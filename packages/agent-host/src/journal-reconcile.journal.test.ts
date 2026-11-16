import { itemDigest, SessionJournal, type JournalIndexEntry } from '@orchardworks/agent-remote-journal';
import type { CanonicalTimelineRow } from '@orchardworks/agent-remote-relay/timeline-projection';
import { describe, expect, it } from 'vitest';

import { groupItems, mergedRow, MESSAGE_BUDGET_BYTES, type TimelineItem } from './journal-items.js';
import { planPublication, replacementPlan, type PlanOptions, type PublicationPlan } from './journal-reconcile.js';

let seq = 0;
const row = (key: string, text: string, identity: CanonicalTimelineRow['identity'] = { key, completes: true }): CanonicalTimelineRow => ({
  epoch: 'e', seq: ++seq, providerId: 'fake', sourceKey: `source:${seq}`, occurredAt: 1_725_000_000_000 + seq, timestamp: new Date(1_725_000_000_000 + seq).toISOString(),
  turnId: 'turn-1', item: { type: 'assistant_message', text, messageId: key }, resources: [], ...(identity ? { identity } : {}),
});
const done = (key: string, text = key) => row(key, text);
const open = (key: string, text = key) => row(key, text, { key });
const kept = (key: string, text = key) => row(key, text, { key, completes: true, liveOnly: true });
const digest = (item: TimelineItem) => itemDigest(mergedRow(item).item);

/** A real journal, written to by publishing plans as the Relay applies them. */
function relay() {
  const journal = SessionJournal.create('host-1:fake:session-1', 'epoch-1');
  const { generation } = journal.claim('controller-1');
  const next = () => ({ publisherId: 'controller-1', generation, sequence: (journal.publisher?.watermark ?? 0) + 1 });
  const apply = (plan: PublicationPlan): void => {
    if (plan.kind === 'gap') throw new Error('Unexpected gap.');
    for (const { op } of [...plan.ops, ...(plan.kind === 'continue' ? plan.older : [])]) {
      if (op.op === 'append') journal.append(next(), op.row);
      else if (op.op === 'complete') journal.complete(next(), op.itemKey, op.digest);
      else if (op.op === 'seal') journal.seal(next(), op.itemKey);
      else if (op.op === 'correct') journal.correct(next(), op.row, op.digest, op.expectedRevision);
      else if (op.op === 'replace') journal.replace(next(), op.items, 1_725_000_000_000);
      else if (op.op === 'prepend') journal.prepend(next(), op.items);
      else if (op.op === 'outcome') journal.outcome(next(), op.background);
    }
  };
  /** One reconcile: the Controller rereads, plans against the index the Relay holds, and publishes the plan. */
  const reconcile = async (reread: CanonicalTimelineRow[], options?: PlanOptions) => {
    const plan = await planPublication(journal.index() as JournalIndexEntry[], groupItems(reread), digest, options);
    apply(plan);
    return plan;
  };
  const keys = () => journal.index().map(entry => entry.itemKey);
  return { journal, reconcile, keys };
}

const opsOf = (plan: PublicationPlan) => plan.kind === 'continue' ? [...plan.ops, ...plan.older].map(({ op }) => op.op) : plan.kind === 'replace' ? plan.ops.map(({ op }) => op.op) : ['gap'];

const isStable = async (fixture: ReturnType<typeof relay>, reread: CanonicalTimelineRow[], options?: PlanOptions) => opsOf(await fixture.reconcile(reread, options));
const seed = async (...rows: CanonicalTimelineRow[]) => { const fixture = relay(); await fixture.reconcile(rows); return fixture; };

describe('a journal that is planned against again after a plan was published', () => {
  it('stays put after a rewrite that leaves an older open item and a live-only item behind', async () => {
    const fixture = await seed(kept('q'), open('o'), done('a'), done('b'));
    expect(await fixture.reconcile([done('b'), done('a')])).toMatchObject({ kind: 'replace', reason: 'reordered' });
    expect(fixture.keys()).toEqual(['q', 'o', 'b', 'a']);
    expect(await isStable(fixture, [done('b'), done('a')])).toEqual([]);
  });

  it('stays put after a replacement that keeps a live-only item the reread still holds', async () => {
    const fixture = await seed(done('a'), kept('q'), open('o'), done('b'));
    expect(await fixture.reconcile([done('b'), kept('q'), done('a')])).toMatchObject({ kind: 'replace' });
    expect(await isStable(fixture, [done('b'), kept('q'), done('a')])).toEqual([]);
  });

  it('stays put after a narrowed quota window carried a live-only item to the front, and when the window widens', async () => {
    const full = [done('a'), kept('q'), done('b'), done('c')];
    const fixture = await seed(...full);
    expect(await fixture.reconcile(full, { forceReplace: true, window: 2 })).toMatchObject({ kind: 'replace', reason: 'quota' });
    expect(fixture.keys()).toEqual(['q', 'b', 'c']);
    expect(await isStable(fixture, full, { window: 2 })).toEqual([]);
    expect(opsOf(await fixture.reconcile(full))).toEqual(['prepend']);
    expect(fixture.keys()).toEqual(['a', 'q', 'b', 'c']);
    expect(await isStable(fixture, full)).toEqual([]);
  });

  it('stays put after older history that holds a provider live-only item was prepended', async () => {
    const fixture = await seed(kept('q'), done('b'), done('c'));
    expect(opsOf(await fixture.reconcile([done('a'), kept('q'), done('b'), done('c')]))).toEqual(['prepend']);
    expect(fixture.keys()).toEqual(['a', 'q', 'b', 'c']);
    expect(await isStable(fixture, [done('a'), kept('q'), done('b'), done('c')])).toEqual([]);
    expect(opsOf(await fixture.reconcile([done('z'), done('a'), kept('q'), done('b'), done('c')]))).toEqual(['prepend']);
    expect(await isStable(fixture, [done('z'), done('a'), kept('q'), done('b'), done('c')])).toEqual([]);
  });

  it('keeps the live-only mark of an item that completed while the Controller was away', async () => {
    const fixture = await seed(done('a'), { ...open('q', 'Asked'), identity: { key: 'q', liveOnly: true } });
    expect(fixture.journal.index().find(entry => entry.itemKey === 'q')).toMatchObject({ state: 'open', liveOnly: true });
    const plan = await fixture.reconcile([done('a'), kept('q', 'Asked, and answered')]);
    expect(opsOf(plan)).toEqual(['correct']);
    expect(fixture.journal.index().find(entry => entry.itemKey === 'q')).toMatchObject({ state: 'complete', liveOnly: true });
    expect(await isStable(fixture, [done('a'), kept('q', 'Asked, and answered')])).toEqual([]);
    // The Relay restarts and the journal is restored from its state: the item is still carried.
    const restored = new SessionJournal(structuredClone(fixture.journal.state()));
    expect(restored.index().find(entry => entry.itemKey === 'q')).toMatchObject({ liveOnly: true });
  });

  it('lets a native copy take over an item the journal held alone', async () => {
    const fixture = await seed(done('a'), open('o'), done('b'));
    await fixture.reconcile([done('b'), done('a')]);
    expect(fixture.journal.index().find(entry => entry.itemKey === 'o')).toMatchObject({ liveOnly: true, state: 'complete' });
    expect(opsOf(await fixture.reconcile([done('b'), done('a'), done('o')]))).toEqual(['correct']);
    expect(fixture.journal.index().find(entry => entry.itemKey === 'o')).toMatchObject({ liveOnly: false, state: 'complete' });
    expect(await isStable(fixture, [done('b'), done('a'), done('o')])).toEqual([]);
  });

  it('never wipes a journal with an empty reread that is not forced', async () => {
    const fixture = await seed(done('a'), done('b'));
    expect(await fixture.reconcile([])).toMatchObject({ kind: 'continue', ops: [], older: [] });
    expect(fixture.keys()).toEqual(['a', 'b']);
    expect(fixture.journal.index().every(entry => entry.state === 'complete' && !entry.liveOnly)).toBe(true);
  });

  it('does not turn a rewrite into an empty replacement, whatever found it', async () => {
    expect(await replacementPlan([], digest, 'gap')).toMatchObject({ kind: 'continue', ops: [] });
    expect(await replacementPlan([], digest, 'missing')).toMatchObject({ kind: 'continue', ops: [] });
    expect(await replacementPlan([], digest, 'quota', true)).toMatchObject({ kind: 'replace', ops: [{ op: { op: 'replace', items: [] } }] });
  });

  it('replaces with an empty block when the replacement is forced, because that is the only way to make an incomplete journal whole', async () => {
    const fixture = await seed(done('a'), done('b'));
    fixture.journal.markIncomplete();
    const plan = await fixture.reconcile([], { forceReplace: true });
    expect(plan).toMatchObject({ kind: 'replace', ops: [{ op: { op: 'replace', items: [] } }] });
    expect(fixture.keys()).toEqual([]);
    expect(fixture.journal.incomplete).toBe(false);
  });

  it('forces a replacement of what is left when the wire refuses some items, and names the refused ones', async () => {
    const fixture = await seed(done('a'));
    const plan = await fixture.reconcile([done('k'.repeat(4097))], { forceReplace: true });
    expect(plan).toMatchObject({ kind: 'replace', refused: ['k'.repeat(4097)] });
    expect(fixture.keys()).toEqual([]);
  });

  it('numbers the revision of a correction from the item, not from its place', async () => {
    const fixture = await seed(done('a'), done('b'));
    await fixture.reconcile([done('a'), done('b', 'changed once')]);
    const plan = await planPublication(fixture.journal.index() as JournalIndexEntry[], groupItems([done('a'), done('b', 'changed twice')]), digest);
    const entry = fixture.journal.index().find(item => item.itemKey === 'b')!;
    expect(entry.revision).not.toBe(entry.seqStart);
    expect(plan.kind === 'continue' && plan.ops[0]?.op).toMatchObject({ op: 'correct', expectedRevision: entry.revision });
  });
});

describe('a replacement that leaves an older open or live-only item in front of the block it sent', () => {
  // History longer than one message: a replacement sends only [b1, b2] and leaves the older items to a prepend.
  const big = (key: string, share: number) => done(key, 'x'.repeat(Math.floor(MESSAGE_BUDGET_BYTES * share)));
  const reopen = async (fixture: ReturnType<typeof relay>, reread: CanonicalTimelineRow[], times: number, options?: PlanOptions) => {
    const kinds: string[] = [];
    for (let at = 0; at < times; at += 1) {
      const plan = await fixture.reconcile(reread, options);
      kinds.push(plan.kind === 'replace' ? `replace:${plan.reason}` : plan.kind);
    }
    return kinds;
  };

  it('settles after a rewrite, with an open item older than the block', async () => {
    const [p1, o, p2, p3, b1, b2] = [done('p1'), open('o'), big('p2', 0.12), big('p3', 0.12), big('b1', 0.6), big('b2', 0.35)];
    const fixture = await seed(p1, o, p2, p3, b1, b2);
    expect(fixture.keys()).toEqual(['b1', 'b2']);
    await fixture.reconcile([p1, o, p2, p3, b1, b2]);
    expect(fixture.keys()).toEqual(['p1', 'o', 'p2', 'p3', 'b1', 'b2']);
    const rewritten = [p1, o, p3, b1, b2];
    expect(await fixture.reconcile(rewritten)).toMatchObject({ kind: 'replace', reason: 'missing' });
    expect(fixture.keys()).toEqual(['o', 'b1', 'b2']);
    expect(await reopen(fixture, rewritten, 4)).toEqual(['continue', 'continue', 'continue', 'continue']);
  });

  it('settles after a quota replacement, whose window holds an open item older than the block', async () => {
    const full = [done('p0'), open('o'), big('p3', 0.12), big('b1', 0.6), big('b2', 0.35)];
    const fixture = await seed(...full);
    await fixture.reconcile(full);
    expect(fixture.keys()).toEqual(['p0', 'o', 'p3', 'b1', 'b2']);
    expect(await fixture.reconcile(full, { forceReplace: true, window: 4 })).toMatchObject({ kind: 'replace', reason: 'quota' });
    expect(fixture.keys()).toEqual(['o', 'b1', 'b2']);
    expect(await reopen(fixture, full, 4, { window: 4 })).toEqual(['continue', 'continue', 'continue', 'continue']);
  });

  it('settles after a rewrite, with a provider live-only item older than the block', async () => {
    const [p1, l, p2, p3, b1, b2] = [done('p1'), kept('l'), big('p2', 0.12), big('p3', 0.12), big('b1', 0.6), big('b2', 0.35)];
    const fixture = await seed(p1, l, p2, p3, b1, b2);
    await fixture.reconcile([p1, l, p2, p3, b1, b2]);
    expect(fixture.keys()).toEqual(['p1', 'l', 'p2', 'p3', 'b1', 'b2']);
    const rewritten = [p1, l, p3, b1, b2];
    expect(await fixture.reconcile(rewritten)).toMatchObject({ kind: 'replace', reason: 'missing' });
    expect(fixture.keys()).toEqual(['l', 'b1', 'b2']);
    expect(await reopen(fixture, rewritten, 4)).toEqual(['continue', 'continue', 'continue', 'continue']);
  });
});

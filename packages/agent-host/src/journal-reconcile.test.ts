import { itemDigest, type JournalIndexEntry } from '@orchardworks/agent-remote-journal';
import type { CanonicalTimelineRow } from '@orchardworks/agent-remote-relay/timeline-projection';
import { describe, expect, it } from 'vitest';

import { groupItems, mergedRow, type PublishOp, type TimelineItem } from './journal-items.js';
import { planPublication, replacementPlan, type PublicationPlan } from './journal-reconcile.js';

let seq = 0;
const row = (key: string, text: string, identity: CanonicalTimelineRow['identity'] = { key, completes: true }): CanonicalTimelineRow => ({
  epoch: 'e', seq: ++seq, providerId: 'fake', sourceKey: `source:${seq}`, occurredAt: 1_725_000_000_000 + seq, timestamp: new Date(1_725_000_000_000 + seq).toISOString(),
  turnId: 'turn-1', item: { type: 'assistant_message', text, messageId: key }, resources: [], ...(identity ? { identity } : {}),
});
const digest = (item: TimelineItem) => itemDigest(mergedRow(item).item);
const items = (...rows: CanonicalTimelineRow[]) => groupItems(rows);

async function indexOf(timeline: TimelineItem[], extra: Partial<JournalIndexEntry> = {}): Promise<JournalIndexEntry[]> {
  const entries: JournalIndexEntry[] = [];
  let next = 1;
  for (const item of timeline) {
    entries.push({ itemKey: item.key, seqStart: next, seqEnd: next, state: 'complete', digest: await digest(item), liveOnly: false, revision: next, resident: true, ...extra });
    next += 1;
  }
  return entries;
}

const ops = (plan: PublicationPlan): PublishOp[] => plan.kind === 'continue' ? [...plan.ops, ...plan.older].map(({ op }) => op) : plan.kind === 'replace' ? plan.ops.map(({ op }) => op) : [];
const summary = (plan: PublicationPlan) => ops(plan).map(op => op.op === 'append' || op.op === 'correct' ? `${op.op}:${op.row.itemKey}` : op.op === 'complete' || op.op === 'seal' ? `${op.op}:${op.itemKey}`
  : op.op === 'prepend' || op.op === 'replace' ? `${op.op}:${op.items.map(({ row: { itemKey } }) => itemKey).join(',')}` : op.op === 'outcome' ? `outcome:${op.background.id}` : op.op);

describe('bringing a journal up to date', () => {
  it('publishes nothing for an unchanged session', async () => {
    const timeline = items(row('a', 'One'), row('b', 'Two'));
    expect(summary(await planPublication(await indexOf(timeline), timeline, digest))).toEqual([]);
  });

  it('appends an item the journal does not know, and completes it', async () => {
    const known = items(row('a', 'One'));
    const timeline = items(row('a', 'One'), row('b', 'Two'));
    expect(summary(await planPublication(await indexOf(known), timeline, digest))).toEqual(['append:b', 'complete:b']);
  });

  it('appends an item that is still open without completing it', async () => {
    const known = items(row('a', 'One'));
    const timeline = items(row('a', 'One'), row('b', 'Tw', { key: 'b' }));
    expect(summary(await planPublication(await indexOf(known), timeline, digest))).toEqual(['append:b']);
  });

  it('corrects an item whose content changed, naming the revision it saw, and completes it with the new digest', async () => {
    const before = items(row('a', 'One'), row('b', 'Two'));
    const timeline = items(row('a', 'One'), row('b', 'Two, extended'));
    const plan = await planPublication(await indexOf(before), timeline, digest);
    expect(summary(plan)).toEqual(['correct:b']);
    expect(ops(plan)[0]).toMatchObject({ expectedRevision: 2, digest: await digest(timeline[1]!) });
  });

  it('corrects an item the journal holds open without completing an item that is still open', async () => {
    const timeline = items(row('a', 'One'), row('b', 'Two', { key: 'b' }));
    const index = await indexOf(timeline);
    index[1] = { ...index[1]!, state: 'open', digest: undefined };
    const plan = await planPublication(index, timeline, digest);
    expect(summary(plan)).toEqual(['correct:b']);
    expect(ops(plan)[0]).not.toHaveProperty('digest');
  });

  it('prepends older history the journal has not seen, newest block first', async () => {
    const full = items(row('a', 'One'), row('b', 'Two'), row('c', 'Three'));
    const known = full.slice(2);
    const plan = await planPublication(await indexOf(known), full, digest);
    expect(summary(plan)).toEqual(['prepend:a,b']);
  });

  it('seals an open item that native history no longer holds, and leaves live-only items alone', async () => {
    const reread = items(row('a', 'One'));
    const journal = items(row('a', 'One'), row('b', 'Streamed once', { key: 'b' }), row('i', 'Question', { key: 'i', completes: true, liveOnly: true }));
    const index = await indexOf(journal);
    index[1] = { ...index[1]!, state: 'open', digest: undefined };
    index[2] = { ...index[2]!, liveOnly: true };
    expect(summary(await planPublication(index, reread, digest))).toEqual(['seal:b']);
  });

  it('replaces only when native history was rewritten, with the newest items', async () => {
    const journal = items(row('a', 'One'), row('b', 'Two'), row('c', 'Three'));
    const missing = items(row('a', 'One'), row('c', 'Three'));
    const plan = await planPublication(await indexOf(journal), missing, digest);
    expect(plan).toMatchObject({ kind: 'replace', reason: 'missing' });
    expect(summary(plan)).toEqual(['replace:a,c']);
    expect(await planPublication(await indexOf(journal), items(row('c', 'Three'), row('a', 'One')), digest)).toMatchObject({ kind: 'replace', reason: 'reordered' });
    expect(await planPublication(await indexOf(journal), items(row('a', 'One'), row('x', 'New'), row('b', 'Two'), row('c', 'Three')), digest)).toMatchObject({ kind: 'replace', reason: 'inserted' });
  });

  it('leaves journal items older than the reread alone, because they are outside its window', async () => {
    const journal = items(row('a', 'One'), row('b', 'Two'));
    expect(summary(await planPublication(await indexOf(journal), items(row('b', 'Two'), row('c', 'Three')), digest))).toEqual(['append:c', 'complete:c']);
  });

  it('replaces an empty journal in one entry, and publishes nothing for an empty session', async () => {
    const timeline = items(row('a', 'One'), row('b', 'Two'));
    const plan = await planPublication([], timeline, digest);
    expect(plan).toMatchObject({ kind: 'replace', reason: 'initial' });
    expect(summary(plan)).toEqual(['replace:a,b']);
    expect(summary(await planPublication([], [], digest))).toEqual([]);
  });

  it('asks for older history when none of the reread is in the journal', async () => {
    const journal = items(row('x', 'Older than the reread'));
    expect(await planPublication(await indexOf(journal), items(row('a', 'One')), digest)).toEqual({ kind: 'gap' });
  });

  it('compares only the newest items when the window is narrowed, and leaves the older journal items alone', async () => {
    const full = items(row('a', 'One'), row('b', 'Two'), row('c', 'Three'));
    const plan = await planPublication(await indexOf(full), full, digest, { window: 2 });
    expect(summary(plan)).toEqual([]);
  });

  it('replaces with the newest items of the window when told to, which a quota refusal does', async () => {
    const full = items(row('a', 'One'), row('b', 'Two'), row('c', 'Three'));
    const plan = await planPublication(await indexOf(full), full, digest, { forceReplace: true, window: 2 });
    expect(plan).toMatchObject({ kind: 'replace', reason: 'quota' });
    expect(summary(plan)).toEqual(['replace:b,c']);
  });

  it('keeps an item the wire refuses out of the plan and names it', async () => {
    const long = 'k'.repeat(4097);
    const timeline = items(row('a', 'One'), row(long, 'Too long'));
    const plan = await planPublication(await indexOf(items(row('a', 'One'))), timeline, digest);
    expect(plan).toMatchObject({ kind: 'continue', refused: [long] });
    expect(summary(plan)).toEqual([]);
  });

  it('does not take a refused item in the middle of the timeline for a rewrite, and names it in every kind of plan', async () => {
    const long = 'k'.repeat(4097);
    const timeline = items(row('a', 'One'), row(long, 'Too long'), row('c', 'Three'));
    const known = items(row('a', 'One'), row('c', 'Three'));
    const continued = await planPublication(await indexOf(known), timeline, digest);
    expect(continued).toMatchObject({ kind: 'continue', refused: [long] });
    expect(summary(continued)).toEqual([]);
    const initial = await planPublication([], timeline, digest);
    expect(initial).toMatchObject({ kind: 'replace', reason: 'initial', refused: [long] });
    expect(summary(initial)).toEqual(['replace:a,c']);
    expect(await planPublication(await indexOf(known), timeline, digest, { forceReplace: true })).toMatchObject({ kind: 'replace', refused: [long] });
  });

  it('publishes older history apart from the other operations, so a head can go between them', async () => {
    const full = items(row('a', 'One'), row('b', 'Two'), row('c', 'Three'), row('d', 'Four'));
    const known = items(row('b', 'Two'), row('c', 'Three Changed'));
    const plan = await planPublication(await indexOf(known), full, digest);
    expect(plan).toMatchObject({ kind: 'continue' });
    if (plan.kind !== 'continue') throw new Error('Expected a continuing plan.');
    expect(plan.ops.map(({ op }) => op.op)).toEqual(['correct', 'append', 'complete']);
    expect(plan.older.map(({ op }) => op.op)).toEqual(['prepend']);
  });

  it('puts an item that is still open in a replacement without a digest', async () => {
    const timeline = items(row('a', 'One'), row('b', 'Streaming', { key: 'b' }));
    const plan = await planPublication([], timeline, digest);
    if (plan.kind !== 'replace') throw new Error('Expected a replacement.');
    const op = plan.ops[0]!.op;
    expect(op.op === 'replace' && op.items.map(item => [item.row.itemKey, item.digest === undefined])).toEqual([['a', false], ['b', true]]);
  });

  it('says again the outcome of every background in the window, with the strongest status', async () => {
    const first = row('a', 'a');
    first.item = { type: 'assistant_message', text: 'a', messageId: 'a', background: { id: 'review-1', kind: 'review', status: 'pending' } };
    const second = row('b', 'b');
    second.item = { type: 'assistant_message', text: 'b', messageId: 'b', background: { id: 'review-1', kind: 'review', status: 'visible' } };
    const timeline = items(first, second, row('c', 'No background'));
    const continued = await planPublication(await indexOf(timeline), timeline, digest);
    expect(summary(continued)).toEqual(['outcome:review-1']);
    const op = ops(continued)[0]!;
    expect(op.op === 'outcome' && op.background.status).toBe('visible');
    expect(summary(await planPublication([], timeline, digest))).toEqual(['replace:a,b,c', 'outcome:review-1']);
  });

  it('builds the replacement a gap that could not be closed calls for', async () => {
    const timeline = items(row('a', 'One'), row('b', 'Two'));
    expect(summary(await replacementPlan(timeline, digest, 'gap'))).toEqual(['replace:a,b']);
  });
});

import { itemDigest, type JournalIndexEntry } from '@orchardworks/agent-remote-journal';
import type { JournalRelayMessage } from '@orchardworks/agent-remote-protocol';
import type { AgentJournalTap } from '@orchardworks/agent-remote-relay';
import { afterEach, describe, expect, it } from 'vitest';

import { groupItems, mergedRow } from './journal-items.js';
import { createJournalPublisher, type JournalPublisher, type JournalSource } from './journal-publisher.js';
import { attachScripted, boundary, driver, item, ScriptedSession, virtualClock } from './test-utils/journal-scripted-session.js';

type Wire = Record<string, any>;
const clock = virtualClock();
const { settle, until } = driver(clock);
const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

const entry = (itemKey: string, at: number, extra: Partial<JournalIndexEntry> = {}): JournalIndexEntry =>
  ({ itemKey, seqStart: at, seqEnd: at, state: 'complete', digest: 'd', liveOnly: false, revision: at, resident: true, ...extra });

interface Answer { ack(): void; refuse(reason: string, itemKey?: string, sequence?: number): void; ignore(): void }

/** A Relay that answers the publisher by script and keeps the item index of what it was sent. Every message the publisher writes is recorded. */
function scriptedRelay(options: { index?: JournalIndexEntry[]; pages?: JournalIndexEntry[][]; watermark?: number; staleFirstPage?: boolean; holdOpened?: boolean; refuseOpen?(opens: number, reset: boolean): boolean; onPublish?(message: Wire, answer: Answer): void } = {}) {
  const written: Wire[] = [];
  const writtenAt: number[] = [];
  const refusedAt: number[] = [];
  let publisher!: JournalPublisher;
  let generation = 0;
  let applied = options.watermark ?? 0;
  let model: JournalIndexEntry[] = [...(options.index ?? [])];
  let revision = 100;
  const heldOpens: Array<() => void> = [];
  const send = (message: JournalRelayMessage) => queueMicrotask(() => publisher.receive(message));
  const known = (items: Wire[], first: number): JournalIndexEntry[] => items.map((value, at) => ({
    itemKey: value.row.itemKey, seqStart: first + at, seqEnd: first + at, state: value.digest ? 'complete' as const : 'open' as const, digest: value.digest, liveOnly: value.row.liveOnly === true, revision: ++revision, resident: true,
  }));
  const apply = (entries: Wire[]): void => {
    for (const value of entries) {
      const at = model.findIndex(entry => entry.itemKey === (value.itemKey ?? value.row?.itemKey));
      if (value.op === 'replace') model = known(value.items, 1);
      else if (value.op === 'prepend') model = [...known(value.items, (model[0]?.seqStart ?? 1) - value.items.length), ...model];
      else if (value.op === 'append' && at < 0) model.push({ itemKey: value.row.itemKey, seqStart: (model.at(-1)?.seqEnd ?? 0) + 1, seqEnd: (model.at(-1)?.seqEnd ?? 0) + 1, state: 'open', liveOnly: value.row.liveOnly === true, revision: ++revision, resident: true });
      else if (value.op === 'complete' && at >= 0) model[at] = { ...model[at]!, state: 'complete', digest: value.digest, revision: ++revision };
      else if (value.op === 'correct' && at >= 0) model[at] = { ...model[at]!, state: value.digest ? 'complete' : 'open', digest: value.digest, revision: ++revision };
      else if (value.op === 'seal' && at >= 0) model[at] = { ...model[at]!, state: 'complete', liveOnly: true, revision: ++revision };
    }
  };
  const writer = { send(json: string) {
    const message: Wire = JSON.parse(json);
    written.push(message);
    writtenAt.push(clock.now());
    if (message.type === 'journal_open') {
      if (options.refuseOpen?.(written.filter(entry => entry.type === 'journal_open').length, message.reset === true)) {
        send({ uplinkVersion: 2, type: 'journal_open_refused', requestId: message.requestId, sessionKey: message.sessionKey, reason: 'index_too_large' });
        return;
      }
      generation += 1;
      const paged = (options.pages?.length ?? 0) > 0;
      if (message.reset) model = [];
      const first = message.reset ? [] : paged ? (options.index ?? []) : structuredClone(model);
      const reply = () => send({ uplinkVersion: 2, type: 'journal_opened', requestId: message.requestId, sessionKey: message.sessionKey, generation, watermark: applied, epoch: 'epoch-1', index: first,
        ...(paged ? { indexAfter: first.at(-1)?.seqStart ?? 0 } : {}) } as JournalRelayMessage);
      if (options.holdOpened) heldOpens.push(reply); else reply();
    } else if (message.type === 'journal_index_request') {
      const requests = written.filter(entry => entry.type === 'journal_index_request').length;
      if (options.staleFirstPage && requests === 1) {
        send({ uplinkVersion: 2, type: 'journal_open_refused', requestId: message.requestId, sessionKey: message.sessionKey, reason: 'stale_epoch' });
        return;
      }
      const at = options.staleFirstPage ? requests - 2 : requests - 1;
      const page = (options.pages ?? [])[at] ?? [];
      send({ uplinkVersion: 2, type: 'journal_index_page', requestId: message.requestId, sessionKey: message.sessionKey, index: page,
        ...(at + 1 < (options.pages ?? []).length ? { indexAfter: page.at(-1)?.seqStart ?? 0 } : {}) } as JournalRelayMessage);
    } else if (message.type === 'journal_publish') {
      const last = message.entries.at(-1).sequence as number;
      // As the journal does: a publication starts exactly after the watermark, and a refused entry consumes no sequence.
      if (message.entries[0].sequence !== applied + 1) {
        refusedAt.push(clock.now());
        send({ uplinkVersion: 2, type: 'journal_refused', sessionKey: message.sessionKey, generation: message.generation, sequence: message.entries[0].sequence, reason: 'sequence_gap' });
        return;
      }
      const answer: Answer = {
        ack: () => { apply(message.entries); applied = last; send({ uplinkVersion: 2, type: 'journal_ack', sessionKey: message.sessionKey, generation: message.generation, watermark: last, cursor: { epoch: 'epoch-1', seq: last } }); },
        refuse: (reason, itemKey, sequence = message.entries[0].sequence) => {
          refusedAt.push(clock.now());
          // The entries before the refused one are stored; the refused one and those after it are not, and `applied` stops before it.
          const before = message.entries.filter((value: Wire) => value.sequence < sequence);
          if (before.length > 0 && reason !== 'quota_exceeded') { apply(before); applied = sequence - 1; }
          send({ uplinkVersion: 2, type: 'journal_refused', sessionKey: message.sessionKey, generation: message.generation, sequence, reason, ...(itemKey ? { itemKey } : {}) } as JournalRelayMessage);
        },
        ignore: () => undefined,
      };
      if (options.onPublish) options.onPublish(message, answer); else answer.ack();
    }
  } };
  return {
    written, send, connect(next: JournalPublisher) { publisher = next; next.available(writer); },
    types: () => written.map(message => message.type),
    ops: () => written.filter(message => message.type === 'journal_publish').flatMap(message => message.entries.map((value: Wire) => value.op)),
    publishes: () => written.filter(message => message.type === 'journal_publish'),
    opens: () => written.filter(message => message.type === 'journal_open').length,
    opensAt: () => written.flatMap((message, at) => message.type === 'journal_open' ? [writtenAt[at]!] : []),
    refusedAt: () => refusedAt,
    releaseOpens: () => { for (const reply of heldOpens.splice(0)) reply(); },
    model: () => model,
    /** Makes the Relay hold these items already, as an earlier Controller left them. */
    seed: (entries: JournalIndexEntry[]) => { model = entries; },
    unserves: () => written.filter(message => message.type === 'journal_unserve'),
  };
}
type Relay = ReturnType<typeof scriptedRelay>;

const publisherFor = (relay: Relay, limits: Record<string, unknown> = {}, diagnostics: Wire[] = []) => {
  const publisher = createJournalPublisher({
    providers: () => ['fake'], scheduler: clock, now: clock.now, diagnostic: event => diagnostics.push(event),
    limits: { batchWindowMs: 5, backoffBaseMs: 5, backoffMaxMs: 20, responseTimeoutMs: 10_000, ...limits },
  });
  closers.push(() => publisher.close());
  relay.connect(publisher);
  return publisher;
};

type Observation = ReturnType<typeof item>;
async function attachSession(publisher: JournalPublisher, history: Observation[], older?: Array<{ observations: Observation[]; nextCursor?: string }>, ids = { agentId: 'agent-1', nativeSessionId: 'thread-1' }, held?: { relay: Relay; keys: string[] }) {
  const session = new ScriptedSession('fake', ids.nativeSessionId, [...history, boundary(older ? 'older-1' : undefined)], older);
  const manager = await attachScripted(session, ids.agentId);
  closers.push(() => { void manager.close(); });
  if (held) held.relay.seed(await entriesFor(manager, held.keys));
  publisher.attach({ agentId: ids.agentId, providerId: 'fake', nativeSessionId: ids.nativeSessionId, source: manager });
  return { session, manager };
}

/** The index entries a journal holds for these items of the manager's timeline, with the digests it computes. */
async function entriesFor(manager: Awaited<ReturnType<typeof attachScripted>>, keys: string[]): Promise<JournalIndexEntry[]> {
  const entries: JournalIndexEntry[] = [];
  for (const group of groupItems(manager.timelineRows()).filter(candidate => keys.includes(candidate.key))) {
    entries.push({ itemKey: group.key, seqStart: entries.length + 1, seqEnd: entries.length + 1, state: 'complete', digest: await itemDigest(mergedRow(group).item), liveOnly: false, revision: entries.length + 1, resident: true });
  }
  return entries;
}

/** The session is live: its journal was replaced if it had to be, reopened, and the head published. */
async function live(relay: Relay): Promise<void> {
  await until(() => relay.ops().includes('head'), 'the first head');
  await settle(30);
}

const sourceOf = (manager: Awaited<ReturnType<typeof attachScripted>>, overrides: Partial<JournalSource> = {}): JournalSource => ({
  subscribeJournal: tap => manager.subscribeJournal(tap), timelineRows: () => manager.timelineRows(), itemRows: key => manager.itemRows(key),
  attentionItemKey: () => manager.attentionItemKey(), snapshot: () => manager.snapshot(), hasOlderHistory: () => manager.hasOlderHistory(),
  loadOlderHistory: () => manager.loadOlderHistory(), ...overrides,
});

describe('publishing a session', () => {
  it('opens the journal, publishes the history as one replacement of an empty journal, and ends with the head', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay);
    await attachSession(publisher, [item('history', 'm1', 'Hello'), item('history', 'm2', 'World')]);
    await until(() => relay.ops().includes('head'), 'the head');
    expect(relay.types()[0]).toBe('journal_open');
    expect(relay.written[0]).toMatchObject({ sessionKey: 'fake:thread-1', publisherId: expect.any(String) });
    const publish = relay.publishes()[0]!;
    expect(publish.generation).toBe(1);
    expect(publish.entries.map((value: Wire) => value.op)).toEqual(['replace', 'head']);
    expect(publish.entries[0].items.map((value: Wire) => value.row.itemKey)).toEqual(['m1', 'm2']);
    expect(publish.entries[1].head.snapshot.id).toBe('agent-1');
  });

  it('does nothing for a journal that already holds the session, apart from the head', async () => {
    const relay = scriptedRelay({ index: [] });
    const publisher = publisherFor(relay);
    await attachSession(publisher, []);
    await until(() => relay.ops().includes('head'), 'the head');
    expect(relay.ops()).toEqual(['head']);
  });

  it('numbers its entries from the Relay\'s watermark and waits for each acknowledgement before the next message', async () => {
    const pending: Array<() => void> = [];
    const relay = scriptedRelay({ watermark: 7, onPublish: (_message, answer) => { pending.push(answer.ack); } });
    const publisher = publisherFor(relay);
    const { session } = await attachSession(publisher, []);
    await until(() => pending.length === 1, 'the first publication');
    expect(relay.publishes()[0]!.entries.map((value: Wire) => value.sequence)).toEqual([8]);
    session.push(item('live', 'a', 'Streaming', { completes: false }));
    await settle(40);
    expect(relay.publishes()).toHaveLength(1);
    pending.shift()!();
    await until(() => pending.length === 1, 'the next publication after the acknowledgement');
    expect(relay.publishes().at(-1)!.entries.map((value: Wire) => [value.sequence, value.op])).toEqual([[9, 'append']]);
  });

  it('pulls the rest of a paged index with the epoch it was opened in, one page at a time', async () => {
    const relay = scriptedRelay({ index: [entry('a', 1, { liveOnly: true }), entry('b', 2, { liveOnly: true })], pages: [[entry('c', 3, { liveOnly: true })], [entry('d', 4, { liveOnly: true })]] });
    const publisher = publisherFor(relay);
    await attachSession(publisher, []);
    await until(() => relay.ops().includes('head'), 'the head');
    const requests = relay.written.filter(message => message.type === 'journal_index_request');
    expect(requests.map(message => [message.generation, message.epoch, message.after])).toEqual([[1, 'epoch-1', 2], [1, 'epoch-1', 3]]);
  });

  it('opens again when a page of the index is refused as belonging to an older epoch', async () => {
    const relay = scriptedRelay({ index: [entry('a', 1, { liveOnly: true })], pages: [[entry('b', 2, { liveOnly: true })]], staleFirstPage: true });
    const publisher = publisherFor(relay);
    await attachSession(publisher, []);
    await until(() => relay.ops().includes('head'), 'the head after a second open');
    expect(relay.opens()).toBe(2);
  });

  it('plans against the whole index before it publishes anything, so a journal read in pages is not replaced', async () => {
    const relay = scriptedRelay({ index: [entry('m1', 1)], pages: [[entry('m2', 2)]] });
    const publisher = publisherFor(relay);
    await attachSession(publisher, [item('history', 'm1', 'One'), item('history', 'm2', 'Two')]);
    await until(() => relay.ops().includes('head'), 'the head');
    expect(relay.ops()).not.toContain('replace');
  });

  it('opens again without the index when the Relay refuses it as too large, publishes a replacement that fits first, and goes on', async () => {
    const diagnostics: Wire[] = [];
    const relay = scriptedRelay({ refuseOpen: (opens, reset) => opens === 1 && !reset });
    const publisher = publisherFor(relay, {}, diagnostics);
    const { session } = await attachSession(publisher, [item('history', 'm1', 'One'), item('history', 'm2', 'Two')]);
    await until(() => relay.opens() === 3 && relay.ops().includes('head'), 'the open after the replacement');
    expect(relay.written.filter(message => message.type === 'journal_open').map(message => message.reset)).toEqual([undefined, true, undefined]);
    expect(relay.publishes()[0]!.entries.map((value: Wire) => value.op)).toEqual(['replace', 'head']);
    expect(relay.unserves()).toEqual([]);
    expect(diagnostics.filter(entry => entry.event === 'journal_open_refused')).toEqual([{ event: 'journal_open_refused', providerId: 'fake', reason: 'index_too_large' }]);
    session.push(item('live', 'later', 'Still publishing', { completes: true }));
    await until(() => relay.ops().includes('complete'), 'a live item after the way out');
    expect(diagnostics.map(entry => entry.event)).not.toContain('journal_session_stopped');
  });

  it('gives up publishing a session whose reset open is refused too, and opens it again only when a connection returns', async () => {
    const diagnostics: Wire[] = [];
    const relay = scriptedRelay({ refuseOpen: () => true });
    const publisher = publisherFor(relay, {}, diagnostics);
    await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => diagnostics.filter(entry => entry.event === 'journal_open_refused').length === 2, 'both refusals');
    await settle(200);
    expect(relay.written.filter(message => message.type === 'journal_open').map(message => message.reset)).toEqual([undefined, true]);
    expect(relay.unserves()).toEqual([]);
    publisher.available(undefined);
    relay.connect(publisher);
    await until(() => relay.opens() === 3, 'the open on the next connection');
  });

  it('does not publish a session of a provider that does not declare journal support', async () => {
    const relay = scriptedRelay();
    const publisher = createJournalPublisher({ providers: () => ['other'], scheduler: clock, now: clock.now, limits: { batchWindowMs: 5 } });
    closers.push(() => publisher.close());
    relay.connect(publisher);
    const session = new ScriptedSession('fake', 'thread-1', [boundary()]);
    const manager = await attachScripted(session);
    closers.push(() => { void manager.close(); });
    expect(publisher.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source: manager })).toBe(false);
    await settle(30);
    expect(relay.written).toEqual([]);
  });
});

describe('live rows', () => {
  it('merges consecutive deltas of one item into a row, completes it with the digest of the whole item, and keeps a still-open item open', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, { batchWindowMs: 25 });
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await live(relay);
    const before = relay.written.length;
    session.push(item('live', 'a', 'Wor', { completes: false }));
    session.push(item('live', 'a', 'ld', { completes: false }));
    session.push(item('live', 'a', '!', { completes: true }));
    session.push(item('live', 'b', 'Still ', { completes: false }));
    await until(() => relay.written.slice(before).some(message => message.type === 'journal_publish'), 'the live publication');
    const entries = relay.written.slice(before).filter(message => message.type === 'journal_publish').flatMap(message => message.entries) as Wire[];
    expect(entries.map(value => value.op)).toEqual(['append', 'complete', 'append']);
    expect(entries[0]!.row).toMatchObject({ itemKey: 'a', item: { text: 'World!' } });
    expect(entries[1]).toMatchObject({ itemKey: 'a', digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(entries[2]).toMatchObject({ row: { itemKey: 'b', item: { text: 'Still ' } } });
  });

  it('collects rows for the batch window before it publishes them', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, { batchWindowMs: 50 });
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await live(relay);
    const before = relay.publishes().length;
    const startedAt = clock.now();
    session.push(item('live', 'a', 'Streaming', { completes: false }));
    await until(() => relay.publishes().length > before, 'the live publication');
    expect(clock.now() - startedAt).toBeGreaterThanOrEqual(50);
  });

  it('publishes a head that carries a new pending interaction at once, not after the batch window', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, { batchWindowMs: 5000 });
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await live(relay);
    const before = relay.written.length;
    const startedAt = clock.now();
    session.push({ type: 'observation', sourceKey: 'ask-1', occurredAt: 1, delivery: 'live', event: { type: 'interaction_requested', provider: 'fake', request: { kind: 'question', requestId: 'question-1', questions: [{ questionId: 'q', header: 'Pick', prompt: 'Which?', required: true, selection: 'single', options: [{ value: 'a', label: 'A' }], allowCustomText: false, allowDismiss: false }] } } });
    await until(() => relay.written.slice(before).some(message => message.type === 'journal_publish'), 'an urgent head');
    expect(clock.now() - startedAt).toBeLessThan(1000);
    const head = relay.written.slice(before).flatMap(message => message.entries ?? []).find((value: Wire) => value.op === 'head') as Wire;
    expect(head.head.snapshot.pendingInteractions.map((request: Wire) => request.requestId)).toEqual(['question-1']);
  });

  it('publishes a background outcome in order with the rows, and leaves the other runtime events to the head', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, { batchWindowMs: 25 });
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await live(relay);
    const before = relay.written.length;
    session.push({ type: 'observation', sourceKey: 'turn-1', occurredAt: 5, delivery: 'live', event: { type: 'turn_started', provider: 'fake', turnId: 'turn-9' } });
    session.push(item('live', 'a', 'Done', { completes: true }));
    session.push({ type: 'observation', sourceKey: 'bg-1', occurredAt: 6, delivery: 'live', event: { type: 'background_activity_updated', provider: 'fake', turnId: 'turn-9', background: { id: 'review-1', kind: 'review', status: 'visible' } } });
    await until(() => relay.ops().filter(op => op === 'outcome').length === 1, 'the outcome');
    const ops = relay.written.slice(before).filter(message => message.type === 'journal_publish').flatMap(message => message.entries.map((value: Wire) => value.op));
    expect(ops.filter(op => op !== 'head').slice(0, 3)).toEqual(['append', 'complete', 'outcome']);
    expect(ops).not.toContain('event');
    const head = relay.written.slice(before).flatMap(message => message.entries ?? []).filter((value: Wire) => value.op === 'head').at(-1) as Wire;
    expect(head.head.snapshot.activeTurn).toMatchObject({ turnId: 'turn-9' });
  });

  it('drops a row the wire refuses, tells the diagnostics once, and keeps publishing the rest', async () => {
    const diagnostics: Wire[] = [];
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, { batchWindowMs: 5 }, diagnostics);
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await live(relay);
    session.push(item('live', 'bad', 'x', { turnId: 't'.repeat(600) }));
    session.push(item('live', 'good', 'Fine', { completes: true }));
    await until(() => relay.ops().includes('complete'), 'the rest');
    expect(diagnostics.filter(entry => entry.event === 'journal_row_rejected')).toEqual([{ event: 'journal_row_rejected', providerId: 'fake' }]);
    const appended = relay.publishes().flatMap(message => message.entries).filter((value: Wire) => value.op === 'append').map((value: Wire) => value.row.itemKey);
    expect(appended).toEqual(['good']);
  });

  it('does not tell the diagnostics again about an item the wire refuses when the session reconciles again', async () => {
    const diagnostics: Wire[] = [];
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, {}, diagnostics);
    await attachSession(publisher, [item('history', 'bad', 'x', { turnId: 't'.repeat(600) }), item('history', 'm1', 'Hello')]);
    await live(relay);
    publisher.available(undefined);
    relay.connect(publisher);
    await until(() => relay.opens() === 2 && relay.ops().filter(op => op === 'head').length >= 2, 'the second reconcile');
    expect(diagnostics.filter(entry => entry.event === 'journal_row_rejected')).toHaveLength(1);
    expect(relay.publishes().flatMap(message => message.entries).filter((value: Wire) => value.op === 'replace')).toHaveLength(1);
  });

  it('skips a replacement that has nothing to replace with', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay);
    await attachSession(publisher, [item('history', 'bad', 'x', { turnId: 't'.repeat(600) })]);
    await until(() => relay.ops().includes('head'), 'the head');
    expect(relay.ops()).toEqual(['head']);
    expect(relay.opens()).toBe(1);
  });
});

describe('events the manager emits besides rows', () => {
  async function reachable(publisher: JournalPublisher) {
    const session = new ScriptedSession('fake', 'thread-1', [item('history', 'm1', 'Hello'), boundary()]);
    const manager = await attachScripted(session);
    closers.push(() => { void manager.close(); });
    const taps: AgentJournalTap[] = [];
    const source = sourceOf(manager, { subscribeJournal: tap => { taps.push(tap); return manager.subscribeJournal(tap); } });
    publisher.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source });
    return { tap: () => taps.at(-1)! };
  }

  it('publishes a replaced resource binding as an amendment of the item it belongs to', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, { batchWindowMs: 5 });
    const { tap } = await reachable(publisher);
    await live(relay);
    const previous = { locator: 'out.png', resourceId: 'r1', status: 'pending' as const };
    const replacement = { locator: 'out.png', resourceId: 'r2', status: 'available' as const };
    tap().event({ type: 'timeline_resource_binding_replaced', agentId: 'agent-1', epoch: 'e', seq: 1, itemKey: 'm1', previous, replacement });
    await until(() => relay.ops().includes('rebind'), 'the amendment');
    expect(relay.publishes().flatMap(message => message.entries).find((value: Wire) => value.op === 'rebind')).toMatchObject({ itemKey: 'm1', previous, replacement });
  });

  it('reconciles again after the provider replaces its timeline, and publishes nothing of the rows in between', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, { batchWindowMs: 5 });
    const { tap } = await reachable(publisher);
    await live(relay);
    const opens = relay.opens();
    tap().event({ type: 'timeline_replacement', agentId: 'agent-1', epoch: 'e2' });
    tap().event({ type: 'agent_stream', agentId: 'agent-1', delivery: 'history', timestamp: new Date(1).toISOString(), event: { type: 'timeline', provider: 'fake', item: { type: 'assistant_message', text: 'Mid-rebuild', messageId: 'x' } },
      row: { epoch: 'e2', seq: 1, providerId: 'fake', sourceKey: 'rebuild:1', occurredAt: 1, timestamp: new Date(1).toISOString(), item: { type: 'assistant_message', text: 'Mid-rebuild', messageId: 'x' }, resources: [], identity: { key: 'x', completes: true } } });
    tap().event({ type: 'timeline_rebuilt', agentId: 'agent-1', cursor: { epoch: 'e2', seq: 1 } });
    await until(() => relay.opens() === opens + 1, 'the reopening');
    await settle(40);
    expect(relay.ops().filter(op => op === 'append')).toEqual([]);
  });
});

describe('recovering', () => {
  it('opens again and reconciles from the manager after the Relay refuses a publication', async () => {
    let refused = false;
    const relay = scriptedRelay({ onPublish: (message, answer) => {
      if (!refused && message.entries.some((value: Wire) => value.op === 'append')) { refused = true; answer.refuse('stale_revision', 'a'); return; }
      answer.ack();
    } });
    const publisher = publisherFor(relay);
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await live(relay);
    await settle(30);
    const opens = relay.opens();
    session.push(item('live', 'a', 'Hi', { completes: true }));
    await until(() => relay.opens() === opens + 1 && relay.model().some(value => value.itemKey === 'a' && value.state === 'complete'), 'the open after the refusal, and the item');
    await settle(100);
    expect(relay.opens()).toBe(opens + 1);
  });

  it('opens again when the Relay does not acknowledge in time', async () => {
    let silent = true;
    const relay = scriptedRelay({ onPublish: (_message, answer) => { if (silent) { silent = false; answer.ignore(); } else answer.ack(); } });
    const publisher = publisherFor(relay, { responseTimeoutMs: 60 });
    await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.opens() >= 2, 'a second open');
    await until(() => relay.model().length === 1, 'the replacement after the second open');
  });

  it('opens again when the Relay answers sequence_gap, which no per-item refusal explains', async () => {
    const diagnostics: Wire[] = [];
    let gaps = 0;
    const relay = scriptedRelay({ onPublish: (message, answer) => {
      if (gaps === 0 && message.entries.some((value: Wire) => value.op === 'append')) { gaps += 1; answer.refuse('sequence_gap'); } else answer.ack();
    } });
    const publisher = publisherFor(relay, { batchWindowMs: 25 }, diagnostics);
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await live(relay);
    const opens = relay.opens();
    session.push(item('live', 'm2', 'Next', { completes: true }));
    await until(() => relay.opens() === opens + 1 && relay.model().some(value => value.itemKey === 'm2'), 'the journal to be opened again and to hold the item');
    expect(diagnostics).toContainEqual({ event: 'journal_publication_refused', providerId: 'fake', reason: 'sequence_gap' });
  });

  it('leaves out an item the Relay refuses for its own sake, sends the rest again numbered from the refused entry, and does not open again', async () => {
    const diagnostics: Wire[] = [];
    let refused = false;
    const relay = scriptedRelay({ onPublish: (message, answer) => {
      const bad = message.entries.find((value: Wire) => value.op === 'append' && value.row.itemKey === 'bad');
      if (!refused && bad) { refused = true; answer.refuse('body_missing', 'bad', bad.sequence); } else answer.ack();
    } });
    const publisher = publisherFor(relay, { batchWindowMs: 25 }, diagnostics);
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await live(relay);
    await settle(40);
    const opens = relay.opens();
    session.push(item('live', 'bad', 'Never stored', { completes: true }));
    session.push(item('live', 'good', 'Stored', { completes: true }));
    await until(() => relay.model().some(value => value.itemKey === 'good' && value.state === 'complete'), 'the item after the refused one');
    const publishes = relay.publishes().slice(-2);
    const shape = publishes.map(message => message.entries.filter((value: Wire) => value.op !== 'head').map((value: Wire) => [value.op, value.row?.itemKey ?? value.itemKey]));
    expect(shape).toEqual([
      [['append', 'bad'], ['complete', 'bad'], ['append', 'good'], ['complete', 'good']],
      [['append', 'good'], ['complete', 'good']],
    ]);
    // The second message starts at the refused entry's own number: the refused entry consumed none.
    expect(publishes[1]!.entries[0].sequence).toBe(publishes[0]!.entries[0].sequence);
    expect(relay.opens()).toBe(opens);
    expect(relay.model().map(value => value.itemKey)).not.toContain('bad');
    expect(diagnostics).toContainEqual({ event: 'journal_publication_refused', providerId: 'fake', reason: 'body_missing:item' });
  });

  it('leaves a refused item out of a replacement, publishes the rest, and does not mistake the reread that follows for a rewrite', async () => {
    let refused = false;
    const relay = scriptedRelay({ onPublish: (message, answer) => {
      const replace = message.entries.find((value: Wire) => value.op === 'replace' && value.items.some((input: Wire) => input.row.itemKey === 'bad'));
      if (!refused && replace) { refused = true; answer.refuse('invalid', 'bad', replace.sequence); } else answer.ack();
    } });
    const publisher = publisherFor(relay);
    await attachSession(publisher, [item('history', 'm1', 'One'), item('history', 'bad', 'Refused'), item('history', 'm2', 'Two')]);
    await live(relay);
    const replaces = relay.publishes().flatMap(message => message.entries).filter((value: Wire) => value.op === 'replace');
    expect(replaces.map((value: Wire) => value.items.map((input: Wire) => input.row.itemKey))).toEqual([['m1', 'bad', 'm2'], ['m1', 'm2']]);
    expect(relay.model().map(value => value.itemKey)).toEqual(['m1', 'm2']);
    expect(relay.unserves()).toEqual([]);
    expect(relay.opens()).toBe(2);
  });

  it('maps the sequence of a refusal back to its own numbering when the refused entry is not the first of the message', async () => {
    let refused = false;
    const relay = scriptedRelay({ onPublish: (message, answer) => {
      const bad = message.entries.find((value: Wire) => value.op === 'complete' && value.itemKey === 'b');
      if (!refused && bad) { refused = true; answer.refuse('invalid', 'b', bad.sequence); } else answer.ack();
    } });
    const publisher = publisherFor(relay, { batchWindowMs: 25 });
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await live(relay);
    const opens = relay.opens();
    session.push(item('live', 'a', 'One', { completes: true }));
    session.push(item('live', 'b', 'Two', { completes: true }));
    session.push(item('live', 'c', 'Three', { completes: true }));
    await until(() => relay.model().some(value => value.itemKey === 'c' && value.state === 'complete'), 'the items after the refused one');
    const [first, second] = relay.publishes().slice(-2) as [Wire, Wire];
    const refusedAt = first.entries.find((value: Wire) => value.op === 'complete' && value.itemKey === 'b').sequence;
    expect(second.entries[0].sequence).toBe(refusedAt);
    expect(second.entries.map((value: Wire) => [value.op, value.row?.itemKey ?? value.itemKey])).toEqual([['append', 'c'], ['complete', 'c']]);
    expect(relay.opens()).toBe(opens);
  });

  it('replaces with narrower windows after a quota refusal, and stops with a diagnostic and an unserve when the narrowest is refused', async () => {
    const diagnostics: Wire[] = [];
    const relay = scriptedRelay({ onPublish: (message, answer) => {
      if (message.entries.some((value: Wire) => value.op === 'replace')) answer.refuse('quota_exceeded'); else answer.ack();
    } });
    const publisher = publisherFor(relay, { quotaWindows: [3, 2, 1] }, diagnostics);
    await attachSession(publisher, Array.from({ length: 5 }, (_, at) => item('history', `m${at}`, `Item ${at}`)));
    await until(() => diagnostics.some(entry => entry.event === 'journal_session_stopped'), 'the session to stop');
    expect(relay.publishes().map(message => message.entries[0].items.length)).toEqual([5, 3, 2, 1]);
    expect(diagnostics.find(entry => entry.event === 'journal_session_stopped')).toMatchObject({ providerId: 'fake', reason: 'quota_exceeded' });
    await settle(100);
    expect(relay.publishes()).toHaveLength(4);
    expect(relay.unserves()).toEqual([{ uplinkVersion: 2, type: 'journal_unserve', sessionKey: 'fake:thread-1', generation: 4 }]);
  });

  it('does not loop when the replacement a quota asked for is accepted: it reopens once, finds the window known, publishes the head and goes live', async () => {
    const diagnostics: Wire[] = [];
    let refusals = 0;
    const relay = scriptedRelay({ onPublish: (message, answer) => {
      if (refusals === 0 && message.entries.some((value: Wire) => value.op === 'replace')) { refusals += 1; answer.refuse('quota_exceeded'); } else answer.ack();
    } });
    const publisher = publisherFor(relay, { quotaWindows: [3, 2, 1] }, diagnostics);
    const { session } = await attachSession(publisher, Array.from({ length: 5 }, (_, at) => item('history', `m${at}`, `Item ${at}`)));
    await until(() => relay.model().length === 3 && relay.ops().includes('head'), 'the window to be accepted');
    session.push(item('live', 'later', 'Still publishing', { completes: true }));
    await until(() => relay.ops().includes('complete'), 'a live item after the window');
    await settle(100);
    const replaces = relay.publishes().flatMap(message => message.entries).filter((value: Wire) => value.op === 'replace');
    expect(replaces.map((value: Wire) => value.items.length)).toEqual([5, 3]);
    expect(relay.opens()).toBe(3);
    expect(diagnostics.map(entry => entry.event)).not.toContain('journal_session_stopped');
    expect(diagnostics.find(entry => entry.event === 'journal_quota_window')).toMatchObject({ reason: '3' });
  });

  it('does not count the replacements a quota asks for as a rewrite loop: every window may be tried', async () => {
    const diagnostics: Wire[] = [];
    let refusals = 0;
    const relay = scriptedRelay({ onPublish: (message, answer) => {
      if (refusals < 3 && message.entries.some((value: Wire) => value.op === 'replace')) { refusals += 1; answer.refuse('quota_exceeded'); } else answer.ack();
    } });
    const publisher = publisherFor(relay, { quotaWindows: [4, 3, 2, 1] }, diagnostics);
    await attachSession(publisher, Array.from({ length: 5 }, (_, at) => item('history', `m${at}`, `Item ${at}`)));
    await until(() => relay.model().length === 2 && relay.ops().includes('head'), 'the third window to be accepted');
    expect(diagnostics.map(entry => entry.event)).not.toContain('journal_session_stopped');
  });

  it('answers an incomplete journal with a replacement of the same window, then the head, without narrowing', async () => {
    const diagnostics: Wire[] = [];
    let refusals = 0;
    const relay = scriptedRelay({ onPublish: (message, answer) => {
      if (refusals === 0 && message.entries.some((value: Wire) => value.op === 'head')) { refusals += 1; answer.refuse('incomplete', undefined, message.entries.at(-1).sequence); } else answer.ack();
    } });
    const publisher = publisherFor(relay, { quotaWindows: [3, 2, 1] }, diagnostics);
    const { session } = await attachSession(publisher, Array.from({ length: 5 }, (_, at) => item('history', `m${at}`, `Item ${at}`)));
    await until(() => relay.model().length === 5 && relay.opens() === 3 && relay.ops().filter(op => op === 'head').length >= 2, 'the replacement, its head and the open that follows');
    const replaces = relay.publishes().flatMap(message => message.entries).filter((value: Wire) => value.op === 'replace');
    expect(replaces.map((value: Wire) => value.items.length)).toEqual([5, 5]);
    expect(diagnostics.map(entry => entry.event)).not.toContain('journal_quota_window');
    session.push(item('live', 'later', 'Still publishing', { completes: true }));
    await until(() => relay.ops().includes('complete'), 'a live item after the head');
  });

  it('stops, and takes the session out of serving, when the Relay keeps calling the journal incomplete', async () => {
    const diagnostics: Wire[] = [];
    const relay = scriptedRelay({ onPublish: (message, answer) => answer.refuse('incomplete', undefined, message.entries.at(-1).sequence) });
    const publisher = publisherFor(relay, {}, diagnostics);
    await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => diagnostics.some(entry => entry.event === 'journal_session_stopped'), 'the session to stop');
    expect(diagnostics.find(entry => entry.event === 'journal_session_stopped')).toMatchObject({ providerId: 'fake', reason: 'incomplete' });
    expect(relay.unserves()).toHaveLength(1);
  });

  it('stops, tells the Relay to stop serving the journal and records the breach when the provider emits an observation without identity', async () => {
    const diagnostics: Wire[] = [];
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, {}, diagnostics);
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await live(relay);
    session.push({ ...item('live', 'm2', 'No identity', { completes: true }), itemIdentity: undefined });
    await until(() => relay.unserves().length > 0, 'the unserve');
    // The journal was opened twice: for the replacement of the empty journal, and again for the head. The unserve names the second.
    expect(relay.unserves()[0]).toMatchObject({ sessionKey: 'fake:thread-1', generation: relay.opens() });
    expect(diagnostics).toContainEqual({ event: 'journal_session_stopped', providerId: 'fake', reason: 'identity_missing' });
    const published = relay.publishes().length;
    const opens = relay.opens();
    session.push(item('live', 'm3', 'Later', { completes: true }));
    await settle(100);
    expect(relay.publishes()).toHaveLength(published);
    expect(relay.opens()).toBe(opens);
    expect(relay.unserves()).toHaveLength(1);
  });

  it('stops a session whose provider uses the key prefix reserved for the Controller, and unserves it on the first open, which holds the head of an earlier connection', async () => {
    const diagnostics: Wire[] = [];
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, {}, diagnostics);
    await attachSession(publisher, [item('history', 'controller:m1', 'Hello')]);
    await until(() => relay.unserves().length === 1, 'the unserve');
    expect(diagnostics).toContainEqual({ event: 'journal_session_stopped', providerId: 'fake', reason: 'identity_missing' });
    expect(relay.opens()).toBe(1);
    expect(relay.unserves()[0]).toMatchObject({ sessionKey: 'fake:thread-1', generation: 1 });
    expect(relay.publishes()).toEqual([]);
  });

  it('unserves a session whose identity is missing when the connection comes back, if it could not before', async () => {
    const relay = scriptedRelay();
    const publisher = createJournalPublisher({ providers: () => ['fake'], scheduler: clock, now: clock.now, limits: { responseTimeoutMs: 10_000 } });
    closers.push(() => publisher.close());
    await attachSession(publisher, [item('history', 'controller:m1', 'Hello')]);
    await settle(30);
    expect(relay.written).toEqual([]);
    relay.connect(publisher);
    await until(() => relay.unserves().length === 1, 'the unserve on the first connection');
    expect(relay.publishes()).toEqual([]);
  });

  it('keeps publishing nothing for a session it gave up on until a connection returns, then tries it again', async () => {
    const relay = scriptedRelay({ onPublish: (message, answer) => answer.refuse('incomplete', undefined, message.entries.at(-1).sequence) });
    const publisher = publisherFor(relay);
    await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.unserves().length === 1, 'the unserve');
    const opens = relay.opens();
    await settle(200);
    expect(relay.opens()).toBe(opens);
    publisher.available(undefined);
    relay.connect(publisher);
    await until(() => relay.opens() === opens + 1, 'the open on the next connection');
  });

  function failsOnce(failed = new Set<string>()) {
    return (message: Wire, answer: Answer) => {
      const live = message.entries.find((value: Wire) => value.op === 'append' && ['a', 'b'].includes(value.row.itemKey) && !failed.has(value.row.itemKey));
      if (live) { failed.add(live.row.itemKey); answer.refuse('stale_revision', live.row.itemKey, live.sequence); } else answer.ack();
    };
  }

  /** How long the publisher waited to open again after each of its two failures. */
  async function waitsAfterTwoFailures(secondPushAfterMs: number, sustainedMs: number): Promise<[number, number]> {
    const relay = scriptedRelay({ onPublish: failsOnce() });
    const publisher = publisherFor(relay, { batchWindowMs: 1, backoffBaseMs: 100, backoffMaxMs: 10_000, sustainedMs });
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await settle(100);
    session.push(item('live', 'a', 'One', { completes: true }));
    await settle(secondPushAfterMs);
    session.push(item('live', 'b', 'Two', { completes: true }));
    await settle(600);
    const opens = relay.opensAt();
    const refused = relay.refusedAt();
    expect(refused).toHaveLength(2);
    expect(opens.length).toBeGreaterThanOrEqual(4);
    return [opens[2]! - refused[0]!, opens[3]! - refused[1]!];
  }

  it('starts the backoff over only after the session published for a sustained time', async () => {
    const [first, second] = await waitsAfterTwoFailures(1500, 500);
    expect(first).toBeGreaterThanOrEqual(100);
    expect(first).toBeLessThan(150);
    expect(second).toBeGreaterThanOrEqual(100);
    expect(second).toBeLessThan(150);
  });

  it('doubles the backoff when failures follow each other closely', async () => {
    const [first, second] = await waitsAfterTwoFailures(200, 5000);
    expect(first).toBeGreaterThanOrEqual(100);
    expect(first).toBeLessThan(150);
    expect(second).toBeGreaterThanOrEqual(200);
    expect(second).toBeLessThan(250);
  });

  it('keeps reading a head change that arrives while the session reconciles, and publishes it once the session is live', async () => {
    const relay = scriptedRelay({ holdOpened: true, index: [entry('zz', 1, { liveOnly: true })] });
    const publisher = publisherFor(relay, { batchWindowMs: 5 });
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.opens() === 1, 'the open');
    session.push({ type: 'observation', sourceKey: 'turn-1', occurredAt: 5, delivery: 'live', event: { type: 'turn_started', provider: 'fake', turnId: 'turn-9' } });
    await settle(30);
    relay.releaseOpens();
    await until(() => relay.ops().filter(op => op === 'head').length >= 2, 'a head after going live');
    expect(relay.opens()).toBe(1);
    const heads = relay.publishes().flatMap(message => message.entries).filter((value: Wire) => value.op === 'head') as Wire[];
    expect(heads.at(-1)!.head.snapshot.activeTurn).toMatchObject({ turnId: 'turn-9' });
  });

  it('holds the rows that arrive while it reconciles, and publishes them after the reconcile is acknowledged', async () => {
    const relay = scriptedRelay({ holdOpened: true, index: [entry('zz', 1, { liveOnly: true })] });
    const publisher = publisherFor(relay, { batchWindowMs: 5 });
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.opens() === 1, 'the open');
    session.push(item('live', 'late', 'Arrived during the open', { completes: true }));
    await settle(30);
    expect(relay.publishes()).toEqual([]);
    relay.releaseOpens();
    await until(() => relay.model().some(value => value.itemKey === 'late' && value.state === 'complete'), 'the held row');
    const entries = relay.publishes().flatMap(message => message.entries) as Wire[];
    expect(entries.findIndex(value => value.op === 'head')).toBeLessThan(entries.findIndex(value => value.op === 'append' && value.row.itemKey === 'late'));
  });

  it('opens at most the allowed number of sessions at a time, and frees the place once a session has read its index', async () => {
    const pending: Array<() => void> = [];
    const relay = scriptedRelay({ onPublish: (_message, answer) => { pending.push(answer.ack); } });
    const publisher = publisherFor(relay, { concurrentOpens: 1 });
    await attachSession(publisher, [item('history', 'a1', 'First')], undefined, { agentId: 'agent-1', nativeSessionId: 'thread-1' });
    await until(() => pending.length === 1, 'the first session to wait for its acknowledgement');
    await attachSession(publisher, [item('history', 'b1', 'Second')], undefined, { agentId: 'agent-2', nativeSessionId: 'thread-2' });
    await until(() => relay.opens() === 2, 'the second session to open while the first waits');
    await until(() => pending.length === 2, 'the second session to publish while the first waits');
  });

  it('keeps a session from opening while the allowed number of sessions are still reading their index', async () => {
    const relay = scriptedRelay({ holdOpened: true });
    const publisher = publisherFor(relay, { concurrentOpens: 1 });
    await attachSession(publisher, [item('history', 'a1', 'First')], undefined, { agentId: 'agent-1', nativeSessionId: 'thread-1' });
    await attachSession(publisher, [item('history', 'b1', 'Second')], undefined, { agentId: 'agent-2', nativeSessionId: 'thread-2' });
    await settle(60);
    expect(relay.opens()).toBe(1);
    relay.releaseOpens();
    await until(() => relay.opens() === 2, 'the second open once the first index is read');
  });

  it('keeps no more messages in flight than the shared budget allows, across sessions', async () => {
    const pending: Array<() => void> = [];
    const relay = scriptedRelay({ onPublish: (_message, answer) => { pending.push(answer.ack); } });
    const publisher = publisherFor(relay, { inFlightMessages: 2 });
    for (const at of [1, 2, 3]) await attachSession(publisher, [item('history', `a${at}`, 'Text')], undefined, { agentId: `agent-${at}`, nativeSessionId: `thread-${at}` });
    await until(() => pending.length === 2, 'two messages in flight');
    await settle(60);
    expect(pending).toHaveLength(2);
    pending.shift()!();
    await until(() => relay.publishes().some(message => message.sessionKey === 'fake:thread-3'), 'the third session once room is given back');
  });

  it('closes a gap without publishing twice the rows that arrive while it reads older history', async () => {
    const relay = scriptedRelay({ index: [entry('m1', 1)] });
    const publisher = publisherFor(relay, { batchWindowMs: 5 });
    const session = new ScriptedSession('fake', 'thread-1', [item('history', 'm3', 'Three'), boundary('older-1')], [{ observations: [item('history', 'm1', 'One'), item('history', 'm2', 'Two')] }]);
    const manager = await attachScripted(session);
    closers.push(() => { void manager.close(); });
    let injected = false;
    const source = sourceOf(manager, {
      async loadOlderHistory() {
        const loaded = await manager.loadOlderHistory();
        if (!injected) { injected = true; session.push(item('live', 'x', 'Live during the gap', { completes: true })); await settle(20); }
        return loaded;
      },
    });
    publisher.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source });
    await until(() => relay.model().some(value => value.itemKey === 'x' && value.state === 'complete'), 'the live item');
    await settle(40);
    const appended = relay.publishes().flatMap(message => message.entries).filter((value: Wire) => value.op === 'append' && value.row.itemKey === 'x');
    expect(appended).toHaveLength(1);
    expect(appended[0].row.item.text).toBe('Live during the gap');
  });

  it('starts over when the connection returns, from the manager\'s timeline and the Relay\'s watermark', async () => {
    const relay = scriptedRelay({ index: [] });
    const publisher = publisherFor(relay);
    await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await live(relay);
    publisher.available(undefined);
    const opens = relay.opens();
    await settle(30);
    expect(relay.opens()).toBe(opens);
    relay.connect(publisher);
    await until(() => relay.opens() === opens + 1, 'the open after the connection returned');
  });
});

describe('giving up on a session, and following another source of it', () => {
  it('stops, tells the Relay to stop serving the journal and says why when the Snapshot cannot be published', async () => {
    const diagnostics: Wire[] = [];
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, { batchWindowMs: 5 }, diagnostics);
    const session = new ScriptedSession('fake', 'thread-1', [item('history', 'm1', 'Hello'), boundary()]);
    const manager = await attachScripted(session);
    closers.push(() => { void manager.close(); });
    let broken = false;
    const source = sourceOf(manager, { snapshot: () => { const snapshot = manager.snapshot(); if (broken) snapshot.payload.id = ''; return snapshot; } });
    publisher.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source });
    await live(relay);
    broken = true;
    session.push({ type: 'observation', sourceKey: 'turn-1', occurredAt: 5, delivery: 'live', event: { type: 'turn_started', provider: 'fake', turnId: 'turn-9' } });
    await until(() => relay.unserves().length === 1, 'the unserve');
    expect(diagnostics).toContainEqual({ event: 'journal_session_stopped', providerId: 'fake', reason: 'head_rejected' });
    expect(relay.unserves()[0]).toMatchObject({ generation: expect.any(Number) });
  });

  it('follows a manager that replaces the one it followed, and ignores the old one', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, { batchWindowMs: 5 });
    const first = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await live(relay);
    const opens = relay.opens();
    const second = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.opens() === opens + 1, 'the open of the new source');
    await until(() => relay.types().at(-1) === 'journal_publish', 'the head of the new source');
    first.session.push(item('live', 'old', 'From the manager that closed', { completes: true }));
    second.session.push(item('live', 'new', 'From the woken manager', { completes: true }));
    await until(() => relay.model().some(value => value.itemKey === 'new' && value.state === 'complete'), 'the new source\'s item');
    expect(relay.model().map(value => value.itemKey)).not.toContain('old');
  });

  it('keeps following the same manager when it is attached again', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay);
    const { manager } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await live(relay);
    const opens = relay.opens();
    expect(publisher.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source: manager })).toBe(true);
    await settle(40);
    expect(relay.opens()).toBe(opens);
  });

  it('does not follow a manager that is already closed, and tells it nothing', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay);
    const session = new ScriptedSession('fake', 'thread-1', [boundary()]);
    const manager = await attachScripted(session);
    await manager.close();
    publisher.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source: manager });
    await settle(50);
    expect(relay.ops()).toEqual([]);
    await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.ops().includes('head'), 'a live manager of the same session');
  });

  it('stops following a manager whose tap was dropped, and follows it again when it is attached again', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, { batchWindowMs: 5 });
    const session = new ScriptedSession('fake', 'thread-1', [item('history', 'm1', 'Hello'), boundary()]);
    const manager = await attachScripted(session);
    closers.push(() => { void manager.close(); });
    let tap: AgentJournalTap | undefined;
    const source = sourceOf(manager, { subscribeJournal: next => { tap = next; return manager.subscribeJournal(next); } });
    publisher.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source });
    await live(relay);
    const opens = relay.opens();
    tap!.closed();
    await settle(60);
    session.push(item('live', 'a', 'Nobody follows', { completes: true }));
    await settle(60);
    expect(relay.ops()).not.toContain('append');
    expect(publisher.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source: manager })).toBe(true);
    await until(() => relay.opens() === opens + 1 && relay.model().some(value => value.itemKey === 'a' && value.state === 'complete'), 'the open of the source followed again');
  });

  it('refuses at once a fill or an older-history request for a session it does not follow', async () => {
    const relay = scriptedRelay();
    publisherFor(relay);
    relay.send({ uplinkVersion: 2, type: 'journal_fill_request', requestId: 'fill-1', sessionKey: 'fake:unknown', itemKeys: ['m1'] });
    relay.send({ uplinkVersion: 2, type: 'journal_older_request', requestId: 'older-1', sessionKey: 'fake:unknown', limit: 10 });
    await until(() => relay.written.filter(message => message.type === 'journal_request_refused').length === 2, 'the refusals');
    expect(relay.written.filter(message => message.type === 'journal_request_refused')).toEqual([
      { uplinkVersion: 2, type: 'journal_request_refused', requestId: 'fill-1', sessionKey: 'fake:unknown', reason: 'not_followed' },
      { uplinkVersion: 2, type: 'journal_request_refused', requestId: 'older-1', sessionKey: 'fake:unknown', reason: 'not_followed' },
    ]);
  });

  it('refuses a request for a session it follows but cannot answer, as not ready', async () => {
    const relay = scriptedRelay({ onPublish: (message, answer) => answer.refuse('incomplete', undefined, message.entries.at(-1).sequence) });
    const diagnostics: Wire[] = [];
    const publisher = publisherFor(relay, {}, diagnostics);
    await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => diagnostics.some(entry => entry.event === 'journal_session_stopped'), 'the session to be given up');
    relay.send({ uplinkVersion: 2, type: 'journal_fill_request', requestId: 'fill-1', sessionKey: 'fake:thread-1', itemKeys: ['m1'] });
    await until(() => relay.written.some(message => message.type === 'journal_request_refused'), 'the refusal');
    expect(relay.written.find(message => message.type === 'journal_request_refused')).toMatchObject({ requestId: 'fill-1', reason: 'not_ready' });
  });
});

describe('older history and fills the Relay asks for', () => {
  it('publishes the manager\'s older items as a prepend, and reads further native history when it has none left', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay);
    const { manager } = await attachSession(publisher, [item('history', 'm3', 'Three'), item('history', 'm4', 'Four')], [
      { observations: [item('history', 'm1', 'One'), item('history', 'm2', 'Two')], nextCursor: 'older-2' },
      { observations: [item('history', 'm0', 'Zero')], nextCursor: 'older-3' },
    ], { agentId: 'agent-1', nativeSessionId: 'thread-1' }, { relay, keys: ['m3', 'm4'] });
    await live(relay);
    const before = relay.written.length;
    relay.send({ uplinkVersion: 2, type: 'journal_older_request', requestId: 'older-1', sessionKey: 'fake:thread-1', limit: 3 });
    await until(() => relay.written.slice(before).some(message => message.type === 'journal_older_done'), 'the answer');
    const written = relay.written.slice(before);
    const prepend = written.find(message => message.type === 'journal_publish')!.entries[0];
    expect(prepend.op).toBe('prepend');
    expect(prepend.items.map((value: Wire) => value.row.itemKey)).toEqual(['m0', 'm1', 'm2']);
    expect(written.find(message => message.type === 'journal_older_done')).toMatchObject({ requestId: 'older-1', olderAvailable: true });
    expect(manager.hasOlderHistory()).toBe(true);
  });

  it('says that no older history is left once native history is read to its start', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay);
    await attachSession(publisher, [item('history', 'm2', 'Two')], [{ observations: [item('history', 'm1', 'One')] }], { agentId: 'agent-1', nativeSessionId: 'thread-1' }, { relay, keys: ['m2'] });
    await live(relay);
    relay.send({ uplinkVersion: 2, type: 'journal_older_request', requestId: 'older-1', sessionKey: 'fake:thread-1', limit: 10 });
    await until(() => relay.written.some(message => message.type === 'journal_older_done'), 'the answer');
    expect(relay.written.find(message => message.type === 'journal_older_done')).toMatchObject({ olderAvailable: false });
  });

  it('answers a fill request with the bodies it still has, complete and with their digests', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay);
    await attachSession(publisher, [item('history', 'm1', 'One'), item('history', 'm2', 'Two')], undefined, { agentId: 'agent-1', nativeSessionId: 'thread-1' }, { relay, keys: ['m1'] });
    await live(relay);
    relay.send({ uplinkVersion: 2, type: 'journal_fill_request', requestId: 'fill-1', sessionKey: 'fake:thread-1', itemKeys: ['m1', 'missing'] });
    await until(() => relay.written.some(message => message.type === 'journal_fill'), 'the fill');
    const fill = relay.written.find(message => message.type === 'journal_fill')!;
    expect(fill).toMatchObject({ requestId: 'fill-1', sessionKey: 'fake:thread-1' });
    expect(fill.items.map((value: Wire) => [value.row.itemKey, value.row.item.text, typeof value.digest])).toEqual([['m1', 'One', 'string']]);
  });

  it('takes room from the shared budget for a fill, like a publication', async () => {
    const pending: Array<() => void> = [];
    const relay = scriptedRelay({ onPublish: (_message, answer) => { pending.push(answer.ack); } });
    const publisher = publisherFor(relay, { inFlightMessages: 1 });
    await attachSession(publisher, [item('history', 'm1', 'One')], undefined, { agentId: 'agent-1', nativeSessionId: 'thread-1' }, { relay, keys: ['m1'] });
    await until(() => pending.length === 1, 'the head waiting for its acknowledgement');
    relay.send({ uplinkVersion: 2, type: 'journal_fill_request', requestId: 'fill-1', sessionKey: 'fake:thread-1', itemKeys: ['m1'] });
    await settle(60);
    expect(relay.written.some(message => message.type === 'journal_fill')).toBe(false);
    pending.shift()!();
    await until(() => relay.written.some(message => message.type === 'journal_fill'), 'the fill after the room was given back');
  });

  it('publishes the head before the older history of a reconcile, which follows as prepends', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay);
    await attachSession(publisher, [item('history', 'm1', 'One'), item('history', 'm2', 'Two'), item('history', 'm3', 'Three'), item('history', 'm4', 'Four')], undefined, { agentId: 'agent-1', nativeSessionId: 'thread-1' }, { relay, keys: ['m3', 'm4'] });
    await until(() => relay.ops().includes('prepend'), 'the older items');
    expect(relay.publishes().map(message => message.entries.map((value: Wire) => value.op))).toEqual([['head'], ['prepend']]);
  });

  it('publishes a live row that arrives between the blocks of older history before the next block', async () => {
    const big = 'x'.repeat(2_600_000);
    let liveRow: (() => void) | undefined;
    const relay = scriptedRelay({ onPublish: (message, answer) => {
      if (liveRow && message.entries.some((value: Wire) => value.op === 'prepend')) {
        liveRow();
        liveRow = undefined;
        setImmediate(() => answer.ack());
      } else answer.ack();
    } });
    const publisher = publisherFor(relay, { batchWindowMs: 1 });
    const { session } = await attachSession(publisher, [item('history', 'm3', 'Three')], [{ observations: [item('history', 'm1', big), item('history', 'm2', big)] }], { agentId: 'agent-1', nativeSessionId: 'thread-1' }, { relay, keys: ['m3'] });
    await until(() => relay.ops().includes('head'), 'the head');
    liveRow = () => session.push(item('live', 'between', 'Between the blocks', { completes: true }));
    relay.send({ uplinkVersion: 2, type: 'journal_older_request', requestId: 'older-1', sessionKey: 'fake:thread-1', limit: 2 });
    await until(() => relay.written.some(message => message.type === 'journal_older_done'), 'the answer');
    const ops = relay.publishes().flatMap(message => message.entries.map((value: Wire) => value.op));
    expect(ops.filter(op => op === 'prepend')).toHaveLength(2);
    expect(ops.indexOf('append')).toBeGreaterThan(ops.indexOf('prepend'));
    expect(ops.indexOf('append')).toBeLessThan(ops.lastIndexOf('prepend'));
  });
});

describe('releasing a session', () => {
  it('publishes what is queued before it stops following', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, { batchWindowMs: 5000 });
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await live(relay);
    session.push(item('live', 'a', 'Last words', { completes: true }));
    await settle(30);
    let done = false;
    void publisher.release('agent-1').then(() => { done = true; });
    await until(() => done, 'the release');
    expect(relay.ops()).toContain('complete');
    const opens = relay.opens();
    session.push(item('live', 'b', 'After release', { completes: true }));
    await settle(100);
    expect(relay.ops().filter(op => op === 'append')).toHaveLength(1);
    expect(relay.opens()).toBe(opens);
  });
});

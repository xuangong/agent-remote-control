import type { JournalRelayMessage } from '@orchardworks/agent-remote-protocol';
import type { AgentJournalTap } from '@orchardworks/agent-remote-relay';
import { afterEach, describe, expect, it } from 'vitest';

import { MESSAGE_BUDGET_BYTES } from './journal-items.js';
import { createJournalPublisher, type JournalPublisher, type JournalSource } from './journal-publisher.js';
import { attachScripted, boundary, driver, item, ScriptedSession, virtualClock } from './test-utils/journal-scripted-session.js';

type Wire = Record<string, any>;
const clock = virtualClock();
const { settle, until } = driver(clock);
const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

interface Answer { ack(): void; refuse(reason: string): void; ignore(): void }

/** A Relay that answers the publisher by script and keeps the keys of the items it was sent. Every message the publisher writes is recorded. */
function scriptedRelay(options: { watermark?: number; holdOpened?: boolean; refuseOpen?(opens: number): boolean; onPublish?(message: Wire, answer: Answer): void } = {}) {
  const written: Wire[] = [];
  const writtenAt: number[] = [];
  const refusedAt: number[] = [];
  let publisher!: JournalPublisher;
  /** What the Relay keeps of one session: its generation, watermark and item keys with their state. */
  interface Held { generation: number; applied: number; model: Array<{ itemKey: string; state: 'open' | 'complete' }> }
  const sessions = new Map<string, Held>();
  const heldBy = (sessionKey: string): Held => {
    let held = sessions.get(sessionKey);
    if (!held) { held = { generation: 0, applied: options.watermark ?? 0, model: [] }; sessions.set(sessionKey, held); }
    return held;
  };
  const heldOpens: Array<() => void> = [];
  const send = (message: JournalRelayMessage) => queueMicrotask(() => publisher.receive(message));
  const apply = (held: Held, entries: Wire[]): void => {
    for (const value of entries) {
      const at = held.model.findIndex(entry => entry.itemKey === (value.itemKey ?? value.row?.itemKey));
      if (value.op === 'window') held.model = value.items.map((input: Wire) => ({ itemKey: input.row.itemKey, state: input.digest ? 'complete' : 'open' }));
      else if (value.op === 'prepend') held.model = [...value.items.map((input: Wire) => ({ itemKey: input.row.itemKey, state: input.digest ? 'complete' : 'open' })), ...held.model];
      else if (value.op === 'append' && at < 0) held.model.push({ itemKey: value.row.itemKey, state: 'open' });
      else if (value.op === 'complete' && at >= 0) held.model[at] = { ...held.model[at]!, state: 'complete' };
    }
  };
  const writer = { send(json: string) {
    const message: Wire = JSON.parse(json);
    written.push(message);
    writtenAt.push(clock.now());
    const held = heldBy(message.sessionKey);
    if (message.type === 'journal_open') {
      if (options.refuseOpen?.(written.filter(entry => entry.type === 'journal_open').length)) {
        send({ uplinkVersion: 2, type: 'journal_open_refused', requestId: message.requestId, sessionKey: message.sessionKey, reason: 'unavailable' });
        return;
      }
      held.generation += 1;
      const reply = () => send({ uplinkVersion: 2, type: 'journal_opened', requestId: message.requestId, sessionKey: message.sessionKey, generation: held.generation, watermark: held.applied });
      if (options.holdOpened) heldOpens.push(reply); else reply();
    } else if (message.type === 'journal_publish') {
      const generationOf: number = message.generation;
      // As the Relay does: entries at or below the watermark are duplicates and are ignored, and the rest must start exactly after it.
      const fresh: Wire[] = message.entries.filter((value: Wire) => value.sequence > held.applied);
      const last = message.entries.at(-1).sequence as number;
      const ackTo = (watermark: number): void => send({ uplinkVersion: 2, type: 'journal_ack', sessionKey: message.sessionKey, generation: generationOf, watermark, cursor: { epoch: 'epoch-1', seq: watermark } });
      if (fresh.length === 0) { ackTo(last); return; }
      if (fresh[0]!.sequence !== held.applied + 1) {
        refusedAt.push(clock.now());
        send({ uplinkVersion: 2, type: 'journal_refused', sessionKey: message.sessionKey, generation: generationOf, sequence: fresh[0]!.sequence, reason: 'sequence_gap' });
        return;
      }
      const answer: Answer = {
        ack: () => { apply(held, fresh); held.applied = last; ackTo(last); },
        refuse: reason => {
          refusedAt.push(clock.now());
          send({ uplinkVersion: 2, type: 'journal_refused', sessionKey: message.sessionKey, generation: generationOf, sequence: fresh[0]!.sequence, reason } as JournalRelayMessage);
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
    windows: () => written.filter(message => message.type === 'journal_publish').flatMap(message => message.entries).filter((value: Wire) => value.op === 'window') as Wire[],
    opens: () => written.filter(message => message.type === 'journal_open').length,
    opensAt: () => written.flatMap((message, at) => message.type === 'journal_open' ? [writtenAt[at]!] : []),
    refusedAt: () => refusedAt,
    releaseOpens: () => { for (const reply of heldOpens.splice(0)) reply(); },
    model: (sessionKey = 'fake:thread-1') => heldBy(sessionKey).model,
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
async function attachSession(publisher: JournalPublisher, history: Observation[], older?: Array<{ observations: Observation[]; nextCursor?: string }>, ids = { agentId: 'agent-1', nativeSessionId: 'thread-1' }) {
  const session = new ScriptedSession('fake', ids.nativeSessionId, [...history, boundary(older ? 'older-1' : undefined)], older);
  const manager = await attachScripted(session, ids.agentId);
  closers.push(() => { void manager.close(); });
  publisher.attach({ agentId: ids.agentId, providerId: 'fake', nativeSessionId: ids.nativeSessionId, source: manager });
  return { session, manager };
}

/** The session is live: its journal was opened, the window and the head published. */
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
  it('opens the journal, publishes the newest items as one window, and ends with the head', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay);
    await attachSession(publisher, [item('history', 'm1', 'Hello'), item('history', 'm2', 'World')]);
    await until(() => relay.ops().includes('head'), 'the head');
    expect(relay.types()[0]).toBe('journal_open');
    expect(relay.written[0]).toMatchObject({ sessionKey: 'fake:thread-1', publisherId: expect.any(String) });
    const publish = relay.publishes()[0]!;
    expect(publish.generation).toBe(1);
    expect(publish.entries.map((value: Wire) => value.op)).toEqual(['window', 'head']);
    expect(publish.entries[0].items.map((value: Wire) => value.row.itemKey)).toEqual(['m1', 'm2']);
    expect(publish.entries[1].head.snapshot.id).toBe('agent-1');
  });

  it('sends the window again on every open, and asks for no index', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay);
    await attachSession(publisher, [item('history', 'm1', 'Hello'), item('history', 'm2', 'World')]);
    await live(relay);
    publisher.available(undefined);
    relay.connect(publisher);
    await until(() => relay.windows().length === 2 && relay.ops().filter(op => op === 'head').length === 2, 'the second window and head');
    expect(relay.windows().map(value => value.items.map((input: Wire) => input.row.itemKey))).toEqual([['m1', 'm2'], ['m1', 'm2']]);
    expect(relay.types().filter(type => type !== 'journal_open' && type !== 'journal_publish')).toEqual([]);
  });

  it('numbers its entries from the Relay\'s watermark and waits for each acknowledgement before the next message', async () => {
    const pending: Array<() => void> = [];
    const relay = scriptedRelay({ watermark: 7, onPublish: (_message, answer) => { pending.push(answer.ack); } });
    const publisher = publisherFor(relay);
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => pending.length === 1, 'the first publication');
    expect(relay.publishes()[0]!.entries.map((value: Wire) => value.sequence)).toEqual([8, 9]);
    session.push(item('live', 'a', 'Streaming', { completes: false }));
    await settle(40);
    expect(relay.publishes()).toHaveLength(1);
    pending.shift()!();
    await until(() => pending.length === 1, 'the next publication after the acknowledgement');
    expect(relay.publishes().at(-1)!.entries.map((value: Wire) => [value.sequence, value.op])).toEqual([[10, 'append']]);
  });

  it('opens again with backoff when the Relay refuses the open, and goes live without unserving', async () => {
    const diagnostics: Wire[] = [];
    const relay = scriptedRelay({ refuseOpen: opens => opens === 1 });
    const publisher = publisherFor(relay, {}, diagnostics);
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.opens() === 2 && relay.ops().includes('head'), 'the second open');
    expect(diagnostics.filter(entry => entry.event === 'journal_open_refused')).toEqual([{ event: 'journal_open_refused', providerId: 'fake', reason: 'unavailable' }]);
    expect(relay.unserves()).toEqual([]);
    session.push(item('live', 'later', 'Still publishing', { completes: true }));
    await until(() => relay.ops().includes('complete'), 'a live item after the refused open');
    expect(diagnostics.map(entry => entry.event)).not.toContain('journal_session_stopped');
  });

  it('sends an empty window when native history is exhausted and empty, and none while older pages remain unread', async () => {
    const exhausted = scriptedRelay();
    await attachSession(publisherFor(exhausted), []);
    await until(() => exhausted.ops().includes('head'), 'the head');
    expect(exhausted.ops()).toEqual(['window', 'head']);
    expect(exhausted.windows()[0]!.items).toEqual([]);

    const unread = scriptedRelay();
    await attachSession(publisherFor(unread, { gapReadsMax: 1 }), [], [{ observations: [], nextCursor: 'older-2' }, { observations: [item('history', 'm1', 'One')] }]);
    await until(() => unread.ops().includes('head'), 'the head');
    expect(unread.ops()).toEqual(['head']);
  });

  it('reads older pages before it sends a window, so an empty newest page does not empty the journal', async () => {
    const relay = scriptedRelay();
    await attachSession(publisherFor(relay), [], [{ observations: [], nextCursor: 'older-2' }, { observations: [item('history', 'm1', 'One')] }]);
    await until(() => relay.ops().includes('head'), 'the head');
    expect(relay.windows().map(value => value.items.map((input: Wire) => input.row.itemKey))).toEqual([['m1']]);
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

  it('leaves an item the wire refuses out of every window, and tells the diagnostics once', async () => {
    const diagnostics: Wire[] = [];
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, {}, diagnostics);
    await attachSession(publisher, [item('history', 'bad', 'x', { turnId: 't'.repeat(600) }), item('history', 'm1', 'Hello')]);
    await live(relay);
    publisher.available(undefined);
    relay.connect(publisher);
    await until(() => relay.windows().length === 2 && relay.ops().filter(op => op === 'head').length >= 2, 'the second window');
    expect(diagnostics.filter(entry => entry.event === 'journal_row_rejected')).toHaveLength(1);
    expect(relay.windows().map(value => value.items.map((input: Wire) => input.row.itemKey))).toEqual([['m1'], ['m1']]);
  });

  it('sends an empty window when the wire refuses every item of a session whose history is exhausted', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay);
    await attachSession(publisher, [item('history', 'bad', 'x', { turnId: 't'.repeat(600) })]);
    await until(() => relay.ops().includes('head'), 'the head');
    expect(relay.ops()).toEqual(['window', 'head']);
    expect(relay.windows()[0]!.items).toEqual([]);
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

  it('opens again after the provider replaces its timeline, and publishes nothing of the rows in between', async () => {
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
  it('opens again and sends the window again after the Relay refuses a publication', async () => {
    let refused = false;
    const relay = scriptedRelay({ onPublish: (message, answer) => {
      if (!refused && message.entries.some((value: Wire) => value.op === 'append')) { refused = true; answer.refuse('invalid'); return; }
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

  it('opens again when the Relay answers sequence_gap', async () => {
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

  it.each(['quota_exceeded', 'incomplete', 'invalid', 'sequence_gap', 'fenced'])('opens again with backoff and sends the window again after the Relay refuses a live row as %s', async reason => {
    const diagnostics: Wire[] = [];
    let refused = false;
    const relay = scriptedRelay({ onPublish: (message, answer) => {
      if (!refused && message.entries.some((value: Wire) => value.op === 'append')) { refused = true; answer.refuse(reason); } else answer.ack();
    } });
    const publisher = publisherFor(relay, { batchWindowMs: 25 }, diagnostics);
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await live(relay);
    const opens = relay.opens();
    session.push(item('live', 'a', 'Hi', { completes: true }));
    await until(() => relay.opens() === opens + 1 && relay.model().some(value => value.itemKey === 'a' && value.state === 'complete'), 'the open after the refusal, and the item');
    await settle(100);
    expect(relay.opens()).toBe(opens + 1);
    expect(relay.windows()).toHaveLength(2);
    expect(diagnostics).toContainEqual({ event: 'journal_publication_refused', providerId: 'fake', reason });
    expect(relay.unserves()).toEqual([]);
  });

  it('keeps reopening with backoff while the Relay keeps refusing, and never gives up or narrows the window', async () => {
    const diagnostics: Wire[] = [];
    const relay = scriptedRelay({ onPublish: (message, answer) => { if (message.entries.some((value: Wire) => value.op === 'window')) answer.refuse('quota_exceeded'); else answer.ack(); } });
    const publisher = publisherFor(relay, {}, diagnostics);
    await attachSession(publisher, Array.from({ length: 5 }, (_, at) => item('history', `m${at}`, `Item ${at}`)));
    await until(() => relay.opens() >= 6, 'six opens');
    expect(relay.windows().map(value => value.items.length)).toEqual(Array(relay.windows().length).fill(5));
    expect(diagnostics.map(entry => entry.event)).not.toContain('journal_session_stopped');
    expect(relay.unserves()).toEqual([]);
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
    const relay = scriptedRelay();
    const publisher = publisherFor(relay);
    await attachSession(publisher, [item('history', 'controller:m1', 'Hello')]);
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
      if (live) { failed.add(live.row.itemKey); answer.refuse('invalid'); } else answer.ack();
    };
  }

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
    expect(opens.length).toBeGreaterThanOrEqual(3);
    return [opens[1]! - refused[0]!, opens[2]! - refused[1]!];
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

  it('keeps a head change that arrives while the window is in flight, and publishes it once the session is live', async () => {
    const pending: Array<() => void> = [];
    const relay = scriptedRelay({ onPublish: (_message, answer) => { pending.push(answer.ack); } });
    const publisher = publisherFor(relay, { batchWindowMs: 5 });
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => pending.length === 1, 'the window in flight');
    session.push({ type: 'observation', sourceKey: 'turn-1', occurredAt: 5, delivery: 'live', event: { type: 'turn_started', provider: 'fake', turnId: 'turn-9' } });
    await settle(30);
    pending.shift()!();
    await until(() => relay.ops().length === 2 && pending.length === 0, 'the window acknowledged');
    await until(() => relay.ops().filter(op => op === 'head').length >= 2, 'a head after going live');
    expect(relay.opens()).toBe(1);
    const heads = relay.publishes().flatMap(message => message.entries).filter((value: Wire) => value.op === 'head') as Wire[];
    expect(heads.at(-1)!.head.snapshot.activeTurn).toMatchObject({ turnId: 'turn-9' });
  });

  it('holds the rows that arrive while it opens, and publishes them after the window and the head are acknowledged', async () => {
    const relay = scriptedRelay({ holdOpened: true });
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

  it('keeps no more bytes in flight than the shared budget allows, across sessions, and admits one message when none is in flight', async () => {
    const pending: Array<() => void> = [];
    const relay = scriptedRelay({ onPublish: (_message, answer) => { pending.push(answer.ack); } });
    const publisher = publisherFor(relay, { inFlightBytes: 1 });
    for (const at of [1, 2, 3]) await attachSession(publisher, [item('history', `a${at}`, 'Text')], undefined, { agentId: `agent-${at}`, nativeSessionId: `thread-${at}` });
    await until(() => pending.length === 1, 'one message in flight, though it is larger than the budget');
    await settle(60);
    expect(pending).toHaveLength(1);
    pending.shift()!();
    await until(() => pending.length === 1 && relay.publishes().length === 2, 'the next session once room is given back');
    pending.shift()!();
    await until(() => relay.publishes().some(message => message.sessionKey === 'fake:thread-3'), 'the third session once room is given back again');
  });

  it('publishes a row that arrives while it reads older history once, after the head', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, { batchWindowMs: 5 });
    const session = new ScriptedSession('fake', 'thread-1', [boundary('older-1')], [{ observations: [item('history', 'm1', 'One'), item('history', 'm2', 'Two')] }]);
    const manager = await attachScripted(session);
    closers.push(() => { void manager.close(); });
    let injected = false;
    const source = sourceOf(manager, {
      async loadOlderHistory() {
        const loaded = await manager.loadOlderHistory();
        if (!injected) { injected = true; session.push(item('live', 'x', 'Live during the read', { completes: true })); await settle(20); }
        return loaded;
      },
    });
    publisher.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source });
    await until(() => relay.model().some(value => value.itemKey === 'x' && value.state === 'complete'), 'the live item');
    await settle(40);
    const appended = relay.publishes().flatMap(message => message.entries).filter((value: Wire) => value.op === 'append' && value.row.itemKey === 'x');
    expect(appended).toHaveLength(1);
    expect(relay.windows()[0]!.items.map((input: Wire) => input.row.itemKey)).toEqual(['m1', 'm2']);
  });

  it('starts over when the connection returns, from the manager\'s timeline and the Relay\'s watermark', async () => {
    const relay = scriptedRelay();
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

describe('requests of the Relay', () => {
  const refusals = (relay: Relay) => relay.written.filter(message => message.type === 'journal_request_refused');

  it('refuses a request at once while the session waits to open again, well inside the Relay\'s deadline', async () => {
    let refuse = true;
    const relay = scriptedRelay({ onPublish: (message, answer) => {
      if (refuse && message.entries.some((value: Wire) => value.op === 'append')) { refuse = false; answer.refuse('invalid'); } else answer.ack();
    } });
    const publisher = publisherFor(relay, { batchWindowMs: 5, backoffBaseMs: 60_000, backoffMaxMs: 60_000 });
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await live(relay);
    const opens = relay.opens();
    session.push(item('live', 'a', 'Hi', { completes: true }));
    await until(() => relay.refusedAt().length > 0, 'the refusal that starts the wait');
    const startedAt = clock.now();
    relay.send({ uplinkVersion: 2, type: 'journal_fill_request', requestId: 'fill-1', sessionKey: 'fake:thread-1', itemKeys: ['m1'] });
    await until(() => refusals(relay).length === 1, 'the refusal of the request', 14_000);
    expect(clock.now() - startedAt).toBeLessThan(15_000);
    expect(refusals(relay)[0]).toMatchObject({ requestId: 'fill-1', reason: 'not_ready' });
    expect(relay.opens()).toBe(opens);
  });

  it('refuses a request that arrives after the open was sent and before the Relay answered it', async () => {
    const relay = scriptedRelay({ holdOpened: true });
    const publisher = publisherFor(relay);
    await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.opens() === 1, 'the open');
    relay.send({ uplinkVersion: 2, type: 'journal_older_request', requestId: 'older-1', sessionKey: 'fake:thread-1', limit: 5 });
    await until(() => refusals(relay).length === 1, 'the refusal');
    expect(refusals(relay)[0]).toMatchObject({ requestId: 'older-1', reason: 'not_ready' });
  });

  it('refuses at once the oldest request when more than 32 wait for the session to be live, instead of dropping it', async () => {
    const relay = scriptedRelay({ holdOpened: true });
    const publisher = publisherFor(relay);
    await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.opens() === 1, 'the open');
    const before = refusals(relay).length;
    for (let at = 0; at < 34; at += 1) relay.send({ uplinkVersion: 2, type: 'journal_fill_request', requestId: `fill-${at}`, sessionKey: 'fake:thread-1', itemKeys: ['m1'] });
    await settle(30);
    expect(refusals(relay).slice(before).map(message => message.requestId)).toContain('fill-0');
  });

  it('refuses a request it had queued when the cycle that queued it ends before the session is live', async () => {
    let refuse = true;
    const relay = scriptedRelay({ onPublish: (_message, answer) => {
      if (refuse) {
        refuse = false;
        // The open was answered, so the request is queued for the reconcile; the refusal then ends the cycle.
        relay.send({ uplinkVersion: 2, type: 'journal_fill_request', requestId: 'fill-1', sessionKey: 'fake:thread-1', itemKeys: ['m1'] });
        queueMicrotask(() => answer.refuse('invalid'));
      } else answer.ack();
    } });
    const publisher = publisherFor(relay);
    await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => refusals(relay).length === 1, 'the refusal when the cycle ended');
    expect(refusals(relay)[0]).toMatchObject({ requestId: 'fill-1', reason: 'not_ready' });
    await live(relay);
    expect(relay.written.some(message => message.type === 'journal_fill')).toBe(false);
  });
});

describe('what a flush sends', () => {
  it('sends the messages of one flush one at a time, each after the acknowledgement of the one before', async () => {
    const pending: Array<() => void> = [];
    let hold = false;
    const relay = scriptedRelay({ onPublish: (_message, answer) => { if (hold) pending.push(answer.ack); else answer.ack(); } });
    const publisher = publisherFor(relay, { batchWindowMs: 5 });
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await live(relay);
    hold = true;
    for (let at = 0; at < 130; at += 1) session.push(item('live', `k${at}`, 'Row', { completes: true }));
    await until(() => pending.length === 1, 'the first message of the flush');
    await settle(60);
    expect(pending).toHaveLength(1);
    const first = relay.publishes().at(-1)!;
    expect(first.entries.length).toBe(256);
    hold = false;
    pending.shift()!();
    await until(() => relay.model().some(value => value.itemKey === 'k129' && value.state === 'complete'), 'the rest of the flush');
    const sequences = relay.publishes().slice(-2).map(message => message.entries.map((value: Wire) => value.sequence));
    expect(sequences[1]![0]).toBe(sequences[0]!.at(-1)! + 1);
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
    const relay = scriptedRelay();
    const diagnostics: Wire[] = [];
    const publisher = publisherFor(relay, {}, diagnostics);
    await attachSession(publisher, [item('history', 'controller:m1', 'Hello')]);
    await until(() => diagnostics.some(entry => entry.event === 'journal_session_stopped'), 'the session to be given up');
    relay.send({ uplinkVersion: 2, type: 'journal_fill_request', requestId: 'fill-1', sessionKey: 'fake:thread-1', itemKeys: ['m1'] });
    await until(() => relay.written.some(message => message.type === 'journal_request_refused'), 'the refusal');
    expect(relay.written.find(message => message.type === 'journal_request_refused')).toMatchObject({ requestId: 'fill-1', reason: 'not_ready' });
  });
});

describe('older history and fills the Relay asks for', () => {
  it('publishes the manager\'s complete items older than the anchor as a prepend, and reads further native history when it has too few', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay);
    const { manager } = await attachSession(publisher, [item('history', 'm3', 'Three'), item('history', 'm4', 'Four')], [
      { observations: [item('history', 'm1', 'One'), item('history', 'm2', 'Two')], nextCursor: 'older-2' },
      { observations: [item('history', 'm0', 'Zero')], nextCursor: 'older-3' },
    ]);
    await live(relay);
    const before = relay.written.length;
    relay.send({ uplinkVersion: 2, type: 'journal_older_request', requestId: 'older-1', sessionKey: 'fake:thread-1', beforeItemKey: 'm3', limit: 3 });
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
    await attachSession(publisher, [item('history', 'm2', 'Two')], [{ observations: [item('history', 'm1', 'One')] }]);
    await live(relay);
    relay.send({ uplinkVersion: 2, type: 'journal_older_request', requestId: 'older-1', sessionKey: 'fake:thread-1', beforeItemKey: 'm2', limit: 10 });
    await until(() => relay.written.some(message => message.type === 'journal_older_done'), 'the answer');
    expect(relay.written.find(message => message.type === 'journal_older_done')).toMatchObject({ olderAvailable: false });
  });

  it('answers an anchor the timeline does not hold with no items, and says whether native history has more', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay);
    await attachSession(publisher, [item('history', 'm2', 'Two')], [{ observations: [] }]);
    await live(relay);
    const before = relay.publishes().length;
    relay.send({ uplinkVersion: 2, type: 'journal_older_request', requestId: 'older-1', sessionKey: 'fake:thread-1', beforeItemKey: 'unknown', limit: 10 });
    await until(() => relay.written.some(message => message.type === 'journal_older_done'), 'the answer');
    expect(relay.publishes()).toHaveLength(before);
    expect(relay.written.find(message => message.type === 'journal_older_done')).toMatchObject({ olderAvailable: false });
  });

  it('answers a fill request with the bodies it still has, complete and with their digests', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay);
    await attachSession(publisher, [item('history', 'm1', 'One'), item('history', 'm2', 'Two')]);
    await live(relay);
    relay.send({ uplinkVersion: 2, type: 'journal_fill_request', requestId: 'fill-1', sessionKey: 'fake:thread-1', itemKeys: ['m1', 'missing'] });
    await until(() => relay.written.some(message => message.type === 'journal_fill'), 'the fill');
    const fill = relay.written.find(message => message.type === 'journal_fill')!;
    expect(fill).toMatchObject({ requestId: 'fill-1', sessionKey: 'fake:thread-1' });
    expect(fill.items.map((value: Wire) => [value.row.itemKey, value.row.item.text, typeof value.digest])).toEqual([['m1', 'One', 'string']]);
  });

  it('reads native history outside the publishing lane, so a head that must go at once does not wait for the read', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, { batchWindowMs: 5000 });
    const session = new ScriptedSession('fake', 'thread-1', [item('history', 'm2', 'Two'), boundary('older-1')], [{ observations: [item('history', 'm1', 'One')] }]);
    const manager = await attachScripted(session);
    closers.push(() => { void manager.close(); });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    publisher.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source: sourceOf(manager, { loadOlderHistory: async () => { await gate; return manager.loadOlderHistory(); } }) });
    await live(relay);
    relay.send({ uplinkVersion: 2, type: 'journal_older_request', requestId: 'older-1', sessionKey: 'fake:thread-1', beforeItemKey: 'm2', limit: 5 });
    await settle(20);
    const before = relay.written.length;
    session.push({ type: 'observation', sourceKey: 'ask-1', occurredAt: 1, delivery: 'live', event: { type: 'interaction_requested', provider: 'fake', request: { kind: 'question', requestId: 'question-1', questions: [{ questionId: 'q', header: 'Pick', prompt: 'Which?', required: true, selection: 'single', options: [{ value: 'a', label: 'A' }], allowCustomText: false, allowDismiss: false }] } } });
    await until(() => relay.written.slice(before).flatMap(message => message.entries ?? []).some((value: Wire) => value.op === 'head'), 'the urgent head while the read is pending');
    expect(relay.written.some(message => message.type === 'journal_older_done')).toBe(false);
    release();
    await until(() => relay.written.some(message => message.type === 'journal_older_done'), 'the answer');
  });

  it('takes room from the shared budget for a fill, like a publication', async () => {
    const pending: Array<() => void> = [];
    const relay = scriptedRelay({ onPublish: (_message, answer) => { pending.push(answer.ack); } });
    const publisher = publisherFor(relay, { inFlightBytes: 1 });
    await attachSession(publisher, [item('history', 'm1', 'One')]);
    await until(() => pending.length === 1, 'the head waiting for its acknowledgement');
    relay.send({ uplinkVersion: 2, type: 'journal_fill_request', requestId: 'fill-1', sessionKey: 'fake:thread-1', itemKeys: ['m1'] });
    await settle(60);
    expect(relay.written.some(message => message.type === 'journal_fill')).toBe(false);
    pending.shift()!();
    await until(() => relay.written.some(message => message.type === 'journal_fill'), 'the fill after the room was given back');
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

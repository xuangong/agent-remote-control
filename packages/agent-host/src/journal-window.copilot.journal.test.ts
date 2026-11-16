import type { ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { supportsJournal } from '@orchardworks/agent-provider-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { CopilotAgentProvider } from '../../agent-provider-copilot/src/provider.js';
import { Projector } from '../../agent-provider-copilot/src/projector.js';
import type { SessionEvent } from '@github/copilot-sdk';
import { MESSAGE_BUDGET_BYTES } from './journal-items.js';
import { createJournalPublisher, type JournalPublisher } from './journal-publisher.js';
import { recording, type CopilotRecording } from './test-utils/copilot-recordings.js';
import { relayLoopback } from './test-utils/journal-relay-loopback.js';
import { attachScripted, boundary, driver, ScriptedSession, virtualClock } from './test-utils/journal-scripted-session.js';

/**
 * Copilot sessions, as the real CLI recorded them, through the Controller's publisher and the Relay's real journal service:
 * what a Controller sends when it opens a session again, and what the Relay keeps and reports.
 */
const clock = virtualClock();
const { settle, until } = driver(clock);
const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });
const SESSION = 'copilot:public';
const limits = { batchWindowMs: 5, backoffBaseMs: 5, backoffMaxMs: 20, responseTimeoutMs: 10_000 };

type Relay = ReturnType<typeof relayLoopback>;

function start(relay: Relay): JournalPublisher {
  const publisher = createJournalPublisher({ providers: () => ['copilot'], scheduler: clock, now: clock.now, limits });
  closers.push(() => publisher.close());
  relay.connect(publisher);
  return publisher;
}

const liveOf = (observations: readonly ProviderObservation[]) => observations.filter(observation => observation.delivery === 'live');

/** A native session of the Controller: its history, older pages and the live observations received since, under one manager. */
async function follow(publisher: JournalPublisher, history: readonly ProviderObservation[], options: { live?: readonly ProviderObservation[]; older?: Array<{ observations: ProviderObservation[]; nextCursor?: string }> } = {}) {
  const session = new ScriptedSession('copilot', 'public', [...history, boundary(options.older ? 'older-1' : undefined)], options.older);
  const manager = await attachScripted(session, 'agent-1');
  closers.push(() => { void manager.close(); });
  for (const observation of options.live ?? []) session.push(observation);
  if ((options.live ?? []).length > 0) await settle(20);
  publisher.attach({ agentId: 'agent-1', providerId: 'copilot', nativeSessionId: 'public', source: manager });
  return { session, manager };
}

const journalOf = async (relay: Relay) => (await relay.journal(SESSION))!;
const keysOf = async (relay: Relay) => (await journalOf(relay)).state().items.map(value => value.itemKey);
const heads = (relay: Relay) => relay.fromPublisher.filter(message => message.type === 'journal_publish' && message.entries.some((entry: { op: string }) => entry.op === 'head')).length;
const windows = (relay: Relay, from = 0) => relay.diagnosticDetails.filter(({ event }) => event === 'journal_window').slice(from).map(({ reason }) => reason);
const itemWrites = (relay: Relay, from: number) => relay.writes.slice(from).filter(write => write.upsert.length > 0 || write.removed.length > 0 || write.replaced);

async function settled(relay: Relay): Promise<void> {
  await until(async () => (await relay.journal(SESSION))?.head !== undefined, 'the head');
  await settle(30);
}

/** The session is released and opened again: a new manager reads the native history, and the connection comes back. */
async function reopenFrom(relay: Relay, publisher: JournalPublisher, history: readonly ProviderObservation[], live: readonly ProviderObservation[] = []) {
  const before = heads(relay);
  publisher.available(undefined);
  const run = await follow(publisher, history, { live });
  relay.connect(publisher);
  await until(() => heads(relay) > before, 'the head of the reopened journal');
  await settle(30);
  return run;
}

/** The Controller restarts: a new publisher and a new manager read the same native history. */
async function restart(relay: Relay, previous: JournalPublisher, history: readonly ProviderObservation[], options: Parameters<typeof follow>[2] = {}) {
  previous.close();
  const before = heads(relay);
  const publisher = start(relay);
  const run = await follow(publisher, history, options);
  await until(() => heads(relay) > before, 'the head after the restart');
  await settle(30);
  return { publisher, ...run };
}

/** Publishes a recorded live run to a Relay, and returns what the Relay holds. */
async function published(name: string, relay: Relay = relayLoopback(clock)) {
  const run = recording(name);
  const publisher = start(relay);
  await follow(publisher, [], { live: liveOf(run.live) });
  await settled(relay);
  return { run, relay, publisher };
}

describe('a recorded Copilot session that is opened again', () => {
  it('writes no item and keeps the epoch when the connection drops and the session is read again, and reports one unchanged window', async () => {
    const { run, relay, publisher } = await published('settled');
    const epoch = (await journalOf(relay)).epoch;
    const keys = await keysOf(relay);
    const writes = relay.writes.length;
    const reported = windows(relay).length;
    await reopenFrom(relay, publisher, run.reread);
    expect(windows(relay, reported)).toEqual(['unchanged']);
    expect(itemWrites(relay, writes)).toEqual([]);
    expect((await journalOf(relay)).epoch).toBe(epoch);
    expect(await keysOf(relay)).toEqual(keys);
    const reportedWindow = relay.diagnosticDetails.filter(({ event }) => event === 'journal_window').at(-1)!;
    expect(reportedWindow).toMatchObject({ agentId: SESSION, reason: 'unchanged' });
    expect(reportedWindow.bytes).toBeGreaterThan(0);
  });

  it('keeps the epoch across five releases of the runtime, each reading the history again', async () => {
    const { run, relay, publisher } = await published('settled');
    const epoch = (await journalOf(relay)).epoch;
    const reported = windows(relay).length;
    for (let at = 0; at < 5; at += 1) await reopenFrom(relay, publisher, run.reread);
    expect((await journalOf(relay)).epoch).toBe(epoch);
    expect(windows(relay, reported)).toEqual(Array(5).fill('unchanged'));
  });

  it('keeps the epoch when the Controller restarts under a new publisher, for the recording a new CLI process read', async () => {
    const { run, relay, publisher } = await published('restart');
    const epoch = (await journalOf(relay)).epoch;
    const writes = relay.writes.length;
    const next = await restart(relay, publisher, run.reread);
    await reopenFrom(relay, next.publisher, run.reread);
    expect((await journalOf(relay)).epoch).toBe(epoch);
    expect(itemWrites(relay, writes)).toEqual([]);
    expect(windows(relay).slice(-2)).toEqual(['unchanged', 'unchanged']);
  });

  it.each(['approval', 'todos', 'reasoning', 'compaction'])('%s: reopens unchanged five times, and the items the reread cannot reproduce stay', async name => {
    const { run, relay, publisher } = await published(name);
    const keys = await keysOf(relay);
    const writes = relay.writes.length;
    for (let at = 0; at < 5; at += 1) await reopenFrom(relay, publisher, run.reread);
    expect(await keysOf(relay)).toEqual(keys);
    expect(itemWrites(relay, writes)).toEqual([]);
    expect(windows(relay).slice(-5)).toEqual(Array(5).fill('unchanged'));
    expect((await journalOf(relay)).state().items.some(value => value.liveOnly)).toBe(name !== 'compaction');
  });

  it('appends the snapshot of the todo list that the reopened session publishes when it opens, and replaces nothing', async () => {
    const { run, relay, publisher } = await published('todos');
    const snapshot = run.live.filter(({ itemIdentity }) => itemIdentity?.key.startsWith('todo:')).at(-1)!;
    const keys = await keysOf(relay);
    const epoch = (await journalOf(relay)).epoch;
    const reported = windows(relay).length;
    await reopenFrom(relay, publisher, run.reread, [{ ...snapshot, sourceKey: 'copilot:local:reopen', itemIdentity: { key: 'todo:reopened', completes: true, liveOnly: true } }]);
    expect(windows(relay, reported)).toEqual(['appended']);
    expect((await journalOf(relay)).epoch).toBe(epoch);
    expect(await keysOf(relay)).toEqual([...keys, 'todo:reopened']);
  });

  describe('interrupted', () => {
    it('leaves no item open after the cancel, and reopens unchanged five times', async () => {
      const { run, relay, publisher } = await published('interrupted');
      expect((await journalOf(relay)).state().items.filter(value => value.state === 'open')).toEqual([]);
      for (let at = 0; at < 5; at += 1) await reopenFrom(relay, publisher, run.reread);
      expect(windows(relay).slice(-5)).toEqual(Array(5).fill('unchanged'));
    });

    it('replaces once, as an open item, when a tool completed while the Controller was away', async () => {
      const run = recording('partial-tool');
      const completes = run.live.findIndex(({ itemIdentity }) => itemIdentity?.key.startsWith('tool:') && itemIdentity.completes === true);
      const relay = relayLoopback(clock);
      const first = start(relay);
      await follow(first, [], { live: liveOf(run.live.slice(0, completes)) });
      await settled(relay);
      expect((await journalOf(relay)).state().items.filter(value => value.state === 'open').map(value => value.itemKey)).toHaveLength(1);
      const reported = windows(relay).length;
      const next = await restart(relay, first, run.reread);
      expect(windows(relay, reported)).toEqual(['open_item']);
      await reopenFrom(relay, next.publisher, run.reread);
      expect(windows(relay, reported)).toEqual(['open_item', 'unchanged']);
    });
  });

  it('replaces once, as a changed item, for a corrected final message, and then holds the base once and no correction item', async () => {
    let id = 0;
    const event = (type: string, data: unknown): SessionEvent => ({ type, data, id: `native-${++id}`, timestamp: new Date(1_725_000_000_000 + id).toISOString(), parentId: null }) as SessionEvent;
    const user = event('user.message', { content: 'Fix it' });
    const started = event('assistant.turn_start', { turnId: '0' });
    const delta = event('assistant.message_delta', { messageId: 'm1', deltaContent: 'Draft' });
    const final = event('assistant.message', { messageId: 'm1', content: 'Final' });
    const ended = event('assistant.turn_end', { turnId: '0' });
    const observe = (events: SessionEvent[], delivery: 'live' | 'history', projector: Projector): ProviderObservation[] => events.flatMap(native => projector.projectAll(native, delivery).map(projected => ({
      type: 'observation' as const, sourceKey: `copilot:public:${projected.key}:${native.id}`, occurredAt: Date.parse(native.timestamp), delivery, event: projected.event, ...(projected.identity ? { itemIdentity: projected.identity } : {}),
    })));
    const live = observe([user, started, delta, final, ended, event('assistant.idle', {})], 'live', new Projector());
    const historyProjector = new Projector();
    const nativeHistory = [user, started, final, ended];
    historyProjector.prepareHistory(nativeHistory);
    const reread = observe(nativeHistory, 'history', historyProjector);
    const corrected: CopilotRecording = { live, reread };

    const relay = relayLoopback(clock);
    const publisher = start(relay);
    await follow(publisher, [], { live: liveOf(corrected.live) });
    await settled(relay);
    expect((await keysOf(relay)).filter(key => key.endsWith(':correction'))).toHaveLength(1);
    const reported = windows(relay).length;
    await reopenFrom(relay, publisher, corrected.reread);
    await reopenFrom(relay, publisher, corrected.reread);
    expect(windows(relay, reported)).toEqual(['changed', 'unchanged']);
    expect(await keysOf(relay)).toEqual([`user:${user.id}`, 'assistant:m1']);
    expect((await journalOf(relay)).state().items.map(value => (value.body?.item as { text?: string }).text)).toEqual(['Fix it', 'Final']);
  });

  it('sends a scroll past the window as an older request, lands the page below the oldest item, and reports one older request', async () => {
    const run = recording('settled');
    const secondTurn = run.reread.findIndex(({ event }) => event.type === 'timeline' && event.item.type === 'user_message' && event.item.text === 'Second');
    expect(secondTurn).toBeGreaterThan(0);
    const relay = relayLoopback(clock);
    const publisher = start(relay);
    const older = run.reread.slice(0, secondTurn).filter(({ event }) => event.type === 'timeline');
    await follow(publisher, run.reread.slice(secondTurn), { older: [{ observations: older }] });
    await settled(relay);
    const before = await keysOf(relay);
    const anchor = (await journalOf(relay)).oldestItemKey!;
    expect(anchor).toBe(before[0]);
    await expect(relay.connection.requestOlder(SESSION, 10, anchor)).resolves.toEqual({ olderAvailable: expect.any(Boolean) });
    await settle(60);
    const after = await keysOf(relay);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.slice(-before.length)).toEqual(before);
    expect(relay.diagnosticDetails.filter(({ event, reason }) => event === 'journal_request' && reason === 'older')).toHaveLength(1);
  });
});

describe('the size of a Copilot session', () => {
  /** A large assistant message in the shape the CLI recorded. */
  function large(key: string, share: number): ProviderObservation[] {
    const template = recording('settled').reread.find(({ event }) => event.type === 'timeline' && event.item.type === 'assistant_message')!;
    if (template.event.type !== 'timeline' || template.event.item.type !== 'assistant_message') throw new Error('The recording has no assistant message.');
    return [{ ...template, sourceKey: `copilot:public:${key}`, itemIdentity: { key: `assistant:${key}`, completes: true }, event: { ...template.event, item: { ...template.event.item, messageId: key, text: 'x'.repeat(Math.floor(MESSAGE_BUDGET_BYTES * share)) } } }];
  }
  const session = () => ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].flatMap(key => large(key, 0.3));

  it('serves the newest items when the window does not fit one message, and the older ones are fetched on demand', async () => {
    const relay = relayLoopback(clock);
    const publisher = start(relay);
    await follow(publisher, session());
    await settled(relay);
    const served = await keysOf(relay);
    expect(served.length).toBeGreaterThan(0);
    expect(served.length).toBeLessThan(6);
    expect(served.at(-1)).toBe('assistant:m6');
    const reported = windows(relay).length;
    await reopenFrom(relay, publisher, session());
    expect(windows(relay, reported)).toEqual(['unchanged']);
  });

  it('refuses a window larger than the Host\'s room, and serves nothing while it is refused', async () => {
    const relay = relayLoopback(clock, { limits: { sessionBytes: 400_000 } });
    const publisher = start(relay);
    await follow(publisher, large('m1', 0.4));
    await settle(200);
    const journal = await relay.journal(SESSION);
    expect(journal?.head).toBeUndefined();
    expect(relay.diagnostics).toContain('journal_quota_exceeded');
  });
});

describe('journals are off unless the Relay and the Host switch them on', () => {
  it('declares journal support for Copilot and for no adapter that does not', () => {
    expect(supportsJournal(new CopilotAgentProvider())).toBe(true);
    expect(supportsJournal({})).toBe(false);
  });
});

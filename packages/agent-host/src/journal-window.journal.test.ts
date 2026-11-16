import type { ResourceBinding } from '@orchardworks/agent-remote-protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { MESSAGE_BUDGET_BYTES } from './journal-items.js';
import { createJournalPublisher, type JournalPublisher } from './journal-publisher.js';
import { HOST_ID, relayLoopback } from './test-utils/journal-relay-loopback.js';
import { attachScripted, boundary, driver, item, ScriptedSession, virtualClock } from './test-utils/journal-scripted-session.js';

/** The publisher against the Relay's real journal service: what a Controller sends when it opens, and what the Relay keeps. */
const clock = virtualClock();
const { settle, until } = driver(clock);
const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });
const SESSION = 'fake:thread-1';
const limits = { batchWindowMs: 5, backoffBaseMs: 5, backoffMaxMs: 20, responseTimeoutMs: 10_000 };

type Relay = ReturnType<typeof relayLoopback>;
type Observation = ReturnType<typeof item>;
type Wire = Record<string, any>;

function start(relay: Relay, extra: Record<string, unknown> = {}, diagnostics: Array<{ event: string; reason?: string }> = []): JournalPublisher {
  const publisher = createJournalPublisher({ providers: () => ['fake'], scheduler: clock, now: clock.now, limits: { ...limits, ...extra }, diagnostic: entry => diagnostics.push(entry) });
  closers.push(() => publisher.close());
  relay.connect(publisher);
  return publisher;
}

/** A native session of the Controller: its history, older pages, live observations already received, and the manager over them. */
async function follow(publisher: JournalPublisher, history: Observation[], options: { older?: Array<{ observations: Observation[]; nextCursor?: string }>; live?: ProviderLive[]; resources?: Record<string, Uint8Array> } = {}) {
  const session = new ScriptedSession('fake', 'thread-1', [...history, boundary(options.older ? 'older-1' : undefined)], options.older, options.resources);
  const manager = await attachScripted(session, 'agent-1', options.resources ? { resourceIdKey: 'controller-secret' } : {});
  closers.push(() => { void manager.close(); });
  for (const observation of options.live ?? []) session.push(observation);
  if ((options.live ?? []).length > 0) await settle(10);
  publisher.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source: manager });
  return { session, manager };
}
type ProviderLive = Observation;

const journalOf = async (relay: Relay) => (await relay.journal(SESSION))!;
const keysOf = async (relay: Relay) => (await journalOf(relay)).state().items.map(value => value.itemKey);
const texts = async (relay: Relay) => (await journalOf(relay)).state().items.map(value => (value.body?.item as { text?: string } | undefined)?.text ?? '');
const heads = (relay: Relay) => relay.fromPublisher.filter(message => message.type === 'journal_publish' && message.entries.some((entry: Wire) => entry.op === 'head')).length;
const replacements = (relay: Relay) => relay.published.flatMap(({ result }) => result.events).filter(event => event.kind === 'replaced').length;
/** The writes since `from` that carried an item, a removal or a replacement; a write of the meta alone is not one. */
const itemWrites = (relay: Relay, from: number) => relay.writes.slice(from).filter(write => write.upsert.length > 0 || write.removed.length > 0 || write.replaced);

async function settled(relay: Relay): Promise<void> {
  await until(async () => (await relay.journal(SESSION))?.head !== undefined, 'the head');
  await settle(30);
}

/** The connection drops and returns: the Relay sees the same Controller open the journal again. */
async function reopen(relay: Relay, publisher: JournalPublisher): Promise<void> {
  const before = heads(relay);
  publisher.available(undefined);
  relay.connect(publisher);
  await until(() => heads(relay) > before, 'the head of the reopened journal');
  await settle(30);
}

/** The Controller restarts: a new publisher and a new manager read the same native history again. */
async function restart(relay: Relay, previous: JournalPublisher, history: Observation[], options: Parameters<typeof follow>[2] = {}) {
  previous.close();
  const before = heads(relay);
  const publisher = start(relay);
  const run = await follow(publisher, history, options);
  await until(() => heads(relay) > before, 'the head after the restart');
  await settle(30);
  return { publisher, ...run };
}

const big = (key: string, share: number, text = '') => item('history', key, `${text}${'x'.repeat(Math.floor(MESSAGE_BUDGET_BYTES * share))}`);

describe('a window that the Relay compares with its journal', () => {
  it('writes no item and sends no event but the head when the session is opened again unchanged, and appends what a session grew by', async () => {
    const relay = relayLoopback(clock);
    const publisher = start(relay);
    await follow(publisher, [item('history', 'm1', 'Hello'), item('history', 'm2', 'World')]);
    await settled(relay);
    const epoch = (await journalOf(relay)).epoch;
    const writes = relay.writes.length;
    const published = relay.published.length;
    await reopen(relay, publisher);
    await reopen(relay, publisher);
    expect(itemWrites(relay, writes)).toEqual([]);
    expect(relay.published.slice(published).flatMap(({ result }) => result.events.map(event => event.kind))).toEqual(['head', 'head']);
    expect((await journalOf(relay)).epoch).toBe(epoch);

    // The Controller restarts after the session grew while it was away.
    await restart(relay, publisher, [item('history', 'm1', 'Hello'), item('history', 'm2', 'World'), item('history', 'm3', 'Again')]);
    expect(await texts(relay)).toEqual(['Hello', 'World', 'Again']);
    expect((await journalOf(relay)).epoch).toBe(epoch);
    expect(replacements(relay)).toBe(1);
  });

  describe('replaces once, and then settles, for every other change', () => {
    /** Four more opens leave the journal as it is: no item written, no replacement. */
    async function expectSettled(relay: Relay, publisher: JournalPublisher): Promise<void> {
      const writes = relay.writes.length;
      const replaced = replacements(relay);
      for (let at = 0; at < 4; at += 1) await reopen(relay, publisher);
      expect(itemWrites(relay, writes)).toEqual([]);
      expect(replacements(relay)).toBe(replaced);
    }

    /** p2 and p3 are large, so a window carries only [b1, b2]; older history is not uploaded until asked for. */
    const history = (changed: 'b1' | 'b2' | 'none') => [
      item('history', 'p1', 'First'), big('p2', 0.12), big('p3', 0.12), big('b1', 0.6, changed === 'b1' ? 'rewritten ' : ''), big('b2', 0.35, changed === 'b2' ? 'rewritten ' : ''),
    ];

    it('settles after a rewrite, with an interrupted open item the journal holds beside the window', async () => {
      const relay = relayLoopback(clock);
      const first = start(relay);
      await follow(first, history('none'), { live: [item('live', 'o', 'Interrupted', { completes: false })] });
      await settled(relay);
      expect(await keysOf(relay)).toEqual(['b1', 'b2', 'o']);
      const replaced = replacements(relay);
      const next = await restart(relay, first, history('b1'));
      expect(replacements(relay)).toBe(replaced + 1);
      expect(await keysOf(relay)).toEqual(['b1', 'b2']);
      await expectSettled(relay, next.publisher);
    });

    it('settles after a rewrite, carrying a provider live-only item the window does not hold', async () => {
      const relay = relayLoopback(clock);
      const first = start(relay);
      await follow(first, history('none'), { live: [item('live', 'l', 'Asked', { completes: true, liveOnly: true })] });
      await settled(relay);
      expect(await keysOf(relay)).toEqual(['b1', 'b2', 'l']);
      const replaced = replacements(relay);
      const next = await restart(relay, first, history('b1'));
      expect(replacements(relay)).toBe(replaced + 1);
      expect((await keysOf(relay)).sort()).toEqual(['b1', 'b2', 'l']);
      await expectSettled(relay, next.publisher);
    });

    it('leaves an open item that the journal holds with the same content alone on every open, and replaces once when its content differs', async () => {
      const relay = relayLoopback(clock);
      const first = start(relay);
      const { session } = await follow(first, [item('history', 'm1', 'Hello')], { live: [item('live', 'turn', 'Thinking', { completes: false })] });
      await settled(relay);
      const writes = relay.writes.length;
      await reopen(relay, first);
      session.push(item('live', 'turn', ' hard', { completes: false }));
      await until(async () => (await texts(relay)).includes('Thinking hard'), 'the row the live turn grew by');
      await reopen(relay, first);
      await reopen(relay, first);
      expect(replacements(relay)).toBe(1);
      expect(itemWrites(relay, writes).flatMap(write => write.removed)).toEqual([]);
      expect(await texts(relay)).toEqual(['Hello', 'Thinking hard']);
      session.push(item('live', 'turn', '!', { completes: true }));
      await until(async () => (await texts(relay)).includes('Thinking hard!'), 'the completed turn');

      const replaced = replacements(relay);
      const next = await restart(relay, first, [item('history', 'm1', 'Hello')], { live: [item('live', 'turn', 'Thinking differently', { completes: false })] });
      expect(replacements(relay)).toBe(replaced + 1);
      expect(await texts(relay)).toEqual(['Hello', 'Thinking differently']);
      await expectSettled(relay, next.publisher);
    });

    it('replaces the copy of a live-only item that the reread now holds, once, and keeps the mark of one that completed while the Controller was away', async () => {
      const relay = relayLoopback(clock);
      const first = start(relay);
      await follow(first, [item('history', 'm1', 'Hello')], { live: [
        item('live', 'q', 'Asked', { completes: false, liveOnly: true }), item('live', 'r', 'Told', { completes: true, liveOnly: true }),
      ] });
      await settled(relay);
      expect((await journalOf(relay)).state().items.map(value => [value.itemKey, value.state, value.liveOnly])).toEqual([['m1', 'complete', false], ['q', 'open', true], ['r', 'complete', true]]);
      const replaced = replacements(relay);
      // While the Controller was away q was answered, and the native history now also records r.
      const next = await restart(relay, first, [item('history', 'm1', 'Hello'), item('history', 'r', 'Told')], { live: [item('live', 'q', 'Asked, and answered', { completes: true, liveOnly: true })] });
      expect(replacements(relay)).toBe(replaced + 1);
      expect((await journalOf(relay)).state().items.map(value => [value.itemKey, value.state, value.liveOnly])).toEqual([['m1', 'complete', false], ['r', 'complete', false], ['q', 'complete', true]]);
      await expectSettled(relay, next.publisher);
    });
  });

  it('leaves the stored items and the epoch as they are across five reconnects and five restarts, and writes only the meta', async () => {
    const relay = relayLoopback(clock);
    let publisher = start(relay);
    const native = () => [item('history', 'm1', 'Hello'), item('history', 'm2', 'World'), item('history', 'm3', 'Again')];
    await follow(publisher, native(), { live: [item('live', 'q', 'Asked', { completes: true, liveOnly: true })] });
    await settled(relay);
    const stored = async () => { const state = (await journalOf(relay)).state(); return { epoch: state.meta.epoch, items: state.items }; };
    const baseline = await stored();
    const writes = relay.writes.length;
    for (let at = 0; at < 5; at += 1) await reopen(relay, publisher);
    for (let at = 0; at < 5; at += 1) publisher = (await restart(relay, publisher, native())).publisher;
    expect(await stored()).toEqual(baseline);
    expect(itemWrites(relay, writes)).toEqual([]);
    expect(replacements(relay)).toBe(1);
  });
});

describe('the quota and a journal that is missing rows', () => {
  const rows = (count: number) => Array.from({ length: count }, (_, at) => item('history', `m${at}`, `Item ${at} ${'y'.repeat(2000)}`));

  it('keeps the whole window, settles, keeps live rows flowing, and serves nothing while a row larger than the room is in the window', async () => {
    const relay = relayLoopback(clock, { limits: { sessionBytes: 12_000 } });
    const diagnostics: Array<{ event: string }> = [];
    const publisher = start(relay, {}, diagnostics);
    const { session } = await follow(publisher, rows(3));
    await settled(relay);
    expect(await keysOf(relay)).toEqual(['m0', 'm1', 'm2']);
    const writes = relay.writes.length;
    for (let at = 0; at < 3; at += 1) await reopen(relay, publisher);
    expect(itemWrites(relay, writes)).toEqual([]);

    session.push(item('live', 'small', 'Still flowing', { completes: true }));
    await until(async () => (await texts(relay)).includes('Still flowing'), 'a live row');

    // A live row larger than the room leaves a hole, and the window that now holds it cannot fit either: the session is not served, and the Controller only retries with backoff.
    session.push(item('live', 'huge', 'z'.repeat(12_000), { completes: true }));
    await until(() => relay.diagnostics.includes('journal_quota_exceeded'), 'the refusal');
    const publishes = () => relay.fromPublisher.filter(message => message.type === 'journal_publish').length;
    const before = publishes();
    await settle(200);
    const journal = await journalOf(relay);
    expect(journal.incomplete).toBe(true);
    expect(journal.head).toBeUndefined();
    expect(await keysOf(relay)).toEqual(['m0', 'm1', 'm2', 'small']);
    expect(publishes() - before).toBeLessThanOrEqual(200 / limits.backoffBaseMs);
    expect(diagnostics.map(entry => entry.event)).not.toContain('journal_session_stopped');
    expect(relay.fromPublisher.filter(message => message.type === 'journal_unserve')).toEqual([]);
  });

  it('serves nothing and retries only with backoff while the Relay has no room for the whole window', async () => {
    const relay = relayLoopback(clock, { limits: { sessionBytes: 9_000 } });
    const diagnostics: Array<{ event: string; reason?: string }> = [];
    const publisher = start(relay, {}, diagnostics);
    await follow(publisher, rows(8));
    await settle(200);
    const journal = await relay.journal(SESSION);
    expect(journal?.head).toBeUndefined();
    expect(journal?.state().items ?? []).toEqual([]);
    expect(diagnostics).toContainEqual({ event: 'journal_publication_refused', providerId: 'fake', reason: 'quota_exceeded' });
    expect(relay.fromPublisher.filter(message => message.type === 'journal_publish').length).toBeLessThanOrEqual(1 + 200 / limits.backoffBaseMs);
    expect(relay.fromPublisher.filter(message => message.type === 'journal_unserve')).toEqual([]);
  });

  it('stays live when a scroll-up hits the quota: the journal keeps its head and rows, and the Relay marks older history over for the session', async () => {
    const relay = relayLoopback(clock, { limits: { sessionBytes: 1_500_000 } });
    const publisher = start(relay);
    const { session } = await follow(publisher, [big('b1', 0.1), big('b2', 0.1)], { older: [{ observations: [big('o1', 0.9)] }] });
    await settled(relay);
    const anchor = (await journalOf(relay)).oldestItemKey!;
    expect(anchor).toBe('b1');
    const before = await keysOf(relay);
    // The Relay refuses the page for its quota; the Controller says no older history is left, and does not open again.
    const openCount = () => relay.fromPublisher.filter(message => message.type === 'journal_open').length;
    const opensBefore = openCount();
    await expect(relay.connection.requestOlder(SESSION, 5, anchor)).resolves.toEqual({ olderAvailable: false });
    await settle(60);
    expect(openCount()).toBe(opensBefore);
    expect(relay.diagnostics).toContain('journal_quota_exceeded');
    expect(relay.published.some(({ result }) => result.prependRefused === true)).toBe(true);
    const journal = await journalOf(relay);
    expect(journal.head).toBeDefined();
    expect(journal.incomplete).toBe(false);
    expect(await keysOf(relay)).toEqual(before);
    expect((await relay.journals.status(HOST_ID, SESSION))?.head).toBeDefined();
    session.push(item('live', 'later', 'Still live', { completes: true }));
    await until(async () => (await texts(relay)).some(text => text === 'Still live'), 'a live row after the refused scroll-up');
  });

  it('sends the window, never an empty one while native history may hold more, and clears a journal that is missing rows only from exhausted history', async () => {
    const relay = relayLoopback(clock);
    const publisher = start(relay);
    await follow(publisher, [], { older: [{ observations: [item('history', 'm1', 'One'), item('history', 'm2', 'Two')] }] });
    await settled(relay);
    expect(await keysOf(relay)).toEqual(['m1', 'm2']);
    await relay.makeIncomplete(SESSION);
    await reopen(relay, publisher);
    expect(await keysOf(relay)).toEqual(['m1', 'm2']);
    expect((await journalOf(relay)).incomplete).toBe(false);

    const empty = relayLoopback(clock);
    const quiet = start(empty);
    await follow(quiet, []);
    await settled(empty);
    await empty.makeIncomplete(SESSION);
    expect((await journalOf(empty)).incomplete).toBe(true);
    await reopen(empty, quiet);
    expect((await journalOf(empty)).incomplete).toBe(false);
    expect(empty.fromPublisher.filter(message => message.type === 'journal_publish').flatMap(message => message.entries).filter((entry: Wire) => entry.op === 'window').map((entry: Wire) => entry.items.length)).toEqual([0, 0]);
  });
});

describe('a Relay refusal or a lost message heals by opening again', () => {
  const native = () => [item('history', 'm1', 'Hello'), item('history', 'm2', 'World')];

  async function expectHealed(relay: Relay, publisher: JournalPublisher, opensBefore: number, run: Awaited<ReturnType<typeof follow>>): Promise<void> {
    await until(async () => (await texts(relay)).includes('Fresh') && opens(relay) > opensBefore, 'the journal to hold the live row after opening again');
    await settle(60);
    expect(await texts(relay)).toEqual([...run.manager.timelineRows().map(row => (row.item as { text: string }).text)]);
    expect((await journalOf(relay)).incomplete).toBe(false);
    expect((await journalOf(relay)).head).toBeDefined();
    expect(relay.fromPublisher.filter(message => message.type === 'journal_unserve')).toEqual([]);
    void publisher;
  }
  const opens = (relay: Relay) => relay.fromPublisher.filter(message => message.type === 'journal_open').length;

  it.each(['quota_exceeded', 'invalid'] as const)('after the Relay refuses a live row as %s', async reason => {
    let refused = false;
    const relay = relayLoopback(clock, { refuseEntry: entry => {
      if (refused || entry.op !== 'append') return undefined;
      refused = true;
      return { reason };
    } });
    const publisher = start(relay);
    const run = await follow(publisher, native());
    await settled(relay);
    const before = opens(relay);
    run.session.push(item('live', 'x', 'Fresh', { completes: true }));
    await expectHealed(relay, publisher, before, run);
    expect(refused).toBe(true);
  });

  it('after the Relay refuses the open', async () => {
    const relay = relayLoopback(clock, { refuseOpen: n => n <= 2 });
    const publisher = start(relay);
    const run = await follow(publisher, native());
    await until(async () => (await relay.journal(SESSION))?.head !== undefined, 'the head after two refused opens');
    run.session.push(item('live', 'x', 'Fresh', { completes: true }));
    await expectHealed(relay, publisher, 2, run);
  });

  it('after the Relay does not acknowledge a message', async () => {
    const relay = relayLoopback(clock);
    const publisher = start(relay, { responseTimeoutMs: 60 });
    let dropped = false;
    const run = await follow(publisher, native());
    await settled(relay);
    publisher.available({ send: json => {
      const message = JSON.parse(json);
      if (!dropped && message.type === 'journal_publish' && message.entries.some((entry: Wire) => entry.op === 'append')) { dropped = true; return; }
      relay.writer.send(json);
    } });
    await settle(30);
    const before = opens(relay);
    run.session.push(item('live', 'x', 'Fresh', { completes: true }));
    await expectHealed(relay, publisher, before, run);
    expect(dropped).toBe(true);
  });

  it('after the Relay finds a gap in the numbers of a message', async () => {
    const relay = relayLoopback(clock);
    const publisher = start(relay);
    let skewed = false;
    const run = await follow(publisher, native());
    await settled(relay);
    publisher.available({ send: json => {
      const message = JSON.parse(json);
      if (!skewed && message.type === 'journal_publish' && message.entries.some((entry: Wire) => entry.op === 'append')) {
        skewed = true;
        relay.writer.send(JSON.stringify({ ...message, entries: message.entries.map((entry: Wire) => ({ ...entry, sequence: entry.sequence + 5 })) }));
        return;
      }
      relay.writer.send(json);
    } });
    await settle(30);
    const before = opens(relay);
    run.session.push(item('live', 'x', 'Fresh', { completes: true }));
    await expectHealed(relay, publisher, before, run);
    expect(skewed).toBe(true);
  });

  it('leaves an item the wire refuses out with one diagnostic and publishes every other item', async () => {
    const relay = relayLoopback(clock);
    const diagnostics: Array<{ event: string }> = [];
    const publisher = start(relay, {}, diagnostics);
    const { session } = await follow(publisher, [item('history', 'bad', 'x', { turnId: 't'.repeat(600) }), ...native()]);
    await settled(relay);
    session.push(item('live', 'bad-live', 'x', { turnId: 't'.repeat(600) }));
    session.push(item('live', 'x', 'Fresh', { completes: true }));
    await until(async () => (await texts(relay)).includes('Fresh'), 'the row after the refused one');
    expect(await keysOf(relay)).toEqual(['m1', 'm2', 'x']);
    expect(diagnostics.filter(entry => entry.event === 'journal_row_rejected')).toHaveLength(2);
  });
});

describe('outcomes, bindings and older history that the journal holds outside the window', () => {
  const background = { id: 'review-1', kind: 'review' as const, status: 'pending' as const };
  const withBackground = (observation: Observation): Observation => ({ ...observation, event: { ...observation.event, item: { ...observation.event.item, background } } }) as Observation;
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=', 'base64'));

  it('restates an outcome the Controller learned later, for an item outside the window, and then writes nothing', async () => {
    const relay = relayLoopback(clock);
    const first = start(relay);
    const native = () => [withBackground(big('p1', 0.12, 'Started a review ')), big('b1', 0.6), big('b2', 0.35)];
    await follow(first, native());
    await settled(relay);
    expect(await keysOf(relay)).toEqual(['b1', 'b2']);
    await relay.connection.requestOlder(SESSION, 5, 'b1');
    await until(async () => (await keysOf(relay)).includes('p1'), 'the older item');
    const backgroundOf = async () => (await journalOf(relay)).state().items.find(value => value.itemKey === 'p1')?.body?.item.background;
    expect(await backgroundOf()).toMatchObject({ id: 'review-1', status: 'pending' });

    // The Controller restarts, and the manager has learned that the review failed.
    const failure = { type: 'observation' as const, sourceKey: 'bg-1', occurredAt: 9, delivery: 'live' as const, event: { type: 'background_activity_updated' as const, provider: 'fake', background: { ...background, status: 'failed' as const } } };
    const next = await restart(relay, first, native(), { live: [failure as unknown as Observation] });
    expect(await backgroundOf()).toMatchObject({ id: 'review-1', status: 'failed' });
    const writes = relay.writes.length;
    const published = relay.published.length;
    await reopen(relay, next.publisher);
    expect(itemWrites(relay, writes)).toEqual([]);
    expect(relay.published.slice(published).flatMap(({ result }) => result.events.map(event => event.kind))).toEqual(['head']);
  });

  it('restates a settled binding for an item outside the window, and then writes nothing', async () => {
    const relay = relayLoopback(clock);
    const first = start(relay);
    const native = () => [item('history', 'img', 'See ![shot](shot.png)'), big('b1', 0.6), big('b2', 0.35)];
    const run = await follow(first, native(), { resources: { 'shot.png': png } });
    await settled(relay);
    await relay.connection.requestOlder(SESSION, 5, 'b1');
    await until(async () => (await keysOf(relay)).includes('img'), 'the older item');
    const bindingOf = async (): Promise<ResourceBinding | undefined> => (await journalOf(relay)).state().items.find(value => value.itemKey === 'img')?.body?.resources[0];
    const settledOf = () => run.manager.timelineRows().flatMap(row => row.resources).find(binding => binding.status === 'available');
    await until(async () => settledOf() !== undefined && (await bindingOf())?.status === 'available', 'the binding to settle in the journal');
    // A journal that lost the settlement is restated by the next open.
    const next = await restart(relay, first, native(), { resources: { 'shot.png': png } });
    await until(() => next.manager.timelineRows().some(row => row.resources.some(binding => binding.status === 'available')), 'the new manager to settle');
    await reopen(relay, next.publisher);
    expect(await bindingOf()).toEqual(next.manager.timelineRows().flatMap(row => row.resources).find(binding => binding.status === 'available'));
    const writes = relay.writes.length;
    const published = relay.published.length;
    await reopen(relay, next.publisher);
    expect(itemWrites(relay, writes)).toEqual([]);
    expect(relay.published.slice(published).flatMap(({ result }) => result.events.map(event => event.kind))).toEqual(['head']);
  });

  it('asks for older history before the journal\'s oldest item, lands it below that item, and answers an unknown anchor from native history', async () => {
    const relay = relayLoopback(clock);
    const publisher = start(relay);
    await follow(publisher, [item('history', 'm3', 'Three'), item('history', 'm4', 'Four')], { older: [{ observations: [item('history', 'm1', 'One'), item('history', 'm2', 'Two')], nextCursor: 'older-2' }, { observations: [item('history', 'm0', 'Zero')] }] });
    await settled(relay);
    const journal = await journalOf(relay);
    expect(journal.oldestItemKey).toBe('m3');
    expect(await relay.connection.requestOlder(SESSION, 3, journal.oldestItemKey!)).toEqual({ olderAvailable: false });
    expect(relay.fromRelay.find(message => message.type === 'journal_older_request')).toMatchObject({ beforeItemKey: 'm3', limit: 3 });
    expect(await keysOf(relay)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(await relay.connection.requestOlder(SESSION, 3, 'unknown')).toEqual({ olderAvailable: false });
  });
});

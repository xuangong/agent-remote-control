import { itemDigest, type JournalChanges, type SessionJournal } from '@orchardworks/agent-remote-journal';
import { afterEach, describe, expect, it } from 'vitest';

import { groupItems, mergedRow } from './journal-items.js';
import { createJournalPublisher, type JournalPublisher } from './journal-publisher.js';
import { relayLoopback } from './test-utils/journal-relay-loopback.js';
import { attachScripted, boundary, driver, item, ScriptedSession, virtualClock } from './test-utils/journal-scripted-session.js';

const clock = virtualClock();
const { settle, until } = driver(clock);
const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });
const SESSION = 'fake:thread-1';
const limits = { batchWindowMs: 5, backoffBaseMs: 5, backoffMaxMs: 20, responseTimeoutMs: 10_000 };

function start(relay: ReturnType<typeof relayLoopback>, publisherId?: string, extra: Partial<typeof limits & { quotaWindows: number[] }> = {}, diagnostics: Array<{ event: string }> = []): JournalPublisher {
  const publisher = createJournalPublisher({ providers: () => ['fake'], scheduler: clock, now: clock.now, limits: { ...limits, ...extra }, diagnostic: entry => diagnostics.push(entry), ...(publisherId ? { publisherId } : {}) });
  closers.push(() => publisher.close());
  relay.connect(publisher);
  return publisher;
}

type Observation = ReturnType<typeof item>;
async function follow(publisher: JournalPublisher, history: Observation[], older?: Array<{ observations: Observation[]; nextCursor?: string }>) {
  const session = new ScriptedSession('fake', 'thread-1', [...history, boundary(older ? 'older-1' : undefined)], older);
  const manager = await attachScripted(session);
  closers.push(() => { void manager.close(); });
  publisher.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source: manager });
  return { session, manager };
}

const texts = async (relay: ReturnType<typeof relayLoopback>, sessionKey = SESSION) => {
  const journal = await relay.journal(sessionKey);
  const page = journal?.page({ requestId: 'r', agentId: 'agent', direction: 'tail', limit: 500 }, { olderBeyondJournal: false });
  return page?.kind === 'page' ? page.page.payload.entries.map(entry => 'text' in entry.item ? entry.item.text : '') : undefined;
};

/** What a Relay restart keeps: the journal's state, in a store of a new Relay. */
async function carryOver(from: SessionJournal, to: ReturnType<typeof relayLoopback>): Promise<void> {
  const changes: JournalChanges = { meta: from.state().meta, upsert: from.state().items, removed: [], replaced: true, bytes: 0 };
  await to.store.apply(changes);
}

describe('the publisher against the Relay\'s journal service', () => {
  it('builds the journal of a session from its history, with digests, a head and its epoch', async () => {
    const relay = relayLoopback(clock);
    const publisher = start(relay);
    await follow(publisher, [item('history', 'm1', 'Hello'), item('history', 'm2', 'World')]);
    await until(async () => (await relay.journal(SESSION))?.head !== undefined, 'the head');
    const journal = (await relay.journal(SESSION))!;
    expect(await texts(relay)).toEqual(['Hello', 'World']);
    expect(journal.index().map(value => [value.itemKey, value.state, typeof value.digest])).toEqual([['m1', 'complete', 'string'], ['m2', 'complete', 'string']]);
    expect(journal.head?.snapshot.id).toBe('agent-1');
  });

  it('keeps the epoch and every row across a Controller restart, and publishes nothing for an unchanged session', async () => {
    const relay = relayLoopback(clock);
    const first = start(relay, 'controller-before');
    const run = await follow(first, [item('history', 'm1', 'Hello'), item('history', 'm2', 'World')]);
    await until(async () => (await relay.journal(SESSION))?.head !== undefined, 'the head');
    run.session.push(item('live', 'a', 'Wor', { completes: false }));
    run.session.push(item('live', 'a', 'ld', { completes: true }));
    await until(async () => (await texts(relay))?.length === 3, 'the live item');
    await settle(20);
    const before = (await relay.journal(SESSION))!;
    first.close();
    relay.disconnect();
    await run.manager.close();

    const restarted = relayLoopback(clock);
    await carryOver(before, restarted);
    const second = start(restarted, 'controller-after');
    const reopened = await follow(second, [item('history', 'm1', 'Hello'), item('history', 'm2', 'World'), item('history', 'a', 'World')]);
    await until(async () => ((await restarted.journal(SESSION))?.publisher?.publisherId) === 'controller-after' && (await restarted.journal(SESSION))?.head !== undefined, 'the reconcile');
    await settle(50);
    const after = (await restarted.journal(SESSION))!;
    expect(after.epoch).toBe(before.epoch);
    expect(after.index().map(value => [value.itemKey, value.seqStart])).toEqual(before.index().map(value => [value.itemKey, value.seqStart]));
    expect(restarted.published.flatMap(({ result }) => result.events.filter(event => event.kind === 'row' || event.kind === 'replaced'))).toEqual([]);
    expect(await texts(restarted)).toEqual(['Hello', 'World', 'World']);
    await reopened.manager.close();
  });

  it('corrects an item whose native content changed without starting a new epoch', async () => {
    const relay = relayLoopback(clock);
    const first = start(relay);
    const run = await follow(first, [item('history', 'm1', 'Hello'), item('history', 'm2', 'Wor')]);
    await until(async () => (await relay.journal(SESSION))?.head !== undefined, 'the head');
    const old = (await relay.journal(SESSION))!;
    first.close();
    relay.disconnect();
    await run.manager.close();
    const next = relayLoopback(clock);
    await carryOver(old, next);
    const second = start(next, 'controller-2');
    await follow(second, [item('history', 'm1', 'Hello'), item('history', 'm2', 'World, complete')]);
    await until(async () => (await texts(next))?.[1] === 'World, complete', 'the correction');
    expect((await next.journal(SESSION))!.epoch).toBe(old.epoch);
  });

  it('starts a new epoch only when native history was rewritten, carrying its live-only items over', async () => {
    const relay = relayLoopback(clock);
    const first = start(relay);
    const run = await follow(first, [item('history', 'm1', 'Hello'), item('history', 'm2', 'World'), item('history', 'm3', 'Again')]);
    run.session.push(item('live', 'question', 'Which one?', { completes: true, liveOnly: true }));
    await until(async () => (await texts(relay))?.length === 4, 'the live-only item');
    await settle(20);
    const old = (await relay.journal(SESSION))!;
    first.close();
    relay.disconnect();
    await run.manager.close();
    const next = relayLoopback(clock);
    await carryOver(old, next);
    const second = start(next, 'controller-2');
    await follow(second, [item('history', 'm1', 'Hello'), item('history', 'm3', 'Again')]);
    await until(async () => (await next.journal(SESSION))!.epoch !== old.epoch, 'the replacement');
    await until(async () => (await texts(next))?.length === 3, 'the new epoch');
    expect(await texts(next)).toEqual(['Hello', 'Again', 'Which one?']);
  });

  it('answers the Relay\'s request for older history with a prepend, and for evicted bodies with a fill', async () => {
    const relay = relayLoopback(clock);
    const publisher = start(relay);
    await follow(publisher, [item('history', 'm3', 'Three'), item('history', 'm4', 'Four')], [{ observations: [item('history', 'm1', 'One'), item('history', 'm2', 'Two')] }]);
    await until(async () => (await relay.journal(SESSION))?.head !== undefined, 'the head');
    await settle(30);
    expect(await relay.connection.requestOlder(SESSION, 10, 'm3')).toEqual({ olderAvailable: false });
    expect(await texts(relay)).toEqual(['One', 'Two', 'Three', 'Four']);
    const journal = (await relay.journal(SESSION))!;
    expect(journal.index().map(value => value.seqStart)).toEqual([-1, 0, 1, 2]);
    const digest = journal.index()[0]!.digest;
    expect(digest).toBe(await itemDigest(mergedRow(groupItems([{ epoch: 'e', seq: 1, providerId: 'fake', sourceKey: 's', occurredAt: 1, timestamp: new Date(1).toISOString(), turnId: 'turn-1', item: { type: 'assistant_message', text: 'One', messageId: 'm1' }, resources: [], identity: { key: 'm1', completes: true } }])[0]!).item));
    expect(await relay.connection.requestFill(SESSION, ['m3', 'm4'])).toMatchObject({ filled: ['m3', 'm4'] });
  });

  it('publishes the head before older history, which follows as a prepend', async () => {
    const relay = relayLoopback(clock);
    const first = start(relay, 'controller-before');
    const run = await follow(first, [item('history', 'm3', 'Three'), item('history', 'm4', 'Four')]);
    await until(async () => (await relay.journal(SESSION))?.head !== undefined, 'the head');
    await settle(40);
    const before = (await relay.journal(SESSION))!;
    first.close();
    relay.disconnect();
    await run.manager.close();
    const next = relayLoopback(clock);
    await carryOver(before, next);
    const second = start(next, 'controller-after');
    await follow(second, [item('history', 'm1', 'One'), item('history', 'm2', 'Two'), item('history', 'm3', 'Three'), item('history', 'm4', 'Four')]);
    await until(async () => (await texts(next))?.length === 4, 'the older items');
    const sequence = next.fromPublisher.filter(message => message.type === 'journal_publish').map(message => message.entries.map((value: { op: string }) => value.op));
    expect(sequence.slice(0, 2)).toEqual([['head'], ['prepend']]);
    expect(await texts(next)).toEqual(['One', 'Two', 'Three', 'Four']);
    expect((await next.journal(SESSION))!.epoch).toBe(before.epoch);
  });

  it('keeps the id of an image across a Controller restart, so the journal\'s row still names a resource that can be read', async () => {
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=', 'base64'));
    const withImage = () => item('history', 'm1', 'See ![shot](shot.png)');
    const resourceOf = async (relay: ReturnType<typeof relayLoopback>) => (await relay.journal(SESSION))?.state().items[0]?.body?.resources[0];
    const relay = relayLoopback(clock);
    const first = start(relay, 'controller-before');
    const session = new ScriptedSession('fake', 'thread-1', [withImage(), boundary()], undefined, { 'shot.png': png });
    const manager = await attachScripted(session, 'agent-1', { resourceIdKey: 'controller-secret' });
    first.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source: manager });
    await until(async () => (await resourceOf(relay))?.status === 'available', 'the image to settle in the journal');
    const settled = (await resourceOf(relay))!;
    expect(settled.resourceId).toMatch(/^rid_/);
    const before = (await relay.journal(SESSION))!;
    first.close();
    relay.disconnect();
    await manager.close();

    const next = relayLoopback(clock);
    await carryOver(before, next);
    const second = start(next, 'controller-after');
    const reopened = new ScriptedSession('fake', 'thread-1', [withImage(), boundary()], undefined, { 'shot.png': png });
    const again = await attachScripted(reopened, 'agent-1', { resourceIdKey: 'controller-secret' });
    second.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source: again });
    await until(async () => ((await next.journal(SESSION))?.publisher?.publisherId) === 'controller-after' && (await next.journal(SESSION))?.head !== undefined, 'the reconcile');
    await settle(100);
    expect(await resourceOf(next)).toEqual(settled);
    expect(again.timelineRows()[0]!.resources[0]).toEqual(settled);
    expect((await again.readResource('r', settled.resourceId)).payload.state).toMatchObject({ status: 'available', mediaType: 'image/png' });
    expect(next.published.flatMap(({ result }) => result.events.filter(event => event.kind === 'row' || event.kind === 'replaced'))).toEqual([]);
    await again.close();
  });

  it('serves the attention cursor in the journal\'s epoch and sequence, as the item the Controller\'s cursor points at', async () => {
    const relay = relayLoopback(clock);
    const publisher = start(relay);
    const { session } = await follow(publisher, [item('history', 'm1', 'Hello'), item('history', 'm2', 'World')]);
    await until(async () => (await relay.journal(SESSION))?.head !== undefined, 'the head');
    session.push({ type: 'observation', sourceKey: 'bg-1', occurredAt: 6, delivery: 'live', event: { type: 'background_activity_updated', provider: 'fake', background: { id: 'review-1', kind: 'review', status: 'visible' } } });
    await until(async () => (await relay.journal(SESSION))?.head?.snapshot.attention?.background !== undefined, 'a head with attention');
    const journal = (await relay.journal(SESSION))!;
    expect(journal.head?.snapshot.attention).toEqual({ cursor: { epoch: journal.epoch, seq: 2 }, background: { id: 'review-1', kind: 'review', status: 'visible' } });
  });

  it('unserves a session whose provider broke the identity contract, so the Relay stops serving its journal', async () => {
    const relay = relayLoopback(clock);
    const publisher = start(relay);
    const { session } = await follow(publisher, [item('history', 'm1', 'Hello')]);
    await until(async () => (await relay.journal(SESSION))?.head !== undefined, 'the head');
    session.push({ ...item('live', 'm2', 'No identity', { completes: true }), itemIdentity: undefined });
    await until(async () => (await relay.journal(SESSION))?.head === undefined, 'the head to be cleared');
    expect(relay.published.some(({ result }) => result.unserved === true)).toBe(true);
  });

  const opensOf = (relay: ReturnType<typeof relayLoopback>) => relay.fromPublisher.filter(message => message.type === 'journal_open');
  const sequencesContiguous = async (relay: ReturnType<typeof relayLoopback>) => {
    const journal = (await relay.journal(SESSION))!;
    const seqs = journal.index().map(value => value.seqStart);
    return seqs.every((value, at) => at === 0 || value === seqs[at - 1]! + 1);
  };

  it('leaves out an item the Relay refuses for its own sake, renumbers what follows, and keeps the journal contiguous without opening again', async () => {
    let refused = false;
    const relay = relayLoopback(clock, { refuseEntry: entry => {
      if (refused || entry.op !== 'append' || entry.itemKey !== 'bad') return undefined;
      refused = true;
      return { reason: 'body_missing', itemKey: 'bad' };
    } });
    const publisher = start(relay);
    const { session } = await follow(publisher, [item('history', 'm1', 'Hello')]);
    await until(async () => (await relay.journal(SESSION))?.head !== undefined, 'the head');
    await settle(30);
    const opens = opensOf(relay).length;
    session.push(item('live', 'bad', 'Never stored', { completes: true }));
    session.push(item('live', 'good', 'Stored', { completes: true }));
    await until(async () => (await texts(relay))?.includes('Stored') === true, 'the item after the refused one');
    await settle(40);
    expect(await texts(relay)).toEqual(['Hello', 'Stored']);
    expect(await sequencesContiguous(relay)).toBe(true);
    expect(opensOf(relay)).toHaveLength(opens);
    const watermark = (await relay.journal(SESSION))!.publisher!.watermark;
    expect(watermark).toBeGreaterThan(0);
    expect(refused).toBe(true);
  });

  it('replaces with a window that fits after a quota refusal, then goes on publishing live rows', async () => {
    const relay = relayLoopback(clock, { limits: { sessionItems: 4 } });
    const diagnostics: Array<{ event: string }> = [];
    const publisher = start(relay, undefined, { quotaWindows: [5, 3, 2] }, diagnostics);
    const { session } = await follow(publisher, Array.from({ length: 6 }, (_, at) => item('history', `m${at}`, `Item ${at}`)));
    await until(async () => (await relay.journal(SESSION))?.head !== undefined, 'the head of the window');
    await settle(40);
    expect(await texts(relay)).toEqual(['Item 3', 'Item 4', 'Item 5']);
    session.push(item('live', 'later', 'Still publishing', { completes: true }));
    await until(async () => (await texts(relay))?.at(-1) === 'Still publishing', 'a live item after the window');
    expect(diagnostics.map(entry => entry.event)).not.toContain('journal_session_stopped');
    expect(relay.fromPublisher.filter(message => message.type === 'journal_unserve')).toEqual([]);
    expect((await relay.journal(SESSION))!.head).toBeDefined();
  });

  it('makes an incomplete journal whole with a replacement before its head, and goes on', async () => {
    const relay = relayLoopback(clock);
    const diagnostics: Array<{ event: string }> = [];
    const publisher = start(relay, undefined, {}, diagnostics);
    const { session } = await follow(publisher, [item('history', 'm1', 'Hello'), item('history', 'm2', 'World')]);
    await until(async () => (await relay.journal(SESSION))?.head !== undefined, 'the head');
    await settle(30);
    // Another publisher resets the journal: it is incomplete, its head is gone, and this publisher is fenced.
    await relay.connection.receive({ uplinkVersion: 2, type: 'journal_open', requestId: 'intruder', sessionKey: SESSION, publisherId: 'intruder', reset: true });
    expect((await relay.journal(SESSION))!.incomplete).toBe(true);
    session.push(item('live', 'later', 'Still publishing', { completes: true }));
    await until(async () => { const journal = await relay.journal(SESSION); return journal?.incomplete === false && journal.head !== undefined && (await texts(relay))?.includes('Still publishing') === true; }, 'the journal to be whole again');
    expect(await texts(relay)).toEqual(['Hello', 'World', 'Still publishing']);
    expect(diagnostics.map(entry => entry.event)).not.toContain('journal_session_stopped');
  });

  it('opens without the index when the Relay refuses it as too large, replaces with what native history holds, and goes on', async () => {
    const first = relayLoopback(clock);
    const before = start(first, 'controller-before');
    const run = await follow(before, Array.from({ length: 5 }, (_, at) => item('history', `m${at}`, `Item ${at}`)));
    await until(async () => (await texts(first))?.length === 5, 'the five items');
    await settle(40);
    const old = (await first.journal(SESSION))!;
    before.close();
    first.disconnect();
    await run.manager.close();

    const next = relayLoopback(clock, { maxIndexItems: 4 });
    await carryOver(old, next);
    const diagnostics: Array<{ event: string }> = [];
    const after = start(next, 'controller-after', {}, diagnostics);
    const reopened = await follow(after, Array.from({ length: 4 }, (_, at) => item('history', `n${at}`, `New ${at}`)));
    await until(async () => (await texts(next))?.join() === 'New 0,New 1,New 2,New 3' && (await next.journal(SESSION))?.head !== undefined, 'the replacement');
    await settle(40);
    expect(opensOf(next).map(message => message.reset)).toEqual([undefined, true, undefined]);
    expect((await next.journal(SESSION))!.epoch).not.toBe(old.epoch);
    reopened.session.push(item('live', 'later', 'Still publishing', { completes: true }));
    await until(async () => (await texts(next))?.at(-1) === 'Still publishing', 'a live item after the way out');
    expect(diagnostics.map(entry => entry.event)).not.toContain('journal_session_stopped');
  });

  it('keeps the journal as it was across a reconnect, with nothing duplicated and the epoch kept', async () => {
    const first = relayLoopback(clock);
    const publisher = start(first, 'controller-1');
    const run = await follow(publisher, [item('history', 'm1', 'Hello'), item('history', 'm2', 'World')]);
    await until(async () => (await first.journal(SESSION))?.head !== undefined, 'the head');
    run.session.push(item('live', 'a', 'Live', { completes: true }));
    await until(async () => (await texts(first))?.length === 3, 'the live item');
    await settle(40);
    const before = (await first.journal(SESSION))!;
    first.disconnect();
    run.session.push(item('live', 'b', 'While away', { completes: true }));
    await settle(40);

    const again = relayLoopback(clock, { store: first.store });
    again.connect(publisher);
    await until(async () => (await texts(again))?.includes('While away') === true, 'the row published while the connection was away');
    await settle(40);
    const after = (await again.journal(SESSION))!;
    expect(after.epoch).toBe(before.epoch);
    expect(await texts(again)).toEqual(['Hello', 'World', 'Live', 'While away']);
    expect(new Set(after.index().map(value => value.itemKey)).size).toBe(after.index().length);
    expect(again.published.flatMap(({ result }) => result.events.filter(event => event.kind === 'replaced'))).toEqual([]);
    expect(await sequencesContiguous(again)).toBe(true);
  });

  it('ends with the settled binding in the journal\'s row when the connection dropped inside the batch window that carried it', async () => {
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=', 'base64'));
    const first = relayLoopback(clock);
    const publisher = start(first, 'controller-1', { batchWindowMs: 500 });
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const session = new ScriptedSession('fake', 'thread-1', [item('history', 'm1', 'Hello'), boundary()], undefined, { 'shot.png': png }, gate);
    const manager = await attachScripted(session, 'agent-1', { resourceIdKey: 'controller-secret' });
    closers.push(() => { void manager.close(); });
    publisher.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source: manager });
    await until(async () => (await first.journal(SESSION))?.head !== undefined, 'the head');
    await settle(30);
    session.push(item('live', 'a', 'Here ![shot](shot.png)', { completes: true }));
    const rowOf = async (relay: ReturnType<typeof relayLoopback>) => (await relay.journal(SESSION))?.state().items.find(value => value.itemKey === 'a')?.body?.resources[0];
    await until(async () => (await rowOf(first)) !== undefined, 'the item with its image');
    expect((await rowOf(first))!.status).toBe('pending');
    open();
    for (let at = 0; at < 50 && !manager.timelineRows().some(row => row.resources.some(binding => binding.status === 'available')); at += 1) await new Promise<void>(resolve => setImmediate(resolve));
    const settled = manager.timelineRows().flatMap(row => row.resources).find(binding => binding.status === 'available')!;
    expect(settled).toBeDefined();
    first.disconnect();
    const again = relayLoopback(clock, { store: first.store });
    again.connect(publisher);
    await until(async () => (await rowOf(again))?.status === 'available', 'the settled binding in the journal');
    expect(await rowOf(again)).toEqual(settled);
  });

  it('reads older pages before it forces a replacement of an empty newest page, so an incomplete journal is not served empty', async () => {
    const first = relayLoopback(clock);
    const publisher = start(first, 'controller-1');
    const run = await follow(publisher, [], [{ observations: [item('history', 'm1', 'One'), item('history', 'm2', 'Two')] }]);
    await until(async () => (await first.journal(SESSION))?.head !== undefined, 'the head');
    await settle(30);
    // Another publisher resets the journal: it is incomplete and holds nothing.
    await first.connection.receive({ uplinkVersion: 2, type: 'journal_open', requestId: 'intruder', sessionKey: SESSION, publisherId: 'intruder', reset: true });
    first.disconnect();
    const again = relayLoopback(clock, { store: first.store });
    again.connect(publisher);
    await until(async () => { const journal = await again.journal(SESSION); return journal?.incomplete === false && journal.head !== undefined; }, 'the journal to be whole again');
    expect(await texts(again)).toEqual(['One', 'Two']);
    const replaces = again.fromPublisher.filter(message => message.type === 'journal_publish').flatMap(message => message.entries).filter((entry: { op: string }) => entry.op === 'replace');
    expect(replaces.map((entry: { items: unknown[] }) => entry.items.length)).toEqual([2]);
    await run.manager.close();
  });

  it('clears an incomplete journal with an empty replacement only when native history is exhausted', async () => {
    const first = relayLoopback(clock);
    const publisher = start(first, 'controller-1');
    await follow(publisher, [item('history', 'm1', 'One')]);
    await until(async () => (await first.journal(SESSION))?.head !== undefined, 'the head');
    await first.connection.receive({ uplinkVersion: 2, type: 'journal_open', requestId: 'intruder', sessionKey: SESSION, publisherId: 'intruder', reset: true });
    first.disconnect();
    const again = relayLoopback(clock, { store: first.store });
    again.connect(publisher);
    await until(async () => { const journal = await again.journal(SESSION); return journal?.incomplete === false && journal.head !== undefined; }, 'the journal to be whole again');
    expect(await texts(again)).toEqual(['One']);
  });

  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=', 'base64'));
  const imageRow = async (relay: ReturnType<typeof relayLoopback>, key: string) => (await relay.journal(SESSION))?.state().items.find(value => value.itemKey === key)?.body?.resources[0];
  const settledOf = (manager: Awaited<ReturnType<typeof attachScripted>>) => manager.timelineRows().flatMap(row => row.resources).find(binding => binding.status === 'available');

  it('ends with the settled id in a row that older history prepended, when the image settled just after the timeline was read', async () => {
    const relay = relayLoopback(clock);
    const publisher = start(relay, 'controller-1');
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const session = new ScriptedSession('fake', 'thread-1', [item('history', 'm3', 'Three'), item('history', 'm4', 'Four'), boundary('older-1')],
      [{ observations: [item('history', 'm1', 'See ![shot](shot.png)')] }], { 'shot.png': png }, gate);
    const manager = await attachScripted(session, 'agent-1', { resourceIdKey: 'controller-secret' });
    closers.push(() => { void manager.close(); });
    let read = false;
    publisher.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source: {
      subscribeJournal: tap => manager.subscribeJournal(tap), itemRows: key => manager.itemRows(key), attentionItemKey: () => manager.attentionItemKey(),
      snapshot: () => manager.snapshot(), hasOlderHistory: () => manager.hasOlderHistory(), loadOlderHistory: () => manager.loadOlderHistory(),
      timelineRows: () => {
        const rows = manager.timelineRows();
        // The image settles right after the answer to the request read the timeline.
        if (!read && rows.some(row => row.identity?.key === 'm1')) { read = true; queueMicrotask(open); }
        return rows;
      },
    } });
    await until(async () => (await relay.journal(SESSION))?.head !== undefined, 'the head');
    await settle(30);
    await relay.connection.requestOlder(SESSION, 5, 'm3');
    await until(async () => (await imageRow(relay, 'm1')) !== undefined && settledOf(manager) !== undefined, 'the prepended row');
    await until(async () => (await imageRow(relay, 'm1'))?.status === 'available', 'the settled binding in the prepended row');
    expect(await imageRow(relay, 'm1')).toEqual(settledOf(manager));
  });

  it('ends with the settled id in a row that the reconcile\'s older blocks prepended, when the image settled after the timeline was read', async () => {
    const first = relayLoopback(clock);
    const before = start(first, 'controller-before');
    const run = await follow(before, [item('history', 'm3', 'Three')]);
    await until(async () => (await first.journal(SESSION))?.head !== undefined, 'the head');
    await settle(30);
    const old = (await first.journal(SESSION))!;
    before.close();
    first.disconnect();
    await run.manager.close();

    const next = relayLoopback(clock);
    await carryOver(old, next);
    const after = start(next, 'controller-after');
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const session = new ScriptedSession('fake', 'thread-1', [item('history', 'm3', 'Three'), boundary('older-1')],
      [{ observations: [item('history', 'm1', 'See ![shot](shot.png)')] }], { 'shot.png': png }, gate);
    const manager = await attachScripted(session, 'agent-1', { resourceIdKey: 'controller-secret' });
    closers.push(() => { void manager.close(); });
    await manager.loadOlderHistory();
    after.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source: {
      subscribeJournal: tap => { const subscription = manager.subscribeJournal(tap); queueMicrotask(open); return subscription; },
      timelineRows: () => manager.timelineRows(), itemRows: key => manager.itemRows(key), attentionItemKey: () => manager.attentionItemKey(),
      snapshot: () => manager.snapshot(), hasOlderHistory: () => manager.hasOlderHistory(), loadOlderHistory: () => manager.loadOlderHistory(),
    } });
    await until(async () => (await imageRow(next, 'm1')) !== undefined && settledOf(manager) !== undefined, 'the prepended row');
    await until(async () => (await imageRow(next, 'm1'))?.status === 'available', 'the settled binding in the prepended row');
    expect(await imageRow(next, 'm1')).toEqual(settledOf(manager));
  });

  it('does not send an item whole that a refusal left partly in the journal, which would repeat its content', async () => {
    let appends = 0;
    const relay = relayLoopback(clock, { refuseEntry: entry => {
      if (entry.op !== 'append' || entry.itemKey !== 'x') return undefined;
      appends += 1;
      return appends === 2 ? { reason: 'type_changed', itemKey: 'x' } : undefined;
    } });
    const publisher = start(relay);
    const { session } = await follow(publisher, [item('history', 'm1', 'Hello')]);
    await until(async () => (await relay.journal(SESSION))?.head !== undefined, 'the head');
    await settle(30);
    session.push(item('live', 'x', 'first ', { completes: false }));
    await until(async () => (await texts(relay))?.includes('first ') === true, 'the first row');
    await settle(30);
    session.push(item('live', 'x', 'second ', { completes: false }));
    await until(() => appends === 2, 'the refusal');
    await settle(30);
    session.push(item('live', 'x', 'third', { completes: true }));
    await settle(60);
    const shown = (await texts(relay))!.filter(text => text.includes('first'));
    expect(shown).toEqual(['first ']);
    expect(appends).toBe(2);
  });

  describe('many sessions over one connection', () => {
    const SESSIONS = 12;
    const BUDGET_BYTES = 6000;
    /** A publisher whose writer is watched: the bytes of the entries of the publications the Relay has not yet acknowledged are what the uplink holds. */
    function watched(relay: ReturnType<typeof relayLoopback>) {
      const sent: Array<{ sessionKey: string; last: number; bytes: number }> = [];
      const unacknowledged = () => sent.filter(message => !relay.fromRelay.some(reply => reply.type === 'journal_ack' && reply.sessionKey === message.sessionKey && reply.watermark >= message.last));
      const peak = { bytes: 0 };
      const publisher = createJournalPublisher({ providers: () => ['fake'], scheduler: clock, now: clock.now, limits: { ...limits, inFlightBytes: BUDGET_BYTES } });
      closers.push(() => publisher.close());
      relay.connect(publisher);
      publisher.available({ send: json => {
        const message = JSON.parse(json);
        if (message.type === 'journal_publish') {
          sent.push({ sessionKey: message.sessionKey, last: message.entries.at(-1).sequence, bytes: Buffer.byteLength(JSON.stringify(message.entries)) });
          peak.bytes = Math.max(peak.bytes, unacknowledged().reduce((total, entry) => total + entry.bytes, 0));
        }
        relay.writer.send(json);
      } });
      return { publisher, sent, peak };
    }
    async function attachAll(publisher: JournalPublisher, text: string) {
      const sessions: ScriptedSession[] = [];
      for (let at = 1; at <= SESSIONS; at += 1) {
        const session = new ScriptedSession('fake', `thread-${at}`, [item('history', `m${at}`, text), boundary()]);
        const manager = await attachScripted(session, `agent-${at}`);
        closers.push(() => { void manager.close(); });
        publisher.attach({ agentId: `agent-${at}`, providerId: 'fake', nativeSessionId: `thread-${at}`, source: manager });
        sessions.push(session);
      }
      return sessions;
    }
    const keys = Array.from({ length: SESSIONS }, (_, at) => `fake:thread-${at + 1}`);
    const allServed = (relay: ReturnType<typeof relayLoopback>) => async () => (await Promise.all(keys.map(key => relay.journal(key)))).every(journal => journal?.head !== undefined);

    it('takes every session of a burst live, and never has more bytes in flight than the shared budget allows', async () => {
      const relay = relayLoopback(clock);
      const { publisher, peak } = watched(relay);
      await attachAll(publisher, 'y'.repeat(1500));
      await until(allServed(relay), 'every session to publish its head');
      expect(peak.bytes).toBeGreaterThan(0);
      expect(peak.bytes).toBeLessThanOrEqual(BUDGET_BYTES);
    });

    it('acknowledges the head of one session after at most one message of each other session, not after every message they have to send', async () => {
      const relay = relayLoopback(clock);
      const { publisher, sent } = watched(relay);
      const sessions = await attachAll(publisher, 'y'.repeat(800));
      await until(allServed(relay), 'every session to be live');
      await settle(30);
      const before = sent.length;
      for (const [at, session] of sessions.entries()) for (let row = 0; row < 3; row += 1) session.push(item('live', `live-${at}-${row}`, 'z'.repeat(1200), { completes: true }));
      sessions[SESSIONS - 1]!.push(item('live', 'last', 'Last', { completes: true }));
      await until(async () => (await texts(relay, keys[SESSIONS - 1]!))?.includes('Last') === true, 'the last session to publish its row');
      const own = sent.findIndex((message, at) => at >= before && message.sessionKey === keys[SESSIONS - 1]);
      expect(own).toBeGreaterThanOrEqual(0);
      const ahead = sent.slice(before, own).filter(message => message.sessionKey !== keys[SESSIONS - 1]);
      expect(ahead.length).toBeLessThanOrEqual(SESSIONS - 1);
    });
  });
});

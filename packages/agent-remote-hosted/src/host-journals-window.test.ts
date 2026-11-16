import { MemoryJournalStore, type JournalStore } from '@orchardworks/agent-remote-journal';
import type { JournalItemInput, JournalPublishEntry, ResourceBinding } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { createHostJournals, type HostJournals, type HostJournalsOptions, type JournalOpened } from './host-journals.js';
import { createJournalConnection, isJournalHostMessage } from './journal-uplink.js';
import { decodeRemoteHostUplinkMessage } from '@orchardworks/agent-remote-protocol';

const HOST = 'host-1';
const SESSION = 'codex:thread-1';
const KEY = `${HOST}:${SESSION}`;
const rowOf = (itemKey: string, text: string, extra: object = {}) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:source`, occurredAt: 1_725_000_000_000, turnId: 'turn-1',
  item: { type: 'assistant_message' as const, text, messageId: itemKey }, ...extra,
});
const done = (itemKey: string, text = itemKey, extra: object = {}): JournalItemInput => ({ row: rowOf(itemKey, text, extra), digest: `digest-${itemKey}-${text.slice(0, 16)}-${text.length}` });
const liveItem = (itemKey: string): JournalItemInput => done(itemKey, itemKey, { liveOnly: true });
const snapshot = {
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle' as const, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' as const },
};
const head = (sequence: number): JournalPublishEntry => ({ sequence, op: 'head', head: { snapshot, observedAt: sequence } });
const window = (sequence: number, items: JournalItemInput[]): JournalPublishEntry => ({ sequence, op: 'window', items });

/** A store that records what every write carries, so a test can tell an item write from a meta write. */
function countingStore() {
  const memory = new MemoryJournalStore();
  const writes: Array<{ upsert: string[]; removed: string[]; replaced: boolean }> = [];
  const store: JournalStore = {
    load: key => memory.load(key),
    apply: changes => { writes.push({ upsert: changes.upsert.map(item => item.itemKey), removed: changes.removed, replaced: changes.replaced }); return memory.apply(changes); },
    delete: key => memory.delete(key), catalog: memory.catalog,
  };
  return { store, writes, memory };
}

function fixture(options: Partial<Omit<HostJournalsOptions, 'store'>> = {}) {
  const counted = countingStore();
  return { ...counted, journals: createHostJournals({ ...options, store: counted.store }) };
}
const open = (journals: HostJournals, publisherId = 'controller-1') => journals.open(HOST, SESSION, publisherId, {}) as Promise<JournalOpened>;
const keys = async (memory: MemoryJournalStore) => (await memory.load(KEY))!.items.map(item => item.itemKey);

describe('a window published to a journal', () => {
  it('writes no item, epoch or sequence for the same window after any number of reopens, and tells subscribers only the head', async () => {
    const { journals, writes, memory } = fixture();
    const background = { id: 'bg-1', kind: 'review' as const, status: 'visible' as const };
    const withBackground = [{ row: { ...rowOf('a', 'a'), item: { ...rowOf('a', 'a').item, background } }, digest: done('a').digest }, done('b')];
    const binding: ResourceBinding = { locator: 'file:a', resourceId: 'r1', status: 'available' };
    let first = await open(journals);
    let result = await journals.publish(HOST, SESSION, first.generation, [window(1, withBackground), head(2)]);
    expect(result.window).toEqual({ outcome: 'replaced' });
    const epoch = result.cursor!.epoch;
    const baseline = writes.length;
    let sequence = 3;
    for (let reopen = 0; reopen < 5; reopen += 1) {
      first = await open(journals);
      sequence = first.watermark + 1;
      result = await journals.publish(HOST, SESSION, first.generation, [
        window(sequence, withBackground),
        { sequence: sequence + 1, op: 'outcome', providerId: 'codex', turnId: 'turn-1', background, occurredAt: 5 },
        { sequence: sequence + 2, op: 'rebind', itemKey: 'a', previous: binding, replacement: binding },
        head(sequence + 3),
      ]);
      expect(result.refusal).toBeUndefined();
      expect(result.window).toEqual({ outcome: 'unchanged' });
      expect(result.events.map(event => event.kind)).toEqual(['head']);
      expect(result.cursor?.epoch).toBe(epoch);
    }
    for (const write of writes.slice(baseline)) expect(write).toEqual({ upsert: [], removed: [], replaced: false });
    expect(await keys(memory)).toEqual(['a', 'b']);
  });

  it('appends the items a window adds and tells subscribers one row each', async () => {
    const { journals } = fixture();
    let opened = await open(journals);
    await journals.publish(HOST, SESSION, opened.generation, [window(1, [done('a')]), head(2)]);
    opened = await open(journals);
    const result = await journals.publish(HOST, SESSION, opened.generation, [window(opened.watermark + 1, [done('a'), done('b'), done('c')])]);
    expect(result.window).toEqual({ outcome: 'appended' });
    expect(result.events.map(event => event.kind)).toEqual(['row', 'row']);
    expect(result.cursor?.seq).toBe(3);
  });

  it('replaces for a changed digest, carries a live-only item and tells subscribers about the new epoch', async () => {
    const { journals, memory } = fixture();
    let opened = await open(journals);
    await journals.publish(HOST, SESSION, opened.generation, [window(1, [done('a'), liveItem('l'), done('b')])]);
    opened = await open(journals);
    const result = await journals.publish(HOST, SESSION, opened.generation, [window(opened.watermark + 1, [done('a', 'rewritten'), done('b')])]);
    expect(result.window).toEqual({ outcome: 'replaced' });
    expect(result.events.map(event => event.kind)).toEqual(['replaced']);
    expect(await keys(memory)).toEqual(['a', 'l', 'b']);
  });

  it('admits a window whole when the session has room for it, and appends an extension after evicting bodies for it', async () => {
    const items = ['a', 'b', 'c', 'd'].map((key, at) => done(key, key.repeat(400), { turnId: `turn-${at}` }));
    const { journals, memory } = fixture({ limits: { sessionBytes: 3600 }, retention: { turns: 1, minItems: 0 } });
    let opened = await open(journals);
    expect((await journals.publish(HOST, SESSION, opened.generation, [window(1, items.slice(0, 3))])).window).toEqual({ outcome: 'replaced' });
    opened = await open(journals);
    const grown = await journals.publish(HOST, SESSION, opened.generation, [window(opened.watermark + 1, items)]);
    expect(grown.refusal).toBeUndefined();
    expect(grown.window).toEqual({ outcome: 'appended' });
    expect(await keys(memory)).toEqual(['a', 'b', 'c', 'd']);
    const bodies = (await memory.load(KEY))!.items.map(item => item.body !== null);
    expect(bodies.at(-1)).toBe(true);
    expect(bodies.filter(Boolean).length).toBeLessThan(4);
  });

  it('refuses a window that the room cannot hold whole, and leaves the journal incomplete and out of serving instead of keeping part of it', async () => {
    const items = ['a', 'b', 'c', 'd'].map(key => done(key, key.repeat(400)));
    const { journals, memory } = fixture({ limits: { sessionBytes: 2600 } });
    const opened = await open(journals);
    await journals.publish(HOST, SESSION, opened.generation, [window(1, items.slice(0, 2)), head(2)]);
    expect(journals.served(HOST, SESSION)).toBe(true);
    const refused = await journals.publish(HOST, SESSION, opened.generation, [window(3, items)]);
    expect(refused.refusal).toMatchObject({ reason: 'quota_exceeded', sequence: 3 });
    expect(refused).toMatchObject({ unserved: true, hasHead: false });
    expect(journals.served(HOST, SESSION)).toBe(false);
    expect((await memory.load(KEY))!.meta.incomplete).toBe(true);
    expect(await keys(memory)).toEqual(['a', 'b']);
  });

  it('refuses the window of a Host whose other sessions fill its budget, and serves nothing from the session', async () => {
    const { journals, memory } = fixture({ limits: { hostBytes: 5000 } });
    const other = await journals.open(HOST, 'codex:other', 'controller-1', {}) as JournalOpened;
    await journals.publish(HOST, 'codex:other', other.generation, [{ sequence: 1, op: 'append', row: { ...rowOf('big', 'x'.repeat(3500)), turnId: 'turn-9' } }]);
    const opened = await open(journals);
    const refused = await journals.publish(HOST, SESSION, opened.generation, [window(1, ['a', 'b', 'c'].map(key => done(key, key.repeat(600)))), head(2)]);
    expect(refused.refusal).toMatchObject({ reason: 'quota_exceeded', sequence: 1 });
    expect(refused.hasHead).toBe(false);
    expect(journals.served(HOST, SESSION)).toBe(false);
    expect(await keys(memory)).toEqual([]);
    const again = await open(journals);
    const retried = await journals.publish(HOST, SESSION, again.generation, [window(1, ['a', 'b', 'c'].map(key => done(key, key.repeat(600)))), head(2)]);
    expect(retried.refusal).toMatchObject({ reason: 'quota_exceeded' });
    expect(journals.served(HOST, SESSION)).toBe(false);
  });

  it('refuses a live row too large for the room without emptying the journal, and the next window rebuilds it whole', async () => {
    const { journals, memory } = fixture({ limits: { sessionBytes: 4000 } });
    const opened = await open(journals);
    await journals.publish(HOST, SESSION, opened.generation, [window(1, [done('a'), done('b')]), head(2)]);
    const refused = await journals.publish(HOST, SESSION, opened.generation, [{ sequence: 3, op: 'append', row: rowOf('huge', 'x'.repeat(6000)) }]);
    expect(refused.refusal).toMatchObject({ reason: 'quota_exceeded', sequence: 3 });
    expect(journals.served(HOST, SESSION)).toBe(false);
    expect(await keys(memory)).toEqual(['a', 'b']);
    const recovered = await journals.publish(HOST, SESSION, opened.generation, [window(3, [done('a'), done('b'), done('c')]), head(4)]);
    expect(recovered.refusal).toBeUndefined();
    expect(recovered.window).toEqual({ outcome: 'replaced' });
    expect(recovered.hasHead).toBe(true);
    expect(await keys(memory)).toEqual(['a', 'b', 'c']);
  });

  it('caps the live-only items by bytes so that a window always fits beside them', async () => {
    const { journals, memory } = fixture({ limits: { sessionBytes: 6000 } });
    const opened = await open(journals);
    const live = (key: string) => ({ row: { ...rowOf(key, key.repeat(900)), liveOnly: true } });
    let dropped = 0;
    for (const [at, key] of ['l1', 'l2', 'l3', 'l4', 'l5'].entries()) {
      const result = await journals.publish(HOST, SESSION, opened.generation, [
        { sequence: at * 2 + 1, op: 'append', row: live(key).row }, { sequence: at * 2 + 2, op: 'complete', itemKey: key, digest: `digest-${key}` },
      ]);
      expect(result.refusal).toBeUndefined();
      dropped += result.droppedLiveOnly ?? 0;
    }
    expect(dropped).toBeGreaterThan(0);
    const kept = await keys(memory);
    expect(kept.length).toBeLessThan(5);
    expect(kept.at(-1)).toBe('l5');
    const fits = await journals.publish(HOST, SESSION, opened.generation, [window(11, [done('a', 'a'.repeat(1200)), done('b', 'b'.repeat(1200))])]);
    expect(fits.refusal).toBeUndefined();
    expect(await keys(memory)).toEqual([...kept, 'a', 'b']);
  });

  it('marks the journal incomplete when a live append is refused for quota, and a window from the same generation recovers it', async () => {
    const { journals, memory } = fixture({ limits: { sessionBytes: 3000 } });
    const opened = await open(journals);
    await journals.publish(HOST, SESSION, opened.generation, [window(1, [done('a')]), head(2)]);
    const refused = await journals.publish(HOST, SESSION, opened.generation, [{ sequence: 3, op: 'append', row: rowOf('big', 'x'.repeat(5000)) }]);
    expect(refused.refusal).toMatchObject({ reason: 'quota_exceeded', sequence: 3 });
    expect(refused.unserved).toBe(true);
    const later = await journals.publish(HOST, SESSION, opened.generation, [{ sequence: 3, op: 'append', row: rowOf('next', 'next') }]);
    expect(later.refusal).toMatchObject({ reason: 'incomplete' });
    const recovered = await journals.publish(HOST, SESSION, opened.generation, [window(3, [done('a'), done('next')]), head(4)]);
    expect(recovered.refusal).toBeUndefined();
    expect(recovered.window?.outcome).toBe('replaced');
    expect(recovered.hasHead).toBe(true);
    expect(await keys(memory)).toEqual(['a', 'next']);
    const live = await journals.publish(HOST, SESSION, opened.generation, [{ sequence: 5, op: 'append', row: rowOf('after', 'after') }]);
    expect(live.refusal).toBeUndefined();
  });

  it('refuses a prepend that passes the quota alone: the head stays, nothing is replaced, live rows continue and a rebind is never refused', async () => {
    const { journals, memory } = fixture({ limits: { sessionBytes: 4000 } });
    const opened = await open(journals);
    const binding: ResourceBinding = { locator: 'file:a', resourceId: 'r1', status: 'pending' };
    const settled: ResourceBinding = { ...binding, status: 'available', resourceId: 'r2' };
    const settledEpoch = (await journals.publish(HOST, SESSION, opened.generation, [window(1, [done('a', 'a', { resources: [binding] })]), head(2)])).cursor!.epoch;
    const refused = await journals.publish(HOST, SESSION, opened.generation, [{ sequence: 3, op: 'prepend', items: [done('old', 'o'.repeat(6000))] }]);
    expect(refused.refusal).toMatchObject({ reason: 'quota_exceeded', sequence: 3 });
    expect(refused.prependRefused).toBe(true);
    expect(refused.unserved).toBeUndefined();
    expect(refused.hasHead).toBe(true);
    expect(refused.cursor!.epoch).toBe(settledEpoch);
    expect(await keys(memory)).toEqual(['a']);
    const next = await journals.publish(HOST, SESSION, opened.generation, [
      { sequence: 3, op: 'append', row: rowOf('b', 'live') },
      { sequence: 4, op: 'rebind', itemKey: 'a', previous: binding, replacement: settled },
    ]);
    expect(next.refusal).toBeUndefined();
    expect(next.events.map(event => event.kind)).toEqual(['row', 'rebound']);
    expect((await memory.load(KEY))!.meta.incomplete).toBeUndefined();
  });

  it('reports the journal\'s oldest item that is not live-only', async () => {
    const { journals } = fixture();
    expect(await journals.status(HOST, SESSION)).toBeUndefined();
    const opened = await open(journals);
    expect((await journals.status(HOST, SESSION))?.oldestItemKey).toBeUndefined();
    await journals.publish(HOST, SESSION, opened.generation, [window(1, [liveItem('l'), done('a'), done('b')])]);
    expect((await journals.status(HOST, SESSION))?.oldestItemKey).toBe('a');
    await journals.publish(HOST, SESSION, opened.generation, [{ sequence: 2, op: 'prepend', items: [done('older')] }]);
    expect((await journals.status(HOST, SESSION))?.oldestItemKey).toBe('older');
  });
});

describe('the Relay\'s diagnostics for a window', () => {
  it('tells when a window replaced the journal, and nothing for an unchanged or appended one', async () => {
    const { journals } = fixture({ limits: { sessionBytes: 3000 } });
    const events: string[] = [];
    const connection = createJournalConnection({
      hostId: HOST, journals, current: () => true, send: () => undefined, diagnostic: event => events.push(event),
      scheduler: { setTimeout: () => 0, clearTimeout: () => undefined },
    });
    const wire = (fields: Record<string, unknown>) => {
      const decoded = decodeRemoteHostUplinkMessage(JSON.stringify({ uplinkVersion: 2, ...fields }));
      if (decoded.status !== 'ok' || !isJournalHostMessage(decoded.value)) throw new Error('Not a journal message from the Host.');
      return decoded.value;
    };
    const send = async (sequence: number, items: JournalItemInput[]) => connection.receive(wire({ type: 'journal_publish', sessionKey: SESSION, generation: 1, entries: [window(sequence, items)] }));
    await connection.receive(wire({ type: 'journal_open', requestId: 'open-1', sessionKey: SESSION, publisherId: 'controller-1' }));
    await send(1, [done('a')]);
    expect(events).toEqual(['journal_window_replaced']);
    events.length = 0;
    await send(2, [done('a')]);
    await send(3, [done('a'), done('b')]);
    expect(events).toEqual([]);
    await send(4, [done('c', 'rewritten')]);
    expect(events).toEqual(['journal_window_replaced']);
  });
});

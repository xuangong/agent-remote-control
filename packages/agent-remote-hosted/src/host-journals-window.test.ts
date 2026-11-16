import { MemoryJournalStore, type JournalStore } from '@orchardworks/agent-remote-journal';
import type { JournalItemInput, JournalPublishEntry, ResourceBinding } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { createHostJournals, type HostJournals, type HostJournalsOptions, type JournalOpened } from './host-journals.js';
import { createJournalConnection, isJournalHostMessage } from './journal-uplink.js';
import { decodeRemoteHostUplinkMessage } from '@orchardworks/agent-remote-protocol';

const HOST = 'host-1';
const SESSION = 'codex:thread-1';
const KEY = `${HOST}:${SESSION}`;
const LIMITS = { maxIndexItems: 1_000_000, pageItems: 1_000_000 };
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
  return { ...counted, journals: createHostJournals({ now: () => 1_000, ...options, store: counted.store }) };
}
const open = (journals: HostJournals, publisherId = 'controller-1') => journals.open(HOST, SESSION, publisherId, LIMITS) as Promise<JournalOpened>;
const keys = async (memory: MemoryJournalStore) => (await memory.load(KEY))!.items.map(item => item.itemKey);

describe('a window published to a journal', () => {
  it('writes no item, epoch or sequence for the same window after any number of reopens, and tells subscribers only the head', async () => {
    const { journals, writes, memory } = fixture();
    const background = { id: 'bg-1', kind: 'review' as const, status: 'visible' as const };
    const withBackground = [{ row: { ...rowOf('a', 'a'), item: { ...rowOf('a', 'a').item, background } }, digest: done('a').digest }, done('b')];
    const binding: ResourceBinding = { locator: 'file:a', resourceId: 'r1', status: 'available' };
    let first = await open(journals);
    let result = await journals.publish(HOST, SESSION, first.generation, [window(1, withBackground), head(2)]);
    expect(result.window).toEqual({ outcome: 'replaced', trimmed: 0 });
    const epoch = result.cursor!.epoch;
    const baseline = writes.length;
    let sequence = 3;
    for (let reopen = 0; reopen < 5; reopen += 1) {
      first = await open(journals);
      expect(first.epoch).not.toBe('');
      sequence = first.watermark + 1;
      result = await journals.publish(HOST, SESSION, first.generation, [
        window(sequence, withBackground),
        { sequence: sequence + 1, op: 'outcome', providerId: 'codex', turnId: 'turn-1', background, occurredAt: 5 },
        { sequence: sequence + 2, op: 'rebind', itemKey: 'a', previous: binding, replacement: binding },
        head(sequence + 3),
      ]);
      expect(result.refusal).toBeUndefined();
      expect(result.window).toEqual({ outcome: 'unchanged', trimmed: 0 });
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
    expect(result.window).toEqual({ outcome: 'appended', trimmed: 0 });
    expect(result.events.map(event => event.kind)).toEqual(['row', 'row']);
    expect(result.cursor?.seq).toBe(3);
  });

  it('replaces for a changed digest, carries a live-only item and tells subscribers about the new epoch', async () => {
    const { journals, memory } = fixture();
    let opened = await open(journals);
    await journals.publish(HOST, SESSION, opened.generation, [window(1, [done('a'), liveItem('l'), done('b')])]);
    opened = await open(journals);
    const result = await journals.publish(HOST, SESSION, opened.generation, [window(opened.watermark + 1, [done('a', 'rewritten'), done('b')])]);
    expect(result.window).toEqual({ outcome: 'replaced', trimmed: 0 });
    expect(result.events.map(event => event.kind)).toEqual(['replaced']);
    expect(await keys(memory)).toEqual(['a', 'l', 'b']);
  });

  it('trims a window to the newest items that fit the session, reports it, and leaves a larger window unchanged later', async () => {
    const items = ['a', 'b', 'c', 'd'].map(key => done(key, key.repeat(400)));
    const { journals, memory } = fixture({ limits: { sessionBytes: 2600 } });
    let opened = await open(journals);
    const result = await journals.publish(HOST, SESSION, opened.generation, [window(1, items)]);
    expect(result.refusal).toBeUndefined();
    expect(result.window?.outcome).toBe('replaced');
    expect(result.window!.trimmed).toBeGreaterThan(0);
    const kept = await keys(memory);
    expect(kept.at(-1)).toBe('d');
    expect(kept.length).toBe(4 - result.window!.trimmed);
    opened = await open(journals);
    const again = await journals.publish(HOST, SESSION, opened.generation, [window(opened.watermark + 1, items)]);
    expect(again.window).toEqual({ outcome: 'unchanged', trimmed: 0 });
    expect(await keys(memory)).toEqual(kept);
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
  it('tells when a window replaced the journal and when it was trimmed to the room, and nothing for an unchanged or appended one', async () => {
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
    const big = ['c', 'd', 'e', 'f'].map(key => done(key, key.repeat(500)));
    await send(4, big);
    expect(events).toEqual(['journal_window_replaced', 'journal_window_trimmed']);
  });
});

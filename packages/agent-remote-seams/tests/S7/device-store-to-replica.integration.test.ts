import { describe, expect, it } from 'vitest';
import { createStoredRecord, decodeStoredRecord, DEFAULT_WINDOW_LIMITS, DeviceStore, AgentReplica, STORED_SESSION_VERSION, type SessionIdentity } from '@orchardworks/agent-client';
import { buildEntry, buildSessionIdentity, buildSessionToStore, buildSnapshot, buildStoredRecord, buildTailPage, buildTailRows, memoryDeviceDatabase, TEST_NOW, TEST_RELAY_URL as relay } from '@orchardworks/agent-client/testing';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * S7, device store to replica (docs/current/agent-remote/seams.md). The real device store over an in-memory database and the real replica:
 * a record is saved, the page restarts, the record restores a replica that is marked restored, and the first server page replaces it by item key.
 */
const frozenV1 = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/device-record.v1.json', import.meta.url)), 'utf8'));
const identity: SessionIdentity = buildSessionIdentity();

/** One page of a device: a store over the device's one database, then what an opening conversation does with it. */
function device(database = memoryDeviceDatabase()) {
  const page = () => new DeviceStore({ database });
  return {
    database,
    page,
    /** The replica a conversation opens with: seeded from the device's record of the session for this Relay URL, if there is one. */
    async open(store: DeviceStore, relayUrl = relay): Promise<AgentReplica> {
      await store.preload(relayUrl);
      const replica = new AgentReplica();
      const stored = decodeStoredRecord(store.read(relayUrl, identity), relayUrl, identity);
      if (stored) replica.restoreFromDevice(stored);
      return replica;
    },
  };
}
const keysOf = (replica: AgentReplica) => replica.getState().timeline.entries.map(entry => entry.itemKey);

describe('S7 device store to replica', () => {
  it('a restored record paints before any frame arrives', async () => {
    const phone = device();
    const before = phone.page();
    before.put(buildStoredRecord({ rows: 3 }));
    await before.flush();
    const replica = await phone.open(phone.page());
    const { timeline, agent } = replica.getState();
    expect(keysOf(replica)).toEqual(['m1', 'm2', 'm3']);
    expect(timeline).toMatchObject({ initialized: true, restoredFromDevice: true, epoch: 'e1', nextSeq: 4, hasOlder: false });
    expect(agent?.runtimeInfo.sessionId).toBe('native-1');
  });

  it('restores a display, never an operation: no turn and no interaction survive the device', async () => {
    const running = buildSnapshot({ status: 'running', activeTurn: { turnId: 'turn-1', startedAt: '2026-11-15T00:00:00Z' },
      pendingInteractions: [{ requestId: 'ask', agentId: 'agent-1', type: 'question', prompt: 'Continue?' } as never] });
    const phone = device();
    const store = phone.page();
    store.put(createStoredRecord(relay, identity, buildSessionToStore(2, { snapshot: running }), DEFAULT_WINDOW_LIMITS, TEST_NOW)!);
    await store.flush();
    const { agent } = (await phone.open(phone.page())).getState();
    expect(agent?.activeTurn).toBeNull();
    expect(agent?.pendingInteractions).toEqual([]);
  });

  it('the first server page confirms the restored rows by item key and ends the restored mark', async () => {
    const phone = device();
    const store = phone.page();
    store.put(buildStoredRecord({ rows: 3 }));
    await store.flush();
    const replica = await phone.open(phone.page());
    const held = replica.getState().timeline.entries;
    replica.applyHistory(buildTailPage(buildTailRows(3), { epoch: 'e1' }));
    const { timeline } = replica.getState();
    expect(timeline.restoredFromDevice).toBeUndefined();
    expect(keysOf(replica)).toEqual(['m1', 'm2', 'm3']);
    expect(timeline.entries[0]!.item).toEqual(held[0]!.item);
  });

  it('the first server page replaces what the device held: a row the server no longer has is gone, a new one appears', async () => {
    const phone = device();
    const store = phone.page();
    store.put(buildStoredRecord({ rows: 3 }));
    await store.flush();
    const replica = await phone.open(phone.page());
    replica.applyHistory(buildTailPage([buildEntry(2), buildEntry(3), buildEntry(4, 'newer')], { epoch: 'e1' }));
    expect(keysOf(replica)).toEqual(['m2', 'm3', 'm4']);
  });

  it('a new epoch from the server replaces the restored window whole', async () => {
    const phone = device();
    const store = phone.page();
    store.put(buildStoredRecord({ rows: 3 }));
    await store.flush();
    const replica = await phone.open(phone.page());
    replica.applyHistory(buildTailPage([buildEntry(1, 'rewritten')], { epoch: 'e2' }));
    expect(replica.getState().timeline.epoch).toBe('e2');
    expect(keysOf(replica)).toEqual(['m1']);
    expect(replica.getState().timeline.restoredFromDevice).toBeUndefined();
  });

  it('a replica that already read from the Relay keeps what it has and ignores the device', async () => {
    const replica = new AgentReplica();
    replica.applyHistory(buildTailPage([buildEntry(7)], { epoch: 'e9' }));
    const stored = decodeStoredRecord(buildStoredRecord({ rows: 3 }), relay, identity)!;
    replica.restoreFromDevice(stored);
    expect(keysOf(replica)).toEqual(['m7']);
    expect(replica.getState().timeline.restoredFromDevice).toBeUndefined();
  });

  it('discards a record of another stored version, and one stored for another person or session', async () => {
    const record = buildStoredRecord();
    expect(decodeStoredRecord({ ...record, version: STORED_SESSION_VERSION + 1 }, relay, identity)).toBeUndefined();
    expect(decodeStoredRecord(record, 'https://relay.example/u/b/', identity)).toBeUndefined();
    expect(decodeStoredRecord(record, relay, buildSessionIdentity('other'))).toBeUndefined();
  });

  it('never opens a record of another Relay URL, which is where another person is', async () => {
    const phone = device();
    const store = phone.page();
    store.put(buildStoredRecord({ relayUrl: 'https://relay.example/u/b/' }));
    await store.flush();
    expect(keysOf(await phone.open(phone.page(), relay))).toEqual([]);
  });

  it('a purge after a refused lease leaves nothing to restore, now or after a restart', async () => {
    const phone = device();
    const store = phone.page();
    store.put(buildStoredRecord());
    await store.flush();
    await store.purge(relay);
    expect(keysOf(await phone.open(store))).toEqual([]);
    expect(keysOf(await phone.open(phone.page()))).toEqual([]);
  });

  it('a record over the byte budget is evicted oldest first, and the evicted conversation opens empty', async () => {
    const phone = device();
    const size = buildStoredRecord().bytes;
    const store = new DeviceStore({ database: phone.database, diskCapBytes: size + 10 });
    store.put(buildStoredRecord({ nativeSessionId: 'old', updatedAt: 1 }));
    store.put(buildStoredRecord({ nativeSessionId: 'native-1', updatedAt: 2 }));
    await store.flush();
    expect(phone.database.keys()).toHaveLength(1);
    expect(keysOf(await phone.open(phone.page()))).toEqual(['m1', 'm2', 'm3']);
  });

  it('keeps the newest window of a long conversation and says there is older history', async () => {
    const phone = device();
    const store = phone.page();
    const rows = DEFAULT_WINDOW_LIMITS.maxEntries + 20;
    store.put(createStoredRecord(relay, identity, buildSessionToStore(rows), DEFAULT_WINDOW_LIMITS, TEST_NOW)!);
    await store.flush();
    const replica = await phone.open(phone.page());
    expect(replica.getState().timeline.entries).toHaveLength(DEFAULT_WINDOW_LIMITS.maxEntries);
    expect(keysOf(replica).at(-1)).toBe(`m${rows}`);
    expect(replica.getState().timeline.hasOlder).toBe(true);
  });

  it('still reads a record frozen at stored version 1', () => {
    const stored = decodeStoredRecord(frozenV1, frozenV1.relayUrl, identity);
    expect(stored?.entries.map(entry => entry.itemKey)).toEqual(['m1', 'm2']);
    expect(frozenV1.version).toBe(1);
  });
});

// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { AgentReplica, createStoredRecord, decodeStoredRecord, DEFAULT_WINDOW_LIMITS, HttpWebSocketTransport, RemoteSessionClient } from '@orchardworks/agent-client';
import { deviceStore, type SessionIdentity } from '@orchardworks/agent-client/device-store';
import { journalOf, servedJournal } from './test/served-journal.js';

/**
 * A stored cursor is safe because a wrong one cannot produce a hole or a wrong row: the Relay's journal answers it with a replacement (an epoch it no
 * longer holds, a sequence beyond its head) and the client merges the tail by key. Real `SessionJournal`, real HTTP and WebSocket, real client, real store.
 */
const scope = 'https://relay.example/u/alice/';
const identity: SessionIdentity = ['host', 'copilot', 'one'];
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); await deviceStore.purge(); });

/** Reads a session once and keeps what the device would store of it. */
async function readAndStore(journal: ReturnType<typeof journalOf>) {
  const relay = await servedJournal(journal);
  const transport = new HttpWebSocketTransport(relay.url, { WebSocket: WebSocket as never, sessionChannels: true });
  const replica = new AgentReplica();
  const client = new RemoteSessionClient('one', transport, replica);
  const statuses: string[] = [];
  client.subscribeStatus(status => statuses.push(status));
  client.start();
  await vi.waitFor(() => expect(statuses.at(-1)).toBe('ready'), { timeout: 3000, interval: 10 });
  const { timeline } = replica.getState();
  const record = createStoredRecord(scope, identity, { agentId: 'one', epoch: timeline.epoch!, nextSeq: timeline.nextSeq, hasOlder: timeline.hasOlder, entries: timeline.entries, snapshot: replica.getState().agent! }, DEFAULT_WINDOW_LIMITS, 1)!;
  client.stop(); transport.dispose(); await relay.close();
  return record;
}

/** A new page of the browser: a replica restored from the stored record, then connected to `journal`. */
async function reopen(record: Awaited<ReturnType<typeof readAndStore>>, journal: ReturnType<typeof journalOf>) {
  const relay = await servedJournal(journal);
  const transport = new HttpWebSocketTransport(relay.url, { WebSocket: WebSocket as never, sessionChannels: true });
  const replica = new AgentReplica();
  deviceStore.put(record);
  const stored = decodeStoredRecord(deviceStore.read(scope, identity), scope, identity)!;
  replica.restoreFromDevice(stored);
  const client = new RemoteSessionClient('one', transport, replica);
  const statuses: string[] = [];
  const sizes: number[] = [];
  replica.subscribe(() => sizes.push(replica.getState().timeline.entries.length));
  client.subscribeStatus(status => statuses.push(status));
  closers.push(async () => { client.stop(); transport.dispose(); await relay.close(); });
  const before = replica.getState().timeline.entries;
  client.start();
  await vi.waitFor(() => expect(statuses.at(-1)).toBe('ready'), { timeout: 3000, interval: 10 });
  return { relay, replica, before, sizes };
}
const keys = (replica: AgentReplica) => replica.getState().timeline.entries.map(entry => entry.itemKey);
const rows = (count: number): Array<readonly [string, string]> => Array.from({ length: count }, (_, index) => [`k${index}`, `Row ${index}`] as const);

it('continues exactly from the stored cursor when the journal still holds its epoch, keeping the held rows as they are', async () => {
  const stored = await readAndStore(journalOf('epoch-one', rows(4)));
  const { relay, replica, before } = await reopen(stored, journalOf('epoch-one', [...rows(4), ['k4', 'Row 4']]));
  expect(relay.requests.map(request => request.direction)).toEqual(['after']);
  expect(keys(replica)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);
  for (let index = 0; index < 4; index++) expect(replica.getState().timeline.entries[index]).toBe(before[index]);
  expect(replica.getState().timeline.restoredFromDevice).toBeUndefined();
});

it('turns an epoch the Relay no longer holds into a replacement, merging the tail by key with no empty state', async () => {
  const stored = await readAndStore(journalOf('epoch-one', rows(4)));
  const { relay, replica, sizes } = await reopen(stored, journalOf('epoch-two', [['k0', 'Row 0'], ['k1', 'Row 1 changed'], ['n1', 'New'], ['k3', 'Row 3']]));
  expect(relay.requests.map(request => request.direction)).toEqual(['after', 'tail']);
  expect(keys(replica)).toEqual(['k0', 'k1', 'n1', 'k3']);
  expect(replica.getState().timeline.entries.find(entry => entry.itemKey === 'k1')?.item).toMatchObject({ text: 'Row 1 changed' });
  expect(Math.min(...sizes)).toBeGreaterThan(0);
  expect(replica.getState().timeline.epoch).toBe('epoch-two');
  expect(replica.getState().timeline.restoredFromDevice).toBeUndefined();
  expect(replica.getState().timeline.pendingEpoch).toBeUndefined();
});

it('turns a cursor beyond the journal head into a replacement: no hole and no row the journal does not have', async () => {
  const stored = await readAndStore(journalOf('epoch-one', rows(6)));
  // The same epoch, but the journal holds fewer rows than the device read (a Relay that lost its tail).
  const { relay, replica } = await reopen(stored, journalOf('epoch-one', rows(3)));
  expect(relay.requests.map(request => request.direction)).toEqual(['after', 'tail']);
  expect(keys(replica)).toEqual(['k0', 'k1', 'k2']);
  expect(replica.getState().timeline.nextSeq).toBe(4);
});

it('rewrites the record in the new epoch coordinates after the replacement, and the next open continues from there', async () => {
  const first = await readAndStore(journalOf('epoch-one', rows(3)));
  const second = journalOf('epoch-two', [...rows(3), ['k3', 'Row 3']]);
  const { replica } = await reopen(first, second);
  const { timeline } = replica.getState();
  const rewritten = createStoredRecord(scope, identity, { agentId: 'one', epoch: timeline.epoch!, nextSeq: timeline.nextSeq, hasOlder: timeline.hasOlder, entries: timeline.entries, snapshot: replica.getState().agent! }, DEFAULT_WINDOW_LIMITS, 2)!;
  expect(rewritten).toMatchObject({ epoch: 'epoch-two', nextSeq: 5 });
  const again = await reopen(rewritten, second);
  expect(again.relay.requests.map(request => request.direction)).toEqual(['after']);
  expect(keys(again.replica)).toEqual(['k0', 'k1', 'k2', 'k3']);
});

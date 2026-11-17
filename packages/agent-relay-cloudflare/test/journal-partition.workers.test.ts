import { expect, test } from 'vitest';

import { replayPartitionContract, type PartitionContractStep } from '@orchardworks/agent-relay-core/testing';
import type { JournalPartitionApi } from '@orchardworks/agent-relay-core';
import contract from '@orchardworks/agent-relay-core/journal-partition.contract.json' with { type: 'json' };

import { fixture, send } from './fixture.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const SESSION = 'codex:thread-1';
const row = (itemKey: string, text: string, turn = 1) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:${text.length}`, occurredAt: 1_725_000_000_000, turnId: `turn-${turn}`,
  item: { type: 'assistant_message', text, messageId: itemKey },
});
const snapshot = {
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' },
};
const head = (sequence: number) => ({ sequence, op: 'head', head: { snapshot, observedAt: 5 } });
const tail = { requestId: 'p', agentId: 'a', direction: 'tail', limit: 10 };

/** Calls a method of the Host's journal partition, the way `primary` does: Durable Object RPC from the Worker. */
async function call(f: Fixture, hostId: string, method: string, ...args: unknown[]): Promise<any> {
  const response = await f.inspect(`partition/${hostId}/${method}`, { method: 'POST', body: JSON.stringify(args) });
  const body = await response.json() as { result?: unknown; error?: string };
  if (!response.ok) throw new Error(body.error);
  return body.result;
}

test('keeps a published journal in the object of its Host, splits a large item into chunks and serves it after a restart', async () => {
  const f = await fixture({ journals: {} });
  const text = '😀é'.repeat(100_000);
  expect(await call(f, 'host-1', 'open', 'host-1', SESSION, 'controller-1')).toEqual({ generation: 1, watermark: 0 });
  const published = await call(f, 'host-1', 'publish', 'host-1', SESSION, 1, [
    { sequence: 1, op: 'append', row: row('big', text) }, { sequence: 2, op: 'complete', itemKey: 'big', digest: 'digest-big' }, head(3)]);
  expect(published).toMatchObject({ watermark: 3, hasHead: true });
  const sizes = await call(f, 'host-1', 'inspect', 'SELECT length(bytes) AS size FROM journal_chunks ORDER BY size DESC') as Array<{ size: number }>;
  expect(sizes.length).toBeGreaterThanOrEqual(3);
  expect(sizes[0]!.size).toBeLessThanOrEqual(262_144);
  const before = await call(f, 'host-1', 'page', 'host-1', SESSION, tail, false);
  expect(before.page.payload.entries[0].item.text).toBe(text);
  await f.restart();
  expect(await call(f, 'host-1', 'page', 'host-1', SESSION, tail, false)).toEqual(before);
  expect(await call(f, 'host-1', 'servedSessions', 'host-1')).toEqual([SESSION]);
  expect(await call(f, 'host-1', 'open', 'host-1', SESSION, 'controller-1')).toMatchObject({ generation: 2, watermark: 3 });
}, 60_000);

test('keeps each Host in its own object and deletes the journals of one Host without touching another', async () => {
  const f = await fixture({ journals: {} });
  for (const host of ['host-1', 'host-2']) {
    await call(f, host, 'open', host, SESSION, 'controller-1');
    await call(f, host, 'publish', host, SESSION, 1, [{ sequence: 1, op: 'append', row: row('m1', 'Hello') }, head(2)]);
  }
  expect(await call(f, 'host-1', 'servedSessions', 'host-1')).toEqual([SESSION]);
  await call(f, 'host-1', 'deleteHost', 'host-1');
  expect(await call(f, 'host-1', 'servedSessions', 'host-1')).toEqual([]);
  expect(await call(f, 'host-1', 'inspect', 'SELECT count(*) AS n FROM journal_sessions')).toEqual([{ n: 0 }]);
  expect(await call(f, 'host-1', 'inspect', 'SELECT count(*) AS n FROM journal_chunks')).toEqual([{ n: 0 }]);
  expect(await call(f, 'host-2', 'servedSessions', 'host-2')).toEqual([SESSION]);
  expect(await call(f, 'host-2', 'status', 'host-2', SESSION)).toMatchObject({ cursor: { seq: 1 } });
}, 60_000);

test('holds the Durable Object bounds by default: two journals, 20 MiB of cache and 12 MiB per session', async () => {
  const f = await fixture({ journals: {} });
  expect(await call(f, 'host-1', 'effectiveTuning')).toEqual({
    cache: { maxJournals: 2, maxBytes: 20 * 1024 * 1024 }, limits: { sessionBytes: 12 * 1024 * 1024, hostBytes: 1024 * 1024 * 1024 } });
}, 60_000);

test('answers every recorded call of the partition contract through Durable Object RPC', async () => {
  const f = await fixture({ journals: {} });
  const api = Object.fromEntries(['open', 'publish', 'fill', 'page', 'status', 'unserveHead', 'servedSessions', 'deleteHost', 'capabilities']
    .map(method => [method, async (...args: unknown[]) => (await call(f, 'host-1', method, ...args)) ?? undefined])) as unknown as JournalPartitionApi;
  await replayPartitionContract(api, contract as PartitionContractStep[]);
}, 60_000);

test('rolls back every statement of a transaction that fails', async () => {
  const f = await fixture({ journals: {} });
  expect(await call(f, 'host-1', 'transactionProbe')).toEqual([{ n: 0 }]);
}, 60_000);

/** A Controller connected for journals: it registers (rotating its pairing key into a device credential on the first connection) and keeps what the Relay sends. */
async function journalHost(f: Fixture, key: string) {
  const socket = await f.upgrade('/ws/remote-host?journal=1', { authorization: `Bearer ${key}` });
  const inbox: Array<Record<string, any>> = [];
  socket.addEventListener('message', message => { inbox.push(JSON.parse(String(message.data))); });
  const take = async (...types: string[]): Promise<Record<string, any>> => {
    for (let attempt = 0; attempt < 500; attempt++) {
      const at = inbox.findIndex(message => types.includes(message.type));
      if (at >= 0) return inbox.splice(at, 1)[0]!;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`The Relay sent none of ${types.join(', ')}.`);
  };
  send(socket, { type: 'register', credentialRotation: true, installationId: 'journal-host', name: 'Journal Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] });
  let message = await take('credential_issued', 'registered');
  let credential = key;
  if (message.type === 'credential_issued') {
    credential = message.credential;
    send(socket, { type: 'credential_saved' });
    message = await take('registered');
  }
  return { socket, take, registered: message, credential };
}

test('grants journals through the partitions, keeps journal rows out of primary and finds the journal again after a restart', async () => {
  const f = await fixture({ journals: {} });
  const owner = await f.login('owner');
  const pairing = await (await f.json(owner.basePath + 'v1/remote/pairings', owner.cookie, {})).json() as { key: string };
  const host = await journalHost(f, pairing.key);
  expect(host.registered).toMatchObject({ type: 'registered', journal: 1 });
  const hostId = host.registered.hostId as string;
  send(host.socket, { type: 'journal_open', requestId: 'open-1', sessionKey: SESSION, publisherId: 'controller-1' });
  expect(await host.take('journal_opened')).toMatchObject({ generation: 1, watermark: 0 });
  send(host.socket, { type: 'journal_publish', sessionKey: SESSION, generation: 1, entries: [
    { sequence: 1, op: 'append', row: row('m1', 'Hello') }, { sequence: 2, op: 'complete', itemKey: 'm1', digest: 'digest-m1' }, head(3)] });
  expect(await host.take('journal_ack')).toMatchObject({ generation: 1, watermark: 3 });
  expect(await (await f.inspect('journal-tables')).json()).toEqual([]);
  expect(await call(f, hostId, 'inspect', 'SELECT count(*) AS n FROM journal_sessions')).toEqual([{ n: 1 }]);
  expect(await call(f, hostId, 'servedSessions', hostId)).toEqual([SESSION]);
  host.socket.close();
  await f.restart();
  const again = await journalHost(f, host.credential);
  expect(again.registered).toMatchObject({ type: 'registered', journal: 1, hostId });
  send(again.socket, { type: 'journal_open', requestId: 'open-2', sessionKey: SESSION, publisherId: 'controller-1' });
  const reopened = await again.take('journal_opened');
  expect(reopened).toMatchObject({ generation: 2, watermark: 3 });
  expect(reopened).not.toHaveProperty('index');
}, 90_000);

test('grants no journals when the Worker has the binding but the variable is not set', async () => {
  const f = await fixture();
  const owner = await f.login('owner');
  const pairing = await (await f.json(owner.basePath + 'v1/remote/pairings', owner.cookie, {})).json() as { key: string };
  const host = await journalHost(f, pairing.key);
  expect(host.registered).toMatchObject({ type: 'registered' });
  expect(host.registered).not.toHaveProperty('journal');
}, 60_000);

test('runs without journals and logs a configuration error when the variable is set but the Worker has no JOURNALS binding', async () => {
  const f = await fixture({ journals: { withoutBinding: true } });
  const owner = await f.login('owner');
  const pairing = await (await f.json(owner.basePath + 'v1/remote/pairings', owner.cookie, {})).json() as { key: string };
  const host = await journalHost(f, pairing.key);
  expect(host.registered).toMatchObject({ type: 'registered' });
  expect(host.registered).not.toHaveProperty('journal');
  expect(f.runtimeErrors).toContain('AGENT_REMOTE_JOURNALS is 1 but this Worker has no JOURNALS binding');
}, 60_000);

test('refuses the open of a Host whose partition is older than the Relay, and answers once the partition is current', async () => {
  const f = await fixture({ journals: { olderPartition: true } });
  const missing = await call(f, 'host-1', 'capabilities', 'host-1').then(() => undefined, error => String(error.message));
  expect(missing).toBe('TypeError: The RPC receiver does not implement the method "capabilities".');
  const owner = await f.login('owner');
  const pairing = await (await f.json(owner.basePath + 'v1/remote/pairings', owner.cookie, {})).json() as { key: string };
  const host = await journalHost(f, pairing.key);
  expect(host.registered).toMatchObject({ type: 'registered', journal: 1 });
  send(host.socket, { type: 'journal_open', requestId: 'open-1', sessionKey: SESSION, publisherId: 'controller-1' });
  expect(await host.take('journal_open_refused')).toMatchObject({ requestId: 'open-1', sessionKey: SESSION, reason: 'unavailable' });
}, 60_000);

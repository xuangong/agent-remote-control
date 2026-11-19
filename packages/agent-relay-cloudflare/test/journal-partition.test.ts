import { expect, test } from 'vitest';

import { createHostJournals, JOURNAL_PARTITION_CACHE, JOURNAL_PARTITION_LIMITS, serveJournalPartition, type JournalPartitionApi } from '@orchardworks/agent-relay-core';
import { replayPartitionContract, type PartitionContractStep } from '@orchardworks/agent-relay-core/testing';
import contract from '@orchardworks/agent-relay-core/journal-partition.contract.json' with { type: 'json' };
import { SqlJournalStore } from '@orchardworks/agent-remote-journal-sqlite';

import { durableObjectJournalDatabase } from '../src/journal-sql-database.js';
import { sqliteStorage } from './sqlite-storage.js';

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


/** The Host journal partitions as `JournalPartition` builds them, over node:sqlite: one storage per Host; `restart` opens a Host's partition again over its rows. */
function partitions() {
  const storages = new Map<string, ReturnType<typeof sqliteStorage>['storage']>();
  const open = (hostId: string) => {
    const storage = storages.get(hostId) ?? storages.set(hostId, sqliteStorage().storage).get(hostId)!;
    const database = durableObjectJournalDatabase(storage);
    const api = serveJournalPartition(createHostJournals({ store: new SqlJournalStore(database), cache: JOURNAL_PARTITION_CACHE, limits: JOURNAL_PARTITION_LIMITS }));
    return { api, database };
  };
  const live = new Map<string, ReturnType<typeof open>>();
  const partition = (hostId: string) => live.get(hostId) ?? live.set(hostId, open(hostId)).get(hostId)!;
  return {
    call: async (hostId: string, method: string, ...args: unknown[]): Promise<any> => {
      if (method === 'inspect') return partition(hostId).database.all(args[0] as string);
      return (await (partition(hostId).api as any)[method](...args)) ?? null;
    },
    restart: () => live.clear(),
  };
}

test('keeps a published journal in the object of its Host, splits a large item into chunks and serves it after a restart', async () => {
  const f = partitions();
  const text = '😀é'.repeat(100_000);
  expect(await f.call('host-1', 'open', 'host-1', SESSION, 'controller-1')).toEqual({ generation: 1, watermark: 0 });
  const published = await f.call('host-1', 'publish', 'host-1', SESSION, 1, [
    { sequence: 1, op: 'append', row: row('big', text) }, { sequence: 2, op: 'complete', itemKey: 'big', digest: 'digest-big' }, head(3)]);
  expect(published).toMatchObject({ watermark: 3, hasHead: true });
  const sizes = await f.call('host-1', 'inspect', 'SELECT length(bytes) AS size FROM journal_chunks ORDER BY size DESC') as Array<{ size: number }>;
  expect(sizes.length).toBeGreaterThanOrEqual(3);
  expect(sizes[0]!.size).toBeLessThanOrEqual(262_144);
  const before = await f.call('host-1', 'page', 'host-1', SESSION, tail, false);
  expect(before.page.payload.entries[0].item.text).toBe(text);
  f.restart();
  expect(await f.call('host-1', 'page', 'host-1', SESSION, tail, false)).toEqual(before);
  expect(await f.call('host-1', 'servedSessions', 'host-1')).toEqual([SESSION]);
  expect(await f.call('host-1', 'open', 'host-1', SESSION, 'controller-1')).toMatchObject({ generation: 2, watermark: 3 });
});

test('keeps each Host in its own object and deletes the journals of one Host without touching another', async () => {
  const f = partitions();
  for (const host of ['host-1', 'host-2']) {
    await f.call(host, 'open', host, SESSION, 'controller-1');
    await f.call(host, 'publish', host, SESSION, 1, [{ sequence: 1, op: 'append', row: row('m1', 'Hello') }, head(2)]);
  }
  expect(await f.call('host-1', 'servedSessions', 'host-1')).toEqual([SESSION]);
  await f.call('host-1', 'deleteHost', 'host-1');
  expect(await f.call('host-1', 'servedSessions', 'host-1')).toEqual([]);
  expect(await f.call('host-1', 'inspect', 'SELECT count(*) AS n FROM journal_sessions')).toEqual([{ n: 0 }]);
  expect(await f.call('host-1', 'inspect', 'SELECT count(*) AS n FROM journal_chunks')).toEqual([{ n: 0 }]);
  expect(await f.call('host-2', 'servedSessions', 'host-2')).toEqual([SESSION]);
  expect(await f.call('host-2', 'status', 'host-2', SESSION)).toMatchObject({ cursor: { seq: 1 } });
});

test('answers every recorded call of the partition contract through Durable Object RPC', async () => {
  const f = partitions();
  const api = Object.fromEntries(['open', 'publish', 'fill', 'page', 'status', 'unserveHead', 'servedSessions', 'deleteHost', 'capabilities']
    .map(method => [method, async (...args: unknown[]) => (await f.call('host-1', method, ...args)) ?? undefined])) as unknown as JournalPartitionApi;
  await replayPartitionContract(api, contract as PartitionContractStep[]);
});


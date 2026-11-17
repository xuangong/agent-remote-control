import { createHostJournals, createPartitionJournals, serveJournalPartition, type JournalPartitionApi } from '@orchardworks/agent-relay-core';
import { overStructuredClone, playPartitionContract, type PartitionContractStep } from '@orchardworks/agent-relay-core/testing';
import { MemoryJournalStore } from '@orchardworks/agent-remote-journal';
import type { JournalPublishEntry } from '@orchardworks/agent-remote-protocol';
import { createRequire } from 'node:module';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startPartitionServer } from './partition-server.js';

/**
 * S5, Relay to Cloudflare partition: the partition proxy of `primary` (`createPartitionJournals`) and the partition server
 * (`serveJournalPartition` over the SQL store, as `JournalPartition` composes it), joined by `journal-partition.contract.json`
 * and by calls that cross as structured clones. The Durable Object shell is the Workers project's business.
 */
const steps = createRequire(import.meta.url)('@orchardworks/agent-relay-core/journal-partition.contract.json') as PartitionContractStep[];
const HOST = 'host-1';
const SESSION = 'codex:thread-1';
const row = (itemKey: string, text: string, turn = 1) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:${text.length}`, occurredAt: 1_725_000_000_000, turnId: `turn-${turn}`,
  item: { type: 'assistant_message' as const, text, messageId: itemKey },
});
const append = (sequence: number, itemKey: string, text: string, turn = 1): JournalPublishEntry => ({ sequence, op: 'append', row: row(itemKey, text, turn) });
const complete = (sequence: number, itemKey: string): JournalPublishEntry => ({ sequence, op: 'complete', itemKey, digest: `digest-${itemKey}` });
const tail = (limit = 10) => ({ requestId: 'p', agentId: 'a', direction: 'tail' as const, limit });

const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });
async function server(...args: Parameters<typeof startPartitionServer>) {
  const started = await startPartitionServer(...args);
  closers.push(started.close);
  return started;
}

const methods = [...new Set(steps.map(step => step.method))];

describe('S5 the partition server answers the contract', () => {
  let played: PartitionContractStep[];
  beforeAll(async () => {
    const started = await startPartitionServer();
    try { played = await playPartitionContract(started.api, steps); } finally { started.close(); }
  });

  it.each(methods)('answers every recorded %s call with the recorded reply', method => {
    const expected = steps.map((step, index) => ({ step, index })).filter(({ step }) => step.method === method);
    expect(expected.length).toBeGreaterThan(0);
    for (const { step, index } of expected) expect(played[index]!.reply, `${step.method} step ${index}`).toEqual(step.reply);
  });

  it('serves exactly the methods of the contract', async () => {
    const started = await server();
    expect(Object.keys(started.api).sort()).toEqual([...methods].sort());
  });
});

describe('S5 the proxy over the partition server', () => {
  it('opens, publishes and pages through the partition of each Host, keeping Hosts apart', async () => {
    const partitions = new Map<string, JournalPartitionApi>();
    for (const host of [HOST, 'host-2']) partitions.set(host, (await server()).api);
    const journals = createPartitionJournals({ partition: host => partitions.get(host)! });
    await journals.open(HOST, SESSION, 'controller-1', {});
    await journals.open('host-2', SESSION, 'controller-2', {});
    expect(await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello'), complete(2, 'm1')])).toMatchObject({ watermark: 2, cursor: { seq: 1 }, hasHead: false });
    expect(await journals.page(HOST, SESSION, tail(), false)).toMatchObject({ kind: 'page', page: { payload: { entries: [expect.objectContaining({ item: expect.objectContaining({ text: 'Hello' }) })] } } });
    expect(await journals.page('host-2', SESSION, tail(), false)).toMatchObject({ kind: 'page', page: { payload: { entries: [] } } });
  });

  it('refuses a publication that skips a sequence and applies it once the gap is filled', async () => {
    const { api } = await server();
    const journals = createPartitionJournals({ partition: () => api });
    await journals.open(HOST, SESSION, 'controller-1', {});
    expect(await journals.publish(HOST, SESSION, 1, [append(2, 'm1', 'Hello')])).toMatchObject({ refusal: { reason: 'sequence_gap', sequence: 2 }, watermark: 0 });
    expect(await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello')])).toMatchObject({ watermark: 1 });
  });

  it('fences a publication of a generation that a newer open replaced', async () => {
    const { api } = await server();
    const journals = createPartitionJournals({ partition: () => api });
    await journals.open(HOST, SESSION, 'controller-1', {});
    await journals.open(HOST, SESSION, 'controller-2', {});
    expect(await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello')])).toMatchObject({ refusal: { reason: 'fenced' } });
  });

  it('refuses growth over the session limit with quota_exceeded, and consumes no sequence', async () => {
    const { api } = await server({ limits: { sessionBytes: 3500, hostBytes: 1024 * 1024 } });
    const journals = createPartitionJournals({ partition: () => api });
    const big = 'x'.repeat(2000);
    await journals.open(HOST, SESSION, 'controller-1', {});
    expect((await journals.publish(HOST, SESSION, 1, [append(1, 'm1', big, 1)])).refusal).toBeUndefined();
    expect(await journals.publish(HOST, SESSION, 1, [append(2, 'm2', big, 2)])).toMatchObject({ refusal: { sequence: 2, reason: 'quota_exceeded' }, watermark: 1 });
  });

  it('answers a page that would pass the reply bound with fewer entries', async () => {
    const { api } = await server({ replyMaxBytes: 5000 });
    const journals = createPartitionJournals({ partition: () => api });
    await journals.open(HOST, SESSION, 'controller-1', {});
    const entries = Array.from({ length: 6 }, (_, n) => [append(n * 2 + 1, `m${n}`, 'x'.repeat(2000), n), complete(n * 2 + 2, `m${n}`)]).flat();
    await journals.publish(HOST, SESSION, 1, entries);
    const result = await journals.page(HOST, SESSION, tail(6), false);
    const answered = result?.kind === 'page' ? result.page.payload.entries.length : 0;
    expect(answered).toBeGreaterThan(0);
    expect(answered).toBeLessThan(6);
  });

  it('fills bodies and reads the page in one call', async () => {
    const { api } = await server({ retention: { turns: 1, minItems: 1 } });
    const journals = createPartitionJournals({ partition: () => api });
    await journals.open(HOST, SESSION, 'controller-1', {});
    const text = 'é'.repeat(20_000);
    for (const n of [1, 2, 3]) await journals.publish(HOST, SESSION, 1, [append(n * 2 - 1, `m${n}`, text, n), complete(n * 2, `m${n}`)]);
    expect(await journals.page(HOST, SESSION, tail(), false)).toEqual({ kind: 'missing', itemKeys: ['m1', 'm2'] });
    const filled = await journals.fill(HOST, SESSION, ['m1', 'm2'].map(key => ({ row: row(key, text, Number(key.slice(1))), digest: `digest-${key}` })), { request: tail(), olderBeyondJournal: () => true });
    expect(filled).toMatchObject({ filled: ['m1', 'm2'], page: { kind: 'page', page: { payload: { hasOlder: true } } } });
  });

  it('serves the journal again from a server that started over the same database', async () => {
    const started = await server();
    const first = createPartitionJournals({ partition: () => started.api });
    await first.open(HOST, SESSION, 'controller-1', {});
    await first.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello'), complete(2, 'm1')]);
    const restarted = createPartitionJournals({ partition: () => started.restart() });
    expect(await restarted.servedSessions(HOST)).toEqual([]);
    expect(await restarted.open(HOST, SESSION, 'controller-1', {})).toMatchObject({ generation: 2, watermark: 2 });
    expect(await restarted.page(HOST, SESSION, tail(), false)).toMatchObject({ kind: 'page', page: { payload: { entries: [expect.objectContaining({ item: expect.objectContaining({ text: 'Hello' }) })] } } });
  });

  it('orders a deletion after the publications made before it', async () => {
    const { api } = await server();
    const journals = createPartitionJournals({ partition: () => api });
    await journals.open(HOST, SESSION, 'controller-1', {});
    const earlier = journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello')]);
    const deleted = journals.deleteHost(HOST);
    expect(await earlier).toMatchObject({ watermark: 1 });
    await deleted;
    expect(await journals.servedSessions(HOST)).toEqual([]);
    expect(await journals.page(HOST, SESSION, tail(), false)).toBeUndefined();
  });

  it('refuses the open of a partition that cannot answer its version, and asks again at the next open', async () => {
    const { api } = await server();
    let answer: 'missing' | 'current' = 'missing';
    const partition: JournalPartitionApi = { ...api, capabilities: async host => {
      if (answer === 'missing') throw new TypeError('The RPC receiver does not implement the method "capabilities".');
      return api.capabilities(host);
    } };
    const journals = createPartitionJournals({ partition: () => partition });
    expect(await journals.open(HOST, SESSION, 'controller-1', {})).toEqual({ refused: 'unavailable' });
    answer = 'current';
    expect(await journals.open(HOST, SESSION, 'controller-1', {})).toMatchObject({ generation: 1 });
  });

  it('serves a proxy that talks to a partition over the memory store the same as over SQL', async () => {
    const sql = await server();
    const memory = overStructuredClone(serveJournalPartition(createHostJournals({ store: new MemoryJournalStore() })));
    const played = await Promise.all([sql.api, memory].map(api => playPartitionContract(api, steps)));
    expect(played[0]).toEqual(played[1]);
  });
});

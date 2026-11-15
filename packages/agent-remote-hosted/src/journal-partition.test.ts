import { MemoryJournalStore, type JournalStore } from '@orchardworks/agent-remote-journal';
import type { JournalPublishEntry } from '@orchardworks/agent-remote-protocol';
import { serialize } from 'node:v8';

import { describe, expect, it } from 'vitest';

import recorded from './journal-partition.contract.json' with { type: 'json' };
import { createHostJournals, type HostJournalsOptions, type JournalOpened } from './host-journals.js';
import { createPartitionJournals, estimateCloneBytes, serveJournalPartition, type JournalPartitionApi } from './journal-partition.js';

const HOST = 'host-1';
const SESSION = 'codex:thread-1';
const DEADLINE_MS = 5000;
const LIMITS = { maxIndexItems: 1_000_000, pageItems: 2000 };
const rowOf = (itemKey: string, text: string, turn = 1) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:${text.length}`, occurredAt: 1_725_000_000_000, turnId: `turn-${turn}`,
  item: { type: 'assistant_message' as const, text, messageId: itemKey },
});
const append = (sequence: number, itemKey: string, text: string, turn = 1): JournalPublishEntry => ({ sequence, op: 'append', row: rowOf(itemKey, text, turn) });
const complete = (sequence: number, itemKey: string): JournalPublishEntry => ({ sequence, op: 'complete', itemKey, digest: `digest-${itemKey}` });
const snapshot = {
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle' as const, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' as const },
};
const head = (sequence: number): JournalPublishEntry => ({ sequence, op: 'head', head: { snapshot, observedAt: 5 } });

/** What a Durable Object does to every call: arguments and results cross as structured clones. */
function overRpc(api: JournalPartitionApi): JournalPartitionApi {
  const wrap = <A extends unknown[], R>(call: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => structuredClone(await call(...structuredClone(args)));
  return {
    open: wrap(api.open), indexPage: wrap(api.indexPage), publish: wrap(api.publish), fill: wrap(api.fill), page: wrap(api.page), status: wrap(api.status), unserveHead: wrap(api.unserveHead),
    servedSessions: wrap(api.servedSessions), deleteHost: wrap(api.deleteHost), capabilities: wrap(api.capabilities),
  };
}

/** One partition per Host, each over its own store, reached the way `primary` reaches a Durable Object. */
function cluster(options: Partial<Omit<HostJournalsOptions, 'store' | 'now'>> = {}) {
  const stores = new Map<string, MemoryJournalStore>();
  const partitions = new Map<string, JournalPartitionApi>();
  const calls: string[] = [];
  let held: Promise<void> | undefined;
  const build = (hostId: string, memory: MemoryJournalStore): JournalPartitionApi => {
    const store: JournalStore = { load: key => memory.load(key), apply: changes => memory.apply(changes), delete: key => memory.delete(key),
      catalog: { list: async prefix => { calls.push(`list:${hostId}`); return memory.catalog.list(prefix); }, deletePrefix: prefix => memory.catalog.deletePrefix(prefix) } };
    const inner = serveJournalPartition(createHostJournals({ store, now: () => 1_000, ...options }));
    return overRpc({
      ...inner,
      open: (...args) => { calls.push(`open:${hostId}`); return inner.open(...args); },
      // The answer is read first and held back after: the caller holds an answer that later changes make stale.
      servedSessions: async id => { calls.push(`served:${id}`); const sessions = await inner.servedSessions(id); await held; return sessions; },
    });
  };
  const partition = (hostId: string): JournalPartitionApi => {
    let api = partitions.get(hostId);
    if (!api) {
      const memory = new MemoryJournalStore();
      stores.set(hostId, memory);
      api = build(hostId, memory);
      partitions.set(hostId, api);
    }
    return api;
  };
  return {
    partition, stores, calls,
    /** Partitions that start again over the same stores, as Durable Objects do after they are evicted: their journal services know nothing yet. */
    restart: () => { const fresh = new Map<string, JournalPartitionApi>(); return (hostId: string) => { let api = fresh.get(hostId); if (!api) { api = build(hostId, stores.get(hostId) ?? new MemoryJournalStore()); fresh.set(hostId, api); } return api; }; },
    holdServed: () => { let release!: () => void; held = new Promise<void>(resolve => { release = resolve; }); return () => { held = undefined; release(); }; },
    journals: createPartitionJournals({ partition }),
  };
}

describe('the journals of primary over journal partitions', () => {
  it('opens, publishes and pages through the partition of each Host, keeping Hosts apart', async () => {
    const { journals, stores } = cluster();
    await journals.open(HOST, SESSION, 'controller-1', LIMITS);
    await journals.open('host-2', SESSION, 'controller-2', LIMITS);
    const published = await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello'), complete(2, 'm1')]);
    expect(published).toMatchObject({ watermark: 2, cursor: { seq: 1 }, hasHead: false, events: [{ kind: 'row' }] });
    const page = await journals.page(HOST, SESSION, { requestId: 'p', agentId: 'a', direction: 'tail', limit: 10 }, false);
    expect(page).toMatchObject({ kind: 'page', page: { payload: { entries: [expect.objectContaining({ item: expect.objectContaining({ text: 'Hello' }) })] } } });
    expect(await journals.page('host-2', SESSION, { requestId: 'p', agentId: 'a', direction: 'tail', limit: 10 }, false)).toMatchObject({ kind: 'page', page: { payload: { entries: [] } } });
    expect((await stores.get(HOST)!.catalog.list('')).map(({ sessionKey }) => sessionKey)).toEqual([`${HOST}:${SESSION}`]);
    expect((await stores.get('host-2')!.catalog.list('')).map(({ sessionKey }) => sessionKey)).toEqual([`host-2:${SESSION}`]);
    expect(await journals.status(HOST, SESSION)).toMatchObject({ cursor: { seq: 1 } });
  });

  it('opens with the first page of the index and reads the rest a page at a time', async () => {
    const { journals } = cluster();
    await journals.open(HOST, SESSION, 'controller-1', LIMITS);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), append(2, 'm2', 'b'), append(3, 'm3', 'c')]);
    const opened = await journals.open(HOST, SESSION, 'controller-1', { maxIndexItems: 10, pageItems: 2 }) as JournalOpened;
    expect(opened).toMatchObject({ generation: 2, more: true, index: [{ itemKey: 'm1' }, { itemKey: 'm2' }] });
    expect((await journals.indexPage(HOST, SESSION, opened.epoch, 2, 10))!.map(entry => entry.itemKey)).toEqual(['m3']);
    expect(await journals.indexPage(HOST, SESSION, 'another-epoch', 2, 10)).toBeUndefined();
    expect(await journals.open(HOST, SESSION, 'controller-1', { maxIndexItems: 2, pageItems: 2 })).toEqual({ refused: 'index_too_large' });
  });

  it('learns which sessions have a head from publication results and loads a Host once', async () => {
    const { journals, calls } = cluster();
    expect(journals.served(HOST, SESSION)).toBeUndefined();
    expect(await journals.servedSessions(HOST)).toEqual([]);
    await journals.open(HOST, SESSION, 'controller-1', LIMITS);
    expect((await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello'), head(2)])).hasHead).toBe(true);
    expect(journals.served(HOST, SESSION)).toBe(true);
    expect(journals.served(HOST, 'codex:other')).toBe(false);
    expect(calls.filter(call => call === `list:${HOST}`)).toHaveLength(1);
  });

  it('keeps a head published before the Host loaded, and answers undefined until it loads', async () => {
    const { journals } = cluster();
    await journals.open(HOST, SESSION, 'controller-1', LIMITS);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello'), head(2)]);
    expect(journals.served(HOST, SESSION)).toBeUndefined();
    expect(await journals.servedSessions(HOST)).toEqual([SESSION]);
    expect(journals.served(HOST, SESSION)).toBe(true);
  });

  it('shares one load among concurrent callers, and loads the heads from the partition after primary starts again', async () => {
    const first = cluster();
    await first.journals.open(HOST, SESSION, 'controller-1', LIMITS);
    await first.journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello'), head(2)]);
    first.calls.length = 0;
    const restarted = createPartitionJournals({ partition: first.restart() });
    expect(restarted.served(HOST, SESSION)).toBeUndefined();
    const loads = await Promise.all([restarted.servedSessions(HOST), restarted.servedSessions(HOST), restarted.servedSessions(HOST)]);
    expect(loads).toEqual([[SESSION], [SESSION], [SESSION]]);
    expect(restarted.served(HOST, SESSION)).toBe(true);
    expect(first.calls.filter(call => call === `list:${HOST}`)).toHaveLength(1);
    expect(first.calls.filter(call => call === `served:${HOST}`)).toHaveLength(1);
    await restarted.loadAllServed();
  });

  it('discards an answer that a deletion overtook', async () => {
    const first = cluster();
    await first.journals.open(HOST, SESSION, 'controller-1', LIMITS);
    await first.journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello'), head(2)]);
    const reader = createPartitionJournals({ partition: first.partition });
    const release = first.holdServed();
    const loading = reader.servedSessions(HOST);
    await new Promise(resolve => setTimeout(resolve, 5));
    await reader.deleteHost(HOST);
    release();
    expect(await loading).toEqual([]);
    expect(reader.served(HOST, SESSION)).toBe(false);
  });

  it('discards an answer that a head change overtook, so a session whose head a quota cleared is not served again', async () => {
    const first = cluster({ limits: { sessionItems: 1 } });
    await first.journals.open(HOST, SESSION, 'controller-1', LIMITS);
    await first.journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello'), head(2)]);
    const reader = createPartitionJournals({ partition: first.partition });
    const release = first.holdServed();
    const loading = reader.servedSessions(HOST);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect((await reader.publish(HOST, SESSION, 1, [append(3, 'm2', 'World')])).unserved).toBe(true);
    release();
    expect(await loading).toEqual([]);
    expect(reader.served(HOST, SESSION)).toBe(false);
  });

  it('forgets a session a stream found without a head, until a publication gives it one', async () => {
    const { journals } = cluster();
    await journals.servedSessions(HOST);
    await journals.open(HOST, SESSION, 'controller-1', LIMITS);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello'), head(2)]);
    expect(journals.served(HOST, SESSION)).toBe(true);
    journals.unserve(HOST, SESSION);
    expect(journals.served(HOST, SESSION)).toBe(false);
    await journals.publish(HOST, SESSION, 1, [head(3)]);
    expect(journals.served(HOST, SESSION)).toBe(true);
  });

  it('does not call the partition for an open whose connection ended', async () => {
    const { journals, calls, stores } = cluster();
    expect(await journals.open(HOST, SESSION, 'controller-1', { ...LIMITS, allowed: () => false })).toEqual({ refused: 'unavailable' });
    expect(calls).toEqual([]);
    expect(stores.size).toBe(0);
  });

  it('orders a deletion against publications: earlier ones apply, later ones are refused and the head index forgets', async () => {
    const { journals, stores } = cluster();
    await journals.open(HOST, SESSION, 'controller-1', LIMITS);
    const before = journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello'), head(2)]);
    const deleted = journals.deleteHost(HOST);
    const after = journals.publish(HOST, SESSION, 1, [append(3, 'm2', 'World')]);
    expect((await before).hasHead).toBe(true);
    await deleted;
    expect((await after).refusal).toEqual({ sequence: 3, reason: 'fenced' });
    expect(journals.served(HOST, SESSION)).toBe(false);
    expect(await stores.get(HOST)!.catalog.list('')).toEqual([]);
  });

  it('stops serving a session whose head a quota cleared, and serves it again when a rebuild publishes a head', async () => {
    const { journals } = cluster({ limits: { sessionItems: 2 } });
    await journals.servedSessions(HOST);
    await journals.open(HOST, SESSION, 'controller-1', LIMITS);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), complete(2, 'm1'), append(3, 'm2', 'b'), complete(4, 'm2'), head(5)]);
    expect(journals.served(HOST, SESSION)).toBe(true);
    const refused = await journals.publish(HOST, SESSION, 1, [append(6, 'm3', 'c')]);
    expect(refused).toMatchObject({ unserved: true, hasHead: false });
    expect(journals.served(HOST, SESSION)).toBe(false);
    // The journal is missing a row until a replacement under a new generation rebuilds it.
    const reopened = await journals.open(HOST, SESSION, 'controller-1', LIMITS) as JournalOpened;
    await journals.publish(HOST, SESSION, reopened.generation, [{ sequence: 6, op: 'replace', items: [{ row: rowOf('r1', 'Fresh'), digest: 'digest-r1' }] }, head(7)]);
    expect(journals.served(HOST, SESSION)).toBe(true);
  });

  it('takes the session out of serving when an open is refused over the index bound after clearing its head', async () => {
    const { journals } = cluster();
    await journals.servedSessions(HOST);
    await journals.open(HOST, SESSION, 'controller-1', LIMITS);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), append(2, 'm2', 'b'), head(3)]);
    expect(journals.served(HOST, SESSION)).toBe(true);
    expect(await journals.open(HOST, SESSION, 'controller-1', { maxIndexItems: 1, pageItems: 1 })).toEqual({ refused: 'index_too_large', unserved: true });
    expect(journals.served(HOST, SESSION)).toBe(false);
  });

  it('takes the session out of serving at the Controller\'s word and when a reset open clears its head', async () => {
    const { journals } = cluster();
    await journals.servedSessions(HOST);
    await journals.open(HOST, SESSION, 'controller-1', LIMITS);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)]);
    expect(journals.served(HOST, SESSION)).toBe(true);
    expect(await journals.unserveHead(HOST, SESSION, 7)).toBeUndefined();
    expect(journals.served(HOST, SESSION)).toBe(true);
    expect(await journals.unserveHead(HOST, SESSION, 1)).toMatchObject({ unserved: true, hasHead: false });
    expect(journals.served(HOST, SESSION)).toBe(false);
    await journals.publish(HOST, SESSION, 1, [head(3)]);
    expect(journals.served(HOST, SESSION)).toBe(true);
    const reset = await journals.open(HOST, SESSION, 'controller-1', { ...LIMITS, reset: true }) as JournalOpened;
    expect(reset).toMatchObject({ generation: 2, index: [], more: false, unserved: true });
    expect(journals.served(HOST, SESSION)).toBe(false);
  });

  it('fills bodies and reads the page in one step, asking olderBeyondJournal in the Host queue and sending only plain data', async () => {
    const { journals } = cluster({ retention: { turns: 1, minItems: 1 } });
    await journals.open(HOST, SESSION, 'controller-1', LIMITS);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'first', 1), complete(2, 'm1'), append(3, 'm2', 'second', 2), complete(4, 'm2')]);
    const request = { requestId: 'p', agentId: 'a', direction: 'tail' as const, limit: 10 };
    expect(await journals.page(HOST, SESSION, request, false)).toEqual({ kind: 'missing', itemKeys: ['m1'] });
    let olderBeyondJournal = false;
    const filling = journals.fill(HOST, SESSION, [{ row: rowOf('m1', 'first', 1), digest: 'digest-m1' }], { request, olderBeyondJournal: () => olderBeyondJournal });
    olderBeyondJournal = true;
    const filled = await filling;
    expect(filled).toMatchObject({ filled: ['m1'], page: { kind: 'page', page: { payload: { entries: [{ item: { text: 'first' } }, { item: { text: 'second' } }], hasOlder: true } } } });
    expect(await journals.fill(HOST, 'codex:none', [], { request, olderBeyondJournal: () => false })).toEqual({ filled: [], mismatched: [], unknown: [] });
    expect(await journals.fill(HOST, SESSION, [])).not.toHaveProperty('page');
  });

  it('runs a fill after the publications made before it', async () => {
    const { journals } = cluster({ retention: { turns: 1, minItems: 1 } });
    await journals.open(HOST, SESSION, 'controller-1', LIMITS);
    const request = { requestId: 'p', agentId: 'a', direction: 'tail' as const, limit: 10 };
    void journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'first', 1), complete(2, 'm1')]);
    const filled = await journals.fill(HOST, SESSION, [{ row: rowOf('m1', 'first', 1), digest: 'digest-m1' }], { request, olderBeyondJournal: () => false });
    expect(filled.page).toMatchObject({ kind: 'page', page: { payload: { entries: [{ item: { text: 'first' } }] } } });
  });

  it('refuses a publication queued behind one that failed with a partition reset, instead of applying it with a gap', async () => {
    const memory = new MemoryJournalStore();
    const fresh = () => serveJournalPartition(createHostJournals({ store: memory, now: () => 1_000 }));
    let current = fresh();
    let failNext = true;
    const journals = createPartitionJournals({ partition: () => overRpc({ ...current, publish: async (...args) => {
      if (failNext) { failNext = false; current = fresh(); throw new Error('The Durable Object was reset.'); }
      return current.publish(...args);
    } }) });
    await journals.open(HOST, SESSION, 'controller-1', LIMITS);
    const first = journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'one'), append(2, 'm2', 'two')]);
    const second = journals.publish(HOST, SESSION, 1, [append(3, 'm3', 'three')]);
    await expect(first).rejects.toThrow('reset');
    expect((await second).refusal).toEqual({ sequence: 3, reason: 'sequence_gap' });
    expect((await memory.catalog.list('')).length).toBe(1);
    expect(await journals.status(HOST, SESSION)).toMatchObject({ cursor: { seq: 0 } });
    const reopened = await journals.open(HOST, SESSION, 'controller-1', LIMITS) as JournalOpened;
    expect(reopened.watermark).toBe(0);
    expect((await journals.publish(HOST, SESSION, reopened.generation, [append(1, 'm1', 'one'), append(2, 'm2', 'two'), append(3, 'm3', 'three')])).refusal).toBeUndefined();
  });

  it('answers a read after the publications made before it', async () => {
    const { journals } = cluster();
    await journals.open(HOST, SESSION, 'controller-1', LIMITS);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm2', 'now', 2), complete(2, 'm2')]);
    const request = { requestId: 'p', agentId: 'a', direction: 'tail' as const, limit: 10 };
    const older = journals.publish(HOST, SESSION, 1, [{ sequence: 3, op: 'prepend', items: [{ row: rowOf('m1', 'before', 1), digest: 'digest-m1' }] }]);
    const page = await journals.page(HOST, SESSION, request, false);
    const status = journals.status(HOST, SESSION);
    const index = journals.indexPage(HOST, SESSION, (await journals.open(HOST, SESSION, 'controller-1', LIMITS) as JournalOpened).epoch, -100, 10);
    await older;
    expect(page).toMatchObject({ kind: 'page', page: { payload: { entries: [{ item: { text: 'before' } }, { item: { text: 'now' } }], hasOlder: false } } });
    expect(await status).toMatchObject({ cursor: { seq: 1 } });
    expect((await index)!.map(entry => entry.itemKey)).toEqual(['m1', 'm2']);
  });

  it('lets a head load complete between back-to-back publications', async () => {
    const first = cluster();
    await first.journals.open(HOST, SESSION, 'controller-1', LIMITS);
    const writer = createPartitionJournals({ partition: first.partition });
    await writer.open(HOST, SESSION, 'controller-1', LIMITS);
    const release = first.holdServed();
    const loading = writer.servedSessions(HOST);
    await new Promise(resolve => setTimeout(resolve, 5));
    for (let sequence = 1; sequence <= 5; sequence++) await writer.publish(HOST, SESSION, 2, [append(sequence, `m${sequence}`, 'x', sequence)]);
    release();
    await loading;
    expect(first.calls.filter(call => call === `served:${HOST}`)).toHaveLength(1);
    expect(writer.served(HOST, SESSION)).toBe(false);
  });

  it('deletes at most four Hosts at once across partitions, and later deletions wait for a slot', async () => {
    let running = 0, peak = 0, started = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const partitions = new Map<string, JournalPartitionApi>();
    const journals = createPartitionJournals({ partition: hostId => {
      let api = partitions.get(hostId);
      if (!api) {
        const inner = serveJournalPartition(createHostJournals({ store: new MemoryJournalStore(), now: () => 1_000 }));
        api = { ...inner, deleteHost: async id => { started++; running++; peak = Math.max(peak, running); await gate; await inner.deleteHost(id); running--; } };
        partitions.set(hostId, api);
      }
      return api;
    } });
    const deletions = Array.from({ length: 7 }, (_, n) => journals.deleteHost(`host-${n}`));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect({ started, running }).toEqual({ started: 4, running: 4 });
    release();
    await Promise.all(deletions);
    expect({ started, peak, running }).toEqual({ started: 7, peak: 4, running: 0 });
  }, DEADLINE_MS);
});

describe('the partition contract across a rollout', () => {
  type Step = { method: keyof JournalPartitionApi; args: unknown[]; reply: unknown };
  const steps = recorded as Step[];
  const masked = (value: unknown, epoch: string) => JSON.parse(JSON.stringify(value ?? null).replaceAll(epoch || '\u0000', '<epoch>').replace(/"protocolVersion":"[^"]*"/g, '"protocolVersion":"<version>"'));

  it('answers every recorded call with the recorded reply shape, so a change to an argument or a result fails here', async () => {
    const api = overRpc(serveJournalPartition(createHostJournals({ store: new MemoryJournalStore(), now: () => 1_000 })));
    const methods = new Set(steps.map(step => step.method));
    expect([...methods].sort()).toEqual(['capabilities', 'deleteHost', 'fill', 'indexPage', 'open', 'page', 'publish', 'servedSessions', 'status', 'unserveHead']);
    let epoch = '';
    for (const step of steps) {
      const args = step.args.map(arg => (arg === '<epoch>' ? epoch : arg === null ? undefined : arg));
      const reply = await (api[step.method] as (...call: unknown[]) => Promise<unknown>)(...args);
      if (step.method === 'open') epoch = (reply as { epoch: string }).epoch;
      expect(masked(reply, epoch), `${step.method} ${JSON.stringify(step.args).slice(0, 80)}`).toEqual(masked(step.reply, '<epoch>'));
    }
  });

  it('covers every method of the contract', () => {
    const api = serveJournalPartition(createHostJournals({ store: new MemoryJournalStore(), now: () => 1 }));
    expect(Object.keys(api).sort()).toEqual([...new Set(steps.map(step => step.method))].sort());
  });

  it('reads the capabilities of a partition once, and counts a partition without the method as version 1', async () => {
    let asked = 0;
    const fresh = serveJournalPartition(createHostJournals({ store: new MemoryJournalStore(), now: () => 1 }));
    const current = createPartitionJournals({ partition: () => ({ ...fresh, capabilities: async host => { asked++; return fresh.capabilities(host); } }) });
    expect(await current.capabilities(HOST)).toEqual({ journal: 2 });
    expect(await current.capabilities(HOST)).toEqual({ journal: 2 });
    expect(asked).toBe(1);

    let clock = 0, failures = 0;
    const { capabilities: _missing, ...older } = fresh;
    const previous = createPartitionJournals({ now: () => clock, partition: () => ({ ...older, capabilities: async () => { failures++; throw new TypeError('The RPC receiver does not implement the method "capabilities".'); } }) });
    expect(await previous.capabilities(HOST)).toEqual({ journal: 1 });
    expect(await previous.capabilities(HOST)).toEqual({ journal: 1 });
    expect(failures).toBe(1);
    clock = 31_000;
    expect(await previous.capabilities(HOST)).toEqual({ journal: 1 });
    expect(failures).toBe(2);
  });

  it('throws a failure that is not a missing method, and asks again instead of remembering version 1', async () => {
    const fresh = serveJournalPartition(createHostJournals({ store: new MemoryJournalStore(), now: () => 1 }));
    let broken = true;
    const journals = createPartitionJournals({ partition: () => ({ ...fresh, capabilities: async host => { if (broken) throw new Error('The Durable Object is overloaded.'); return fresh.capabilities(host); } }) });
    await expect(journals.capabilities(HOST)).rejects.toThrow('overloaded');
    const otherMethod = createPartitionJournals({ partition: () => ({ ...fresh, capabilities: async () => { throw new TypeError('The RPC receiver does not implement the method "open".'); } }) });
    await expect(otherMethod.capabilities(HOST)).rejects.toThrow('"open"');
    broken = false;
    expect(await journals.capabilities(HOST)).toEqual({ journal: 2 });
  });
});

describe('estimateCloneBytes', () => {
  it('covers what V8 serializes for strings, numbers and nesting, and counts a string at two bytes per character', () => {
    const page = { kind: 'page', entries: [{ text: 'x'.repeat(1000), n: 1, ok: true, none: null }, { text: 'é'.repeat(500) }] };
    expect(serialize(page).length).toBeLessThanOrEqual(estimateCloneBytes(page));
    expect(estimateCloneBytes('x'.repeat(1000))).toBeGreaterThanOrEqual(2000);
    expect(estimateCloneBytes('x'.repeat(1000))).toBeLessThan(2100);
    expect(estimateCloneBytes(['a'.repeat(100), 'b'.repeat(100)])).toBeGreaterThanOrEqual(estimateCloneBytes('a'.repeat(100)) + estimateCloneBytes('b'.repeat(100)));
    expect(estimateCloneBytes({ key: 'v'.repeat(10) })).toBeGreaterThan(estimateCloneBytes('v'.repeat(10)) + estimateCloneBytes('key'));
  });
});

describe('serveJournalPartition', () => {
  const publishSix = (api: JournalPartitionApi) => api.publish(HOST, SESSION, 1,
    Array.from({ length: 6 }, (_, n) => [append(n * 2 + 1, `m${n}`, 'x'.repeat(2000), n), complete(n * 2 + 2, `m${n}`)]).flat());
  const tail = { requestId: 'p', agentId: 'a', direction: 'tail' as const, limit: 6 };
  const entriesOf = (result: Awaited<ReturnType<JournalPartitionApi['page']>>) => (result as { kind: 'page'; page: { payload: { entries: unknown[] } } }).page.payload.entries;

  it('answers a page whose estimated clone size would pass the bound with fewer entries', async () => {
    const journals = createHostJournals({ store: new MemoryJournalStore(), now: () => 1_000 });
    const bounded = serveJournalPartition(journals, { replyMaxBytes: 5000 });
    await bounded.open(HOST, SESSION, 'controller-1', LIMITS);
    await publishSix(bounded);
    const small = entriesOf(await bounded.page(HOST, SESSION, tail, false));
    expect(small.length).toBeGreaterThan(0);
    expect(small.length).toBeLessThan(6);
    expect(entriesOf(await serveJournalPartition(journals).page(HOST, SESSION, tail, false))).toHaveLength(6);
  });

  it('answers a page with every entry when its estimate fits the bound exactly, and with fewer when it is one byte over', async () => {
    const journals = createHostJournals({ store: new MemoryJournalStore(), now: () => 1_000 });
    const open = serveJournalPartition(journals);
    await open.open(HOST, SESSION, 'controller-1', LIMITS);
    await publishSix(open);
    const full = await open.page(HOST, SESSION, tail, false);
    const size = estimateCloneBytes(full);
    expect(entriesOf(await serveJournalPartition(journals, { replyMaxBytes: size }).page(HOST, SESSION, tail, false))).toHaveLength(6);
    expect(entriesOf(await serveJournalPartition(journals, { replyMaxBytes: size - 1 }).page(HOST, SESSION, tail, false))).toHaveLength(3);
  });

  it('answers a fill whose page would pass the bound with a page of fewer entries, keeping what was filled', async () => {
    const journals = createHostJournals({ store: new MemoryJournalStore(), now: () => 1_000, retention: { turns: 1, minItems: 1 } });
    const bounded = serveJournalPartition(journals, { replyMaxBytes: 5000 });
    await bounded.open(HOST, SESSION, 'controller-1', LIMITS);
    await publishSix(bounded);
    const missing = await bounded.page(HOST, SESSION, tail, false);
    const itemKeys = (missing as { itemKeys: string[] }).itemKeys;
    expect(itemKeys.length).toBeGreaterThan(0);
    const filled = await bounded.fill(HOST, SESSION, itemKeys.map(key => ({ row: rowOf(key, 'x'.repeat(2000), Number(key.slice(1))), digest: `digest-${key}` })), { request: tail, olderBeyondJournal: false });
    expect(filled.filled).toEqual(itemKeys);
    const size = entriesOf(filled.page).length;
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(6);
  });

  it('returns no page for a session without a journal', async () => {
    const api = serveJournalPartition(createHostJournals({ store: new MemoryJournalStore(), now: () => 1_000 }), { replyMaxBytes: 1 });
    expect(await api.page(HOST, SESSION, tail, false)).toBeUndefined();
  });
});

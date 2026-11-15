# P1-B3b Cloudflare journal partition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Cloudflare, keep Host journals out of the `primary` Durable Object. One new Durable Object class, `JournalPartition`, holds the journals of one Host in its own SQLite storage and runs the existing journal service there; `primary` keeps every socket and the fan-out and reaches the partition through Durable Object RPC. Nothing changes for a deployment that does not turn journals on.

**Architecture:** `agent-remote-hosted` gains the partition contract: `JournalPartitionApi` (plain-data RPC methods), `serveJournalPartition` (adapts a `HostJournals` service to that contract and bounds reply sizes), and `createPartitionJournals` (a `HostJournals` implementation for `primary` that forwards each call to the Host's partition, keeps the head index current from publication results, and orders opens, publications and deletions per Host). `agent-remote-cloudflare` gains the Durable Object class over `SqlJournalStore` (from P1-B3a) bound to `ctx.storage.sql`, the wiring in `RelayObject`, and the wrangler binding and migration. This is step 1 of the design's "Moving the Relay to partitions".

**Tech Stack:** TypeScript 5.7, Cloudflare Workers Durable Objects with SQLite and RPC (`cloudflare:workers`, `compatibility_date` 2026-06-01), Miniflare 4 for real Worker tests, Vitest 4.1.11.

**Design reference:** `docs/superpowers/specs/2026-11-15-im-session-service-design.md`, sections Architecture (Deployment and middleware, Moving the Relay to partitions) and Session journal (Durability and fan-out). Predecessor: `2026-11-15-p1b3a-journal-storage.md`, which must have landed completely (`SqlJournalStore` and `JournalSqlDatabase` in `@orchardworks/agent-remote-journal-sqlite`, the extended `HostJournals` interface with `indexPage`, `servedSessions`, `loadAllServed`, `deleteHost` and the `open` options, the gateway option `journalService`, the broker's switch, gate, stopping of streams and durable `journalDeletions`).

**Commands.** Every test command sets a per-test deadline (`--testTimeout`). Run each with an outer deadline: the Bash tool `timeout` of at most 300000 ms (the Cloudflare suite and `pnpm local up` take up to 600000). Hosted tests import the protocol, journal and store packages from `dist`; the Cloudflare tests bundle the hosted package from source. Rebuild a package before running tests of its dependents. All work happens in the worktree `/Users/xian/projects/agent-remote-control/.worktrees/im-session-service`.

## Decisions made in this plan

These are not stated in the design or the brief.

1. **One class, one object per Host.** `JournalPartition extends DurableObject`, addressed with `env.JOURNALS.getByName(hostId)` (the name-derived id, `idFromName(hostId)`). Host ids are UUIDs the Relay generates, so Hosts of different accounts never share an object. The class has no `fetch` and lives in a Worker script of its own (`src/journal-worker.ts`, answering 404 to every request), reached from the Relay Worker by a `script_name` binding, so partitions never share an isolate with `primary` and a busy partition cannot reset its sockets; only `primary` can call it; the partition does no authorization of its own (reads and submissions stay authorized in `primary` until P4 moves sockets).
2. **The partition runs the unchanged service.** `createHostJournals` over `SqlJournalStore` over `durableObjectJournalDatabase(ctx.storage)`. Stamping, storing, the item index, the publish-time retention rule, quotas, the quota-refusal handling and deletion are the P1-B3a code; the partition adds only bounds suited to a Durable Object.
3. **Plain data over RPC, no functions.** `JournalPartitionApi` takes and returns structured-clonable data. `open`'s `allowed` callback stays in `primary`: the proxy checks it inside its per-Host queue, before the call, and orders it against deletions there. A fill's `read.olderBeyondJournal` is a function in the service; the proxy asks it inside the same queue and sends the answer as a boolean. The fill's page comes back in the reply, and a reply over the bound is read again with a halved limit by a fill of no items, so the filled bodies stay. `page`, `status`, `indexPage`, `fill`, `open`, `publish` and `deleteHost` run in the proxy's per-Host queue, so a read never overtakes a publication queued before it; `servedSessions` stays outside it.
4. **Durable Object limits.**
   - *Memory (128 MB per isolate):* the partition keeps only the journal in use: a cache of 2 journals bounded to 20 MiB of estimated size, and one session may hold 12 MiB of UTF-8, so that one entry serialized at two bytes per character (24 MiB) stays under the 32 MiB RPC limit; an entry larger than the room is refused before anything is evicted. The estimate counts UTF-8 bytes; heap use is up to twice that, plus transient buffers while a journal loads. Per Host the quota stays 1 GiB of the object's SQLite storage.
   - *Value size:* every stored value is split into 256 KiB chunks by `SqlJournalStore` (far below the Durable Object limit on one SQLite value).
   - *RPC payload (32 MiB per message):* a publication is at most 8 MiB (`JOURNAL_MESSAGE_MAX_BYTES`) and a fill at most 8 MiB. A page or fill reply is measured by `estimateCloneBytes`, a walk over the reply that counts every string at two bytes per character (an upper bound of the V8 clone) and copies nothing, and is answered again with half the limit until it fits 24 MiB. The index in an `open` reply is its first page of at most 2,000 entries (about 18.3 MiB at the longest keys when they hold two-byte characters); the Controller pulls the rest with `indexPage`, one page per call.
5. **`primary` keeps the head index.** `createPartitionJournals` holds a `JournalHeadIndex` per Relay start. A Host's sessions are loaded with one `servedSessions` RPC when the first browser stream for the Host needs the answer (P1-B3a: shared by concurrent opens, outside the Host's queue, the gate waits at most 2 s) and kept current from the `hasHead` of each publication result and from deletions. The Host's epoch in the proxy rises only when the index loses a session (an unserve, an open or publication that cleared a head, a failed publication) and when a deletion starts and ends; adding a head only adds to what a load reads, so back-to-back publications cannot starve a load. A load read across a loss is discarded and read again; a stream that finds no head calls `unserve`. After `primary` restarts the index starts empty and loads again.
6. **Off by default.** The proxy exists only when the Worker has the `JOURNALS` binding and the variable `AGENT_REMOTE_JOURNALS` is `1`. No repository configuration sets the variable, so production and every existing deployment keep granting no journals until the Controller publisher (P1-C) lands. The binding and the migration `v2` ship in all three wrangler configurations; a deployment that has not copied them stays off.
7. **Retention is the publish-time rule.** The partition evicts bodies outside the latest 50 turns after each publication, as the service does everywhere. It has no sweep and no alarm; use-based windows are P3.
8. **Deleting a Host empties its object's tables** (`deletePrefix`). The object stays with its empty schema; a Durable Object cannot be destroyed from the Worker, and `storage.deleteAll()` would remove the schema under a running store. A revoke records the deletion in `journalDeletions` (P1-B3a) and the broker retries it until the partition confirms.
9. **The deletion cap stays 4 per Relay.** Each partition runs one Host, so its own semaphore never limits anything. The proxy in `primary` holds the semaphore (`HOST_DELETIONS_AT_ONCE`, exported by `host-journals.ts`) around each `deleteHost`, outside the Host's queue as the service does, so the broker's four-worker pool and any other caller together start at most four partition deletions at once.
10. **A publication must continue the watermark.** The journal core refuses a non-duplicate publication whose sequence is not `watermark + 1` with `JournalSequenceGapError` (the service answers it with its own refusal reason `sequence_gap`, which a publisher must never skip, and the publisher must open the journal again). The sequence is checked before quota admission, so a gap that is also over quota is a gap, and a gap never fences the generation or marks the journal incomplete. A failed entry never advances the watermark, so every later entry of that generation is a gap, also after a partition reset: the watermark is stored. This is why a publication pipelined behind a failed one cannot be applied with a gap. A publisher that skips a refused entry must still consume its sequence number (P1-C).
11. **`primary`'s state is untouched.** No journal data enters `RelayObject`'s storage, so its 16 MiB bound and its full-state validation are unaffected. A test asserts that `primary` has no `journal` tables.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/agent-remote-hosted/src/journal-partition.ts` | New: `JournalPartitionApi`, the partition bounds, `serveJournalPartition`, `createPartitionJournals`. |
| `packages/agent-remote-hosted/src/journal-partition.test.ts` | New: tests with in-process partitions behind structured-clone "RPC". |
| `packages/agent-remote-journal/src/types.ts`, `session-journal.ts` | Modify: `JournalSequenceGapError` and the rule that a publication continues the watermark. |
| `packages/agent-remote-hosted/src/host-journals.ts` | Modify: export `HOST_DELETIONS_AT_ONCE`; answer a sequence gap with `invalid`. |
| `packages/agent-remote-hosted/src/index.ts` | Modify: exports. |
| `packages/agent-remote-cloudflare/src/journal-sql-database.ts` | New: `durableObjectJournalDatabase`, the Durable Object binding of the store's SQL port. |
| `packages/agent-remote-cloudflare/src/journal-partition.ts` | New: the `JournalPartition` Durable Object class. |
| `packages/agent-remote-cloudflare/src/journal-worker.ts` | New: the Worker script that holds the partitions. |
| `packages/agent-remote-cloudflare/src/relay-object.ts` | Modify: environment and the proxy. |
| `packages/agent-remote-cloudflare/package.json`, `pnpm-lock.yaml` | Modify: dependency on the store package. |
| `packages/agent-remote-cloudflare/test/fixture.ts` | Modify: the partition binding, test class and routes. |
| `packages/agent-remote-cloudflare/test/journal-partition.test.ts` | New: Miniflare tests of the object and of `primary` with journals on. |
| `packages/agent-remote-cloudflare/wrangler.jsonc`, `deploy/self-hosted/wrangler.jsonc`, `scripts/relay-workers-local.mjs` | Modify: binding and migration `v2`. |
| `docs/self-hosted-deployment.md` | Modify: the Workers settings of the journal section. |

---

### Task 1: The partition contract, its server side and its proxy

**Files:**
- Modify: `packages/agent-remote-journal/src/types.ts`, `session-journal.ts`, `journal.test-fixture.ts`, `session-journal.test.ts`, `journal-carry.test.ts` (the sequence rule)
- Modify: `packages/agent-remote-hosted/src/host-journals.ts` (export `HOST_DELETIONS_AT_ONCE`; map the gap)
- Create: `packages/agent-remote-hosted/src/journal-partition.ts`
- Create: `packages/agent-remote-hosted/src/journal-partition.test.ts`
- Modify: `packages/agent-remote-hosted/src/index.ts`

- [x] **Step 1: Write the failing tests.** `packages/agent-remote-hosted/src/journal-partition.test.ts`:

```ts
import { MemoryJournalStore, type JournalStore } from '@orchardworks/agent-remote-journal';
import type { JournalPublishEntry } from '@orchardworks/agent-remote-protocol';
import { serialize } from 'node:v8';

import { describe, expect, it } from 'vitest';

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
    open: wrap(api.open), indexPage: wrap(api.indexPage), publish: wrap(api.publish), fill: wrap(api.fill), page: wrap(api.page), status: wrap(api.status),
    servedSessions: wrap(api.servedSessions), deleteHost: wrap(api.deleteHost),
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
    expect((await second).refusal).toEqual({ sequence: 3, reason: 'invalid' });
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
```

- [x] **Step 2: Run the tests and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/journal-partition.test.ts --testTimeout=10000`
Expected: FAIL (`./journal-partition.js` does not exist).

- [x] **Step 3: Implement.** `packages/agent-remote-hosted/src/journal-partition.ts`:

```ts
import type { JournalIndexEntry, JournalPageRequest, JournalPageResult } from '@orchardworks/agent-remote-journal';
import type { CompleteItemInput, JournalPublishEntry } from '@orchardworks/agent-remote-protocol';

import { HOST_DELETIONS_AT_ONCE, type HostJournals, type JournalFilled, type JournalOpened, type JournalOpenRefusal, type JournalPublished, type JournalStatus } from './host-journals.js';
import { JournalHeadIndex } from './journal-head-index.js';

/** What a journal partition keeps in memory: a Durable Object has 128 MB, so only the journal in use stays. */
export const JOURNAL_PARTITION_CACHE = { maxJournals: 2, maxBytes: 20 * 1024 * 1024 } as const;
/** The growth limits of a partition; the per-Host quota is the one of the object's SQLite storage. */
export const JOURNAL_PARTITION_LIMITS = { sessionBytes: 12 * 1024 * 1024, hostBytes: 1024 * 1024 * 1024 } as const;
/** A reply whose estimated clone size passes this is answered again with fewer entries: a Workers RPC message may not exceed 32 MiB. A session holds at most 12 MiB of UTF-8, so one entry at two bytes per character stays well below the message limit. */
const REPLY_MAX_BYTES = 24 * 1024 * 1024;

/** A page read in the same step as a fill. Whether the Host may hold older history is known to `primary`, so it crosses as a value. */
export interface JournalPartitionRead {
  request: JournalPageRequest;
  olderBeyondJournal: boolean;
}

/**
 * What `primary` asks of the partition of one Host. Every argument and result is plain data that crosses Durable
 * Object RPC by structured clone; nothing here is a function. The partition runs the journal service of that one Host.
 */
export interface JournalPartitionApi {
  open(hostId: string, sessionKey: string, publisherId: string, options: { maxIndexItems: number; pageItems: number }): Promise<JournalOpened | JournalOpenRefusal>;
  indexPage(hostId: string, sessionKey: string, epoch: string, after: number, maxItems: number): Promise<JournalIndexEntry[] | undefined>;
  publish(hostId: string, sessionKey: string, generation: number, entries: JournalPublishEntry[]): Promise<JournalPublished>;
  /** Fills bodies. With `read`, the page comes back in the same reply and was read in the same step as the fill. */
  fill(hostId: string, sessionKey: string, items: CompleteItemInput[], read?: JournalPartitionRead): Promise<JournalFilled>;
  page(hostId: string, sessionKey: string, request: JournalPageRequest, olderBeyondJournal: boolean): Promise<JournalPageResult | undefined>;
  status(hostId: string, sessionKey: string): Promise<JournalStatus | undefined>;
  /** The Host's sessions that have a head. */
  servedSessions(hostId: string): Promise<string[]>;
  deleteHost(hostId: string): Promise<void>;
}

/**
 * An upper estimate of the size of a value as V8 clones it, counted without copying it: a string takes two bytes per
 * character (its size as UTF-16, the most a clone can take), a number eight, and each value and key a few bytes of tag and length.
 */
export function estimateCloneBytes(value: unknown): number {
  switch (typeof value) {
    case 'string': return 8 + value.length * 2;
    case 'number': case 'bigint': return 9;
    case 'boolean': return 2;
    case 'object': {
      if (value === null) return 1;
      let bytes = 8;
      if (Array.isArray(value)) { for (const entry of value) bytes += estimateCloneBytes(entry); return bytes; }
      for (const [key, entry] of Object.entries(value)) bytes += estimateCloneBytes(key) + estimateCloneBytes(entry);
      return bytes;
    }
    default: return 1;
  }
}

/** The partition side: adapts a journal service to the contract and keeps its replies within the RPC bound. */
export function serveJournalPartition(journals: HostJournals, options: { replyMaxBytes?: number } = {}): JournalPartitionApi {
  const replyMaxBytes = options.replyMaxBytes ?? REPLY_MAX_BYTES;
  return {
    open: (hostId, sessionKey, publisherId, bounds) => journals.open(hostId, sessionKey, publisherId, bounds),
    indexPage: (hostId, sessionKey, epoch, after, maxItems) => journals.indexPage(hostId, sessionKey, epoch, after, maxItems),
    publish: (hostId, sessionKey, generation, entries) => journals.publish(hostId, sessionKey, generation, entries),
    async fill(hostId, sessionKey, items, read) {
      if (!read) return journals.fill(hostId, sessionKey, items);
      const olderBeyondJournal = () => read.olderBeyondJournal;
      let filled = await journals.fill(hostId, sessionKey, items, { request: read.request, olderBeyondJournal });
      let limit = read.request.limit;
      // The bodies are filled once. A page that is too large is read again with fewer entries, in a step of its own;
      // bodies that were filled stay resident until a publication moves the retained window past them.
      while (filled.page?.kind === 'page' && limit > 1 && estimateCloneBytes(filled) > replyMaxBytes) {
        limit = Math.max(1, Math.floor(limit / 2));
        const { page } = await journals.fill(hostId, sessionKey, [], { request: { ...read.request, limit }, olderBeyondJournal });
        const { page: _discarded, ...rest } = filled;
        filled = page ? { ...rest, page } : rest;
      }
      return filled;
    },
    async page(hostId, sessionKey, request, olderBeyondJournal) {
      let limit = request.limit;
      for (;;) {
        const result = await journals.page(hostId, sessionKey, { ...request, limit }, olderBeyondJournal);
        if (!result || result.kind !== 'page' || limit === 1 || estimateCloneBytes(result) <= replyMaxBytes) return result;
        limit = Math.max(1, Math.floor(limit / 2));
      }
    },
    status: (hostId, sessionKey) => journals.status(hostId, sessionKey),
    servedSessions: hostId => journals.servedSessions(hostId),
    deleteHost: hostId => journals.deleteHost(hostId),
  };
}

export interface PartitionJournalsOptions {
  /** The partition of a Host: a Durable Object stub. */
  partition(hostId: string): JournalPartitionApi;
}

/**
 * The `primary` side: a `HostJournals` that forwards each call to the Host's partition. It keeps the head index, so a
 * browser stream is gated without a call. Opens, publications, fills and deletions of one Host run in the order they were
 * made, so a deletion is never overtaken by a later call. Each partition holds one Host, so the cap of four deletions at
 * once across the Relay is held here, not in the partitions.
 */
export function createPartitionJournals(options: PartitionJournalsOptions): HostJournals {
  const { partition } = options;
  const heads = new JournalHeadIndex();
  const chains = new Map<string, Promise<void>>();
  const loading = new Map<string, Promise<void>>();
  /** Raised when the head index loses a session (an unserve, an open or publication that cleared a head) and when a deletion starts and ends, so a load read in between is discarded. Adding a head never raises it. */
  const epochs = new Map<string, number>();
  const bump = (hostId: string) => { epochs.set(hostId, (epochs.get(hostId) ?? 0) + 1); };
  let deletionsRunning = 0;
  const deletionWaiters: Array<() => void> = [];

  async function withDeletionSlot<T>(operation: () => Promise<T>): Promise<T> {
    while (deletionsRunning >= HOST_DELETIONS_AT_ONCE) await new Promise<void>(resolve => deletionWaiters.push(resolve));
    deletionsRunning += 1;
    try { return await operation(); } finally { deletionsRunning -= 1; deletionWaiters.shift()?.(); }
  }

  function serialized<T>(hostId: string, work: () => Promise<T>): Promise<T> {
    const result = (chains.get(hostId) ?? Promise.resolve()).then(work);
    const tail = result.then(() => undefined, () => undefined);
    chains.set(hostId, tail);
    void tail.then(() => { if (chains.get(hostId) === tail) chains.delete(hostId); });
    return result;
  }

  /** One load per Host at a time, outside the Host's queue. A load that a head change or a deletion overtook is read again. */
  function loadHost(hostId: string): Promise<void> {
    if (heads.loaded(hostId)) return Promise.resolve();
    let pending = loading.get(hostId);
    if (!pending) {
      pending = (async () => {
        for (let attempt = 0; attempt < 3 && !heads.loaded(hostId); attempt++) {
          const epoch = epochs.get(hostId) ?? 0;
          const sessions = await partition(hostId).servedSessions(hostId);
          if ((epochs.get(hostId) ?? 0) === epoch && !heads.loaded(hostId)) heads.load(hostId, sessions);
        }
      })().finally(() => { loading.delete(hostId); });
      loading.set(hostId, pending);
    }
    return pending;
  }

  return {
    open: (hostId, sessionKey, publisherId, { allowed, maxIndexItems, pageItems }) => serialized<JournalOpened | JournalOpenRefusal>(hostId, async () => {
      if (allowed && !allowed()) return { refused: 'unavailable' };
      const opened = await partition(hostId).open(hostId, sessionKey, publisherId, { maxIndexItems, pageItems });
      if ('refused' in opened && opened.unserved) {
        heads.remove(hostId, sessionKey);
        bump(hostId);
      }
      return opened;
    }),

    indexPage: (hostId, sessionKey, epoch, after, maxItems) => serialized(hostId, () => partition(hostId).indexPage(hostId, sessionKey, epoch, after, maxItems)),

    publish: (hostId, sessionKey, generation, entries) => serialized<JournalPublished>(hostId, async () => {
      try {
        const result = await partition(hostId).publish(hostId, sessionKey, generation, [...entries]);
        if (result.hasHead === true) heads.add(hostId, sessionKey);
        else if (result.hasHead === false) heads.remove(hostId, sessionKey);
        // A publication that gives a head only adds to what a load reads, so it cannot make a load stale; one that took a head away can.
        if (result.unserved) bump(hostId);
        return result;
      } catch (error) {
        bump(hostId);
        throw error;
      }
    }),

    // Whether the Host may hold older history is asked here, in the Host's queue, as the service asks it.
    fill: (hostId, sessionKey, items, read) => serialized<JournalFilled>(hostId, () =>
      partition(hostId).fill(hostId, sessionKey, [...items], read && { request: read.request, olderBeyondJournal: read.olderBeyondJournal() })),

    // Reads wait in the Host's queue behind earlier publications, as in the in-process service.
    page: (hostId, sessionKey, request, olderBeyondJournal) => serialized(hostId, () => partition(hostId).page(hostId, sessionKey, request, olderBeyondJournal)),

    status: (hostId, sessionKey) => serialized(hostId, () => partition(hostId).status(hostId, sessionKey)),

    async forget() { /* The partition owns its cache. */ },

    served: (hostId, sessionKey) => heads.served(hostId, sessionKey),

    unserve(hostId, sessionKey) {
      heads.remove(hostId, sessionKey);
      bump(hostId);
    },

    async servedSessions(hostId) {
      await loadHost(hostId);
      return heads.sessions(hostId);
    },

    async loadAllServed() { /* A Host's sessions load when the first stream for it needs them. */ },

    deleteHost: hostId => withDeletionSlot(() => serialized<void>(hostId, async () => {
      bump(hostId);
      try {
        await partition(hostId).deleteHost(hostId);
        heads.clearHost(hostId);
      } finally { bump(hostId); }
    })),
  };
}
```

In `packages/agent-remote-hosted/src/index.ts`, after the `host-journals.js` export add (only what the Cloudflare package imports):

```ts
export { createPartitionJournals, JOURNAL_PARTITION_CACHE, JOURNAL_PARTITION_LIMITS, serveJournalPartition, type JournalPartitionApi, type JournalPartitionRead } from './journal-partition.js';
```

- [x] **Step 4: Run the tests and see them pass.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/journal-partition.test.ts --testTimeout=10000`
Expected: PASS (23 tests). The hosted suite then has 941 tests, the journal suite 178.

- [x] **Step 5: Typecheck and rebuild.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted run typecheck` then `pnpm --filter @orchardworks/agent-remote-hosted run build`
Expected: PASS.

- [x] **Step 6: Commit.**

```bash
git add packages/agent-remote-hosted/src/host-journals.ts packages/agent-remote-hosted/src/journal-partition.ts packages/agent-remote-hosted/src/journal-partition.test.ts packages/agent-remote-hosted/src/index.ts
git commit -m "feat(hosted): the journal partition contract, its server side and the primary-side proxy" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: The Durable Object over the store, tested in a real Worker

**Files:**
- Modify: `packages/agent-remote-cloudflare/package.json`, `pnpm-lock.yaml`
- Create: `packages/agent-remote-cloudflare/src/journal-sql-database.ts`
- Create: `packages/agent-remote-cloudflare/src/journal-partition.ts`
- Create: `packages/agent-remote-cloudflare/src/journal-worker.ts`
- Modify: `packages/agent-remote-cloudflare/test/fixture.ts`
- Create: `packages/agent-remote-cloudflare/test/journal-partition.test.ts`

- [x] **Step 1: Add the dependency.** In `packages/agent-remote-cloudflare/package.json`, add to `dependencies`, after the hosted line:

```json
    "@orchardworks/agent-remote-journal-sqlite": "workspace:*",
```

Edit only the Cloudflare importer entry of `pnpm-lock.yaml` by hand (`pnpm install` rewrites unrelated registry entries of this checkout), then run `pnpm install --frozen-lockfile --prefer-offline`.
Expected: the Cloudflare package links the store package; `pnpm-lock.yaml` changes by that importer entry only.

- [x] **Step 2: Extend the Miniflare fixture.** All edits are in `packages/agent-remote-cloudflare/test/fixture.ts`; the file is the reference. The fixture now starts two Workers in one Miniflare: `relay` (as before) and `journals`, bundled from a test entry that exports `TestJournalPartition extends JournalPartition` (tuning from the `JOURNAL_TUNING` binding, `effectiveTuning`, `inspect(sql)`, `transactionProbe`, a counting `database()` and `journalLoads`; with `actualEntry` it bundles `src/journal-worker.ts` instead). `relay` binds `JOURNALS` with `scriptName: 'journals'` and the variable `AGENT_REMOTE_JOURNALS` when the option `journals` is given; `TestRelayObject` gains `/_fixture/journal-tables` and `/_fixture/partition/<hostId>/<method>` (a Durable Object RPC call from `primary`). Both Workers share `durableObjectsPersist`.

- [x] **Step 3: Write the failing tests for the object.** `packages/agent-remote-cloudflare/test/journal-partition.test.ts`:

```ts
import { expect, test } from 'vitest';

import { fixture } from './fixture.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const SESSION = 'codex:thread-1';
const LIMITS = { maxIndexItems: 1_000_000, pageItems: 2000 };
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
  expect(await call(f, 'host-1', 'open', 'host-1', SESSION, 'controller-1', LIMITS)).toMatchObject({ generation: 1, watermark: 0, index: [] });
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
  expect(await call(f, 'host-1', 'open', 'host-1', SESSION, 'controller-1', LIMITS)).toMatchObject({ generation: 2, watermark: 3 });
}, 60_000);

test('keeps each Host in its own object and deletes the journals of one Host without touching another', async () => {
  const f = await fixture({ journals: {} });
  for (const host of ['host-1', 'host-2']) {
    await call(f, host, 'open', host, SESSION, 'controller-1', LIMITS);
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

test('refuses growth over the session limit of the object', async () => {
  const f = await fixture({ journals: { tuning: { limits: { sessionBytes: 3500 } } } });
  const big = 'x'.repeat(2000);
  await call(f, 'host-1', 'open', 'host-1', SESSION, 'controller-1', LIMITS);
  expect((await call(f, 'host-1', 'publish', 'host-1', SESSION, 1, [{ sequence: 1, op: 'append', row: row('m1', big, 1) }])).refusal).toBeUndefined();
  expect((await call(f, 'host-1', 'publish', 'host-1', SESSION, 1, [{ sequence: 2, op: 'append', row: row('m2', big, 2) }])).refusal).toEqual({ sequence: 2, reason: 'quota_exceeded' });
}, 60_000);

test('answers a page that would pass the reply bound with fewer entries', async () => {
  const f = await fixture({ journals: { tuning: { replyMaxBytes: 5000 } } });
  await call(f, 'host-1', 'open', 'host-1', SESSION, 'controller-1', LIMITS);
  const entries = Array.from({ length: 6 }, (_, n) => [{ sequence: n * 2 + 1, op: 'append', row: row(`m${n}`, 'x'.repeat(2000), n) }, { sequence: n * 2 + 2, op: 'complete', itemKey: `m${n}`, digest: `digest-${n}` }]).flat();
  await call(f, 'host-1', 'publish', 'host-1', SESSION, 1, entries);
  const page = await call(f, 'host-1', 'page', 'host-1', SESSION, { ...tail, limit: 6 }, false);
  expect(page.page.payload.entries.length).toBeGreaterThan(0);
  expect(page.page.payload.entries.length).toBeLessThan(6);
}, 60_000);

test('refuses to open a journal whose index is over the item bound, claims nothing, and pages the index through RPC', async () => {
  const f = await fixture({ journals: {} });
  await call(f, 'host-1', 'open', 'host-1', SESSION, 'controller-1', LIMITS);
  await call(f, 'host-1', 'publish', 'host-1', SESSION, 1, [
    { sequence: 1, op: 'append', row: row('m1', 'a') }, { sequence: 2, op: 'append', row: row('m2', 'b') }, { sequence: 3, op: 'append', row: row('m3', 'c') }]);
  expect(await call(f, 'host-1', 'open', 'host-1', SESSION, 'controller-1', { maxIndexItems: 2, pageItems: 2 })).toEqual({ refused: 'index_too_large' });
  const opened = await call(f, 'host-1', 'open', 'host-1', SESSION, 'controller-1', { maxIndexItems: 10, pageItems: 2 });
  expect(opened).toMatchObject({ generation: 2, watermark: 3, more: true });
  expect(opened.index.map((entry: { itemKey: string }) => entry.itemKey)).toEqual(['m1', 'm2']);
  const rest = await call(f, 'host-1', 'indexPage', 'host-1', SESSION, opened.epoch, opened.index.at(-1).seqStart, 10);
  expect(rest.map((entry: { itemKey: string }) => entry.itemKey)).toEqual(['m3']);
  expect(await call(f, 'host-1', 'indexPage', 'host-1', SESSION, 'another-epoch', 0, 10)).toBeNull();
}, 60_000);

test('fills bodies and reads the page in one call, and serves a page of several MiB in one reply', async () => {
  const f = await fixture({ journals: { tuning: { retention: { turns: 1, minItems: 1 } } } });
  const text = 'é'.repeat(1_000_000);
  await call(f, 'host-1', 'open', 'host-1', SESSION, 'controller-1', LIMITS);
  for (const n of [1, 2, 3]) {
    await call(f, 'host-1', 'publish', 'host-1', SESSION, 1, [
      { sequence: n * 2 - 1, op: 'append', row: row(`m${n}`, text, n) }, { sequence: n * 2, op: 'complete', itemKey: `m${n}`, digest: `digest-m${n}` }]);
  }
  expect(await call(f, 'host-1', 'page', 'host-1', SESSION, tail, false)).toEqual({ kind: 'missing', itemKeys: ['m1', 'm2'] });
  const filled = await call(f, 'host-1', 'fill', 'host-1', SESSION,
    ['m1', 'm2'].map(key => ({ row: row(key, text, Number(key.slice(1))), digest: `digest-${key}` })), { request: tail, olderBeyondJournal: true });
  expect(filled).toMatchObject({ filled: ['m1', 'm2'], page: { kind: 'page', page: { payload: { hasOlder: true } } } });
  expect(filled.page.page.payload.entries.map((entry: { item: { text: string } }) => entry.item.text.length)).toEqual([1_000_000, 1_000_000, 1_000_000]);
}, 120_000);


test('holds the Durable Object bounds by default: two journals, 20 MiB of cache and 12 MiB per session', async () => {
  const f = await fixture({ journals: {} });
  expect(await call(f, 'host-1', 'effectiveTuning')).toEqual({
    cache: { maxJournals: 2, maxBytes: 20 * 1024 * 1024 }, limits: { sessionBytes: 12 * 1024 * 1024, hostBytes: 1024 * 1024 * 1024 } });
  const text = 'x'.repeat(7 * 1024 * 1024);
  await call(f, 'host-1', 'open', 'host-1', SESSION, 'controller-1', LIMITS);
  expect((await call(f, 'host-1', 'publish', 'host-1', SESSION, 1, [{ sequence: 1, op: 'append', row: row('m1', text, 1) }])).refusal).toBeUndefined();
  expect((await call(f, 'host-1', 'publish', 'host-1', SESSION, 1, [{ sequence: 2, op: 'append', row: row('m2', text, 2) }])).refusal).toEqual({ sequence: 2, reason: 'quota_exceeded' });
}, 120_000);

test('rolls back every statement of a transaction that fails', async () => {
  const f = await fixture({ journals: {} });
  expect(await call(f, 'host-1', 'transactionProbe')).toEqual([{ n: 0 }]);
}, 60_000);

test('keeps two journals in memory by default and reads a third one that was dropped from the store again', async () => {
  const f = await fixture({ journals: {} });
  for (const key of ['codex:a', 'codex:b', 'codex:c']) await call(f, 'host-1', 'open', 'host-1', key, 'controller-1', LIMITS);
  const before = await call(f, 'host-1', 'journalLoads');
  await call(f, 'host-1', 'status', 'host-1', 'codex:c');
  expect(await call(f, 'host-1', 'journalLoads')).toBe(before);
  await call(f, 'host-1', 'status', 'host-1', 'codex:a');
  expect(await call(f, 'host-1', 'journalLoads')).toBe(before + 1);
}, 60_000);
```

- [x] **Step 4: Run the tests and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-cloudflare exec vitest run test/journal-partition.test.ts --testTimeout=60000 --maxWorkers=1` (Bash `timeout` 300000)
Expected: FAIL at start-up (the bundle cannot resolve `./src/journal-partition.ts`).

- [x] **Step 5: Implement the binding of the store to a Durable Object.** `packages/agent-remote-cloudflare/src/journal-sql-database.ts`:

```ts
import type { JournalSqlDatabase, SqlValue } from '@orchardworks/agent-remote-journal-sqlite';

/** Binds the journal store to a Durable Object's SQLite storage. Binary values cross as `ArrayBuffer`s and are given back as `Uint8Array`s. */
export function durableObjectJournalDatabase(storage: DurableObjectStorage): JournalSqlDatabase {
  const bind = (params: SqlValue[]): SqlStorageValue[] => params.map(value => (value instanceof Uint8Array ? value.slice().buffer as ArrayBuffer : value));
  return {
    run(sql, ...params) { storage.sql.exec(sql, ...bind(params)); },
    all<Row extends Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): Row[] {
      return storage.sql.exec(sql, ...bind(params)).toArray().map(row => {
        const converted: Record<string, SqlValue> = {};
        for (const [key, value] of Object.entries(row)) converted[key] = value instanceof ArrayBuffer ? new Uint8Array(value) : value as SqlValue;
        return converted as Row;
      });
    },
    transaction: work => storage.transactionSync(work),
  };
}
```

- [x] **Step 6: Implement the Durable Object.** `packages/agent-remote-cloudflare/src/journal-partition.ts`:

```ts
import { DurableObject } from 'cloudflare:workers';
import {
  createHostJournals, JOURNAL_PARTITION_CACHE, JOURNAL_PARTITION_LIMITS, serveJournalPartition,
  type HostJournalsOptions, type JournalPartitionApi,
} from '@orchardworks/agent-remote-hosted';
import { SqlJournalStore, type JournalSqlDatabase } from '@orchardworks/agent-remote-journal-sqlite';

import { durableObjectJournalDatabase } from './journal-sql-database.js';

export interface JournalPartitionTuning extends Pick<HostJournalsOptions, 'cache' | 'limits' | 'retention'> {
  /** The size above which a page reply is answered again with fewer entries. */
  replyMaxBytes?: number;
}

/**
 * The journals of one Host: the hosted journal service over a SQLite store in this object's own storage. Only `primary`
 * calls it, through Durable Object RPC; it has no `fetch` and does no authorization. One object per Host, named by the Host id.
 */
export class JournalPartition extends DurableObject<unknown> implements JournalPartitionApi {
  private readonly api: JournalPartitionApi;

  constructor(context: DurableObjectState, env: unknown) {
    super(context, env);
    const tuning = this.tuning();
    const journals = createHostJournals({
      store: new SqlJournalStore(this.database(context.storage)), now: Date.now,
      cache: tuning.cache, limits: tuning.limits, retention: tuning.retention,
    });
    this.api = serveJournalPartition(journals, tuning.replyMaxBytes === undefined ? {} : { replyMaxBytes: tuning.replyMaxBytes });
  }

  /** The SQL port of the store. */
  protected database(storage: DurableObjectStorage): JournalSqlDatabase {
    return durableObjectJournalDatabase(storage);
  }

  /** The bounds of this object; a Durable Object has 128 MB of memory. */
  protected tuning(): JournalPartitionTuning {
    return { cache: JOURNAL_PARTITION_CACHE, limits: JOURNAL_PARTITION_LIMITS };
  }

  open(...args: Parameters<JournalPartitionApi['open']>) { return this.api.open(...args); }
  indexPage(...args: Parameters<JournalPartitionApi['indexPage']>) { return this.api.indexPage(...args); }
  publish(...args: Parameters<JournalPartitionApi['publish']>) { return this.api.publish(...args); }
  fill(...args: Parameters<JournalPartitionApi['fill']>) { return this.api.fill(...args); }
  page(...args: Parameters<JournalPartitionApi['page']>) { return this.api.page(...args); }
  status(...args: Parameters<JournalPartitionApi['status']>) { return this.api.status(...args); }
  servedSessions(...args: Parameters<JournalPartitionApi['servedSessions']>) { return this.api.servedSessions(...args); }
  deleteHost(...args: Parameters<JournalPartitionApi['deleteHost']>) { return this.api.deleteHost(...args); }
}
```

`packages/agent-remote-cloudflare/src/journal-worker.ts` is the entry of the Worker that holds the partitions; `worker.ts` does not export the class:

```ts
export { JournalPartition } from './journal-partition.js';

export default {
  fetch(): Response { return new Response(null, { status: 404 }); },
};
```

- [x] **Step 7: Run the tests and see them pass.**

Run: `pnpm --filter @orchardworks/agent-remote-cloudflare exec vitest run test/journal-partition.test.ts --testTimeout=60000 --maxWorkers=1` (Bash `timeout` 300000)
Expected: PASS (9 tests; the whole Cloudflare suite then has 228, run in two halves of at most 300 s). If the bundle step cannot resolve `@orchardworks/agent-remote-journal-sqlite`, run `pnpm --filter @orchardworks/agent-remote-journal-sqlite run build` first. If a `cloudflare:workers` import is rejected by the bundler, check that the fixture's esbuild call lists `cloudflare:*` in `external` (it already does).

- [x] **Step 8: Typecheck the Cloudflare package.**

Run: `pnpm --filter @orchardworks/agent-remote-cloudflare run typecheck`
Expected: PASS with `implements JournalPartitionApi` kept. If a later change makes the Durable Object RPC types reject a method because they demand `Rpc.Serializable` results, drop only the `implements` clause: `primary` casts the stub to `JournalPartitionApi` and never relies on the class type.

- [x] **Step 9: Commit.**

```bash
git add packages/agent-remote-cloudflare/package.json pnpm-lock.yaml packages/agent-remote-cloudflare/src packages/agent-remote-cloudflare/test
git commit -m "feat(cloudflare): a journal partition Durable Object over the SQLite journal store" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: `primary` reaches the partitions; configuration and documentation

**Files:**
- Modify: `packages/agent-remote-cloudflare/src/relay-object.ts`
- Modify: `packages/agent-remote-cloudflare/test/journal-partition.test.ts`
- Modify: `packages/agent-remote-hosted/src/journal-partition.ts`, `journal-partition.test.ts` (the rollout rule and its test)
- Modify: `packages/agent-remote-cloudflare/scripts/build.mjs`, `package.json` (a second bundle, `deploy:dry-run` for both Workers)
- Create: `packages/agent-remote-cloudflare/wrangler.journals.jsonc`
- Modify: `packages/agent-remote-cloudflare/wrangler.jsonc`
- Create: `deploy/self-hosted/wrangler.journals.jsonc`
- Modify: `deploy/self-hosted/wrangler.jsonc`
- Modify: `scripts/relay-workers-local.mjs`
- Modify: `docs/self-hosted-deployment.md`, `docs/current/agent-remote/deployment.md`, `packages/agent-remote-cloudflare/README.md`

- [x] **Step 1: Write the failing test of the whole path.** Append to `packages/agent-remote-cloudflare/test/journal-partition.test.ts`, and change its second import line from `import { fixture } from './fixture.js';` to `import { fixture, send } from './fixture.js';`:

```ts
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
  expect(await host.take('journal_opened')).toMatchObject({ generation: 1, watermark: 0, index: [] });
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
  expect(reopened.index.map((entry: { itemKey: string }) => entry.itemKey)).toEqual(['m1']);
}, 90_000);

test('grants no journals when the Worker has the binding but the variable is not set', async () => {
  const f = await fixture();
  const owner = await f.login('owner');
  const pairing = await (await f.json(owner.basePath + 'v1/remote/pairings', owner.cookie, {})).json() as { key: string };
  const host = await journalHost(f, pairing.key);
  expect(host.registered).toMatchObject({ type: 'registered' });
  expect(host.registered).not.toHaveProperty('journal');
}, 60_000);
```

- [x] **Step 2: Run the tests and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-cloudflare exec vitest run test/journal-partition.test.ts -t "grants" --testTimeout=60000 --maxWorkers=1` (Bash `timeout` 300000)
Expected: the first test FAILS (`registered.journal` is absent: `primary` builds no journal service yet); the second passes.

- [x] **Step 3: Wire `primary`.** In `packages/agent-remote-cloudflare/src/relay-object.ts`:

Change the import on line 1 to

```ts
import { createHostedRelay, createPartitionJournals, hostedAuthFromEnv, hostedRecordEncodingCosts, PortableTeamResourceStore, type HostedAuthEnvironment, type HostedRecordKind, type JournalPartitionApi, type RelayScheduler } from '@orchardworks/agent-remote-hosted';
```

In `RelayEnvironment`, after `CF_VERSION_METADATA?: { id: string };` add

```ts
  /** The journal partitions, one Durable Object per Host. */
  JOURNALS?: DurableObjectNamespace;
  /** Set to `1` to keep Host session journals in the journal partitions; otherwise no Controller is granted journals. */
  AGENT_REMOTE_JOURNALS?: string;
```

In `initialize`, immediately before `    this.core = createHostedRelay({ ...auth, `, add

```ts
    const partitions = this.env.AGENT_REMOTE_JOURNALS === '1' ? this.env.JOURNALS : undefined;
    const journalService = partitions && createPartitionJournals({ partition: hostId => partitions.getByName(hostId) as unknown as JournalPartitionApi });
```

and change `    this.core = createHostedRelay({ ...auth, ` to `    this.core = createHostedRelay({ ...auth, ...(journalService ? { journalService } : {}), ` (the rest of that statement stays as it is).

- [x] **Step 4: Run the tests and see them pass.**

Run: `pnpm --filter @orchardworks/agent-remote-cloudflare exec vitest run test/journal-partition.test.ts --testTimeout=60000 --maxWorkers=1` (Bash `timeout` 300000)
Expected: PASS for all tests in the file (11). The whole Cloudflare suite then has 230 tests, the hosted suite 943, the journal suite 178, the protocol suite 414.

- [x] **Step 5: Typecheck and run the whole Cloudflare suite.**

Run: `pnpm --filter @orchardworks/agent-remote-cloudflare run typecheck` then `pnpm test:cloudflare` (Bash `timeout` 600000)
Expected: PASS. The added Durable Object binding must not change any existing test.

- [x] **Step 6: Give the partitions their own Worker and bind it from the Relay.**

`packages/agent-remote-cloudflare/scripts/build.mjs` bundles two entries into `dist/cloudflare`: `worker: 'src/worker.ts'` and `journals: 'src/journal-worker.ts'` (`entryPoints` as an object, `outdir: '../../dist/cloudflare'`). The package script `deploy:dry-run` runs `wrangler deploy --dry-run --config wrangler.journals.jsonc && wrangler deploy --dry-run`.

New `packages/agent-remote-cloudflare/wrangler.journals.jsonc` (name `agent-remote-control-journals`, `main` `../../dist/cloudflare/journals.js`, the same compatibility date and flags, `workers_dev` and `preview_urls` off, no routes, no assets, no variables, a `JOURNALS` binding of class `JournalPartition`, migration `v1` with `new_sqlite_classes: ["JournalPartition"]`) and new `deploy/self-hosted/wrangler.journals.jsonc` (the same, name `my-agent-remote-journals`, `main` `../../dist/cloudflare/journals.js`).

In `packages/agent-remote-cloudflare/wrangler.jsonc` and `deploy/self-hosted/wrangler.jsonc` add to `durable_objects.bindings` `{ "name": "JOURNALS", "class_name": "JournalPartition", "script_name": "agent-remote-control-journals" }` (self-hosted: `my-agent-remote-journals`). The Relay configurations get no migration for the class: the partitions Worker owns it.

`scripts/relay-workers-local.mjs` writes a second configuration, `wrangler.journals.local.json` (name `agent-remote-local-journals`, `main` `./journals.js`, the binding and migration `v1`), binds `JOURNALS` in the Relay's configuration with `script_name: 'agent-remote-local-journals'`, passes `AGENT_REMOTE_JOURNALS` through when the environment sets it, and starts `wrangler dev --config wrangler.local.json --config wrangler.journals.local.json`. The Docker `workers` image already copies `dist/cloudflare`, which now holds both bundles.

No configuration sets `AGENT_REMOTE_JOURNALS`, so journals stay off everywhere.

**Deploy order and rollout.** The partitions Worker, with its migration, deploys first, because the Relay's `JOURNALS` binding names it. `JournalPartitionApi` only ever gains methods: existing methods keep their names, argument lists and result shapes, so a newer Relay works with the previous partitions Worker and the reverse during a rollout, and a Relay that calls a new method deploys after a partitions Worker that has it. `journal-partition.test.ts` fixes the method list and arities so that a change must be deliberate. There is no CI workflow or script in the repository that deploys the Relay Worker (the two Controller workflows publish releases); the deploy commands live in `docs/self-hosted-deployment.md`, `docs/current/agent-remote/deployment.md` and the package README, and all three now deploy the partitions Worker first. `scripts/gateway-relay-test-runtime.mjs` starts a Workers Relay for tests with journals off and without the binding; it stays as it is.

- [x] **Step 7: Validate the configurations with dry runs.**

Run: `pnpm --filter @orchardworks/agent-remote-cloudflare run build` then `pnpm build:relay` (Bash `timeout` 600000 for the second), then for each of `wrangler.journals.jsonc`, `wrangler.jsonc`, `../../deploy/self-hosted/wrangler.journals.jsonc`, `../../deploy/self-hosted/wrangler.jsonc`: `pnpm --filter @orchardworks/agent-remote-cloudflare exec wrangler deploy --dry-run --config <file> --outdir /tmp/arc-dry-<n>` (Bash `timeout` 300000; wrangler runs in the package directory, so run the paths as shown). Never deploy.
Expected: each succeeds. The partitions configurations list `env.JOURNALS (JournalPartition)`; the Relay configurations list `env.RELAY (RelayObject)` and `env.JOURNALS (JournalPartition, defined in <partitions Worker>)`. Then `rm -rf /tmp/arc-dry-*`.

Run `scripts/relay-workers-local.mjs` once with a stub `wrangler` on `PATH` to read the configurations and arguments it writes, then start the real `wrangler dev` with both configurations on a free port and `--persist-to` a temporary directory: `/health` answers 200 and the log lists both Workers' bindings.

Run: `node --test --test-timeout=60000 scripts/relay-local.test.mjs`
Expected: PASS.

- [x] **Step 8: Document the Workers settings.** `docs/self-hosted-deployment.md`: the Workers commands dry-run and deploy both configurations, partitions first, with a paragraph that explains the two Workers; the `AGENT_REMOTE_JOURNALS=1` row covers Workers; the journals section gains a Workers paragraph (a partition per Host in a Worker of its own, deploy order, the add-only rollout rule, 2 journals and 20 MiB in memory, 12 MiB per session, 1 GiB per Host, revoking empties a partition). `docs/current/agent-remote/deployment.md` and the package README deploy the partitions Worker first. The text is in the files.

Run: `pnpm lint:docs`
Expected: PASS.

- [x] **Step 9: Commit.**

```bash
git add packages/agent-remote-cloudflare packages/agent-remote-hosted/src deploy/self-hosted scripts/relay-workers-local.mjs docs/self-hosted-deployment.md docs/current/agent-remote/deployment.md docs/superpowers/plans/2026-11-15-p1b3b-cloudflare-journal-partition.md
git commit -m "feat(cloudflare): reach the journal partitions from primary, behind a variable that is off by default" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Verify the workspace, update compatibility metadata and check the local instance

**Files:**
- Modify: `packages/agent-remote-lab/compatibility.json` (written by the script)

- [x] **Step 1: Build every package and typecheck.**

Run: `pnpm -r run build` (Bash `timeout` 600000) then `pnpm typecheck` (Bash `timeout` 600000)
Expected: PASS for both.

- [x] **Step 2: Run the affected suites.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted run test` (Bash `timeout` 300000)
Run: `pnpm --filter @orchardworks/agent-remote-journal-sqlite run test` (Bash `timeout` 300000)
Run: `pnpm test:cloudflare` (Bash `timeout` 600000)
Run: `pnpm test:conformance` (Bash `timeout` 600000)
Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/server/devbox.test.ts src/server/hosted-runtime.test.ts src/server/relay-conformance.test.ts --testTimeout=30000` (Bash `timeout` 600000)
Expected: PASS for each: the Node hosts and crude Hosts are unchanged.

- [x] **Step 3: Update and check the compatibility digest.**

Run: `pnpm compatibility:update` then `pnpm compatibility:check`
Expected: `Compatibility updated: sha256:...` then `Compatibility verified: sha256:...`.

- [x] **Step 4: Commit the manifest.**

```bash
git add packages/agent-remote-lab/compatibility.json
git commit -m "chore: update the compatibility manifest for the journal partition" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [x] **Step 5: Verify on the local instance.** `pnpm local` runs the Node Relay, which this plan changes only by adding the `journalService` option it does not use, so this step proves the Node Relay and its crude read and send path are unaffected; the Workers path is proved by the Miniflare tests and the dry runs above, and was not run in a Workers runtime on this machine. Follow `.agents/skills/prepare-arc-local/SKILL.md`. Read `references/lifecycle.md#before-restarting-a-running-instance` first; if this checkout's instance runs or waits on a session this task did not start, stop and ask the user before `up`.

Run from the worktree: `pnpm local up` (Bash `timeout` 600000)
Expected: it builds, starts the instance, prints the status and exits 0.

Run: `pnpm --silent local status --json`
Expected: exit 0, state ready, running build commit equal to the checkout commit.

Check and report each layer in the skill's format:

1. **Site and Controller.** `agent-remote-controller-dev host providers` shows the expected providers `enabled`; `status` shows `uplink registered`.
2. **Model turn.** Create a session in the instance workspace and read a real reply as `references/test-loop.md` describes: `agent-remote-controller-dev session create --provider claude --message "Reply with the single word ready."`, then `session read <address> --limit 2`. Release any Codex session you created.
3. **Feature.** Not exercised on this instance: no deployment of it uses journal partitions. Say so.
4. **Page.** Not exercised; nothing in this plan changes the page.

Run: `pnpm local down` when nobody needs the instance.

---

## Self-review

- **Partition class and RPC:** Tasks 1 to 3. One `JournalPartition` per Host through `getByName(hostId)`; the unchanged `createHostJournals` runs in it over `SqlJournalStore`; `primary` forwards through `createPartitionJournals`, keeps every socket and does the fan-out (the broker's `published` hook is unchanged and receives the partition's publication results).
- **Journals out of `primary`'s state:** no journal code touches `RelayStateStore`; Task 3's test asserts `primary` has no `journal%` tables.
- **Durable Object limits:** Decision 4 and the tests: chunking (Task 2, first test), memory bounds (Decision 4, `JOURNAL_PARTITION_*`), RPC payload (the reply bound test and the index page test).
- **Gating from a cached head index:** `createPartitionJournals` loads each Host once through `servedSessions` and stays current from publication results and deletions (Task 1 tests); the broker's gate from P1-B3a waits at most 2 s for the first load.
- **Switch, retention, deletion over RPC:** the switch lives in `primary`'s Host record (P1-B3a); retention is the publish-time rule of the service running in the partition; `deleteHost` is ordered against publications by the proxy's queue and by the partition's own, and a deletion the partition did not confirm stays in `journalDeletions` until it does.
- **Wrangler configuration and migration:** Task 3 Steps 6 and 7 (a partitions Worker and the Relay configurations, dry runs, the deploy order).
- **Test approach:** Miniflare with a real Worker and real Durable Object RPC, as the package already uses; the proxy logic is tested in Node with structured-clone "RPC".
- **Local instance verification:** Task 4 Step 5, with its limits stated.

## Open risks

- **Not run in workerd outside Miniflare.** The Workers runtime of `pnpm local` (Docker, `relay:local --runtime workers`) was not exercised; the dry runs validate the bindings and the migration only.
- **The size estimate versus a 128 MB isolate.** The estimate counts UTF-8 bytes and heap use is up to twice that, plus transient buffers while a journal loads. The partition's bounds (2 journals, 20 MiB cache, 12 MiB per session) are conservative guesses; load a 12 MiB journal in the Miniflare fixture and watch memory before raising them, and revisit with the P0 numbers.
- **RPC reply bound.** The page loop halves the limit until the estimated clone size fits 24 MiB; a single item above that (an item folded from many deltas) cannot be split and would fail the RPC. A journal message is at most 8 MiB, so one row cannot reach it, but many deltas of one item could.
- **One extra hop.** Every browser read of a journal-served session costs a Durable Object RPC from `primary` (`status`, `page`), and every publication one more; P4 moves sockets next to the partitions.
- **Deletion after a restart of `primary`.** The proxy's queue orders calls within one `primary` lifetime. A revoke records the Host in `journalDeletions` (P1-B3a), and the broker retries it at start and on every Host registration, so a deletion the partition did not confirm is not lost.
- **An exported but unconfigured class.** A deployment that deploys the new Worker without the `v2` migration works (journals off); one that sets `AGENT_REMOTE_JOURNALS=1` without the binding also works (journals off).

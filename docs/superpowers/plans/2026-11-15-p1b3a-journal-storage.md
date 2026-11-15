# P1-B3a Journal storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Relay's Host journals durable and bounded on the Node hosts. A SQLite journal store in its own package backs the journal service; the service bounds its memory and storage, keeps the latest turns resident, takes a session out of serving when a quota refuses it, deletes a revoked Host's journals durably, and answers "is this session journal-served?" from an in-memory index behind a persisted per-Host, per-provider switch. The uplink pages the item index, pulled by the Controller one page at a time.

**Architecture:** One store, `SqlJournalStore`, in the new package `@orchardworks/agent-remote-journal-sqlite`, written against a small synchronous SQL port (`JournalSqlDatabase`). The Node binding (`node:sqlite`) lives behind the subpath `@orchardworks/agent-remote-journal-sqlite/node`, so only the Node Relay host imports it; P1-B3b binds the same port to a Durable Object's storage. The journal core measures itself incrementally and can drop live-only items and clear its head. `createHostJournals` in `agent-remote-hosted` gains a bounded cache, limits, a head index and deletion. The broker owns the switch (a persisted field of the Host record), the gate in front of the journal-served path, the closing of streams when serving stops, and the durable list of journal deletions that revoke leaves pending. `agent-remote-protocol` gets the pull-based index pages.

**Tech Stack:** TypeScript 5.7 (ES2022, Node16 modules, strict, `noUncheckedIndexedAccess`), TypeBox through `@orchardworks/agent-remote-protocol`, Node's built-in `node:sqlite`, Vitest 4.1.11, pnpm workspace.

**Design reference:** `docs/superpowers/specs/2026-11-15-im-session-service-design.md`, sections Architecture (Deployment and middleware, Moving the Relay to partitions), Session journal (Durability and fan-out, Retention, Access), Compatibility and rollout, Failure handling. Roadmap: `docs/superpowers/plans/2026-11-15-im-session-service-roadmap.md` (row P1-B, "Notes carried to later plans", the P1-B3 bullets). Predecessors, all landed (HEAD `28eacc8e`): `2026-11-15-p1a-journal-core.md`, `2026-11-15-p1b1-relay-journal-service.md`, `2026-11-15-p1b2-journal-served-sessions.md` including Task 6 (`journal-sessions.ts` with `serves(hostId, sessionKey)`, the broker's `journalSessions`, `acceptJournalServed`, `test-utils/journal-session-fixture.ts` with `startRelay({ broker, state, seed, requestTimeoutMs })`, `broker-journal-sessions.test.ts`). Every edit below names the landed code it expects to find; where the landed text differs, follow the landed code.

**Commands.** Every test command sets a per-test deadline (`--testTimeout`, or `--test-timeout` for `node --test`). Run each with an outer deadline: the Bash tool `timeout` of at most 300000 ms (600000 where stated). Hosted and Lab tests import `@orchardworks/agent-remote-protocol`, `@orchardworks/agent-remote-journal` and `@orchardworks/agent-remote-journal-sqlite` from `dist`, so rebuild a package before running tests of its dependents; each task says when. Lab tests run on Node 22 like CI (Node 26 breaks jsdom): prefix them with `PATH=/opt/homebrew/opt/node@22/bin:$PATH`. All work happens in the worktree `/Users/xian/projects/agent-remote-control/.worktrees/im-session-service`. Each task leaves the repository green: no task changes a signature without changing its callers and their tests in the same task.

## Decisions made in this plan

1. **Storage binding: `node:sqlite`.** No native build; unflagged from Node 22.13 (CI 22.23.2, Docker `node:22`, default Node 26), SQLite 3.53 on both. A probe on 22.23.2 and 26.8.1 inserted 30,000 chunks of 2 KB in 35–39 ms and scanned them in 26–28 ms. Costs: it is flagged experimental (Node 22 prints one `ExperimentalWarning` when it is first imported), it is synchronous, and Node before 22.13 lacks it. The import is lazy and happens only when journals are enabled. Task 5 measures the real service on realistic journals against stated thresholds. **If a threshold fails, stop and report the numbers to the owner**; do not switch binding on your own.
2. **The store is written against a SQL port**, so P1-B3b reuses it. Values are chunked at 256 KiB on both bindings.
3. **Store keys stay `${hostId}:${sessionKey}`.** Host ids are UUIDs the Relay generates and contain no `:`. Prefix operations use a key range (`>= prefix AND < next prefix`), not `substr` or `LIKE`.
4. **`JournalStore` keeps its three methods.** The catalog (`list(prefix)`, `deletePrefix(prefix)`) is an optional `catalog` property, so test stores written as `{ load, apply, delete }` still type-check. Without a catalog the head index starts empty and learns from publications.
5. **Sizes are incremental.** `SessionJournal.residentBytes()` is the length of the meta and item records as JSON. It keeps a running total and measures only the items that changed since the last call, so a publication costs in proportion to what it changed, not to the journal. `JournalChanges.bytes` carries it to the store, which records it per session for the catalog. The unit is JSON characters; heap use is up to twice that (two-byte strings), and the defaults below allow for it.
6. **The switch is a field of the Host record.** `smartReading?: string[]` (provider ids, sorted, 1 to 64) is saved with the Host, kept in memory in the broker, and changed with `PUT /v1/remote/hosts/:id/smart-reading` by the account owner (`requireOwner`), inside `commit`. **The default is off for every provider**: reads go to the Controller as today, while journals may be written in shadow. A Host revoked and paired again is a new Host record without the field. The switch is checked before the head index. Turning a provider off closes that Host's and provider's journal-served browser streams with 1012, so their clients reconnect in crude mode.
7. **Gating is in memory.** The service keeps `served(hostId, sessionKey)`, a synchronous answer from an index of sessions that have a head; `undefined` means the Host was never loaded. Node loads every Host from SQLite at startup (`loadAllServed`). A Host not yet loaded (one that registers later) is loaded by `servedSessions(hostId)`. That load runs **outside the Host's journal queue**, once per Host however many opens ask (the sessions object shares the in-flight promise), and the gate waits for it at most 2 s on the broker's scheduler, then serves crude. A load reads at most three times: the Host's epoch is raised by every change of its head index (publications, `unserve`) and by its deletion, and a listing read across a change is discarded. A journal-served stream that finds no head although the index said it had one calls `unserve` before it closes with 1012, so the client's reconnect goes crude instead of looping.
8. **The cache is bounded by count and size.** Defaults: 64 journals and 128 MiB (estimated) for the whole Relay. After each call the least recently used journals are dropped until the cache is within its bounds, never the one the call used. Every call stores its changes before it returns, so dropping loses nothing.
9. **Safety limits refuse growth; they are not retention.** Defaults: 64 MiB per session, 100,000 items per session (`JOURNAL_INDEX_MAX_ITEMS`, also the clamp for the option), 1 GiB per Host, 2,000 live-only items per session. Limits are validated as non-negative integers. A growing entry (`append`, `correct`, `prepend`) that would pass a limit first tries to evict bodies of the session (to 5 turns, then 1, then 0, never live-only or digest-less items) and is refused with `quota_exceeded` if it still does not fit. A `replace` is admitted by its own size plus the live-only items it carries over, without shrinking first. Entries that do not grow a journal (`complete`, `seal`, `alias`, `head`) are never refused for size. **A quota refusal takes the session out of serving**: the service clears the journal's head, persisted, so the index rebuilt after a restart agrees; the publication result says `unserved`, and the broker closes the session's journal-served streams with 1012 so their clients reconnect crude. Serving resumes when a later publication that fits sets a head. Beyond 2,000 live-only items the oldest are removed (item and body) and `journal_live_only_dropped` is reported; the design keeps live-only items for the life of the session up to such a cap.
10. **Retention is one rule: the latest N turns.** After each publication, inside the Host's queue, bodies outside the latest 50 turns (`retention.turns`) are evicted with the core's `evict`; live-only and digest-less items are never evicted. Use-based windows are deferred (see "Notes for the roadmap").
11. **Fills respect the limits.** A fill puts back only the bodies that fit the session limit, the Host quota and the cache bound; the rest stay missing (`skipped`), and the reader's existing handling of a body that cannot be filled applies.
12. **Deletion is durable.** Revoking a Host records its id in `journalDeletions` of the broker state in the same commit as the revoke. The deletion then runs in the Host's journal queue (so it is ordered against a concurrent publish), and when the store confirms, a second commit removes the id. Pending deletions are retried at broker start and whenever a Host registers. `open` re-checks inside the queue that its connection is still current, so a revoked Host cannot recreate a journal. A Host restored through the recovery flow keeps its old id: its own pending deletion runs, and is waited for, before the Relay sends `registered`, and a Host whose deletion failed gets no journal grant until a later run confirms it, so a retry can never delete journals it created. There is no separate binding-removal path in the broker today (only revoke), so no per-session deletion is built. A Controller can open a journal for a session that has no binding; the per-Host quota bounds it. Journals require durable Relay state: `createHostedRelay` refuses `journals` or `journalService` without `storage`, so an ephemeral account cannot orphan journals.
13. **The paged index is pull-based.** `journal_opened` carries the first page and, when more follows, `indexAfter` (the `seqStart` of the last entry sent). The Controller asks for each next page with `journal_index_request { requestId, sessionKey, generation, epoch, after }` and the Relay answers with `journal_index_page { requestId, sessionKey, index, indexAfter? }`. One page is in flight at a time, so the exchange paces itself on every runtime and never reaches the uplink backpressure limit of `send` (`host_backpressure`, 16 MiB buffered). A page holds at most 2,000 entries and 1 MiB of entries; the total is at most `JOURNAL_INDEX_MAX_ITEMS`, raised to 100,000. **Compatibility:** no released Controller declares `journal=1`, so no old Controller reads these messages; `indexAfter` is absent for an index that fits one page, so a small journal's message is unchanged. The cursor is a position in one epoch of the journal: a request whose `epoch` is no longer current (a replacement happened between pages) is refused with `journal_open_refused` reason `stale_epoch`, and the Controller opens again. The `fits` callback of `HostJournals.open` becomes options.
14. **Node hosts.** Journals are enabled by configuration that is off by default: `AGENT_REMOTE_JOURNALS=1` for the self-hosted Node/Docker server (`packages/agent-remote-lab/src/server/gateway.ts`) and `ARC_LOCAL_JOURNALS=1` for `pnpm local`. The database is `journals.sqlite` beside `state.json`; `journalFile` without `stateFile` is refused.

## Notes for the roadmap (P1-C and P3)

- **P1-C:** the publisher consumes `journal_opened.indexAfter` and pulls pages with `journal_index_request` until a page has no `indexAfter`; the journal is open for it after the last page. A `journal_open_refused` with reason `stale_epoch` answering a page request means a replacement happened: open again. On a refusal `quota_exceeded` the Relay has already taken the session out of serving; the publisher reopens the journal and replaces it with a window that fits (fewer turns, still carrying its live-only items), and otherwise stops publishing that session. `journal_quota_exceeded` and `journal_live_only_dropped` reach only Controllers that advertise diagnostic version 4. A publication must not rely on bodies the Relay evicted: bodies outside the latest 50 turns are filled on demand.
- **P3 (demand leases):** use-based retention moves here. It needs demand reports from clients, which the Relay has only as browser stream attachments today. When it lands, add: a larger resident window for sessions in use (the design proposes 50 turns) and a smaller idle window of 5 turns for sessions nobody used for a while; a retention sweep for sessions that receive no publications; the measurements from P0 for the numbers.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/agent-remote-protocol/src/remote-host-journal.ts`, `remote-host-uplink.ts`, `remote-host-journal.test.ts` | Modify: index limits, `indexAfter`, `journal_index_request`, `journal_index_page`, refusal reason `quota_exceeded`. |
| `packages/agent-remote-journal/src/types.ts`, `journal-store.ts`, `session-journal.ts` | Modify: incremental size, removed items, live-only count and drop, head clearing, catalog. |
| `packages/agent-remote-journal/src/journal-bytes.test.ts`, `journal-store.test.ts` | New and modify: tests of the above. |
| `packages/agent-remote-journal-sqlite/` | New package: `src/sql-journal-store.ts`, `src/node-sqlite.ts`, `src/index.ts`, tests. |
| `packages/agent-remote-hosted/src/journal-head-index.ts` | New: the in-memory set of sessions that have a head. |
| `packages/agent-remote-hosted/src/journal-index-pages.ts` (+ test) | New: packing index entries into one message. |
| `packages/agent-remote-hosted/src/host-journals.ts` | Rewrite: bounded cache, limits, head index, retention rule, fills within limits, index pages, deletion, open options. |
| `packages/agent-remote-hosted/src/host-journals-bounds.test.ts` | New: tests of the above. |
| `packages/agent-remote-hosted/src/host-journals.test.ts`, `journal-uplink.test.ts`, `broker-journals.test.ts` | Modify: `open` options, pull-based paging. |
| `packages/agent-remote-hosted/src/journal-uplink.ts` | Modify: `open` call, index pages, diagnostics. |
| `packages/agent-remote-hosted/src/journal-sessions.ts` and its test | Modify: gate, shared load, stopping streams. |
| `packages/agent-remote-hosted/src/relay-diagnostics.ts` and its test | Modify: two journal events. |
| `packages/agent-remote-hosted/src/broker.ts`, `state.ts` | Modify: switch, route, gate, durable deletion. |
| `packages/agent-remote-hosted/src/smart-reading.test.ts`, `broker-journal-switch.test.ts` | New. |
| `packages/agent-remote-hosted/src/test-utils/journal-session-fixture.ts` | Modify: the Host has the switch on; limits and `onStateChange` for tests. |
| `packages/agent-remote-hosted/src/gateway.ts` | Modify: one shared service, durable-state check, `loadJournalIndex`. |
| `packages/agent-remote-lab/scripts/journal-benchmark.mjs`, `package.json` | New and modify: benchmark through the service; dependency. |
| `packages/agent-remote-lab/src/server/gateway-relay.ts`, `gateway.ts`, `devbox.ts`, `devbox.test.ts` | Modify: open the journal database when enabled. |
| `scripts/local/runner.mjs`, `docs/local-development.md`, `docs/self-hosted-deployment.md` | Modify. |
| `packages/agent-remote-cloudflare/test/storage-codec-worker.test.ts` | Modify: switch and pending deletions survive the SQL snapshot. |

---

### Task 1: The pull-based index and the quota refusal in the protocol

**Files:**
- Modify: `packages/agent-remote-protocol/src/remote-host-journal.ts`
- Modify: `packages/agent-remote-protocol/src/remote-host-uplink.ts`
- Modify: `packages/agent-remote-protocol/src/remote-host-journal.test.ts`

- [ ] **Step 1: Write the failing tests.** In `packages/agent-remote-protocol/src/remote-host-journal.test.ts`, change the import on line 3 to

```ts
import { JOURNAL_FILL_MAX_ITEMS, JOURNAL_INDEX_PAGE_MAX_ITEMS, JOURNAL_MESSAGE_MAX_BYTES, JOURNAL_PUBLISH_MAX_ENTRIES } from './remote-host-journal.js';
```

In the `valid` array, after the existing `journal_opened` line, add:

```ts
  message({ type: 'journal_opened', requestId: 'open-1', sessionKey: SESSION, generation: 1, watermark: 0, epoch: 'epoch-1', index: [indexEntry], indexAfter: -2 }),
  message({ type: 'journal_index_request', requestId: 'index-1', sessionKey: SESSION, generation: 1, epoch: 'epoch-1', after: -2 }),
  message({ type: 'journal_open_refused', requestId: 'index-1', sessionKey: SESSION, reason: 'stale_epoch' }),
  message({ type: 'journal_index_page', requestId: 'index-1', sessionKey: SESSION, index: [indexEntry], indexAfter: -2 }),
  message({ type: 'journal_index_page', requestId: 'index-2', sessionKey: SESSION, index: [] }),
  message({ type: 'journal_refused', sessionKey: SESSION, generation: 1, sequence: 4, reason: 'quota_exceeded', itemKey: 'item-1' }),
```

In the invalid list (`it.each<[string, Record<string, unknown>]>`), add before `['an acknowledgement without an epoch', ...]`:

```ts
    ['a first page with a cursor that is not a position', message({ type: 'journal_opened', requestId: 'o', sessionKey: SESSION, generation: 1, watermark: 0, epoch: 'e', index: [], indexAfter: 1.5 })],
    ['an index request without a position', message({ type: 'journal_index_request', requestId: 'i', sessionKey: SESSION, generation: 1, epoch: 'e' })],
    ['an index request without an epoch', message({ type: 'journal_index_request', requestId: 'i', sessionKey: SESSION, generation: 1, after: 1 })],
    ['an index request for generation zero', message({ type: 'journal_index_request', requestId: 'i', sessionKey: SESSION, generation: 0, epoch: 'e', after: 1 })],
    ['an index request without a request id', message({ type: 'journal_index_request', sessionKey: SESSION, generation: 1, epoch: 'e', after: 1 })],
    ['an index page above the page bound', message({ type: 'journal_index_page', requestId: 'i', sessionKey: SESSION,
      index: Array.from({ length: JOURNAL_INDEX_PAGE_MAX_ITEMS + 1 }, (_, at) => ({ ...indexEntry, itemKey: `i${at}`, seqStart: at, seqEnd: at })) })],
    ['an index page whose range is reversed', message({ type: 'journal_index_page', requestId: 'i', sessionKey: SESSION, index: [{ ...indexEntry, seqStart: 3, seqEnd: 2 }] })],
    ['an index page without a request id', message({ type: 'journal_index_page', sessionKey: SESSION, index: [indexEntry] })],
```

- [ ] **Step 2: Run the tests and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-protocol exec vitest run src/remote-host-journal.test.ts --testTimeout=10000`
Expected: FAIL (`journal_index_request`, `journal_index_page`, `stale_epoch` and `quota_exceeded` are rejected; `JOURNAL_INDEX_PAGE_MAX_ITEMS` is undefined).

- [ ] **Step 3: Implement the schema.** In `packages/agent-remote-protocol/src/remote-host-journal.ts`:

Replace

```ts
/** The most items an index in `journal_opened` lists. */
export const JOURNAL_INDEX_MAX_ITEMS = 30_000;
```

with

```ts
/** The most items an index lists, across `journal_opened` and the `journal_index_page` messages the Controller asks for. */
export const JOURNAL_INDEX_MAX_ITEMS = 100_000;
/** The most items one message of an index carries. */
export const JOURNAL_INDEX_PAGE_MAX_ITEMS = 2000;
```

Replace the refusal reasons line with

```ts
export const JOURNAL_REFUSAL_REASONS = ['fenced', 'stale_revision', 'unknown_item', 'body_missing', 'type_changed', 'duplicate_item', 'invalid', 'quota_exceeded'] as const;
```

Add to the Host-to-Relay group, after `JournalOlderDone`:

```ts
/** Asks for the entries of the index of epoch `epoch` after `after`, a `seqStart`; sent for the `indexAfter` of the last page, one request at a time. */
export const JournalIndexRequest = Type.Object({ requestId, sessionKey, generation, epoch: identity, after: SafeTimelinePosition }, object);
```

Replace the `JournalOpened` definition with the following. Its first page keeps the previous bound (the whole index limit) in this task: the landed uplink test that builds more than 2,000 entries still passes, and Task 4, which replaces that test, narrows the bound to one page.

```ts
/**
 * The journal is open. `index` is the first page of the item index. When the index does not fit it, `indexAfter` is the
 * `seqStart` of the last entry sent and the Controller pulls the rest with `journal_index_request`; the journal is open for
 * the Controller after the last page. `indexAfter` is absent when `index` is the whole index.
 */
export const JournalOpened = Type.Object({ requestId, sessionKey, generation, watermark: SafeNonNegativeInteger, epoch: identity,
  index: Type.Array(JournalIndexEntry, { maxItems: JOURNAL_INDEX_MAX_ITEMS }), indexAfter: Type.Optional(SafeTimelinePosition) }, object);
/** The answer to a `journal_index_request`: the next entries in order, and `indexAfter` when more follow. */
export const JournalIndexPage = Type.Object({ requestId, sessionKey,
  index: Type.Array(JournalIndexEntry, { maxItems: JOURNAL_INDEX_PAGE_MAX_ITEMS }), indexAfter: Type.Optional(SafeTimelinePosition) }, object);
```

Also add `'stale_epoch'` to `JOURNAL_OPEN_REFUSAL_REASONS`, so that it reads `['index_too_large', 'invalid', 'stale_epoch']`: it answers an index request for an epoch that is no longer current.

In `validJournalMessage`, after the `journal_opened` case add

```ts
    case 'journal_index_page': return (message as unknown as Static<typeof JournalIndexPage>).index.every(entry => entry.seqStart <= entry.seqEnd);
```

In `packages/agent-remote-protocol/src/remote-host-uplink.ts`, change the import on line 11 to

```ts
import { JournalAck, JournalFill, JournalFillRequest, JournalIndexPage, JournalIndexRequest, JournalOlderDone, JournalOlderRequest, JournalOpen, JournalOpened, JournalOpenRefused, JournalPublish, JournalRefused, validJournalMessage } from './remote-host-journal.js';
```

Add the envelopes: after the `journal_older_done` line

```ts
  Type.Object({ uplinkVersion: version, type: Type.Literal('journal_index_request'), ...JournalIndexRequest.properties }, object),
```

and after the `journal_opened` line

```ts
  Type.Object({ uplinkVersion: version, type: Type.Literal('journal_index_page'), ...JournalIndexPage.properties }, object),
```

Add `'journal_index_page'` to the `RemoteHostUplinkBrokerMessage` extract, after `'journal_opened'`, leaving the rest of that union as it is.

- [ ] **Step 4: Run the tests and see them pass, then the package.**

Run: `pnpm --filter @orchardworks/agent-remote-protocol exec vitest run src/remote-host-journal.test.ts --testTimeout=10000` then `pnpm --filter @orchardworks/agent-remote-protocol run test` then `pnpm --filter @orchardworks/agent-remote-protocol run typecheck` then `pnpm --filter @orchardworks/agent-remote-protocol run build`
Expected: PASS for all (50 tests in `remote-host-journal.test.ts`, 403 in the package; the hosted suite still passes, 790 tests, against the rebuilt `dist`). Then run `pnpm compatibility:update` and `pnpm compatibility:check`, and commit `packages/agent-remote-lab/compatibility.json` with the schema change. If another test names `JOURNAL_INDEX_MAX_ITEMS`, it now means the total across pages (100,000).

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-protocol/src packages/agent-remote-lab/compatibility.json
git commit -m "feat(protocol): pull the journal index page by page and refuse a publication over a quota" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: The journal core measures itself incrementally, drops live-only items, clears its head, and the store gains a catalog

**Files:**
- Modify: `packages/agent-remote-journal/src/types.ts`
- Modify: `packages/agent-remote-journal/src/journal-store.ts`
- Modify: `packages/agent-remote-journal/src/session-journal.ts`
- Create: `packages/agent-remote-journal/src/journal-bytes.test.ts`
- Modify: `packages/agent-remote-journal/src/journal-store.test.ts`

- [ ] **Step 1: Write the failing tests.** Create `packages/agent-remote-journal/src/journal-bytes.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { openJournal, text } from './journal.test-fixture.js';

const big = (character: string) => character.repeat(10_000);
const snapshot = {
  id: 's', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle' as const, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 's', status: 'idle' as const },
};

describe('what a journal knows about its own size', () => {
  it('counts resident bodies and shrinks when they are evicted', () => {
    const { journal, publish } = openJournal();
    for (const [at, key] of ['m1', 'm2', 'm3'].entries()) {
      journal.append(publish(), text(key, `d${at}`, big(String(at)), `turn-${at}`));
      journal.complete(publish(), key, `digest-${key}`);
    }
    const full = journal.residentBytes();
    expect(full).toBeGreaterThan(30_000);
    expect(journal.evict(1)).toEqual(['m1', 'm2']);
    const kept = journal.residentBytes();
    expect(kept).toBeLessThan(full - 15_000);
    expect(kept).toBeGreaterThan(10_000);
  });

  it('grows when an item is extended', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', big('a')));
    const first = journal.residentBytes();
    journal.append(publish(), text('m1', 'd2', big('b')));
    expect(journal.residentBytes()).toBeGreaterThan(first + 9_000);
  });

  it('measures only the items that changed, not the whole journal', () => {
    const { journal, publish } = openJournal();
    for (let at = 0; at < 200; at++) journal.append(publish(), text(`m${at}`, `d${at}`, 'x'.repeat(100)));
    journal.residentBytes();
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      journal.append(publish(), text('m200', 'd200', 'y'.repeat(100)));
      journal.residentBytes();
      journal.residentBytes();
      expect(stringify.mock.calls.length).toBeLessThanOrEqual(12);
    } finally { stringify.mockRestore(); }
  });

  it('reports the same size with the changes it hands to a store', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', big('a')));
    const changes = journal.takeChanges()!;
    expect(changes.bytes).toBe(journal.residentBytes());
    expect(changes.bytes).toBeGreaterThan(10_000);
    expect(changes.removed).toEqual([]);
  });

  it('knows how many items it holds, which, and whether it has a head', () => {
    const { journal, publish } = openJournal();
    expect(journal.hasHead).toBe(false);
    journal.append(publish(), text('m1', 'd1', 'one'));
    journal.append(publish(), text('m2', 'd2', 'two'));
    journal.append(publish(), text('m2', 'd3', 'more'));
    expect(journal.itemCount).toBe(2);
    expect(journal.has('m2')).toBe(true);
    expect(journal.has('m3')).toBe(false);
    journal.setHead(publish(), { snapshot, observedAt: 1 });
    expect(journal.hasHead).toBe(true);
  });

  it('clears its head and hands the change to the store', () => {
    const { journal, publish } = openJournal();
    journal.setHead(publish(), { snapshot, observedAt: 1 });
    journal.takeChanges();
    journal.clearHead();
    expect(journal.hasHead).toBe(false);
    expect(journal.takeChanges()!.meta.head).toBeUndefined();
  });
});

describe('live-only items', () => {
  const live = (key: string) => ({ ...text(key, `s-${key}`, `body ${key}`), liveOnly: true });

  it('counts them and the bytes they take', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), live('l1'));
    journal.append(publish(), text('m1', 'd1', big('a')));
    expect(journal.liveOnlyCount).toBe(1);
    expect(journal.liveOnlyBytes()).toBeGreaterThan(0);
    expect(journal.liveOnlyBytes()).toBeLessThan(journal.residentBytes() - 10_000);
  });

  it('removes the oldest beyond the cap, item and body, and tells the store', () => {
    const { journal, publish } = openJournal();
    for (const key of ['l1', 'l2', 'l3']) journal.append(publish(), live(key));
    journal.append(publish(), text('m1', 'd1', 'kept'));
    journal.takeChanges();
    expect(journal.dropOldestLiveOnly(1)).toEqual(['l1', 'l2']);
    expect(journal.index().map(entry => entry.itemKey)).toEqual(['l3', 'm1']);
    expect(journal.liveOnlyCount).toBe(1);
    const changes = journal.takeChanges()!;
    expect(changes.removed).toEqual(['l1', 'l2']);
    expect(journal.dropOldestLiveOnly(5)).toEqual([]);
  });
});
```

In `packages/agent-remote-journal/src/journal-store.test.ts`, add this helper after the imports:

```ts
const snapshot = () => ({
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle' as const, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' as const },
});
```

and, inside the `describe('MemoryJournalStore', ...)` block before its closing `});`, add:

```ts
  it('deletes the items a journal removed', async () => {
    const store = new MemoryJournalStore();
    const { journal, publish } = openJournal();
    journal.append(publish(), { ...text('l1', 's1', 'live'), liveOnly: true });
    journal.append(publish(), text('m1', 'd1', 'kept'));
    await store.apply(journal.takeChanges()!);
    journal.dropOldestLiveOnly(0);
    await store.apply(journal.takeChanges()!);
    expect((await store.load(journal.sessionKey))?.items.map(({ itemKey }) => itemKey)).toEqual(['m1']);
  });

  it('lists stored journals by key prefix with their head flag and size, and deletes them by prefix', async () => {
    const store = new MemoryJournalStore();
    const keep = openJournal();
    const other = SessionJournal.create('host-2:codex:session-1', 'epoch-2');
    const { generation } = other.claim('controller-1');
    other.append({ publisherId: 'controller-1', generation, sequence: 1 }, text('m1', 'd1', 'Hello'));
    keep.journal.append(keep.publish(), text('m1', 'd1', 'Hello'));
    keep.journal.setHead(keep.publish(), { snapshot: snapshot(), observedAt: 5 });
    await store.apply(keep.journal.takeChanges()!);
    await store.apply(other.takeChanges()!);
    expect(await store.catalog.list('host-1:')).toEqual([{ sessionKey: 'host-1:codex:session-1', hasHead: true, bytes: expect.any(Number) }]);
    expect((await store.catalog.list('')).map(({ sessionKey, hasHead }) => [sessionKey, hasHead])).toEqual([['host-1:codex:session-1', true], ['host-2:codex:session-1', false]]);
    await store.catalog.deletePrefix('host-2:');
    expect((await store.catalog.list('')).map(({ sessionKey }) => sessionKey)).toEqual(['host-1:codex:session-1']);
  });
```

- [ ] **Step 2: Run the tests and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-journal exec vitest run src/journal-bytes.test.ts src/journal-store.test.ts --testTimeout=10000`
Expected: FAIL (`residentBytes`, `clearHead`, `dropOldestLiveOnly`, `catalog` and the rest do not exist).

- [ ] **Step 3: Implement the types and the store.** In `packages/agent-remote-journal/src/types.ts`, replace the `JournalChanges` interface with

```ts
/** What changed since changes were last taken, for a store that writes incrementally. */
export interface JournalChanges {
  meta: JournalMeta;
  /** Removed first, then upserted: an item may be removed and appear again. */
  removed: string[];
  upsert: JournalItem[];
  /** True after a replacement: the store drops every item it holds for the session before the upserts. */
  replaced: boolean;
  /** An estimate of what the journal holds, as `SessionJournal.residentBytes` measures it; the store records it per session. */
  bytes: number;
}

/** What a store reports about one stored journal without loading it. */
export interface JournalListing {
  sessionKey: string;
  hasHead: boolean;
  /** The estimate that came with the journal's latest changes. */
  bytes: number;
}

/** What a store can do over many journals at once, by the prefix of their keys. */
export interface JournalCatalog {
  list(prefix: string): Promise<JournalListing[]>;
  deletePrefix(prefix: string): Promise<void>;
}
```

Replace `packages/agent-remote-journal/src/journal-store.ts` with:

```ts
import type { JournalCatalog, JournalChanges, JournalItem, JournalMeta, JournalState } from './types.js';

/** Persists journals incrementally: the store applies the changes a journal hands out. */
export interface JournalStore {
  load(sessionKey: string): Promise<JournalState | undefined>;
  apply(changes: JournalChanges): Promise<void>;
  delete(sessionKey: string): Promise<void>;
  /** Present on a store that can list and delete journals by key prefix. */
  readonly catalog?: JournalCatalog;
}

export class MemoryJournalStore implements JournalStore {
  private readonly sessions = new Map<string, { meta: JournalMeta; items: Map<string, JournalItem>; bytes: number }>();

  readonly catalog: JournalCatalog = {
    list: async prefix => [...this.sessions]
      .filter(([sessionKey]) => sessionKey.startsWith(prefix))
      .map(([sessionKey, session]) => ({ sessionKey, hasHead: session.meta.head !== undefined, bytes: session.bytes }))
      .sort((left, right) => (left.sessionKey < right.sessionKey ? -1 : left.sessionKey > right.sessionKey ? 1 : 0)),
    deletePrefix: async prefix => {
      for (const sessionKey of [...this.sessions.keys()]) if (sessionKey.startsWith(prefix)) this.sessions.delete(sessionKey);
    },
  };

  async load(sessionKey: string): Promise<JournalState | undefined> {
    const session = this.sessions.get(sessionKey);
    if (!session) return undefined;
    const items = [...session.items.values()].map(item => structuredClone(item)).sort((left, right) => left.seqStart - right.seqStart);
    return { meta: structuredClone(session.meta), items };
  }

  async apply(changes: JournalChanges): Promise<void> {
    const existing = this.sessions.get(changes.meta.sessionKey);
    const items = existing && !changes.replaced ? existing.items : new Map<string, JournalItem>();
    for (const key of changes.removed) items.delete(key);
    for (const item of changes.upsert) items.set(item.itemKey, structuredClone(item));
    this.sessions.set(changes.meta.sessionKey, { meta: structuredClone(changes.meta), items, bytes: changes.bytes });
  }

  async delete(sessionKey: string): Promise<void> {
    this.sessions.delete(sessionKey);
  }
}
```

- [ ] **Step 4: Implement the journal changes.** In `packages/agent-remote-journal/src/session-journal.ts`:

(a) Add fields after `protected replaced = false;`:

```ts
  /** Items removed since changes were last taken. */
  protected readonly removedKeys = new Set<string>();
  /** The measured size of each item record, a running total of them, and the items not measured since they changed. */
  protected readonly sizes = new Map<string, number>();
  protected sizedTotal = 0;
  protected readonly unmeasured = new Set<string>();
```

(b) In the constructor, after the line `for (const item of this.items) this.byKey.set(item.itemKey, item);` add

```ts
    for (const item of this.items) this.unmeasured.add(item.itemKey);
```

(c) First replace every `this.dirty.add(` in the file with `this.touch(` (in `append`, `complete`, `seal`, `alias`, `correct`, `prepend`, `evict`, `fill` and `insertLast`; the one in `evict` reads `this.dirty.add(key)` and the one in `fill` reads `this.dirty.add(itemKey)`). Then add the method (near the other protected helpers, before `protected duplicate`):

```ts
  /** Marks an item for the store and for measuring. */
  protected touch(itemKey: string): void {
    this.dirty.add(itemKey);
    this.unmeasured.add(itemKey);
  }
```

(d) In `replace`, after `this.dirty.clear();` add

```ts
    this.sizes.clear();
    this.sizedTotal = 0;
    this.unmeasured.clear();
    this.removedKeys.clear();
```

(e) Replace `takeChanges` with

```ts
  /** What changed since the last call, or undefined when nothing did. */
  takeChanges(): JournalChanges | undefined {
    if (!this.metaDirty && this.dirty.size === 0 && this.removedKeys.size === 0 && !this.replaced) return undefined;
    const upsert = [...this.dirty]
      .map(key => this.byKey.get(key))
      .filter((item): item is JournalItem => item !== undefined)
      .map(item => structuredClone(item));
    const changes: JournalChanges = { meta: structuredClone(this.meta), removed: [...this.removedKeys], upsert, replaced: this.replaced, bytes: this.residentBytes() };
    this.dirty.clear();
    this.removedKeys.clear();
    this.metaDirty = false;
    this.replaced = false;
    return changes;
  }
```

(f) Add these members after the `publisher` getter:

```ts
  /** How many items the journal holds, resident or evicted. */
  get itemCount(): number { return this.items.length; }

  has(itemKey: string): boolean { return this.byKey.has(itemKey); }

  /** Whether the Controller has published a head; cheaper than reading it. */
  get hasHead(): boolean { return this.meta.head !== undefined; }

  /** Takes the journal out of serving until a later head is published. The Relay does this when a quota refuses a publication. */
  clearHead(): void {
    delete this.meta.head;
    this.metaDirty = true;
  }

  /** How many live-only items the journal holds. */
  get liveOnlyCount(): number {
    let count = 0;
    for (const item of this.items) if (item.liveOnly) count += 1;
    return count;
  }

  /**
   * An estimate of what the journal holds: the length of its meta and of each item record as stored, in JSON characters.
   * Only items that changed since the last call are measured, so the cost follows the change, not the journal.
   */
  residentBytes(): number {
    for (const key of this.unmeasured) {
      const item = this.byKey.get(key);
      const before = this.sizes.get(key) ?? 0;
      const size = item ? JSON.stringify(item).length : 0;
      if (item) this.sizes.set(key, size); else this.sizes.delete(key);
      this.sizedTotal += size - before;
    }
    this.unmeasured.clear();
    return this.sizedTotal + JSON.stringify(this.meta).length;
  }

  /** The estimated size of the live-only items, which a replacement carries over. */
  liveOnlyBytes(): number {
    this.residentBytes();
    let total = 0;
    for (const item of this.items) if (item.liveOnly) total += this.sizes.get(item.itemKey) ?? 0;
    return total;
  }

  /**
   * Removes the oldest live-only items beyond `keep`, skeleton and body: nothing can rebuild them, so their place in the
   * sequence goes with them. Returns their keys.
   */
  dropOldestLiveOnly(keep: number): string[] {
    const live = this.items.filter(item => item.liveOnly);
    const doomed = new Set(live.slice(0, Math.max(0, live.length - keep)).map(item => item.itemKey));
    if (doomed.size === 0) return [];
    const remaining = this.items.filter(item => !doomed.has(item.itemKey));
    this.items.length = 0;
    for (const item of remaining) this.items.push(item);
    for (const key of doomed) {
      this.byKey.delete(key);
      this.dirty.delete(key);
      this.removedKeys.add(key);
      this.unmeasured.add(key);
    }
    return [...doomed];
  }
```

- [ ] **Step 5: Run the tests and see them pass, then typecheck and rebuild.**

Run: `pnpm --filter @orchardworks/agent-remote-journal run test` then `pnpm --filter @orchardworks/agent-remote-journal run typecheck` then `pnpm --filter @orchardworks/agent-remote-journal run build`
Expected: PASS for all three (151 tests in 12 files). Then run the hosted suite against the rebuilt `dist` (`pnpm --filter @orchardworks/agent-remote-hosted exec vitest run --testTimeout=20000`, 790 tests), and `pnpm compatibility:update` then `pnpm compatibility:check`: the digest covers the journal sources, so commit `packages/agent-remote-lab/compatibility.json` with this task.

- [ ] **Step 6: Commit.**

```bash
git add packages/agent-remote-journal/src packages/agent-remote-lab/compatibility.json
git commit -m "feat(journal): measure size incrementally, drop live-only items, clear the head, and let a store list and delete by key prefix" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---
### Task 3: The SQLite journal store

**Files:**
- Create: `packages/agent-remote-journal-sqlite/package.json`
- Create: `packages/agent-remote-journal-sqlite/tsconfig.json`
- Create: `packages/agent-remote-journal-sqlite/src/index.ts`
- Create: `packages/agent-remote-journal-sqlite/src/sql-journal-store.ts`
- Create: `packages/agent-remote-journal-sqlite/src/node-sqlite.ts`
- Create: `packages/agent-remote-journal-sqlite/src/sql-journal-store.test.ts`

- [ ] **Step 1: Create the package files.** `packages/agent-remote-journal-sqlite/package.json`:

```json
{
  "name": "@orchardworks/agent-remote-journal-sqlite",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "SQLite storage for Relay session journals: one store over a small SQL port, and its Node binding.",
  "engines": { "node": ">=22.13" },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./node": {
      "types": "./dist/node-sqlite.d.ts",
      "import": "./dist/node-sqlite.js"
    }
  },
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --testTimeout=10000"
  },
  "dependencies": {
    "@orchardworks/agent-remote-journal": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "24.13.3",
    "typescript": "^5.7.0",
    "vitest": "4.1.11"
  }
}
```

`packages/agent-remote-journal-sqlite/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "types": ["node"],
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/agent-remote-journal-sqlite/src/index.ts`:

```ts
export { SqlJournalStore, JOURNAL_CHUNK_BYTES, type JournalSqlDatabase, type SqlValue } from './sql-journal-store.js';
```

The Node binding is deliberately not exported here: `src/node-sqlite.ts` is reached only through `@orchardworks/agent-remote-journal-sqlite/node`, so a bundle that imports the store alone, such as a Durable Object's, never meets `node:sqlite`.

- [ ] **Step 2: Link the package.**

Run: `pnpm install --prefer-offline` (`--offline` lacks metadata for vitest's dependencies)
Expected: it links `packages/agent-remote-journal-sqlite` into the workspace and adds its importer to `pnpm-lock.yaml`. It also rewrites unrelated `resolution:` lines; restore the lockfile from git and keep only the new `packages/agent-remote-journal-sqlite:` importer block (placed before `packages/agent-remote-lab:`), then check `pnpm install --frozen-lockfile --prefer-offline`.

- [ ] **Step 3: Write the failing tests.** `packages/agent-remote-journal-sqlite/src/sql-journal-store.test.ts`:

```ts
import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bodyFromRow, MemoryJournalStore, SessionJournal, type JournalCatalog, type JournalRowInput, type JournalStore } from '@orchardworks/agent-remote-journal';
import { afterEach, describe, expect, it } from 'vitest';

import { openNodeJournalDatabase } from './node-sqlite.js';
import { SqlJournalStore } from './sql-journal-store.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const row = (itemKey: string, text: string, turnId = 'turn-1'): JournalRowInput => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:${text.length}`, occurredAt: 1_725_000_000_000, turnId,
  item: { type: 'assistant_message', text, messageId: itemKey },
});
const snapshot = () => ({
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle' as const, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' as const },
});

/** A journal claimed by one publisher, with a function that numbers its publications. */
function openJournal(sessionKey = 'host-1:codex:session-1') {
  const journal = SessionJournal.create(sessionKey, 'epoch-1');
  const { generation } = journal.claim('controller-1');
  let sequence = 0;
  return { journal, at: () => ({ publisherId: 'controller-1', generation, sequence: ++sequence }) };
}

async function memoryDatabase() {
  const database = await openNodeJournalDatabase(':memory:');
  cleanups.push(() => database.close());
  return database;
}

type CatalogedStore = JournalStore & { catalog: JournalCatalog };
const stores: Array<[string, () => Promise<CatalogedStore>]> = [
  ['the memory store', async () => new MemoryJournalStore()],
  ['the SQLite store', async () => new SqlJournalStore(await memoryDatabase())],
  ['the SQLite store with 64-byte chunks', async () => new SqlJournalStore(await memoryDatabase(), { chunkBytes: 64 })],
];

describe.each(stores)('%s', (_name, create) => {
  it('restores a journal from the changes it applied', async () => {
    const store = await create();
    const { journal, at } = openJournal();
    journal.append(at(), row('m1', 'Hel'));
    await store.apply(journal.takeChanges()!);
    journal.append(at(), row('m1', 'lo'));
    journal.append(at(), row('m2', 'Next'));
    await store.apply(journal.takeChanges()!);
    const restored = new SessionJournal((await store.load(journal.sessionKey))!);
    expect(restored.index()).toEqual(journal.index());
    expect(restored.cursor).toEqual(journal.cursor);
    const request = { requestId: 'r', agentId: 'a', direction: 'tail' as const, limit: 10 };
    expect(restored.page(request, { olderBeyondJournal: false })).toEqual(journal.page(request, { olderBeyondJournal: false }));
  });

  it('knows nothing of a journal it never stored', async () => {
    expect(await (await create()).load('host-1:codex:never')).toBeUndefined();
  });

  it('drops the old items after a replacement and deletes a journal', async () => {
    const store = await create();
    const { journal, at } = openJournal();
    journal.append(at(), row('m1', 'Old'));
    journal.complete(at(), 'm1', 'digest-1');
    await store.apply(journal.takeChanges()!);
    journal.replace(at(), [{ row: row('m2', 'Fresh'), digest: 'digest-2' }], 0);
    await store.apply(journal.takeChanges()!);
    expect((await store.load(journal.sessionKey))?.items.map(({ itemKey }) => itemKey)).toEqual(['m2']);
    await store.delete(journal.sessionKey);
    expect(await store.load(journal.sessionKey)).toBeUndefined();
  });

  it('restores an equivalent journal after evict, fill and prepend', async () => {
    const store = await create();
    const { journal, at } = openJournal();
    journal.append(at(), row('m1', 'first', 'turn-1'));
    journal.complete(at(), 'm1', 'digest-1');
    journal.append(at(), row('m2', 'second', 'turn-2'));
    journal.setHead(at(), { snapshot: snapshot(), observedAt: 5 });
    await store.apply(journal.takeChanges()!);
    journal.evict(1);
    journal.prepend(at(), [{ row: row('m0', 'zeroth', 'turn-0'), digest: 'digest-0' }]);
    await store.apply(journal.takeChanges()!);
    journal.fill('m1', bodyFromRow(row('m1', 'first', 'turn-1')), 'digest-1');
    await store.apply(journal.takeChanges()!);
    expect(new SessionJournal((await store.load(journal.sessionKey))!).state()).toEqual(journal.state());
  });

  it('deletes the items a journal removed', async () => {
    const store = await create();
    const { journal, at } = openJournal();
    journal.append(at(), { ...row('l1', 'live'), liveOnly: true });
    journal.append(at(), row('m1', 'kept'));
    await store.apply(journal.takeChanges()!);
    journal.dropOldestLiveOnly(0);
    await store.apply(journal.takeChanges()!);
    expect((await store.load(journal.sessionKey))?.items.map(({ itemKey }) => itemKey)).toEqual(['m1']);
  });

  it('keeps an item far larger than a chunk, with characters that span chunk boundaries', async () => {
    const store = await create();
    const { journal, at } = openJournal();
    const text = '😀é'.repeat(100_000);
    journal.append(at(), row('big', text));
    await store.apply(journal.takeChanges()!);
    const restored = (await store.load(journal.sessionKey))!;
    expect(restored.items[0]?.body?.item).toMatchObject({ text });
  });

  it('lists journals by key prefix with their head flag and size, and deletes them by prefix', async () => {
    const store = await create();
    const first = openJournal('host-1:codex:session-1');
    const second = openJournal('host-2:codex:session-1');
    first.journal.append(first.at(), row('m1', 'Hello'));
    first.journal.setHead(first.at(), { snapshot: snapshot(), observedAt: 5 });
    second.journal.append(second.at(), row('m1', 'Hello'));
    await store.apply(first.journal.takeChanges()!);
    await store.apply(second.journal.takeChanges()!);
    expect(await store.catalog.list('host-1:')).toEqual([{ sessionKey: 'host-1:codex:session-1', hasHead: true, bytes: first.journal.residentBytes() }]);
    expect((await store.catalog.list('')).map(({ sessionKey, hasHead }) => [sessionKey, hasHead])).toEqual([['host-1:codex:session-1', true], ['host-2:codex:session-1', false]]);
    await store.catalog.deletePrefix('host-2:');
    expect((await store.catalog.list('')).map(({ sessionKey }) => sessionKey)).toEqual(['host-1:codex:session-1']);
    expect(await store.load('host-2:codex:session-1')).toBeUndefined();
    expect(await store.load('host-1:codex:session-1')).toBeDefined();
  });

  it('does not take a key that merely starts like another Host\'s prefix', async () => {
    const store = await create();
    const first = openJournal('host-1:codex:session-1');
    const second = openJournal('host-10:codex:session-1');
    first.journal.append(first.at(), row('m1', 'Hello'));
    second.journal.append(second.at(), row('m1', 'Hello'));
    await store.apply(first.journal.takeChanges()!);
    await store.apply(second.journal.takeChanges()!);
    expect((await store.catalog.list('host-1:')).map(({ sessionKey }) => sessionKey)).toEqual(['host-1:codex:session-1']);
    await store.catalog.deletePrefix('host-1:');
    expect((await store.catalog.list('')).map(({ sessionKey }) => sessionKey)).toEqual(['host-10:codex:session-1']);
  });
});

describe('the SQLite store over its file', () => {
  it('splits every stored value into chunks no larger than the chunk size and leaves nothing behind after a delete', async () => {
    const database = await memoryDatabase();
    const store = new SqlJournalStore(database, { chunkBytes: 100 });
    const { journal, at } = openJournal();
    journal.append(at(), row('m1', 'x'.repeat(1000)));
    await store.apply(journal.takeChanges()!);
    const [stats] = database.all<{ size: number; chunks: number }>('SELECT max(length(bytes)) AS size, count(*) AS chunks FROM journal_chunks');
    expect(stats!.size).toBeLessThanOrEqual(100);
    expect(stats!.chunks).toBeGreaterThan(10);
    await store.delete(journal.sessionKey);
    expect(database.all<{ rows: number }>('SELECT (SELECT count(*) FROM journal_chunks) + (SELECT count(*) FROM journal_items) + (SELECT count(*) FROM journal_sessions) AS rows')[0]!.rows).toBe(0);
  });

  it('applies a change atomically', async () => {
    const store = new SqlJournalStore(await memoryDatabase());
    const { journal, at } = openJournal();
    journal.append(at(), row('m1', 'Hello'));
    await store.apply(journal.takeChanges()!);
    const before = await store.load(journal.sessionKey);
    journal.append(at(), row('m2', 'World'));
    const changes = journal.takeChanges()!;
    const unwritable = { ...changes, upsert: [{ ...changes.upsert[0]!, keptBody: { big: 10n } as never }] };
    await expect(store.apply(unwritable)).rejects.toThrow();
    expect(await store.load(journal.sessionKey)).toEqual(before);
  });

  it('keeps journals in its file across a restart, readable by its owner only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arc-journal-store-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, 'nested', 'journals.sqlite');
    const first = await openNodeJournalDatabase(file);
    const { journal, at } = openJournal();
    journal.append(at(), row('m1', 'Hello'));
    await new SqlJournalStore(first).apply(journal.takeChanges()!);
    first.close();
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const second = await openNodeJournalDatabase(file);
    cleanups.push(() => second.close());
    expect((await new SqlJournalStore(second).load(journal.sessionKey))?.items.map(({ itemKey }) => itemKey)).toEqual(['m1']);
  });

  it('refuses a database written by a newer format', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arc-journal-store-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, 'journals.sqlite');
    const first = await openNodeJournalDatabase(file);
    new SqlJournalStore(first);
    first.run('UPDATE journal_schema SET version = 99');
    first.close();
    const second = await openNodeJournalDatabase(file);
    cleanups.push(() => second.close());
    expect(() => new SqlJournalStore(second)).toThrow(/version 99/);
  });

  it('rejects a chunk size the platform cannot store', async () => {
    const database = await memoryDatabase();
    expect(() => new SqlJournalStore(database, { chunkBytes: 0 })).toThrow(RangeError);
    expect(() => new SqlJournalStore(database, { chunkBytes: 262_145 })).toThrow(RangeError);
  });
});
```

- [ ] **Step 4: Run the tests and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-journal-sqlite exec vitest run --testTimeout=10000`
Expected: FAIL (`./node-sqlite.js` and `./sql-journal-store.js` do not exist).

- [ ] **Step 5: Implement the store.** `packages/agent-remote-journal-sqlite/src/sql-journal-store.ts`:

```ts
import type { JournalCatalog, JournalChanges, JournalItem, JournalMeta, JournalState, JournalStore } from '@orchardworks/agent-remote-journal';

export type SqlValue = string | number | null | Uint8Array;

/**
 * The synchronous SQLite surface the store needs. Node's `node:sqlite` and a Durable Object's storage both provide it.
 * A binary column reads back as a `Uint8Array`.
 */
export interface JournalSqlDatabase {
  run(sql: string, ...params: SqlValue[]): void;
  all<Row extends Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): Row[];
  /** Runs `work` in one transaction: it commits when `work` returns and rolls back when it throws. Transactions do not nest. */
  transaction<T>(work: () => T): T;
}

/** The size at which a stored value is split: the convention of the Cloudflare state storage, and below a Durable Object's value limit. */
export const JOURNAL_CHUNK_BYTES = 256 * 1024;
const SCHEMA_VERSION = 1;
const META_PART = 'm';
const itemPart = (itemKey: string) => `i:${itemKey}`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function splitValue(value: unknown, chunkBytes: number): Uint8Array[] {
  const bytes = encoder.encode(JSON.stringify(value));
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += chunkBytes) chunks.push(bytes.subarray(at, at + chunkBytes));
  return chunks;
}

function joinChunks(chunks: readonly Uint8Array[]): unknown {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return JSON.parse(decoder.decode(bytes));
}

const TABLES = ['journal_chunks', 'journal_items', 'journal_sessions'] as const;

/** The key range of a prefix: every key from the prefix up to, not including, the prefix with its last character raised. */
function prefixRange(prefix: string): { where: string; params: string[] } {
  if (prefix === '') return { where: '1 = 1', params: [] };
  const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  return { where: 'session_key >= ? AND session_key < ?', params: [prefix, end] };
}

/**
 * Stores journals in three tables: one row per session, one per item (its place in the sequence), and the chunks that
 * hold the JSON of the session's meta and of each item. A change is applied in one transaction.
 */
export class SqlJournalStore implements JournalStore {
  private readonly chunkBytes: number;

  readonly catalog: JournalCatalog = {
    list: async prefix => {
      const { where, params } = prefixRange(prefix);
      return this.db.all<{ session_key: string; has_head: number; bytes: number }>(
        `SELECT session_key, has_head, bytes FROM journal_sessions WHERE ${where} ORDER BY session_key`, ...params)
        .map(row => ({ sessionKey: row.session_key, hasHead: row.has_head === 1, bytes: row.bytes }));
    },
    deletePrefix: async prefix => {
      const { where, params } = prefixRange(prefix);
      this.db.transaction(() => {
        for (const table of TABLES) this.db.run(`DELETE FROM ${table} WHERE ${where}`, ...params);
      });
    },
  };

  constructor(private readonly db: JournalSqlDatabase, options: { chunkBytes?: number } = {}) {
    this.chunkBytes = options.chunkBytes ?? JOURNAL_CHUNK_BYTES;
    if (!Number.isInteger(this.chunkBytes) || this.chunkBytes < 1 || this.chunkBytes > JOURNAL_CHUNK_BYTES) {
      throw new RangeError(`The journal chunk size must be an integer from 1 to ${JOURNAL_CHUNK_BYTES}.`);
    }
    db.transaction(() => {
      db.run('CREATE TABLE IF NOT EXISTS journal_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)');
      db.run(`CREATE TABLE IF NOT EXISTS journal_sessions (
        session_key TEXT PRIMARY KEY, has_head INTEGER NOT NULL, bytes INTEGER NOT NULL, meta_chunks INTEGER NOT NULL)`);
      db.run(`CREATE TABLE IF NOT EXISTS journal_items (
        session_key TEXT NOT NULL, item_key TEXT NOT NULL, seq_start INTEGER NOT NULL, chunks INTEGER NOT NULL,
        PRIMARY KEY (session_key, item_key)) WITHOUT ROWID`);
      db.run('CREATE INDEX IF NOT EXISTS journal_items_order ON journal_items (session_key, seq_start)');
      db.run(`CREATE TABLE IF NOT EXISTS journal_chunks (
        session_key TEXT NOT NULL, part TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        bytes BLOB NOT NULL CHECK (typeof(bytes) = 'blob' AND length(bytes) BETWEEN 1 AND ${JOURNAL_CHUNK_BYTES}),
        PRIMARY KEY (session_key, part, ordinal))`);
      const [schema] = db.all<{ version: number }>('SELECT version FROM journal_schema WHERE id = 1');
      if (!schema) db.run('INSERT INTO journal_schema (id, version) VALUES (1, ?)', SCHEMA_VERSION);
      else if (schema.version !== SCHEMA_VERSION) {
        throw new Error(`The journal database has schema version ${String(schema.version)}; this build reads version ${String(SCHEMA_VERSION)}.`);
      }
    });
  }

  async load(sessionKey: string): Promise<JournalState | undefined> {
    const [session] = this.db.all<{ meta_chunks: number }>('SELECT meta_chunks FROM journal_sessions WHERE session_key = ?', sessionKey);
    if (!session) return undefined;
    const parts = new Map<string, Uint8Array[]>();
    for (const chunk of this.db.all<{ part: string; bytes: Uint8Array }>('SELECT part, bytes FROM journal_chunks WHERE session_key = ? ORDER BY part, ordinal', sessionKey)) {
      const list = parts.get(chunk.part);
      if (list) list.push(chunk.bytes);
      else parts.set(chunk.part, [chunk.bytes]);
    }
    const meta = parts.get(META_PART);
    if (!meta) throw new Error(`The stored journal of ${sessionKey} has no meta.`);
    const items = this.db.all<{ item_key: string }>('SELECT item_key FROM journal_items WHERE session_key = ? ORDER BY seq_start', sessionKey).map(({ item_key }) => {
      const chunks = parts.get(itemPart(item_key));
      if (!chunks) throw new Error(`The stored journal of ${sessionKey} has no record of item ${item_key}.`);
      return joinChunks(chunks) as JournalItem;
    });
    return { meta: joinChunks(meta) as JournalMeta, items };
  }

  async apply(changes: JournalChanges): Promise<void> {
    const sessionKey = changes.meta.sessionKey;
    this.db.transaction(() => {
      if (changes.replaced) {
        this.db.run('DELETE FROM journal_chunks WHERE session_key = ? AND part <> ?', sessionKey, META_PART);
        this.db.run('DELETE FROM journal_items WHERE session_key = ?', sessionKey);
      }
      for (const itemKey of changes.removed) {
        this.db.run('DELETE FROM journal_chunks WHERE session_key = ? AND part = ?', sessionKey, itemPart(itemKey));
        this.db.run('DELETE FROM journal_items WHERE session_key = ? AND item_key = ?', sessionKey, itemKey);
      }
      const meta = splitValue(changes.meta, this.chunkBytes);
      this.writeChunks(sessionKey, META_PART, meta);
      this.db.run(`INSERT INTO journal_sessions (session_key, has_head, bytes, meta_chunks) VALUES (?, ?, ?, ?)
        ON CONFLICT (session_key) DO UPDATE SET has_head = excluded.has_head, bytes = excluded.bytes, meta_chunks = excluded.meta_chunks`,
      sessionKey, changes.meta.head === undefined ? 0 : 1, Math.round(changes.bytes), meta.length);
      for (const item of changes.upsert) {
        const chunks = splitValue(item, this.chunkBytes);
        this.writeChunks(sessionKey, itemPart(item.itemKey), chunks);
        this.db.run(`INSERT INTO journal_items (session_key, item_key, seq_start, chunks) VALUES (?, ?, ?, ?)
          ON CONFLICT (session_key, item_key) DO UPDATE SET seq_start = excluded.seq_start, chunks = excluded.chunks`,
        sessionKey, item.itemKey, item.seqStart, chunks.length);
      }
    });
  }

  async delete(sessionKey: string): Promise<void> {
    this.db.transaction(() => {
      for (const table of TABLES) this.db.run(`DELETE FROM ${table} WHERE session_key = ?`, sessionKey);
    });
  }

  private writeChunks(sessionKey: string, part: string, chunks: readonly Uint8Array[]): void {
    this.db.run('DELETE FROM journal_chunks WHERE session_key = ? AND part = ?', sessionKey, part);
    chunks.forEach((bytes, ordinal) => this.db.run('INSERT INTO journal_chunks (session_key, part, ordinal, bytes) VALUES (?, ?, ?, ?)', sessionKey, part, ordinal, bytes));
  }
}
```

`packages/agent-remote-journal-sqlite/src/node-sqlite.ts`:

```ts
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import type { StatementSync } from 'node:sqlite';

import type { JournalSqlDatabase, SqlValue } from './sql-journal-store.js';

export interface NodeJournalDatabase extends JournalSqlDatabase {
  close(): void;
}

/**
 * Opens, and creates when missing, the journal database file with Node's built-in `node:sqlite` (Node 22.13 or later).
 * The directory is private to its owner and so is the file. Pass `:memory:` for a database that lives as long as the handle.
 * The module is imported here, not at the top of the file, so a Relay that never enables journals never loads it.
 */
export async function openNodeJournalDatabase(file: string): Promise<NodeJournalDatabase> {
  let sqlite: typeof import('node:sqlite');
  try { sqlite = await import('node:sqlite'); }
  catch (error) { throw new Error('Session journals need Node 22.13 or later: the built-in node:sqlite module is unavailable.', { cause: error }); }
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    closeSync(openSync(file, 'a', 0o600));
    chmodSync(file, 0o600);
  }
  const database = new sqlite.DatabaseSync(file);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA synchronous = FULL');
  database.exec('PRAGMA busy_timeout = 5000');
  const statements = new Map<string, StatementSync>();
  const statement = (sql: string): StatementSync => {
    let prepared = statements.get(sql);
    if (!prepared) { prepared = database.prepare(sql); statements.set(sql, prepared); }
    return prepared;
  };
  return {
    run(sql, ...params) { statement(sql).run(...params); },
    all<Row extends Record<string, SqlValue>>(sql: string, ...params: SqlValue[]) { return statement(sql).all(...params) as unknown as Row[]; },
    transaction<T>(work: () => T): T {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        database.exec('COMMIT');
        return result;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch { /* the transaction had already ended */ }
        throw error;
      }
    },
    close() { database.close(); },
  };
}
```

- [ ] **Step 6: Run the tests.**

Run: `pnpm --filter @orchardworks/agent-remote-journal-sqlite exec vitest run --testTimeout=10000`
Expected: PASS on the default Node (29 tests). Then run the same with Node 22: `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-journal-sqlite exec vitest run --testTimeout=10000`
Expected: PASS (an `ExperimentalWarning: SQLite is an experimental feature` line is printed once).

- [ ] **Step 7: Typecheck and build.**

Run: `pnpm --filter @orchardworks/agent-remote-journal-sqlite run typecheck` then `pnpm --filter @orchardworks/agent-remote-journal-sqlite run build`
Expected: PASS. `dist/index.js` must not mention `node:sqlite`:

Run: `grep -c "node:sqlite" packages/agent-remote-journal-sqlite/dist/index.js packages/agent-remote-journal-sqlite/dist/sql-journal-store.js`
Expected: `0` for both files. Then run `pnpm compatibility:update` and `pnpm compatibility:check`: the digest lists the new package, so commit `packages/agent-remote-lab/compatibility.json` too.

- [ ] **Step 8: Commit.**

```bash
git add packages/agent-remote-journal-sqlite pnpm-lock.yaml packages/agent-remote-lab/compatibility.json
git commit -m "feat(journal-sqlite): store journals in SQLite behind a small SQL port" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: The journal service and the uplink: bounds, head index, retention rule, quota handling, pulled index pages

**Files:**
- Create: `packages/agent-remote-hosted/src/journal-head-index.ts`
- Create: `packages/agent-remote-hosted/src/journal-index-pages.ts`, `journal-index-pages.test.ts`
- Rewrite: `packages/agent-remote-hosted/src/host-journals.ts`
- Create: `packages/agent-remote-hosted/src/host-journals-bounds.test.ts`
- Modify: `packages/agent-remote-hosted/src/host-journals.test.ts`, `journal-uplink.ts`, `journal-uplink.test.ts`, `broker-journals.test.ts`
- Modify: `packages/agent-remote-hosted/src/relay-diagnostics.ts`, `relay-diagnostics.test.ts`, `index.ts`

The service's `open` changes shape in this task, and its only caller is the uplink, so both change together and the existing tests of both move with them. `host-journals.ts` is the landed version (with `events`, `status`); this task keeps every behaviour of it and adds the new ones, so the file is replaced whole.

- [ ] **Step 1: Write the failing tests for the new service behaviour.** `packages/agent-remote-hosted/src/host-journals-bounds.test.ts`:

```ts
import { MemoryJournalStore, type JournalStore } from '@orchardworks/agent-remote-journal';
import type { JournalPublishEntry } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { createHostJournals, type HostJournals, type HostJournalsOptions, type JournalOpened } from './host-journals.js';

const HOST = 'host-1';
const SESSION = 'codex:thread-1';
const KEY = `${HOST}:${SESSION}`;
const LIMITS = { maxIndexItems: 1_000_000, pageItems: 1_000_000 };
const rowOf = (itemKey: string, text: string, turn = 1) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:${text.length}`, occurredAt: 1_725_000_000_000, turnId: `turn-${turn}`,
  item: { type: 'assistant_message' as const, text, messageId: itemKey },
});
const append = (sequence: number, itemKey: string, text: string, turn = 1): JournalPublishEntry => ({ sequence, op: 'append', row: rowOf(itemKey, text, turn) });
const live = (sequence: number, itemKey: string, text = 'live'): JournalPublishEntry => ({ sequence, op: 'append', row: { ...rowOf(itemKey, text, 0), liveOnly: true } });
const complete = (sequence: number, itemKey: string): JournalPublishEntry => ({ sequence, op: 'complete', itemKey, digest: `digest-${itemKey}` });
const snapshot = {
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle' as const, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' as const },
};
const head = (sequence: number): JournalPublishEntry => ({ sequence, op: 'head', head: { snapshot, observedAt: 5 } });

/** A store that counts how often a journal and a listing are read from it, and can hold a listing back after it was read, so the reader holds a listing that later changes make stale. */
function countingStore() {
  const memory = new MemoryJournalStore();
  const loads: string[] = [];
  const lists: string[] = [];
  let gate: Promise<void> | undefined;
  const store: JournalStore = {
    load: key => { loads.push(key); return memory.load(key); }, apply: changes => memory.apply(changes), delete: key => memory.delete(key),
    catalog: { list: async prefix => { lists.push(prefix); const listing = await memory.catalog.list(prefix); await gate; return listing; }, deletePrefix: prefix => memory.catalog.deletePrefix(prefix) },
  };
  return { store, memory, loads, lists, holdLists: () => { let release!: () => void; gate = new Promise<void>(resolve => { release = resolve; }); return () => { gate = undefined; release(); }; } };
}

function fixture(options: Partial<Omit<HostJournalsOptions, 'store'>> & { store?: JournalStore } = {}) {
  const counted = countingStore();
  const store = options.store ?? counted.store;
  return { ...counted, store, journals: createHostJournals({ now: () => 1_000, ...options, store }) };
}
const open = (journals: HostJournals, hostId: string, sessionKey: string, publisherId = 'controller-1') =>
  journals.open(hostId, sessionKey, publisherId, LIMITS) as Promise<JournalOpened>;
const resident = async (store: JournalStore, key = KEY) => (await store.load(key))!.items.map(item => [item.itemKey, item.body !== null] as const);

describe('the journal cache', () => {
  it('keeps at most the configured number of journals and reads an evicted one from the store again', async () => {
    const { journals, loads } = fixture({ cache: { maxJournals: 2 } });
    for (const session of ['codex:s1', 'codex:s2', 'codex:s3']) await open(journals, HOST, session);
    expect(loads).toHaveLength(3);
    await journals.status(HOST, 'codex:s1');
    expect(loads).toHaveLength(4);
    await journals.status(HOST, 'codex:s3');
    expect(loads).toHaveLength(4);
  });

  it('keeps no more than the configured size, apart from the journal in use', async () => {
    const { journals, loads } = fixture({ cache: { maxBytes: 1 } });
    await open(journals, HOST, 'codex:s1');
    await open(journals, HOST, 'codex:s2');
    expect(loads).toHaveLength(2);
    await journals.status(HOST, 'codex:s1');
    expect(loads).toHaveLength(3);
  });

  it('rejects limits that are not whole numbers', () => {
    expect(() => createHostJournals({ store: new MemoryJournalStore(), now: () => 1, limits: { sessionBytes: 1.5 } })).toThrow(RangeError);
    expect(() => createHostJournals({ store: new MemoryJournalStore(), now: () => 1, cache: { maxJournals: -1 } })).toThrow(RangeError);
  });
});

describe('the safety limits', () => {
  it('refuses a row that does not fit the session budget, still accepts completion, and evicts bodies to make room', async () => {
    const { journals, store } = fixture({ limits: { sessionBytes: 3500 } });
    await open(journals, HOST, SESSION);
    const big = 'x'.repeat(2000);
    expect((await journals.publish(HOST, SESSION, 1, [append(1, 'm1', big, 1)])).refusal).toBeUndefined();
    const refused = await journals.publish(HOST, SESSION, 1, [append(2, 'm2', big, 2)]);
    expect(refused.refusal).toEqual({ sequence: 2, reason: 'quota_exceeded' });
    expect(refused.events).toEqual([]);
    expect((await journals.publish(HOST, SESSION, 1, [complete(2, 'm1')])).refusal).toBeUndefined();
    expect((await journals.publish(HOST, SESSION, 1, [append(3, 'm2', big, 2)])).refusal).toBeUndefined();
    expect(await resident(store)).toEqual([['m1', false], ['m2', true]]);
  });

  it('refuses a new item beyond the item limit but lets an item that exists grow', async () => {
    const { journals } = fixture({ limits: { sessionItems: 2 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), append(2, 'm2', 'b')]);
    expect((await journals.publish(HOST, SESSION, 1, [append(3, 'm3', 'c')])).refusal).toEqual({ sequence: 3, reason: 'quota_exceeded' });
    const grown = await journals.publish(HOST, SESSION, 1, [append(3, 'm1', 'more')]);
    expect(grown.refusal).toBeUndefined();
    expect(grown.events).toHaveLength(1);
  });

  it('refuses growth of a Host over its quota without touching another Host', async () => {
    const { journals } = fixture({ limits: { hostBytes: 6000 } });
    const big = 'x'.repeat(3000);
    await open(journals, HOST, 'codex:s1');
    await open(journals, HOST, 'codex:s2');
    await open(journals, 'host-2', 'codex:s1', 'controller-2');
    expect((await journals.publish(HOST, 'codex:s1', 1, [append(1, 'm1', big)])).refusal).toBeUndefined();
    expect((await journals.publish(HOST, 'codex:s2', 1, [append(1, 'm1', big)])).refusal).toEqual({ sequence: 1, reason: 'quota_exceeded' });
    expect((await journals.publish('host-2', 'codex:s1', 1, [append(1, 'm1', big)])).refusal).toBeUndefined();
  });

  it('does not count a publication of a fenced generation against the limits', async () => {
    const { journals } = fixture({ limits: { sessionItems: 0 } });
    await open(journals, HOST, SESSION);
    expect((await journals.publish(HOST, SESSION, 9, [append(1, 'm1', 'a')])).refusal).toEqual({ sequence: 1, reason: 'fenced' });
  });

  it('admits a replacement by its own size and the live-only items it carries, without evicting first', async () => {
    const { journals, store } = fixture({ limits: { sessionBytes: 3500 } });
    await open(journals, HOST, SESSION);
    const big = 'x'.repeat(2000);
    await journals.publish(HOST, SESSION, 1, [live(1, 'l1', big)]);
    const tooBig = await journals.publish(HOST, SESSION, 1, [{ sequence: 2, op: 'replace', items: [{ row: rowOf('m1', big), digest: 'digest-m1' }] }]);
    expect(tooBig.refusal).toEqual({ sequence: 2, reason: 'quota_exceeded' });
    expect((await store.load(KEY))!.items.map(item => item.itemKey)).toEqual(['l1']);
    const fits = await journals.publish(HOST, SESSION, 1, [{ sequence: 2, op: 'replace', items: [{ row: rowOf('m1', 'small'), digest: 'digest-m1' }] }]);
    expect(fits.refusal).toBeUndefined();
    expect((await store.load(KEY))!.items.map(item => item.itemKey).sort()).toEqual(['l1', 'm1']);
  });

  it('refuses an open whose index is over the item bound, before claiming anything, and sends the index a page at a time', async () => {
    const { journals, store } = fixture();
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), append(2, 'm2', 'b'), append(3, 'm3', 'c')]);
    expect(await journals.open(HOST, SESSION, 'controller-1', { maxIndexItems: 2, pageItems: 2 })).toEqual({ refused: 'index_too_large' });
    expect((await store.load(KEY))?.meta.publisher?.generation).toBe(1);
    const first = await journals.open(HOST, SESSION, 'controller-1', { maxIndexItems: 10, pageItems: 2 }) as JournalOpened;
    expect(first).toMatchObject({ generation: 2, more: true });
    expect(first.index.map(entry => entry.itemKey)).toEqual(['m1', 'm2']);
    const after = first.index.at(-1)!.seqStart;
    expect((await journals.indexPage(HOST, SESSION, first.epoch, after, 10))!.map(entry => entry.itemKey)).toEqual(['m3']);
    expect(await journals.indexPage(HOST, SESSION, first.epoch, 100, 10)).toEqual([]);
    expect(await journals.indexPage(HOST, 'codex:none', first.epoch, 0, 10)).toBeUndefined();
  });

  it('refuses an index page for an epoch a replacement ended', async () => {
    const { journals } = fixture();
    const opened = await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a')]);
    expect(await journals.indexPage(HOST, SESSION, opened.epoch, 0, 10)).toHaveLength(1);
    await journals.publish(HOST, SESSION, 1, [{ sequence: 2, op: 'replace', items: [{ row: rowOf('m9', 'fresh'), digest: 'digest-m9' }] }]);
    expect(await journals.indexPage(HOST, SESSION, opened.epoch, 0, 10)).toBeUndefined();
  });
});

describe('a quota refusal and the live-only cap', () => {
  it('takes the session out of serving, persisted, and serves it again when a later head is published', async () => {
    const { journals, store } = fixture({ limits: { sessionItems: 1 } });
    await open(journals, HOST, SESSION);
    expect((await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)])).hasHead).toBe(true);
    expect(journals.served(HOST, SESSION)).toBe(true);
    const refused = await journals.publish(HOST, SESSION, 1, [append(3, 'm2', 'b')]);
    expect(refused).toMatchObject({ refusal: { sequence: 3, reason: 'quota_exceeded' }, unserved: true, hasHead: false });
    expect(journals.served(HOST, SESSION)).toBe(false);
    expect((await store.load(KEY))?.meta.head).toBeUndefined();
    const restarted = createHostJournals({ store, now: () => 1_000 });
    expect(await restarted.servedSessions(HOST)).toEqual([]);
    const resumed = await journals.publish(HOST, SESSION, 1, [head(3)]);
    expect(resumed).toMatchObject({ hasHead: true });
    expect(resumed.unserved).toBeUndefined();
    expect(journals.served(HOST, SESSION)).toBe(true);
  });

  it('does not report a session without a head as taken out of serving', async () => {
    const { journals } = fixture({ limits: { sessionItems: 0 } });
    await open(journals, HOST, SESSION);
    expect((await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a')])).unserved).toBeUndefined();
  });

  it('removes the oldest live-only items beyond the cap, with their bodies, and reports how many', async () => {
    const { journals, store } = fixture({ limits: { liveOnlyItems: 2 } });
    await open(journals, HOST, SESSION);
    const result = await journals.publish(HOST, SESSION, 1, [live(1, 'l1'), live(2, 'l2'), live(3, 'l3'), append(4, 'm1', 'kept', 1)]);
    expect(result.droppedLiveOnly).toBe(1);
    expect((await store.load(KEY))!.items.map(item => item.itemKey)).toEqual(['l2', 'l3', 'm1']);
    expect((await journals.publish(HOST, SESSION, 1, [append(5, 'm1', 'more', 1)])).droppedLiveOnly).toBeUndefined();
  });
});

describe('retention', () => {
  const turn = (sequence: number, n: number): JournalPublishEntry[] => [append(sequence, `m${n}`, `text ${n}`, n), complete(sequence + 1, `m${n}`)];

  it('evicts bodies outside the latest turns after a publication and keeps live-only items', async () => {
    const { journals, store } = fixture({ retention: { turns: 2 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [live(1, 'l0'), complete(2, 'l0'), ...turn(3, 1), ...turn(5, 2), ...turn(7, 3), ...turn(9, 4)]);
    expect(await resident(store)).toEqual([['l0', true], ['m1', false], ['m2', false], ['m3', true], ['m4', true]]);
    await journals.publish(HOST, SESSION, 1, turn(11, 5));
    expect(await resident(store)).toEqual([['l0', true], ['m1', false], ['m2', false], ['m3', false], ['m4', true], ['m5', true]]);
  });

  it('does not evict for a publication the journal did not apply', async () => {
    const { journals, store } = fixture({ retention: { turns: 1 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [...turn(1, 1)]);
    await journals.publish(HOST, SESSION, 1, [...turn(3, 2)]);
    const before = await resident(store);
    await journals.publish(HOST, SESSION, 9, turn(5, 3));
    expect(await resident(store)).toEqual(before);
  });
});

describe('filling bodies back', () => {
  const big = 'x'.repeat(2000);
  const item = (key: string, turn: number) => ({ row: rowOf(key, big, turn), digest: `digest-${key}` });

  it('puts back the bodies that fit and leaves the rest missing', async () => {
    const { journals, store } = fixture({ limits: { sessionBytes: 3500 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', big, 1), complete(2, 'm1'), append(3, 'm2', big, 2)]);
    expect(await resident(store)).toEqual([['m1', false], ['m2', true]]);
    const result = await journals.fill(HOST, SESSION, [item('m1', 1)]);
    expect(result).toEqual({ filled: [], mismatched: [], unknown: [], skipped: ['m1'] });
    expect(await resident(store)).toEqual([['m1', false], ['m2', true]]);
  });

  it('fills when it fits, and reports an item the journal does not have as unknown', async () => {
    const { journals, store } = fixture({ retention: { turns: 1 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', big, 1), complete(2, 'm1'), append(3, 'm2', big, 2), complete(4, 'm2')]);
    expect(await resident(store)).toEqual([['m1', false], ['m2', true]]);
    const result = await journals.fill(HOST, SESSION, [item('m1', 1), item('nope', 1)]);
    expect(result).toEqual({ filled: ['m1'], mismatched: [], unknown: ['nope'] });
    expect(await resident(store)).toEqual([['m1', true], ['m2', true]]);
  });

  it('makes room by evicting bodies outside the latest turns once, so an idle session read back past the limit is not stuck', async () => {
    const text = 'x'.repeat(1500);
    const bodies = (key: string, turn: number) => ({ row: rowOf(key, text, turn), digest: `digest-${key}` });
    const { journals, store } = fixture({ limits: { sessionBytes: 5500 }, retention: { turns: 1 } });
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [1, 2, 3].flatMap(n => [append(n * 2 - 1, `m${n}`, text, n), complete(n * 2, `m${n}`)]));
    expect(await resident(store)).toEqual([['m1', false], ['m2', false], ['m3', true]]);
    const result = await journals.fill(HOST, SESSION, [bodies('m1', 1), bodies('m2', 2)]);
    expect(result).toEqual({ filled: ['m2'], mismatched: [], unknown: [], skipped: ['m1'] });
    expect(await resident(store)).toEqual([['m1', false], ['m2', true], ['m3', true]]);
  });
});

describe('the head index', () => {
  it('is unknown for a Host until it is loaded, and then answers from memory', async () => {
    const { journals, store } = fixture();
    await open(journals, HOST, SESSION);
    expect((await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)])).hasHead).toBe(true);
    expect(journals.served(HOST, SESSION)).toBe(true);
    expect(journals.served(HOST, 'codex:other')).toBe(false);
    expect(journals.served('host-9', SESSION)).toBeUndefined();
    const restarted = createHostJournals({ store, now: () => 1_000 });
    expect(restarted.served(HOST, SESSION)).toBeUndefined();
    expect(await restarted.servedSessions(HOST)).toEqual([SESSION]);
    expect(restarted.served(HOST, SESSION)).toBe(true);
    expect(restarted.served(HOST, 'codex:other')).toBe(false);
  });

  it('is complete for every Host after the startup load', async () => {
    const { journals, store } = fixture();
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)]);
    await open(journals, 'host-2', SESSION, 'controller-2');
    await journals.publish('host-2', SESSION, 1, [append(1, 'm1', 'a')]);
    const restarted = createHostJournals({ store, now: () => 1_000 });
    await restarted.loadAllServed();
    expect([restarted.served(HOST, SESSION), restarted.served('host-2', SESSION), restarted.served('host-3', SESSION)]).toEqual([true, false, false]);
  });

  it('does not count a journal without a head', async () => {
    const { journals } = fixture();
    await open(journals, HOST, SESSION);
    expect((await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a')])).hasHead).toBe(false);
    expect(await journals.servedSessions(HOST)).toEqual([]);
  });

  it('loads a Host once however many ask, without waiting for the Host\'s queue', async () => {
    const seeded = fixture();
    await open(seeded.journals, HOST, SESSION);
    await seeded.journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)]);
    const reader = createHostJournals({ store: seeded.store, now: () => 1_000 });
    const [first, second] = await Promise.all([reader.servedSessions(HOST), reader.servedSessions(HOST)]);
    expect([first, second]).toEqual([[SESSION], [SESSION]]);
    expect(seeded.lists.filter(prefix => prefix === `${HOST}:`)).toHaveLength(2);
  });

  it('discards a listing that a deletion overtook', async () => {
    const seeded = fixture();
    await open(seeded.journals, HOST, SESSION);
    await seeded.journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)]);
    const reader = createHostJournals({ store: seeded.store, now: () => 1_000 });
    const release = seeded.holdLists();
    const loading = reader.servedSessions(HOST);
    await new Promise(resolve => setTimeout(resolve, 5));
    await reader.deleteHost(HOST);
    release();
    expect(await loading).toEqual([]);
    expect(reader.served(HOST, SESSION)).toBe(false);
  });

  it('discards a listing that a head change overtook, so a session whose head was cleared is not served again', async () => {
    const seeded = fixture();
    await open(seeded.journals, HOST, SESSION);
    await seeded.journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)]);
    const reader = createHostJournals({ store: seeded.store, now: () => 1_000 });
    const release = seeded.holdLists();
    const loading = reader.servedSessions(HOST);
    await new Promise(resolve => setTimeout(resolve, 5));
    // Another process of the Relay's data clears the head in the store while the reader holds the older listing.
    const limited = createHostJournals({ store: seeded.memory, now: () => 1_000, limits: { sessionItems: 1 } });
    await limited.open(HOST, SESSION, 'controller-1', LIMITS);
    expect((await limited.publish(HOST, SESSION, 2, [append(3, 'm2', 'b')])).unserved).toBe(true);
    reader.unserve(HOST, SESSION);
    release();
    expect(await loading).toEqual([]);
    expect(reader.served(HOST, SESSION)).toBe(false);
  });

  it('forgets a session that was found without a head, until a publication gives it one', async () => {
    const { journals } = fixture();
    await open(journals, HOST, SESSION);
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)]);
    expect(journals.served(HOST, SESSION)).toBe(true);
    journals.unserve(HOST, SESSION);
    expect(journals.served(HOST, SESSION)).toBe(false);
    await journals.publish(HOST, SESSION, 1, [head(3)]);
    expect(journals.served(HOST, SESSION)).toBe(true);
  });
});

describe('deletion', () => {
  it('deletes every journal of a Host and none of another Host', async () => {
    const { journals, store } = fixture();
    await open(journals, HOST, 'codex:s1');
    await open(journals, HOST, 'codex:s2');
    await open(journals, 'host-2', 'codex:s1', 'controller-2');
    await journals.deleteHost(HOST);
    expect(await store.catalog!.list('')).toMatchObject([{ sessionKey: 'host-2:codex:s1' }]);
    expect(await journals.servedSessions(HOST)).toEqual([]);
    expect(await journals.status(HOST, 'codex:s1')).toBeUndefined();
  });

  it('orders a deletion against publications: earlier ones apply, later ones are refused and nothing returns', async () => {
    const { journals, store } = fixture();
    await open(journals, HOST, SESSION);
    const before = journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a'), head(2)]);
    const deleted = journals.deleteHost(HOST);
    const after = journals.publish(HOST, SESSION, 1, [append(3, 'm2', 'b')]);
    expect((await before).watermark).toBe(2);
    await deleted;
    expect((await after).refusal).toEqual({ sequence: 3, reason: 'fenced' });
    expect(await store.load(KEY)).toBeUndefined();
    expect(journals.served(HOST, SESSION)).toBe(false);
  });

  it('does not open a journal for a connection that ended behind a deletion of its Host', async () => {
    const { journals, store } = fixture();
    await open(journals, HOST, SESSION);
    let current = true;
    const deleted = journals.deleteHost(HOST);
    const reopened = journals.open(HOST, SESSION, 'controller-1', { ...LIMITS, allowed: () => current });
    current = false;
    await deleted;
    expect(await reopened).toEqual({ refused: 'unavailable' });
    expect(await store.load(KEY)).toBeUndefined();
  });

  it('opens a fresh journal for a Host whose journals were deleted', async () => {
    const { journals } = fixture();
    const first = await open(journals, HOST, SESSION);
    await journals.deleteHost(HOST);
    const second = await open(journals, HOST, SESSION);
    expect(second).toMatchObject({ generation: 1, watermark: 0, index: [] });
    expect(second.epoch).not.toBe(first.epoch);
  });
});
```

- [ ] **Step 2: Write the tests for packing an index page.** `packages/agent-remote-hosted/src/journal-index-pages.test.ts`:

```ts
import { encodeRemoteHostUplinkMessage, JOURNAL_INDEX_PAGE_MAX_ITEMS, REMOTE_HOST_UPLINK_VERSION } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { packIndex } from './journal-index-pages.js';

const entry = (at: number, keyLength = 8) => ({
  itemKey: `${at}-`.padEnd(keyLength, 'k'), seqStart: at, seqEnd: at, state: 'complete' as const, liveOnly: false, revision: 1, resident: true });
const asMessage = (index: ReturnType<typeof entry>[]) =>
  ({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_index_page' as const, requestId: 'index-1', sessionKey: 'codex:thread-1', index });

describe('packIndex', () => {
  it('packs nothing from nothing and everything that fits', () => {
    expect(packIndex([])).toEqual([]);
    const index = Array.from({ length: 50 }, (_, at) => entry(at));
    expect(packIndex(index)).toEqual(index);
  });

  it('stops at the item bound', () => {
    const index = Array.from({ length: JOURNAL_INDEX_PAGE_MAX_ITEMS + 5 }, (_, at) => entry(at));
    expect(packIndex(index)).toHaveLength(JOURNAL_INDEX_PAGE_MAX_ITEMS);
  });

  it('stops at the byte bound, always packs one entry, and what it packs fits one message', () => {
    const index = Array.from({ length: 1200 }, (_, at) => entry(at, 4000));
    const packed = packIndex(index);
    expect(packed.length).toBeGreaterThan(0);
    expect(packed.length).toBeLessThan(index.length);
    expect(packed).toEqual(index.slice(0, packed.length));
    expect(encodeRemoteHostUplinkMessage(asMessage(packed)).status).toBe('ok');
  });
});
```

- [ ] **Step 3: Update the existing tests.**

In `packages/agent-remote-hosted/src/host-journals.test.ts`, replace the import on line 5 with

```ts
import { createHostJournals, type HostJournals, type JournalOpenOptions, type JournalOpened } from './host-journals.js';
```

replace lines 23-25

```ts
const fitsAlways = () => true;
const openSession = (journals: HostJournals, hostId: string, sessionKey: string, publisherId: string, fits: (index: JournalIndexEntry[], epoch: string) => boolean = fitsAlways) =>
  journals.open(hostId, sessionKey, publisherId, fits) as Promise<JournalOpened>;
```

with

```ts
const LIMITS: JournalOpenOptions = { maxIndexItems: 1_000_000, pageItems: 1_000_000 };
const openSession = (journals: HostJournals, hostId: string, sessionKey: string, publisherId: string, options: JournalOpenOptions = LIMITS) =>
  journals.open(hostId, sessionKey, publisherId, options) as Promise<JournalOpened>;
```

Rename the test `claims nothing when the reply for the index cannot be sent` to `claims nothing when the index is larger than the Relay may send` and replace its line `expect(await journals.open(HOST, SESSION, 'controller-1', () => false)).toEqual({ refused: 'index_too_large' });` with

```ts
    expect(await journals.open(HOST, SESSION, 'controller-1', { maxIndexItems: 0, pageItems: 10 })).toEqual({ refused: 'index_too_large' });
```

Replace every remaining `fitsAlways` (in `runs the calls queued behind one that failed` and `does not let one Host waiting on its store hold up another Host`) with `LIMITS`. The test stores written as `{ load, delete, apply }` literals keep working because `catalog` is optional.

In `packages/agent-remote-hosted/src/journal-uplink.test.ts`:

Change the imports on lines 1-2 to

```ts
import { MemoryJournalStore, SessionJournal, type JournalStore } from '@orchardworks/agent-remote-journal';
import { decodeRemoteHostUplinkMessage, JOURNAL_INDEX_MAX_ITEMS, JOURNAL_INDEX_PAGE_MAX_ITEMS } from '@orchardworks/agent-remote-protocol';
```

Widen the diagnostic type in the `fixture` options (line 24) to `'journal_message_unencodable' | 'journal_store_failed' | 'journal_fanout_failed' | 'journal_quota_exceeded' | 'journal_live_only_dropped'`.

Replace the test `refuses an open whose reply no single message can carry and leaves the session unopened` with:

```ts
  it('asks for an index no longer than a journal may list, and leaves the session unopened when the service refuses it', async () => {
    const asked: Array<{ maxIndexItems: number; pageItems: number }> = [];
    const refusing: HostJournals = { ...createHostJournals({ store: new MemoryJournalStore(), now: () => 1 }),
      open: async (_hostId, _sessionKey, _publisherId, options) => { asked.push({ maxIndexItems: options.maxIndexItems, pageItems: options.pageItems }); return { refused: 'index_too_large' }; } };
    const f = fixture({ journals: refusing });
    expect(await f.open()).toEqual({ uplinkVersion: 2, type: 'journal_open_refused', requestId: 'open-1', sessionKey: SESSION, reason: 'index_too_large' });
    expect(asked).toEqual([{ maxIndexItems: JOURNAL_INDEX_MAX_ITEMS, pageItems: JOURNAL_INDEX_PAGE_MAX_ITEMS }]);
    expect(f.sent).toHaveLength(1);
    await f.publish([{ sequence: 1, op: 'seal', itemKey: 'm1' }]);
    expect(f.sent.at(-1)).toMatchObject({ type: 'journal_refused', reason: 'fenced' });
  });
```

Replace the test `refuses an open whose reply fits only with small numbers, without claiming` (the whole block, ending before `clears an opened session when a later open is refused`) with:

```ts
  it('sends the first page of an index no single message can carry and the rest one page at a time, as the Controller asks', async () => {
    const f = fixture();
    const seeded = SessionJournal.create(`host-1:${SESSION}`);
    const { generation } = seeded.claim('controller-1');
    for (let at = 0; at < 2100; at++) {
      const itemKey = `${at}-`.padEnd(4000, 'k');
      seeded.append({ publisherId: 'controller-1', generation, sequence: at + 1 }, { ...row(itemKey, 'x'), sourceKey: itemKey });
    }
    await f.store.apply(seeded.takeChanges()!);
    const opened = await f.open() as unknown as { generation: number; watermark: number; epoch: string; index: Array<{ seqStart: number }>; indexAfter?: number };
    expect(opened).toMatchObject({ type: 'journal_opened', generation: 2, watermark: 2100 });
    expect(f.sent).toHaveLength(1);
    const index = [...opened.index];
    let after = opened.indexAfter;
    let requests = 0;
    while (after !== undefined) {
      f.sent.length = 0;
      await f.connection.receive(wire({ type: 'journal_index_request', requestId: `index-${requests}`, sessionKey: SESSION, generation: 2, epoch: opened.epoch, after }));
      expect(f.sent).toHaveLength(1);
      const page = f.sent[0] as unknown as { type: string; requestId: string; index: Array<{ seqStart: number }>; indexAfter?: number };
      expect(page).toMatchObject({ type: 'journal_index_page', requestId: `index-${requests}`, sessionKey: SESSION });
      index.push(...page.index);
      after = page.indexAfter;
      requests += 1;
    }
    expect(requests).toBeGreaterThanOrEqual(1);
    expect(index.map(entry => entry.seqStart)).toEqual(Array.from({ length: 2100 }, (_, at) => at + 1));
    await f.publish([{ sequence: 2101, op: 'append', row: row('after', 'Hello') }], 2);
    expect(f.sent.at(-1)).toMatchObject({ type: 'journal_ack', generation: 2, watermark: 2101 });
  });

  it('refuses an index request for a generation that is not the one opened', async () => {
    const f = fixture();
    await f.open();
    f.sent.length = 0;
    await f.connection.receive(wire({ type: 'journal_index_request', requestId: 'index-1', sessionKey: SESSION, generation: 9, epoch: 'e', after: 0 }));
    expect(f.sent).toEqual([{ uplinkVersion: 2, type: 'journal_open_refused', requestId: 'index-1', sessionKey: SESSION, reason: 'invalid' }]);
  });

  it('refuses an index request for an epoch a replacement ended, so the Controller opens again', async () => {
    const f = fixture();
    const opened = await f.open() as unknown as { epoch: string };
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }]);
    await f.publish([{ sequence: 2, op: 'replace', items: [{ row: row('m9', 'Fresh'), digest: DIGEST }] }]);
    f.sent.length = 0;
    await f.connection.receive(wire({ type: 'journal_index_request', requestId: 'index-1', sessionKey: SESSION, generation: 1, epoch: opened.epoch, after: 0 }));
    expect(f.sent).toEqual([{ uplinkVersion: 2, type: 'journal_open_refused', requestId: 'index-1', sessionKey: SESSION, reason: 'stale_epoch' }]);
  });

  it('sends the index of a small journal in the opening message alone', async () => {
    const f = fixture();
    await f.open();
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }]);
    f.sent.length = 0;
    await f.connection.receive(wire({ type: 'journal_open', requestId: 'open-2', sessionKey: SESSION, publisherId: 'controller-1' }));
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ type: 'journal_opened', index: [expect.objectContaining({ itemKey: 'm1' })] });
    expect(f.sent[0]).not.toHaveProperty('indexAfter');
  });

  it('lets the journal service ask whether the connection is still current before it claims anything', async () => {
    const store = new MemoryJournalStore();
    const base = createHostJournals({ store, now: () => 1 });
    const asked: boolean[] = [];
    const journals: HostJournals = { ...base, open: async (hostId, sessionKey, publisherId, options) => { asked.push(options.allowed?.() ?? false); return base.open(hostId, sessionKey, publisherId, options); } };
    const f = fixture({ journals });
    await f.open();
    f.endConnection();
    f.sent.length = 0;
    await f.connection.receive(wire({ type: 'journal_open', requestId: 'open-2', sessionKey: SESSION, publisherId: 'controller-1' }));
    expect(asked).toEqual([true, false]);
    expect(f.sent).toEqual([]);
    expect((await store.load(`host-1:${SESSION}`))?.meta.publisher?.generation).toBe(1);
  });

  it('reports a publication the journal refused for its limits, and refuses it to the Host', async () => {
    const events: string[] = [];
    const journals = createHostJournals({ store: new MemoryJournalStore(), now: () => 1, limits: { sessionItems: 0 } });
    const f = fixture({ journals, diagnostic: event => events.push(event) });
    await f.open();
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }]);
    expect(f.sent.at(-1)).toMatchObject({ type: 'journal_refused', sequence: 1, reason: 'quota_exceeded' });
    expect(events).toEqual(['journal_quota_exceeded']);
  });

  it('reports live-only items the journal removed beyond its cap', async () => {
    const events: string[] = [];
    const journals = createHostJournals({ store: new MemoryJournalStore(), now: () => 1, limits: { liveOnlyItems: 1 } });
    const f = fixture({ journals, diagnostic: event => events.push(event) });
    await f.open();
    await f.publish([{ sequence: 1, op: 'append', row: { ...row('l1', 'a'), liveOnly: true } }, { sequence: 2, op: 'append', row: { ...row('l2', 'b'), liveOnly: true } }]);
    expect(events).toEqual(['journal_live_only_dropped']);
    expect(f.sent.at(-1)).toMatchObject({ type: 'journal_ack', watermark: 2 });
  });
```

In `clears an opened session when a later open is refused`, replace the `journals` line

```ts
    const journals: HostJournals = { ...base, open: (hostId, sessionKey, publisherId, fits) => base.open(hostId, sessionKey, publisherId, ++calls === 1 ? fits : () => false) };
```

with

```ts
    const journals: HostJournals = { ...base, open: (hostId, sessionKey, publisherId, options) => base.open(hostId, sessionKey, publisherId, ++calls === 1 ? options : { ...options, maxIndexItems: -1 }) };
```

In `packages/agent-remote-hosted/src/broker-journals.test.ts`, replace the whole test `refuses to open a journal whose index no message can carry, claims nothing and records a diagnostic` (from its `it(` line to its closing `}, 30_000);`) with:

```ts
it('opens a journal whose index no single message can carry, and sends the rest a page at a time as the Controller asks', async () => {
  const memory = new MemoryJournalStore();
  const probe = await connectedHost({ journals: memory });
  const seeded = SessionJournal.create(probe.storeKey);
  const { generation } = seeded.claim('controller-1');
  for (let at = 0; at < 2100; at++) {
    const itemKey = `${at}-`.padEnd(4000, 'k');
    seeded.append({ publisherId: 'controller-1', generation, sequence: at + 1 }, { ...row(itemKey, 'x'), sourceKey: itemKey });
  }
  await memory.apply(seeded.takeChanges()!);
  probe.send({ type: 'journal_open', requestId: 'open-big', sessionKey: SESSION, publisherId: 'controller-1' });
  const opened = await probe.take('journal_opened');
  expect(opened).toMatchObject({ requestId: 'open-big', generation: 2, watermark: 2100 });
  expect(opened.indexAfter).toBeDefined();
  const index: Wire[] = [...opened.index];
  let after: number | undefined = opened.indexAfter;
  for (let request = 0; after !== undefined; request++) {
    probe.send({ type: 'journal_index_request', requestId: `index-${request}`, sessionKey: SESSION, generation: 2, epoch: opened.epoch, after });
    const page = await probe.take('journal_index_page');
    expect(page).toMatchObject({ requestId: `index-${request}`, sessionKey: SESSION });
    index.push(...page.index);
    after = page.indexAfter;
  }
  expect(index.map(entry => entry.seqStart)).toEqual(Array.from({ length: 2100 }, (_, at) => at + 1));
  probe.send({ type: 'journal_publish', sessionKey: SESSION, generation: 2, entries: [{ sequence: 2101, op: 'seal', itemKey: index[0]!.itemKey }] });
  expect(await probe.take('journal_ack')).toMatchObject({ generation: 2, watermark: 2101 });
}, 30_000);
```

In `packages/agent-remote-hosted/src/relay-diagnostics.test.ts`, in the test `keeps journal events from Controllers that do not know them`, after `const fanout = ...` add

```ts
 const quota = { ...event, event: 'journal_quota_exceeded', reason: undefined };
 const dropped = { ...event, event: 'journal_live_only_dropped', reason: undefined };
 expect(isRelayDiagnostic(quota)).toBe(true);
 expect(isRelayDiagnostic(dropped)).toBe(true);
```

and change the `parseRelayDiagnosticBatch` line to `const batch = parseRelayDiagnosticBatch({ entries: [event, unencodable, failed, fanout, quota, dropped] })!;` (the following version assertions stay).

- [ ] **Step 3a: Narrow the first page of `journal_opened` to one page.** The landed uplink test that built more than 2,000 entries is replaced above, so the bound can now be the page's. In `packages/agent-remote-protocol/src/remote-host-journal.test.ts`, add to the invalid list, before `['an acknowledgement without an epoch', ...]`:

```ts
    ['a first page above the page bound', message({ type: 'journal_opened', requestId: 'o', sessionKey: SESSION, generation: 1, watermark: 0, epoch: 'e',
      index: Array.from({ length: JOURNAL_INDEX_PAGE_MAX_ITEMS + 1 }, (_, at) => ({ ...indexEntry, itemKey: `i${at}`, seqStart: at, seqEnd: at })) })],
```

In `packages/agent-remote-protocol/src/remote-host-journal.ts`, in `JournalOpened`, change `index: Type.Array(JournalIndexEntry, { maxItems: JOURNAL_INDEX_MAX_ITEMS })` to `index: Type.Array(JournalIndexEntry, { maxItems: JOURNAL_INDEX_PAGE_MAX_ITEMS })`.

Run: `pnpm --filter @orchardworks/agent-remote-protocol run test` then `pnpm --filter @orchardworks/agent-remote-protocol run build`
Expected: PASS. Rebuilding makes the hosted tests below use the narrowed schema.

- [ ] **Step 4: Run the tests and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/host-journals-bounds.test.ts src/journal-index-pages.test.ts src/host-journals.test.ts src/journal-uplink.test.ts src/broker-journals.test.ts src/relay-diagnostics.test.ts --testTimeout=10000`
Expected: FAIL (the new modules and options do not exist).

- [ ] **Step 5: Write the head index and the page packer.** `packages/agent-remote-hosted/src/journal-head-index.ts`:

```ts
/** The sessions of each Host that have a journal head: the ones whose reads a journal may serve, answered from memory. */
export class JournalHeadIndex {
  private readonly heads = new Map<string, Set<string>>();
  private readonly loadedHosts = new Set<string>();
  private everyHostLoaded = false;

  /** Whether the Host's sessions were loaded. */
  loaded(hostId: string): boolean { return this.everyHostLoaded || this.loadedHosts.has(hostId); }

  /** Whether the session has a head; undefined while the Host's sessions have not been loaded. */
  served(hostId: string, sessionKey: string): boolean | undefined {
    if (!this.loaded(hostId)) return undefined;
    return this.heads.get(hostId)?.has(sessionKey) ?? false;
  }

  /** Adds the sessions a store lists for the Host and counts the Host as loaded; sessions added since are kept. */
  load(hostId: string, sessionKeys: Iterable<string>): void {
    const sessions = this.heads.get(hostId) ?? new Set<string>();
    for (const sessionKey of sessionKeys) sessions.add(sessionKey);
    this.heads.set(hostId, sessions);
    this.loadedHosts.add(hostId);
  }

  /** Every Host the store holds was loaded: a Host it listed nothing for has no session with a head. */
  markEveryHostLoaded(): void { this.everyHostLoaded = true; }

  add(hostId: string, sessionKey: string): void {
    const sessions = this.heads.get(hostId) ?? new Set<string>();
    sessions.add(sessionKey);
    this.heads.set(hostId, sessions);
  }

  remove(hostId: string, sessionKey: string): void { this.heads.get(hostId)?.delete(sessionKey); }

  sessions(hostId: string): string[] { return [...(this.heads.get(hostId) ?? [])].sort(); }

  /** Forgets every session of a Host and counts the Host as loaded and empty. */
  clearHost(hostId: string): void {
    this.heads.set(hostId, new Set());
    this.loadedHosts.add(hostId);
  }
}
```

`packages/agent-remote-hosted/src/journal-index-pages.ts`:

```ts
import type { JournalIndexEntry } from '@orchardworks/agent-remote-journal';
import { JOURNAL_INDEX_PAGE_MAX_ITEMS } from '@orchardworks/agent-remote-protocol';

/** The most UTF-8 bytes of index entries in one message; a journal message may be 8 MiB, so a page leaves ample room for its envelope. */
export const JOURNAL_INDEX_PAGE_MAX_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

/** The leading entries that fit one message: at most the page's items and bytes, and always the first entry. */
export function packIndex(entries: readonly JournalIndexEntry[]): JournalIndexEntry[] {
  const packed: JournalIndexEntry[] = [];
  let bytes = 0;
  for (const entry of entries) {
    if (packed.length >= JOURNAL_INDEX_PAGE_MAX_ITEMS) break;
    const size = encoder.encode(JSON.stringify(entry)).length + 1;
    if (packed.length > 0 && bytes + size > JOURNAL_INDEX_PAGE_MAX_BYTES) break;
    packed.push(entry);
    bytes += size;
  }
  return packed;
}
```

- [ ] **Step 6: Write the service.** Replace `packages/agent-remote-hosted/src/host-journals.ts` with:

```ts
import {
  bodyFromRow, JournalBodyMissingError, JournalDuplicateItemError, JournalFencedError, JournalInvalidPublicationError, JournalInvalidRowError, JournalItemTypeChangedError,
  JournalStaleRevisionError, JournalUnknownItemError, SessionJournal,
  type JournalHead, type JournalIndexEntry, type JournalListing, type JournalPageRequest, type JournalPageResult, type JournalPublication, type JournalRow, type JournalStore,
} from '@orchardworks/agent-remote-journal';
import { JOURNAL_INDEX_MAX_ITEMS, type CompleteItemInput, type JournalPublishEntry, type JournalRefusalReason, type TimelineCursor } from '@orchardworks/agent-remote-protocol';

import { JournalHeadIndex } from './journal-head-index.js';

/** Journals kept in memory, for the whole Relay. */
const CACHE_MAX_JOURNALS = 64;
/** The estimated size of the journals kept in memory, for the whole Relay. */
const CACHE_MAX_BYTES = 128 * 1024 * 1024;
/** A session's estimated size above which a growing entry is refused once its bodies are evicted as far as they can be. */
const SESSION_MAX_BYTES = 64 * 1024 * 1024;
/** The estimated size of all journals of a Host above which a growing entry is refused. */
const HOST_MAX_BYTES = 1024 * 1024 * 1024;
/** Live-only items kept per session; beyond it the oldest are removed. */
const LIVE_ONLY_MAX_ITEMS = 2000;
/** Turns whose bodies stay resident. */
const RETAIN_TURNS = 50;

export interface HostJournalsOptions {
  store: JournalStore;
  now(): number;
  /** How much the service keeps in memory; a journal is read from the store again when it is needed after it was dropped. */
  cache?: { maxJournals?: number; maxBytes?: number };
  /** Safety bounds on growth. They are not the retention policy. `sessionItems` never exceeds what an index may list. */
  limits?: { sessionBytes?: number; sessionItems?: number; hostBytes?: number; liveOnlyItems?: number };
  /** The working set: how many of the latest turns keep their bodies after a publication. */
  retention?: { turns?: number };
}

export interface JournalOpenOptions {
  /** A journal whose index lists more items than this is refused, and nothing is claimed. */
  maxIndexItems: number;
  /** How many entries of the index the answer carries; `indexPage` reads the rest. */
  pageItems: number;
  /** Asked inside the Host's queue: false means the connection that asked is gone, so nothing is created or claimed. */
  allowed?(): boolean;
}

export interface JournalOpened {
  generation: number;
  watermark: number;
  epoch: string;
  /** The first `pageItems` entries of the index. */
  index: JournalIndexEntry[];
  /** Whether the index has entries beyond `index`. */
  more: boolean;
}

/** The journal could not be opened, and no generation was claimed. */
export interface JournalOpenRefusal {
  refused: 'index_too_large' | 'unavailable';
}

export interface JournalRefusal {
  sequence: number;
  reason: JournalRefusalReason;
  itemKey?: string;
}

/** What a subscriber of the session sees of a publication, in the order its entries were applied. */
export type JournalLiveEvent =
  /** An appended row; it is delivered live with its epoch and sequence. Corrections and prepended rows are never events. */
  | { kind: 'row'; row: JournalRow }
  /** A replacement started a new epoch. */
  | { kind: 'replaced'; epoch: string }
  /** A head that was not already applied. */
  | { kind: 'head'; head: JournalHead };

/** The journal's cursor, and its head once the Controller has published one. */
export interface JournalStatus {
  cursor: TimelineCursor;
  head?: JournalHead;
}

export interface JournalPublished {
  /** What live subscribers see of the publication, in order. */
  events: JournalLiveEvent[];
  /** The last publication applied; everything up to it is stored. */
  watermark: number;
  /** The journal's cursor after the publication; absent when the session has no journal. */
  cursor?: TimelineCursor;
  /** Whether the journal has a head after the publication; absent when the session has no journal. */
  hasHead?: boolean;
  /** The first entry the journal refused; entries before it are applied and stored. */
  refusal?: JournalRefusal;
  /** A quota refusal cleared the journal's head: the session is no longer served from it until a later head is published. */
  unserved?: true;
  /** Live-only items removed because the session passed its cap. */
  droppedLiveOnly?: number;
}

export interface JournalFilled {
  filled: string[];
  mismatched: string[];
  unknown: string[];
  /** Bodies that were not put back because the session, the Host or the cache has no room; they stay missing. */
  skipped?: string[];
}

/**
 * The session journals of the Hosts of one Relay. Journals are keyed by Host and session, loaded from the store when
 * first used, and changed only through this service. All work of one Host runs one call at a time, in the order the calls
 * were made, and a journal is stored before the call that changed it returns.
 */
export interface HostJournals {
  /**
   * Claims the session's journal for a publisher, creating it when needed, and fences every older generation. When the
   * index is over `options.maxIndexItems`, or `options.allowed` says the connection is gone, nothing is created or claimed.
   */
  open(hostId: string, sessionKey: string, publisherId: string, options: JournalOpenOptions): Promise<JournalOpened | JournalOpenRefusal>;
  /**
   * Up to `maxItems` entries of the session's index whose `seqStart` is above `after`, in order. Undefined when the session
   * has no journal or its epoch is no longer `epoch`: a replacement happened, and the cursor means nothing now.
   */
  indexPage(hostId: string, sessionKey: string, epoch: string, after: number, maxItems: number): Promise<JournalIndexEntry[] | undefined>;
  /** Applies entries in order and stores the changes before returning. */
  publish(hostId: string, sessionKey: string, generation: number, entries: readonly JournalPublishEntry[]): Promise<JournalPublished>;
  /** Puts bodies the Host read again back into the journal, as far as the limits allow. */
  fill(hostId: string, sessionKey: string, items: readonly CompleteItemInput[]): Promise<JournalFilled>;
  /** A page of the session's journal, or undefined when it has none. */
  page(hostId: string, sessionKey: string, request: JournalPageRequest, olderBeyondJournal: boolean): Promise<JournalPageResult | undefined>;
  /** The cursor and head of the session's journal, or undefined when it has none. */
  status(hostId: string, sessionKey: string): Promise<JournalStatus | undefined>;
  /** Drops the journals cached for a Host; the store keeps them. */
  forget(hostId: string): Promise<void>;
  /** Whether the session has a journal head, answered from memory; undefined until the Host's sessions are loaded. */
  served(hostId: string, sessionKey: string): boolean | undefined;
  /**
   * The Host's sessions that have a journal head. Loads them for `served` when the Host was not loaded. It does not wait
   * for the Host's queue, and concurrent calls share one load.
   */
  servedSessions(hostId: string): Promise<string[]>;
  /** Loads the sessions with a head of every Host the store holds, so `served` never answers undefined. */
  loadAllServed(): Promise<void>;
  /**
   * A stream found the session without a head although `served` said it had one: forget it, so the client's reconnect is
   * read through the Controller instead of looping. A later publication that sets a head serves it again.
   */
  unserve(hostId: string, sessionKey: string): void;
  /** Deletes every journal of the Host. */
  deleteHost(hostId: string): Promise<void>;
}

/** A growing entry the journal's limits do not allow. */
class JournalQuotaRefused extends Error {
  constructor(readonly limit: 'items' | 'session' | 'host') {
    super(`The journal is over its ${limit} limit.`);
    this.name = 'JournalQuotaRefused';
  }
}

function wholeNumber(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative whole number.`);
  return value;
}

type Cached = { hostId: string; sessionKey: string; journal: SessionJournal; bytes: number };
type HostUsage = { total: number; sessions: Map<string, number> };

export function createHostJournals(options: HostJournalsOptions): HostJournals {
  const { store, now } = options;
  const cacheLimits = {
    maxJournals: wholeNumber('Journal cache journals', options.cache?.maxJournals ?? CACHE_MAX_JOURNALS),
    maxBytes: wholeNumber('Journal cache bytes', options.cache?.maxBytes ?? CACHE_MAX_BYTES),
  };
  const limits = {
    sessionBytes: wholeNumber('Journal session bytes', options.limits?.sessionBytes ?? SESSION_MAX_BYTES),
    sessionItems: Math.min(wholeNumber('Journal session items', options.limits?.sessionItems ?? JOURNAL_INDEX_MAX_ITEMS), JOURNAL_INDEX_MAX_ITEMS),
    hostBytes: wholeNumber('Journal Host bytes', options.limits?.hostBytes ?? HOST_MAX_BYTES),
    liveOnlyItems: wholeNumber('Journal live-only items', options.limits?.liveOnlyItems ?? LIVE_ONLY_MAX_ITEMS),
  };
  const retainTurns = wholeNumber('Journal retained turns', options.retention?.turns ?? RETAIN_TURNS);
  /** Least recently used first. */
  const cache = new Map<string, Cached>();
  let cacheBytes = 0;
  const chains = new Map<string, Promise<void>>();
  /** Sessions whose last publication failed to apply or store: nothing more is accepted until the session is opened again. */
  const needsReopen = new Set<string>();
  const heads = new JournalHeadIndex();
  const hostsLoaded = new Set<string>();
  const usage = new Map<string, HostUsage>();
  const loading = new Map<string, Promise<void>>();
  /** Raised on every change of a Host's head index and when its deletion starts and ends, so a listing read in between is discarded. */
  const epochs = new Map<string, number>();
  const bump = (hostId: string) => { epochs.set(hostId, (epochs.get(hostId) ?? 0) + 1); };
  const storeKey = (hostId: string, sessionKey: string) => `${hostId}:${sessionKey}`;
  const hostPrefix = (hostId: string) => `${hostId}:`;

  function serialized<T>(hostId: string, work: () => Promise<T>): Promise<T> {
    const result = (chains.get(hostId) ?? Promise.resolve()).then(work);
    const tail = result.then(() => undefined, () => undefined);
    chains.set(hostId, tail);
    void tail.then(() => { if (chains.get(hostId) === tail) chains.delete(hostId); });
    return result;
  }

  function drop(key: string): void {
    const entry = cache.get(key);
    if (!entry) return;
    cache.delete(key);
    cacheBytes -= entry.bytes;
  }

  function remember(hostId: string, sessionKey: string, journal: SessionJournal, bytes: number = journal.residentBytes()): void {
    const key = storeKey(hostId, sessionKey);
    drop(key);
    cache.set(key, { hostId, sessionKey, journal, bytes });
    cacheBytes += bytes;
  }

  /** Drops least recently used journals until the cache is within its bounds, but never the journal in use. */
  function trimCache(keepKey: string): void {
    for (const key of [...cache.keys()]) {
      if (cache.size <= cacheLimits.maxJournals && cacheBytes <= cacheLimits.maxBytes) return;
      if (key !== keepKey) drop(key);
    }
  }

  async function load(hostId: string, sessionKey: string, create: boolean): Promise<SessionJournal | undefined> {
    const key = storeKey(hostId, sessionKey);
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return cached.journal;
    }
    const saved = await store.load(key);
    const journal = saved ? new SessionJournal(saved) : create ? SessionJournal.create(key) : undefined;
    if (journal) {
      remember(hostId, sessionKey, journal);
      trimCache(key);
    }
    return journal;
  }

  /** Writes what changed and returns the journal's estimated size; after a failed write the cached journal is ahead of the store, so it is dropped. */
  async function persist(hostId: string, sessionKey: string, journal: SessionJournal): Promise<number | undefined> {
    const changes = journal.takeChanges();
    if (!changes) return undefined;
    try { await store.apply(changes); }
    catch (error) { drop(storeKey(hostId, sessionKey)); throw error; }
    return changes.bytes;
  }

  function adopt(hostId: string, listing: readonly JournalListing[]): void {
    const sessions = new Map<string, number>();
    const withHead: string[] = [];
    let total = 0;
    for (const entry of listing) {
      const sessionKey = entry.sessionKey.slice(hostPrefix(hostId).length);
      sessions.set(sessionKey, entry.bytes);
      total += entry.bytes;
      if (entry.hasHead) withHead.push(sessionKey);
    }
    usage.set(hostId, { total, sessions });
    heads.load(hostId, withHead);
    hostsLoaded.add(hostId);
  }

  /** Lists what the store holds for the Host, once at a time, for the head index and the Host's usage. A load that a deletion overtook is read again. */
  function loadHost(hostId: string): Promise<void> {
    if (hostsLoaded.has(hostId)) return Promise.resolve();
    let pending = loading.get(hostId);
    if (!pending) {
      pending = (async () => {
        for (let attempt = 0; attempt < 3 && !hostsLoaded.has(hostId); attempt++) {
          const epoch = epochs.get(hostId) ?? 0;
          const listing = await store.catalog?.list(hostPrefix(hostId)) ?? [];
          if ((epochs.get(hostId) ?? 0) === epoch && !hostsLoaded.has(hostId)) adopt(hostId, listing);
        }
      })().finally(() => { loading.delete(hostId); });
      loading.set(hostId, pending);
    }
    return pending;
  }

  function account(hostId: string, sessionKey: string, bytes: number): void {
    const host = usage.get(hostId) ?? { total: 0, sessions: new Map<string, number>() };
    usage.set(hostId, host);
    host.total += bytes - (host.sessions.get(sessionKey) ?? 0);
    host.sessions.set(sessionKey, bytes);
  }

  /** Whether the Host can take `size` for this session, counting what its other sessions hold. */
  function hostHasRoom(hostId: string, sessionKey: string, size: number): boolean {
    const host = usage.get(hostId);
    return !host || host.total - (host.sessions.get(sessionKey) ?? 0) + size <= limits.hostBytes;
  }

  /** Evicts bodies, from the larger window to none, until the journal is within `target` or nothing more can go. */
  function shrink(journal: SessionJournal, target: number): number {
    let size = journal.residentBytes();
    for (const keep of [5, 1, 0]) {
      if (size <= target) break;
      journal.evict(keep);
      size = journal.residentBytes();
    }
    return size;
  }

  /**
   * Checks each entry that grows the journal against the limits. A replacement is admitted by its own size and the
   * live-only items it carries over, without evicting first; the other entries may evict bodies to make room. The size is
   * measured once and then counted up by the entries.
   */
  function admission(hostId: string, sessionKey: string, journal: SessionJournal): (entry: JournalPublishEntry) => void {
    let size: number | undefined;
    return entry => {
      if (entry.op === 'replace') {
        if (entry.items.length + journal.liveOnlyCount > limits.sessionItems) throw new JournalQuotaRefused('items');
        const need = JSON.stringify(entry).length + journal.liveOnlyBytes();
        if (need > limits.sessionBytes) throw new JournalQuotaRefused('session');
        if (!hostHasRoom(hostId, sessionKey, need)) throw new JournalQuotaRefused('host');
        size = undefined;
        return;
      }
      if (entry.op !== 'append' && entry.op !== 'correct' && entry.op !== 'prepend') return;
      const itemsAfter = entry.op === 'append' ? journal.itemCount + (journal.has(entry.row.itemKey) ? 0 : 1)
        : entry.op === 'prepend' ? journal.itemCount + entry.items.length : journal.itemCount;
      if (itemsAfter > limits.sessionItems) throw new JournalQuotaRefused('items');
      const entryBytes = JSON.stringify(entry).length;
      size ??= journal.residentBytes();
      if (size + entryBytes > limits.sessionBytes) size = shrink(journal, limits.sessionBytes - entryBytes);
      if (size + entryBytes > limits.sessionBytes) throw new JournalQuotaRefused('session');
      size += entryBytes;
      if (!hostHasRoom(hostId, sessionKey, size)) throw new JournalQuotaRefused('host');
    };
  }

  function apply(journal: SessionJournal, publication: JournalPublication, entry: JournalPublishEntry, published: JournalPublished): void {
    switch (entry.op) {
      case 'append': { const row = journal.append(publication, entry.row); if (row) published.events.push({ kind: 'row', row }); break; }
      case 'complete': journal.complete(publication, entry.itemKey, entry.digest); break;
      case 'seal': journal.seal(publication, entry.itemKey); break;
      case 'alias': journal.alias(publication, entry.itemKey, entry.clientMessageId); break;
      case 'correct': journal.correct(publication, entry.row, entry.digest, entry.expectedRevision); break;
      case 'replace': {
        const before = journal.epoch;
        const epoch = journal.replace(publication, entry.items, now());
        if (epoch !== before) published.events.push({ kind: 'replaced', epoch });
        break;
      }
      case 'prepend': journal.prepend(publication, entry.items); break;
      case 'head': {
        const before = journal.publisher?.watermark;
        journal.setHead(publication, entry.head);
        const head = journal.head;
        if (journal.publisher?.watermark !== before && head) published.events.push({ kind: 'head', head });
        break;
      }
    }
  }

  /** The refusal for an error the journal raises on purpose; undefined for an unexpected one. */
  function refusalOf(error: unknown, sequence: number): JournalRefusal | undefined {
    if (error instanceof JournalQuotaRefused) return { sequence, reason: 'quota_exceeded' };
    if (error instanceof JournalFencedError) return { sequence, reason: 'fenced' };
    if (error instanceof JournalStaleRevisionError) return { sequence, reason: 'stale_revision', itemKey: error.itemKey };
    if (error instanceof JournalUnknownItemError) return { sequence, reason: 'unknown_item', itemKey: error.itemKey };
    if (error instanceof JournalBodyMissingError) return { sequence, reason: 'body_missing', itemKey: error.itemKey };
    if (error instanceof JournalItemTypeChangedError) return { sequence, reason: 'type_changed', itemKey: error.itemKey };
    if (error instanceof JournalDuplicateItemError) return { sequence, reason: 'duplicate_item', itemKey: error.itemKey };
    if (error instanceof JournalInvalidRowError) return { sequence, reason: 'invalid', itemKey: error.itemKey };
    if (error instanceof JournalInvalidPublicationError) return { sequence, reason: 'invalid' };
    return undefined;
  }

  return {
    open: (hostId, sessionKey, publisherId, openOptions) => serialized<JournalOpened | JournalOpenRefusal>(hostId, async () => {
      if (openOptions.allowed && !openOptions.allowed()) return { refused: 'unavailable' };
      await loadHost(hostId);
      const key = storeKey(hostId, sessionKey);
      const journal = (await load(hostId, sessionKey, true))!;
      const refuse = (refused: JournalOpenRefusal['refused']): JournalOpenRefusal => {
        if (journal.publisher === null) drop(key);
        return { refused };
      };
      if (openOptions.allowed && !openOptions.allowed()) return refuse('unavailable');
      const index = journal.index();
      if (index.length > openOptions.maxIndexItems) return refuse('index_too_large');
      const { generation, watermark } = journal.claim(publisherId);
      const bytes = (await persist(hostId, sessionKey, journal)) ?? journal.residentBytes();
      needsReopen.delete(key);
      account(hostId, sessionKey, bytes);
      remember(hostId, sessionKey, journal, bytes);
      trimCache(key);
      return { generation, watermark, epoch: journal.epoch, index: index.slice(0, openOptions.pageItems), more: index.length > openOptions.pageItems };
    }),

    indexPage: (hostId, sessionKey, epoch, after, maxItems) => serialized<JournalIndexEntry[] | undefined>(hostId, async () => {
      const journal = await load(hostId, sessionKey, false);
      if (!journal || journal.epoch !== epoch) return undefined;
      const page: JournalIndexEntry[] = [];
      for (const entry of journal.index()) {
        if (entry.seqStart <= after) continue;
        page.push(entry);
        if (page.length >= maxItems) break;
      }
      return page;
    }),

    publish: (hostId, sessionKey, generation, entries) => serialized<JournalPublished>(hostId, async () => {
      const fenced = (): JournalPublished => ({ events: [], watermark: 0, refusal: { sequence: entries[0]?.sequence ?? 0, reason: 'fenced' } });
      const key = storeKey(hostId, sessionKey);
      if (needsReopen.has(key)) return fenced();
      const published: JournalPublished = { events: [], watermark: 0 };
      let journal!: SessionJournal;
      let bytes = 0;
      try {
        await loadHost(hostId);
        const loaded = await load(hostId, sessionKey, false);
        const publisherId = loaded?.publisher?.publisherId;
        if (!loaded || publisherId === undefined) return fenced();
        journal = loaded;
        const admit = admission(hostId, sessionKey, journal);
        let applied = false;
        let liveOnlyChanged = false;
        for (const entry of entries) {
          const current = journal.publisher;
          const fresh = current !== null && current.generation === generation && entry.sequence > current.watermark;
          try {
            if (fresh) admit(entry);
            apply(journal, { publisherId, generation, sequence: entry.sequence }, entry, published);
            if (fresh) {
              applied = true;
              if (entry.op === 'seal' || entry.op === 'replace' || (entry.op === 'append' && entry.row.liveOnly === true)) liveOnlyChanged = true;
            }
          } catch (error) {
            const refusal = refusalOf(error, entry.sequence);
            if (!refusal) throw error;
            published.refusal = refusal;
            if (error instanceof JournalQuotaRefused && journal.hasHead) {
              journal.clearHead();
              published.unserved = true;
            }
            break;
          }
        }
        if (liveOnlyChanged) {
          const dropped = journal.dropOldestLiveOnly(limits.liveOnlyItems);
          if (dropped.length > 0) published.droppedLiveOnly = dropped.length;
        }
        if (applied) journal.evict(retainTurns);
        bytes = (await persist(hostId, sessionKey, journal)) ?? journal.residentBytes();
      } catch (error) {
        drop(key);
        needsReopen.add(key);
        throw error;
      }
      account(hostId, sessionKey, bytes);
      remember(hostId, sessionKey, journal, bytes);
      if (journal.hasHead) heads.add(hostId, sessionKey); else heads.remove(hostId, sessionKey);
      bump(hostId);
      trimCache(key);
      return { ...published, watermark: journal.publisher?.watermark ?? 0, cursor: journal.cursor, hasHead: journal.hasHead };
    }),

    fill: (hostId, sessionKey, items) => serialized<JournalFilled>(hostId, async () => {
      const filled: string[] = [], mismatched: string[] = [], unknown: string[] = [], skipped: string[] = [];
      const journal = await load(hostId, sessionKey, false);
      const fits = (journal: SessionJournal, added: number) => {
        const size = journal.residentBytes() + added;
        return size <= Math.min(limits.sessionBytes, cacheLimits.maxBytes) && hostHasRoom(hostId, sessionKey, size);
      };
      let trimmed = false;
      for (const { row, digest } of items) {
        if (!journal || !journal.has(row.itemKey)) { unknown.push(row.itemKey); continue; }
        const added = JSON.stringify(row).length;
        if (!fits(journal, added) && !trimmed) {
          // The first body that does not fit: bodies outside the latest turns, such as ones filled earlier, make room once.
          trimmed = true;
          const evicted = new Set(journal.evict(retainTurns));
          for (const key of filled.filter(filledKey => evicted.has(filledKey))) skipped.push(key);
          for (const key of evicted) { const at = filled.indexOf(key); if (at >= 0) filled.splice(at, 1); }
        }
        if (!fits(journal, added)) { skipped.push(row.itemKey); continue; }
        const outcome = journal.fill(row.itemKey, bodyFromRow(row), digest);
        (outcome === 'filled' ? filled : outcome === 'mismatch' ? mismatched : unknown).push(row.itemKey);
      }
      if (journal) {
        const bytes = (await persist(hostId, sessionKey, journal)) ?? journal.residentBytes();
        account(hostId, sessionKey, bytes);
        remember(hostId, sessionKey, journal, bytes);
        trimCache(storeKey(hostId, sessionKey));
      }
      return { filled, mismatched, unknown, ...(skipped.length > 0 ? { skipped } : {}) };
    }),

    page: (hostId, sessionKey, request, olderBeyondJournal) => serialized<JournalPageResult | undefined>(hostId, async () =>
      (await load(hostId, sessionKey, false))?.page(request, { olderBeyondJournal })),

    status: (hostId, sessionKey) => serialized<JournalStatus | undefined>(hostId, async () => {
      const journal = await load(hostId, sessionKey, false);
      if (!journal) return undefined;
      const head = journal.head;
      return { cursor: journal.cursor, ...(head ? { head } : {}) };
    }),

    forget: hostId => serialized<void>(hostId, async () => {
      for (const [key, entry] of cache) if (entry.hostId === hostId) drop(key);
    }),

    served: (hostId, sessionKey) => heads.served(hostId, sessionKey),

    unserve(hostId, sessionKey) {
      heads.remove(hostId, sessionKey);
      bump(hostId);
    },

    async servedSessions(hostId) {
      await loadHost(hostId);
      return heads.sessions(hostId);
    },

    async loadAllServed() {
      const byHost = new Map<string, JournalListing[]>();
      for (const entry of await store.catalog?.list('') ?? []) {
        const at = entry.sessionKey.indexOf(':');
        if (at < 1) continue;
        const hostId = entry.sessionKey.slice(0, at);
        const listing = byHost.get(hostId) ?? [];
        listing.push(entry);
        byHost.set(hostId, listing);
      }
      for (const [hostId, listing] of byHost) if (!hostsLoaded.has(hostId)) adopt(hostId, listing);
      heads.markEveryHostLoaded();
    },

    deleteHost: hostId => serialized<void>(hostId, async () => {
      bump(hostId);
      const prefix = hostPrefix(hostId);
      const known = [...(usage.get(hostId)?.sessions.keys() ?? [])];
      for (const key of [...cache.keys()]) if (key.startsWith(prefix)) drop(key);
      for (const key of [...needsReopen]) if (key.startsWith(prefix)) needsReopen.delete(key);
      if (store.catalog) await store.catalog.deletePrefix(prefix);
      else for (const sessionKey of known) await store.delete(storeKey(hostId, sessionKey));
      heads.clearHost(hostId);
      usage.set(hostId, { total: 0, sessions: new Map() });
      hostsLoaded.add(hostId);
      bump(hostId);
    }),
  };
}
```

- [ ] **Step 7: Change the uplink.** In `packages/agent-remote-hosted/src/journal-uplink.ts`:

Remove the line `import type { JournalIndexEntry } from '@orchardworks/agent-remote-journal';` and replace the protocol import and the following hosted import with

```ts
import {
  encodeRemoteHostUplinkMessage, JOURNAL_FILL_MAX_ITEMS, JOURNAL_INDEX_MAX_ITEMS, JOURNAL_INDEX_PAGE_MAX_ITEMS, JOURNAL_OLDER_MAX_LIMIT, REMOTE_HOST_UPLINK_VERSION,
  type JournalRefusalReason, type RemoteHostUplinkMessage,
} from '@orchardworks/agent-remote-protocol';

import type { HostJournals, JournalFilled, JournalPublished } from './host-journals.js';
import { packIndex } from './journal-index-pages.js';
```

Replace the `JournalHostMessage` type and its guard with

```ts
export type JournalHostMessage = Extract<RemoteHostUplinkMessage, { type: 'journal_open' | 'journal_index_request' | 'journal_publish' | 'journal_fill' | 'journal_older_done' }>;

export function isJournalHostMessage(message: RemoteHostUplinkMessage): message is JournalHostMessage {
  return message.type === 'journal_open' || message.type === 'journal_index_request' || message.type === 'journal_publish' || message.type === 'journal_fill' || message.type === 'journal_older_done';
}
```

Widen the diagnostic option:

```ts
  diagnostic?(event: 'journal_message_unencodable' | 'journal_store_failed' | 'journal_fanout_failed' | 'journal_quota_exceeded' | 'journal_live_only_dropped'): void;
```

Replace the `journal_open` case, from `case 'journal_open': {` through its closing `}` before `case 'journal_publish'`, with:

```ts
        case 'journal_open': {
          const { sessionKey, requestId } = message;
          const result = await journals.open(hostId, sessionKey, message.publisherId,
            { maxIndexItems: JOURNAL_INDEX_MAX_ITEMS, pageItems: JOURNAL_INDEX_PAGE_MAX_ITEMS, allowed: () => options.current() });
          if (!options.current()) return;
          if ('refused' in result) {
            opened.delete(sessionKey);
            if (result.refused === 'index_too_large') {
              send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_open_refused', requestId, sessionKey, reason: 'index_too_large' });
            }
            return;
          }
          opened.set(sessionKey, result.generation);
          const index = packIndex(result.index);
          const last = index[index.length - 1];
          send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_opened', requestId, sessionKey, generation: result.generation, watermark: result.watermark,
            epoch: result.epoch, index, ...(last && (result.more || index.length < result.index.length) ? { indexAfter: last.seqStart } : {}) });
          return;
        }
        case 'journal_index_request': {
          const { sessionKey, requestId, generation, epoch, after } = message;
          if (opened.get(sessionKey) !== generation) {
            send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_open_refused', requestId, sessionKey, reason: 'invalid' });
            return;
          }
          const entries = await journals.indexPage(hostId, sessionKey, epoch, after, JOURNAL_INDEX_PAGE_MAX_ITEMS + 1);
          if (!options.current()) return;
          if (!entries) {
            send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_open_refused', requestId, sessionKey, reason: 'stale_epoch' });
            return;
          }
          const index = packIndex(entries);
          const last = index[index.length - 1];
          send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_index_page', requestId, sessionKey, index, ...(last && entries.length > index.length ? { indexAfter: last.seqStart } : {}) });
          return;
        }
```

In the `journal_publish` case, immediately before `if (!options.current()) return;` (the one after the `stored` block), add

```ts
          if (stored && result.droppedLiveOnly) options.diagnostic?.('journal_live_only_dropped');
```

and replace

```ts
          if (result.refusal) {
            const { sequence, reason, itemKey } = result.refusal;
            refuse(sessionKey, generation, sequence, reason, itemKey);
          }
```

with

```ts
          if (result.refusal) {
            const { sequence, reason, itemKey } = result.refusal;
            if (reason === 'quota_exceeded') options.diagnostic?.('journal_quota_exceeded');
            refuse(sessionKey, generation, sequence, reason, itemKey);
          }
```

In `packages/agent-remote-hosted/src/relay-diagnostics.ts`, append `'journal_quota_exceeded', 'journal_live_only_dropped'` to the `events` array after `'journal_fanout_failed'`.

In `packages/agent-remote-hosted/src/index.ts`, add `type JournalOpenOptions` to the `host-journals.js` export line, next to `type JournalOpened`.

- [ ] **Step 8: Run the tests and see them pass.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/host-journals-bounds.test.ts src/journal-index-pages.test.ts src/host-journals.test.ts src/journal-uplink.test.ts src/broker-journals.test.ts src/relay-diagnostics.test.ts --testTimeout=10000`
Expected: PASS. Reading a failure: a retention test that differs usually means the latest-N units differ (the live-only `l0` forms its own unit of `turn-0` and is never evicted); a size test that differs means the entry or record sizes moved a few hundred characters, so compare the measured sizes (`residentBytes`) with the limit the test sets.

- [ ] **Step 9: Run the whole package, typecheck, rebuild.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted run test` (Bash `timeout` 300000) then `pnpm --filter @orchardworks/agent-remote-hosted run typecheck` then `pnpm --filter @orchardworks/agent-remote-hosted run build`
Expected: PASS for all. The landed P1-B2 suites (`broker-journal-sessions.test.ts` and the rest) run here and must stay green; none of them uses the changed `open` options.

- [ ] **Step 10: Commit.**

```bash
git add packages/agent-remote-hosted/src
git commit -m "feat(hosted): bound the journal service, take a quota-refused session out of serving, fill within limits, and pull the index page by page" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Measure the service on realistic journals

**Files:**
- Modify: `packages/agent-remote-lab/package.json`, `pnpm-lock.yaml`
- Create: `packages/agent-remote-lab/scripts/journal-benchmark.mjs`

The benchmark runs the real path: `createHostJournals` over `SqlJournalStore` over `node:sqlite`, with 2 KiB bodies. The binding is synchronous, so what the Relay can afford is an event-loop stall. Thresholds: a `publish()` of one realistic batch (128 items, 256 entries) on a 10,000-item journal in at most 60 ms at the 95th percentile; a cold `status()` (load and parse) of that journal in at most 800 ms; a cold `status()` of a 30,000-item journal with every body resident (about 80 MB, the worst case) in at most 1,500 ms. The script lives in the Lab because it needs both the hosted package and the store, and neither the Controller nor the hosted package may depend on the store.

- [ ] **Step 1: Add the dependency.** In `packages/agent-remote-lab/package.json`, add to `dependencies`, after `"@orchardworks/agent-remote-hosted": "workspace:*",`:

```json
    "@orchardworks/agent-remote-journal-sqlite": "workspace:*",
```

and to `scripts`, after `"test:conformance": ...`:

```json
    "benchmark:journals": "node scripts/journal-benchmark.mjs",
```

Run: `pnpm install --offline` (or `pnpm install` if the offline store lacks something)
Expected: the Lab links the store package; `pnpm-lock.yaml` changes by that link only.

- [ ] **Step 2: Write the script.** `packages/agent-remote-lab/scripts/journal-benchmark.mjs`:

```js
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHostJournals } from '@orchardworks/agent-remote-hosted';
import { SqlJournalStore } from '@orchardworks/agent-remote-journal-sqlite';
import { openNodeJournalDatabase } from '@orchardworks/agent-remote-journal-sqlite/node';

const THRESHOLDS = { publishP95Ms: 60, coldStatusMs: 800, largeColdStatusMs: 1500 };
const BODY = 'x'.repeat(2048);
const HOST = 'host-1';
const OPEN = { maxIndexItems: 1_000_000, pageItems: 2000 };
const WORST_CASE = { limits: { sessionBytes: 2 ** 30, hostBytes: 2 ** 40 }, retention: { turns: 1_000_000 } };

const row = (itemKey, turn) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:0`, occurredAt: 1_725_000_000_000, turnId: `turn-${turn}`,
  item: { type: 'assistant_message', text: BODY, messageId: itemKey },
});

/** Publishes `count` complete items as batches of 128 items (256 entries), the size of a Controller's publication. */
async function populate(journals, session, count) {
  const opened = await journals.open(HOST, session, 'controller-1', OPEN);
  let sequence = opened.watermark;
  for (let first = 0; first < count; first += 128) {
    const entries = [];
    for (let n = first; n < Math.min(first + 128, count); n++) {
      entries.push({ sequence: ++sequence, op: 'append', row: row(`item-${n}`, Math.floor(n / 4)) });
      entries.push({ sequence: ++sequence, op: 'complete', itemKey: `item-${n}`, digest: `digest-${n}` });
    }
    const result = await journals.publish(HOST, session, opened.generation, entries);
    if (result.refusal) throw new Error(`The journal refused the benchmark data: ${result.refusal.reason}`);
  }
  return { generation: opened.generation, sequence };
}

async function timed(work) {
  const start = performance.now();
  const value = await work();
  return { ms: performance.now() - start, value };
}

const percentile = (values, fraction) => [...values].sort((left, right) => left - right)[Math.min(values.length - 1, Math.floor(values.length * fraction))];

const directory = await mkdtemp(join(tmpdir(), 'arc-journal-benchmark-'));
const database = await openNodeJournalDatabase(join(directory, 'journals.sqlite'));
const store = new SqlJournalStore(database);
const results = {};
try {
  const journals = createHostJournals({ store, now: Date.now });
  const state = await populate(journals, 'codex:publish', 10_000);
  const rounds = [];
  let sequence = state.sequence;
  for (let round = 0; round < 50; round++) {
    const entries = [];
    for (let n = 0; n < 128; n++) {
      const itemKey = `new-${round}-${n}`;
      entries.push({ sequence: ++sequence, op: 'append', row: row(itemKey, 5_000 + round) });
      entries.push({ sequence: ++sequence, op: 'complete', itemKey, digest: `digest-${itemKey}` });
    }
    const published = await timed(() => journals.publish(HOST, 'codex:publish', state.generation, entries));
    if (published.value.refusal) throw new Error(`Refused: ${published.value.refusal.reason}`);
    rounds.push(published.ms);
  }
  results.publishP95Ms = percentile(rounds, 0.95);

  const cold = createHostJournals({ store, now: Date.now });
  results.coldStatusMs = (await timed(() => cold.status(HOST, 'codex:publish'))).ms;

  const worst = createHostJournals({ store, now: Date.now, ...WORST_CASE });
  await populate(worst, 'codex:large', 30_000);
  const coldLarge = createHostJournals({ store, now: Date.now, ...WORST_CASE });
  const loaded = await timed(() => coldLarge.status(HOST, 'codex:large'));
  if (!loaded.value) throw new Error('The large journal was not found.');
  results.largeColdStatusMs = loaded.ms;
} finally {
  database.close();
  await rm(directory, { recursive: true, force: true });
}

console.log(`node ${process.version}`);
let failed = false;
for (const [name, limit] of Object.entries(THRESHOLDS)) {
  const ok = results[name] <= limit;
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${results[name].toFixed(1)} (limit ${limit})`);
}
process.exitCode = failed ? 1 : 0;
```

- [ ] **Step 3: Build what the script imports and run it on both Node versions.**

Run: `pnpm --filter @orchardworks/agent-remote-journal-sqlite run build` then `pnpm --filter @orchardworks/agent-remote-lab run benchmark:journals` (Bash `timeout` 600000)
Expected: three `ok` lines and exit code 0 on the default Node (26).

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-lab run benchmark:journals` (Bash `timeout` 600000)
Expected: three `ok` lines and exit code 0 on Node 22.23.2.

- [ ] **Step 4: Decide.** If both runs pass, `node:sqlite` is the binding (Decision 1); copy the two result blocks into the commit message below. **If any threshold fails on either Node, stop and report the numbers to the owner.** Do not continue the plan and do not change the binding.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-lab/package.json pnpm-lock.yaml packages/agent-remote-lab/scripts/journal-benchmark.mjs
git commit -m "test(lab): measure the journal service over SQLite on realistic journals" -m "Measured on Node 22.23.2 and 26: <paste the two result blocks here>" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: The switch, the gate, stopping streams and durable deletion in the broker

**Files:**
- Modify: `packages/agent-remote-hosted/src/journal-sessions.ts`, `journal-session-stream.ts`, `journal-sessions.test.ts`
- Modify: `packages/agent-remote-hosted/src/state.ts`
- Create: `packages/agent-remote-hosted/src/smart-reading.test.ts`
- Modify: `packages/agent-remote-hosted/src/test-utils/journal-session-fixture.ts`
- Create: `packages/agent-remote-hosted/src/broker-journal-switch.test.ts`
- Modify: `packages/agent-remote-hosted/src/broker.ts`
- Modify: `packages/agent-remote-cloudflare/test/storage-codec-worker.test.ts`

- [ ] **Step 1: Write the failing tests for the gate and for stopping streams.** In `packages/agent-remote-hosted/src/journal-sessions.test.ts`, change the import to

```ts
import { createJournalSessions, type JournalGate } from './journal-sessions.js';
```

add the gate to the existing test's `createJournalSessions({ ... })` call, after the `journals:` line:

```ts
      gate: { readingEnabled: () => true, served: () => true, loadServed: async () => undefined },
```

and give that call's `journals:` fake an `unserve: () => undefined` member too. Then append at the end of the file:

```ts
describe('whether a session is read from its journal', () => {
  function build(gate: Partial<JournalGate>) {
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const calls: string[] = [];
    const sessions = createJournalSessions({
      journals: { status: async () => undefined, page: async () => undefined, unserve: () => undefined },
      gate: {
        readingEnabled: () => { calls.push('enabled'); return true; },
        served: () => { calls.push('served'); return true; },
        loadServed: async () => { calls.push('load'); },
        ...gate,
      },
      requestFill: async () => ({}) as never,
      requestOlder: async () => ({ olderAvailable: false }),
      scheduler: { setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: timer => { timers.delete(timer as number); } },
    });
    return { sessions, calls, timers };
  }

  it('is crude while the switch is off, without asking the index', async () => {
    const { sessions, calls } = build({ readingEnabled: () => false });
    expect(await sessions.serves('host-1', 'codex', 'codex:a')).toBe(false);
    expect(calls).toEqual([]);
  });

  it('answers from the index without loading anything', async () => {
    const served = build({});
    expect(await served.sessions.serves('host-1', 'codex', 'codex:a')).toBe(true);
    const unserved = build({ served: () => false });
    expect(await unserved.sessions.serves('host-1', 'codex', 'codex:a')).toBe(false);
    expect(served.calls).not.toContain('load');
    expect(unserved.calls).not.toContain('load');
  });

  it('loads the Host once for every open that asks while it loads, and then answers', async () => {
    let loaded = false;
    let loads = 0;
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const { sessions } = build({ served: () => (loaded ? true : undefined), loadServed: async () => { loads += 1; await held; loaded = true; } });
    const answers = [sessions.serves('host-1', 'codex', 'codex:a'), sessions.serves('host-1', 'codex', 'codex:b'), sessions.serves('host-1', 'codex', 'codex:c')];
    finish();
    expect(await Promise.all(answers)).toEqual([true, true, true]);
    expect(loads).toBe(1);
  });

  it('serves crude when the load takes longer than the wait, on the broker\'s scheduler', async () => {
    const { sessions, timers } = build({ served: () => undefined, loadServed: () => new Promise<void>(() => undefined) });
    const answer = sessions.serves('host-1', 'codex', 'codex:a');
    expect(timers.size).toBe(1);
    [...timers.values()][0]!();
    expect(await answer).toBe(false);
  });

  it('serves crude when the load fails', async () => {
    const { sessions } = build({ served: () => undefined, loadServed: async () => { throw new Error('store unavailable'); } });
    expect(await sessions.serves('host-1', 'codex', 'codex:a')).toBe(false);
  });
});

describe('stopping journal-served streams', () => {
  function attached() {
    const sessions = createJournalSessions({
      journals: { status: async () => undefined, page: async () => undefined, unserve: () => undefined },
      gate: { readingEnabled: () => true, served: () => true, loadServed: async () => undefined },
      requestFill: async () => ({}) as never,
      requestOlder: async () => ({ olderAvailable: false }),
      scheduler: { setTimeout: () => 0, clearTimeout: () => undefined },
    });
    const offline: HostStreamOpener = { open: async () => { throw Object.assign(new Error('The Remote Host is offline.'), { code: 'host_offline' }); } };
    const attach = (hostId: string, sessionKey: string) => {
      const { client, closed } = socket();
      sessions.attach({ hostId, sessionKey, publicAgentId: 'agent', client, hostStreams: offline });
      return closed;
    };
    return { sessions, attach };
  }

  it('closes the streams of one provider of one Host with 1012 when its smart reading is turned off, and no others', () => {
    const { sessions, attach } = attached();
    const codex = attach('host-1', 'codex:a');
    const claude = attach('host-1', 'claude:a');
    const other = attach('host-2', 'codex:a');
    sessions.stopReading('host-1', 'codex');
    expect(codex).toEqual([[1012, 'Smart reading turned off']]);
    expect(claude).toEqual([]);
    expect(other).toEqual([]);
  });

  it('closes the streams of a session that a quota took out of serving', () => {
    const { sessions, attach } = attached();
    const taken = attach('host-1', 'codex:a');
    const kept = attach('host-1', 'codex:b');
    sessions.published('host-1', 'codex:a', { events: [], watermark: 4, unserved: true, hasHead: false });
    expect(taken).toEqual([[1012, 'Journal unavailable']]);
    expect(kept).toEqual([]);
  });
});
```

```ts
describe('a journal that has no head although the index said it had one', () => {
  it('is forgotten by the index before the stream closes with 1012, so the client\'s reconnect is read through the Controller', async () => {
    const unserved: string[] = [];
    const sessions = createJournalSessions({
      journals: { status: async () => undefined, page: async () => undefined, unserve: (hostId, sessionKey) => { unserved.push(`${hostId}/${sessionKey}`); } },
      gate: { readingEnabled: () => true, served: () => true, loadServed: async () => undefined },
      requestFill: async () => ({}) as never,
      requestOlder: async () => ({ olderAvailable: false }),
      scheduler: { setTimeout: () => 0, clearTimeout: () => undefined },
    });
    const offline: HostStreamOpener = { open: async () => { throw Object.assign(new Error('The Remote Host is offline.'), { code: 'host_offline' }); } };
    const { client, closed } = socket();
    const stream = sessions.attach({ hostId: 'host-1', sessionKey: 'codex:a', publicAgentId: 'agent', client, hostStreams: offline });
    stream.receive(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(unserved).toEqual(['host-1/codex:a']);
    expect(closed).toEqual([[1012, 'Session journal unavailable']]);
  });
});
```

- [ ] **Step 2: Write the failing tests for the persisted switch.** `packages/agent-remote-hosted/src/smart-reading.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { emptyRelayState, validateRelayState } from './state.js';

const auth = { origin: 'https://relay.example', issuer: 'https://issuer.example', secret: 'test-secret' };
const state = (host: Record<string, unknown> = {}, broker: Record<string, unknown> = {}) => ({
  ...emptyRelayState(auth),
  tenants: [{ subject: 'owner', namespace: createHash('sha256').update(JSON.stringify([auth.issuer, 'owner'])).digest('hex'), broker: {
    keys: [], bindings: [], creations: [],
    hosts: [{ id: 'host', installationId: 'machine', name: 'Machine', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false, ...host }],
    ...broker,
  } }],
});

describe('the smart reading switch in saved state', () => {
  it('accepts a Host without the switch and a Host with distinct providers', () => {
    expect(() => validateRelayState(state(), auth)).not.toThrow();
    expect(() => validateRelayState(state({ smartReading: ['claude', 'codex'] }), auth)).not.toThrow();
  });

  it.each([
    ['an empty list', []],
    ['a repeated provider', ['codex', 'codex']],
    ['a provider that is not a string', [1]],
    ['an empty provider id', ['']],
    ['something that is not a list', 'codex'],
    ['more than 64 providers', Array.from({ length: 65 }, (_, at) => `provider-${at}`)],
  ])('rejects %s', (_name, value) => {
    expect(() => validateRelayState(state({ smartReading: value }), auth)).toThrow();
  });
});

describe('the pending journal deletions in saved state', () => {
  it('accepts none and a list of distinct Host ids', () => {
    expect(() => validateRelayState(state({}, { journalDeletions: ['gone-1', 'gone-2'] }), auth)).not.toThrow();
  });

  it.each([
    ['an empty list', []],
    ['a repeated id', ['gone', 'gone']],
    ['an id that is not a string', [1]],
    ['something that is not a list', 'gone'],
    ['more than 128 ids', Array.from({ length: 129 }, (_, at) => `gone-${at}`)],
  ])('rejects %s', (_name, value) => {
    expect(() => validateRelayState(state({}, { journalDeletions: value }), auth)).toThrow();
  });
});
```

- [ ] **Step 3: Extend the landed fixture.** In `packages/agent-remote-hosted/src/test-utils/journal-session-fixture.ts`:

Change the import on line 4 to

```ts
import { createHostBroker, createHostJournals, type BrokerRequestContext, type HostBrokerOptions, type HostJournalsOptions, type RelaySocket, type RemoteHostBrokerState } from '../index.js';
```

In `savedState`, give the Host the switch: replace `legacyDsh: false }],` with `legacyDsh: false, smartReading: ['codex'] }],`. Every landed journal-served test then keeps serving from its journal; a test that needs the switch off removes it through `state`.

In `RelayOptions`, change the `broker` property to

```ts
  broker?: Partial<Pick<HostBrokerOptions, 'ownerSubject' | 'userStreamCount' | 'onStateChange'>>;
  /** Safety limits of the journal service, for tests of a quota. */
  journalLimits?: HostJournalsOptions['limits'];
  /** Wraps the in-memory store the broker keeps its journals in, for tests of a store that is slow or fails. */
  journalStore?(memory: MemoryJournalStore): JournalStore;
```

and in the `createHostBroker({ ... })` call insert, before `...options.broker`:

```ts
    ...(options.journalLimits ? { journalService: createHostJournals({ store, now: () => 10_000, limits: options.journalLimits }) } : {}),
```

and in the same call replace `journals: store,` with `journals: options.journalStore ? options.journalStore(store) : store,` (the call currently reads `journals: store, journalRequestTimeoutMs: options.requestTimeoutMs ?? 1000, ...options.broker });`). Add `type JournalStore` to the fixture's import from `@orchardworks/agent-remote-journal` on its first line.

`packages/agent-remote-hosted/src/broker-journal-switch.test.ts`:

```ts
import { MemoryJournalStore, SessionJournal, type JournalStore } from '@orchardworks/agent-remote-journal';
import { afterEach, expect, it } from 'vitest';

import { createHostBroker, type RemoteHostBrokerState } from './index.js';
import { DIGEST, HOST_ID, PUBLIC_ID, row, SESSION_KEY, seedJournal, sleep, snapshot, startRelay, STORE_KEY, type Wire } from './test-utils/journal-session-fixture.js';

const started: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => { for (const relay of started.splice(0)) await relay.dispose(); });
async function relay(options: Parameters<typeof startRelay>[0] = {}) {
  const value = await startRelay(options);
  started.push(value);
  return value;
}
type Relay = Awaited<ReturnType<typeof relay>>;

const withoutSwitch = (saved: RemoteHostBrokerState): RemoteHostBrokerState =>
  ({ ...saved, hosts: saved.hosts.map(({ smartReading: _smartReading, ...host }) => host) });
const withSwitch = (smartReading: string[]) => (saved: RemoteHostBrokerState): RemoteHostBrokerState =>
  ({ ...saved, hosts: saved.hosts.map(host => ({ ...host, smartReading })) });
const REJECTED = 'Session stream rejected: 503';

const route = (r: Pick<Relay, 'broker'>, method: string, body?: Wire) => r.broker.handleRequest(
  new Request(`https://relay.example/v1/remote/hosts/${HOST_ID}/smart-reading`, { method, headers: { 'content-type': 'application/json', origin: 'https://relay.example' }, ...(body ? { body: JSON.stringify(body) } : {}) }), {});

it('reads from the journal only while the owner has smart reading on for the provider, and closes the streams when it is turned off', async () => {
  const r = await relay({ state: withoutSwitch, seed: store => seedJournal(store) });
  await expect(r.openBrowser()).rejects.toThrow(REJECTED);
  const on = (await route(r, 'PUT', { providerId: 'codex', enabled: true }))!;
  expect(on.status).toBe(200);
  expect(await on.json()).toEqual({ providers: ['codex'] });
  const browser = await r.openBrowser();
  browser.send({ type: 'negotiate' });
  expect(await browser.take(message => message.type === 'agent_snapshot', 'Snapshot')).toMatchObject({ payload: { id: PUBLIC_ID, status: 'idle' } });
  const off = (await route(r, 'PUT', { providerId: 'codex', enabled: false }))!;
  expect(await off.json()).toEqual({ providers: [] });
  expect(browser.pair.native.closeCode).toBe(1012);
  expect(browser.pair.native.closeReason).toBe('Smart reading turned off');
  await expect(r.openBrowser()).rejects.toThrow(REJECTED);
});

it('does not read from the journal for a provider the switch does not name', async () => {
  const r = await relay({ state: withSwitch(['claude']), seed: store => seedJournal(store) });
  await expect(r.openBrowser()).rejects.toThrow(REJECTED);
});

it('does not read from the journal of a session that has none, or none with a head, even with the switch on', async () => {
  const none = await relay();
  await expect(none.openBrowser()).rejects.toThrow(REJECTED);
  const headless = await relay({ seed: store => seedJournal(store, { head: false }) });
  await expect(headless.openBrowser()).rejects.toThrow(REJECTED);
});

it('lists the providers with smart reading on and refuses a malformed change', async () => {
  const r = await relay({ state: withSwitch(['claude', 'codex']) });
  expect(await (await route(r, 'GET'))!.json()).toEqual({ providers: ['claude', 'codex'] });
  expect((await route(r, 'PUT', { providerId: 'codex' }))!.status).toBe(400);
  expect((await route(r, 'PUT', { providerId: '', enabled: true }))!.status).toBe(400);
  expect((await route(r, 'PUT', { providerId: 'codex', enabled: true, extra: 1 }))!.status).toBe(400);
  expect((await route(r, 'DELETE'))!.status).toBe(405);
  const unknown = await r.broker.handleRequest(new Request('https://relay.example/v1/remote/hosts/nobody/smart-reading', { method: 'GET' }), {});
  expect(unknown!.status).toBe(404);
});

it('saves the switch with the Host, keeps it when the Controller registers again, and loads it back', async () => {
  let saved: RemoteHostBrokerState | undefined;
  const r = await relay({ state: withoutSwitch, broker: { onStateChange: async state => { saved = structuredClone(state); } } });
  await route(r, 'PUT', { providerId: 'codex', enabled: true });
  expect(saved!.hosts[0]).toMatchObject({ id: HOST_ID, smartReading: ['codex'] });
  await r.connectController();
  await sleep(20);
  expect(saved!.hosts[0]).toMatchObject({ id: HOST_ID, smartReading: ['codex'] });
  const again = createHostBroker({ origin: 'https://relay.example', initialState: saved!, now: () => 10_000 });
  try { expect(await (await route({ broker: again }, 'GET'))!.json()).toEqual({ providers: ['codex'] }); }
  finally { again.close(); }
  await route(r, 'PUT', { providerId: 'codex', enabled: false });
  expect(saved!.hosts[0]).not.toHaveProperty('smartReading');
});

it('takes a session out of serving when a quota refuses a publication: its streams close, a new one is read from the Controller, and the head is cleared', async () => {
  const r = await relay({ journalLimits: { sessionItems: 1 } });
  const controller = await r.connectController();
  const opened = await controller.open();
  await controller.publish([
    { op: 'append', row: row('m1', 'Hello') }, { op: 'complete', itemKey: 'm1', digest: DIGEST },
    { op: 'head', head: { snapshot: snapshot('idle', 'native-session'), observedAt: 5 } },
  ]);
  const browser = await r.openBrowser();
  browser.send({ type: 'negotiate' });
  await browser.take(message => message.type === 'agent_snapshot', 'Snapshot');
  controller.send({ type: 'journal_publish', sessionKey: SESSION_KEY, generation: opened.generation, entries: [{ sequence: 4, op: 'append', row: row('m2', 'World') }] });
  expect(await controller.inbox.take(message => message.type === 'journal_refused', 'refusal')).toMatchObject({ sequence: 4, reason: 'quota_exceeded' });
  await sleep(20);
  expect(browser.pair.native.closeCode).toBe(1012);
  expect((await r.store.load(STORE_KEY))!.meta.head).toBeUndefined();
  const crude = await r.openBrowser();
  crude.send({ type: 'negotiate' });
  expect(await crude.take(message => message.type === 'agent_snapshot', 'Snapshot')).toMatchObject({ payload: { status: 'running' } });
});

/** A broker over a store whose first deletion by prefix fails. */
function revocation(store: JournalStore, states: RemoteHostBrokerState[], initialState?: RemoteHostBrokerState) {
  return createHostBroker({ origin: 'https://relay.example', accountBacked: true, journals: store, now: () => 10_000,
    onStateChange: async state => { states.push(structuredClone(state)); },
    initialState: initialState ?? {
      keys: [], creations: [],
      hosts: [{ id: HOST_ID, installationId: 'restored-installation', name: 'Restored Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false }],
      bindings: [{ hostId: HOST_ID, providerId: 'codex', nativeSessionId: 'native-session', agentId: PUBLIC_ID }],
    } });
}
const revoke = (broker: ReturnType<typeof revocation>) => broker.handleRequest(new Request(`https://relay.example/v1/remote/hosts/${HOST_ID}/revoke`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://relay.example' }, body: '{}' }), {});

async function otherHostJournal(store: MemoryJournalStore) {
  const other = SessionJournal.create('other-host:codex:native-session');
  const { generation } = other.claim('controller-1');
  other.append({ publisherId: 'controller-1', generation, sequence: 1 }, row('m1', 'Hello'));
  await store.apply(other.takeChanges()!);
}

it('deletes the journals of a Host when the owner revokes it, and no other, recording the deletion in the same commit', async () => {
  const store = new MemoryJournalStore();
  await seedJournal(store);
  await otherHostJournal(store);
  const states: RemoteHostBrokerState[] = [];
  const broker = revocation(store, states);
  try {
    expect((await revoke(broker))!.status).toBe(200);
    expect(states[0]!.journalDeletions).toEqual([HOST_ID]);
    expect(states[0]!.hosts).toEqual([]);
    await sleep(30);
    expect((await store.catalog.list('')).map(({ sessionKey }) => sessionKey)).toEqual(['other-host:codex:native-session']);
    expect(states.at(-1)).not.toHaveProperty('journalDeletions');
  } finally { broker.close(); }
});

it('keeps a deletion the store failed in the saved state and finishes it when the Relay starts again', async () => {
  const memory = new MemoryJournalStore();
  await seedJournal(memory);
  let failures = 1;
  const store: JournalStore = { load: key => memory.load(key), apply: changes => memory.apply(changes), delete: key => memory.delete(key),
    catalog: { list: prefix => memory.catalog.list(prefix), deletePrefix: async prefix => { if (failures-- > 0) throw new Error('disk unavailable'); await memory.catalog.deletePrefix(prefix); } } };
  const states: RemoteHostBrokerState[] = [];
  const first = revocation(store, states);
  try {
    expect((await revoke(first))!.status).toBe(200);
    await sleep(30);
    expect((await memory.catalog.list('')).map(({ sessionKey }) => sessionKey)).toEqual([`${HOST_ID}:${SESSION_KEY}`]);
    expect(states.at(-1)!.journalDeletions).toEqual([HOST_ID]);
  } finally { first.close(); }
  const restarted: RemoteHostBrokerState[] = [];
  const second = revocation(store, restarted, states.at(-1));
  try {
    await sleep(30);
    expect(await memory.catalog.list('')).toEqual([]);
    expect(restarted.at(-1)).not.toHaveProperty('journalDeletions');
  } finally { second.close(); }
});

it('finishes the deletion of a Host revoked while another deletion runs, without waiting for the next start', async () => {
  const memory = new MemoryJournalStore();
  await seedJournal(memory);
  const other = SessionJournal.create('host-2:codex:native-session');
  const { generation } = other.claim('controller-1');
  other.append({ publisherId: 'controller-1', generation, sequence: 1 }, row('m1', 'Hello'));
  await memory.apply(other.takeChanges()!);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const store: JournalStore = { load: key => memory.load(key), apply: changes => memory.apply(changes), delete: key => memory.delete(key),
    catalog: { list: prefix => memory.catalog.list(prefix), deletePrefix: async prefix => { await gate; await memory.catalog.deletePrefix(prefix); } } };
  const states: RemoteHostBrokerState[] = [];
  const broker = revocation(store, states, {
    keys: [], creations: [], bindings: [{ hostId: HOST_ID, providerId: 'codex', nativeSessionId: 'native-session', agentId: PUBLIC_ID }],
    hosts: [
      { id: HOST_ID, installationId: 'restored-installation', name: 'Restored Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false },
      { id: 'host-2', installationId: 'second-installation', name: 'Second Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false },
    ],
  });
  try {
    expect((await revoke(broker))!.status).toBe(200);
    expect((await broker.handleRequest(new Request('https://relay.example/v1/remote/hosts/host-2/revoke', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://relay.example' }, body: '{}' }), {}))!.status).toBe(200);
    expect(states.at(-1)!.journalDeletions).toEqual([HOST_ID, 'host-2']);
    release();
    await sleep(50);
    expect(await memory.catalog.list('')).toEqual([]);
    expect(states.at(-1)).not.toHaveProperty('journalDeletions');
  } finally { broker.close(); }
});

it('deletes the pending journals of a Host before it is told it is registered, so its new journal is not deleted afterwards', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const r = await relay({
    state: saved => ({ ...saved, journalDeletions: [HOST_ID] }),
    seed: store => seedJournal(store),
    journalStore: memory => ({ load: key => memory.load(key), apply: changes => memory.apply(changes), delete: key => memory.delete(key),
      catalog: { list: prefix => memory.catalog.list(prefix), deletePrefix: async prefix => { await gate; await memory.catalog.deletePrefix(prefix); } } }),
  });
  let registered = false;
  const connecting = r.connectController().then(controller => { registered = true; return controller; });
  await sleep(60);
  expect(registered).toBe(false);
  release();
  const controller = await connecting;
  const opened = await controller.open();
  expect(opened).toMatchObject({ watermark: 0, index: [] });
  await sleep(30);
  expect((await r.store.catalog.list('')).map(({ sessionKey }) => sessionKey)).toEqual([STORE_KEY]);
});
```

Add the codec test to `packages/agent-remote-cloudflare/test/storage-codec-worker.test.ts`, after the first `test(...)` block:

```ts
test('keeps the smart reading switch of a Host and the pending journal deletions through the SQL snapshot and a persisted restart', async () => {
  const f = await fixture({ completeCodec: true }); const state = codecState({ origin, issuer, secret });
  const broker = state.tenants[0]!.broker;
  broker.hosts[0]!.smartReading = ['claude', 'codex'];
  broker.journalDeletions = ['revoked-host'];
  expect((await f.inspect('codec/seed', { method: 'POST', body: JSON.stringify(state) })).status).toBe(200);
  expect(await (await f.inspect('codec/snapshot')).json()).toEqual(state);
  await f.restart();
  expect(await (await f.inspect('codec/snapshot')).json()).toEqual(state);
}, 30000);
```

- [ ] **Step 4: Run the tests and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/journal-sessions.test.ts src/smart-reading.test.ts --testTimeout=10000`
Expected: FAIL (`serves` takes two arguments, `gate` and `stopReading` do not exist, `smartReading` and `journalDeletions` are not validated).

- [ ] **Step 5: Implement the gate and the stopping of streams.** In the landed `packages/agent-remote-hosted/src/journal-session-stream.ts`, add to `JournalReads`, after `olderBeyondJournal(): boolean;`:

```ts
  /** The journal has no head although the index said it had one; the index forgets the session before the stream closes. */
  noHead?(): void;
```

and in both places that read `if (!status?.head) { shutdown(1012, 'Session journal unavailable'); return; }` (in `refreshHead` and in `negotiate`) call it first:

```ts
    if (!status?.head) { reads.noHead?.(); shutdown(1012, 'Session journal unavailable'); return; }
```

In the landed `packages/agent-remote-hosted/src/journal-sessions.ts`:

Change `journals: Pick<HostJournals, 'status' | 'page'>;` in `JournalSessionsOptions` to `journals: Pick<HostJournals, 'status' | 'page' | 'unserve'>;`, and in `attach`, add to the `reads` object, after `olderBeyondJournal: () => !shared.olderExhausted,`:

```ts
        noHead: () => options.journals.unserve(hostId, sessionKey),
```

After `journalSessionKey` add:

```ts
/** What decides whether a session is read from its journal. Once a Host is loaded, every answer comes from memory. */
export interface JournalGate {
  /** Whether the owner turned smart reading on for the provider of the Host. */
  readingEnabled(hostId: string, providerId: string): boolean;
  /** Whether the session has a journal head; undefined while the Host's sessions are not loaded. */
  served(hostId: string, sessionKey: string): boolean | undefined;
  /** Loads the Host's sessions that have a head. */
  loadServed(hostId: string): Promise<void>;
}

/** How long opening a stream waits for a Host's sessions to load before it is served crude. */
export const JOURNAL_GATE_LOAD_WAIT_MS = 2000;
```

In `JournalSessionsOptions`, after the `journals:` line add `gate: JournalGate;`.

In `JournalSessions`, replace

```ts
  /** Whether the session's reads are served from its journal: a journal with a head exists. */
  serves(hostId: string, sessionKey: string): Promise<boolean>;
```

with

```ts
  /**
   * Whether the session's reads are served from its journal: the owner turned smart reading on for the provider, and the
   * session has a journal head. A Host whose sessions were never loaded is loaded once, within a bound, however many opens
   * ask; after that the answer is immediate and never waits on the store or on the Host's journal queue.
   */
  serves(hostId: string, providerId: string, sessionKey: string): Promise<boolean>;
  /** Smart reading was turned off for the provider of the Host: its journal-served streams close with 1012, so their clients reconnect crude. */
  stopReading(hostId: string, providerId: string): void;
```

In the `SharedSession` interface add

```ts
  sessionKey: string;
  /** The browser sockets of the session's streams, to close them when the session stops being served. */
  clients: Map<JournalSessionStream, Pick<RelaySocket, 'close'>>;
```

In `createJournalSessions`, after `const keyOf = ...` add

```ts
  /** The load of each Host's sessions in flight, shared by every open that asks. */
  const loads = new Map<string, Promise<void>>();
  const loadServed = (hostId: string): Promise<void> => {
    let load = loads.get(hostId);
    if (!load) {
      load = options.gate.loadServed(hostId).finally(() => { loads.delete(hostId); });
      loads.set(hostId, load);
    }
    return load;
  };
  const closeClients = (shared: SharedSession, reason: string): void => {
    for (const client of [...shared.clients.values()]) {
      try { client.close(1012, reason); }
      catch { /* A client that cannot be closed is gone. */ }
    }
  };
```

Replace the `serves` implementation

```ts
    async serves(hostId, sessionKey) {
      return (await options.journals.status(hostId, sessionKey))?.head !== undefined;
    },
```

with

```ts
    async serves(hostId, providerId, sessionKey) {
      if (!options.gate.readingEnabled(hostId, providerId)) return false;
      const known = options.gate.served(hostId, sessionKey);
      if (known !== undefined) return known;
      await waitFor(loadServed(hostId), JOURNAL_GATE_LOAD_WAIT_MS, options.scheduler);
      return options.gate.served(hostId, sessionKey) === true;
    },

    stopReading(hostId, providerId) {
      for (const shared of [...sessions.values()]) {
        if (shared.hostId === hostId && shared.sessionKey.startsWith(`${providerId}:`)) closeClients(shared, 'Smart reading turned off');
      }
    },
```

In `attach`, change the object literal `{ hostId, streams: new Set<JournalSessionStream>(), olderExhausted: false, replacements: 0, fillTail: Promise.resolve(), pending: 0 }` to

```ts
{ hostId, sessionKey, clients: new Map(), streams: new Set<JournalSessionStream>(), olderExhausted: false, replacements: 0, fillTail: Promise.resolve(), pending: 0 }
```

after `shared.streams.add(stream);` add `shared.clients.set(stream, attachment.client);`, and in the returned `close()` after `shared.streams.delete(stream);` add `shared.clients.delete(stream);`.

In `published`, after `if (!shared) return;` add

```ts
      if (result.unserved) { closeClients(shared, 'Journal unavailable'); return; }
```

At the end of the file add:

```ts
/** Resolves when the work settles or after `ms`, whichever is first; a failure of the work is not an error here. */
function waitFor(work: Promise<void>, ms: number, scheduler: BrokerScheduler): Promise<void> {
  return new Promise(resolve => {
    const timer = scheduler.setTimeout(resolve, ms);
    work.then(() => undefined, () => undefined).then(() => { scheduler.clearTimeout(timer); resolve(); });
  });
}
```

- [ ] **Step 6: Validate the persisted fields.** In `packages/agent-remote-hosted/src/state.ts`, after the `unique` function add:

```ts
/** The providers a Host reads from journals: a nonempty list of at most 64 distinct provider ids. */
function validSmartReading(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 64 && value.every(item => string(item)) && unique(value, item => item);
}
/** Hosts whose journals still await deletion: a nonempty list of at most 128 distinct Host ids. */
function validJournalDeletions(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 128 && value.every(item => string(item)) && unique(value, item => item);
}
```

In the Host validation line (the one containing `(host.outbox === undefined || host.outbox === 1) &&`) insert `(host.smartReading === undefined || validSmartReading(host.smartReading)) &&` immediately after it. After the line `  if (value.revokedHosts !== undefined && !validRevokedHosts(value.revokedHosts)) return false;` add

```ts
  if (value.journalDeletions !== undefined && !validJournalDeletions(value.journalDeletions)) return false;
```

- [ ] **Step 7: Wire the broker.** All edits are in `packages/agent-remote-hosted/src/broker.ts`.

(a) Replace `import { createHostJournals } from './host-journals.js';` with `import { createHostJournals, type HostJournals } from './host-journals.js';`.

(b) In the `Host` type, after `  outbox?: 1;` add

```ts
  /** Providers whose sessions are read from their journals; saved with the Host. Absent: every read goes to the Controller. */
  smartReading?: string[];
```

(c) In `RemoteHostBrokerState`, change `'teamManagement' | 'outbox'>>;` to `'teamManagement' | 'outbox' | 'smartReading'>>;` and add the property, after `revokedHosts?: RevokedHost[];`:

```ts
  /** Hosts that were revoked and whose journals are not yet confirmed deleted. */
  journalDeletions?: string[];
```

(d) In `HostBrokerOptions`, after `journalRequestTimeoutMs?: number;` add

```ts
  /** A journal service built elsewhere, such as one shared by every account or one that reaches journal partitions; used instead of `journals`. */
  journalService?: HostJournals;
```

(e) Replace `  const journals = options.journals && createHostJournals({ store: options.journals, now });` with

```ts
  const journals = options.journalService ?? (options.journals && createHostJournals({ store: options.journals, now }));
```

(f) After `  let revokedHosts = structuredClone(options.initialState?.revokedHosts);` add

```ts
  let journalDeletions = [...(options.initialState?.journalDeletions ?? [])];
```

(g) In `snapshot()`, after `...(revokedHosts ? { revokedHosts: structuredClone(revokedHosts) } : {}),` add `...(journalDeletions.length > 0 ? { journalDeletions: [...journalDeletions] } : {}),`, and replace `teamManagement, outbox }) => ({ ...(outbox ? { outbox } : {}),` with

```ts
teamManagement, outbox, smartReading }) => ({ ...(outbox ? { outbox } : {}), ...(smartReading ? { smartReading: [...smartReading] } : {}),
```

(h) In `register`, in the object `next`, after `...(existing?.gatewayKeyRequested ? { gatewayKeyRequested: true } : {}),` add

```ts
            ...(existing?.smartReading ? { smartReading: existing.smartReading } : {}),
```

in `register`, a Host that comes back with the id of a revoked Host (the recovery flow keeps the old id) must not be told it is registered while its old journals are still to be deleted: before `function registered() {` add `let pendingDeletionHandled = false;`, add at the top of `registered()`, after its first guard line (`if (retired || !host || host.socket !== socket) return;`):

```ts
      if (!pendingDeletionHandled && journals && journalDeletions.includes(host.id)) {
        pendingDeletionHandled = true;
        void finishJournalDeletions(host.id).then(registered);
        return;
      }
```

and in the same function change the condition that grants the journal connection, `host.journal ??= journalRequested && journals`, to `host.journal ??= journalRequested && journals && !journalDeletions.includes(host.id)`: a Host whose deletion failed is granted journals only after a later run confirms it, so a retry cannot delete journals it creates. Then, after the line `      journalSessions?.hostReturned(host.id);` add

```ts
      if (journalDeletions.length > 0) void finishJournalDeletions();
```

(i) The deletion bookkeeping. Immediately before `  const handlesRequest = (url: URL) => {` add:

```ts
  /**
   * Deletes the journals of revoked Hosts the state still lists, one at a time, until none is left that this run has not
   * tried, so a Host revoked while a run is going is not left for the next start. `first` is deleted before the others. Each
   * id leaves the state once the store confirms; an id that failed stays. Runs queue one after another and never reject.
   */
  let deletionTail: Promise<void> = Promise.resolve();
  function finishJournalDeletions(first?: string): Promise<void> {
    const service = journals;
    if (!service) return Promise.resolve();
    const run = deletionTail.then(async () => {
      const tried = new Set<string>();
      for (;;) {
        const hostId = first !== undefined && !tried.has(first) && journalDeletions.includes(first) ? first : journalDeletions.find(id => !tried.has(id));
        if (hostId === undefined) return;
        tried.add(hostId);
        try {
          await service.deleteHost(hostId);
          await commit(draft => {
            const rest = (draft.journalDeletions ?? []).filter(id => id !== hostId);
            if (rest.length > 0) draft.journalDeletions = rest; else delete draft.journalDeletions;
            return { value: undefined, publish() { journalDeletions = rest; } };
          });
        } catch { options.diagnostics?.record(hostId, { event: 'journal_store_failed' }); }
      }
    });
    deletionTail = run;
    return run;
  }
```

and immediately before the line `  return {` that opens the broker's public object (the only `^  return {` at that indent, near the end of `createHostBroker`) add

```ts
  if (journalDeletions.length > 0) void finishJournalDeletions();
```

(j) In the revoke route, in the `commit(draft => { ... })` body add, after `draft.hosts = draft.hosts.filter(value => value.id !== host.id);`:

```ts
        if (journals) draft.journalDeletions = [...(draft.journalDeletions ?? []).filter(id => id !== host.id), host.id];
```

and in its `publish()`, after `previews.forget(host.id);` add

```ts
          if (journals) { journalDeletions = draft.journalDeletions ?? []; void finishJournalDeletions(); }
```

(k) The owner's route. Immediately before `const revoking = /^\/v1\/remote\/hosts\/([^/]+)\/revoke$/.exec(url.pathname);` add:

```ts
    const reading = /^\/v1\/remote\/hosts\/([^/]+)\/smart-reading$/.exec(url.pathname);
    if (reading) {
      requireOwner(subject);
      const host = hosts.get(reading[1]!);
      if (!host) throw new BrokerError(404, 'host_not_found', 'The Remote Host is unknown.');
      if (request.method === 'GET') return json(200, { providers: host.smartReading ?? [] });
      if (request.method !== 'PUT') return json(405, { error: 'Method is not allowed.' });
      const body = await readBody(request);
      if (Object.keys(body).some(key => key !== 'providerId' && key !== 'enabled') || typeof body.enabled !== 'boolean') {
        throw new BrokerError(400, 'invalid_request', 'Name a provider and whether smart reading is on for it.');
      }
      const providerId = required(body.providerId, 'providerId');
      const enabled = body.enabled;
      const providers = await commit(draft => {
        assertHostCurrent(host);
        const saved = draft.hosts.find(value => value.id === host.id);
        if (!saved) throw new BrokerError(404, 'host_not_found', 'The Remote Host is unknown.');
        const next = new Set(saved.smartReading ?? []);
        if (enabled) next.add(providerId); else next.delete(providerId);
        if (next.size > 64) throw new BrokerError(400, 'invalid_request', 'Smart reading names at most 64 providers per Host.');
        const list = [...next].sort();
        if (list.length > 0) saved.smartReading = list; else delete saved.smartReading;
        return { value: list, publish() {
          host.smartReading = list.length > 0 ? list : undefined;
          if (!enabled) journalSessions?.stopReading(host.id, providerId);
        } };
      });
      return json(200, { providers });
    }
```

(l) The gate. In the landed code that creates `journalSessions`, replace

```ts
  const journalSessions = journals && createJournalSessions({
    journals, scheduler,
```

with

```ts
  const journalSessions = journals && createJournalSessions({
    journals, scheduler,
    gate: {
      readingEnabled: (hostId, providerId) => hosts.get(hostId)?.smartReading?.includes(providerId) === true,
      served: (hostId, sessionKey) => journals.served(hostId, sessionKey),
      loadServed: async hostId => { await journals.servedSessions(hostId); },
    },
```

and in `upgrade` replace `journalSessions!.serves(journalHost.id, journalSessionKey(binding.providerId, binding.nativeSessionId))` with `journalSessions!.serves(journalHost.id, binding.providerId, journalSessionKey(binding.providerId, binding.nativeSessionId))`; leave the `.catch(...)` after it and the lines around it as they are.

- [ ] **Step 8: Run the tests and see them pass.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/journal-sessions.test.ts src/smart-reading.test.ts src/broker-journal-switch.test.ts src/broker-journal-sessions.test.ts src/broker-journals.test.ts --testTimeout=10000`
Expected: PASS. The landed `broker-journal-sessions.test.ts` runs against a Host that has the switch on (the fixture), so it is unchanged.

- [ ] **Step 9: Run the whole hosted package, typecheck, rebuild.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted run test` (Bash `timeout` 300000) then `pnpm --filter @orchardworks/agent-remote-hosted run typecheck` then `pnpm --filter @orchardworks/agent-remote-hosted run build`
Expected: PASS for all.

- [ ] **Step 10: Run the Cloudflare codec test.**

Run: `pnpm --filter @orchardworks/agent-remote-cloudflare exec vitest run test/storage-codec-worker.test.ts --testTimeout=30000 --maxWorkers=1` (Bash `timeout` 300000)
Expected: PASS.

- [ ] **Step 11: Commit.**

```bash
git add packages/agent-remote-hosted/src packages/agent-remote-cloudflare/test/storage-codec-worker.test.ts
git commit -m "feat(hosted): gate journal reads on a persisted per-provider switch and an in-memory head index, stop streams, delete a revoked Host's journals durably" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: One journal service for the whole hosted Relay, on durable state

**Files:**
- Modify: `packages/agent-remote-hosted/src/gateway.ts`
- Modify: `packages/agent-remote-hosted/src/gateway.test.ts`

Until now every account (tenant) built its own journal service over the shared store, so caches and quotas would be bounded per account, not per Relay. The hosted Relay now builds one service and hands it to every account's broker. Because a deletion that is not recorded in durable state could be lost, journals require durable state.

- [ ] **Step 1: Write the failing tests.** Append to `packages/agent-remote-hosted/src/gateway.test.ts` (add `import { MemoryJournalStore } from '@orchardworks/agent-remote-journal';` to its imports):

```ts
it('refuses journals without durable Relay state', () => {
  expect(() => createHostedRelay({ ...auth, scheduler, journals: new MemoryJournalStore() })).toThrow(/durable/);
  expect(() => createHostedRelay({ ...auth, scheduler, journalService: {} as never })).toThrow(/durable/);
});

it('builds one journal service over its store and loads its head index on request', async () => {
  const memory = new MemoryJournalStore();
  const listed: string[] = [];
  const journals = { load: (key: string) => memory.load(key), apply: memory.apply.bind(memory), delete: (key: string) => memory.delete(key),
    catalog: { list: async (prefix: string) => { listed.push(prefix); return []; }, deletePrefix: (prefix: string) => memory.catalog.deletePrefix(prefix) } };
  const relay = createHostedRelay({ ...auth, scheduler, journals, storage: { initial: emptyRelayState(auth), async commit() {} } });
  closers.push(() => relay.close());
  await relay.loadJournalIndex();
  expect(listed).toEqual(['']);
});

it('uses a journal service built elsewhere, and loads nothing without one', async () => {
  let loads = 0;
  const journalService = { loadAllServed: async () => { loads += 1; } } as unknown as NonNullable<Parameters<typeof createHostedRelay>[0]['journalService']>;
  const served = createHostedRelay({ ...auth, scheduler, journalService, storage: { initial: emptyRelayState(auth), async commit() {} } });
  closers.push(() => served.close());
  await served.loadJournalIndex();
  expect(loads).toBe(1);
  const plain = createHostedRelay({ ...auth, scheduler });
  closers.push(() => plain.close());
  await expect(plain.loadJournalIndex()).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run the tests and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/gateway.test.ts --testTimeout=10000`
Expected: FAIL (`loadJournalIndex` is not a function; journals without storage are accepted).

- [ ] **Step 3: Implement.** In `packages/agent-remote-hosted/src/gateway.ts`:

After the line `import type { JournalStore } from '@orchardworks/agent-remote-journal';` add

```ts
import { createHostJournals, type HostJournals } from './host-journals.js';
```

In `HostedRelayOptions`, after the `journals?: JournalStore;` option add

```ts
  /** A journal service built elsewhere, such as one that reaches journal partitions; used instead of `journals`. */
  journalService?: HostJournals;
```

After `  const durable = options.storage !== undefined;` add

```ts
  if ((options.journals || options.journalService) && !durable) throw new Error('Session journals need durable Relay state: without it a deletion could be lost.');
  const journalService = options.journalService ?? (options.journals ? createHostJournals({ store: options.journals, now: Date.now }) : undefined);
```

In the `createHostBroker({ ... })` call replace `        journals: options.journals,` with

```ts
        ...(journalService ? { journalService } : {}),
```

In the returned object, after `    refresh,` add

```ts
    /** Loads the head index of every Host the journal store holds; the Node hosts call it once before they listen. */
    async loadJournalIndex() { await journalService?.loadAllServed(); },
```

- [ ] **Step 4: Run the tests and see them pass, then the package.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/gateway.test.ts src/broker-journals.test.ts --testTimeout=10000` then `pnpm --filter @orchardworks/agent-remote-hosted run typecheck` then `pnpm --filter @orchardworks/agent-remote-hosted run build`
Expected: PASS for all three.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-hosted/src/gateway.ts packages/agent-remote-hosted/src/gateway.test.ts
git commit -m "feat(hosted): one journal service for every account of a Relay, on durable state" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Enable journals on the Node hosts

**Files:**
- Modify: `packages/agent-remote-lab/src/server/gateway-relay.ts`
- Modify: `packages/agent-remote-lab/src/server/gateway.ts`
- Modify: `packages/agent-remote-lab/src/server/devbox.ts`
- Modify: `packages/agent-remote-lab/src/server/devbox.test.ts`
- Modify: `scripts/local/runner.mjs`

The hosts that run the hosted Relay on Node are `createGatewayRelay` (the self-hosted Node/Docker server in `gateway.ts`) and, through it, `createDevboxServer` (`pnpm local` and the Devbox). The Lab already depends on the store package (Task 5). Journals stay off unless configured.

- [ ] **Step 1: Write the failing test.** In `packages/agent-remote-lab/src/server/devbox.test.ts`:

Add to the imports

```ts
import { existsSync } from 'node:fs';
import { SqlJournalStore } from '@orchardworks/agent-remote-journal-sqlite';
import { openNodeJournalDatabase } from '@orchardworks/agent-remote-journal-sqlite/node';
```

Change `fixture` to accept options for the server: its signature becomes `async function fixture(hostname = '127.0.0.1', extra: Partial<Parameters<typeof createDevboxServer>[0]> = {}) {` and its line `const options = { origin, stateDir: join(directory, 'state'), webDist };` becomes

```ts
  const options = { origin, stateDir: join(directory, 'state'), webDist, ...extra };
```

Append a test. The registration handshake is the one of `bootstraps an ordinary Host invitation...` (rotation requested, the credential issued and saved, then `registered`):

```ts
/** Connects a Controller that asks for journals and completes the credential handshake; returns what the Relay sends, by type. */
async function journalController(origin: string, remoteKey: string) {
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws/remote-host?journal=1', { headers: { authorization: `Bearer ${remoteKey}` }, handshakeTimeout: 3000 });
  cleanups.push(async () => { socket.terminate(); });
  await once(socket, 'open');
  const inbox: Array<Record<string, any>> = [];
  socket.on('message', data => { inbox.push(JSON.parse(data.toString())); });
  const take = async (type: string) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const at = inbox.findIndex(message => message.type === type);
      if (at >= 0) return inbox.splice(at, 1)[0]!;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`The Relay sent no ${type}.`);
  };
  const send = (fields: Record<string, unknown>) => socket.send(JSON.stringify({ uplinkVersion: 2, ...fields }));
  send({ type: 'register', installationId: 'journal-host', name: 'Journal Host', credentialRotation: true, providers: [{ providerId: 'codex', displayName: 'Codex' }] });
  expect(await take('credential_issued')).toMatchObject({ credential: expect.any(String) });
  send({ type: 'credential_saved' });
  return { socket, send, take, registered: await take('registered') };
}

it('stores Host journals in SQLite beside the state when journals are on, and grants them only then', async () => {
  const off = await fixture();
  expect(existsSync(join(off.options.stateDir, 'relay', 'journals.sqlite'))).toBe(false);
  const offController = await journalController(off.origin, (await off.server.getConnection()).remoteKey);
  expect(offController.registered).toMatchObject({ type: 'registered' });
  expect(offController.registered).not.toHaveProperty('journal');

  const f = await fixture('127.0.0.1', { journals: true });
  expect(existsSync(join(f.options.stateDir, 'relay', 'journals.sqlite'))).toBe(true);
  const controller = await journalController(f.origin, (await f.server.getConnection()).remoteKey);
  expect(controller.registered).toMatchObject({ type: 'registered', journal: 1 });
  controller.send({ type: 'journal_open', requestId: 'open-1', sessionKey: 'codex:thread-1', publisherId: 'controller-1' });
  expect(await controller.take('journal_opened')).toMatchObject({ generation: 1, watermark: 0, index: [] });
  controller.send({ type: 'journal_publish', sessionKey: 'codex:thread-1', generation: 1, entries: [
    { sequence: 1, op: 'append', row: { itemKey: 'm1', providerId: 'codex', sourceKey: 'm1:1', occurredAt: 1_725_000_000_000, turnId: 'turn-1', item: { type: 'assistant_message', text: 'Hello', messageId: 'm1' } } },
  ] });
  expect(await controller.take('journal_ack')).toMatchObject({ generation: 1, watermark: 1 });
  controller.socket.terminate();
  await f.server.close();
  const database = await openNodeJournalDatabase(join(f.options.stateDir, 'relay', 'journals.sqlite'));
  try {
    const stored = await new SqlJournalStore(database).load(`${controller.registered.hostId}:codex:thread-1`);
    expect(stored?.items.map(({ itemKey }) => itemKey)).toEqual(['m1']);
  } finally { database.close(); }
}, 30000);

it('refuses journals without a state file', () => {
  expect(() => createGatewayRelay({ origin: 'http://127.0.0.1:0', issuer: 'http://127.0.0.1:0', secret: 'journal-secret-01234567890123456789', journalFile: join(tmpdir(), 'arc-never.sqlite') })).toThrow(/state file/);
});
```

(The fixture closes the server again in its cleanup. That second `close` does nothing harmful: the runtime's `close` returns early once it is closing, the state lock and the journal database handle are released once and cleared, and the WebSocket server answers a second `close` through its `close` event.)

- [ ] **Step 2: Run the test and see it fail.**

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/server/devbox.test.ts -t "journals" --testTimeout=30000` (Bash `timeout` 300000)
Expected: FAIL (`journals` is not an option; no file is created).

- [ ] **Step 3: Implement.** In `packages/agent-remote-lab/src/server/gateway-relay.ts`:

Add imports after `import { join } from 'node:path';`:

```ts
import { SqlJournalStore } from '@orchardworks/agent-remote-journal-sqlite';
import { openNodeJournalDatabase, type NodeJournalDatabase } from '@orchardworks/agent-remote-journal-sqlite/node';
```

Add to `GatewayRelayOptions`, after `stateFile?: string;`:

```ts
  /** Where Host session journals are stored (a SQLite file); absent, no Controller is granted journals. Needs `stateFile`. */
  journalFile?: string;
```

At the start of `createGatewayRelay`, after `const auth = resolveHostedAuth(options);`, add

```ts
  if (options.journalFile && !options.stateFile) throw new Error('Session journals need a state file: journals are kept only beside durable Relay state.');
```

Add after the other `let` declarations (`let storage: ...`):

```ts
  let journalDatabase: NodeJournalDatabase | undefined;
```

In `listen`, before `runtime = createHostedRelay({ ...`, add

```ts
        if (options.journalFile) journalDatabase = await openNodeJournalDatabase(options.journalFile);
```

In its argument list add, after the `...(options.stateFile ? { diagnosticStorage: ... } : {}),` line:

```ts
          ...(journalDatabase ? { journals: new SqlJournalStore(journalDatabase) } : {}),
```

After the `createHostedRelay` call, still inside the `try`, add

```ts
        try { await runtime.loadJournalIndex(); }
        catch (error) { await runtime.close().catch(() => undefined); runtime = undefined; throw error; }
```

and replace the `catch` with

```ts
      } catch (error) { storage?.close(); journalDatabase?.close(); journalDatabase = undefined; server.close(); throw error; }
```

In `close()`, replace `storage?.close(); server.closeAllConnections();` with

```ts
      storage?.close(); journalDatabase?.close(); journalDatabase = undefined; server.closeAllConnections();
```

In `packages/agent-remote-lab/src/server/devbox.ts`, add to `DevboxServerOptions`:

```ts
  /** Store Host session journals in SQLite beside the Relay state. Off unless set. */
  journals?: boolean;
```

and in the `createGatewayRelay({ ... })` call add after the `stateFile` property:

```ts
    ...(options.journals ? { journalFile: join(options.stateDir, 'relay', 'journals.sqlite') } : {}),
```

In `packages/agent-remote-lab/src/server/gateway.ts`, name the state directory once. Before `const server = createGatewayRelay({` add

```ts
const stateDirectory = process.env.AGENT_REMOTE_STATE_DIR ?? join(homedir(), '.agent-remote-control', 'gateway-relay');
```

then replace the `stateFile:` property with

```ts
  stateFile: join(stateDirectory, 'state.json'),
  ...(process.env.AGENT_REMOTE_JOURNALS === '1' ? { journalFile: join(stateDirectory, 'journals.sqlite') } : {}),
```

In `scripts/local/runner.mjs`, change the call `factory({ origin: record.origin, stateDir: files.relay, webDist: ... })` to

```js
    server = await factory({ origin: record.origin, stateDir: files.relay,
      webDist: environment.ARC_LOCAL_WEB_DIST ?? join(record.source, 'dist/relay/web'),
      ...(environment.ARC_LOCAL_JOURNALS === '1' ? { journals: true } : {}) });
```

- [ ] **Step 4: Build what the Lab imports, then run the tests.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted run build` then `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/server/devbox.test.ts --testTimeout=30000` (Bash `timeout` 300000)
Expected: PASS, including the existing Devbox tests.

- [ ] **Step 5: Run the runner tests and typecheck the Lab.**

Run: `node --test --test-timeout=60000 scripts/local/runner.test.mjs` (Bash `timeout` 300000) then `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-lab run typecheck`
Expected: PASS for both.

- [ ] **Step 6: Confirm the Relay bundle carries the store lazily and the Controller does not depend on it.**

Run: `pnpm build:relay` (Bash `timeout` 600000) then `grep -c "node:sqlite" dist/relay/gateway.mjs`
Expected: the build succeeds and the count is at least 1 (the lazy `import("node:sqlite")` stays external).

Run: `pnpm --filter @orchardworks/agent-remote-controller why @orchardworks/agent-remote-journal-sqlite`, then the same for `@orchardworks/agent-remote-hosted` and `@orchardworks/agent-remote-relay`.
Expected: no output for all three. Only the Lab (and, in P1-B3b, the Cloudflare package) depends on the store package.

- [ ] **Step 7: Commit.**

```bash
git add packages/agent-remote-lab/src/server scripts/local/runner.mjs
git commit -m "feat(lab): store Host journals in SQLite on the Node hosts when configured" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Document the configuration

**Files:**
- Modify: `docs/self-hosted-deployment.md`
- Modify: `docs/local-development.md`

- [ ] **Step 1: Self-hosted guide.** In `docs/self-hosted-deployment.md`, insert before the heading `## Persistence, backups and upgrades`:

```markdown
## Session journals (optional, off by default)

A Relay can keep a working copy of each session's conversation, so a session can be read without waiting for its
Controller. This is an opt-in feature in development: it does nothing until a Controller that publishes journals is
installed, and nothing reads from a journal until the owner turns it on for a Host and provider.

| Setting | Meaning |
| --- | --- |
| `AGENT_REMOTE_JOURNALS=1` | Node / Docker only. Stores journals in `journals.sqlite` in the state directory (`AGENT_REMOTE_STATE_DIR`). Needs Node 22.13 or later; the image uses Node 22. Node prints one `ExperimentalWarning` for its built-in SQLite. Unset or any other value: no journals. |
| `PUT /v1/remote/hosts/<host id>/smart-reading` with `{"providerId":"codex","enabled":true}` | The owner turns reading from journals on or off for one provider of one Host. The default is off. Turning it off closes that provider's journal-served streams so their pages reconnect and read through the Controller. `GET` on the same path lists the providers that are on. |

Journals are a working set, not an archive: the native session on the Host is the ground truth. The Relay keeps the
bodies of the latest 50 turns of a session, bounds each session, each Host and its memory, and a Controller can read
evicted turns again from the Host. Items nothing can rebuild (live-only items) are kept, up to a cap per session. A
session whose journal a limit refused is read through the Controller until its Controller publishes again. Revoking a
Host deletes its journals; the Relay records the deletion with the revoke and retries it until the store confirms. The
journal file is inside the state directory, so the backup rules below cover it; copy it only while the Relay is stopped.
```

- [ ] **Step 2: Local development guide.** In `docs/local-development.md`, add a row to the environment variable table, after the `ARC_LOCAL_WEB_DIST` row:

```markdown
| `ARC_LOCAL_JOURNALS` | Set to `1` before `up` to store Host session journals in `relay/journals.sqlite` of the instance. Off by default. The development Controller does not publish journals yet, so this only exercises the store, the switch and the Relay's startup. | unset |
```

- [ ] **Step 3: Check the documents.**

Run: `pnpm lint:docs`
Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add docs/self-hosted-deployment.md docs/local-development.md
git commit -m "docs: describe the journal store configuration and the smart reading switch" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Verify the workspace, update compatibility metadata and check the local instance

**Files:**
- Modify: `packages/agent-remote-lab/compatibility.json` (written by the script)

- [ ] **Step 1: Build every package and typecheck.**

Run: `pnpm -r run build` (Bash `timeout` 600000) then `pnpm typecheck` (Bash `timeout` 600000)
Expected: PASS for both.

- [ ] **Step 2: Run the suites of the packages this plan changed.** Each command has the Bash `timeout` shown.

Run: `pnpm --filter @orchardworks/agent-remote-protocol run test` (300000)
Run: `pnpm --filter @orchardworks/agent-remote-journal run test` (300000)
Run: `pnpm --filter @orchardworks/agent-remote-journal-sqlite run test` (300000)
Run: `pnpm --filter @orchardworks/agent-remote-hosted run test` (300000)
Run: `pnpm --filter @orchardworks/agent-remote-relay run test` (300000)
Expected: PASS for each.

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/server/devbox.test.ts src/server/hosted-runtime.test.ts src/server/remote-host-broker.test.ts src/server/session-channel-routing.test.ts src/server/relay-conformance.test.ts --testTimeout=30000` (600000)
Expected: PASS.

Run: `pnpm test:cloudflare` (600000)
Expected: PASS. It includes the codec test that carries the switch and the pending deletions through the SQL snapshot.

Run: `pnpm test:conformance` (600000)
Expected: PASS, unchanged: Hosts without journals take the same path as before.

Run: `pnpm --filter @orchardworks/agent-remote-controller exec vitest run --testTimeout=30000` (600000)
Expected: PASS.

- [ ] **Step 3: Update and check the compatibility digest.**

Run: `pnpm compatibility:update` then `pnpm compatibility:check`
Expected: `Compatibility updated: sha256:...` then `Compatibility verified: sha256:...`. The new package, the protocol change and the changed lockfile are part of the digest.

- [ ] **Step 4: Commit the manifest.**

```bash
git add packages/agent-remote-lab/compatibility.json
git commit -m "chore: update the compatibility manifest for the journal store" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 5: Verify on the local instance.** Follow `.agents/skills/prepare-arc-local/SKILL.md`. Read `references/lifecycle.md#before-restarting-a-running-instance` first; if this checkout's instance runs or waits on a session this task did not start, stop and ask the user before `up`.

Run from the worktree: `ARC_LOCAL_JOURNALS=1 pnpm local up` (Bash `timeout` 600000)
Expected: it builds, starts the instance, prints the status and exits 0.

Run: `pnpm --silent local status --json`
Expected: exit 0, state ready, running build commit equal to the checkout commit. Note the `State:` directory.

Check the layers and report each as the skill's report format asks:

1. **Site and Controller.** `agent-remote-controller-dev host providers` shows the expected providers `enabled`; `status` shows `uplink registered`. The development Controller does not request journals yet, so it registers exactly as before.
2. **Feature: the store.** `ls -l <State>/relay/journals.sqlite` exists, mode `-rw-------`. `pnpm local logs` shows no store error. This is the Node store opened by the real Relay process, including `loadJournalIndex` at startup.
3. **Feature: the switch.** `agent-remote-controller-dev api GET /v1/remote/hosts` gives the Host id. Then `agent-remote-controller-dev api PUT /v1/remote/hosts/<id>/smart-reading --body '{"providerId":"codex","enabled":true}'` answers `{"providers":["codex"]}` (if the command line `api` does not accept `PUT`, use `pnpm --silent local api v1/remote/hosts/<id>/smart-reading --method PUT --data '{"providerId":"codex","enabled":true}'`, which signs in once). Read it back with `GET`. Restart with `ARC_LOCAL_JOURNALS=1 pnpm local up --no-build` and read it again: it must survive. Turn it off again with `enabled:false` and read `{"providers":[]}`.
4. **Model turn: the crude path is unchanged with journals on.** Create a session in the instance workspace and read a real reply, as `references/test-loop.md` describes: `agent-remote-controller-dev session create --provider claude --message "Reply with the single word ready."`, then `session read <address> --limit 2`. With smart reading on for the provider and no journal head, the session must still answer through the Controller. Release any Codex session you created (`session release <address>`).
5. **Page.** Not exercised; nothing in this plan changes the page. Say so.

Run: `pnpm local down` when nobody needs the instance (it belongs to this worktree).

---

## Self-review

- **C1:** Decision 9 and Tasks 2, 4, 6: a replacement is admitted by its size plus carried live-only items without shrinking; a quota refusal clears the head (persisted, index agrees after restart), reports `unserved` and the broker closes the session's streams with 1012; the live-only cap removes the oldest and reports `journal_live_only_dropped`; the P1-C note says reopen and replace with a window that fits, else stop.
- **C2:** Decision 10 and Task 4: one publish-time rule (`evict` to the latest 50 turns inside the Host's queue); no use tracking, sweep, `startedAt`, `settled` or interval option; the 5-turn idle window is a P3 note.
- **C3:** Task 4 changes `open` together with the uplink and every test that calls it; Task 8's registration copies the credential handshake of `devbox.test.ts`; Task 6's fixture edits target the landed fixture (`savedState`, `RelayOptions`).
- **I1:** Decision 13 and Tasks 1 and 4: `indexAfter`, `journal_index_request`, `journal_index_page`, one page in flight, tested over the in-memory transport and through the real broker.
- **I2:** Decision 11 and Task 4: fills put back only what fits the session, the Host and the cache.
- **I3:** Decision 12 and Task 6: `journalDeletions` in the revoke commit, confirmed deletion removes it, retried at start and on every Host registration.
- **Re-review:** the first-page bound narrows in Task 4 with the test it breaks (item 1); every head change raises the Host's epoch and a stream without a head calls `unserve` (2); a fill makes room once by evicting bodies outside the latest turns (3); deletions run until none is untried and a restored Host's own deletion is waited for before `registered` (4); `journal_index_request` carries the epoch and a stale one is refused with `stale_epoch` (5).
- **I4:** Task 6: `stopReading` closes that Host and provider's journal-served streams with 1012.
- **I6:** Tasks 2 and 5: incremental `residentBytes`; the benchmark runs `status()` cold, `publish()` of realistic batches and a large load through `createHostJournals`; a failed threshold stops the plan and goes to the owner.
- **Minor items:** the journal message limit is 8 MiB (Task 4 `JOURNAL_INDEX_PAGE_MAX_BYTES` comment); the scheduler is the broker's (Task 6 `waitFor`); the PUT list change is inside `commit`; `deletePrefix` uses a key range and chunk rows are not `WITHOUT ROWID`; limits are whole numbers and `sessionItems` is clamped; the hedges are gone; the runtime closes when `loadJournalIndex` fails (Task 8); the head index loads once per Host, shared, outside the Host's queue (Task 4 `loadHost`, Task 6 `loadServed`); every `node --test` has `--test-timeout`.
- **YAGNI:** no `deleteSession`, `deleteJournals`, `journalTuning`, `journalRetentionIntervalMs`; `JournalHeadIndex` and the service constants are not exported.

## Open risks

- `node:sqlite` is synchronous: loading a very large journal stalls the Relay's event loop for the read and parse (the benchmark bounds it). A worker-thread database is the follow-up if P0 shows larger journals.
- The size estimate counts JSON characters; heap use is up to twice that. The defaults (128 MiB cache, 64 MiB session) assume a Node host; the Durable Object bounds in P1-B3b are lower.
- A Controller can open a journal for a session that has no binding; only the per-Host quota bounds it.
- Removing live-only items beyond the cap loses them for good; the cap (2,000) is a guess that P0 should confirm.
- The pending-deletion list is retried at start and on Host registration only; a Relay that never restarts and sees no Host register keeps the journals until one of those happens.

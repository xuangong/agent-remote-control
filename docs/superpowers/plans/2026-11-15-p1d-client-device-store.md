# P1-D Client device store Implementation Plan

> **Superseded** by [S4](2026-11-16-s4-client-absorbs-replacements.md) for the work it still covers (2026-11-16): it assumed a stable epoch and incremental corrections; see S4 section 1 for what survives.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A conversation this device opened before shows its content from an IndexedDB device store on mount, before any network, with no blank timeline and no opening label. After negotiation the client asks for what it missed after its stored cursor, on the same epoch, and a changed epoch is swapped in once the new tail arrives. The client never leaves a hole in its window, and unchanged rows keep their rendered DOM nodes across a reconnect, a Controller restart or a Relay restart of a journal-served session.

**Architecture:** The device store lives in the web package (`device-store.ts`), next to the drafts and images it shares one IndexedDB database with (schema version 3). It keeps a memory copy of the records a page needs, writes behind, bounds itself with soft LRU limits that never evict a pinned (mounted) session, and absorbs quota errors by evicting. The replica reducer gains two rules (updates older than the window fold in without moving its older boundary; unchanged entries keep their object identity) and the replica can be restored from a stored record. The lab replaces its six-session localStorage preview with the device store behind the same synchronous functions (`readWorkspaceSnapshot`, `saveWorkspaceSnapshot`), seeds each new conversation replica from it, preloads it before the application chunk renders, and clears it with the other conversation caches. Real-transport tests run a journal-served Relay (the hosted broker over real HTTP and WebSocket) with a fake Controller. Latency measurement, the Relay's attach shortcut and the final local verification are in the second plan, `2026-11-15-p1d2-client-measurement.md`.

**Tech Stack:** TypeScript 5.7 (ES2022, strict, `noUncheckedIndexedAccess`), React 18, IndexedDB with `fake-indexeddb` 6 in tests, `ws`, Vitest 4.1.11, pnpm workspace.

**Design reference:** `docs/superpowers/specs/2026-11-15-im-session-service-design.md`, sections Experience targets (T1, T2, T6), Client (Device store, Sync channel, Presentation, Removed in smart mode, Crude mode), Answering the client protocol in smart mode, Failure handling, Measurement and testing. Baselines: `docs/superpowers/plans/2026-11-15-p0-baselines.md`. Roadmap notes: "no holes in a client's window" and "measure under latency, against the same runner". Predecessor: `2026-11-15-p1b2-journal-served-sessions.md` (landed): a journal-served stream has a stable epoch and stable sequences across Controller and Relay restarts and speaks today's client protocol.

**Commands.** Every test command sets a per-test deadline (`--testTimeout`). Run each with an outer deadline: the Bash tool `timeout` named in the step (at most 600000 ms). Web tests run against source. Lab tests import `@orchardworks/agent-remote-web` and `@orchardworks/agent-remote-hosted` from `dist`, so rebuild a package before running tests of its dependents; each task says when. Lab tests run on Node 22 like CI (Node 26 breaks jsdom): prefix them with `PATH=/opt/homebrew/opt/node@22/bin:$PATH`. All work happens in the worktree `/Users/xian/projects/agent-remote-control/.worktrees/im-session-service`. Each task leaves the repository green: no task changes a signature without changing its callers and their tests in the same task. **Task 11 depends on P1-B3a Task 6** (the persisted `smartReading` field of the Host record and the gate); the retention of the latest 50 turns that its stale-cursor test uses landed with B3a Task 4. The other tasks need only the landed P1-B2.

## Decisions made in this plan

These are decisions the owner did not make; each can be reversed by editing the task named.

1. **One database, schema version 3.** The owner asked for an upgrade from the current database version that preserves drafts and images. The device store therefore lives in the existing database `agent-remote-image-drafts`, which moves from version 2 to 3 and gains two object stores, `sessions` (record bodies) and `session_index` (key, scope, identity, time and size of every record, so limits are enforced without reading bodies). The upgrade only creates missing stores; it never opens a cursor on `drafts` or `images`. Cost: every place that opened the database at an explicit version 2 (11 sites, tests and Playwright specs) now opens it without a version. Task 1. A rollback build must keep a version-3 opener, as the performance README already says for version 2.
2. **The record is a window, not a conversation.** Per public session it holds the agent id, epoch, next sequence (the cursor is `nextSeq - 1`), `hasOlder`, the latest entries (at most 200 entries and 1 MiB of JSON), the last Snapshot with `activeTurn`, `pendingInteractions` and `runtimeInfo.connection` removed (what was true before is not claimed as live), and the time of the last update. A window trimmed on the older side stores `hasOlder: true`. A window whose newest entry alone exceeds the byte limit is not stored. The key is `JSON.stringify([scope, identity])` where scope is the account's Relay URL and identity is `[hostId, providerId, nativeSessionId]`. Task 2.
3. **Limits.** 40 sessions and 32 MiB on disk, 16 MiB resident in memory, preload of the 16 most recent sessions within 4 MiB. All soft: a pinned session is never evicted (Task 3). The old preview kept 6 sessions and 150 entries.
4. **Write-behind.** `save` updates memory at once and queues the disk write for 50 ms; one transaction writes a batch. In the lab the observer that calls `save` already debounces by 2 s and flushes on `pagehide` and when the page hides, so a frame never waits on disk. A write that finds a newer record of the same epoch on disk (another tab) leaves it alone.
5. **Quota.** A quota error aborts the batch, evicts the oldest half of the unpinned records and retries once; a second failure keeps the content in memory and retries with the next save. Nothing reaches the UI.
6. **Preload at start.** `main.tsx` starts the preload when the entry chunk runs and the application chunk waits for it (at most one second), so the first render of the application already reads the store synchronously. The store has its own subpath, `@orchardworks/agent-remote-web/device-store`, because it imports the protocol codec; the sign-in entry (`GatewayController.tsx`, `conversation-recovery.tsx`, `conversation-storage.tsx`) never imports it statically (sign-out and Clear cache on close reach it through a registry or a dynamic import), so the entry chunk (budget 70,000 bytes gzip, 63,666 before this plan) does not grow, and Task 9 builds the lab with the budget. A conversation outside the preloaded sixteen loads from disk after its replica is created and is shown as soon as the load completes.
7. **Row keys keep their format.** A row key is `${epoch}:${providerId}:${seqStart}:${identity}`, where the identity is a native item field (`callId`, `requestId`, letter ids, `messageId`). Tests, Trace, search jumps and source references use it, so it stays. On a journal-served session the epoch and the sequences are stable across reconnects, Controller restarts and Relay restarts, so an unchanged row already has an unchanged key. What this plan adds is what keeps it so: an update to an item older than the window is folded in at the held entry's own `seqStart` (Task 4), and a catch-up never replaces an unchanged entry by a clone. The remaining way to re-key a row is an adapter that changes an item's native id in a correction (a `messageId` that appears later); the continuity fixtures of P1-C must keep those ids constant, and this is recorded as a risk at the end.
8. **Unchanged entries keep their object identity.** When a page is applied, an entry equal to the one already held at the same `seqStart` is not replaced by a clone. Memoized rows then do no work for a catch-up that changed nothing. Task 4.
9. **Where the one-step replacement lives.** The replica clears its timeline on a replacement, as it always did, and the lab's `SessionConversation` already keeps showing the last initialized display until the new tail is applied (`retainedDisplay`). This plan keeps that division, seeds the retained display from the device store, and proves with a real-transport test that no frame is without rows. Other embedders of `AgentTimeline` are not changed.
10. **Label rule, narrowly.** While the displayed rows came from the device store and the connection has not yet reached `ready` for the first time (`timeline.restoredFromDevice`, cleared when the client becomes ready), and the connection is `connecting` or `catching_up`, the labels `Opening session`, `Synchronizing` and `Checking access` (heading and composer status) give way to the session's last known business label. A `disconnected` connection is never hidden: a socket that closes before the first page says `Reconnecting`. These are the only label and composer touches of this plan (`SessionWorkbench`, `AgentActivityStatus`, and the draft-only status of `AgentComposer`); the rest is P2. The T1 count covers `Opening session`, `Loading conversation`, `Awaiting Agent` and `Start with a Provider`. T6 in this plan counts rows and row-less frames only; labels across restarts are counted in P2 (T5).
11. **Pinning.** Every conversation connection pins its record while it exists (`observeWorkspaceDisplay`), so mounted and retained sessions are never evicted. Sign-out (`clearConversationRecovery(scope)`) and "Clear cache on close" clear the store like the other conversation caches; with the preference on, the store keeps memory copies only.
13. **Records rewrite the whole window.** The design says the device store is written incrementally, only changed entries. This plan writes a session's whole window (at most 200 entries and 1 MiB) in one put, at most once per two seconds and on page hide, because a record is one IndexedDB value and the window is small. The byte limits count JSON length in UTF-16 code units; a value takes up to twice that in memory and its on-disk size differs again.
12. **Older history reads follow the transport's recovery mode.** `loadOlder`, the timeline search and the recovery loop called `transport.fetchTimeline`, an HTTP request that the Relay forwards to the Controller, whatever the recovery mode; P1-B2 left those HTTP routes on the Controller. A journal-served session would then need its Controller and its Host online to scroll back, which the design rules out. They now read through `readTimeline`: the session wire for a transport that recovers over it (every session-channel transport), HTTP otherwise. The echo sync (`watchMessageEchoes`) still uses HTTP; it only runs while a message of this device waits for its echo, which P2 moves to the operation queue. Task 6.

## File structure

| File | Responsibility |
|---|---|
| `packages/agent-remote-web/src/browser-database.ts` (+ test) | New: database name, version 3, store names, the one upgrade function and the open request. |
| `packages/agent-remote-web/src/image-drafts.ts` | Modify: open through `requestBrowserDatabase`. |
| `packages/agent-remote-web/src/image-drafts.test.ts` | Modify: three opens without an explicit version. |
| `packages/agent-remote-web/src/session-record.ts` (+ test) | New: the stored record, window trimming, display snapshot, validation. |
| `packages/agent-remote-web/src/device-store.ts` (+ test) | New: `DeviceStore`, the singleton, persistence configuration, preload. |
| `packages/agent-remote-web/package.json` | Modify: the store's own subpath `@orchardworks/agent-remote-web/device-store`. |
| `packages/agent-remote-web/src/replica/types.ts`, `reducer.ts`, `store.ts` | Modify: `restoredFromDevice`, fold older updates, keep unchanged entries, `restoreFromDevice`. |
| `packages/agent-remote-web/src/replica/reducer.window.test.ts`, `store.restore.test.ts` | New: tests of the above. |
| `packages/agent-remote-web/src/client/session-state.ts`, `react/AgentActivityStatus.tsx` | Modify: `restoring` and the label rule. |
| `packages/agent-remote-hosted/src/broker.ts`, `broker-timeline-admission.test.ts` | Modify and new: timeline reads have their own admission budget. |
| `packages/agent-remote-web/src/client/remote-session-client.ts` (+ test) | Modify: every page is read through one method that follows the transport's recovery mode; catch-up tests with a fake transport. |
| `packages/agent-remote-lab/src/App.succession.test.tsx` | Modify: one test moves from the HTTP route to the session wire for older history. |
| `packages/agent-remote-lab/src/workspace-cache.ts` (+ test) | Rewrite over the device store, same synchronous API plus `restoreWorkspaceReplica` and `pinWorkspaceSession`. |
| `packages/agent-remote-lab/src/workspace-display-cache.ts` (+ test) | Modify: pin, skip unconfirmed content. |
| `packages/agent-remote-lab/src/conversation-connections.ts` | Modify: seed new replicas. |
| `packages/agent-remote-lab/src/conversation-storage.ts`, `conversation-recovery.tsx`, `main.tsx` | Modify: clear and preload policies. |
| `packages/agent-remote-lab/src/components/SessionWorkbench.tsx` | Modify: label rule. |
| `packages/agent-remote-lab/src/components/LabWorkbench.restored.test.tsx`, `SessionConversation.device-store.test.tsx` | New: label and counted-state tests. |
| `packages/agent-remote-lab/src/components/SessionConversation.tsx` | Modify: the preview follows the disk; lost access forgets the stored session. |
| `packages/agent-remote-lab/src/test/journal-relay.ts`, `components/SessionConversation.journal.test.tsx` | New: journal-served Relay fixture and the real-transport tests. |
| `packages/agent-remote-lab/package.json` | Modify: dev dependency on `@orchardworks/agent-remote-journal`. |
| `packages/agent-remote-lab/src/test/image-draft-storage.ts`, `e2e/*.spec.ts` (3 files) | Modify: open the database without a version. |
| `packages/agent-remote-lab/performance/README.md`, `docs/current/agent-remote/web.md` | Modify: schema and behaviour. |
| `packages/agent-remote-lab/compatibility.json` | Generated. |

Wire contracts do not change in this plan: no protocol fixture, schema or replay entry changes.

---

### Task 1: One database at version 3

**Files:**
- Create: `packages/agent-remote-web/src/browser-database.ts`
- Create: `packages/agent-remote-web/src/browser-database.test.ts`
- Modify: `packages/agent-remote-web/src/image-drafts.ts`
- Modify: `packages/agent-remote-web/src/image-drafts.test.ts`
- Modify: `packages/agent-remote-lab/src/test/image-draft-storage.ts`
- Modify: `packages/agent-remote-lab/e2e/session-succession-joined.spec.ts`, `seamless-access.spec.ts`, `session-succession.spec.ts`
- Modify: `packages/agent-remote-lab/performance/README.md`

- [ ] **Step 1: Write the failing test.**

Create `packages/agent-remote-web/src/browser-database.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, it } from 'vitest';
import { BROWSER_DATABASE, BROWSER_DATABASE_VERSION, requestBrowserDatabase } from './browser-database.js';

/** An older database as a previous release left it: `build` runs inside the version change. */
function legacy(factory: IDBFactory, version: number, build: (database: IDBDatabase, transaction: IDBTransaction) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.open(BROWSER_DATABASE, version);
    request.onupgradeneeded = () => build(request.result, request.transaction!);
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });
}
function upgraded(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = requestBrowserDatabase(factory);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function read<T>(database: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(store, 'readonly');
    const request = transaction.objectStore(store).get(key);
    transaction.oncomplete = () => resolve(request.result as T | undefined);
    transaction.onabort = () => reject(transaction.error);
  });
}

it('creates every store in a fresh database', async () => {
  const database = await upgraded(new IDBFactory());
  try {
    expect(database.version).toBe(BROWSER_DATABASE_VERSION);
    expect([...database.objectStoreNames].sort()).toEqual(['drafts', 'images', 'session_index', 'sessions']);
  } finally { database.close(); }
});

it('upgrades a version-one database without touching its drafts', async () => {
  const factory = new IDBFactory();
  await legacy(factory, 1, (database, transaction) => {
    database.createObjectStore('drafts', { keyPath: 'key' });
    transaction.objectStore('drafts').put({ key: 'composer', version: 1, scope: 'account', images: { one: { blobBytes: new Uint8Array([1, 2, 3]).buffer } } });
  });
  const database = await upgraded(factory);
  try {
    expect(database.version).toBe(3);
    const draft = await read<{ images: { one: { blobBytes: ArrayBuffer } } }>(database, 'drafts', 'composer');
    expect([...new Uint8Array(draft!.images.one.blobBytes)]).toEqual([1, 2, 3]);
    expect([...database.objectStoreNames].sort()).toEqual(['drafts', 'images', 'session_index', 'sessions']);
  } finally { database.close(); }
});

it('upgrades a version-two database without touching its drafts, image bytes or image index', async () => {
  const factory = new IDBFactory();
  await legacy(factory, 2, (database, transaction) => {
    database.createObjectStore('drafts', { keyPath: 'key' });
    database.createObjectStore('images', { keyPath: 'key' }).createIndex('imageId', 'imageId');
    transaction.objectStore('drafts').put({ key: 'composer', version: 1, scope: 'account', images: { one: { blobKey: '["composer","one"]' } } });
    transaction.objectStore('images').put({ key: '["composer","one"]', scope: 'account', imageId: 'one', blobBytes: new Uint8Array([9, 8]).buffer });
  });
  const database = await upgraded(factory);
  try {
    expect(await read(database, 'drafts', 'composer')).toMatchObject({ key: 'composer', images: { one: { blobKey: '["composer","one"]' } } });
    const bytes = await read<{ blobBytes: ArrayBuffer }>(database, 'images', '["composer","one"]');
    expect([...new Uint8Array(bytes!.blobBytes)]).toEqual([9, 8]);
    const indexed = await new Promise<unknown[]>((resolve, reject) => {
      const transaction = database.transaction('images', 'readonly');
      const request = transaction.objectStore('images').index('imageId').getAll('one');
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
    });
    expect(indexed).toHaveLength(1);
  } finally { database.close(); }
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `pnpm --filter @orchardworks/agent-remote-web exec vitest run src/browser-database.test.ts --testTimeout=10000` (Bash timeout 120000)
Expected: FAIL, `Failed to resolve import "./browser-database.js"`.

- [ ] **Step 3: Write the module.**

Create `packages/agent-remote-web/src/browser-database.ts`:

```ts
/** The one IndexedDB database of this browser origin: composer drafts and images, and the device store of conversations. */
export const BROWSER_DATABASE = 'agent-remote-image-drafts';
/** 1: drafts. 2: image bytes in their own store. 3: the device store (`sessions` and `session_index`). */
export const BROWSER_DATABASE_VERSION = 3;
export const DRAFTS_STORE = 'drafts';
export const IMAGES_STORE = 'images';
export const SESSIONS_STORE = 'sessions';
export const SESSION_INDEX_STORE = 'session_index';

/** Creates what an older database lacks and never opens what it holds, so drafts and images survive every upgrade. */
export function upgradeBrowserDatabase(database: IDBDatabase): void {
  const names = database.objectStoreNames;
  if (!names.contains(DRAFTS_STORE)) database.createObjectStore(DRAFTS_STORE, { keyPath: 'key' });
  if (!names.contains(IMAGES_STORE)) database.createObjectStore(IMAGES_STORE, { keyPath: 'key' }).createIndex('imageId', 'imageId');
  if (!names.contains(SESSIONS_STORE)) database.createObjectStore(SESSIONS_STORE, { keyPath: 'key' });
  if (!names.contains(SESSION_INDEX_STORE)) database.createObjectStore(SESSION_INDEX_STORE, { keyPath: 'key' });
}

/** An open request that upgrades the database to the current version; each caller attaches its own result handlers. */
export function requestBrowserDatabase(factory: IDBFactory = indexedDB): IDBOpenDBRequest {
  const request = factory.open(BROWSER_DATABASE, BROWSER_DATABASE_VERSION);
  request.onupgradeneeded = () => upgradeBrowserDatabase(request.result);
  return request;
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `pnpm --filter @orchardworks/agent-remote-web exec vitest run src/browser-database.test.ts --testTimeout=10000` (Bash timeout 120000)
Expected: PASS, 3 tests.

- [ ] **Step 5: Open the drafts database through it.**

In `packages/agent-remote-web/src/image-drafts.ts`, add after the first import line (`import { clearResourceDraftScope } from './resource-drafts.js';`):

```ts
import { requestBrowserDatabase } from './browser-database.js';
```

Delete the line `const DATABASE = 'agent-remote-image-drafts';` and replace this block inside `openDatabase`:

```ts
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('drafts')) request.result.createObjectStore('drafts', { keyPath: 'key' });
      if (!request.result.objectStoreNames.contains('images')) request.result.createObjectStore('images', { keyPath: 'key' }).createIndex('imageId', 'imageId');
    };
```

with:

```ts
    const request = requestBrowserDatabase();
```

- [ ] **Step 6: Open the database without a version wherever a test or spec reads it.**

Run:

```bash
cd /Users/xian/projects/agent-remote-control/.worktrees/im-session-service
sed -i '' "s/open('agent-remote-image-drafts', 2)/open('agent-remote-image-drafts')/g" \
  packages/agent-remote-web/src/image-drafts.test.ts \
  packages/agent-remote-lab/src/test/image-draft-storage.ts \
  packages/agent-remote-lab/e2e/session-succession-joined.spec.ts \
  packages/agent-remote-lab/e2e/seamless-access.spec.ts \
  packages/agent-remote-lab/e2e/session-succession.spec.ts
grep -rn "agent-remote-image-drafts'" packages --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v "/dist/"
```

Expected: the only line that still names a version is the fixture that deliberately creates a version-one database in `image-drafts.test.ts` (`isolated.open('agent-remote-image-drafts', 1)`); every other line is `open('agent-remote-image-drafts')`, plus the constant in `browser-database.ts` (which does not match this pattern).

- [ ] **Step 7: Record the schema in the performance README.**

In `packages/agent-remote-lab/performance/README.md`, replace

```
Do not delete drafts or downgrade the database. The migration test covers old embedded drafts and both readable representations; packaging a rollback build remains a release task.
```

with

```
Do not delete drafts or downgrade the database. The migration test covers old embedded drafts and both readable representations; packaging a rollback build remains a release task.

Version 3 adds the device store's `sessions` and `session_index` stores to the same database. The upgrade only creates missing stores (`browser-database.ts`); `browser-database.test.ts` upgrades version-one and version-two databases and checks that drafts, image bytes and the image index are unchanged. A rollback build must keep a version-3 opener for the same reason it must keep a version-2 one.
```

- [ ] **Step 8: Run the web draft and database suites, then typecheck.**

Run: `pnpm --filter @orchardworks/agent-remote-web exec vitest run src/browser-database.test.ts src/image-drafts.test.ts src/resource-drafts.test.ts --testTimeout=10000` (Bash timeout 180000)
Expected: PASS (the version-one upgrade test now ends at version 3).

Run: `pnpm --filter @orchardworks/agent-remote-web run typecheck` (Bash timeout 180000)
Expected: exit code 0.

- [ ] **Step 9: Commit.**

```bash
git add packages/agent-remote-web/src/browser-database.ts packages/agent-remote-web/src/browser-database.test.ts packages/agent-remote-web/src/image-drafts.ts packages/agent-remote-web/src/image-drafts.test.ts packages/agent-remote-lab/src/test/image-draft-storage.ts packages/agent-remote-lab/e2e/session-succession-joined.spec.ts packages/agent-remote-lab/e2e/seamless-access.spec.ts packages/agent-remote-lab/e2e/session-succession.spec.ts packages/agent-remote-lab/performance/README.md
git commit -m "feat(web): move the browser database to version 3 for the device store" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: The stored session record

**Files:**
- Create: `packages/agent-remote-web/src/session-record.ts`
- Create: `packages/agent-remote-web/src/session-record.test.ts`

- [ ] **Step 1: Write the failing test.**

Create `packages/agent-remote-web/src/session-record.test.ts`:

```ts
import { expect, it } from 'vitest';
import type { AgentSnapshotPayload, ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { createStoredRecord, decodeStoredRecord, displaySnapshot, storedKey, windowForStorage } from './session-record.js';

const snapshot = (): AgentSnapshotPayload => ({
  id: 'agent-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'running',
  activeTurn: { turnId: 'turn-1', startedAt: '2026-11-15T00:00:00.500Z' },
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [],
  runtimeInfo: { providerId: 'codex', sessionId: 'native-1', status: 'running', connection: { state: 'restoring' } },
});
const entry = (seq: number, text = `row ${seq}`): ProjectedTimelineEntry => ({
  providerId: 'codex', item: { type: 'assistant_message', text, messageId: `m${seq}` }, timestamp: '2026-11-15T00:00:00.000Z',
  seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [], resources: [],
});
const limits = { maxEntries: 3, maxBytes: 100_000 };

it('keeps the newest entries within the entry limit and says it trimmed', () => {
  const window = windowForStorage([1, 2, 3, 4, 5].map(seq => entry(seq)), limits)!;
  expect(window.entries.map(item => item.seqStart)).toEqual([3, 4, 5]);
  expect(window.trimmed).toBe(true);
});

it('keeps the newest entries within the byte limit', () => {
  const size = JSON.stringify(entry(1)).length;
  const window = windowForStorage([1, 2, 3].map(seq => entry(seq)), { maxEntries: 10, maxBytes: size * 2 + 1 })!;
  expect(window.entries.map(item => item.seqStart)).toEqual([2, 3]);
  expect(window.bytes).toBeLessThanOrEqual(size * 2 + 1);
});

it('stores nothing when the newest entry alone is over the byte limit, and an empty conversation as empty', () => {
  expect(windowForStorage([entry(1, 'x'.repeat(500))], { maxEntries: 10, maxBytes: 100 })).toBeUndefined();
  expect(windowForStorage([], limits)).toEqual({ entries: [], trimmed: false, bytes: 0 });
});

it('does not claim what was live: no active turn, interactions or runtime connection', () => {
  const display = displaySnapshot({ ...snapshot(), pendingInteractions: [{ requestId: 'ask', kind: 'question', questions: [] } as never] });
  expect(display.activeTurn).toBeNull();
  expect(display.pendingInteractions).toEqual([]);
  expect(display.runtimeInfo.connection).toBeUndefined();
  expect(display.status).toBe('running');
});

it('builds a record keyed by account and identity, with hasOlder set when the window was trimmed', () => {
  const record = createStoredRecord('https://relay/u/a/', '["h","codex","native-1"]', { agentId: 'agent-1', epoch: 'e1', nextSeq: 6, hasOlder: false,
    entries: [1, 2, 3, 4, 5].map(seq => entry(seq)), snapshot: snapshot() }, limits, 1234)!;
  expect(record.key).toBe(storedKey('https://relay/u/a/', '["h","codex","native-1"]'));
  expect(record).toMatchObject({ version: 1, epoch: 'e1', nextSeq: 6, hasOlder: true, updatedAt: 1234 });
  expect(record.entries).toHaveLength(3);
  expect(record.bytes).toBeGreaterThan(0);
});

it('decodes what it encoded and refuses damaged records', () => {
  const record = createStoredRecord('s', 'i', { agentId: 'agent-1', epoch: 'e1', nextSeq: 3, hasOlder: false, entries: [entry(1), entry(2)], snapshot: snapshot() }, limits, 9)!;
  const decoded = decodeStoredRecord(structuredClone(record))!;
  expect(decoded.entries).toEqual(record.entries);
  expect(decoded.snapshot.id).toBe('agent-1');
  expect(decoded.updatedAt).toBe(9);
  expect(decodeStoredRecord({ ...record, version: 2 })).toBeUndefined();
  expect(decodeStoredRecord({ ...record, nextSeq: 0 })).toBeUndefined();
  expect(decodeStoredRecord({ ...record, entries: [{ ...entry(1), item: { type: 'bogus' } }] })).toBeUndefined();
  expect(decodeStoredRecord({ ...record, snapshot: null })).toBeUndefined();
  expect(decodeStoredRecord('not a record')).toBeUndefined();
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `pnpm --filter @orchardworks/agent-remote-web exec vitest run src/session-record.test.ts --testTimeout=10000` (Bash timeout 120000)
Expected: FAIL, `Failed to resolve import "./session-record.js"`.

- [ ] **Step 3: Write the module.**

Create `packages/agent-remote-web/src/session-record.ts`:

```ts
import { decodeAgentSnapshot, decodeHistoryPage, PROTOCOL_VERSION, type AgentSnapshotPayload, type ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';

export const STORED_SESSION_VERSION = 1;

/** How much of one conversation a device keeps. */
export interface StoredWindowLimits { readonly maxEntries: number; readonly maxBytes: number }
export const DEFAULT_WINDOW_LIMITS: StoredWindowLimits = { maxEntries: 200, maxBytes: 1_048_576 };

/** What a page hands over to be kept. */
export interface SessionToStore {
  readonly agentId: string;
  readonly epoch: string;
  /** The next sequence the page expects; the cursor of what it holds is `nextSeq - 1`. */
  readonly nextSeq: number;
  readonly hasOlder: boolean;
  readonly entries: readonly ProjectedTimelineEntry[];
  readonly snapshot: AgentSnapshotPayload;
}
export interface StoredSession extends SessionToStore { readonly updatedAt: number }
export interface StoredRecord extends StoredSession {
  readonly key: string;
  readonly scope: string;
  readonly identity: string;
  readonly version: typeof STORED_SESSION_VERSION;
  readonly bytes: number;
}

export const storedKey = (scope: string, identity: string): string => JSON.stringify([scope, identity]);

/** The newest entries that fit the limits, oldest first; undefined when entries exist and not even the newest one fits. */
export function windowForStorage(entries: readonly ProjectedTimelineEntry[], limits: StoredWindowLimits): { entries: ProjectedTimelineEntry[]; trimmed: boolean; bytes: number } | undefined {
  const kept: ProjectedTimelineEntry[] = [];
  let bytes = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    const size = JSON.stringify(entry).length;
    if (kept.length >= limits.maxEntries || bytes + size > limits.maxBytes) break;
    kept.push(entry);
    bytes += size;
  }
  if (entries.length > 0 && kept.length === 0) return undefined;
  kept.reverse();
  return { entries: kept, trimmed: kept.length < entries.length, bytes };
}

/** The Snapshot as a device may show it before the Relay answers: what was running or pending then is not claimed now. */
export function displaySnapshot(snapshot: AgentSnapshotPayload): AgentSnapshotPayload {
  const { connection: _connection, ...runtimeInfo } = snapshot.runtimeInfo;
  return { ...snapshot, activeTurn: null, pendingInteractions: [], runtimeInfo };
}

export function createStoredRecord(scope: string, identity: string, session: SessionToStore, limits: StoredWindowLimits, now: number): StoredRecord | undefined {
  const window = windowForStorage(session.entries, limits);
  if (!window) return undefined;
  const snapshot = displaySnapshot(session.snapshot);
  return {
    key: storedKey(scope, identity), scope, identity, version: STORED_SESSION_VERSION, agentId: session.agentId, epoch: session.epoch,
    nextSeq: session.nextSeq, hasOlder: session.hasOlder || window.trimmed, entries: window.entries, snapshot, updatedAt: now,
    bytes: window.bytes + JSON.stringify(snapshot).length + 256,
  };
}

/** The record's content when it has the current version and passes the protocol's own validation; undefined otherwise. */
export function decodeStoredRecord(value: unknown): StoredSession | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Partial<StoredRecord>;
  if (record.version !== STORED_SESSION_VERSION || typeof record.agentId !== 'string' || !record.agentId || typeof record.epoch !== 'string' || !record.epoch
    || !Number.isSafeInteger(record.nextSeq) || record.nextSeq! < 1 || typeof record.hasOlder !== 'boolean' || !Array.isArray(record.entries)
    || !Number.isSafeInteger(record.updatedAt) || !record.snapshot || typeof record.snapshot !== 'object') return undefined;
  const history = decodeHistoryPage(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
    requestId: 'device-store', agentId: record.agentId, direction: 'tail', epoch: record.epoch, reset: false, staleCursor: false, gap: false,
    window: { minSeq: 1, maxSeq: record.nextSeq! - 1, nextSeq: record.nextSeq }, startCursor: null, endCursor: null,
    hasOlder: record.hasOlder, hasNewer: false, entries: record.entries, error: null,
  } }));
  const snapshot = decodeAgentSnapshot(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: record.snapshot }));
  if (history.status !== 'ok' || snapshot.status !== 'ok') return undefined;
  return { agentId: record.agentId, epoch: record.epoch, nextSeq: record.nextSeq!, hasOlder: record.hasOlder, entries: history.value.payload.entries,
    snapshot: snapshot.value.payload, updatedAt: record.updatedAt! };
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `pnpm --filter @orchardworks/agent-remote-web exec vitest run src/session-record.test.ts --testTimeout=10000` (Bash timeout 120000)
Expected: PASS, 6 tests. (If the `pendingInteractions` fixture in the third test is rejected by the type checker it is cast with `as never`; no decoder runs on it.)

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-web/src/session-record.ts packages/agent-remote-web/src/session-record.test.ts
git commit -m "feat(web): the record a device keeps of one conversation" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: The device store

**Files:**
- Create: `packages/agent-remote-web/src/device-store.ts`
- Create: `packages/agent-remote-web/src/device-store.test.ts`
- Modify: `packages/agent-remote-web/package.json`

- [ ] **Step 1: Write the failing tests.**

Create `packages/agent-remote-web/src/device-store.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentSnapshotPayload, ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { requestBrowserDatabase } from './browser-database.js';
import { DeviceStore, type DeviceStoreOptions } from './device-store.js';
import type { SessionToStore } from './session-record.js';

const snapshot = (): AgentSnapshotPayload => ({
  id: 'agent-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'native-1', status: 'idle' },
});
const entry = (seq: number): ProjectedTimelineEntry => ({
  providerId: 'codex', item: { type: 'assistant_message', text: `row ${seq}`, messageId: `m${seq}` }, timestamp: '2026-11-15T00:00:00.000Z',
  seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [], resources: [],
});
const session = (rows: number, extra: Partial<SessionToStore> = {}): SessionToStore => ({
  agentId: 'agent-1', epoch: 'e1', nextSeq: rows + 1, hasOlder: false, entries: Array.from({ length: rows }, (_, index) => entry(index + 1)), snapshot: snapshot(), ...extra,
});

const stores: DeviceStore[] = [];
function open(factory: IDBFactory): () => Promise<IDBDatabase> {
  return () => new Promise((resolve, reject) => {
    const request = requestBrowserDatabase(factory);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
// One clock for every store of a test, so rows written by different "tabs" order by when they were written.
let clock = 1000;
function create(factory: IDBFactory, options: DeviceStoreOptions = {}): DeviceStore {
  const store = new DeviceStore({ openDatabase: open(factory), now: () => ++clock, ...options });
  stores.push(store);
  return store;
}
async function diskKeys(factory: IDBFactory, name: 'sessions' | 'session_index'): Promise<string[]> {
  const database = await open(factory)();
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const transaction = database.transaction(name, 'readonly');
      const request = transaction.objectStore(name).getAllKeys();
      transaction.oncomplete = () => resolve(request.result as string[]);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { database.close(); }
}
afterEach(async () => { for (const store of stores.splice(0)) await store.flush(); vi.restoreAllMocks(); });

const A = ['account', 'a'] as const;

it('shows what it was given at once and writes it behind, so a new page finds it after a reload', async () => {
  const factory = new IDBFactory();
  const store = create(factory);
  store.save(...A, session(3));
  expect(store.peek(...A)?.entries).toHaveLength(3);
  expect(await diskKeys(factory, 'sessions')).toEqual([]);
  await store.flush();
  expect(await diskKeys(factory, 'sessions')).toHaveLength(1);
  expect(await diskKeys(factory, 'session_index')).toHaveLength(1);

  const reloaded = create(factory);
  expect(reloaded.peek(...A)).toBeUndefined();
  await reloaded.preload();
  expect(reloaded.peek(...A)).toMatchObject({ agentId: 'agent-1', epoch: 'e1', nextSeq: 4 });
  expect(reloaded.peek(...A)?.entries.map(item => item.seqStart)).toEqual([1, 2, 3]);
});

it('keeps only the newest window and remembers that older history exists', async () => {
  const store = create(new IDBFactory(), { limits: { window: { maxEntries: 5, maxBytes: 1_000_000 } } });
  store.save(...A, session(12));
  expect(store.peek(...A)?.entries.map(item => item.seqStart)).toEqual([8, 9, 10, 11, 12]);
  expect(store.peek(...A)?.hasOlder).toBe(true);
});

it('evicts the least recently updated unpinned sessions beyond its limit and never a pinned one', async () => {
  const factory = new IDBFactory();
  const store = create(factory, { limits: { maxSessions: 3 } });
  const release = store.pin('account', 's1');
  for (const id of ['s1', 's2', 's3', 's4', 's5']) store.save('account', id, session(2));
  await store.flush();
  const reloaded = create(factory);
  await reloaded.preload();
  expect(['s1', 's2', 's3', 's4', 's5'].map(id => !!reloaded.peek('account', id))).toEqual([true, false, false, true, true]);
  expect(store.peek('account', 's1')).toBeDefined();
  release();
  store.save('account', 's6', session(2));
  await store.flush();
  const again = create(factory);
  await again.preload();
  expect(['s1', 's4', 's5', 's6'].map(id => !!again.peek('account', id))).toEqual([false, true, true, true]);
});

it('keeps pinned content in memory when the resident budget is exceeded', async () => {
  const store = create(new IDBFactory(), { limits: { maxResidentBytes: 1 }, persistent: () => false });
  const release = store.pin('account', 'mounted');
  store.save('account', 'mounted', session(2));
  store.save('account', 'idle', session(2));
  expect(store.peek('account', 'mounted')).toBeDefined();
  expect(store.peek('account', 'idle')).toBeUndefined();
  release();
});

it('absorbs a quota error by evicting the oldest unpinned sessions and writing again', async () => {
  const factory = new IDBFactory();
  const store = create(factory);
  const release = store.pin('account', 's1');
  for (const id of ['s1', 's2', 's3', 's4']) store.save('account', id, session(2));
  await store.flush();
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); });
  store.save('account', 's5', session(2));
  await expect(store.flush()).resolves.toBeUndefined();
  expect(put).toHaveBeenCalled();
  const reloaded = create(factory);
  await reloaded.preload();
  expect(reloaded.peek('account', 's5')).toBeDefined();
  expect(reloaded.peek('account', 's1')).toBeDefined();
  expect(['s2', 's3', 's4'].filter(id => reloaded.peek('account', id))).toEqual(['s4']);
  release();
});

it('keeps content in memory and never throws when every write is refused', async () => {
  const factory = new IDBFactory();
  const store = create(factory);
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); });
  store.save(...A, session(2));
  await expect(store.flush()).resolves.toBeUndefined();
  expect(store.peek(...A)?.entries).toHaveLength(2);
  expect(await diskKeys(factory, 'sessions')).toEqual([]);
});

it('leaves a newer record of the same epoch, written by another tab, alone', async () => {
  const factory = new IDBFactory();
  const other = create(factory), page = create(factory);
  other.save(...A, session(20));
  await other.flush();
  page.save(...A, session(5));
  await page.flush();
  const reloaded = create(factory);
  await reloaded.preload();
  expect(reloaded.peek(...A)?.nextSeq).toBe(21);
  page.save(...A, session(5, { epoch: 'e2' }));
  await page.flush();
  const replaced = create(factory);
  await replaced.preload();
  expect(replaced.peek(...A)?.epoch).toBe('e2');
});

it('clears one account without touching another, in memory and on disk', async () => {
  const factory = new IDBFactory();
  const store = create(factory);
  store.save('one', 'a', session(2)); store.save('two', 'a', session(2));
  await store.flush();
  await store.clear('one');
  expect(store.peek('one', 'a')).toBeUndefined();
  expect(store.peek('two', 'a')).toBeDefined();
  const reloaded = create(factory);
  await reloaded.preload();
  expect(reloaded.peek('one', 'a')).toBeUndefined();
  expect(reloaded.peek('two', 'a')).toBeDefined();
  await reloaded.clear();
  expect(await diskKeys(factory, 'sessions')).toEqual([]);
});

it('clears what was there when it was asked, not what the page saves while it waits for the disk', async () => {
  const factory = new IDBFactory();
  const first = create(factory);
  first.save('one', 'a', session(2));
  await first.flush();
  const second = create(factory);
  const clearing = second.clear('one');
  second.save('one', 'a', session(3));
  await clearing;
  await second.flush();
  const reloaded = create(factory);
  await reloaded.preload();
  expect(reloaded.peek('one', 'a')?.nextSeq).toBe(4);
});

it('clears rows another tab wrote after this page read the index, and keeps what this page saved meanwhile', async () => {
  const factory = new IDBFactory();
  const page = create(factory), other = create(factory);
  await page.preload();
  other.save('one', 'b', session(2));
  await other.flush();
  const clearing = page.clear('one');
  page.save('one', 'c', session(2));
  await clearing;
  await page.flush();
  const reloaded = create(factory);
  await reloaded.preload();
  expect(reloaded.peek('one', 'b')).toBeUndefined();
  expect(reloaded.peek('one', 'c')).toBeDefined();
});

it('counts rows another tab wrote when it enforces its limits', async () => {
  const factory = new IDBFactory();
  const page = create(factory, { limits: { maxSessions: 2 } }), other = create(factory);
  await page.preload();
  for (const id of ['s1', 's2', 's3']) other.save('account', id, session(2));
  await other.flush();
  page.save('account', 's4', session(2));
  await page.flush();
  const reloaded = create(factory);
  await reloaded.preload();
  expect(['s1', 's2', 's3', 's4'].map(id => !!reloaded.peek('account', id))).toEqual([false, false, true, true]);
});

it('forgets one session, in memory and on disk, for content the reader may no longer see', async () => {
  const factory = new IDBFactory();
  const store = create(factory);
  store.save('account', 'a', session(2)); store.save('account', 'b', session(2));
  await store.flush();
  await store.forget('account', 'a');
  expect(store.peek('account', 'a')).toBeUndefined();
  const reloaded = create(factory);
  await reloaded.preload();
  expect(reloaded.peek('account', 'a')).toBeUndefined();
  expect(reloaded.peek('account', 'b')).toBeDefined();
});

it('drops content it could not write for several batches in a row once memory is over its budget', async () => {
  const measure = create(new IDBFactory());
  measure.save(...A, session(2));
  const one = measure.stats().bytes;
  const store = create(new IDBFactory(), { limits: { maxResidentBytes: Math.ceil(one * 1.5) } });
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new Error('The disk failed.'); });
  store.save('account', 'old', session(2));
  for (let attempt = 0; attempt < 3; attempt++) await store.flush();
  store.save('account', 'new', session(2));
  expect(store.peek('account', 'old')).toBeUndefined();
  expect(store.peek('account', 'new')).toBeDefined();
});

it('drops its disk copies but keeps showing what the page holds when persistence is switched off', async () => {
  const factory = new IDBFactory();
  let persistent = true;
  const store = create(factory, { persistent: () => persistent });
  store.save(...A, session(2));
  await store.flush();
  persistent = false;
  await store.dropPersisted();
  expect(await diskKeys(factory, 'sessions')).toEqual([]);
  expect(store.peek(...A)).toBeDefined();
  store.save('account', 'b', session(2));
  await store.flush();
  expect(await diskKeys(factory, 'sessions')).toEqual([]);
});

it('discards a damaged record and still serves the rest', async () => {
  const factory = new IDBFactory();
  const store = create(factory);
  store.save(...A, session(2)); store.save('account', 'b', session(2));
  await store.flush();
  const database = await open(factory)();
  const key = JSON.stringify(A);
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('sessions', 'readwrite');
    transaction.objectStore('sessions').put({ key, version: 1, nextSeq: 0 });
    transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
  });
  database.close();
  const reloaded = create(factory);
  await reloaded.preload();
  expect(reloaded.peek(...A)).toBeUndefined();
  expect(reloaded.peek('account', 'b')).toBeDefined();
});

it('loads a session outside its preload on demand', async () => {
  const factory = new IDBFactory();
  const store = create(factory);
  for (const id of ['s1', 's2', 's3']) store.save('account', id, session(2));
  await store.flush();
  const reloaded = create(factory, { limits: { preloadSessions: 1 } });
  await reloaded.preload();
  expect(['s1', 's2', 's3'].filter(id => reloaded.peek('account', id))).toEqual(['s3']);
  expect((await reloaded.load('account', 's1'))?.nextSeq).toBe(3);
  expect(reloaded.peek('account', 's1')).toBeDefined();
  expect(await reloaded.load('account', 'unknown')).toBeUndefined();
});

it('forgets its memory like a reload does and keeps what is on disk', async () => {
  const factory = new IDBFactory();
  const store = create(factory);
  store.save(...A, session(2));
  await store.flush();
  store.unload();
  expect(store.peek(...A)).toBeUndefined();
  await store.preload();
  expect(store.peek(...A)).toBeDefined();
});
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `pnpm --filter @orchardworks/agent-remote-web exec vitest run src/device-store.test.ts --testTimeout=10000` (Bash timeout 120000)
Expected: FAIL, `Failed to resolve import "./device-store.js"`.

- [ ] **Step 3: Write the store.**

Create `packages/agent-remote-web/src/device-store.ts`:

```ts
import { requestBrowserDatabase, SESSIONS_STORE, SESSION_INDEX_STORE } from './browser-database.js';
import { createStoredRecord, decodeStoredRecord, DEFAULT_WINDOW_LIMITS, storedKey, type SessionToStore, type StoredRecord, type StoredSession, type StoredWindowLimits } from './session-record.js';

export interface DeviceStoreLimits {
  /** Sessions kept on disk. Every limit is soft: a pinned session is never evicted. */
  readonly maxSessions: number;
  readonly maxBytes: number;
  /** Bytes of records held in memory; unpinned ones beyond it leave memory and stay on disk. */
  readonly maxResidentBytes: number;
  readonly window: StoredWindowLimits;
  /** What a preload reads: the most recently updated sessions, up to these bounds. */
  readonly preloadSessions: number;
  readonly preloadBytes: number;
}
export type { SessionToStore, StoredSession } from './session-record.js';
export const DEFAULT_DEVICE_STORE_LIMITS: DeviceStoreLimits = {
  maxSessions: 40, maxBytes: 32 * 1024 * 1024, maxResidentBytes: 16 * 1024 * 1024, window: DEFAULT_WINDOW_LIMITS,
  preloadSessions: 16, preloadBytes: 4 * 1024 * 1024,
};

export interface DeviceStoreOptions {
  openDatabase?(): Promise<IDBDatabase>;
  limits?: Partial<DeviceStoreLimits>;
  /** Whether content may be written to disk now; false keeps everything in memory. */
  persistent?(): boolean;
  now?(): number;
  /** How long a save waits for others to share its transaction. */
  flushDelayMs?: number;
}

interface IndexRow { readonly key: string; readonly scope: string; readonly identity: string; readonly updatedAt: number; readonly bytes: number }
/** `decoded` is undefined until the record is first read, and null when it failed validation. */
interface Held { readonly record: StoredRecord; decoded?: StoredSession | null }

const indexRow = (record: StoredRecord): IndexRow => ({ key: record.key, scope: record.scope, identity: record.identity, updatedAt: record.updatedAt, bytes: record.bytes });
const toSession = (record: StoredRecord): StoredSession => ({ agentId: record.agentId, epoch: record.epoch, nextSeq: record.nextSeq, hasOlder: record.hasOlder,
  entries: record.entries, snapshot: record.snapshot, updatedAt: record.updatedAt });
/** After this many failed batches in a row, content waiting for disk may leave memory to keep it bounded. */
const MAX_FAILED_WRITES = 3;
const isQuotaError = (error: unknown): boolean => (error as { name?: string } | null)?.name === 'QuotaExceededError' || (error as { code?: number } | null)?.code === 22;

/**
 * What this device keeps of the conversations it opened: a memory copy for the synchronous first paint, and an IndexedDB copy
 * written behind. The disk is bounded by soft limits that spare pinned (mounted) sessions, and a full disk is absorbed here.
 */
export class DeviceStore {
  private readonly held = new Map<string, Held>();
  private readonly index = new Map<string, IndexRow>();
  private readonly pins = new Map<string, number>();
  private readonly dirty = new Set<string>();
  private readonly removed = new Set<string>();
  private readonly limits: DeviceStoreLimits;
  private readonly openDatabase: (() => Promise<IDBDatabase>) | undefined;
  private readonly persistent: () => boolean;
  private readonly now: () => number;
  private readonly flushDelayMs: number;
  private connection: Promise<IDBDatabase> | undefined;
  private indexLoaded: Promise<void> | undefined;
  private preloaded: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  /** Consecutive batches that could not be written. */
  private failedWrites = 0;

  constructor(options: DeviceStoreOptions = {}) {
    this.limits = { ...DEFAULT_DEVICE_STORE_LIMITS, ...options.limits, window: { ...DEFAULT_WINDOW_LIMITS, ...options.limits?.window } };
    this.openDatabase = options.openDatabase;
    this.persistent = options.persistent ?? (() => true);
    this.now = options.now ?? Date.now;
    this.flushDelayMs = options.flushDelayMs ?? 50;
  }

  /** What the page holds for a session, synchronously; undefined when it was not loaded (see `load`). */
  peek(scope: string, identity: string): StoredSession | undefined {
    const key = storedKey(scope, identity);
    const held = this.held.get(key);
    if (!held) return undefined;
    if (held.decoded === undefined) held.decoded = decodeStoredRecord(held.record) ?? null;
    if (held.decoded === null) { this.discard(key); return undefined; }
    this.held.delete(key);
    this.held.set(key, held);
    return held.decoded;
  }

  /** `peek`, reading the session from disk when the page does not hold it yet. */
  async load(scope: string, identity: string): Promise<StoredSession | undefined> {
    const hit = this.peek(scope, identity);
    if (hit || !this.available()) return hit;
    await this.loadIndex();
    const key = storedKey(scope, identity);
    if (!this.index.has(key)) return undefined;
    const database = await this.open();
    const [record] = await readMany<StoredRecord>(database, SESSIONS_STORE, [key]);
    if (record && !this.held.has(key)) { this.held.set(key, { record }); this.trimMemory(); }
    return this.peek(scope, identity);
  }

  /** Keeps what a page shows now; the disk write follows after a short wait. */
  save(scope: string, identity: string, session: SessionToStore): void {
    const record = createStoredRecord(scope, identity, session, this.limits.window, this.now());
    if (!record) return;
    this.held.delete(record.key);
    this.held.set(record.key, { record, decoded: toSession(record) });
    this.removed.delete(record.key);
    this.trimMemory();
    if (!this.persistent()) return;
    this.index.set(record.key, indexRow(record));
    this.dirty.add(record.key);
    this.timer ??= setTimeout(() => { this.timer = undefined; void this.flush(); }, this.flushDelayMs);
  }

  /** A pinned session is never evicted, from memory or from disk. Release it when its view goes away. */
  pin(scope: string, identity: string): () => void {
    const key = storedKey(scope, identity);
    this.pins.set(key, (this.pins.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.pins.get(key) ?? 1) - 1;
      if (count > 0) this.pins.set(key, count); else this.pins.delete(key);
    };
  }

  /** Reads the index and the most recent records into memory, so the first paint can use `peek`. Never rejects. */
  preload(): Promise<void> {
    this.preloaded ??= (async () => { await this.loadIndex(); if (this.available()) await this.loadRecent(); })()
      .catch(() => { this.preloaded = undefined; });
    return this.preloaded;
  }

  /** Writes what is waiting. Never rejects: a failed write leaves the content in memory for the next one. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.chain = this.chain.then(() => this.writeBatch()).catch(() => undefined);
    return this.chain;
  }

  /** Removes an account's sessions (every account's without a scope) from memory and disk. What the page saves meanwhile stays. */
  async clear(scope?: string): Promise<void> {
    const matches = (row: IndexRow) => scope === undefined || row.scope === scope;
    for (const [key, held] of [...this.held]) if (scope === undefined || held.record.scope === scope) this.held.delete(key);
    for (const row of [...this.index.values()]) if (matches(row)) { this.index.delete(row.key); this.dirty.delete(row.key); }
    await this.purge(matches, true);
  }

  /** Removes one session from memory and disk, for content the reader may no longer see. */
  async forget(scope: string, identity: string): Promise<void> {
    const key = storedKey(scope, identity);
    this.held.delete(key); this.index.delete(key); this.dirty.delete(key);
    await this.purge(row => row.key === key, true);
  }

  /** Removes everything from disk and keeps what the page holds, for a page that must not leave content behind. */
  async dropPersisted(): Promise<void> {
    this.index.clear();
    this.dirty.clear();
    await this.purge(() => true, false);
  }

  /** Forgets what the page holds, as a reload does; disk stays. */
  unload(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.held.clear(); this.index.clear(); this.dirty.clear(); this.removed.clear();
    this.indexLoaded = undefined; this.preloaded = undefined;
  }

  stats(): { sessions: number; bytes: number; resident: number } {
    let bytes = 0;
    for (const row of this.index.values()) bytes += row.bytes;
    return { sessions: this.index.size, bytes, resident: this.held.size };
  }

  /** Deletes matching rows from disk after every write already queued. The index is read inside the deleting transaction, so rows another tab wrote are found. */
  private purge(matches: (row: IndexRow) => boolean, spareHeld: boolean): Promise<void> {
    this.chain = this.chain.then(() => this.purgeOnDisk(matches, spareHeld)).catch(() => undefined);
    return this.chain;
  }

  private async purgeOnDisk(matches: (row: IndexRow) => boolean, spareHeld: boolean): Promise<void> {
    if (!this.available()) return;
    try {
      const database = await this.open();
      const gone = await new Promise<string[]>((resolve, reject) => {
        const transaction = database.transaction([SESSIONS_STORE, SESSION_INDEX_STORE], 'readwrite');
        const sessions = transaction.objectStore(SESSIONS_STORE), index = transaction.objectStore(SESSION_INDEX_STORE);
        const rows = index.getAll();
        const doomed: string[] = [];
        rows.onsuccess = () => {
          for (const row of rows.result as IndexRow[]) {
            // What this page saved since the call is held or waiting to be written, and stays.
            if (!matches(row) || (spareHeld && (this.held.has(row.key) || this.dirty.has(row.key)))) continue;
            sessions.delete(row.key); index.delete(row.key); doomed.push(row.key);
          }
        };
        transaction.oncomplete = () => resolve(doomed);
        transaction.onabort = () => reject(transaction.error);
      });
      for (const key of gone) this.index.delete(key);
    } catch { /* The rows stay until the next clear. */ }
  }

  private available(): boolean { return this.openDatabase !== undefined || typeof indexedDB !== 'undefined'; }

  private discard(key: string): void {
    this.held.delete(key);
    if (this.index.delete(key)) this.removed.add(key);
    this.dirty.delete(key);
  }

  private trimMemory(): void {
    let bytes = 0;
    for (const held of this.held.values()) bytes += held.record.bytes;
    for (const [key, held] of this.held) {
      if (bytes <= this.limits.maxResidentBytes) break;
      if (this.pins.has(key)) continue;
      // Content that could not be written for a while is dropped rather than letting memory grow without bound.
      if (this.dirty.has(key) && this.failedWrites < MAX_FAILED_WRITES) continue;
      this.dirty.delete(key); this.index.delete(key);
      this.held.delete(key);
      bytes -= held.record.bytes;
    }
  }

  private open(): Promise<IDBDatabase> {
    if (this.connection) return this.connection;
    const pending = (this.openDatabase ?? openDefault)().then(database => {
      const release = () => { if (this.connection === pending) this.connection = undefined; };
      database.onversionchange = () => { release(); database.close(); };
      database.onclose = release;
      return database;
    });
    this.connection = pending;
    pending.catch(() => { if (this.connection === pending) this.connection = undefined; });
    return pending;
  }

  private loadIndex(): Promise<void> {
    if (!this.indexLoaded) {
      const loading = this.readIndex().catch(() => { if (this.indexLoaded === loading) this.indexLoaded = undefined; });
      this.indexLoaded = loading;
    }
    return this.indexLoaded;
  }

  private async readIndex(): Promise<void> {
    if (!this.available()) return;
    const rows = await readAll<IndexRow>(await this.open(), SESSION_INDEX_STORE);
    for (const row of rows) if (!this.index.has(row.key) && !this.removed.has(row.key)) this.index.set(row.key, row);
  }

  private async loadRecent(): Promise<void> {
    const database = await this.open();
    const rows = [...this.index.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    const chosen: string[] = [];
    let bytes = 0;
    for (const row of rows) {
      if (this.held.has(row.key)) continue;
      if (chosen.length >= this.limits.preloadSessions || (chosen.length > 0 && bytes + row.bytes > this.limits.preloadBytes)) break;
      chosen.push(row.key);
      bytes += row.bytes;
    }
    const records = await readMany<StoredRecord>(database, SESSIONS_STORE, chosen);
    // Newest was read first; the map keeps the least recently used first.
    for (const record of records.reverse()) if (record && !this.held.has(record.key)) this.held.set(record.key, { record });
  }

  private async writeBatch(): Promise<void> {
    if (!this.available()) { this.dirty.clear(); this.removed.clear(); return; }
    await this.loadIndex();
    const writes = [...this.dirty].flatMap(key => { const held = this.held.get(key); return held ? [held.record] : []; });
    const deletes = [...this.removed];
    this.dirty.clear(); this.removed.clear();
    if (!writes.length && !deletes.length) return;
    try { await this.commit(writes, deletes); }
    catch (error) {
      if (!isQuotaError(error)) { this.retain(writes, deletes); return; }
      const freed = this.evictForQuota(new Set(writes.map(record => record.key)));
      try { await this.commit(writes, [...deletes, ...freed]); }
      catch { this.retain(writes, [...deletes, ...freed]); return; }
    }
    this.failedWrites = 0;
    await this.enforceLimits();
  }

  /** A failed write is not lost: its content stays held and is written with the next save. */
  private retain(writes: readonly StoredRecord[], deletes: readonly string[]): void {
    this.failedWrites += 1;
    for (const record of writes) if (this.held.has(record.key)) this.dirty.add(record.key);
    for (const key of deletes) this.removed.add(key);
  }

  private commit(writes: readonly StoredRecord[], deletes: readonly string[]): Promise<void> {
    return this.open().then(database => new Promise<void>((resolve, reject) => {
      let failure: unknown;
      const transaction = database.transaction([SESSIONS_STORE, SESSION_INDEX_STORE], 'readwrite');
      const sessions = transaction.objectStore(SESSIONS_STORE), index = transaction.objectStore(SESSION_INDEX_STORE);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(failure ?? transaction.error ?? new DOMException('Device storage was interrupted.', 'AbortError'));
      for (const key of deletes) { sessions.delete(key); index.delete(key); }
      for (const record of writes) {
        const read = sessions.get(record.key);
        read.onsuccess = () => {
          const existing = read.result as StoredRecord | undefined;
          // Another tab may have saved newer content of this epoch since this page last looked.
          if (existing && existing.epoch === record.epoch && existing.nextSeq > record.nextSeq) return;
          try { sessions.put(record); index.put(indexRow(record)); }
          catch (error) { failure = error; transaction.abort(); }
        };
      }
    }));
  }

  /** Drops the oldest half of what may be dropped, so a retry has room. Returns the keys to delete on disk. */
  private evictForQuota(keep: ReadonlySet<string>): string[] {
    const candidates = [...this.index.values()].filter(row => !keep.has(row.key) && !this.pins.has(row.key)).sort((a, b) => a.updatedAt - b.updatedAt);
    const evicted = candidates.slice(0, Math.max(1, Math.ceil(candidates.length / 2))).map(row => row.key);
    for (const key of evicted) { this.index.delete(key); this.held.delete(key); }
    return evicted;
  }

  /** Evicts beyond the limits. The rows are read inside the deleting transaction, so what other tabs wrote counts too. */
  private async enforceLimits(): Promise<void> {
    try {
      const database = await this.open();
      const evicted = await new Promise<string[]>((resolve, reject) => {
        const transaction = database.transaction([SESSIONS_STORE, SESSION_INDEX_STORE], 'readwrite');
        const sessions = transaction.objectStore(SESSIONS_STORE), index = transaction.objectStore(SESSION_INDEX_STORE);
        const rows = index.getAll();
        const gone: string[] = [];
        rows.onsuccess = () => { for (const key of this.victims(rows.result as IndexRow[])) { sessions.delete(key); index.delete(key); gone.push(key); } };
        transaction.oncomplete = () => resolve(gone);
        transaction.onabort = () => reject(transaction.error);
      });
      for (const key of evicted) { this.index.delete(key); this.held.delete(key); }
    } catch { /* The limits are enforced again after the next write. */ }
  }

  /** The least recently updated sessions beyond the limits, never a pinned or unwritten one. */
  private victims(all: readonly IndexRow[]): string[] {
    const rows = [...all].sort((a, b) => a.updatedAt - b.updatedAt);
    let sessions = rows.length;
    let bytes = rows.reduce((sum, row) => sum + row.bytes, 0);
    const evicted: string[] = [];
    for (const row of rows) {
      if (sessions <= this.limits.maxSessions && bytes <= this.limits.maxBytes) break;
      if (this.pins.has(row.key) || this.dirty.has(row.key)) continue;
      evicted.push(row.key);
      sessions -= 1;
      bytes -= row.bytes;
    }
    return evicted;
  }
}

function openDefault(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Browser storage is unavailable.')); return; }
    const request = requestBrowserDatabase();
    let settled = false;
    request.onsuccess = () => {
      // A blocked open that succeeds later must not leave a connection nobody holds, which would block the next upgrade.
      if (settled) { request.result.close(); return; }
      settled = true; resolve(request.result);
    };
    request.onerror = () => { settled = true; reject(request.error ?? new Error('Browser storage is unavailable.')); };
    request.onblocked = () => { settled = true; reject(new Error('Browser storage is blocked.')); };
  });
}

function readAll<T>(database: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(store, 'readonly');
    const request = transaction.objectStore(store).getAll();
    transaction.oncomplete = () => resolve(request.result as T[]);
    transaction.onabort = () => reject(transaction.error);
  });
}

function readMany<T>(database: IDBDatabase, store: string, keys: readonly string[]): Promise<Array<T | undefined>> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(store, 'readonly');
    const objects = transaction.objectStore(store);
    const requests = keys.map(key => objects.get(key));
    transaction.oncomplete = () => resolve(requests.map(request => request.result as T | undefined));
    transaction.onabort = () => reject(transaction.error);
  });
}

let persistence: () => boolean = () => true;
/** The device store of this page. Its disk copy is written unless the page's policy forbids it (see `configureDeviceStorePersistence`). */
export const deviceStore = new DeviceStore({ persistent: () => persistence() });
/** Lets the application say when content may not be left on disk, as it does for drafts. */
export function configureDeviceStorePersistence(persistent: () => boolean): void { persistence = persistent; }
/** Removes the disk copies and keeps what the page holds. */
export function clearPersistedDeviceStore(): Promise<void> { return deviceStore.dropPersisted(); }
if (typeof window !== 'undefined') {
  // A page that is going away writes what it holds; the transaction is started before the page is gone.
  window.addEventListener('pagehide', () => { void deviceStore.flush(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void deviceStore.flush(); });
}
/** Starts reading the store for the first paint. Resolves when it is read or when the wait is over; never rejects. */
export function preloadDeviceStore(timeoutMs = 1000): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs);
    void deviceStore.preload().then(() => { clearTimeout(timer); resolve(); });
  });
}
```

- [ ] **Step 4: Give the store its own subpath.**

The sign-in entry chunk of the lab (`GatewayController.tsx`) already imports `@orchardworks/agent-remote-web/browser`. The store imports the protocol codec (TypeBox) to validate records, so it must not be reachable from `browser.ts`. In `packages/agent-remote-web/package.json`, add to `exports`, after the `"./browser"` entry:

```json
    "./device-store": {
      "types": "./dist/device-store.d.ts",
      "import": "./dist/device-store.js"
    },
```

Do not add the store to `browser.ts` or `index.ts`.

- [ ] **Step 5: Run the tests to verify they pass.**

Run: `pnpm --filter @orchardworks/agent-remote-web exec vitest run src/device-store.test.ts src/session-record.test.ts --testTimeout=10000` (Bash timeout 180000)
Expected: PASS, 23 tests (17 in `device-store.test.ts`, 6 in `session-record.test.ts`).

The tests assert, among other things, that nothing is on disk before the flush (write-behind), that the pinned session survives eviction while the two oldest unpinned ones go, that a refused write never rejects `flush`, and that a record another tab wrote with a larger cursor in the same epoch survives.

- [ ] **Step 6: Typecheck.**

Run: `pnpm --filter @orchardworks/agent-remote-web run typecheck` (Bash timeout 180000)
Expected: exit code 0.

- [ ] **Step 7: Commit.**

```bash
git add packages/agent-remote-web/src/device-store.ts packages/agent-remote-web/src/device-store.test.ts packages/agent-remote-web/package.json
git commit -m "feat(web): a device store for conversations with soft limits and write-behind" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: No holes in the window, and rows that keep their identity

**Files:**
- Modify: `packages/agent-remote-web/src/replica/reducer.ts`
- Create: `packages/agent-remote-web/src/replica/reducer.window.test.ts`

How row keys work today: `timelineEntryKey(epoch, entry)` is `${epoch}:${providerId}:${seqStart}:${identity}` and `createTimelineRenderModel` uses it as the React key of every row (`ConversationEntry key={key}`). The epoch changes only on a replacement (journal-served) or on every Controller open (crude), so on a journal-served session a stable epoch and a stable `seqStart` already keep a row mounted across a reconnect. The key is not changed. This task makes sure a catch-up never changes an entry's first sequence (the fold rule) and never replaces an unchanged entry by a clone.

- [ ] **Step 1: Write the failing tests.**

Create `packages/agent-remote-web/src/replica/reducer.window.test.ts`:

```ts
import { expect, it } from 'vitest';
import type { HistoryPage, ProjectedTimelineEntry, TimelineDirection } from '@orchardworks/agent-remote-protocol';
import { applyHistoryPage, createReplicaState } from './reducer.js';
import { timelineEntryKey } from './timeline-entry-key.js';

const entry = (seqStart: number, seqEnd = seqStart, text = `row ${seqStart}`, extra: Partial<ProjectedTimelineEntry> = {}): ProjectedTimelineEntry => ({
  providerId: 'p', item: { type: 'assistant_message', text, messageId: `m${seqStart}` }, timestamp: '2026-11-15T00:00:00.000Z',
  seqStart, seqEnd, sourceSeqRanges: [{ startSeq: seqStart, endSeq: seqEnd }], collapsed: [], resources: [], ...extra,
});
const page = (direction: TimelineDirection, entries: ProjectedTimelineEntry[], options: { epoch?: string; nextSeq: number; hasOlder?: boolean }): HistoryPage => ({
  protocolVersion: '1.8.0', type: 'timeline_page',
  payload: { requestId: 'r', agentId: 'a', direction, epoch: options.epoch ?? 'e1', reset: false, staleCursor: false, gap: false,
    window: { minSeq: entries[0]?.seqStart ?? 0, maxSeq: options.nextSeq - 1, nextSeq: options.nextSeq }, startCursor: null, endCursor: null,
    hasOlder: options.hasOlder ?? false, hasNewer: false, entries, error: null },
});
const held = (entries: ProjectedTimelineEntry[], nextSeq: number) => applyHistoryPage(createReplicaState(), page('tail', entries, { nextSeq, hasOlder: true })).state;

it('drops an update to an item older than the window instead of leaving an isolated old entry', () => {
  const state = held([entry(10), entry(11), entry(12)], 13);
  const corrected = entry(4, 13, 'corrected', { sourceSeqRanges: [{ startSeq: 4, endSeq: 4 }, { startSeq: 13, endSeq: 13 }] });
  const result = applyHistoryPage(state, page('after', [corrected, entry(14)], { nextSeq: 15 }));
  expect(result.status).toBe('applied');
  expect(result.state.timeline.entries.map(item => item.seqStart)).toEqual([10, 11, 12, 14]);
  expect(result.state.timeline.nextSeq).toBe(15);
  expect(result.state.timeline.hasOlder).toBe(true);
});

it('folds an update that reaches into the window into the entry it overlaps, at that entry\'s place and under its key', () => {
  const state = held([entry(10), entry(11)], 12);
  const amended = entry(4, 10, 'amended', { item: { type: 'assistant_message', text: 'amended', messageId: 'm10' }, sourceSeqRanges: [{ startSeq: 4, endSeq: 4 }, { startSeq: 10, endSeq: 10 }] });
  const result = applyHistoryPage(state, page('after', [amended], { nextSeq: 12 }));
  expect(result.state.timeline.entries.map(item => [item.seqStart, (item.item as { text: string }).text])).toEqual([[10, 'amended'], [11, 'row 11']]);
  expect(timelineEntryKey('e1', result.state.timeline.entries[0]!)).toBe(timelineEntryKey('e1', state.timeline.entries[0]!));
});

it('leaves the next older page a contiguous start: a before page from the window\'s first entry fills everything in between', () => {
  const state = held([entry(10), entry(11)], 12);
  const amended = entry(4, 10, 'amended', { sourceSeqRanges: [{ startSeq: 4, endSeq: 4 }, { startSeq: 10, endSeq: 10 }] });
  const folded = applyHistoryPage(state, page('after', [amended], { nextSeq: 12 })).state;
  const cursor = folded.timeline.entries[0]!.seqStart;
  expect(cursor).toBe(10);
  const older = [entry(3), amended];
  const result = applyHistoryPage(folded, page('before', older, { nextSeq: 12 }));
  expect(result.state.timeline.entries.map(item => item.seqStart)).toEqual([3, 4, 11]);
});

it('keeps the object of an entry a page repeats unchanged, and replaces only the one that changed', () => {
  const first = applyHistoryPage(createReplicaState(), page('tail', [entry(1), entry(2), entry(3)], { nextSeq: 4 })).state;
  const again = applyHistoryPage(first, page('tail', [entry(1), entry(2, 2, 'edited'), entry(3)], { nextSeq: 4 })).state;
  expect(again.timeline.entries[0]).toBe(first.timeline.entries[0]);
  expect(again.timeline.entries[1]).not.toBe(first.timeline.entries[1]);
  expect(again.timeline.entries[2]).toBe(first.timeline.entries[2]);
  const afterPage = applyHistoryPage(again, page('after', [entry(3), entry(4)], { nextSeq: 5 })).state;
  expect(afterPage.timeline.entries[0]).toBe(again.timeline.entries[0]);
  expect(afterPage.timeline.entries[2]).toBe(again.timeline.entries[2]);
});

it('never reuses an entry across epochs', () => {
  const first = applyHistoryPage(createReplicaState(), page('tail', [entry(1)], { nextSeq: 2 })).state;
  const replaced = applyHistoryPage(first, page('tail', [entry(1)], { epoch: 'e2', nextSeq: 2 })).state;
  expect(replaced.timeline.entries[0]).not.toBe(first.timeline.entries[0]);
});
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `pnpm --filter @orchardworks/agent-remote-web exec vitest run src/replica/reducer.window.test.ts --testTimeout=10000` (Bash timeout 120000)
Expected: FAIL in the first four tests: the isolated old entry (`[4, 10, 11, 12, 14]` instead of `[10, 11, 12, 14]`) and the object identity (`toBe`). The last test (no reuse across epochs) passes already; it guards the reuse rule.

- [ ] **Step 3: Fold older updates and keep unchanged entries.**

In `packages/agent-remote-web/src/replica/reducer.ts`, in `applyHistoryPage`, replace

```ts
  const entries = mergeAuthoritative(base, incoming);
```

with

```ts
  const entries = mergeAuthoritative(base, payload.direction === 'after' ? foldBelowWindow(base, incoming) : incoming);
  const unchanged = authorityState.timeline.epoch === payload.epoch ? authorityState.timeline.entries : [];
```

and replace, inside the `prepared` object of the same function,

```ts
      entries: applyBackgroundEntries(entries, authorityState.timeline.backgroundActivities),
```

with

```ts
      entries: reuseUnchanged(applyBackgroundEntries(entries, authorityState.timeline.backgroundActivities), unchanged),
      // Stored content stays marked until the connection is ready (`AgentReplica.confirmRestored`), not until its first page.
      ...(authorityState.timeline.restoredFromDevice && authorityState.timeline.epoch === payload.epoch ? { restoredFromDevice: true as const } : {}),
```

Add these functions directly above `function mergeAuthoritative(`:

```ts
/**
 * An `after` page can carry an item older than the window the client holds, for example an old tool call whose output arrived
 * later, or an item the Relay corrected. Such an item keeps its place in the window: it never becomes an entry before the window's
 * oldest one, or the next `before` page, which starts at that entry, would skip the history between them. An item outside the
 * window is left for a `before` page to bring, already corrected.
 */
function foldBelowWindow(held: readonly ProjectedTimelineEntry[], incoming: readonly ProjectedTimelineEntry[]): ProjectedTimelineEntry[] {
  const boundary = held[0]?.seqStart;
  if (boundary === undefined) return [...incoming];
  const folded: ProjectedTimelineEntry[] = [];
  for (const candidate of incoming) {
    if (candidate.seqStart >= boundary) { folded.push(candidate); continue; }
    const overlapped = held.filter(entry => rangesOverlap(entry.sourceSeqRanges, candidate.sourceSeqRanges));
    if (overlapped.length) folded.push({ ...candidate, seqStart: Math.min(...overlapped.map(entry => entry.seqStart)) });
  }
  return folded;
}

/** An entry equal to the one held at its sequence is that one, so rows built from it do no work. */
function reuseUnchanged(entries: readonly ProjectedTimelineEntry[], previous: readonly ProjectedTimelineEntry[]): readonly ProjectedTimelineEntry[] {
  if (!previous.length) return entries;
  const bySequence = new Map(previous.map(entry => [entry.seqStart, entry]));
  return entries.map(entry => {
    const held = bySequence.get(entry.seqStart);
    return held && sameValue(held, entry) ? held : entry;
  });
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || !left || !right || Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => key in b && sameValue(a[key], b[key]));
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `pnpm --filter @orchardworks/agent-remote-web exec vitest run src/replica src/react/AgentTimeline.test.tsx src/react/AgentTimeline.selection.test.tsx src/client/timeline-search.test.ts --testTimeout=10000` (Bash timeout 300000)
Expected: PASS, including every existing reducer and timeline test.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-web/src/replica/reducer.ts packages/agent-remote-web/src/replica/reducer.window.test.ts
git commit -m "feat(web): fold updates older than the window in place and keep unchanged rows" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Restoring a replica from the device store

**Files:**
- Modify: `packages/agent-remote-web/src/replica/types.ts`
- Modify: `packages/agent-remote-web/src/replica/store.ts`
- Modify: `packages/agent-remote-web/src/client/session-state.ts`
- Modify: `packages/agent-remote-web/src/react/AgentActivityStatus.tsx`
- Modify: `packages/agent-remote-web/src/react/AgentComposer.tsx`
- Create: `packages/agent-remote-web/src/replica/store.restore.test.ts`
- Create: `packages/agent-remote-web/src/react/AgentActivityStatus.restoring.test.tsx`
- Create: `packages/agent-remote-web/src/react/AgentComposer.restoring.test.tsx`
- Modify: `packages/agent-remote-web/src/client/session-state.test.ts`

- [ ] **Step 1: Write the failing tests.**

Create `packages/agent-remote-web/src/replica/store.restore.test.ts`:

```ts
import { expect, it } from 'vitest';
import type { AgentSnapshotPayload, HistoryPage, ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { remoteSessionState } from '../client/session-state.js';
import { AgentReplica } from './store.js';

const snapshot = (): AgentSnapshotPayload => ({
  id: 'stored-id', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'native-1', status: 'idle' },
});
const entry = (seq: number): ProjectedTimelineEntry => ({
  providerId: 'codex', item: { type: 'assistant_message', text: `row ${seq}`, messageId: `m${seq}` }, timestamp: '2026-11-15T00:00:00.000Z',
  seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [], resources: [],
});
const stored = { snapshot: snapshot(), epoch: 'e1', nextSeq: 3, hasOlder: true, entries: [entry(1), entry(2)] };
const afterPage: HistoryPage = { protocolVersion: '1.8.0', type: 'timeline_page', payload: { requestId: 'r', agentId: 'agent-1', direction: 'after', epoch: 'e1',
  reset: false, staleCursor: false, gap: false, window: { minSeq: 1, maxSeq: 3, nextSeq: 4 }, startCursor: null, endCursor: null, hasOlder: false, hasNewer: false,
  entries: [entry(3)], error: null } };

it('shows the stored conversation with its cursor and names the public session it is now attached as', () => {
  const replica = new AgentReplica();
  expect(replica.restoreFromDevice(stored, 'agent-1')).toBe(true);
  const state = replica.getState();
  expect(state.agent?.id).toBe('agent-1');
  expect(state.timeline).toMatchObject({ epoch: 'e1', initialized: true, nextSeq: 3, hasOlder: true, restoredFromDevice: true, pendingLive: [] });
  expect(state.timeline.entries.map(item => item.seqStart)).toEqual([1, 2]);
  expect(state.timeline.entries[0]).not.toBe(stored.entries[0]);
});

it('does not replace a conversation that already holds content', () => {
  const replica = new AgentReplica();
  replica.applyHistory({ ...afterPage, payload: { ...afterPage.payload, direction: 'tail', entries: [entry(1)], window: { minSeq: 1, maxSeq: 1, nextSeq: 2 } } });
  replica.applySnapshot({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: snapshot() });
  expect(replica.restoreFromDevice(stored, 'agent-1')).toBe(false);
  expect(replica.getState().timeline.nextSeq).toBe(2);
});

it('stays restored content until the connection is ready, so Synchronizing does not flicker, and is shown as a disconnect when the socket closes', () => {
  const replica = new AgentReplica();
  replica.restoreFromDevice(stored, 'agent-1');
  expect(remoteSessionState(replica.getState(), 'connecting').restoring).toBe(true);
  expect(remoteSessionState(replica.getState(), 'catching_up').restoring).toBe(true);
  expect(remoteSessionState(replica.getState(), 'disconnected').restoring).toBe(false);
  expect(remoteSessionState(replica.getState(), 'ready').restoring).toBe(false);
  expect(remoteSessionState(replica.getState(), 'unavailable').restoring).toBe(false);
  replica.applyHistory(afterPage);
  const state = replica.getState();
  expect(state.timeline.restoredFromDevice).toBe(true);
  expect(state.timeline.entries.map(item => item.seqStart)).toEqual([1, 2, 3]);
  expect(remoteSessionState(state, 'catching_up').restoring).toBe(true);
  replica.confirmRestored();
  expect(replica.getState().timeline.restoredFromDevice).toBeUndefined();
  expect(remoteSessionState(replica.getState(), 'catching_up').restoring).toBe(false);
});
```

Append to `packages/agent-remote-web/src/client/session-state.test.ts`:

```ts

it('is not restoring unless content came from the device and the connection has not caught up', () => {
  expect(remoteSessionState(undefined, 'connecting').restoring).toBe(false);
});
```

Create `packages/agent-remote-web/src/react/AgentActivityStatus.restoring.test.tsx`:

```tsx
import { expect, it } from 'vitest';
import { remoteSessionState } from '../client/session-state.js';
import { AgentReplica } from '../replica/store.js';
import { createReplicaState } from '../replica/reducer.js';
import { render } from '../test/setup.js';
import { AgentActivityStatus } from './AgentActivityStatus.js';

const stored = { epoch: 'e1', nextSeq: 2, hasOlder: false, entries: [], snapshot: {
  id: 'agent-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle' as const, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'native-1', status: 'idle' as const },
} };
const label = (container: HTMLElement) => container.querySelector('[data-testid="agent-activity-label"]')?.textContent;

it('says what the stored session last was, not that it is opening, while stored content is shown', async () => {
  const replica = new AgentReplica();
  replica.restoreFromDevice(stored, 'agent-1');
  const state = replica.getState();
  for (const connection of ['connecting', 'catching_up'] as const) {
    const container = await render(<AgentActivityStatus state={state} sessionState={remoteSessionState(state, connection)} disabled interruptDisabled interruptLabel="Stop" onInterrupt={() => {}} />);
    expect(label(container)).toBe('Ready');
    expect(container.querySelector('.agent-activity')?.getAttribute('data-connection-pending')).toBe('true');
  }
});

it('says Reconnecting for stored content when the socket closed: the disconnect is not hidden', async () => {
  const replica = new AgentReplica();
  replica.restoreFromDevice(stored, 'agent-1');
  const state = replica.getState();
  const container = await render(<AgentActivityStatus state={state} sessionState={remoteSessionState(state, 'disconnected')} disabled interruptDisabled interruptLabel="Stop" onInterrupt={() => {}} />);
  expect(label(container)).toBe('Reconnecting');
});

it('still says Opening session for a session without stored content', async () => {
  const state = { ...createReplicaState() };
  const container = await render(<AgentActivityStatus state={state} sessionState={remoteSessionState(state, 'connecting')} disabled interruptDisabled interruptLabel="Stop" onInterrupt={() => {}} />);
  expect(label(container)).toBe('Opening session');
});
```

Create `packages/agent-remote-web/src/react/AgentComposer.restoring.test.tsx`:

```tsx
import { expect, it, vi } from 'vitest';
import { remoteSessionState } from '../client/session-state.js';
import { AgentReplica } from '../replica/store.js';
import { render } from '../test/setup.js';
import { AgentComposer } from './AgentComposer.js';

const stored = { epoch: 'e1', nextSeq: 2, hasOlder: false, entries: [], snapshot: {
  id: 'agent-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle' as const, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'native-1', status: 'idle' as const },
} };

it('says what the session last was in the composer of a draft that is still opening while stored content is shown', async () => {
  const replica = new AgentReplica();
  replica.restoreFromDevice(stored, 'agent-1');
  const state = replica.getState();
  for (const connection of ['connecting', 'catching_up'] as const) {
    const container = await render(<AgentComposer state={state} sessionState={remoteSessionState(state, connection)} draftOnly draft="Local draft" onSendMessage={vi.fn()} />);
    expect(container.querySelector('[data-testid="agent-activity-label"]')?.textContent).toBe('Ready');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')?.value).toBe('Local draft');
  }
});
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `pnpm --filter @orchardworks/agent-remote-web exec vitest run src/replica/store.restore.test.ts src/client/session-state.test.ts src/react/AgentActivityStatus.restoring.test.tsx src/react/AgentComposer.restoring.test.tsx --testTimeout=10000` (Bash timeout 120000)
Expected: FAIL (`restoreFromDevice is not a function`).

- [ ] **Step 3: Add the state flag.**

In `packages/agent-remote-web/src/replica/types.ts`, inside `TimelineReplicaState`, add after `readonly pendingLive: readonly TimelineStreamMessage[];`:

```ts
  /** The entries came from this device's store and no page of this connection has confirmed them yet. */
  readonly restoredFromDevice?: true;
```

- [ ] **Step 4: Add `restoreFromDevice` to the replica.**

In `packages/agent-remote-web/src/replica/store.ts`, add after the imports:

```ts
import type { StoredSession } from '../session-record.js';
```

and add this method after `subscribeHistory`:

```ts
  /**
   * Shows what this device kept of the conversation until the Relay answers. Its cursor is the one a catch-up continues from, so
   * the client asks for what came after it. Does nothing when the replica already holds a conversation.
   */
  restoreFromDevice(stored: Pick<StoredSession, 'snapshot' | 'epoch' | 'nextSeq' | 'hasOlder' | 'entries'>, agentId: string): boolean {
    if (this.state.agent || this.state.timeline.initialized) return false;
    this.replace({
      ...this.state,
      agent: { ...structuredClone(stored.snapshot), id: agentId },
      timeline: { epoch: stored.epoch, initialized: true, entries: structuredClone([...stored.entries]), nextSeq: stored.nextSeq,
        hasOlder: stored.hasOlder, pendingLive: [], restoredFromDevice: true },
    });
    return true;
  }

  /** The connection is ready: what was stored is now confirmed content. */
  confirmRestored(): void {
    if (!this.state.timeline.restoredFromDevice) return;
    const { restoredFromDevice: _restored, ...timeline } = this.state.timeline;
    this.replace({ ...this.state, timeline });
  }
```

- [ ] **Step 5: Report restored content in the session state and use it for the activity label.**

In `packages/agent-remote-web/src/client/session-state.ts`, add to `RemoteSessionState` after `readonly recovering: boolean;`:

```ts
  /** Rows from this device's store are shown and this connection has not caught up yet: the connection is not news to the reader. */
  readonly restoring?: boolean;
```

and in `remoteSessionState`, add to the returned object after `busy: ...,`:

```ts
    restoring: replica?.timeline.restoredFromDevice === true && (connection === 'connecting' || connection === 'catching_up'),
```

In `packages/agent-remote-web/src/react/AgentActivityStatus.tsx`, replace

```ts
  const label = disabled ? disabledLabel ?? connectionLabel
```

with

```ts
  // Stored content is shown while the connection opens: say what the session last was, not that it is opening.
  const lastKnown = session.restoring === true && disabledLabel === undefined;
  const label = disabled && !lastKnown ? disabledLabel ?? connectionLabel
```

A composer of a draft that is still opening builds its status from a state without a conversation. In `packages/agent-remote-web/src/react/AgentComposer.tsx`, replace

```ts
  const activitySession = draftOnly ? remoteSessionState(undefined, session.connection === 'ready' ? 'connecting' : session.connection) : session;
```

with

```ts
  // A draft still opening has no live conversation; stored content shown above it keeps its last known state.
  const activitySession = draftOnly ? remoteSessionState(state?.timeline.restoredFromDevice ? state : undefined, session.connection === 'ready' ? 'connecting' : session.connection) : session;
```

- [ ] **Step 6: Run the tests to verify they pass.**

Run: `pnpm --filter @orchardworks/agent-remote-web exec vitest run src/replica src/client/session-state.test.ts src/react/AgentActivityStatus.restoring.test.tsx src/react/AgentComposer.restoring.test.tsx src/react/AgentComposer.test.tsx src/react/AgentComposer.pending.test.tsx src/react/AgentComposer.transport.test.tsx --testTimeout=10000` (Bash timeout 300000)
Expected: PASS, including the existing composer label tests, which use states without stored content.

- [ ] **Step 7: Commit.**

```bash
git add packages/agent-remote-web/src/replica/types.ts packages/agent-remote-web/src/replica/store.ts packages/agent-remote-web/src/client/session-state.ts packages/agent-remote-web/src/react/AgentActivityStatus.tsx packages/agent-remote-web/src/react/AgentComposer.tsx packages/agent-remote-web/src/replica/store.restore.test.ts packages/agent-remote-web/src/react/AgentActivityStatus.restoring.test.tsx packages/agent-remote-web/src/react/AgentComposer.restoring.test.tsx packages/agent-remote-web/src/client/session-state.test.ts
git commit -m "feat(web): restore a replica from the device store and say what it last was" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Catch-up from the stored cursor, the replacement and older history, with a fake transport

The client already asks for `after` the replica's cursor when the replica holds a timeline (`catchUpAfterSubscription`), and for `tail` otherwise. A restored replica therefore needs no client change for catch-up, and the first three tests below pin it.

Older history is different. `loadOlder`, the timeline search and the recovery loop read pages with `transport.fetchTimeline`, an HTTP request that the Relay forwards to the Controller (P1-B2 Decision 13 left those routes alone), even for a transport that recovers over the session wire. On a journal-served session every older page would therefore reach its Controller and need its Host online, which contradicts "the Host partition answers from the journal". This task reads every page through one method that follows the transport's recovery mode: the session wire when the transport offers it, HTTP otherwise.

**Files:**
- Modify: `packages/agent-remote-web/src/client/remote-session-client.ts`
- Modify: `packages/agent-remote-web/src/client/remote-session-client.test.ts`

- [ ] **Step 1: Write the tests.**

Append to the end of `packages/agent-remote-web/src/client/remote-session-client.test.ts`:

```ts

describe('RemoteSessionClient with a conversation restored from the device store', () => {
  function restored(entries: ProjectedTimelineEntry[], nextSeq: number, hasOlder: boolean, epoch = 'epoch-one', options: ConstructorParameters<typeof RemoteSessionClient>[3] = {}) {
    const transport = new FakeTransport();
    const replica = new AgentReplica();
    replica.restoreFromDevice({ snapshot: snapshot().payload, epoch, nextSeq, hasOlder, entries }, 'agent-one');
    const client = new RemoteSessionClient('agent-one', transport, replica, options);
    client.start(); transport.open();
    transport.emit({ protocolVersion: '1.8.0', type: 'negotiated' });
    transport.emit(snapshot());
    transport.emit({ protocolVersion: '1.8.0', type: 'timeline_subscribed', payload: { requestId: transport.sent[1]?.payload.requestId as string, agentIds: ['agent-one'] } });
    return { transport, replica, client };
  }

  it('asks for what came after its stored cursor on the same epoch, never for the tail, and shows the stored rows meanwhile', async () => {
    const { transport, replica, client } = restored([entry(1, 2, 'AB')], 3, true);
    expect(transport.timelineRequests).toEqual([{ direction: 'after', cursor: { epoch: 'epoch-one', seq: 2 } }]);
    expect(replica.getState().timeline.entries).toHaveLength(1);
    transport.resolveTimeline(page('after', [entry(3, 3, 'C')], { window: { minSeq: 1, maxSeq: 3, nextSeq: 4 }, hasOlder: true }));
    await transport.settle();
    expect(replica.getState().timeline.entries.map(item => item.seqStart)).toEqual([1, 3]);
    expect(replica.getState().timeline.restoredFromDevice).toBeUndefined();
    expect(client.getSessionState().connection).toBe('ready');
    expect(transport.timelineRequests.map(request => request.direction)).toEqual(['after']);
    client.stop();
  });

  it('fetches the tail of the same epoch when the first page after the stored cursor has more behind it, and keeps the rows that did not change', async () => {
    const { transport, replica, client } = restored([entry(1, 1, 'A'), entry(2, 2, 'B')], 3, false);
    const held = replica.getState().timeline.entries;
    transport.resolveTimeline(page('after', [entry(3, 3, 'C')], { hasNewer: true, window: { minSeq: 1, maxSeq: 400, nextSeq: 401 } }));
    await transport.settle();
    expect(transport.timelineRequests.map(request => request.direction)).toEqual(['after', 'tail']);
    expect(replica.getState().timeline.entries).toHaveLength(2);
    transport.resolveTimeline(page('tail', [entry(1, 1, 'A'), entry(2, 2, 'B'), entry(400, 400, 'Z')], { hasOlder: true, window: { minSeq: 1, maxSeq: 400, nextSeq: 401 } }));
    await transport.settle();
    expect(replica.getState().timeline.entries.map(item => item.seqStart)).toEqual([1, 2, 400]);
    expect(replica.getState().timeline.entries[0]).toBe(held[0]);
    expect(replica.getState().timeline.entries[1]).toBe(held[1]);
    expect(client.getSessionState().connection).toBe('ready');
    client.stop();
  });

  it('fetches the tail when the Relay cannot serve the run after the stored cursor, and never asks for that run again', async () => {
    const { transport, replica, client } = restored([entry(1, 1, 'A')], 2, false);
    transport.rejectTimeline(Object.assign(new Error('timeline_unavailable'), { code: 'timeline_unavailable' }));
    await transport.settle();
    expect(transport.timelineRequests.map(request => request.direction)).toEqual(['after', 'tail']);
    transport.resolveTimeline(page('tail', [entry(1, 1, 'A'), entry(9, 9, 'I')], { window: { minSeq: 1, maxSeq: 9, nextSeq: 10 } }));
    await transport.settle();
    expect(replica.getState().timeline.entries.map(item => item.seqStart)).toEqual([1, 9]);
    expect(client.getSessionState().connection).toBe('ready');
    expect(transport.timelineRequests.map(request => request.direction)).toEqual(['after', 'tail']);
    client.stop();
  });

  it('does not say Ready when the tail fails too, and does not keep asking', async () => {
    const { transport, client } = restored([entry(1, 1, 'A')], 2, false, 'epoch-one', { scheduleReconnect: () => () => {} });
    transport.rejectTimeline(new Error('timeline_unavailable'));
    await transport.settle();
    transport.rejectTimeline(new Error('timeline_unavailable'));
    await transport.settle();
    expect(client.getSessionState().connection).toBe('disconnected');
    expect(transport.timelineRequests.map(request => request.direction)).toEqual(['after', 'tail']);
    client.stop();
  });

  it('shows a disconnect before the first page: the stored rows stay, the connection is not hidden behind them', () => {
    const { transport, replica, client } = restored([entry(1, 1, 'A')], 2, false, 'epoch-one', { scheduleReconnect: () => () => {} });
    transport.disconnect();
    expect(client.getSessionState()).toMatchObject({ connection: 'disconnected', restoring: false });
    expect(replica.getState().timeline.entries).toHaveLength(1);
    client.stop();
  });

  it('follows the stale answer of a replaced epoch with the new tail and swaps the conversation then', async () => {
    const { transport, replica, client } = restored([entry(1, 2, 'AB')], 3, false, 'epoch-old');
    transport.resolveTimeline(page('after', [], { epoch: 'epoch-new', reset: true, staleCursor: true, error: 'Timeline cursor epoch was replaced.', window: { minSeq: 0, maxSeq: 0, nextSeq: 1 } }));
    await transport.settle();
    expect(transport.timelineRequests.map(request => request.direction)).toEqual(['after', 'tail']);
    transport.resolveTimeline(page('tail', [entry(1, 1, 'New')], { epoch: 'epoch-new', window: { minSeq: 1, maxSeq: 1, nextSeq: 2 } }));
    await transport.settle();
    expect(replica.getState().timeline).toMatchObject({ epoch: 'epoch-new', initialized: true, nextSeq: 2 });
    expect(replica.getState().timeline.entries.map(item => (item.item as { text: string }).text)).toEqual(['New']);
    expect(client.getSessionState().connection).toBe('ready');
    client.stop();
  });

  it('loads older history from the first entry it holds after a correction to an older item, so nothing in between is skipped', async () => {
    const { transport, replica, client } = restored([entry(10, 10, 'a'), entry(11, 11, 'b'), entry(12, 12, 'c')], 13, true);
    const corrected = { ...entry(4, 13, 'corrected'), sourceSeqRanges: [{ startSeq: 4, endSeq: 4 }, { startSeq: 13, endSeq: 13 }] };
    transport.resolveTimeline(page('after', [corrected, entry(14, 14, 'e')], { window: { minSeq: 1, maxSeq: 14, nextSeq: 15 }, hasOlder: true }));
    await transport.settle();
    expect(replica.getState().timeline.entries.map(item => item.seqStart)).toEqual([10, 11, 12, 14]);
    const older = client.loadOlder();
    expect(transport.timelineRequests.at(-1)).toEqual({ direction: 'before', cursor: { epoch: 'epoch-one', seq: 10 } });
    transport.resolveTimeline(page('before', [entry(8, 8, 'x'), entry(9, 9, 'y')], { hasOlder: false }));
    await older;
    expect(replica.getState().timeline.entries.map(item => item.seqStart)).toEqual([8, 9, 10, 11, 12, 14]);
    expect(replica.getState().timeline.hasOlder).toBe(false);
    client.stop();
  });
});

it('reads older history over the session wire when the transport recovers over it, never over HTTP', async () => {
  const transport = new FakeTransport();
  const replica = new AgentReplica();
  replica.restoreFromDevice({ snapshot: snapshot().payload, epoch: 'epoch-one', nextSeq: 11, hasOlder: true, entries: [entry(10, 10, 'a')] }, 'agent-one');
  const client = new RemoteSessionClient('agent-one', transport, replica, { timelineRecovery: 'websocket' });
  const requests = () => transport.sent.filter(message => message.type === 'timeline_request');
  try {
    client.start(); transport.open();
    transport.emit({ protocolVersion: '1.8.0', type: 'negotiated' });
    transport.emit(snapshot());
    const first = requests()[0]!;
    const subscription = transport.sent.find(message => message.type === 'timeline_subscription')!;
    if (first.type !== 'timeline_request' || subscription.type !== 'timeline_subscription') throw new Error('Missing recovery requests');
    transport.emit(page('after', [], { requestId: first.payload.requestId, hasOlder: true, window: { minSeq: 1, maxSeq: 10, nextSeq: 11 } }));
    transport.emit({ protocolVersion: '1.8.0', type: 'timeline_subscribed', payload: { requestId: subscription.payload.requestId, agentIds: ['agent-one'] } });
    await transport.settle();
    expect(client.getSessionState().connection).toBe('ready');
    const older = client.loadOlder();
    const request = requests().at(-1)!;
    if (request.type !== 'timeline_request') throw new Error('Missing older-history request');
    expect(request.payload).toMatchObject({ direction: 'before', cursor: { epoch: 'epoch-one', seq: 10 } });
    transport.emit(page('before', [entry(8, 8, 'x'), entry(9, 9, 'y')], { requestId: request.payload.requestId }));
    await older;
    expect(replica.getState().timeline.entries.map(item => item.seqStart)).toEqual([8, 9, 10]);
    expect(transport.timelineRequests).toHaveLength(0);
  } finally { client.stop(); }
});
```

- [ ] **Step 2: Run them to verify the new one fails.**

Run: `pnpm --filter @orchardworks/agent-remote-web exec vitest run src/client/remote-session-client.test.ts --testTimeout=10000` (Bash timeout 180000)
Expected: FAIL in `reads older history over the session wire ...` (`loadOlder` asks the transport over HTTP, so `transport.timelineRequests` has one entry and no `timeline_request` is sent) and in the three stale-cursor tests (the client asks for `after` only; on a `hasNewer` or failing answer it never fetches the tail, and the tail failing too must leave the connection not ready). The first catch-up test, the disconnect test, the replaced-epoch test and the hole test pass already; they pin behaviour.

- [ ] **Step 3: Read every page through one method.**

In `packages/agent-remote-web/src/client/remote-session-client.ts`:

Replace, in `searchTimeline`,

```ts
      fetchBefore: seq => this.transport.fetchTimeline(this.agentId, 'before', { epoch, seq }, this.historyPageSize, { signal: options.signal }),
```

with

```ts
      fetchBefore: seq => this.readTimeline('before', { epoch, seq }, options.signal ?? new AbortController().signal),
```

Replace, in `loadOlder`,

```ts
    const promise = this.transport.fetchTimeline(this.agentId, 'before', { epoch: state.epoch, seq: first?.seqStart ?? 1 }, this.historyPageSize, { signal: controller.signal }).then((page) => {
```

with

```ts
    const promise = this.readTimeline('before', { epoch: state.epoch, seq: first?.seqStart ?? 1 }, controller.signal).then((page) => {
```

Replace the opening of `fetchTimeline`

```ts
  private async fetchTimeline(
    generation: number,
    direction: TimelineDirection,
    cursor?: TimelineCursor,
  ): Promise<void> {
```

with

```ts
  /**
   * `restored` marks a cursor that came from this device's store. It may be too old to continue from: the Relay may answer with
   * a long run of newer rows (`hasNewer`) or be unable to serve the run (evicted bodies and an absent Controller answer
   * `timeline_unavailable`). The client then fetches the tail of the same epoch instead, which replaces the window with the same
   * rows where nothing changed, and never keeps asking for a run it cannot get.
   */
  private async fetchTimeline(
    generation: number,
    direction: TimelineDirection,
    cursor?: TimelineCursor,
    restored = false,
  ): Promise<void> {
```

and replace, in the body of `fetchTimeline`,

```ts
        const page = await (this.timelineRecovery === 'websocket'
          ? this.fetchSocketTimeline(direction, nextCursor, controller.signal)
          : this.transport.fetchTimeline(this.agentId, direction, nextCursor, this.historyPageSize, { signal: controller.signal }));
        if (generation !== this.generation || this.recovery !== controller) return;
```

with

```ts
        let page: HistoryPage;
        try { page = await this.readTimeline(direction, nextCursor, controller.signal); }
        catch (error) {
          if (generation !== this.generation || this.recovery !== controller || !restored || direction !== 'after') throw error;
          restored = false; direction = 'tail'; nextCursor = undefined;
          continue;
        }
        if (generation !== this.generation || this.recovery !== controller) return;
        if (restored && direction === 'after' && page.payload.hasNewer && page.payload.epoch === nextCursor?.epoch) {
          restored = false; direction = 'tail'; nextCursor = undefined;
          continue;
        }
        restored = false;
```

and, in `setStatus`, replace

```ts
    if (status === this.currentStatus) return;
    this.currentStatus = status;
```

with

```ts
    if (status === this.currentStatus) return;
    this.currentStatus = status;
    if (status === 'ready') this.replica.confirmRestored();
```

and, in `catchUpAfterSubscription`, replace

```ts
      void this.fetchTimeline(generation, 'after', { epoch: timeline.epoch, seq: timeline.nextSeq - 1 });
```

with

```ts
      void this.fetchTimeline(generation, 'after', { epoch: timeline.epoch, seq: timeline.nextSeq - 1 }, timeline.restoredFromDevice === true);
```

and add this method directly above `private async fetchSocketTimeline(`:

```ts
  /** Pages travel the way recovery does: over the session wire when the transport offers it, so a journal-served session never reaches its Controller for history. */
  private readTimeline(direction: TimelineDirection, cursor: TimelineCursor | undefined, signal: AbortSignal): Promise<HistoryPage> {
    return this.timelineRecovery === 'websocket'
      ? this.fetchSocketTimeline(direction, cursor, signal)
      : this.transport.fetchTimeline(this.agentId, direction, cursor, this.historyPageSize, { signal });
  }
```

- [ ] **Step 4: Run the client suites.**

Run: `pnpm --filter @orchardworks/agent-remote-web exec vitest run src/client --testTimeout=10000` (Bash timeout 300000)
Expected: PASS, including the 8 tests of this task and every existing recovery, older-page and search test (HTTP and session-wire recovery).

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-web/src/client/remote-session-client.ts packages/agent-remote-web/src/client/remote-session-client.test.ts
git commit -m "feat(web): read older history over the session wire and pin the catch-up from the device store" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6a: Search over the session wire has its own admission budget

The Relay refuses a browser stream that sends more than 120 non-resource messages in a minute and closes it with 1008, permanently (the client does not reconnect from a 1008). Task 6 moves `loadOlder`, the timeline search and recovery onto the session wire, and a search through a long session reads one page per request. Without a budget of their own those reads would trip the control-message limit. `timeline_request` is a read and gets 600 per minute, on the crude and the journal-served path alike, because both call `admitClientMessages`.

**Files:**
- Modify: `packages/agent-remote-hosted/src/broker.ts`
- Create: `packages/agent-remote-hosted/src/broker-timeline-admission.test.ts`

- [ ] **Step 1: Write the failing test.**

Create `packages/agent-remote-hosted/src/broker-timeline-admission.test.ts`:

```ts
import { expect, it } from 'vitest';
import { PUBLIC_ID, seedJournal, startRelay, until } from './test-utils/journal-session-fixture.js';

const timelineRequest = (number: number) => ({ type: 'timeline_request', payload: { requestId: `read-${number}`, agentId: PUBLIC_ID, direction: 'tail', limit: 1 } });

it('does not close a stream that reads many pages, as a search through a long session does', async () => {
  const r = await startRelay({ seed: store => seedJournal(store) });
  try {
    const browser = await r.openBrowser();
    browser.send({ type: 'negotiate' });
    await browser.take(frame => frame.type === 'negotiated', 'negotiated');
    for (let number = 0; number < 300; number++) browser.send(timelineRequest(number));
    await browser.take(frame => frame.type === 'timeline_page' && frame.payload.requestId === 'read-299', 'the last page');
    expect(browser.pair.native.readyState).toBe(1);
  } finally { await r.dispose(); }
});

it('still closes a stream that floods timeline requests', async () => {
  const r = await startRelay({ seed: store => seedJournal(store) });
  try {
    const browser = await r.openBrowser();
    browser.send({ type: 'negotiate' });
    await browser.take(frame => frame.type === 'negotiated', 'negotiated');
    for (let number = 0; number < 650; number++) browser.send(timelineRequest(number));
    await until(() => browser.pair.native.readyState === 3 ? true : undefined, 'the stream to close');
    expect(browser.pair.native.closeCode).toBe(1008);
  } finally { await r.dispose(); }
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/broker-timeline-admission.test.ts --testTimeout=20000` (Bash timeout 120000)
Expected: FAIL in the first test: the stream closes with 1008 after 120 requests. The second passes already.

- [ ] **Step 3: Give timeline reads their own budget.**

In `packages/agent-remote-hosted/src/broker.ts`, in `admitClientMessages`, replace

```ts
    let messageWindow = now(); let messageCount = 0; let imageChunkCount = 0;
```

with

```ts
    let messageWindow = now(); let messageCount = 0; let timelineCount = 0; let imageChunkCount = 0;
```

replace

```ts
messageWindow=now(); messageCount=0; imageChunkCount=0;
```

with

```ts
messageWindow=now(); messageCount=0; timelineCount=0; imageChunkCount=0;
```

and replace

```ts
      } else if (++messageCount > 120) return refuse(1008, 'Control message rate exceeded');
```

with

```ts
      } else if (publicMessage?.type === 'timeline_request') {
        // Search and reading older history take one page per request over the session wire; they are reads, not control messages.
        if (++timelineCount > 600) return refuse(1008, 'Timeline request rate exceeded');
      } else if (++messageCount > 120) return refuse(1008, 'Control message rate exceeded');
```

- [ ] **Step 4: Run the test and the hosted suite.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/broker-timeline-admission.test.ts src/broker-journal-sessions.test.ts src/broker.test.ts --testTimeout=20000` (Bash timeout 300000)
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-hosted/src/broker.ts packages/agent-remote-hosted/src/broker-timeline-admission.test.ts
git commit -m "feat(hosted): give timeline reads their own admission budget" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Build the web package, move the lab test that pinned the HTTP route, and run the web suite

**Files:**
- Modify: `packages/agent-remote-lab/src/App.succession.test.tsx`

- [ ] **Step 1: Typecheck and build the web package.**

Run: `pnpm --filter @orchardworks/agent-remote-web run typecheck && pnpm --filter @orchardworks/agent-remote-web run build` (Bash timeout 300000)
Expected: exit code 0 for both. The lab tests of the next tasks import this build.

- [ ] **Step 2: Move the one lab test that asserted the HTTP route for older history.**

In `packages/agent-remote-lab/src/App.succession.test.tsx`, in the test `keeps A outbox, question drafts and reading cursor concrete through B confirmation and explicit A history`, replace

```ts
  expect(operations.map(frame => [frame.message?.type, frame.message?.payload?.agentId])).toEqual([
    ['send_message', 'agent-A'], ['interaction_response', 'agent-A'],
  ]);
  const older = new URL(f.requests.filter(item => item.url.includes('/timeline?')).at(-1)!.url, f.scope);
  expect(older.pathname).toContain('/agent-A/timeline');
  expect(older.searchParams.get('direction')).toBe('before');
  expect(older.searchParams.get('epoch')).toBe('epoch-agent-A');
  expect(older.searchParams.get('seq')).toBe('1');
```

with

```ts
  // Older history is read over the session wire, as recovery is, never through the HTTP timeline route.
  expect(operations.map(frame => [frame.message?.type, frame.message?.payload?.agentId])).toEqual([
    ['send_message', 'agent-A'], ['interaction_response', 'agent-A'], ['timeline_request', 'agent-A'],
  ]);
  expect(operations.at(-1)!.message!.payload).toMatchObject({ direction: 'before', cursor: { epoch: 'epoch-agent-A', seq: 1 } });
  expect(f.requests.filter(item => item.url.includes('/timeline?') && item.url.includes('direction=before'))).toEqual([]);
```

- [ ] **Step 3: Run that suite.**

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/App.succession.test.tsx --testTimeout=30000 --maxWorkers=50%` (Bash timeout 600000)
Expected: PASS, 163 tests. Before Step 2 one test fails on the extra `timeline_request` frame.

- [ ] **Step 4: Run the whole web suite.**

Run: `pnpm --filter @orchardworks/agent-remote-web exec vitest run --testTimeout=10000` (Bash timeout 600000)
Expected: PASS. If the outer deadline is hit, run `src/react` and the rest separately instead of raising it: `... vitest run src/react --testTimeout=10000`, then `... vitest run src/client src/replica src/*.test.ts --testTimeout=10000`.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-lab/src/App.succession.test.tsx
git commit -m "test(lab): older history is read over the session wire" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: The lab's display cache over the device store

`readWorkspaceSnapshot` and `saveWorkspaceSnapshot` keep their signatures and their synchronous behaviour, so every caller and the many tests that save a snapshot and read it back stay as they are. Only the storage underneath changes: the six-session localStorage preview becomes the device store.

**Files:**
- Modify: `packages/agent-remote-lab/src/workspace-cache.ts` (rewrite)
- Modify: `packages/agent-remote-lab/src/workspace-cache.test.ts` (rewrite)
- Modify: `packages/agent-remote-lab/src/conversation-recovery.tsx`

- [ ] **Step 1: Write the failing tests.**

Replace the whole content of `packages/agent-remote-lab/src/workspace-cache.test.ts` with:

```ts
import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { AgentReplica } from '@orchardworks/agent-remote-web';
import { deviceStore } from '@orchardworks/agent-remote-web/device-store';
import { readWorkspaceSnapshot, restoreWorkspaceReplica, saveWorkspaceSnapshot, workspaceDisplayState } from './workspace-cache.js';
import { replicaState } from './test/fixtures.js';
import { clearConversationRecovery } from './conversation-recovery.js';

const scope = 'https://agents.example/u/alice/';
const target = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'recorded-session', agentId: 'agent-1' };
const reply = (seq: number, text = `Reply ${seq}`) => ({ providerId: 'recorded', seqStart: seq, seqEnd: seq, timestamp: '2026-11-15T00:00:00.000Z',
  sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [], resources: [], item: { type: 'assistant_message' as const, text, messageId: `m${seq}` } });
const withReplies = (count: number) => ({ ...replicaState, timeline: { ...replicaState.timeline, epoch: 'epoch-1', nextSeq: count + 1, hasOlder: true,
  entries: Array.from({ length: count }, (_, index) => reply(index + 1)) } });
const otherSession = (nativeSessionId: string) => ({ ...replicaState,
  agent: { ...replicaState.agent!, runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: nativeSessionId } } });

it('restores only display data for the exact account and native session', () => {
  saveWorkspaceSnapshot(scope, target, replicaState);
  expect(readWorkspaceSnapshot(scope, target)?.agent?.id).toBe('agent-1');
  expect(readWorkspaceSnapshot(scope, { ...target, hostId: 'other' })).toBeUndefined();
  expect(readWorkspaceSnapshot(scope + 'other', target)).toBeUndefined();
  clearConversationRecovery(scope);
  expect(readWorkspaceSnapshot(scope, target)).toBeUndefined();
});

it('does not restore pending actions, resources or delivery state from display storage', () => {
  saveWorkspaceSnapshot(scope, target, { ...replicaState, outgoingMessages: [{ id: 'out', agentId: 'agent-1', text: 'no replay', status: 'sending', epoch: null, afterSeq: 0 }], resources: { secret: {} as never } });
  const restored = readWorkspaceSnapshot(scope, target)!;
  expect(restored.outgoingMessages).toEqual([]);
  expect(restored.pendingInteractions).toEqual([]);
  expect(restored.resources).toEqual({});
  expect(restored.timeline.entries).toEqual(replicaState.timeline.entries);
});

it('never labels a different native session or provider snapshot as the requested display', () => {
  saveWorkspaceSnapshot(scope, target, otherSession('other'));
  expect(readWorkspaceSnapshot(scope, target)).toBeUndefined();
  saveWorkspaceSnapshot(scope, target, { ...replicaState, agent: { ...replicaState.agent!, runtimeInfo: { ...replicaState.agent!.runtimeInfo, providerId: 'codex' } } });
  expect(readWorkspaceSnapshot(scope, target)).toBeUndefined();
});

it('keeps preview content without carrying live control authority or recovery cursors', () => {
  const live = { ...replicaState, resources: { picture: { status: 'available' as const, sha256: 'a'.repeat(64), mediaType: 'image/png', byteLength: 5, contentBase64: 'aW1hZ2U=' } }, sessionControl: { access: 'control' as const, available: true },
    outgoingMessages: [{ id: 'out', agentId: 'agent-1', text: 'no replay', status: 'sending' as const, epoch: null, afterSeq: 0 }] };
  const display = workspaceDisplayState(live);
  expect(display.timeline.entries).toBe(live.timeline.entries);
  expect(display.timeline.nextSeq).toBe(0);
  expect(display.sessionControl).toBeUndefined();
  expect(display.outgoingMessages).toEqual([]);
  expect(display.pendingInteractions).toEqual([]);
  expect(display.resources).toBe(live.resources);
  expect(workspaceDisplayState(live)).toBe(display);
});

it('shows a preview marked as stored content, with no cursor and no older history to load', () => {
  saveWorkspaceSnapshot(scope, target, withReplies(3));
  const preview = readWorkspaceSnapshot(scope, target)!;
  expect(preview.timeline).toMatchObject({ initialized: true, nextSeq: 0, hasOlder: false, restoredFromDevice: true });
  expect(preview.timeline.entries).toHaveLength(3);
});

it('does not let a delayed older writer replace newer content in the same epoch', () => {
  const newer = { ...replicaState, timeline: { ...replicaState.timeline, nextSeq: 21, entries: [reply(20, 'Latest visible content')] } };
  saveWorkspaceSnapshot(scope, target, newer);
  saveWorkspaceSnapshot(scope, target, replicaState);
  expect(readWorkspaceSnapshot(scope, target)?.timeline.entries).toEqual(newer.timeline.entries);
  saveWorkspaceSnapshot(scope, target, { ...replicaState, timeline: { ...replicaState.timeline, epoch: 'replacement-epoch' } });
  expect(readWorkspaceSnapshot(scope, target)?.timeline.epoch).toBe('replacement-epoch');
});

it('never saves a display-only preview over an observed snapshot', () => {
  saveWorkspaceSnapshot(scope, target, replicaState);
  const saved = readWorkspaceSnapshot(scope, target);
  saveWorkspaceSnapshot(scope, target, workspaceDisplayState(replicaState));
  expect(readWorkspaceSnapshot(scope, target)).toEqual(saved);
});

it('seeds a new replica with the stored conversation, its epoch and its cursor, as the session it is now attached as', () => {
  saveWorkspaceSnapshot(scope, target, withReplies(3));
  const replica = new AgentReplica();
  restoreWorkspaceReplica(scope, target, replica, 'agent-7');
  expect(replica.getState().agent?.id).toBe('agent-7');
  expect(replica.getState().timeline).toMatchObject({ epoch: 'epoch-1', initialized: true, nextSeq: 4, hasOlder: true, restoredFromDevice: true });
  expect(replica.getState().timeline.entries.map(entry => entry.seqStart)).toEqual([1, 2, 3]);
});

it('does not seed a replica for another session, or one that already holds a conversation', () => {
  saveWorkspaceSnapshot(scope, target, withReplies(2));
  const other = new AgentReplica();
  restoreWorkspaceReplica(scope, { ...target, nativeSessionId: 'other' }, other, 'agent-9');
  expect(other.getState().agent).toBeNull();
  const live = new AgentReplica();
  live.applySnapshot({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: { ...replicaState.agent!, id: 'agent-live' } });
  restoreWorkspaceReplica(scope, target, live, 'agent-live');
  expect(live.getState().timeline.initialized).toBe(false);
});

it('seeds a conversation the page did not preload as soon as its record is read from disk', async () => {
  saveWorkspaceSnapshot(scope, target, withReplies(2));
  await deviceStore.flush();
  deviceStore.unload();
  const replica = new AgentReplica();
  restoreWorkspaceReplica(scope, target, replica, 'agent-1');
  expect(replica.getState().agent).toBeNull();
  await vi.waitFor(() => expect(replica.getState().timeline.restoredFromDevice).toBe(true));
  expect(replica.getState().timeline.entries).toHaveLength(2);
});
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/workspace-cache.test.ts --testTimeout=15000` (Bash timeout 180000)
Expected: FAIL: the web build from Task 7 exports the device store, but `restoreWorkspaceReplica` is not exported by `workspace-cache.ts` yet and the preview is not marked.

- [ ] **Step 3: Rewrite the cache over the device store.**

Replace the whole content of `packages/agent-remote-lab/src/workspace-cache.ts` with:

```ts
import { configureDeviceStorePersistence, deviceStore, type StoredSession } from '@orchardworks/agent-remote-web/device-store';
import { onRecoveryCleared } from './conversation-recovery.js';
import { clearCacheOnClose } from './conversation-storage.js';
import type { AgentReplica, AgentReplicaState } from '@orchardworks/agent-remote-web';
import type { ControllerLocation } from '@orchardworks/agent-remote-hosted/controller-location';

const identity = (target: ControllerLocation) => JSON.stringify([target.hostId ?? 'local', target.providerId, target.nativeSessionId]);

// Content stays off disk while Clear cache on close is on, and goes with the other conversation caches at sign-out.
configureDeviceStorePersistence(() => !clearCacheOnClose());
onRecoveryCleared(scope => { void deviceStore.clear(scope).catch(() => undefined); });

const displayStates = new WeakMap<AgentReplicaState, AgentReplicaState>();
/** Display data cannot authorize operations, revive interactions, or seed a recovery cursor. */
export function workspaceDisplayState(state: AgentReplicaState): AgentReplicaState {
  const previous = displayStates.get(state);
  if (previous) return previous;
  const display: AgentReplicaState = { agent: state.agent && { ...state.agent, activeTurn: null, pendingInteractions: [] },
    timeline: { ...state.timeline, nextSeq: 0, hasOlder: false, pendingLive: [] },
    pendingInteractions: [], interactionRevision: 0, interactionChanges: {}, resources: state.resources, diagnostics: [], retiredEpochs: [], outgoingMessages: [],
  };
  displayStates.set(state, display);
  return display;
}

/** Only observed history can replace a display snapshot; projected previews have no live cursor. */
export function isWorkspaceSnapshotSource(target: ControllerLocation, state: AgentReplicaState): state is AgentReplicaState & { agent: NonNullable<AgentReplicaState['agent']> } {
  return !!state.agent && state.timeline.initialized && !!target.nativeSessionId && !!state.timeline.epoch
    && Number.isSafeInteger(state.timeline.nextSeq) && state.timeline.nextSeq > 0
    && state.agent.providerId === target.providerId && state.agent.runtimeInfo.providerId === target.providerId
    && state.agent.runtimeInfo.sessionId === target.nativeSessionId;
}

/** What this device kept of this exact native session; never a record that names another session or provider. */
function storedFor(scope: string, target: ControllerLocation | undefined): StoredSession | undefined {
  if (!target?.nativeSessionId) return undefined;
  const stored = deviceStore.peek(scope, identity(target));
  const runtime = stored?.snapshot.runtimeInfo;
  return stored && runtime?.sessionId === target.nativeSessionId && stored.snapshot.providerId === target.providerId && runtime.providerId === target.providerId
    ? stored : undefined;
}

/** Keeps what an account's page observed of a session. It never seeds an outbox, and it is written behind (see the device store). */
export function saveWorkspaceSnapshot(scope: string, target: ControllerLocation, state: AgentReplicaState): void {
  if (!isWorkspaceSnapshotSource(target, state)) return;
  const held = deviceStore.peek(scope, identity(target));
  // Multiple pages may observe the same session at different speeds. Sequence order is scoped to an epoch.
  if (held && held.epoch === state.timeline.epoch && held.nextSeq > state.timeline.nextSeq) return;
  deviceStore.save(scope, identity(target), { agentId: state.agent.id, epoch: state.timeline.epoch!, nextSeq: state.timeline.nextSeq,
    hasOlder: state.timeline.hasOlder, entries: state.timeline.entries, snapshot: state.agent });
}

/** What a view shows before its session is attached: the stored rows, marked as stored, with no cursor and no older history to load. */
export function readWorkspaceSnapshot(scope: string, target?: ControllerLocation): AgentReplicaState | undefined {
  const stored = storedFor(scope, target);
  if (!stored) return undefined;
  return { agent: { ...stored.snapshot, activeTurn: null, pendingInteractions: [] },
    timeline: { epoch: stored.epoch, initialized: true, entries: stored.entries, nextSeq: 0, hasOlder: false, pendingLive: [], restoredFromDevice: true },
    pendingInteractions: [], interactionRevision: 0, interactionChanges: {}, resources: {}, diagnostics: [], retiredEpochs: [], outgoingMessages: [],
  };
}

/**
 * Seeds the replica of a conversation that is about to connect with what this device kept of it, so the client continues from the
 * stored cursor. A conversation the page did not preload is read from disk and seeded when that completes, unless the connection
 * has delivered content by then.
 */
export function restoreWorkspaceReplica(scope: string, target: ControllerLocation, replica: AgentReplica, agentId: string): void {
  const stored = storedFor(scope, target);
  if (stored) { replica.restoreFromDevice(stored, agentId); return; }
  void deviceStore.load(scope, identity(target)).then(() => {
    const late = storedFor(scope, target);
    if (late) replica.restoreFromDevice(late, agentId);
  }).catch(() => undefined);
}

/** Reads a conversation the page did not preload from disk; true when this device holds it afterwards. */
export async function loadWorkspaceSnapshot(scope: string, target: ControllerLocation): Promise<boolean> {
  if (!target.nativeSessionId) return false;
  await deviceStore.load(scope, identity(target));
  return storedFor(scope, target) !== undefined;
}

/** Removes what this device kept of a session, for a reader who may no longer see it. */
export function forgetWorkspaceSession(scope: string, target: ControllerLocation): void {
  void deviceStore.forget(scope, identity(target)).catch(() => undefined);
}

/** A session that a connection holds is never evicted from the device store. */
export function pinWorkspaceSession(scope: string, target: ControllerLocation): () => void {
  return deviceStore.pin(scope, identity(target));
}
```

- [ ] **Step 4: Let sign-out reach the store without loading it.**

`conversation-recovery.tsx` is imported by the sign-in entry, which must not carry the store or its codec. It keeps a registry instead. In `packages/agent-remote-lab/src/conversation-recovery.tsx`, add above `export function clearConversationRecovery`:

```ts
const recoveryClearers = new Set<(scope?: string) => void>();
/** Lets a module that holds conversation content drop it when recovery data is cleared, without this module importing it. */
export function onRecoveryCleared(clear: (scope?: string) => void): void { recoveryClearers.add(clear); }
```

and in `clearConversationRecovery`, replace

```ts
  if (scope) void clearImageDraftScope(scope).catch(() => { /* Signout still completes when browser storage is unavailable. */ });
```

with

```ts
  if (scope) void clearImageDraftScope(scope).catch(() => { /* Signout still completes when browser storage is unavailable. */ });
  // The device store is cleared through its registered clearer once it is loaded, and loaded on demand otherwise.
  if (recoveryClearers.size) for (const clear of recoveryClearers) clear(scope);
  else void import('@orchardworks/agent-remote-web/device-store').then(module => module.deviceStore.clear(scope)).catch(() => { /* Signout still completes when browser storage is unavailable. */ });
```

- [ ] **Step 5: Run the tests to verify they pass.**

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/workspace-cache.test.ts src/conversation-recovery.test.ts src/components/SessionFamily.test.tsx src/App.attributions.test.tsx src/App.window-retention.test.tsx src/App.succession.test.tsx --testTimeout=15000` (Bash timeout 600000)
Expected: PASS. The other suites save a snapshot and read it back through the same two functions, now over the store's memory copy.

- [ ] **Step 6: Commit.**

```bash
git add packages/agent-remote-lab/src/workspace-cache.ts packages/agent-remote-lab/src/workspace-cache.test.ts packages/agent-remote-lab/src/conversation-recovery.tsx
git commit -m "feat(lab): keep the conversation display cache in the device store" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Persist, seed, pin, clear and preload

**Files:**
- Modify: `packages/agent-remote-lab/src/workspace-display-cache.ts`
- Modify: `packages/agent-remote-lab/src/workspace-display-cache.test.ts`
- Modify: `packages/agent-remote-lab/src/conversation-connections.ts`
- Modify: `packages/agent-remote-lab/src/conversation-storage.ts`
- Modify: `packages/agent-remote-lab/src/main.tsx`

- [ ] **Step 1: Update and add tests.**

In `packages/agent-remote-lab/src/workspace-display-cache.test.ts`:

Replace the import line `import { conversationLocalStorage } from './conversation-storage.js';` with

```ts
import { deviceStore } from '@orchardworks/agent-remote-web/device-store';
```

In the test `keeps caching a retained session after its last view closes and shares one writer across views`, replace

```ts
  const write = vi.spyOn(conversationLocalStorage, 'setItem');
```

with

```ts
  const write = vi.spyOn(deviceStore, 'save');
```

and replace

```ts
  expect(write.mock.calls.filter(([key]) => key.includes(':workspace:'))).toHaveLength(1);
```

with

```ts
  expect(write).toHaveBeenCalledTimes(1);
```

Append at the end of the file:

```ts

it('seeds the replica of a new connection from the device store, so it continues from the stored cursor', () => {
  const observed = new AgentReplica();
  update(observed, 'Stored reply', 4);
  saveWorkspaceSnapshot(scope, target, observed.getState());
  const pool = new ConversationConnections(transport, scope); connections.push(pool);
  const replica = new AgentReplica();
  pool.acquire('agent-1', replica, target);
  expect(replica.getState().timeline).toMatchObject({ epoch: 'epoch', initialized: true, nextSeq: 5, restoredFromDevice: true });
  expect(replica.getState().agent?.id).toBe('agent-1');
});

it('does not save restored content again before a page of this connection confirms it', async () => {
  vi.useFakeTimers();
  const observed = new AgentReplica();
  update(observed, 'Stored reply', 4);
  saveWorkspaceSnapshot(scope, target, observed.getState());
  const pool = new ConversationConnections(transport, scope); connections.push(pool);
  pool.acquire('agent-1', new AgentReplica(), target);
  const write = vi.spyOn(deviceStore, 'save');
  await vi.advanceTimersByTimeAsync(2100);
  window.dispatchEvent(new Event('pagehide'));
  expect(write).not.toHaveBeenCalled();
});

it('pins the stored session for as long as its connection exists', () => {
  const release = vi.fn();
  const pin = vi.spyOn(deviceStore, 'pin').mockReturnValue(release);
  const pool = new ConversationConnections(transport, scope); connections.push(pool);
  pool.acquire('agent-1', new AgentReplica(), target);
  expect(pin).toHaveBeenCalledWith(scope, JSON.stringify(['host', 'recorded', 'recorded-session']));
  expect(release).not.toHaveBeenCalled();
  pool.clear();
  expect(release).toHaveBeenCalledTimes(1);
});
```

The file's `afterEach` restores real timers, closes every pool and clears the recovery data, so these tests need no cleanup of their own.

- [ ] **Step 2: Run them to verify they fail.**

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/workspace-display-cache.test.ts --testTimeout=15000` (Bash timeout 180000)
Expected: FAIL: the new connection's replica is not seeded, `pin` is never called, and the shared-writer test saw one `save` plus the restored save.

- [ ] **Step 3: Pin and skip unconfirmed content in the display observer.**

Replace the whole content of `packages/agent-remote-lab/src/workspace-display-cache.ts` with:

```ts
import type { AgentReplica, AgentReplicaState } from '@orchardworks/agent-remote-web';
import type { ControllerLocation } from '@orchardworks/agent-remote-hosted/controller-location';
import { recoveryGeneration } from './conversation-recovery.js';
import { isWorkspaceSnapshotSource, pinWorkspaceSession, saveWorkspaceSnapshot } from './workspace-cache.js';

/** A shared session owns its display persistence, independently of views and control readiness. */
export function observeWorkspaceDisplay(scope: string, target: ControllerLocation, replica: AgentReplica): () => void {
  const generation = recoveryGeneration(scope);
  // A conversation a connection holds is never evicted from the device store.
  const unpin = pinWorkspaceSession(scope, target);
  let latest: AgentReplicaState | undefined, dirty = false, timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer); timer = undefined;
    if (dirty && latest && recoveryGeneration(scope) === generation) {
      dirty = false;
      saveWorkspaceSnapshot(scope, target, latest);
    }
  };
  const observe = () => {
    if (recoveryGeneration(scope) !== generation) return;
    const state = replica.getState();
    // Only what this page observed is saved: content restored from the store has not been confirmed by a page of this connection.
    if (!isWorkspaceSnapshotSource(target, state) || state.timeline.restoredFromDevice || state.agent === latest?.agent && state.timeline === latest?.timeline) return;
    // Incomplete replacement history must not discard the last display that was actually observed.
    latest = state; dirty = true;
    timer ??= setTimeout(flush, 2000);
  };
  const hide = () => { if (document.visibilityState === 'hidden') flush(); };
  const stop = replica.subscribe(observe);
  observe();
  if (typeof window !== 'undefined') window.addEventListener('pagehide', flush);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', hide);
  return () => {
    stop(); flush(); clearTimeout(timer); unpin();
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', flush);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', hide);
  };
}
```

- [ ] **Step 4: Seed new connections.**

In `packages/agent-remote-lab/src/conversation-connections.ts`, change

```ts
import { observeWorkspaceDisplay } from './workspace-display-cache.js';
```

to

```ts
import { observeWorkspaceDisplay } from './workspace-display-cache.js';
import { restoreWorkspaceReplica } from './workspace-cache.js';
```

and in `acquire`, replace

```ts
      const key = session ? sessionKey(session) : undefined;
      connection = { agentId, key, ...(session ? { session } : {}), replica, viewers: 0, shown: false,
```

with

```ts
      const key = session ? sessionKey(session) : undefined;
      // What this device kept of the conversation is shown now, and the client continues from its cursor.
      if (this.recoveryScope && session) restoreWorkspaceReplica(this.recoveryScope, session, replica, agentId);
      connection = { agentId, key, ...(session ? { session } : {}), replica, viewers: 0, shown: false,
```

- [ ] **Step 5: Follow Clear cache on close.**

The persistence policy is configured where the store is used (`workspace-cache.ts`, Task 8). `conversation-storage.ts` is in the sign-in entry, so it reaches the store only through a dynamic import. In `clearDiskCopies`, replace

```ts
  const current = Promise.race([clearPersistedImageDrafts(), timeout]).catch(() => { failed = true; }).then(() => {
```

with

```ts
  const current = Promise.race([Promise.all([clearPersistedImageDrafts(), import('@orchardworks/agent-remote-web/device-store').then(module => module.clearPersistedDeviceStore())]).then(() => undefined), timeout]).catch(() => { failed = true; }).then(() => {
```

- [ ] **Step 6: Preload before the application chunk renders.**

In `packages/agent-remote-lab/src/main.tsx`, replace

```ts
const loadApp = () => import('./App.js').then(module => ({ default: module.App }));
```

with

```ts
// The device store is read while the application chunk loads, so the first render of the application finds the conversations this
// device kept. It is a dynamic import: the entry chunk does not carry the store, and the application chunk shares it.
const devicePreload = import('@orchardworks/agent-remote-web/device-store').then(module => module.preloadDeviceStore()).catch(() => undefined);
const loadApp = () => Promise.all([import('./App.js'), devicePreload]).then(([module]) => ({ default: module.App }));
```

- [ ] **Step 7: Run the tests, then the cache and recovery suites.**

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/workspace-display-cache.test.ts src/workspace-cache.test.ts src/conversation-connections.test.ts src/conversation-connections.window.test.ts src/conversation-recovery.test.ts src/replica-cache.test.ts src/storage-keys.test.ts --testTimeout=15000` (Bash timeout 300000)
Expected: PASS.

- [ ] **Step 8: Build the lab with its bundle budget.**

The store and its codec must be in the `App` chunk, never in the sign-in entry (budget 70,000 bytes gzip; 63,666 before this plan).

Run: `pnpm --filter @orchardworks/agent-remote-web run build && pnpm --filter @orchardworks/agent-remote-lab run build` (Bash timeout 600000)
Expected: exit code 0. The bundle-budget plugin fails the build when the entry or the `App` chunk is over its gzip budget and names the chunk. If it names the entry, something the entry imports reaches `device-store`; only `main.tsx`, `conversation-recovery.tsx` and `conversation-storage.ts` may name it, and each does so with a dynamic `import()`.

- [ ] **Step 9: Commit.**

```bash
git add packages/agent-remote-lab/src/workspace-display-cache.ts packages/agent-remote-lab/src/workspace-display-cache.test.ts packages/agent-remote-lab/src/conversation-connections.ts packages/agent-remote-lab/src/conversation-storage.ts packages/agent-remote-lab/src/main.tsx
git commit -m "feat(lab): persist, seed, pin and preload conversations through the device store" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: No opening label while stored content is shown (T1), counted by states

**Files:**
- Modify: `packages/agent-remote-lab/src/components/SessionWorkbench.tsx`
- Create: `packages/agent-remote-lab/src/components/LabWorkbench.restored.test.tsx`
- Create: `packages/agent-remote-lab/src/components/SessionConversation.device-store.test.tsx`

- [ ] **Step 1: Write the failing tests.**

Create `packages/agent-remote-lab/src/components/LabWorkbench.restored.test.tsx`:

```tsx
import { expect, it } from 'vitest';
import type { AgentReplicaState } from '@orchardworks/agent-remote-web';
import { replicaState } from '../test/fixtures.js';
import { render } from '../test/setup.js';
import { LabWorkbench } from './LabWorkbench.js';

const reply = { providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: '2026-11-15T00:00:00Z', sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], collapsed: [], resources: [],
  item: { type: 'assistant_message' as const, text: 'Stored reply', messageId: 'm1' } };
const timeline = { ...replicaState.timeline, entries: [reply], hasOlder: false };
const restored: AgentReplicaState = { ...replicaState, timeline: { ...timeline, restoredFromDevice: true } };
const observed: AgentReplicaState = { ...replicaState, timeline };
const status = (container: HTMLElement) => container.querySelector('.lab-conversation-status')?.textContent;
const composer = (container: HTMLElement) => container.querySelector('[data-testid="agent-activity-label"]')?.textContent;

it.each(['connecting', 'catching_up'] as const)('says what the session last was while %s, as long as stored content is shown', async sessionStatus => {
  const container = await render(<LabWorkbench state={restored} sessionStatus={sessionStatus} actions={{}} />);
  expect(container.textContent).toContain('Stored reply');
  expect(status(container)).toBe('Ready');
  expect(composer(container)).toBe('Ready');
  expect(container.querySelector('.lab-empty-state')).toBeNull();
});

it('shows a socket that closed before the first page: stored content does not hide a disconnect', async () => {
  const container = await render(<LabWorkbench state={restored} sessionStatus="disconnected" actions={{}} />);
  expect(container.textContent).toContain('Stored reply');
  expect(status(container)).toBe('Reconnecting');
});

it('says what the session last was for a session that was working, not that it is opening', async () => {
  const working = { ...restored, agent: { ...restored.agent!, status: 'running' as const } };
  const container = await render(<LabWorkbench state={working} sessionStatus="connecting" actions={{}} />);
  expect(status(container)).toBe('Working');
});

it('keeps today\'s connection labels for content this connection observed, and for a failed session', async () => {
  const container = await render(<LabWorkbench state={observed} sessionStatus="connecting" actions={{}} />);
  expect(status(container)).toBe('Opening session');
  const unavailable = await render(<LabWorkbench state={restored} sessionStatus="unavailable" actions={{}} />);
  expect(status(unavailable)).toBe('Unavailable');
});
```

Create `packages/agent-remote-lab/src/components/SessionConversation.device-store.test.tsx`:

```tsx
import 'fake-indexeddb/auto';
import { Profiler } from 'react';
import { expect, it } from 'vitest';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { deviceStore } from '@orchardworks/agent-remote-web/device-store';
import { ConversationConnections, ConversationConnectionScope } from '../conversation-connections.js';
import { DraftStore } from '../draft-store.js';
import { replicaState } from '../test/fixtures.js';
import { render } from '../test/setup.js';
import { WorkspaceReady } from '../workspace-access.js';
import { saveWorkspaceSnapshot } from '../workspace-cache.js';
import { SessionConversation } from './SessionConversation.js';

const scope = 'https://agents.example/u/alice/';
const target = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'recorded-session', title: 'Stored session' };
const reply = (seq: number) => ({ providerId: 'recorded', seqStart: seq, seqEnd: seq, timestamp: '2026-11-15T00:00:00Z', sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
  collapsed: [], resources: [], item: { type: 'assistant_message' as const, text: `Stored reply ${seq}`, messageId: `m${seq}` } });
const opening = ['Opening session', 'Loading conversation', 'Awaiting Agent', 'Start with a Provider'];
// A network that never answers: the conversation can only show what the device kept.
const silentTransport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {}, connect: () => ({ close() {}, send() {} }) } as unknown as RemoteAgentTransport;

it('shows the stored conversation in its first frame and never an opening label or a blank timeline while nothing has answered', async () => {
  saveWorkspaceSnapshot(scope, target, { ...replicaState, timeline: { ...replicaState.timeline, epoch: 'epoch-1', nextSeq: 4, entries: [reply(1), reply(2), reply(3)] } });
  // The page starts: memory is empty, and the store is read before the first render, as main.tsx does.
  await deviceStore.flush();
  deviceStore.unload();
  await deviceStore.preload();

  const frames: Array<{ rows: number; status: string; composer: string; placeholders: string[] }> = [];
  const connections = new ConversationConnections(silentTransport, scope), drafts = new DraftStore(scope);
  // The profiler reports after every commit of the conversation, when its DOM is in place.
  const record = () => {
    const root = document.querySelector('[data-t1-root]');
    if (!root) return;
    frames.push({
      rows: root.querySelectorAll('.agent-timeline-entry').length,
      status: root.querySelector('.lab-conversation-status')?.textContent ?? '',
      composer: root.querySelector('[data-testid="agent-activity-label"]')?.textContent ?? '',
      placeholders: [...root.querySelectorAll('.lab-empty-state h3')].map(node => node.textContent ?? ''),
    });
  };
  const container = await render(
    <Profiler id="conversation" onRender={record}>
      <div data-t1-root>
        <WorkspaceReady.Provider value={true}><ConversationConnectionScope.Provider value={connections}>
          <SessionConversation storageScope={scope} baseUrl={scope} target={target} attachmentManaged hostLabel="Host" compact={false} active offline={false}
            transport={silentTransport} draftStore={drafts} draftBinding={{ store: drafts, key: 'view' }} viewId="view" windowViewId="view" familyRoot entries={[target]} onNavigate={async () => {}} />
        </ConversationConnectionScope.Provider></WorkspaceReady.Provider>
      </div>
    </Profiler>);
  try {
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]!.rows).toBe(3);
    for (const frame of frames) {
      expect(frame.rows).toBeGreaterThan(0);
      for (const text of [frame.status, frame.composer, ...frame.placeholders]) for (const label of opening) expect(text).not.toContain(label);
    }
    expect(frames.at(-1)!.status).toBe('Ready');
    expect(container.textContent).toContain('Stored reply 3');
  } finally { connections.clear(); }
});
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/components/LabWorkbench.restored.test.tsx src/components/SessionConversation.device-store.test.tsx --testTimeout=15000` (Bash timeout 180000)
Expected: FAIL: the heading says `Opening session` (and `Synchronizing`) while stored content is shown. The disconnect test and the test that keeps today's labels pass already; they pin behaviour.

- [ ] **Step 3: Give way to the last known state while stored content is shown.**

In `packages/agent-remote-lab/src/components/SessionWorkbench.tsx`, add after the line `const sessionStatus = session.connection;`:

```ts
  // Stored content is shown before the connection's own state knows it: the view's replica does not exist yet.
  const restoring = session.restoring === true || !!state?.timeline.restoredFromDevice && (sessionStatus === 'connecting' || sessionStatus === 'catching_up');
```

and replace

```ts
    : sessionStatus === 'disconnected' ? 'Reconnecting'
    : sessionStatus === 'connecting' ? 'Opening session'
    : session.controlChecking ? 'Checking access'
    : sessionStatus === 'catching_up' ? 'Synchronizing'
```

with

```ts
    // Stored content is shown while the connection opens: the heading says what the session last was (P2 removes the rest).
    : sessionStatus === 'disconnected' ? 'Reconnecting'
    : sessionStatus === 'connecting' && !restoring ? 'Opening session'
    : session.controlChecking && !restoring ? 'Checking access'
    : sessionStatus === 'catching_up' && !restoring ? 'Synchronizing'
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/components/LabWorkbench.restored.test.tsx src/components/SessionConversation.device-store.test.tsx src/components/LabWorkbench.test.tsx src/components/LabWorkbench.recovery.test.tsx src/components/AgentActivityStatus.test.tsx --testTimeout=15000` (Bash timeout 300000)
Expected: PASS, including the existing label tests (their states carry no stored content).

Note on the counted-state test: the profiler callback reads the DOM after every commit of the conversation subtree. The saved snapshot is flushed to IndexedDB, the page's memory is dropped (`unload`) and the store is preloaded, as `main.tsx` does at start; the transport never answers, so every frame is what the device alone can show.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-lab/src/components/SessionWorkbench.tsx packages/agent-remote-lab/src/components/LabWorkbench.restored.test.tsx packages/agent-remote-lab/src/components/SessionConversation.device-store.test.tsx
git commit -m "feat(lab): no opening label while the device's stored content is shown" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10a: A preview that follows the disk, and no content for a reader who lost access

Two things the first plan's design leaves to the lab. Only the sixteen most recent sessions are preloaded, but `SessionConversation` read its preview once, so sessions 17 to 40 stayed blank until their attach finished. And a stored preview outlives a revoked share or a removed Host unless something removes it.

**Files:**
- Modify: `packages/agent-remote-lab/src/components/SessionConversation.tsx`
- Modify: `packages/agent-remote-lab/src/components/SessionConversation.device-store.test.tsx`

- [ ] **Step 1: Write the failing tests.**

In `packages/agent-remote-lab/src/components/SessionConversation.device-store.test.tsx`, replace the import lines

```tsx
import { expect, it } from 'vitest';
```

with

```tsx
import { expect, it, vi } from 'vitest';
```

and

```tsx
import { saveWorkspaceSnapshot } from '../workspace-cache.js';
```

with

```tsx
import { readWorkspaceSnapshot, saveWorkspaceSnapshot } from '../workspace-cache.js';
import { DirectoryError, SessionDirectoryClient } from '../directory-client.js';
```

and append at the end of the file:

```tsx

it('shows a stored conversation that was not preloaded as soon as it is read from disk, without waiting for an attach', async () => {
  saveWorkspaceSnapshot(scope, target, { ...replicaState, timeline: { ...replicaState.timeline, epoch: 'epoch-1', nextSeq: 3, entries: [reply(1), reply(2)] } });
  await deviceStore.flush();
  deviceStore.unload();
  const connections = new ConversationConnections(silentTransport, scope), drafts = new DraftStore(scope);
  const container = await render(
    <WorkspaceReady.Provider value={true}><ConversationConnectionScope.Provider value={connections}>
      <SessionConversation storageScope={scope} baseUrl={scope} target={target} attachmentManaged hostLabel="Host" compact={false} active offline={false}
        transport={silentTransport} draftStore={drafts} draftBinding={{ store: drafts, key: 'view' }} viewId="view" windowViewId="view" familyRoot entries={[target]} onNavigate={async () => {}} />
    </ConversationConnectionScope.Provider></WorkspaceReady.Provider>);
  try { await vi.waitFor(() => expect(container.querySelectorAll('.agent-timeline-entry')).toHaveLength(2)); }
  finally { connections.clear(); }
});

it.each(['session_forbidden', 'host_forbidden', 'host_not_found'])('forgets the stored conversation, on disk too, when the Relay answers %s', async code => {
  saveWorkspaceSnapshot(scope, target, { ...replicaState, timeline: { ...replicaState.timeline, epoch: 'epoch-1', nextSeq: 3, entries: [reply(1), reply(2)] } });
  await deviceStore.flush();
  const directory = new SessionDirectoryClient(scope);
  vi.spyOn(directory, 'attach').mockRejectedValue(new DirectoryError('Session access is unavailable.', code, 403));
  const connections = new ConversationConnections(silentTransport, scope), drafts = new DraftStore(scope);
  await render(
    <WorkspaceReady.Provider value={true}><ConversationConnectionScope.Provider value={connections}>
      <SessionConversation storageScope={scope} baseUrl={scope} target={target} hostLabel="Host" compact={false} active offline={false} directoryFor={() => directory}
        transport={silentTransport} draftStore={drafts} draftBinding={{ store: drafts, key: 'view' }} viewId="view" windowViewId="view" familyRoot entries={[target]} onNavigate={async () => {}} />
    </ConversationConnectionScope.Provider></WorkspaceReady.Provider>);
  try {
    await vi.waitFor(() => expect(readWorkspaceSnapshot(scope, target)).toBeUndefined());
    await deviceStore.flush();
    deviceStore.unload();
    await deviceStore.preload();
    expect(readWorkspaceSnapshot(scope, target)).toBeUndefined();
  } finally { connections.clear(); vi.restoreAllMocks(); }
});
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/components/SessionConversation.device-store.test.tsx --testTimeout=15000` (Bash timeout 180000)
Expected: FAIL in the new tests: the preview stays empty (no rows ever appear) and the stored conversation survives the refusal.

- [ ] **Step 3: Read the preview again when the disk answers, and forget on lost access.**

In `packages/agent-remote-lab/src/components/SessionConversation.tsx`, replace

```ts
import { readWorkspaceSnapshot, workspaceDisplayState } from '../workspace-cache.js';
```

with

```ts
import { forgetWorkspaceSession, loadWorkspaceSnapshot, readWorkspaceSnapshot, workspaceDisplayState } from '../workspace-cache.js';
```

replace

```ts
  const preview = useMemo(() => readWorkspaceSnapshot(baseUrl, currentTarget), [baseUrl, currentTarget.hostId, currentTarget.providerId, currentTarget.nativeSessionId]);
```

with

```ts
  // A conversation outside the page's preloaded sessions is read from disk after the first frame; the view reads its preview again then.
  const [previewRevision, setPreviewRevision] = useState(0);
  const preview = useMemo(() => readWorkspaceSnapshot(baseUrl, currentTarget), [baseUrl, currentTarget.hostId, currentTarget.providerId, currentTarget.nativeSessionId, previewRevision]);
  const previewMissing = preview === undefined;
  useEffect(() => {
    if (!previewMissing) return;
    let current = true;
    void loadWorkspaceSnapshot(baseUrl, currentTarget).then(found => { if (found && current) setPreviewRevision(value => value + 1); });
    return () => { current = false; };
  }, [baseUrl, currentTarget.hostId, currentTarget.providerId, currentTarget.nativeSessionId, previewMissing]);
```

and replace

```ts
      if (!historyRoleId) unavailable.remember(currentTarget, error);
```

with

```ts
      if (!historyRoleId) unavailable.remember(currentTarget, error);
      // A reader who lost access to the session or its Host keeps no preview of it on this device.
      if (error instanceof DirectoryError && ['session_forbidden', 'host_forbidden', 'host_not_found'].includes(error.code ?? '')) forgetWorkspaceSession(baseUrl, currentTarget);
```

- [ ] **Step 4: Run the tests and the conversation suites.**

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/components/SessionConversation.device-store.test.tsx src/components/SessionFamily.test.tsx src/components/SessionConversation.connections.test.tsx --testTimeout=15000` (Bash timeout 300000)
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-lab/src/components/SessionConversation.tsx packages/agent-remote-lab/src/components/SessionConversation.device-store.test.tsx packages/agent-remote-lab/src/workspace-cache.ts
git commit -m "feat(lab): follow the disk for previews and forget content a reader lost access to" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: Real transports: a journal-served Relay, a fake Controller and the page

These tests run the hosted broker behind real HTTP and WebSocket servers (`createRemoteHostBroker`), a `MemoryJournalStore` that survives Relay restarts, a fake Controller that publishes over a real uplink socket, and the page's real `HttpWebSocketTransport`, client, replica and `SessionConversation`. A Controller restart and a Relay restart therefore keep the journal's epoch and sequences, as a journal-served session does in production. They cover: T1 from the device store with counted states, catch-up after the stored cursor, the one-step replacement, no holes after a correction, and T6.

**Files:**
- Modify: `packages/agent-remote-lab/package.json`
- Create: `packages/agent-remote-lab/src/test/journal-relay.ts`
- Create: `packages/agent-remote-lab/src/components/SessionConversation.journal.test.tsx`

- [ ] **Step 1: Give the lab the journal store for its tests.**

In `packages/agent-remote-lab/package.json`, add to `devDependencies`, after `"@orchardworks/agent-remote-controller": "workspace:*",`:

```json
    "@orchardworks/agent-remote-journal": "workspace:*",
```

Run: `pnpm install --offline --ignore-scripts` (Bash timeout 300000)
Expected: exit code 0; `pnpm-lock.yaml` gains the lab's link to the journal package and nothing else changes.

Run: `pnpm --filter @orchardworks/agent-remote-journal run build && pnpm --filter @orchardworks/agent-remote-hosted run build` (Bash timeout 300000)
Expected: exit code 0. The lab imports both from `dist`.

- [ ] **Step 2: Write the fixture.**

The Host record carries the owner's smart-reading switch for provider `codex` (`smartReading: [PROVIDER_ID]`, landed with P1-B3a); without it the Relay serves the session through the Controller and these tests would not exercise the journal.

Create `packages/agent-remote-lab/src/test/journal-relay.ts`:

```ts
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocket } from 'ws';
import { MemoryJournalStore } from '@orchardworks/agent-remote-journal';
import { PROTOCOL_VERSION, type AgentSnapshotPayload } from '@orchardworks/agent-remote-protocol';
import { createRemoteHostBroker, type RemoteHostBrokerState } from '../server/remote-host-broker.js';

export type Wire = Record<string, any>;
/** The origin the page's sockets declare; the broker only admits this one. */
export const RELAY_ORIGIN = process.env.AGENT_REMOTE_ORIGIN ?? 'http://127.0.0.1:6175';
export const HOST_ID = 'host';
export const PUBLIC_ID = 'agent';
export const PROVIDER_ID = 'codex';
export const NATIVE_SESSION_ID = 'native-session';
export const SESSION_KEY = `${PROVIDER_ID}:${NATIVE_SESSION_ID}`;
const DEVICE_CREDENTIAL = 'arc_fixture';
/** The hash of `arc_fixture`, as the hosted broker stores device credentials. */
const DEVICE_CREDENTIAL_HASH = '7a8ce1c8927a74e75f9bc855677bd2cb361d6b19a58f85296a8777022d022a14';
export const DIGEST = 'a'.repeat(64);

export const snapshot = (status: 'idle' | 'running', id: string): AgentSnapshotPayload => ({
  id, providerId: PROVIDER_ID, createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: PROVIDER_ID, sessionId: NATIVE_SESSION_ID, status },
});

export const row = (itemKey: string, text: string, turnId = 'turn-1') => ({
  itemKey, providerId: PROVIDER_ID, sourceKey: `${itemKey}:${text}`, occurredAt: 1_725_000_000_000, turnId,
  item: { type: 'assistant_message' as const, text, messageId: itemKey },
});
/** One complete item: its row and its completion. */
export const appended = (itemKey: string, text: string, turnId = 'turn-1'): Wire[] => [{ op: 'append', row: row(itemKey, text, turnId) }, { op: 'complete', itemKey, digest: DIGEST }];
export const head = (): Wire => ({ op: 'head', head: { snapshot: snapshot('idle', NATIVE_SESSION_ID), observedAt: 5 } });

const savedState = (): RemoteHostBrokerState => ({
  keys: [[DEVICE_CREDENTIAL_HASH, { expires: Date.now() + 3_600_000, installationId: 'restored-installation' }]],
  hosts: [{ id: HOST_ID, installationId: 'restored-installation', name: 'Restored Host', providers: [{ providerId: PROVIDER_ID, displayName: 'Codex' }], legacyDsh: false,
    // The owner's switch (P1-B3a): the Relay serves this provider's sessions from their journals.
    smartReading: [PROVIDER_ID] }],
  bindings: [{ hostId: HOST_ID, providerId: PROVIDER_ID, nativeSessionId: NATIVE_SESSION_ID, agentId: PUBLIC_ID }],
  creations: [],
});

export interface FakeController {
  /** Opens the session's journal under a new generation and answers with what the Relay holds. */
  open(): Promise<Wire>;
  /** Publishes entries without their sequence numbers and waits for the Relay's acknowledgement. */
  publish(entries: Wire[]): Promise<void>;
  disconnect(): Promise<void>;
}

/** The Host's Controller on a real uplink socket, with `journal=1`. It answers the attach and the streams the Relay opens. */
async function connectController(port: number): Promise<FakeController> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/remote-host?journal=1`, { headers: { authorization: `Bearer ${DEVICE_CREDENTIAL}` } });
  socket.on('error', () => undefined);
  const seen: Wire[] = [];
  const streams = new Set<string>();
  const send = (fields: Wire) => socket.send(JSON.stringify({ uplinkVersion: 2, ...fields }));
  const toStream = (streamId: string, fields: Wire) => send({ type: 'stream_message', streamId, message: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...fields }) });
  socket.on('message', data => {
    const message = JSON.parse(String(data)) as Wire;
    seen.push(message);
    if (message.type === 'rpc_request' && message.path === '/remote/attach') {
      send({ type: 'rpc_response', requestId: message.requestId, status: 200, body: JSON.stringify({ agentId: PUBLIC_ID, nativeSessionId: NATIVE_SESSION_ID }) });
    } else if (message.type === 'journal_older_request') {
      // Everything the native session holds is already published.
      send({ type: 'journal_older_done', requestId: message.requestId, sessionKey: message.sessionKey, olderAvailable: false });
    } else if (message.type === 'stream_open') {
      streams.add(message.streamId);
      send({ type: 'stream_opened', streamId: message.streamId });
    } else if (message.type === 'stream_message' && streams.has(message.streamId)) {
      const inner = JSON.parse(message.message) as Wire;
      if (inner.type === 'negotiate') {
        toStream(message.streamId, { type: 'negotiated', sessionControl: true });
        toStream(message.streamId, { type: 'agent_snapshot', payload: snapshot('running', PUBLIC_ID) });
        toStream(message.streamId, { type: 'session_control', payload: { agentId: PUBLIC_ID, revision: 'rev-1', access: 'read_only', available: true } });
      } else if (inner.type === 'session_control_request') {
        if (inner.payload.revision !== 'rev-1') toStream(message.streamId, { type: 'protocol_error', payload: { requestId: inner.payload.requestId, code: 'session_control_changed', message: 'Session access changed.', recoverable: true } });
        else toStream(message.streamId, { type: 'session_control', payload: { agentId: PUBLIC_ID, revision: 'rev-1', access: 'control', available: true, token: 'token-1', requestId: inner.payload.requestId } });
      }
    }
  });
  async function take(match: (message: Wire) => boolean, label: string): Promise<Wire> {
    for (let attempt = 0; attempt < 600; attempt++) {
      const at = seen.findIndex(match);
      if (at >= 0) return seen.splice(at, 1)[0]!;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for ${label}.`);
  }
  await once(socket, 'open');
  send({ type: 'register', installationId: 'restored-installation', name: 'Restored Host', providers: [{ providerId: PROVIDER_ID, displayName: 'Codex' }] });
  await take(message => message.type === 'registered', 'registered');
  let generation = 0, sequence = 0, requests = 0;
  return {
    async open() {
      send({ type: 'journal_open', requestId: `open-${++requests}`, sessionKey: SESSION_KEY, publisherId: 'controller-1' });
      const opened = await take(message => message.type === 'journal_opened', 'journal_opened');
      generation = opened.generation; sequence = opened.watermark;
      return opened;
    },
    async publish(entries) {
      const stamped = entries.map(entry => ({ sequence: ++sequence, ...entry }));
      send({ type: 'journal_publish', sessionKey: SESSION_KEY, generation, entries: stamped });
      const watermark = sequence;
      await take(message => message.type === 'journal_ack' && message.watermark === watermark, 'journal_ack');
    },
    async disconnect() {
      if (socket.readyState === WebSocket.OPEN) { socket.close(1000); await once(socket, 'close'); }
    },
  };
}

export interface JournalRelay {
  /** The Relay's address; the same after every restart. */
  readonly url: string;
  readonly journals: MemoryJournalStore;
  connectController(): Promise<FakeController>;
  /** Closes every socket and starts a new broker on the same port over the same journals, as a Relay restart does. */
  restart(): Promise<void>;
  stop(): Promise<void>;
}

/** The hosted broker behind real HTTP and WebSocket servers, with journals kept in memory across restarts. */
export async function startJournalRelay(): Promise<JournalRelay> {
  const journals = new MemoryJournalStore();
  const sockets = new Set<Socket>();
  let server!: Server;
  let broker!: ReturnType<typeof createRemoteHostBroker>;
  let port = 0;
  async function listen(): Promise<void> {
    broker = createRemoteHostBroker({ origin: RELAY_ORIGIN, initialState: savedState(), journals, rpcTimeoutMs: 2000, journalRequestTimeoutMs: 2000 });
    server = createServer((_request, response) => { response.writeHead(404).end(); });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    broker.install(server);
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  }
  async function close(): Promise<void> {
    await broker.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await listen();
  return { get url() { return `http://127.0.0.1:${port}`; }, journals, connectController: () => connectController(port), restart: async () => { await close(); await listen(); }, stop: close };
}
```

- [ ] **Step 3: Write the failing tests.**

Create `packages/agent-remote-lab/src/components/SessionConversation.journal.test.tsx`:

```tsx
import 'fake-indexeddb/auto';
import { Profiler } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { HttpWebSocketTransport, type WebSocketLike } from '@orchardworks/agent-remote-web';
import { deviceStore } from '@orchardworks/agent-remote-web/device-store';
import { ConversationConnections, ConversationConnectionScope } from '../conversation-connections.js';
import { DraftStore } from '../draft-store.js';
import { appended, head, HOST_ID, NATIVE_SESSION_ID, PROVIDER_ID, PUBLIC_ID, RELAY_ORIGIN, row, startJournalRelay, type FakeController, type JournalRelay } from '../test/journal-relay.js';
import { render, unmount } from '../test/setup.js';
import { WorkspaceReady } from '../workspace-access.js';
import { SessionConversation } from './SessionConversation.js';

const target = { hostId: HOST_ID, providerId: PROVIDER_ID, nativeSessionId: NATIVE_SESSION_ID, title: 'Journal session', agentId: PUBLIC_ID };
const opening = ['Opening session', 'Loading conversation', 'Awaiting Agent', 'Start with a Provider'];
interface Frame { rows: number; status: string; composer: string; placeholders: string[] }

async function mountPage(relay: JournalRelay) {
  const requests: string[] = [];
  const frames: Frame[] = [];
  const transport = new HttpWebSocketTransport(relay.url, { sessionChannels: true, webSocketFactory: address =>
    new WebSocket(address, { origin: RELAY_ORIGIN }) as unknown as WebSocketLike });
  transport.onProtocolMessage(event => {
    const message = event.message as { type: string; payload?: { direction?: string } };
    if (event.direction === 'outbound' && message.type === 'timeline_request') requests.push(message.payload!.direction!);
  });
  const connections = new ConversationConnections(transport, relay.url), drafts = new DraftStore(relay.url);
  // The profiler reports after every commit of the conversation, when its DOM is in place.
  const record = () => {
    const root = document.querySelector('[data-journal-root]');
    if (!root) return;
    frames.push({
      rows: root.querySelectorAll('.agent-timeline-entry').length,
      status: root.querySelector('.lab-conversation-status')?.textContent ?? '',
      composer: root.querySelector('[data-testid="agent-activity-label"]')?.textContent ?? '',
      placeholders: [...root.querySelectorAll('.lab-empty-state h3')].map(node => node.textContent ?? ''),
    });
  };
  const container = await render(
    <Profiler id="page" onRender={record}>
      <div data-journal-root>
        <WorkspaceReady.Provider value={true}><ConversationConnectionScope.Provider value={connections}>
          <SessionConversation storageScope={relay.url} baseUrl={relay.url} target={target} attachedSession={target} attachmentManaged hostLabel="Host" compact={false}
            active offline={false} transport={transport} draftStore={drafts} draftBinding={{ store: drafts, key: 'view' }}
            imageDraftBinding={{ scope: relay.url, key: JSON.stringify([relay.url, 'image-owner']) }} displayBinding={{ scope: relay.url, key: 'display-owner' }}
            viewId="view" windowViewId="view" familyRoot entries={[target]} onNavigate={async () => {}} />
        </ConversationConnectionScope.Provider></WorkspaceReady.Provider>
      </div>
    </Profiler>);
  return {
    container, frames, requests, connections,
    rows: () => container.querySelectorAll('.agent-timeline-entry').length,
    live: () => connections.find(target)!,
    ready: () => vi.waitFor(() => expect(connections.find(target)?.client.getSessionState().connection).toBe('ready'), { timeout: 15_000 }),
    async close() { await unmount(container); connections.clear(); transport.dispose(); },
  };
}
type Page = Awaited<ReturnType<typeof mountPage>>;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close().catch(() => undefined); });
async function relayWith(publish: (controller: FakeController) => Promise<void>) {
  const relay = await startJournalRelay();
  cleanup.push(relay.stop);
  const controller = await relay.connectController();
  cleanup.push(() => controller.disconnect());
  await controller.open();
  await publish(controller);
  return { relay, controller };
}
const textsOf = (page: Page) => page.live().replica.getState().timeline.entries.map(entry => (entry.item as { text: string }).text);

it('shows a conversation opened before from the device store before anything answers, then continues after its stored cursor', async () => {
  const { relay, controller } = await relayWith(c => c.publish([...appended('m1', 'Hello'), ...appended('m2', 'World'), head()]));
  const first = await mountPage(relay);
  await first.ready();
  await vi.waitFor(() => expect(first.rows()).toBe(2));
  expect(first.requests).toEqual(['tail']);
  await first.close();
  await deviceStore.flush();

  // The page starts again: memory is empty and the store is read before the first render, as main.tsx does.
  deviceStore.unload();
  await deviceStore.preload();
  const second = await mountPage(relay);
  cleanup.push(() => second.close());
  expect(second.frames[0]!.rows).toBe(2);
  await second.ready();
  await vi.waitFor(() => expect(second.requests).toEqual(['after']));
  await controller.publish(appended('m3', 'Again'));
  await vi.waitFor(() => expect(second.rows()).toBe(3));
  for (const frame of second.frames) {
    expect(frame.rows).toBeGreaterThan(0);
    for (const text of [frame.status, frame.composer, ...frame.placeholders]) for (const label of opening) expect(text).not.toContain(label);
  }
  expect(second.requests).toEqual(['after']);
}, 40_000);

it('swaps a replaced conversation in once its tail arrives, with rows on screen in every frame', async () => {
  const { relay, controller } = await relayWith(c => c.publish([...appended('m1', 'Hello'), ...appended('m2', 'World'), head()]));
  const page = await mountPage(relay);
  cleanup.push(() => page.close());
  await page.ready();
  await vi.waitFor(() => expect(page.rows()).toBe(2));
  const shown = page.frames.length;
  await controller.publish([{ op: 'replace', items: ['New one', 'New two', 'New three'].map((text, index) => ({ row: row(`n${index + 1}`, text), digest: 'c'.repeat(64) })) }]);
  await vi.waitFor(() => expect(page.container.textContent).toContain('New three'), { timeout: 15_000 });
  expect(page.rows()).toBe(3);
  expect(page.container.textContent).not.toContain('Hello');
  expect(page.requests.at(-1)).toBe('tail');
  for (const frame of page.frames.slice(shown)) expect(frame.rows).toBeGreaterThan(0);
}, 40_000);

it('shows the stored conversation first and swaps in the new epoch when the conversation was replaced while the user was away', async () => {
  const { relay, controller } = await relayWith(c => c.publish([...appended('m1', 'Hello'), ...appended('m2', 'World'), head()]));
  const first = await mountPage(relay);
  await first.ready();
  await vi.waitFor(() => expect(first.rows()).toBe(2));
  await first.close();
  await deviceStore.flush();
  await controller.publish([{ op: 'replace', items: ['New one', 'New two', 'New three'].map((text, index) => ({ row: row(`n${index + 1}`, text), digest: 'c'.repeat(64) })) }]);

  deviceStore.unload();
  await deviceStore.preload();
  const second = await mountPage(relay);
  cleanup.push(() => second.close());
  expect(second.frames[0]!.rows).toBe(2);
  await vi.waitFor(() => expect(second.container.textContent).toContain('New three'), { timeout: 15_000 });
  expect(second.container.textContent).not.toContain('Hello');
  expect(second.requests).toEqual(['after', 'tail']);
  for (const frame of second.frames) {
    expect(frame.rows).toBeGreaterThan(0);
    for (const text of [frame.status, frame.composer, ...frame.placeholders]) for (const label of opening) expect(text).not.toContain(label);
  }
}, 40_000);

it('falls back to the tail when the stored cursor is far behind and the Controller is away, and does not ask again', async () => {
  const { relay, controller } = await relayWith(c => c.publish([...appended('t1', 'Turn 1', 'turn-1'), head()]));
  const first = await mountPage(relay);
  await first.ready();
  await vi.waitFor(() => expect(first.rows()).toBe(1));
  await first.close();
  await deviceStore.flush();
  // 60 more turns of three items: the Relay keeps the bodies of the latest 50 turns and fills older ones from the Controller on demand,
  // so the first 100 rows after the stored cursor include bodies it cannot fill while the Controller is away, and the latest 100 do not.
  const operations = Array.from({ length: 60 }, (_, index) => index + 2)
    .flatMap(turn => [1, 2, 3].flatMap(part => appended(`t${turn}-${part}`, `Turn ${turn}.${part}`, `turn-${turn}`)));
  for (let at = 0; at < operations.length; at += 120) await controller.publish(operations.slice(at, at + 120));
  await controller.disconnect();

  deviceStore.unload();
  await deviceStore.preload();
  const second = await mountPage(relay);
  cleanup.push(() => second.close());
  expect(second.frames[0]!.rows).toBe(1);
  await second.ready();
  await vi.waitFor(() => expect(second.container.textContent).toContain('Turn 61.3'), { timeout: 15_000 });
  expect(second.requests).toEqual(['after', 'tail']);
  // Ready, with rows, and no request loop behind it.
  await new Promise(resolve => setTimeout(resolve, 1500));
  expect(second.requests).toEqual(['after', 'tail']);
  expect(second.live().client.getSessionState().connection).toBe('ready');
}, 60_000);

it('never leaves a hole when an item older than the window is corrected: the next older page continues from the window\'s first entry', async () => {
  const items = Array.from({ length: 130 }, (_, index) => index + 1);
  const { relay, controller } = await relayWith(async c => {
    const operations = [...items.flatMap(number => appended(`i${number}`, `Item ${number}`)), head()];
    for (let at = 0; at < operations.length; at += 120) await c.publish(operations.slice(at, at + 120));
  });
  const page = await mountPage(relay);
  cleanup.push(() => page.close());
  await page.ready();
  await vi.waitFor(() => expect(page.rows()).toBe(100));
  const opened = await controller.open();
  const revision = (opened.index as Array<{ itemKey: string; revision: number }>).find(entry => entry.itemKey === 'i1')!.revision;
  await controller.publish([{ op: 'correct', row: row('i1', 'Item 1 corrected'), digest: 'b'.repeat(64), expectedRevision: revision }]);
  // A live row after the correction shows the client a gap, and its `after` page carries the corrected item.
  await controller.publish(appended('i131', 'Item 131'));
  await vi.waitFor(() => expect(page.container.textContent).toContain('Item 131'), { timeout: 15_000 });
  const { client, replica } = page.live();
  while (replica.getState().timeline.hasOlder) await client.loadOlder();
  expect(textsOf(page)).toEqual(['Item 1 corrected', ...Array.from({ length: 130 }, (_, index) => `Item ${index + 2}`)]);
}, 60_000);

it('keeps every row mounted, and never shows a frame without rows, across a Controller restart and a Relay restart', async () => {
  const { relay, controller } = await relayWith(c => c.publish([...appended('m1', 'Hello'), ...appended('m2', 'World'), ...appended('m3', 'Again'), head()]));
  const page = await mountPage(relay);
  cleanup.push(() => page.close());
  await page.ready();
  await vi.waitFor(() => expect(page.rows()).toBe(3));
  const marks = new Map([...page.container.querySelectorAll<HTMLElement>('[data-entry-key]')].map(node => [node.dataset.entryKey!, node] as const));
  expect(marks.size).toBe(3);
  const settled = page.frames.length;
  const requested = page.requests.length;
  const keptMounted = () => { for (const [key, node] of marks) expect(page.container.querySelector(`[data-entry-key="${key}"]`)).toBe(node); };

  // The Controller restarts: its uplink drops and a new one opens the same journal under a new generation.
  await controller.disconnect();
  const again = await relay.connectController();
  cleanup.push(() => again.disconnect());
  await again.open();
  await again.publish(appended('m4', 'Back'));
  await vi.waitFor(() => expect(page.container.textContent).toContain('Back'), { timeout: 20_000 });
  await page.ready();
  keptMounted();

  // The Relay restarts: every socket closes and a new broker serves the same journals.
  const beforeRestart = page.requests.length;
  await relay.restart();
  await vi.waitFor(() => {
    expect(page.requests.length).toBeGreaterThan(beforeRestart);
    expect(page.live().client.getSessionState().connection).toBe('ready');
  }, { timeout: 30_000 });
  keptMounted();
  expect(page.container.textContent).toContain('Back');

  // Rows were never replaced and nothing was fetched from the tail again.
  expect(page.requests.slice(requested)).not.toContain('tail');
  expect(page.requests.slice(requested).length).toBeGreaterThan(0);
  for (const frame of page.frames.slice(settled)) expect(frame.rows).toBeGreaterThanOrEqual(3);
}, 90_000);
```

- [ ] **Step 4: Run them.**

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/components/SessionConversation.journal.test.tsx --testTimeout=90000` (Bash timeout 400000)
Expected: PASS, 6 tests. Without Tasks 8 to 10 the first test fails (stored rows missing or an opening label in its first frame), without Tasks 8 and 9 the reload-after-replacement test fails, without Task 6 the stale-cursor test fails (the client reconnects in a loop instead of fetching the tail), and without Task 4 the hole test fails (a missing run of items). The replacement test and the T6 restart test pass already on the landed Relay and client; they pin behaviour.

The deadlines are per test (`--testTimeout=90000` with a `timeout` inside each `it`) and the Bash tool deadline is the outer one. A Relay restart waits for the transport's reconnect backoff (250 ms to 5 s), which is why the last test allows 90 s.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-lab/package.json pnpm-lock.yaml packages/agent-remote-lab/src/test/journal-relay.ts packages/agent-remote-lab/src/components/SessionConversation.journal.test.tsx
git commit -m "test(lab): real-transport tests of a journal-served conversation on the device store" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 12: Documents, the whole suites, the bundle budget and the compatibility digest

**Files:**
- Modify: `docs/current/agent-remote/web.md`
- Modify: `packages/agent-remote-lab/compatibility.json` (generated)

- [ ] **Step 1: Document the device store.**

In `docs/current/agent-remote/web.md`, insert this section immediately before the line `## Non-Goals`:

```markdown
## Device store

- Each page keeps what it observed of the conversations it opened in the device store (`packages/agent-remote-web/src/device-store.ts`): the `sessions` and `session_index` object stores of the IndexedDB database it shares with composer drafts and images (`browser-database.ts`, schema version 3; an upgrade only creates missing stores). A record holds the public session's epoch, its next sequence, the latest window of projected entries (at most 200 entries and 1 MiB of JSON, `hasOlder` set when older ones were left out), the last Snapshot without its active turn, pending interactions and runtime connection, and the time of the update. Limits are soft: 40 sessions and 32 MiB on disk, and a session a connection holds is never evicted. Writes go behind the display observer's two-second debounce and on page hide. A full disk evicts the oldest unpinned sessions and retries once; a write that still fails leaves the content in memory.
- The page reads the store before the application chunk renders (`packages/agent-remote-lab/src/main.tsx`), so a conversation opened before shows its stored rows in its first frame (`readWorkspaceSnapshot`) and its replica starts from the stored epoch and cursor (`restoreWorkspaceReplica`, `AgentReplica.restoreFromDevice`). After negotiation the client asks for what came `after` that cursor. A replaced epoch is answered stale, the new tail replaces the content when it arrives, and the view keeps showing the last display until then. Until the connection is first ready (`timeline.restoredFromDevice`), and while it is opening or catching up, the labels Opening session, Synchronizing and Checking access say what the session last was; a disconnect is always shown.
- Older history, the timeline search and recovery read their pages over the session wire when the transport recovers over it, so a journal-served session never needs its Controller to scroll back. An `after` page's entry that is older than the window the client holds is folded into the window or left for a `before` page; it never becomes an entry before the window's first one, so the next `before` page skips nothing. An entry equal to the one held at its sequence is that object, and a folded entry keeps the held entry's sequence, so neither a catch-up nor a correction changes a row's key.
- A session whose attach the Relay answers `session_forbidden`, `host_forbidden` or `host_not_found` is removed from the store, memory and disk, so a preview never outlives the reader's access. Sign-out and the disk limits read the index inside the deleting transaction, so rows another tab wrote are included.
- Signing out and Clear cache on close clear the store with the other conversation caches; with the preference on, the store keeps memory copies only.
```

- [ ] **Step 2: Typecheck both packages and the Playwright specs.**

Run: `pnpm --filter @orchardworks/agent-remote-web run typecheck && pnpm --filter @orchardworks/agent-remote-lab run typecheck` (Bash timeout 400000)
Expected: exit code 0 for both. The lab typecheck includes `tsconfig.e2e.json`, which covers the edited Playwright specs.

- [ ] **Step 3: Run the lab suites in three parts.**

Rebuild the web package first so the lab tests see its final state: `pnpm --filter @orchardworks/agent-remote-web run build` (Bash timeout 300000).

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/components --testTimeout=15000 --maxWorkers=50% --exclude '**/*.local.test.*' --exclude 'src/components/SessionConversation.journal.test.tsx'` (Bash timeout 600000)
Expected: PASS.

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/hooks src/server --testTimeout=15000 --maxWorkers=50% --exclude '**/*.local.test.*'` (Bash timeout 600000)
Expected: PASS.

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-lab exec vitest run --testTimeout=15000 --maxWorkers=50% --exclude 'src/components/**' --exclude 'src/hooks/**' --exclude 'src/server/**' --exclude '**/*.local.test.*'` (Bash timeout 600000)
Expected: PASS. The journal test runs in Task 11 and again in the full run of the second plan; it is excluded here only to keep each part inside its deadline.

- [ ] **Step 4: Run the whole web suite and build the lab, which enforces the bundle budgets.**

Run: `pnpm --filter @orchardworks/agent-remote-web exec vitest run --testTimeout=10000` (Bash timeout 600000)
Expected: PASS.

Run: `pnpm --filter @orchardworks/agent-remote-lab run build` (Bash timeout 600000)
Expected: exit code 0. The bundle-budget plugin fails the build when the entry or the `App` chunk exceeds its gzip budget. The device store must be in the `App` chunk, not the entry: if the build names the entry chunk, `main.tsx` imports the store statically somewhere (Task 9 Step 6 loads it with a dynamic import).

- [ ] **Step 5: Update and check the compatibility digest.**

Run: `pnpm compatibility:update && pnpm compatibility:check` (Bash timeout 300000)
Expected: exit code 0 for both. The digest changes because the web and lab sources, the lockfile and the docs changed; no protocol contract did.

- [ ] **Step 6: Commit.**

```bash
git add docs/current/agent-remote/web.md packages/agent-remote-lab/compatibility.json
git commit -m "docs: the device store, and the compatibility digest after it" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-review

**Owner decisions.**

- Device store in IndexedDB per public session with epoch, window (entries and bytes bound), last Snapshot, cursor and update time: Tasks 2 and 3. Soft LRU across sessions that never evicts a mounted session: `victims`, `evictForQuota`, `trimMemory` skip pinned keys; pins come from every connection (Task 9). Write-behind off the frame path: `save` is memory plus a 50 ms timer, called from the observer's 2 s debounce (Task 9). Quota handled by eviction, never by failing: Task 3 tests. Schema versioned with an upgrade preserving drafts and images: Task 1.
- T1 from the store on mount, before any network, no blank timeline, no loading label, preloaded at start, tested by counting states: Tasks 8, 9 (preload in `main.tsx`), 10, 10a (sessions beyond the preload) and 11 (Profiler frames over a silent transport and over a real Relay).
- Catch-up after the stored cursor on the same epoch, a one-step replacement without a blank frame: Task 6 (client, and older history over the session wire), Task 11 (real transport); the retained display is the lab's existing `retainedDisplay`, seeded from the store (decision 9).
- No holes in the window (option b, the client folds without moving its older boundary): Task 4, Task 6 (third test), Task 11 (third test).
- T6 in this plan means rows and row-less frames; labels across restarts are counted in P2 (T5). Unchanged rows keep their DOM across a reconnect or a Controller restart: row keys explained in Task 4 and left as they are; the fold rule keeps a folded entry's key and object identity is kept (Task 4); proven with DOM node identity over real transports in Task 11.
- Presentation: only the opening labels while stored content is shown (decision 10); no composer or full label removal. Crude mode: the store works against any Host; a crude Host's epoch change is a replacement (Task 6 second test).
- Measurement, 4x CPU and 100 ms RTT against the control group, and the last task's dependency on P1-B3a and P1-C2: the second plan.
- Tests: real IndexedDB behaviour with `fake-indexeddb` (already a dev dependency of both packages), real transports for reconnect and catch-up, Node 22 for lab tests, each task ends green, compatibility update and check at the end of this plan and again at the end of the second.

**Placeholder scan.** Every code step shows its code; the edits to existing files name the exact text they replace, each of which occurs once in its file (checked against the current files): `image-drafts.ts` (`openDatabase` block and `DATABASE`), `reducer.ts` (`const entries = mergeAuthoritative(base, incoming);` and the `entries: applyBackgroundEntries(...)` line in `applyHistoryPage`), `AgentActivityStatus.tsx` (`const label = disabled ? disabledLabel ?? connectionLabel`), `AgentComposer.tsx` (`const activitySession = ...`), `conversation-connections.ts`, `conversation-storage.ts`, `main.tsx`, `SessionWorkbench.tsx`.

**Type consistency.** `SessionToStore` and `StoredSession` (Task 2) are what `DeviceStore.save` takes and `peek` returns (Task 3), what `AgentReplica.restoreFromDevice` takes (Task 5, `Pick<StoredSession, ...>`) and what `workspace-cache.ts` builds and reads (Task 8). `timeline.restoredFromDevice` (Task 5) is set by `restoreFromDevice` and by `readWorkspaceSnapshot` (Task 8), read by `remoteSessionState` (`restoring`, Task 5), by `AgentComposer` (Task 5), by `SessionWorkbench` through `session.restoring` (Task 10) and by `observeWorkspaceDisplay` (Task 9). `deviceStore.pin` returns the release function that `pinWorkspaceSession` and `observeWorkspaceDisplay` call (Tasks 8 and 9). `deviceStore.unload()` and `preload()` are used by the lab tests (Tasks 8, 10, 11) and defined in Task 3.

**Risks the implementer should watch.**

- The real-transport tests depend on the hosted broker's journal-served path as P1-B2 and P1-B3a leave it (Decisions 3, 5 and 9 of P1-B2; the retention of the latest 50 turns and the switch of P1-B3a).
- Reconnects in the last test wait for the transport's own backoff; the timeouts are deliberately generous, and the assertions do not use clocks.
- A row is re-keyed if an adapter's correction changes an item's native id (a `messageId` that appears only later). The first plan does not guard against it; P1-C's continuity fixtures must keep `messageId`, `callId` and `requestId` constant between the live and the reread form of an item.

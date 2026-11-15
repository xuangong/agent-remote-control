# P1-C3 Keeping journals current Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**This plan is a task-level outline, not a step-level plan.** It names the files, the interfaces, the messages, the budgets and the tests of each task, from a read of the code and of the four adapters (findings below). It gives code only for interfaces. Expand each task into steps when its turn comes, from the landed state of P1-C1 and P1-C2: the provider tasks depend on how each adapter ended up exposing its history, and the observer tasks depend on probes of native runtimes that must be recorded first.

**Goal:** A journal exists and is current for sessions the Controller does not hold open. The Controller backfills journals of its recently active sessions without starting a runtime, notices that a journal is behind from catalog confirmations and reconciles it, keeps sessions that a native terminal controls current by observing them read-only, and lets a journal-served browser take control of a session that a native CLI owns.

**Architecture:** Four pieces, each shippable on its own.
1. A read-only history capability on adapters that can read a native session without opening a runtime or taking ownership, and a `JournalSource` that is not an agent manager (`HistoricalSource`), so that the publisher of P1-C1 (`SessionPublication`) publishes a session from history alone.
2. Detection: the journal records when its latest activity happened; the Relay marks it behind when a catalog confirmation (`session_states`, about once a minute) is newer, and asks the Controller to reconcile when a journal-served stream is attached (`journal_reconcile_request`); the Controller also checks its own catalogs.
3. Backfill: an idle Controller creates and refreshes journals of its most recently active catalog sessions within a budget, using only the read-only capability.
4. Observation: a session a native CLI controls is observed read-only (a transcript tail, an observer subscription or polling) and published as it grows; and the Relay opens the Controller stream again after a native resume, so a journal-served browser can take control.

**Tech Stack:** TypeScript, TypeBox through `@orchardworks/agent-remote-protocol`, Vitest 4.1.11, the provider packages, `agent-remote-hosted`.

**Preconditions:** P1-C1 and P1-C2 landed (at least one provider declares the capability, so the end-to-end checks have something to publish). Read `2026-11-15-p1c1-controller-publisher.md` (the publisher, `JournalSource`, Decisions 2, 5, 6, 11 and 12; Task 9 for `attach`, which replaces a publication whose source differs, so a historical source attached for a session whose manager wakes later is handed over to the manager rather than ignored) and `2026-11-15-p1c2-provider-item-identity.md` (the contract and the findings per provider).

**Commands.** As in P1-C1: per-test deadlines with `--testTimeout`, outer deadlines of at most 300000 ms, Lab tests on Node 22, and all work in the worktree `/Users/xian/projects/agent-remote-control/.worktrees/im-session-service`.

## Decisions made in this outline

1. **The head of a journal built from history comes from the catalog.** The serving gate of the Relay is "a journal head exists". A backfilled journal has no live Snapshot, so the Controller builds one from the provider's catalog summary (`RemoteSessionSummary`: provider, native id, state, update time) and the adapter's static capabilities: status `idle` (or `running` and `waiting` as the catalog says), no active turn, no pending interactions, `runtimeInfo.connection` absent (the Relay shows `restoring` while no Controller stream is ready). Its `observedAt` is the catalog's read time, which clients show as "as of". A resident session's real head replaces it at once.
2. **`SessionPublication` changes only in its source.** A session followed by a `HistoricalSource` that later gets a resident manager is handed over through `attach` (P1-C1 Task 9); the publication restarts with the new source and reconciles.
   The rest of `SessionPublication` does not change. It already works over `JournalSource`; a `HistoricalSource` implements the same interface over rows built from observations (as `rowsOf` of the continuity fixture does), `snapshot()` from the catalog, and `loadOlderHistory` from the adapter's older cursor. Backfill and observation reuse reconcile, batching, quota and recovery.
3. **Backfill never starts a runtime and never claims a native session.** It uses `readTimelineSnapshot` only. Providers without it are not backfilled; their journals begin at the first open. It stops when the uplink is down, when a publication of a resident session is queued, or when its budget is spent.
4. **The Controller remembers what it published.** A small file `journal-backfill.json` in the state directory records, per session, the catalog `updatedAt` it last published. A session whose catalog `updatedAt` equals the record is not opened again, so a Controller restart does not reopen every session.
5. **Behind means the catalog is newer than the journal.** The journal core records the time of the latest row it applied (`activityAt`). The Relay compares it with the `updatedAt` of a `session_states` report; equality or older is current. The mark is in memory (a restart of the Relay recomputes it from the next report).
6. **Observation is read-only and best effort.** An observer never writes to the native session, never answers an interaction and never contends for ownership. Where a provider offers no safe observer, the journal is marked behind and reconciled on catalog confirmations, as the design says.

7. **Unfollowed sessions are refused, not left to time out.** A fill or older-history request for a session that neither a manager nor a `HistoricalSource` can serve is answered with `journal_request_refused` (`not_followed`) at once (P1-C1 Decision 12). A journal the publisher cannot keep current is taken out of serving with `journal_unserve` (P1-C1 Decision 11); a backfill or observer that gives up does the same, so clients fall back to crude mode.

## Findings the tasks start from

### Where the code stands

- Catalog confirmations: `createSessionStatePublisher` (`packages/agent-host/src/session-state-publisher.ts`) reads the provider catalogs about once a minute (`SESSION_STATE_CONFIRMATION_MS`), merges them with the live states, and sends `session_states` with each session's `updatedAt` (`HostSessionState`). The Relay receives them in `receiveSessionStates` (`packages/agent-remote-hosted/src/broker.ts`, where `message.type === 'session_states'` is handled).
- Today's history reads without a runtime exist only as text pages for session references (`adapter.readSessionHistory`, `AgentHistoryPage`), not as observations.
- Native owners: a session a native CLI controls fails the Controller stream open with `native_session_owned` (`packages/agent-remote-hosted/src/session-errors.ts`). The journal-served stream (`journal-session-stream.ts`) answers a held `acquire` with the pending state carrying `nativeOwner`, keeps reading, and does not retry by itself. The browser takes control through `RemoteSessionClient.takeControl`: `resumeNative` (an attach with the owner's generation, `packages/agent-remote-lab/src/App.tsx`, through `POST /v1/remote/hosts/:id/attach`), then `waitForNativeControl`, then `take_over`. For a journal-served stream, nothing reopens the Controller stream after the resume.

### Per provider (read of the adapters)

- **OpenCode.** Read-only history: `nativeHistoryPage` (`native-history.ts:5`) then `normalize(page.messages, new OpenCodeImages(id), { startsAtBeginning, sessionId: id })`, about ten lines, one HTTP call per 200 messages (`provider.ts:163` already has `readSessionHistory` without a runtime). Turn ids and supplemental receipts do not exist without a session. Observation: the server's event stream is process-wide (`/api/event`, `transport.ts:95`), each session filters by its id (`session.ts:150`); there is no ownership lease for OpenCode (`native-session-owner.ts` serves Claude and Copilot); the adapter is already a shared observer, but restricted mode is rejected (`provider.ts:39`), and every non-delta event triggers a full latest-page re-read. A permission request raised by the native client appears in the Controller's `permission.request.list` (`session.ts:236`): an observer must not answer or surface it.
- **Codex.** Read-only history: `readCodexHistoryPage(transport, id, { cursor })` (`packages/codex-daemon-client/src/history-page.ts`) then `projectCodexThreadHistory`, as `readSessionSummary` and `readSessionTitle` already open a transport, initialize it, read and dispose (`provider.ts:127-160`). Costs: a transport spawn or daemon attach per read; older servers fall back to `thread/read includeTurns:true` (the whole thread); the projector needs a throwaway `CodexImageRegistry` and `images.stop()`; the live path's `communicationHistory.supplement` (`session.ts:378`) must be replicated or skipped (and then agent-communication content differs from live). Observation: `thread/resume` with `excludeTurns:true` (`client.ts:222`) attaches a connection to a loaded thread, but a resume may reload an unloaded thread or take the writer lock, and takeover signals the owner process (`session-takeover.ts:49`): not an observer. The safe design is polling `readTimelineSnapshot` for externally owned sessions and subscribing only for sessions this Controller owns.
- **Copilot.** Read-only history: `readStoredEvents` (`reference-history.ts:96-135`) reads `<profile>/session-state/<sessionId>/events.jsonl` with `realpath`, `lstat` and `O_NOFOLLOW` guards, an 8 MiB and 4096 event limit and shape validation, then `Projector.prepareHistory` and `projectAll(..., 'history')` (`provider.ts:61-68`); it is about 30 lines to expose as observations but the limits would fail long sessions (the read needs to stream), the existing reader filters sub-agent events and drops interactions (the new one must keep them), and ephemeral events (reasoning, deltas) are not in the file. Observation: tail `events.jsonl`; the reader treats a missing trailing newline as an error (line 128), so a tail holds back a partial last line and re-stats by inode for truncation; ephemeral events are never written, so live reasoning of a native CLI is invisible; ownership is learned through `client.rpc.sessions.checkInUse` (`provider.ts:105-110`) and the lease file under `.arc-session-owners`, which exists only when the CLI was started through the Controller's wrapper.
- **Claude.** Read-only history: `catalog.timelineMessages(id)` (`provider.ts:152`, a worker running the SDK's `getSessionMessages`) then `new ClaudeEventProjector(id, 'history', new ClaudeImageRegistry(id))`, with the P1-C2 change that attaches the raw transcript's `toolUseResult`; cost is a Node subprocess per read, a whole-file parse and a 15 second deadline (`catalog.ts:32`). Observation: tail the transcript `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<dir>/<sessionId>.jsonl` (found by `transcriptFile`, `folded-input.ts:57-67`) with `fs.watch` and an offset reader that holds back a partial last line and resets on truncation; raw rows include `attachment`, `progress`, `queue-operation` and snapshot rows the tail filters as the SDK does; a tail sees only complete blocks, which matches history keys. The owner is learned only from the lease file (`inspectNativeOwner`, `native-session-owner.ts:49`, created by `runManagedStdioCommand` only for an explicit `--resume <id>`); a plain `claude` has no lease.

## File structure

| File | Responsibility |
|---|---|
| `packages/agent-provider-sdk/src/provider.ts`, `item-identity.ts`, `testing.ts` | Modify: `readTimelineSnapshot`, `observeNativeSession`, the capability fields, contract tests. |
| `packages/agent-provider-<name>/src/*` | Modify per provider task: the read-only reader and the observer. |
| `packages/agent-host/src/journal-historical-source.ts` (+ test) | Create: `HistoricalSource`, a `JournalSource` over history rows and a catalog head. |
| `packages/agent-host/src/journal-backfill.ts`, `journal-backfill-record.ts` (+ tests) | Create: the budgeted scheduler and the persisted record. |
| `packages/agent-host/src/native-session-observer.ts` (+ test) | Create: starts and stops observers for sessions a native CLI controls. |
| `packages/agent-host/src/journal-publisher.ts`, `journal-publication.ts`, `host.ts` | Modify: attach historical sources, answer `journal_reconcile_request`, wire backfill and observers, native-owner transitions. |
| `packages/agent-remote-protocol/src/remote-host-journal.ts`, `remote-host-uplink.ts` (+ tests) | Modify: `journal_reconcile_request`. |
| `packages/agent-remote-journal/src/session-journal.ts`, `types.ts` | Modify: `activityAt`. |
| `packages/agent-remote-hosted/src/host-journals.ts`, `journal-uplink.ts`, `journal-behind.ts`, `journal-sessions.ts`, `journal-session-stream.ts`, `broker.ts` (+ tests) | Modify and create: behind marking, the reconcile request, the Controller stream retry after a native resume. |
| `docs/blueprint/agent-remote-observation.md`, `docs/current/agent-remote/protocol.md`, `providers.md` | Modify. |
| `packages/agent-remote-lab/compatibility.json` | Generated. |

---

### Task 1: The read-only history capability in the SDK

**Files:** `packages/agent-provider-sdk/src/provider.ts`, `item-identity.ts`, `testing.ts`, `item-identity.test.ts`, `contract.test.ts`.

**Interface:**

```ts
/** Reads a native session's history without opening a runtime, starting a process the session needs, or taking ownership. */
readTimelineSnapshot?(nativeSessionId: string, query?: { cursor?: string }): Promise<{
  /** Oldest first, delivery 'history', every timeline observation with an item identity that completes its item. */
  observations: ProviderObservation[];
  /** The cursor of the next older page; absent when this page reaches the start. */
  olderCursor?: string;
}>;

/** Follows a native session that another client controls, read-only: no write, no answer to an interaction, no ownership. Observations are 'live' and carry item identities. */
observeNativeSession?(nativeSessionId: string, handlers: {
  observation(item: ProviderObservation): void;
  /** The reader lost the native side (file removed, server gone); the Controller marks the journal behind and may start again. */
  ended(reason: string): void;
}): Promise<{ stop(): void }>;
```

`AgentJournalCapability` gains `readHistory?: 1` and `observe?: 1`, so the Controller asks `supportsJournalHistory(adapter)` and `supportsJournalObserver(adapter)` rather than testing methods.

**Tests:** `supportsJournalHistory` is true only with the declaration and the method; a contract helper in `testing.ts` (`runReadOnlyHistoryContract`) checks that a reader returns history observations only, that every timeline observation has an identity, that it does not call `observe()` or `createSession`, and that two reads of an unchanged session return equal observations. Commit; build the package.

### Task 2: A journal source that is not an agent manager

**Files:** create `packages/agent-host/src/journal-historical-source.ts` and `journal-historical-source.test.ts`; modify `packages/agent-host/src/journal-publisher.ts` (`attachHistorical`).

**Interface:**

```ts
export function createHistoricalSource(options: {
  providerId: string;
  nativeSessionId: string;
  adapter: Pick<AgentProviderAdapter, 'readTimelineSnapshot'>;
  /** The catalog's summary of the session, for the head. */
  summary(): Promise<RemoteSessionSummary | undefined>;
  now(): number;
}): JournalSource & {
  /** Reads the newest page again; rows already known are not duplicated. Resolves with how many rows are new. */
  refresh(): Promise<number>;
  /** Appends observations from an observer, as live rows. */
  feed(observation: ProviderObservation): void;
  close(): void;
};
```

It builds `CanonicalTimelineRow`s from observations (the construction of `rowsOf` in `test-utils/journal-continuity.ts`, moved to `journal-items.ts` and shared), keeps them in a `TimelineStore`-like ordered list keyed by source key and revision (so a refresh never duplicates), implements `subscribeJournal` (rows now, taps for rows added by `refresh` and `feed`), `loadOlderHistory` through `olderCursor`, `attentionItemKey` as the last item, and `snapshot()` as the catalog head of Decision 1.

**Tests (over a fake adapter and the relay loopback of P1-C1):** a session never opened is published as a journal with a head and items; a refresh with one new item publishes one append and one head; a refresh of an unchanged session publishes only a head; `feed` publishes live rows through the batcher; `loadOlderHistory` pages older history into a prepend; the catalog head carries the summary's state and update time; no `createSession` or `observe()` is ever called (the fake adapter throws if they are).

### Task 3: Detection: activity time, behind marking and the reconcile request

**Files:**
- Modify `packages/agent-remote-journal/src/session-journal.ts`, `types.ts` (`JournalMeta.activityAt`: the latest `occurredAt` among rows applied by `append`, `correct`, `replace` and `prepend`; a getter `activityAt`).
- Modify `packages/agent-remote-protocol/src/remote-host-journal.ts`, `remote-host-uplink.ts`, `remote-host-journal.test.ts` (`journal_reconcile_request`, Relay to Host: `{ requestId, sessionKey }`; part of `JournalRelayMessage`).
- Create `packages/agent-remote-hosted/src/journal-behind.ts` (+ test): an in-memory map of sessions whose catalog `updatedAt` passed the journal's `activityAt`, fed by `receiveSessionStates`.
- Modify `packages/agent-remote-hosted/src/host-journals.ts` (`activity(hostId, sessionKey)` answered from memory), `journal-uplink.ts` (`requestReconcile`), `journal-sessions.ts` (when a journal-served stream attaches to a behind session, ask the Controller to reconcile, one request per session at a time), `broker.ts` (wire both).
- Modify `packages/agent-host/src/journal-publisher.ts` (`receive` handles `journal_reconcile_request`: a resident session restarts its publication; a session with a history reader publishes from history; one with neither answers nothing). A `journal_fill_request` or `journal_older_request` for a session the Controller does not follow also attaches a short-lived `HistoricalSource` of Task 2, answers through the same code as for a resident session, and releases it after 30 seconds without a request; this is how fills prefer the read-only capability over opening a runtime.

**Tests:** core (`activityAt` follows appends, corrections and replacements, and survives a store round trip); protocol (the new message round trips and rejects extra fields); hosted over the in-memory transport (`session_states` with a newer `updatedAt` marks behind, an equal one does not; attaching a stream to a behind session sends exactly one `journal_reconcile_request`; a Host that is offline gets none and the stream is served as the journal holds it); Controller over the loopback (a request for a resident session restarts its publication, for a backfillable one publishes from history).

### Task 4: Backfill and the Controller's own detection

**Files:** create `packages/agent-host/src/journal-backfill.ts`, `journal-backfill-record.ts` and tests; modify `host.ts` and `session-state-publisher.ts` (the confirmation hook).

**Behaviour:**
- On every catalog confirmation (the hook in `confirm()`), compare each journal-capable session's catalog `updatedAt` with the record; sessions that are newer or unrecorded join a queue ordered by `updatedAt`, newest first.
- A worker takes one session at a time while the uplink holds the grant and no resident publication has a queued batch: it creates a `HistoricalSource`, attaches it to the publisher (`attachHistorical`), waits until it is live, drains, releases it and records `updatedAt`.
- Budget (constructor options with these defaults): at most 4 sessions per confirmation cycle, 200 sessions in total per Controller start, 8 MiB of published bytes per cycle, and a 30 second deadline per session; a session that fails is recorded with a retry time (exponential, up to 6 hours).
- Never for a session that is resident (the publisher already follows it), never when `supportsJournalHistory` is false, and never starts a runtime.
- The record file is written atomically after each session.

**Tests (fake clock, fake adapters, relay loopback):** the newest sessions are backfilled first and the budget stops the rest; a restart with an unchanged record opens nothing; a changed `updatedAt` refreshes only that session; a resident session is skipped; a provider without the capability is skipped; the uplink going down pauses and resumes; a failing session backs off; no runtime is started (the adapter's `createSession`, `resumeSession` and the directory's `open` throw if called).

### Task 5: Read-only history per provider

One task per provider, in the order OpenCode, Codex, Copilot, Claude. Each implements `readTimelineSnapshot` as described in the findings, declares `readHistory: 1` last, and proves it with:
1. A unit test over the provider's own doubles that the reader opens no session and starts no runtime (the doubles throw on `createSession`, `resumeSession`, `observe()` and, where applicable, on spawning the native CLI beyond what the reader itself needs).
2. A continuity test: the reader's observations for a recorded session equal the history observations of a reopened session (same keys, same digests), so the journal built by backfill is the journal a later live session continues.
3. A bounds test: a session larger than the reader's page is read in pages with `olderCursor`; the Copilot reader streams instead of failing at 8 MiB or 4096 events.

Files per provider: OpenCode `packages/agent-provider-opencode/src/provider.ts` (+ `native-history.ts` use); Codex `packages/agent-provider-codex/src/provider.ts`, `history.ts` (`CodexImageRegistry` lifetime); Copilot `packages/agent-provider-copilot/src/reference-history.ts` (a streaming `readStoredEvents`), `provider.ts`; Claude `packages/agent-provider-claude/src/provider.ts`, `catalog.ts`, `catalog-worker.ts`. Update the provider's documents.

### Task 6: Observation of sessions that a native CLI controls

**Files:** create `packages/agent-host/src/native-session-observer.ts` and test; modify `packages/agent-host/src/host.ts`, `native-session-owner.ts` (an event when an owner appears or leaves), `journal-publisher.ts`; per provider `observeNativeSession`.

**Behaviour:**
- When a session of a journal-capable provider is owned by a native CLI (the existing `inspectNativeOwner`/`NativeSessionOwnerError` paths, and the lease polling the Controller already does), the Controller closes its own manager as it does today, and the observer starts: a `HistoricalSource` is refreshed once (catch up) and then fed by the provider's observer; the publisher follows it exactly like a resident session.
- When the owner leaves (the lease disappears) or the Controller takes the session over, the observer stops and the resident path resumes (the manager is created, the publisher attaches, and reconciliation continues the same journal).
- Per provider: **Claude** tails the transcript (offset reader, partial-line hold-back, truncation reset, row filtering as the SDK does); **Copilot** tails `events.jsonl` the same way; **Codex** polls `readTimelineSnapshot` (every 3 seconds while the session is observed, 30 seconds when idle) and never resumes the thread; **OpenCode** subscribes to the shared event stream as a restricted observer that ignores permission and question requests and refreshes the latest page on non-delta events, bounded to one read per second. Providers that cannot do it safely leave `observe` undeclared, and their journals are marked behind and reconciled on catalog confirmations.
- An observer that ends (`ended`) marks nothing by itself; the next catalog confirmation sees the journal behind, and the observer is started again with backoff.

**Tests:** over scripted transcripts and files in a temporary directory: a growing transcript publishes appended items and completes them; a partial last line is not published until its newline; a truncated file resets the tail and reconciles; ownership appearing starts the observer and the manager closes; the owner leaving stops it; an observer never writes (the files are opened read-only, asserted through a wrapper that fails on write flags); the Codex poller never calls `thread/resume`.

### Task 7: Taking control of a native-owned, journal-served session

**Files:** modify `packages/agent-remote-hosted/src/journal-session-stream.ts`, `journal-sessions.ts`, `broker.ts`; tests in `journal-session-stream.test.ts`, `journal-sessions.test.ts`, `broker-journal-sessions.test.ts`.

**Behaviour:** after the broker's attach route succeeds for a session (the route the browser's `resumeNative` calls, with or without the owner generation), `JournalSessions.sessionAttached(hostId, sessionKey)` tells each journal-served stream of the session to try its Controller stream again: a stream whose last attempt failed with `native_session_owned` (or any other refusal that was not final for another reason) clears its `waitingForHost` and refusal state and calls `ensureHost()`. The Controller's real `session_control` then reaches the browser, which is what `waitForNativeControl` waits for, and the browser's `take_over` is forwarded. A stream with no held request does not open the Controller stream unless an operation arrives (the Relay does not keep a stream open for readers).

**Tests:** with a fake Controller that refuses the first open with `native_session_owned` and accepts the second: the browser sees the pending state with `nativeOwner`; after a simulated attach the Relay opens the Controller stream, forwards `session_control` with the real revision, and a following `take_over` request reaches the Controller with the rewritten revision; a stream that never asked for control does not open a Controller stream after the attach.

### Task 8: Documents, compatibility, suites and the local instance

- Documents: `docs/blueprint/agent-remote-observation.md` (the read-only history capability and observation under the Provider Contract), `docs/current/agent-remote/protocol.md` (the reconcile request, behind marking), `docs/current/agent-remote/providers.md`.
- `pnpm compatibility:update` then `pnpm compatibility:check`.
- Suites with deadlines: provider packages, `agent-remote-journal`, `agent-remote-protocol`, `agent-remote-relay`, `agent-remote-hosted`, `agent-remote-controller`; Lab on Node 22.
- Local instance (`.agents/skills/prepare-arc-local/SKILL.md`, `ARC_LOCAL_JOURNALS=1`, smart reading on for a capable provider): (1) with several sessions of the provider in the instance workspace and no runtime started for them, start the Controller idle and watch the Controller log: journals appear in `journals.sqlite` for the newest sessions within the budget, and no native process for those sessions starts (process list before and after); (2) open one of them in a fresh browser context: content appears from the journal without a Controller attach (T2); (3) append to a session from outside the Controller (a native CLI turn, with the session left released) and wait for the next catalog confirmation: the journal grows or, when the Relay marks it behind, a journal-served attach asks for a reconcile and the page catches up; (4) start a native terminal session of Claude or Copilot with the Controller observing, send a message in the terminal, and watch the page follow without taking control; (5) take control from the page: the Relay shows the native owner, `resumeNative` and `take_over` succeed, and the page continues with no reset.

## Open risks

- **Head freshness.** A backfilled journal's head says "idle as of the catalog's read time". A session that is running natively shows idle until the next confirmation; the Relay's presence and the "as of" time are the only cues, and P1-D has to show them.
- **Read cost.** Claude and Codex readers spawn a process or attach a transport per read; the budget bounds them, but a Host with hundreds of large sessions spends its first minutes on backfill. The defaults are conservative and configurable.
- **Observation correctness.** A transcript tail sees only complete blocks, a Copilot tail cannot see ephemeral events, Codex is polled, OpenCode refreshes whole pages: each lags or lacks live detail. This matches the design's statement that observation keeps journals current, not live.
- **Ownership signals.** Claude and Copilot owners are known only through the wrapper's lease; a plain native CLI is discovered by the transcript growing while the Controller holds no runtime, so the observer may start for a session nobody owns, which is harmless.
- **Native resume timing.** The Relay retries the Controller stream once after the attach succeeds; a Controller that needs longer answers the retry with a refusal, and the browser's own acquire retries then.

# S1 and S2: journal simplification implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax. This plan states interfaces, deletions and acceptance tests, not code, under the rules in the [roadmap](2026-11-15-im-session-service-roadmap.md) ("Revised order after the simplification assessment"). The [assessment](../specs/2026-11-16-journal-simplification.md) names every mechanism; read its Sections 2, 3.3 and 4 first.

**Goal:** Remove the dead and duplicate journal pieces (S1), then make the Relay decide how a Controller's window joins the journal: continue, append or replace once (S2, the server half of "replace when in doubt").

**Architecture:** The Provider SDK, the public Remote protocol, the Relay's journal service, the adapters and the client stay separate. S1 changes only Relay and Controller internals and the handshake. S2 changes one wire contract (Controller to Relay) and the code on both ends of it; the client protocol is untouched. The client half (item keys, keeping unchanged rows) is S4, not this plan.

**Tech stack:** TypeScript, Vitest, TypeBox schemas, Node `node:sqlite` store, Cloudflare Durable Object partition (not deployed).

---

## 1. Rules, owner decisions and gates

Owner decisions of 2026-11-16 that this plan implements: T6 is met by "replace when in doubt" plus a client that keeps unchanged rows (S4); an interrupted partial item that native history never recorded may disappear, so `seal` goes; Relay-owned control is S5.

Plan rules: every decision states its **State** (fields +N/-M, recovery paths +N/-M); every task has a deletion list; prefer an invariant over a guard; a bound cites a measurement or becomes one hard cap.

**Worktree.** `/Users/xian/projects/agent-remote-control/.worktrees/im-session-service`, branch `design/im-session-service`, HEAD `33b1c80c` or later, clean. Never touch the main checkout. Use free ports for any local validation.

**Environment for every command.**

```
cd /Users/xian/projects/agent-remote-control/.worktrees/im-session-service
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
```

**Per-package suite** (always with a per-test and an outer deadline):
`timeout 600 pnpm --filter <name> exec vitest run [files] --testTimeout=10000`.
Names: `@orchardworks/agent-remote-protocol`, `-journal`, `-journal-sqlite`, `-hosted`, `-controller` (directory `packages/agent-host`), `-relay`, `-cloudflare` (use `pnpm test:cloudflare`), `-lab`, `-web`. The root `pnpm test` and `pnpm test:conformance` already enforce both deadlines.

**Gate G, the end of every task:**

1. The task's named suites pass.
2. `timeout 900 pnpm typecheck`.
3. `timeout 300 pnpm compatibility:update && timeout 300 pnpm compatibility:check`.
4. `git --no-optional-locks diff --shortstat HEAD -- packages` recorded in the task's notes (expected line deltas below).
5. Commit in the worktree: `git add -A packages docs && git commit` with the task title and its State line. Never push.

**Gate S1 and Gate S2** (end of Task 6 and end of Task 11): `timeout 3000 pnpm test`, `timeout 900 pnpm test:conformance`, `timeout 900 pnpm test:cloudflare`, then Gate G.

**Preconditions, checked once before Task 1:**

- [ ] `git status --short` is empty and `git log -1 --format=%h` is `33b1c80c` or later.
- [ ] No provider declares the journal capability: `git grep -n "journal:" -- 'packages/agent-provider-*/src' ':!*.test.ts'` prints nothing. So no Controller asks for journals, and S1/S2 may change the journal wire without a compatibility bridge. If it prints a provider, stop: the wire then needs a version bump and an upgrade notice to the owner (the owner's rule: compatibility only through an upgrade).
- [ ] `git grep -n "journal=" main -- 'packages/agent-remote-relay/src' 'packages/agent-remote-hosted/src/broker.ts'` prints nothing: the journal query was never on `main`.
- [ ] Baseline counts, saved in the task notes: `wc -l` of every file in the "Where the lines go" table (Section 7) and the publisher field count: `grep -cP '^  private (?!readonly)(?!async)(?!get )\w+\s*[:=;]' packages/agent-host/src/journal-publication.ts` (33 at HEAD; the assessment's 36 counted differently, this command is the budget's definition).

## 2. The result of the interaction-frame check (assessment 3.3)

Verified by reading the client and Relay, before any change. **No client behaviour needs the dedicated `interaction_requested`, `interaction_resolved` and `interaction_invalidated` frames when the head carries the pending interactions.** So Task 6 stops forwarding them on journal-served streams and deletes the hold. Evidence the executor must re-check in Task 6 step 1:

- `packages/agent-remote-web/src/replica/reducer.ts:56-80`: `applyAgentSnapshot` sets `pendingInteractions` from every `agent_snapshot` and `agent_update`; the frame handlers only add local revisions that the next snapshot supersedes.
- Every consumer reads `state.pendingInteractions` or the snapshot: `react/AgentTimeline.tsx:224`, `agent-remote-lab/src/App.tsx:3075`, `conversation-activity.ts:19`, `ReplicaInspector.tsx:38`. None subscribes to a frame.
- `remote-session-client.ts:715-724` passes the frames to the replica; its `resolvePendingOperation(requestId, message)` on `interaction_resolved` resolves nothing, because every pending operation's `matches` asks for `command_acknowledged`, `resource_*` or `command_*` (see `remote-session-client.test.ts:985-1010` and `:910-920`). `respondToInteraction` rejects only when the replica lacks the request, which the head fills.
- `journal-publication.ts` `apply('agent_state')` marks the head urgent when the pending set changes (`pendingKey`), and `headOp()` reads `source.snapshot()` at flush time. The publisher therefore already puts every pending change into the next head within one flush.
- `journal-session-stream.ts` `READ_PATH_FRAMES` already drops the other frames the head and journal answer; the three interaction frames join that set.

The visible difference is timing only: an answered question leaves the browser with the next head (one store write, no hold of up to 2 s) instead of with the Controller's frame. Crude mode is untouched.

## 3. Decisions and state accounting

"Fields" counts state a reader must hold in mind: persisted fields, mutable class fields, maps and flags. "Paths" counts recovery paths. The final column of each row is checked by the task named in it.

| # | Decision | Fields | Paths | Task |
|---|---|---|---|---|
| D1 | One journal version, `journal=1`, checked at the handshake. The Relay never waits on the partition: the partition proxy asks its version before the first `open` of a Host and refuses the open when it cannot answer. Older partitions never see an operation they do not know, because every operation follows an open. | -4 (`host.journalGrant`, `journalLevel`, `capabilitiesPending`, `failedAt`), +1 (`verified` set) | -5 (grant-2 close, 3 s wait close, version-1 downgrade, 30 s retry, capability failure close), +1 (refused open) | 1 |
| D2 | Head-index read discard removed. Self-healing stays: a stream that finds no head calls `unserve`, closes 1012, and the client reconnects crude. | -2 (`epochs` in service and proxy), -2 retry loops | -2 | 2 |
| D3 | `quotaFenced` removed if the existing contiguity makes it redundant (proved first). | -1 map | -1 | 3 |
| D4 | Durable deletion: one sequential loop over `journalDeletions` with a deadline per call, idempotent. The restored Host's bounded wait stays. | -6 broker variables (`revokeCounts`, `deletionsInFlight`, `deletionConfirmations`, `confirming`, `triedDeletions`, `deletionWorkers`) and 1 constant; -2 in the service and -2 in the proxy (`deletionsRunning`, `deletionWaiters`); +1 (`draining`) | -4 (worker hand-off, in-flight sharing, batched confirmation, revoke-count compare), +1 (call deadline) | 4 |
| D5 | Head lane and four open slots removed. The byte cap of the shared budget stays. | -2 queues/counters (`waitingHeads`, `usedByHeads`), -1 pool (`opens`), -2 limits (`inFlightMessages`, `concurrentOpens`), -1 context method (`openSlot`) | 0 | 5 |
| D6 | Interaction frames not forwarded on journal-served streams; the hold deleted. Invariant: pending interactions reach a browser only through heads, and the publisher sends a head at once when the pending set changes. | -1 queue with timers, -1 variable (`servedHead`), -3 constants, -2 functions | -2 (expiry release, overflow release) | 6 |
| D7 | `sync`: the one place that compares a Controller's window with the journal tail. Identical continues; identical plus new items at the end appends; anything else is one replacement that carries live-only items. The Relay trims the window to the quota first. `incomplete` stays as one persisted flag, "accept only a replacement". | core +1 method, +0 persisted fields | +1 compare site | 7 |
| D8 | `window` entry replaces `replace`; the Relay always admits it (trimmed, never refused), and reports `trimmed` and the outcome. `journal_older_request` carries `beforeItemKey`, because the Controller no longer holds an index. | wire +2 fields (`beforeItemKey`, `JournalStatus.oldestItemKey`), +1 result field | 0 | 8 |
| D9 | The Controller sends its newest window on every open and recovers by reopening. It reads no index, keeps no digest cache, and never sends an empty window unless native history is exhausted. | 33 -> 19 mutable fields; 5 readonly collections -> 1 | 14 -> 5 | 9 |
| D10 | Everything the new rule makes unnecessary is deleted: `correct`, `seal`, `expectedRevision`, `stale_revision`, per-item `revision`, index paging and messages, `reset`, `index_too_large`, `planReconcile`, `JournalIndexEntry`, the 100,000-item cap, four per-item refusal reasons. | -2 persisted fields (`revision`, `lastRevision`), -5 wire entities | 0 | 10 |

Where a decision adds state (D1 `verified`, D4 `draining`, D7 `sync`, D8 two fields) it replaces at least four things of the same kind, as the rows state.

**Recovery outcomes of the Controller publisher after Task 9 (budget 6):** (1) reopen with backoff after any refusal, timeout, lost connection, held-event overflow or unencodable message; (2) reopen at once after a provider rebuilt its timeline; (3) a refused open waits for the next connection; (4) a head that cannot be encoded gives up and unserves; (5) a provider that breaks the identity contract gives up and unserves. **Mutable fields after Task 9 (budget 20):** `phase, cycle, subscription, generation, connected, sequence, waiter, queue, headDirty, urgent, headPending, flushTimer, retryTimer, lane, restarts, liveSince, identityBreach, rebuilding, requests` = 19.

## 4. Invariants that replace guards

1. **Contiguous sequences make fences redundant.** A refused entry never consumes its sequence; every later entry of that generation is `sequence_gap`, or `incomplete` if it re-sends the refused sequence. So no extra per-generation fence is needed (D3).
2. **A pending-deletion id receives no journal.** `registered()` grants no journal to a Host whose id is in `journalDeletions`, and the service refuses opens for a deleted Host. So a revoke that overlaps a deletion has nothing new to delete, and a deletion may be confirmed as soon as its call returns (D4).
3. **Per-Host FIFO in the service.** A late deletion cannot overtake a later one for the same Host, so an abandoned (timed-out) call cannot delete journals created after its id was cleared.
4. **A window is always admitted.** The Relay trims it to the room and carries live-only items, so no quota can refuse the recovery step. A quota refusal of a growing live entry marks the journal `incomplete`; the next open's window then replaces it. No ladder, no streak, no give-up counter.
5. **Replace is the one fallback.** Any doubt in `sync` (a mismatch, an open item, a missing item, a gap, a changed room, an anomaly) is a replacement; any failure on the Controller is a reopen that sends the window again.
6. **The head is the only source of pending interactions on a journal-served stream** (D6).

---

## 5. S1: remove dead and duplicate pieces

Nothing user-visible changes in S1 except the timing note in Section 2. Each task is independent and leaves the repository green; keep the order, because Task 5 and 6 edit files that Task 1 to 4 touch less.

### Task 1: one journal version, checked at the handshake (D1)

**Files**
- `packages/agent-remote-protocol/src/remote-host-journal.ts`: add `JOURNAL_VERSION = 1` (the single version). `remote-host-uplink.ts:67`: `registered.journal` is `Type.Optional(Type.Literal(1))`.
- `packages/agent-remote-relay/src/transport/remote-host-uplink-client.ts` (lines 185, 315, 350): ask `journal=1`; the grant is `decoded.value.journal === 1`.
- `packages/agent-remote-hosted/src/broker.ts`: `register(..., journalRequested: 0 | 1)` and the parse at line 2259 (`journal === '1' ? 1 : 0`, so any other value asks for nothing). Delete `journalLevel`, `capabilitiesPending`, `JOURNAL_CAPABILITIES_WAIT_MS`, the `journalLevel === undefined` block in `registered()`, `host.journalGrant` (type, reset at line 827, assignment at 911), the grant-2 `closeConnection` at line 1102 and the `needsJournalGrantTwo` import. `registered` carries `journal: 1` when `host.journal` exists.
- `packages/agent-remote-hosted/src/journal-uplink.ts`: delete `needsJournalGrantTwo`. In `receive('journal_open')`, when the result is `refused: 'unavailable'` and the connection is still current, send `journal_open_refused` (reason `invalid` until Task 10 renames it).
- `packages/agent-remote-hosted/src/host-journals.ts`: delete `JournalCapabilities`, `JOURNAL_CAPABILITIES`, the `capabilities` method and its implementation; remove the export from `index.ts`.
- `packages/agent-remote-hosted/src/journal-partition.ts`: `JournalPartitionApi.capabilities(hostId)` stays and returns `{ journal: JOURNAL_VERSION }` from `serveJournalPartition` without involving the service. In `createPartitionJournals` delete `isMissingMethod`, `VERSION_ONE_PARTITION`, `CAPABILITIES_RETRY_MS`, `capabilitiesOf`; add `verified: Set<string>` and `ensureVersion(hostId)`, called only inside `open` (inside the Host's queue). A failed or different answer returns `{ refused: 'unavailable' }` and is not cached; success is cached for the life of the proxy.
- Query and fixtures: `journal=2` becomes `journal=1` in `broker-heartbeat.test.ts`, `broker-journals.test.ts`, `agent-remote-lab/src/server/devbox.test.ts`.

**Interfaces after:** handshake `?journal=1` -> `registered.journal: 1` (only when the Relay has a journal service); `HostJournals` has no `capabilities`; `JournalPartitionApi.capabilities` is the one Relay-to-partition version check, used before an open.

**Tests**
- Delete: `broker-journal-grant.test.ts` cases for level 1 downgrade, missing method, 1013 on failure and 1013 on three-second timeout; `journal-partition.test.ts` "reads the capabilities of a partition once, and counts a partition without the method as version 1" and "throws a failure that is not a missing method..."; the cloudflare test "recognises an older partition that has no capabilities method, and grants such a Controller level 1".
- Rewrite: `broker-journal-grant.test.ts` to three tests over a real socket pair: grant `journal: 1` to a Controller that asks `journal=1`; no grant for no ask or `journal=2`; no grant without a store. Cloudflare "reports its capabilities" expects `{ journal: 1 }`; update `journal-partition.contract.json` (`capabilities` reply `{ "journal": 1 }`).
- New acceptance: (a) a partition whose `capabilities` throws or lacks the method gets no call but `capabilities` for a Host's open: the Controller receives `journal_open_refused`, nothing is stored, and a later open asks again and succeeds once the partition answers `{journal:1}`; (b) the version is asked once per Host across many opens; (c) a Controller connected over a real transport with `journal=1` opens, publishes and receives `journal_ack` end to end.

**State:** D1. **Lines:** production about -85, tests about -110.

- [ ] Step 1: write the three new acceptance tests and the three rewritten grant tests; run `timeout 300 pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/broker-journal-grant.test.ts src/journal-partition.test.ts --testTimeout=10000`; expect failures.
- [ ] Step 2: make the changes above; run the same suites, then `-protocol`, `-relay` (client tests), `-cloudflare` and `-lab` `src/server/devbox.test.ts`.
- [ ] Step 3: delete the listed tests; Gate G; commit.

### Task 2: the head-index read discard (D2)

**Files**
- `host-journals.ts`: delete `epochs`, `bump` and every call (`open` x2, `unserve`, `unserveHead`, `deleteHost` x2). `loadHost` keeps one shared load in `loading`, reads the listing once and adopts it only if `!hostsLoaded.has(hostId)`.
- `journal-partition.ts` proxy: the same for its own `epochs`, `bump` (including the `catch` in `publish`) and its three-attempt loop in `loadHost`. `heads.load` stays a merge.
- Keep: `JournalHeadIndex`, `unserve`, `noHead`, `readFailed`, the 2 s gate wait, the `hostsLoaded` guard that stops a listing from overtaking a deletion.

**Tests**
- Rewrite `host-journals-bounds.test.ts` "discards a listing that a deletion overtook" (the `hostsLoaded` guard now carries it) and `journal-partition.test.ts` "discards an answer that a deletion overtook".
- Delete the two "discards a listing/answer that a head change overtook" tests (`host-journals-bounds.test.ts` and `journal-partition.test.ts`).
- New acceptance, real transport (`broker-journal-sessions.test.ts`): a listing taken before a quota refusal cleared a head lists the session as served; a browser opening it finds no head, the Relay calls `unserve`, the stream closes 1012, and the reconnect is read through the Controller (crude); the session is served again only after a publication sets a head. A listing that lacks a session that gained a head keeps the head (`load` merges).

**State:** D2. **Lines:** production about -35, tests about -25.

- [ ] Step 1: write the acceptance test (it passes before and after: it pins self-healing); Step 2: make the changes; run `-hosted` suites `host-journals-bounds`, `journal-partition`, `broker-journal-sessions`, `journal-sessions`; Gate G; commit.

### Task 3: `quotaFenced` (D3)

**Files:** `host-journals.ts` only: the `quotaFenced` map, its check at the top of `publish`, its `set` in the quota branch, its clearing in `deleteHost`.

**Proof first (stop condition).** Write, in `host-journals-bounds.test.ts`, one test over the real service with a limit small enough to refuse an append: after the refusal (1) the rest of the same message is not applied; (2) the next message with the next sequence is refused as `sequence_gap`; (3) the next message that re-sends the refused sequence with a non-window entry is refused as `incomplete`; (4) a replacement re-sent at the refused sequence by the same generation is applied (the only observable difference from the fence, and the recovery the new design wants). Run it against the current code: (1) to (3) must pass without the fence mattering (remove the fence locally and re-run). If any of them applies an entry after a refusal, stop and keep the fence with a note here.

**Tests:** delete "forgets the fence of a deleted Host, so the fresh generation 1 of the same Host id publishes". Rewrite "refuses everything the generation publishes after a quota refusal, so a head cannot serve a journal with a hole" to expect `sequence_gap` or `incomplete`, never an applied entry, and the head never served.

**State:** D3. **Lines:** production about -10, tests about -20.

- [ ] Steps: write the proof test; run it with and without the fence; delete the fence; run `host-journals-bounds`, `host-journals`, `broker-journal-switch`; Gate G; commit.

### Task 4: sequential idempotent deletion (D4)

**Files**
- `broker.ts` (about lines 2310-2420): delete `JOURNAL_DELETION_CONCURRENCY`, `revokeCounts` (declaration, `set` at revoke, `delete` on confirmation), `deletionsInFlight`, `deletionConfirmations`, `confirming`, `confirmQueuedDeletions`, `triedDeletions`, `deletionWorkers`, `startDeletionWorkers`. Add:
  - `deleteOne(hostId): Promise<boolean>`: calls `service.deleteHost(hostId)` raced against a deadline (`options.journalDeletionTimeoutMs ?? 30_000`), then, only if the call returned in time, one `commit` that removes the id from `journalDeletions` if it is still there. Never rejects; a failure or a deadline records `journal_store_failed` and leaves the id pending.
  - `drainJournalDeletions()`: a single loop that takes the next id of `journalDeletions` not yet tried in this pass, calls `deleteOne`, and clears `draining` synchronously at the moment it finds no untried id (so a revoke that arrives in the same tick starts a new pass). `retryJournalDeletions()` is `drainJournalDeletions()`.
  - Callers unchanged: start (`if (journalDeletions.length > 0)`), registration (`retryJournalDeletions()` after `host.ready`), revoke `publish()`, and the restored Host's bounded wait (`deleteOne(ownId).then(resume)` under the existing `journalDeletionWaitMs`).
- `host-journals.ts` and `journal-partition.ts`: delete `HOST_DELETIONS_AT_ONCE`, `withDeletionSlot`, `deletionsRunning`, `deletionWaiters`; `deleteHost` is just its `serialized` body.
- Keep: `journalDeletions` in broker state and `state.ts` (bound 1,024 with the oldest dropped and `journal_deletion_dropped`: it is already one hard cap with a refusal-free fallback), the gate that grants no journal to a pending id.

**How the two scenarios stay safe.**
- *A call that never answers:* the loop is sequential, so a hung id would hold the loop; the per-call deadline abandons it for this pass, the id stays pending and is retried at the next start, registration or revoke, and the other ids are deleted. The abandoned call is harmless (invariants 2 and 3): the Host's queue is FIFO, so it finishes before any later deletion of that id, and the id is not cleared until a later call returns.
- *A re-revoke during a deletion:* the pending id receives no journal (invariant 2), so a Host revoked again while its first deletion runs has no journal beyond what that call covers; clearing the id when the call returns is correct, and a second call for the same id (from the retry) is idempotent.

**Tests**
- Delete: "deletes pending Hosts four at a time, and confirmations that wait for a commit share the next one", "never runs more than four store deletions or deletes one Host twice at once...", "asks the journal service for at most four deletions at once from one broker..." (`broker-journal-switch.test.ts`); "deletes at most four Hosts from the store at once" (`host-journals-bounds.test.ts`); "deletes at most four Hosts at once across partitions" (`journal-partition.test.ts`).
- Rewrite: "deletes the journals of a pending Host once, however many asks share the run" (calls may repeat; the store ends empty and the id cleared); "deletes the other pending Hosts and keeps the one whose store call never answers" and "deletes a Host revoked later while another Host's deletion still hangs" (set `journalDeletionTimeoutMs` to 50 ms; the hung id stays pending, the rest are gone, and the loop ends); "does not let a deletion that began before a re-revoke clear the new revoke" becomes "a Host re-revoked during its deletion ends with no journal and no pending id, and a Host that registers after that gets journals that no abandoned call deletes".
- New acceptance (real broker, `MemoryJournalStore` with a controllable `deletePrefix`): 40 pending ids are deleted one after another in one pass with one commit per id; a revoke arriving during the loop is deleted in the same pass; a failure at start is retried when a Host registers; the restored Host registers without journals at its deadline and with them after its own deletion.

**State:** D4. **Lines:** production about -75, tests about -90.

- [ ] Steps: write the rewritten and new tests (they fail on missing option `journalDeletionTimeoutMs` and on the old concurrency); implement; run `-hosted` `broker-journal-switch`, `broker-journals`, `host-journals-bounds`, `journal-partition`, `gateway-journals`, `smart-reading`; `pnpm test:cloudflare`; Gate G; commit.

### Task 5: the head lane and the open slots (D5)

**Files**
- `packages/agent-host/src/journal-publisher.ts`: `createRoom(maxBytes)` keeps one FIFO queue and the byte cap (`used.bytes + needed <= maxBytes`, always admitting one when none is in flight); delete `HEAD_HEADROOM`, `waitingHeads`, `usedByHeads`, the `head` parameter, the `opens` pool, `context.openSlot`.
- `journal-publication.ts`: remove `openSlot()` from `PublicationContext`, `run()`'s slot and its `free()`, `reconcile(token, freeSlot)`'s parameter, the slot in `unserveOnOpen`; `reserve(bytes)` loses `head`; `publish()` stops passing it.
- `PublisherLimits`: delete `inFlightMessages` and `concurrentOpens`; keep `inFlightBytes` (16 MiB): the uplink buffers 16 MiB and `send` throws past it, so the byte cap is correctness (assessment Section 4).

**Tests:** delete "opens at most the allowed number of sessions at a time...", "keeps a session from opening while the allowed number...", "lets a head go out at once while a message that does not fit the shared budget waits"; rewrite "keeps no more messages in flight than the shared budget allows, across sessions" to bytes only. New acceptance (`journal-publisher.relay.test.ts`, real `createHostJournals` through `relayLoopback`): 12 sessions attached at once all go live; the bytes in flight never pass the cap (measure at the writer); a head of one session is acknowledged after at most the messages already in flight (no starvation, no deadlock).

**State:** D5. **Lines:** production about -60, tests about -70.

- [ ] Steps: write the tests; implement; run `-controller` `journal-publisher`, `journal-publisher.relay`, `host-journal`; Gate G; commit.

### Task 6: interaction frames (D6)

**Files:** `packages/agent-remote-hosted/src/journal-session-stream.ts`: add the three frame names to `READ_PATH_FRAMES`; delete `INTERACTION_HOLD_MS`, `INTERACTION_PARKED_MAX`, `INTERACTION_PARKED_MAX_BYTES`, `INTERACTION_FRAMES`, `parkedInteractions`, `servedHead`, `headAgrees`, `releaseInteractionFrames`, `holdInteractionFrame`, the call in `sendHead` and the timer loop in `shutdown`. `hostFrame` no longer branches on them. Keep the publisher's urgent head for a changed pending set (`journal-publication.ts`), which is what makes the head the only source.

**Tests**
- Delete the `describe('interaction frames from the Controller')` block of `journal-session-stream-amendments.test.ts` (about 80 lines).
- New: (1) a Controller frame `interaction_requested` / `resolved` / `invalidated` never reaches the browser; (2) pending interactions arrive only inside `agent_snapshot` / `agent_update`, and an update that lacks one removes it. Real transport (`broker-journal-sessions.test.ts` with the fixture Controller): the Controller publishes a head with a question over the uplink and also sends the frame; the browser socket's frames contain the `agent_update` with `pendingInteractions[0].requestId` and no `interaction_*` frame; after the answer, the next head removes it. Controller side: the existing "publishes a head that carries a new pending interaction at once, not after the batch window" test stays and is the invariant's test.
- Web: add to `remote-session-client.test.ts` one test that the replica gets a question from `agent_update` alone, `respondToInteraction` is accepted, and the next `agent_update` removes it (run under Node 22).

**State:** D6. **Lines:** production about -60, tests about -60.

- [ ] Step 1: re-check Section 2's evidence with `grep -rn "interaction_requested\|interaction_resolved\|interaction_invalidated" packages/agent-remote-web/src packages/agent-remote-lab/src --include=*.ts --include=*.tsx | grep -v test`: only `reducer.ts` and `remote-session-client.ts` may appear. If another consumer appears, keep the hold and record why here.
- [ ] Step 2: tests, then changes; run `-hosted` `journal-session-stream`, `journal-session-stream-amendments`, `broker-journal-sessions`, `journal-sessions`; `-web` `remote-session-client`; `-lab` `pnpm test:conformance`.
- [ ] Step 3: Gate S1 (full suites) and Gate G; commit. Record the S1 totals against the baseline: expected production about -325, tests about -375.

---

## 6. S2: the Relay decides how a window joins the journal

The order keeps every task green: Task 7 adds the core rule beside the old API; Task 8 adds the wire and the Relay's handling beside the old ones; Task 9 moves the Controller, the only client of that wire, to the new rule; Task 10 deletes everything now unused.

### Task 7: `SessionJournal.sync`, the one comparison (D7)

**Files:** `packages/agent-remote-journal/src/session-journal.ts`, `types.ts`, `replacement.ts`, `index.ts`.

**Interface added**

```
sync(publication, window: readonly JournalItemInput[], options: { now: number; roomBytes: number }): SyncResult
type SyncResult = { outcome: 'unchanged' } | { outcome: 'appended'; rows: JournalRow[] } | { outcome: 'replaced'; epoch: string; trimmed: number }
get oldestItemKey(): string | undefined   // the key of the first item that is not live-only
```

**The rule** (this is the whole of "identical continues, extended appends, anything else replaces"):

1. A publication already applied (the watermark rule) returns `unchanged`. A window that repeats a key throws `JournalDuplicateItemError` as before.
2. **Trim.** `T` is the longest newest suffix of `window` whose items, measured as JSON in UTF-8 bytes, fit `roomBytes - liveOnlyBytes()`. It may be empty. `trimmed = window.length - T.length`. Trimming first makes a quota-trimmed journal compare equal to the same window next time.
3. A journal that is `incomplete` is replaced.
4. **Compare `T` with the journal items `J`.** Empty `T` is `unchanged` only if `J` has no item that is not live-only, else replace. Otherwise the anchor is the position in `J` of `T[0]`'s key; absent means replace. Walk `J` from the anchor and `T` from its start: a `J` item that is live-only and whose key is not in `T` is skipped; every other `J` item must equal the next `T` item: same key, same live-only flag, both complete, equal digest. An open item on either side never equals (in doubt, replace). A `J` item left after `T` ends is a missing item: replace. `T` items left after `J` ends are the extension.
5. No mismatch and no extension: `unchanged`. An extension that fits (`residentBytes() + its bytes <= roomBytes`): append its items, complete ones with their digest and open ones without, one sequence each, `appended` with the stamped rows. An extension that does not fit: replace.
6. **Replace** starts a new epoch exactly as `replace` does today, with two changes: only live-only items of `J` whose key is not in `T` are carried (an open item that is not live-only is not carried: `seal` is gone), and an item of `T` whose key is a live-only item of `J` replaces that copy (the alias and background it knew carry over). It clears `incomplete`.
7. `outcome` marks an item touched only when the merged background differs, so a repeated outcome writes nothing.

**Tests**
- New `journal-sync.test.ts` over a real `SessionJournal` and `MemoryJournalStore`: every row of the rule above as a case; restoring from `state()` and syncing again is `unchanged`; the same window and room twice is one write, then none (quota determinism); a larger room replaces once, then is stable; a window item that is a live-only item of the journal replaces its copy; an open window item replaces; an empty window replaces only a journal with items; a duplicate publication is `unchanged`.
- Zero-write property: for a journal built by `sync`, a second `sync` of the same window, then `outcome` with the same background, then `rebind` with the same binding, leave `takeChanges()` with no `upsert`, no `removed` and `replaced: false`; only meta (watermark) changes.
- Keep every old test: the old API stays until Task 10.

**State:** D7: +1 method, +1 getter, 0 persisted fields. **Lines:** production about +95, tests about +180.

- [ ] Step 1: write `journal-sync.test.ts`; run `timeout 300 pnpm --filter @orchardworks/agent-remote-journal exec vitest run src/journal-sync.test.ts --testTimeout=10000`; expect failures. Step 2: implement (`sync`, the internal rebuild shared with `replace`, `outcome`'s no-touch, `replacementOrder`'s live-only-only carry behind a parameter so the old tests still pass). Step 3: run `-journal` and `-hosted` suites; Gate G; commit.

### Task 8: the `window` entry, the older-history anchor and the Relay's handling (D8)

**Files**
- `packages/agent-remote-protocol/src/remote-host-journal.ts`: add the entry `{ sequence, op: 'window', items }` (the shape of `replace`); add `beforeItemKey` (required) to `JournalOlderRequest`. `remote-host-uplink.ts` needs no new message.
- `packages/agent-remote-hosted/src/host-journals.ts`: `apply` case `window` calls `journal.sync(publication, entry.items, { now: now(), roomBytes: roomOf(hostId, sessionKey) })` and maps the result: `appended` to `row` events, `replaced` to one `replaced` event; `JournalPublished` gains `window?: { outcome; trimmed }`. `admission` lets `window` through (the `incomplete` check also allows it) and counts it as a live-only change (so `dropOldestLiveOnly` runs). `JournalStatus` gains `oldestItemKey?` (from `journal.oldestItemKey`).
- `journal-uplink.ts`: after a stored publication, `diagnostic('journal_window_replaced')` when `window.outcome === 'replaced'` and `diagnostic('journal_window_trimmed')` when `trimmed > 0`; `requestOlder(sessionKey, limit, beforeItemKey)` puts it in the message. `relay-diagnostics.ts` and `agent-remote-protocol/README.md` list the two new events (this replaces the Controller's two events that Task 9 removes).
- `journal-sessions.ts`: `older(limit)` reads `journals.status` first; no `oldestItemKey` resolves `{ olderAvailable: false }`; otherwise it calls `requestOlder(hostId, sessionKey, limit, oldestItemKey)`. `JournalSessionsOptions.requestOlder` and the two broker wirings (`broker.ts` lines 785 and 2450) take the extra argument.
- `journal-partition.ts` passes `status` through unchanged; `journal-partition.contract.json` gets a `window` publish step and the `status` reply field.

**Tests**
- New, real `createHostJournals` and a counting `MemoryJournalStore` (`host-journals-window.test.ts`): an identical window sent after N reopens writes no item and keeps the epoch; an extension appends and emits rows; a changed digest replaces and carries a live-only item; `limits.sessionBytes` small trims the window to the newest items that fit, reports `trimmed`, and the same window again is `unchanged`; a quota-refused live append marks the journal incomplete and a `window` from the same generation then recovers it; the two diagnostics fire through `createJournalConnection`; a `journal_older_request` carries the journal's oldest non-live-only key, and a journal with none answers `olderAvailable: false` without a request.
- Keep every old test.

**State:** D8: +2 wire fields, +1 result field, 0 recovery paths. **Lines:** production about +75, tests about +170.

- [ ] Steps: write the tests; implement; run `-protocol`, `-hosted` (`host-journals*`, `journal-uplink*`, `journal-sessions`, `journal-partition`), `pnpm test:cloudflare`; Gate G; commit.

### Task 9: the Controller sends its window and reopens on any doubt (D9)

**Files**
- `packages/agent-host/src/journal-publication.ts` (990 lines to about 520), `journal-reconcile.ts` (180 to about 75), `journal-items.ts` (small), `journal-publisher.ts`, `test-utils/journal-continuity.ts`, `test-utils/journal-relay-loopback.ts`.

**Interfaces after**
- `journal-reconcile.ts`: `windowOp(timeline, digest)` returns `{ op: SizedOp | undefined; items: TimelineItem[]; refused: string[] }`: the newest items that fit one message (`newestItems`, 4 MiB, at most `JOURNAL_ITEMS_PER_ENTRY_MAX`), as one `window` entry; items the wire refuses are left out and named. `outcomeOps(items)` and `rebindOps(items)` stay (idempotent: the core writes nothing for a repeat). `planPublication`, `replacementPlan`, `PublicationPlan`, `ReplaceReason`, `PlanOptions`, `OPEN_DIGEST` are deleted.
- `SessionPublication` keeps its public surface (`resume`, `suspend`, `stop`, `drain`, `receive`, `requestable`, `followed`).
- The cycle: subscribe; open (`journal_open` -> `journal_opened { generation, watermark }`, no index); build the window from the subscription's rows; if the window is empty and `source.hasOlderHistory()`, read older pages up to `gapReadsMax` and rebuild, and if it is still empty send no window (**never replace with an empty window unless native history is exhausted**); publish `[window?, ...outcomeOps, ...rebindOps, head]` in chunks; go live. Rows that arrive meanwhile queue and publish after the head.
- Recovery (`recover`): `Cancelled` ends; `OpenRefused` waits for the next connection; `HeadRejected` gives up and unserves; anything else, any refusal reason, a timeout and a held-event overflow reopens with backoff.
- `answerOlder(request)` uses `request.beforeItemKey`: the complete items older than that key in the manager's timeline, newest `limit` of them, as prepends, reading older native history while there are too few. `answerFill` is unchanged apart from the digest call.
- Digests are computed with `itemDigest(mergedRow(item).item)` where needed; the memo is gone.
- `skipped` stays as the one readonly set: an item the wire refuses, or that a Relay refusal names (`itemKey`), is left out of windows and its live rows are dropped, with one `journal_row_rejected` diagnostic; the refusal then reopens as usual. This is what stops an item the Relay will never accept from looping the reopen: each loop adds one distinct item, so it ends. There is no renumbering and no per-item resend.
- The diagnostic union loses `journal_replacement_published` and `journal_quota_window`. `PublisherLimits` keeps `batchWindowMs, responseTimeoutMs, backoffBaseMs, backoffMaxMs, sustainedMs, heldEventsMax, gapReadsMax, inFlightBytes`.

**Deleted from the Controller:** the index pull (`open`'s pages, `MAX_INDEX_PAGES`, `journalKeys`), `plan`, `items` caching (`checked`, `refusedItems`, `isSkipped`'s refused branch), `digests`/`digestEpoch`, `quotaStep`, `forceReplace`, `resetOpen`, `replaceStreak`, `incompleteStreak`, `olderBlocked`, `MAX_REPLACEMENTS_IN_A_ROW`, `unacknowledgedRebinds`, `carriedRebinds`, `MAX_UNACKNOWLEDGED_REBINDS`, `remember`, `ITEM_REFUSALS`, `namesItem`, `withoutItem`, the renumbering branch of `publish`, `Reopen`, the proactive `older` blocks after the head, `reconciling`, `drainRequests`, `openedInCycle` (a request is answerable when `generation > 0`; `restart` and `suspend` set it to 0).

**Field reductions** (33 -> 19). Do these three last and run the ordering tests after each; if one breaks ordering, keep that field and say so here, but the total must stay at most 20 (merging `heldHeadDirty` into `headDirty` alone gives 20):
- `held` and `heldHeadDirty` merge into `queue` and `headDirty`, bounded by `heldEventsMax`; events that arrive while opening are applied to the queue and flushed at go-live, and `headDirty` is cleared where the window's `headOp()` is built.
- `tasks` and `idleWaiters` go: `drain(timeoutMs)` enqueues one `flush` on `lane` and races its completion with the timeout.
- `connected` stays; `rebuilding` stays (a provider rebuild is not one event).

**Tests**
- Delete: `journal-reconcile.test.ts` (205 lines) and `journal-reconcile.journal.test.ts` (188 lines, replaced below); from `journal-publisher.test.ts` the cases for the paged index (4), the reset open (2), per-item refusal skip and renumbering (4), the quota ladder, `incomplete` streak and `olderBlocked` (8), `replace_loop`, rebind re-sending (3), gap closing with live rows, answering a fill between older blocks, "plans against the whole index"; from `journal-publisher.relay.test.ts` the same families (refused item renumbered, quota window, incomplete, reset open, rebind and older-block cases).
- Rewrite: `journal-publisher.test.ts` "opens the journal, publishes the history as one replacement..." to one `window` entry then the head; "does nothing for a journal that already holds the session, apart from the head" to a window that the Relay answers `unchanged`; the `recovering` block to the universal rule (each refusal reason, a timeout, a lost acknowledgement, `sequence_gap`: one reopen with backoff and a window again); the older-history and fill block to use `beforeItemKey`. `test-utils/journal-continuity.ts`: `continuityOutcome(run)` drives a real `SessionJournal.sync` with the live window and then the reread window and returns `unchanged | appended | replaced`; `expectContinuity` requires `unchanged`, `journal-continuity.test.ts` follows. `journal-relay-loopback.ts` drops `maxIndexItems`; add a counting-store option.
- **New acceptance, `journal-window.journal.test.ts`, real `SessionJournal` and real `createHostJournals` through `relayLoopback`:**
  1. The three live-only and open-item fixtures of `journal-reconcile.journal.test.ts` settle. Same data: `p1, o (open), p2, p3, b1, b2` with `p2`, `p3` large so the window sends only `[b1, b2]`; the journal gets the older items by the Relay's older request; then native history is rewritten inside the window (`b1` changes). Expected for each of (a) an open item `o` older than the block, (b) the quota case (`limits.sessionBytes` that keeps only `[b2]`, so `trimmed` is 1), (c) a provider live-only item `l` older than the block: one `replaced`, the journal holds the window (or its trim) plus `l` carried and no `o` (an interrupted partial item may disappear: the owner's decision), and four more reopens are `unchanged` with no item write.
  2. An open item inside the window replaces on every reopen and costs one window write each; assert exactly that and that live rows continue after it. This is the accepted cost, measured in S3.
  3. A live-only item the reread now also holds replaces the journal's copy once and is then stable; a live-only item that completed while the Controller was away keeps its live-only mark (the port of "keeps the live-only mark...").
  4. Reconnect continuity: five disconnect/connect cycles and five Controller restarts (new publisher, same native history, one live-only item) leave the stored items and epoch deep-equal, and the counting store sees no `upsert`, no `removed` and no `replaced` after the first publication (meta writes only).
  5. Quota trimming end to end: a replacement is trimmed to the newest items that fit plus the live-only items, the Relay's `journal_window_trimmed` fires, the same session reopened N times writes nothing, and live rows keep flowing; a live append refused for quota marks the journal incomplete and the next window recovers it without a ladder.
  6. Never an empty window unless native history is exhausted: with older pages unread and an empty newest page the Controller reads them first; with history exhausted and empty it sends the empty window, which clears an incomplete journal.
  7. The universal fallback: for each injected failure (`quota_exceeded`, a dropped acknowledgement, `sequence_gap`) the session reopens once and ends live with a journal equal to the manager's timeline; a Relay that refuses one named item as `invalid` ends with that item left out of the window, one diagnostic, and every other item present.
  8. Outcomes and rebinds: a background outcome the Controller learned after the rows were published is in the journal after a reopen, and a repeated outcome or rebind writes nothing.
  9. Older history: a `before` page past the journal start makes the Relay ask with `beforeItemKey`; the prepend lands below the oldest item; a missing anchor answers `olderAvailable` from `hasOlderHistory()`.
- Budget check, a command and not a test: the field count command of Section 1 prints at most 20, and the header comment of `journal-publication.ts` states "at most 20 mutable fields and 6 recovery outcomes" with the list in Section 3.

**State:** D9: mutable fields 33 -> 19 (-14), readonly collections 5 -> 1, recovery paths 14 -> 5, diagnostics -2, limits 12 -> 8 (4 of them by Task 5). **Lines:** production about -620, tests about -950 (about -1,500 deleted, +550 new).

- [ ] Step 1: port the three fixtures, the loopback options and the continuity helper; write the new tests and watch them fail. Step 2: rewrite `journal-reconcile.ts`, then `journal-publication.ts`, then the field reductions in the order above, running `timeout 600 pnpm --filter @orchardworks/agent-remote-controller exec vitest run src/journal-publication* src/journal-publisher* src/journal-window.journal.test.ts src/journal-continuity.test.ts src/host-journal.test.ts --testTimeout=10000` after each. Step 3: delete the listed tests; run the whole `-controller` suite; Gate G; commit.

### Task 10: the deletion task: remove what the rule made unnecessary (D10)

Nothing here changes behaviour: after Task 9 no code path uses any of it.

**Protocol** (`remote-host-journal.ts`, `remote-host-uplink.ts`): delete `JournalIndexEntry`, `JOURNAL_INDEX_MAX_ITEMS`, `JOURNAL_INDEX_PAGE_MAX_ITEMS`, the `revision` constant, the entries `seal`, `correct` and `replace`, the messages `journal_index_request` and `journal_index_page` (from the union and from the Relay-to-Host list), `JournalOpen.reset`, `JournalOpened.index`, `indexAfter` and `epoch`, `validIndexPage`. `JOURNAL_OPEN_REFUSAL_REASONS` becomes `['unavailable']` (the Task 1 refusal uses it); `JOURNAL_REFUSAL_REASONS` becomes `fenced, invalid, quota_exceeded, incomplete, sequence_gap` (`unknown_item`, `body_missing`, `type_changed`, `duplicate_item` become `invalid` with `itemKey`; `stale_revision` goes).

**Journal core:** delete `reconcile.ts` and its exports, `seal`, `correct`, public `replace` (its body stays as the private rebuild of `sync`), `index`, `indexSnapshot`, `revision` on `JournalItem`, `lastRevision` on `JournalMeta`, `nextRevision`, `JournalStaleRevisionError`, the public `carriedOnReplace`, `sealedCopy` in `replacement.ts`, the `JournalIndexEntry` re-export. A stored journal that still has the old `revision` fields loads; the extra fields are ignored.

**Relay:** `host-journals.ts`: `JournalOpenOptions.maxIndexItems`, `pageItems`, `reset`; `JournalOpened.index`, `more`, `unserved`; `JournalOpenRefusal.refused: 'index_too_large'` and `unserved`; the `reset` and index-bound branches of `open`; `indexPage`; `limits.sessionItems` and the item-count checks (the byte cap bounds the skeleton); the `correct` branch of `admission`; the `apply` cases `correct`, `seal` and `replace`; the per-item cases of `refusalOf`. `journal-uplink.ts`: the `journal_index_request` case, `packIndex`, the open-time `unserved` fan-out, the index fields of `journal_opened`. Delete `journal-index-pages.ts`. `journal-partition.ts` and `agent-remote-cloudflare/src/journal-partition.ts`: `indexPage` and the open options (`maxIndexItems`, `pageItems`, `reset`). Re-record `journal-partition.contract.json` (open, window, status, no `indexPage`).

**Tests:** delete `reconcile.test.ts` (core), `host-journals-reset-open.test.ts`, `journal-index-pages.test.ts`, the index and reset cases in `journal-uplink.test.ts`, `host-journals-bounds.test.ts` (index bound, paged index, epoch-ended index page, corrected-row measuring, items limit), `journal-partition.test.ts` (paged index), `broker-journals.test.ts` ("opens a journal whose index no single message can carry..."), the cloudflare `indexPage` tests, and the `correct`, `seal`, `replace` and revision cases in `journal-amendments`, `journal-carry`, `journal-robustness`, `journal-size-invariant`, `session-journal`, `journal-window`, `journal-late-rows`, `retention`, `replacement` tests. Where those tests used `replace` or `correct` to build a journal, they use a shared `seedJournal(items)` helper that calls `sync` on an empty journal. Rewrite `remote-host-journal.test.ts` (protocol) to the new entries, reasons and messages.

**Checks that must print nothing:** `git grep -nE "planReconcile|JournalIndexEntry|expectedRevision|stale_revision|journal_index_|index_too_large|JOURNAL_INDEX_|journal_replacement_published|journal_quota_window|needsJournalGrantTwo|quotaFenced|HOST_DELETIONS_AT_ONCE|HEAD_HEADROOM" -- packages ':!*.md'`, and `git grep -nE "\.seal\(|\.correct\(|op: '(seal|correct|replace)'" -- packages`. Then `wc -l` of the Section 7 table files, saved for Gate S2.

**State:** D10: persisted fields -2, wire entities -5 (2 messages, 2 entry types, the `reset` option) and 4 refusal reasons, 1 file of the core, 1 file of the Relay, 1 protocol function. **Lines:** production about -450, tests about -700.

- [ ] Steps: delete and rewrite the tests in the order protocol, core, hosted, cloudflare, controller (each package's suite green after its step); run the checks above; Gate G; commit.

---

## 7. Documents, the local check, and what the plan expects

### Task 11: documents and compatibility metadata

No code. The documents must describe the code of Task 10.

- [ ] `docs/current/agent-remote/protocol.md`, "Session journals over the Host uplink" (about lines 490-515): rewrite for `journal=1`; the open without an index; the `window` entry and the Relay's three outcomes (unchanged, appended, replaced) and its trim; the five refusal reasons and the single recovery (reopen with backoff, send the window again); `journal_older_request.beforeItemKey`; the give-up cases (head cannot be encoded, identity breach, refused open); the Relay's two window diagnostics. Delete the index, `reset`, `correct`, `seal`, revision, quota-window and rewrite-loop text.
- [ ] `docs/current/agent-remote/provider-onboarding.md` (line 65): `journal=1`; the fixture requires the live and reread forms to give `unchanged`.
- [ ] `docs/superpowers/specs/2026-11-15-im-session-service-design.md`: in "Contents" drop the revision from the item index; in "Item identity" delete the Corrections bullet and "Sealing an item makes it live-only too", and say an interrupted open item is not carried by a replacement; rewrite "Continuing a journal across reopens" as fence, window, Relay compares and decides (unchanged, appended, replaced), replacement carries live-only items and is trimmed to the quota, universal recovery is reopening; rewrite "Older history" (a journal begins with the newest window that fits one message; older items arrive on the Relay's request, anchored by the journal's oldest item); in "Answering the client protocol in smart mode" delete "a correction is folded into its item's entry" and the no-corrections-live sentence; "Failure handling": the "Reconcile finds a rewrite" row says replacements also follow any doubt. Add the S2 date and a pointer to this plan.
- [ ] `docs/superpowers/plans/2026-11-15-im-session-service-roadmap.md`: Progress rows for S1 and S2 (state, suite counts); in "Notes carried to later plans" remove "paged index, quota and evicted bodies" (keep "a publication must not rely on bodies the Relay evicted"), "a journal whose index is too large" and "forwarded frames and older heads"; rewrite "an incomplete journal takes a replacement before any head" and "contiguous sequences and per-item refusals" to the new rules; in the P3 note, the deletion retry timer is the loop of Task 4.
- [ ] `packages/agent-remote-protocol/README.md`: the version-4 diagnostic list.
- [ ] Check: `git grep -nE "journal=2|journal_index|expectedRevision|index_too_large|reset: true|stale_revision" -- docs/current docs/superpowers/specs/2026-11-15-im-session-service-design.md packages/*/README.md` prints nothing; review any `seal` or `correction` hit by hand (the assessment and the plans of 2026-11-15 keep their history).
- [ ] Gate S2 (full suites) and Gate G; commit.

### Task 12: the local-instance check (last)

Follow `.agents/skills/prepare-arc-local/SKILL.md`. No provider declares the journal capability, so no Controller asks for journals; this task can show no regression, nothing more.

- [ ] Run `pnpm --silent local status --json`. If this checkout's instance is running, follow "Before restarting a running instance" in `references/lifecycle.md` before `up`; never stop or alter an instance or service that is not this checkout's, and never touch the user's own Controller.
- [ ] `ARC_LOCAL_JOURNALS=1 pnpm local up` (journals on, so the Relay opens its store and the smart-reading switch route is live). If an instance `journals.sqlite` from earlier runs exists, keep it: it must load.
- [ ] Evidence by layer (report each as verified, failed or not exercised, per `references/verification.md`): **Build** `status` commit equals `git rev-parse HEAD` after the last edit; **Site** running and signed in; **Controller** `uplink registered` and `agent-remote-controller-dev host providers` lists the expected providers enabled; **Model turn** a session created in the instance `workspace/` with `agent-remote-controller-dev` completes a real reply, read back with `session read`; **Page** a headless screenshot of that session, opened and described, with a DOM assertion on the reply text.
- [ ] Specific no-regression facts: the Controller's `registered` has no `journal` key (it asked for none) and `pnpm local logs` shows no `journal_` diagnostic; turn smart reading on and off for one provider through the route used by `broker-journal-switch.test.ts` and confirm the session still reads on the crude path each time; no `agent_update` or interaction frame regression in the page (a question asked by a test session appears and disappears).
- [ ] Not exercised, with the reason: journal-served reads, windows, trimming, older history through a journal (no capable provider). The real-transport tests of Tasks 6 to 9 are the evidence for them; S3 enables the first provider.
- [ ] Release any Codex session created (`agent-remote-controller-dev session release <address>`). Leave the instance as the skill's lifecycle reference says.
- [ ] Record: `git --no-optional-locks diff --shortstat 33b1c80c HEAD -- packages`, the `wc -l` table below with actuals, the publisher field count (at most 20), suite counts, and Gate G. Update the roadmap Progress rows to Done with this evidence; commit.

### Where the lines go (expected; record actuals in Task 12)

| File | Today | After | Task |
|---|---:|---:|---|
| `agent-host/src/journal-publication.ts` | 990 | about 520 | 5, 9 |
| `agent-host/src/journal-reconcile.ts` | 180 | about 75 | 9 |
| `agent-host/src/journal-items.ts` | 148 | about 135 | 9 |
| `agent-host/src/journal-publisher.ts` | 202 | about 140 | 5 |
| `agent-remote-journal/src` (`session-journal`, `reconcile`, `replacement`, `types`) | 918 | about 835 | 7, 10 |
| `agent-remote-hosted/src/host-journals.ts` | 727 | about 590 | 1, 2, 3, 4, 8, 10 |
| `agent-remote-hosted/src/journal-uplink.ts` | 283 | about 215 | 1, 8, 10 |
| `agent-remote-hosted/src/journal-partition.ts` | 254 | about 170 | 1, 2, 4, 10 |
| `agent-remote-hosted/src/journal-index-pages.ts` | 20 | 0 | 10 |
| `agent-remote-hosted/src/journal-session-stream.ts` | 572 | about 510 | 6 |
| `agent-remote-hosted/src/broker.ts` (journal parts) | 2,750 | about 2,640 | 1, 4 |
| `agent-remote-protocol/src/remote-host-journal.ts` | 167 | about 115 | 1, 8, 10 |
| **Production** | about 6,480 | about 5,250 | **-1,225** (S1 about -325, S2 about -900) |
| **Tests** | about 12,500 | about 10,900 | about -1,600 net (about -3,000 deleted, about +1,400 new) |

Measured against the assessment: publisher mutable fields 33 -> 19 (the assessment's 36 and 18 used a looser count), recovery paths 14 -> 5, entry operations 10 -> 8, Controller-to-Relay journal messages 7 -> 6 and Relay-to-Controller 7 -> 6, refusal reasons 10 -> 5, open refusal reasons 3 -> 1, grant levels 2 -> 1, messages that carry an index 2 -> 0.

### Decisions this plan takes that the owner may want to reverse

1. **Older history is no longer uploaded proactively on open.** Without an index the Controller cannot know what the journal already holds, so older items arrive only on the Relay's request (`beforeItemKey`). A first scroll past the window costs one request round trip (the Relay already does this today for history beyond the journal). Reversal costs an index again.
2. **The journal version stays 1.** True only while no journal-capable Controller has shipped (the precondition checks it). If one has, S2 needs version 2 and the upgrade notice.
3. **An open item inside the window replaces on every reopen** (a connection flap in the middle of a turn). Until S4 each replacement is a reset for a client without item keys, as today. S3 measures replacements per open; a cheaper compare (the Controller sends a digest for open items and the Relay recomputes its own) is the option if the number is high.
4. **`rebindOps` stays beside `outcomeOps`** as an idempotent restatement after each open, because item digests do not cover resource bindings. The assessment listed "rebind re-sending" for deletion; this plan deletes the unacknowledged-rebind machinery and keeps the restatement (zero state, no write when nothing changed).
5. **Four per-item refusal reasons collapse into `invalid`.** They only drove the deleted skip-and-renumber path.
6. **"Zero writes" means no item, epoch or sequence write.** Each open still writes meta (generation, watermark, head).

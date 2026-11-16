# S4: the client absorbs replacements, keeps a device store, and is measured under latency

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax. This plan states interfaces, deletions and acceptance tests; the implementer writes the code with test-driven development.

**Supersedes** `2026-11-15-p1d-client-device-store.md` and `2026-11-15-p1d2-client-measurement.md` for the work they still cover (section 1). **Follows** S1 to S3 (`2026-11-16-s1-s2-journal-simplification.md`, `2026-11-16-s3-first-journal-provider.md`), whose server side is landed.

**Goal.** A conversation shows rows from the first frame, whatever happens behind it. Rows come from the device store on open and from the held rows across a Controller restart, a runtime release or a journal replacement. A replacement keeps every unchanged row mounted, with no re-render, no scroll jump and no change to the composer. T1, T2, T3's request budget and T6 are measured at 4x CPU slowdown and a 100 ms round trip against P0, with today's path as the control group.

**Tech stack and commands.** As in the old P1-D plans: TypeScript 5.7 strict, React 18, IndexedDB with `fake-indexeddb` in unit tests, `ws`, Vitest, Playwright Chromium from the lab package. Every test run has a per-test deadline (`--testTimeout`) and an outer deadline (the Bash `timeout`, at most 600000 ms). Lab tests run on Node 22 (`PATH=/opt/homebrew/opt/node@22/bin:$PATH`); lab and web tests import dependents from `dist`, so rebuild the package a task changes before running its dependents. Work in `.worktrees/im-session-service`. Local checks follow `.agents/skills/prepare-arc-local/SKILL.md` and use `ARC_LOCAL_JOURNALS=1` for every `up`, restarts included (a run without it turns the Relay's journals off).

**What the owner decided (2026-11-16), and this plan keeps.**
- T6 is met by "replace when in doubt" on the server and a client that keeps unchanged rows across a new epoch. The epoch may change. Rows are keyed by item key.
- Item keys go on entries behind an opt-in flag. The device store, labels and T1 work stay as planned.
- T1, T2 and T6 are measured at 4x CPU and 100 ms round trip, with a delaying proxy in front of the instance so that WebSocket frames are delayed too. Both builds run under the same conditions.
- The counted budgets from P0: at most 2 HTTP requests on a return while sockets are alive (today 13 to 14); no "Opening session" frame on an open or a return; no re-keyed rows after a Controller restart.
- The browser comes before the desktop app.

---

## 1. What survives from the two P1-D plans and what goes

The old plans assumed a stable epoch: corrections that reach back into the client's window, a fold rule for updates older than the window, a reducer that clears on a replacement and a lab patch (`retainedDisplay`) that hides the clearing. S1 and S2 removed corrections, `seal` and the stable epoch. What remains is the device store, the label rule and the measurement.

| Old plan | Item | Fate |
|---|---|---|
| P1-D | Decision 1 and Task 1: one IndexedDB database, schema version 3, stores `sessions` and `session_index` | **Survives** unchanged (section 5, Task 5). |
| P1-D | Decision 2 and Task 2: the stored record is a window (at most 200 entries, 1 MiB) with the last Snapshot minus live state | **Survives**, with item keys in the entries and last-write-wins instead of "a newer record of the same epoch" (section 5). |
| P1-D | Decision 3: limits (40 sessions, 32 MiB disk, 16 MiB resident, 16 sessions in 4 MiB preload) | **Replaced** by one byte cap with whole-record eviction and a preload budget, both set from measurement (rule 4; section 5). |
| P1-D | Decision 4 and Task 3: write-behind, quota handling, pinning | **Survives**; quota handling simplified to "evict least recently used until it fits, retry once, else keep in memory". |
| P1-D | Decision 5 and 11: quota, pinning, sign-out and "Clear cache on close" | **Survives**. |
| P1-D | Decision 6 and Task 9: preload at start, own subpath, entry chunk budget | **Survives**. |
| P1-D | Decision 7: row key `${epoch}:${providerId}:${seqStart}:${identity}` stays | **Goes.** A keyed entry's row key is its item key; the old format remains only for entries without a key (section 3). |
| P1-D | Decision 8: unchanged entries keep their object identity | **Survives in a stronger form**: absorption by key (section 3). |
| P1-D | Decision 9: the replica clears on a replacement and `retainedDisplay` holds the display | **Goes.** The replica holds the rows; `retainedDisplay` is deleted (Task 10). |
| P1-D | Task 4: "no holes in the window", the fold rule for updates older than the window | **Goes.** It existed because corrections made an `after` page return an item older than the window. `correct` is gone; a replacement carries the window and prepends land below it. The client keeps no rule beyond the existing fold in `mergeAuthoritative`. |
| P1-D | Task 5 and 6: restore a replica from the record; catch-up from the stored cursor; the replacement and older history over a fake transport; Decision 12 (older history reads follow the transport's recovery mode) | **Survives**; the replacement case is rewritten as absorption. |
| P1-D | Task 6a: search over the session wire has its own admission budget | **Survives**. |
| P1-D | Tasks 7, 8, 10a, 11, 12: build and move one lab test, the display cache over the device store, no content for a reader who lost access, real transports, documents | **Survive**; Task 8 loses the retained-display seed; Task 11's replacement test becomes the acceptance tests of section 9. |
| P1-D | Decision 10 and Task 10: label rule, T1 counts | **Survives**, extended to the rows held during a replacement (section 3.5). |
| P1-D | Decision 13: whole-window record writes, at most once per 2 s and on page hide | **Survives**. |
| P1-D2 | Task 1: the latency proxy (`latency-proxy.mjs`) and its test | **Survives** unchanged (Task 1 here). |
| P1-D2 | Task 2: runner `--rtt`, `--label`, attach-relative T2, counted T1 and T6, proxy validity, `summarize-p1d.mjs` | **Survives**; the smart-arm validity signal changes (section 7.3); T6 gains a forced-replacement scenario. |
| P1-D2 | Decision 1: control group is a build of the commit before the change in its own worktree | **Survives**; the control is the commit before S4 (`00b211d5` or later) with Copilot journal-served. |
| P1-D2 | Task 3 and Decision 8: attach of a journal-served, bound session from its binding while the Host is offline | **Goes to S5.** Relay-owned session control makes the attach unnecessary; building a shortcut around it now is work S5 deletes. T2 here includes one Controller attach, as the old plan stated. |
| P1-D2 | Task 4: verify the device store on the local instance's crude path | **Folded** into the local check (section 11). |
| P1-D2 | Task 5 and "Notes for the roadmap": measure the three arms, results file | **Survives** as Task 9, with the arms of section 7.1. |

## 2. Decisions and state accounting

Each row states its change in state (rule 1): "fields" are state a reader must hold in mind; "paths" are recovery paths.

| # | Decision | Fields | Paths |
|---|---|---|---|
| D1 | **Row identity is the item key.** `ProjectedTimelineEntry` and the `timeline` event of `agent_stream` gain an optional `itemKey`. A row's React key is `itemKey` when present, else today's `${epoch}:${providerId}:${seqStart}:${identity}`. | Wire +2 optional fields. Client 0. | 0 |
| D2 | **Opt-in flag on negotiation.** `negotiate` gains `itemKeys: true`; `negotiated` echoes it. Only a flagged stream carries keys, so a client that does not send it, and the Strict schemas of older clients, see no new field. | Wire +2 (one flag, one echo). | 0 |
| D3 | **A replacement is absorbed by key.** A new epoch no longer clears the replica. The replica keeps its rows, records the new epoch as pending, buffers the new epoch's live frames, fetches the tail, and merges it by key. | Replica +1 (`pendingEpoch`). `retainedDisplay` -1 (lab). | Reducer outcomes `epoch_changed` and `reset_required` -1 (merged into one `replaced`). Reset-then-refill -1. |
| D4 | **The outgoing-message ledger follows keys, not sequences.** `afterSeq`, `consumedEchoSeqs` and `epoch` on an outgoing message become `afterKey` and `consumedEchoKeys`. A message whose anchor row vanished is `unconfirmed`, as before. | 0 (3 fields swapped for 2, one of them already absent: `epoch` is read from the state). | -1 (the `epoch !== state.timeline.epoch` branch). |
| D5 | **Equality of a row is its content.** An absorbed row is unchanged when `item`, `resources`, `collapsed` and `turnId` are equal. Timestamps and sequences are not compared; the held timestamp is kept (section 6.3). | 0 | 0 |
| D6 | **Device store: one cap, last write wins, validated on connect.** A stored record is never invalidated eagerly; the first page of a connection confirms it or replaces it by key. | Store: record map, index, pinned set, write queue, quota flag (5, all inside `device-store.ts`). Constants: 2 (byte cap, preload budget) instead of 5. | 1 (quota: evict and retry once). |
| D7 | **A return with live sockets refetches nothing but access status.** The visibility listeners of list loaders are removed; lists refetch on mount, on a timer while visible, and when the shared feed socket reopens. | Listeners -N (inventoried in Task 7). | -1 (refetch on every visibility change). |
| D8 | **`failed` compaction status.** | Wire +1 enum value. | 0 |
| D9 | **One todo item per Copilot session.** The adapter's live-only key is `todo`, not `todo:<uuid>`; the SDK states the rule for every live-only item (section 6.2). | Journal items per session -(one per Controller start). | 0 |

**Budgets this plan commits to** (rule 3 and rule 4, checked in Task 9 and Task 11):
- `SessionJournal`/`SessionPublication` are not touched: publisher mutable fields stay at 19.
- The replica gains 2 fields (`pendingEpoch`, `restoredFromDevice`) and loses the lab's `retainedDisplay`. Reducer outcomes go from 7 to 6 (`applied`, `buffered`, `duplicate`, `gap`, `replaced`, `stale_epoch`).
- Client memory: at most one pending replacement per conversation. While pending, rows are held at most twice (held rows and tail), bounded by the window (at most 200 entries and 1 MiB of JSON per record).
- Device store: one disk cap and one preload budget, each stated with the measurement that sets it (Task 9). A bound without a measurement is one hard cap with a refusal.

## 3. The client contract for item keys

### 3.1 The protocol field and the flag

- `ProjectedTimelineEntry.itemKey?: string` (1 to 4096 characters, the journal's own bound) in `packages/agent-remote-protocol/src/timeline.ts`.
- `PublicAgentTimelineEvent.itemKey?: string` in `envelope.ts`, so a live row and the page entry it becomes carry the same key.
- `NegotiateRequest.itemKeys?: true` and `NegotiateResponse.itemKeys?: true` in `messages.ts`.
- The journal-served stream (`journal-session-stream.ts`) stamps `itemKey` on page entries (`itemEntry` already has the item) and on live frames (`streamFrame`) only when the client's negotiate carried the flag, and echoes it. A client without the flag gets today's frames.
- A Controller-answered stream has no item keys until the Controller's projector gives them (S6). It never echoes the flag, so its entries are unkeyed and the client uses the old row key. Task 2 checks where the Relay forwards `negotiate` to a Controller. If it decodes the frame, it removes `itemKeys` before forwarding (a Controller built before S4 rejects unknown fields). If it cannot, a Controller must be updated before the browser is: this plan then tells the owner before Task 2 lands, as S5 will.

**Rule 5: what this replaces, and why it cannot replace more.** On the client it replaces the composite row key as the identity of a row on a keyed stream, and the epoch-and-sequence anchors of the outgoing-message ledger (D4); it removes the clear-and-refill of a replacement and `retainedDisplay`. On the wire it replaces nothing: Controller-answered streams and older clients still need today's fields until S6 gives the Controller keys. S6 then deletes the flag (always on), the old row key, `itemIdentity()`, the range-overlap merge for pages (`mergeAuthoritative`) and `retiredEpochs`. That deletion is recorded in the roadmap (Task 11).

### 3.2 The key and the rows

```
rowKey(epoch, entry) = entry.itemKey ?? `${epoch}:${providerId}:${seqStart}:${identity(entry.item)}`
```

`timelineEntryKey` keeps its signature and its eight call sites (`App.tsx`, `session-communication.ts`, `timeline-search.ts`, `remote-session-client.ts`, `timeline-render-model.ts`, `TimelineSearch.tsx`, `AgentTimeline.tsx`, the export in `index.ts`). Trace, search jumps and source references accept both formats: a stored reference holding an old key never matches a keyed entry, which is a failed jump, not a crash; the test pins that.

Nothing above the row may depend on the epoch for identity: `AgentTimeline.tsx` keys `HistoryControls` and the resource scope by `[agent id, epoch]`. Both drop the epoch for a keyed stream (a resource's id is stable in the journal), and Task 4 verifies this on the resource tests before changing the scope key.

### 3.3 Absorbing a replacement

Trigger: a `timeline_replacement` frame, a live frame whose epoch is neither the current nor the pending one, or a page with `reset`, `staleCursor` or `gap`. All three become one reduction, `replaced`, and one reaction: `pendingEpoch = epoch`, keep `entries`, drop nothing, fetch the tail.

- Frames of the current epoch that arrive while a replacement is pending are ignored (the old epoch is retired). Frames of the pending epoch are buffered in `pendingLive`, which already filters by epoch.
- A second replacement while one is pending retargets `pendingEpoch` and fetches the tail again. There is no queue.
- The tail request asks for `max(historyPageSize, held entries)` entries, at most 200, so that held rows inside the Controller's window are not dropped for lack of room.
- Cursor consumers (`nextSeq`, `useSessionTracking`, `conversation-activity`) keep reading the current epoch until the tail is applied. No consumer sees a half state.

Merging the tail `P` into the held rows `H` (new function `absorbTail(held, page)` in `replica/`):

1. For each entry of `P`, in order: if `H` has the same row key and the content is equal (D5), keep the held `item`, `resources`, `collapsed` and `timestamp` and take the new `seqStart`, `seqEnd` and `sourceSeqRanges`. If the content differs, take the new entry whole. If `H` has no such key, insert the new entry.
2. Held rows whose key is not in `P` are removed. A row older than the first row of `P` is also removed. The held rows are not verified by the new epoch, and older history loads again through the existing `loadOlder`, which reads from the first entry's sequence. This is the one visible change, and it happens only to a reader who scrolled above the new window: the viewport lands on the window's first row. It is bounded by the tail limit above and is counted (section 7.2).
3. `nextSeq`, `hasOlder` and `epoch` come from the page; `pendingEpoch` clears; `restoredFromDevice` clears; buffered live frames of the epoch drain through the existing `drainPending`.

Legacy keys: an entry without `itemKey` keys by epoch, so a new epoch matches none of them and the tail replaces them all, without a frame without rows. The unified path costs nothing for Controller-answered streams and gives them the no-blank frame for free.

### 3.4 What keeps a row, the scroll and the composer

- **Row.** `ConversationEntry` is a memo component. It re-renders when its `entry` prop changes. After absorption the `entry` wrapper is new (its sequence fields changed) while `item`, `resources` and `collapsed` keep their identity. `ConversationEntry` therefore compares those fields and `timestamp`, `turnId`, `searchSelected`, `inspected`, `selection` and the other props, and ignores `seqStart`, `seqEnd` and `sourceSeqRanges`. The row's `sequence` prop is used only for Trace and a data attribute; Task 4 reads it from the state when needed instead of passing it as a prop. A rendered-row counter in the acceptance test pins "no re-render".
- **Scroll.** `useTimelineScroll` already anchors on the first visible row's `data-entry-key` and restores its offset after layout. With keys that survive, the anchor survives. The `[agent id, epoch]` key on the container is what would remount the list, and it is removed. A reader whose anchor row left the window is the case in 3.3 step 2.
- **Composer.** The composer is outside the timeline's keyed tree and reads no epoch. Draft text, focus and selection must be identical before and after; the browser test asserts this.

### 3.5 Labels while rows are held

The label rule of the old P1-D (Decision 10) gains one case. While rows are on screen and not yet confirmed current, either because they came from the device store (`restoredFromDevice`) or because a replacement is pending (`pendingEpoch !== null`), the labels `Opening session`, `Synchronizing` and `Checking access` give way to the session's last business label. A `disconnected` connection is never hidden. For a conversation with no rows at all (a first open on this device), the placeholder shows the neutral empty conversation shell without a connection word: no "Opening session", no "Loading conversation". The other T5 labels stay P2's.

### 3.6 The outgoing-message ledger (D4)

An outgoing message records `afterKey`, the row key of the newest row when it was sent, and `consumedEchoKeys`. An echo is a `user_message` row after `afterKey` in row order whose text matches, as today. A replacement that keeps `afterKey` keeps the message awaiting its echo; one whose `afterKey` is gone makes it `unconfirmed`, as a reset does today. A ledger persisted before S4 has `epoch` and `afterSeq`: it is read once as `unconfirmed` (the same state a reload with a changed epoch gives today) and written back in the new form. This is a reader of old data, not a compatibility layer for old peers.

## 4. The return budget: at most 2 HTTP requests

P0 counted 14 requests on every return, with both sockets alive: `auth/status`, `teams`, `controller-release`, `session-migrations`, `favorites`, `successions`, `relations`, `hosts`, and per Host `previews`, `vscode-tunnel`, `session/refs`, `tpm`, plus `GET /` and `POST session-reads`. Each is a list loader that listens for `visibilitychange` or the page-resume signal. The sockets already deliver the conversation, so a return has nothing to catch up on when they are alive.

**Invariant instead of a guard.** A list loader does not refetch because the page became visible. It refetches (a) when it mounts, (b) on its own timer while the page is visible (the interval each loader already uses, or 5 minutes where it has none), and (c) when the shared feed socket reopens, because a reopened socket is the one signal that something may have been missed. `watchPageResume` keeps its two jobs: confirm the access lease (`GET /auth/status`, the first of the two requests) and ping the sockets so a socket a suspended browser kept alive is found dead and reopened (which triggers (c)). The second request is the session-reads mark (`POST session-reads`), which carries a write, not a list.

- Staleness this accepts: a list changed on another device while this one was hidden shows its previous value until the next timer tick, at most the loader's interval. The conversation content is not a list and is current through the sockets (T3's 1 s).
- A return after a dead socket may exceed 2 requests; the budget is counted only while sockets are alive, as the roadmap states. Task 9 also records that case (the proxy can close every WebSocket) without a budget.
- Task 7 starts by listing every `visibilitychange`, `pageshow`, `online` and `watchPageResume` listener in the lab (`App.tsx` 288 and 1568, `GatewayController.tsx`, `session-references.ts`, `TeamMenu.tsx`, `HostCodexDaemon.tsx`, `Toast.tsx`, `recovery-writes.ts`, `workspace-display-cache.ts` and the others the grep finds) and states for each whether it is a refetch (removed), a write-out on hide (kept), or UI-only (kept).
- A deterministic lab test counts `fetch` calls over a simulated hide and return with live fake sockets; the runner confirms the count in the browser (section 7).

## 5. The device store (IndexedDB)

Unchanged from the old plan: `browser-database.ts` (database `agent-remote-image-drafts`, version 3, an upgrade that only creates `sessions` and `session_index` and never opens a cursor on `drafts` or `images`), `session-record.ts`, `device-store.ts` with its own subpath `@orchardworks/agent-remote-web/device-store`, preload by the entry chunk with the application chunk waiting at most one second, pinning of mounted sessions, and the clearing at sign-out and on "Clear cache on close". Eleven places that open the database at an explicit version 2 open it without a version (Task 5 lists them with `grep`).

**What it caches.** One record per public session, keyed by `JSON.stringify([scope, [hostId, providerId, nativeSessionId]])` where scope is the account's Relay URL. A record holds: agent id, the journal `epoch` and `nextSeq` of the last applied page (the cursor is `nextSeq - 1`), `hasOlder`, the newest entries (at most 200 and 1 MiB of JSON, each with its `itemKey` when it had one), the last Snapshot without `activeTurn`, `pendingInteractions` and `runtimeInfo.connection` (what was true before is not claimed as live), and the time of the last update. A window trimmed on its older side stores `hasOlder: true`. A window whose newest entry alone exceeds the byte limit is not stored.

**How it is keyed by epoch and sequence.** The record's key is the session; its position is `(epoch, nextSeq)`. The journal's epoch is stable across Relay restarts (SQLite) and changes only on a replacement, so the position is meaningful:

- On open the replica is seeded from the record with `restoredFromDevice` set. The first frame already has rows.
- On connect the client asks for `after` `{epoch, nextSeq - 1}`. The same epoch answers with what was missed and the client continues. A different epoch is a replacement: the tail arrives, `absorbTail` merges it by key, and the rows that were restored stay mounted where unchanged. This is the path of section 3.3; the device store adds nothing to it.
- Every applied page saves the replica's window back (write-behind of 50 ms, at most once per 2 s from the lab's observer and on page hide), now in the new epoch's coordinates.

**How a replacement invalidates it without a visible reset.** It does not invalidate it. A stored record is a display cache validated by the connection's first page: confirmed (same epoch), or replaced by key (different epoch). Nothing is deleted before content arrives, so there is no frame without rows. The only deletions are by sign-out, by a lost access (old Task 10a: a reader who lost access sees no stored content and the record is forgotten), by "Clear cache on close", and by the byte cap.

**Last write wins.** Two tabs on one device may save the same session. The old plan's rule "leave a newer record of the same epoch alone" cannot hold once epochs change, and the record is only a cache that the next connection validates. The later `save` wins; a tab keeps its own memory.

**Bounds (rule 4).** One cap on the disk records' total bytes, evicting whole least-recently-used records that are not pinned, and one preload budget in bytes for the start. Both start as the old plan's numbers (32 MiB disk, 4 MiB preload) and Task 9 replaces them with what it measured: the bytes of a record of the S3 session and of a 150-item session, the preload time per MiB at 4x CPU, and the storage the browser grants. A quota error evicts least-recently-used records until the write fits and retries once; a second failure keeps the content in memory and retries on the next save. Nothing reaches the interface.

**Older history.** `loadOlder`, the timeline search and the recovery loop read through `readTimeline`: the session wire for a transport that recovers over it, HTTP otherwise (old Decision 12). A journal-served session scrolls back without its Controller. The timeline search keeps its own admission budget at the Relay (old Task 6a).

## 6. The fixes S3 found

### 6.1 `failed` compaction status

Copilot's projector emits a `compaction` item with status `loading` and, when native compaction fails, a separate `error` item (`Copilot compaction failed: ...`). The `loading` item never ends, so the page shows "In progress" for a failed compaction beside the error.

- `AgentTimelineItem` compaction `status` gains `'failed'`. The Copilot projector completes the item with `failed` (`completes: true`) and keeps the existing `error` item, which carries the cause; no field is added and no information is lost. `CompactionItem.tsx` renders `Failed`.
- Rule 5: it adds one enum value and replaces nothing, because a `loading` item needs a terminal state other than `completed`, and the status is the only place the item can say so. It deletes nothing, but it removes a state that was wrong (a row that stays in progress for ever).
- Ordering: a Relay that does not know `failed` rejects the item, so the Relay and the web bundle update before Controllers. In `pnpm local` and in releases they ship together. The recorded Copilot fixture for a failed compaction is updated to expect `failed`.
- Claude Code's compaction projection has no failure event; it is not changed.

### 6.2 One todo snapshot per session, by invariant

Each Controller start of a Copilot session emits `todo:<uuid>` with `liveOnly: true` (`refreshTodos`, `todosSignature` starts as `'[]'`), and each change of the list emits another. The journal holds one item per start: 7 after 6 restarts, 528 bytes each, up to the item cap.

- **Where it belongs: the adapter, with a rule in the SDK.** The Relay and the client cannot know that two live-only items are two snapshots of one board; only the adapter does. The invariant that stops accumulation is: **a live-only item's key names its kind within the session, not an occurrence.** The Copilot adapter emits `{key: 'todo', completes: true, liveOnly: true}`. A later snapshot is a row of the same item, which the journal already handles as an in-place update of a complete item (it reopens and completes it). The SDK documents the rule next to `liveOnly`, and the SDK conformance test fails an adapter that emits two live-only keys with the same item type in one session.
- **The client shows it as the latest.** One keyed row updates in place. It stays where the board first appeared, not at the bottom of the conversation. Moving it would need a removal operation, which the journal does not have, and adding one fails rule 5. If the owner wants the board at the bottom, it is a presentation decision for a later step (the row can render in the status area), not a protocol one.
- **A restart still appends one row** (the same key with the same content), because the adapter does not know the journal's copy; the item count stays at one. Task 9 measures items and bytes added per restart (expected: 0 items, one 528-byte row) against S3's 12,422 bytes per window.
- State: journal items -1 per Controller start; adapter fields 0; SDK +1 conformance rule.

### 6.3 Time drift between paths: it does not matter, so the client does not compare it

S3 found the same row showing 19:56:21 from the journal and 19:56:23 from the Controller: the journal keeps the time of the live event, the Controller reads Copilot's native time. No time moved inside one path. The two differ by 2 to 3 seconds and the display shows the time to the second.

- It does not affect order, correctness or identity. It would matter only if the client treated a time difference as a content change, because then each replacement would re-render every row.
- So row equality ignores `timestamp` (D5) and an unchanged row keeps its held time. A row's time may differ by seconds from what a later crude read shows; the user never sees the two paths at once. No adapter or Relay change.
- If a changed row (content differs) arrives, it takes the new entry's time. That is the time the source now reports and is correct for that content.

## 7. Measurement

### 7.1 Arms and conditions

- **Control:** the build before S4 (HEAD `00b211d5` or later, journals on, Copilot journal-served), in its own worktree `.worktrees/s4-control` and its own instance. It is today's path with the journal-served read: no device store, reset on a new epoch, per-return refetch. It is measured before any client change (Task 1) so the comparison is fixed.
- **S4:** the S4 build, journals on, Copilot journal-served.
- **S4 crude:** the S4 build with smart reading off for Copilot, to separate what the device store and absorption give from what the journal gives.
- **Conditions:** no emulation, 4x CPU, 100 ms round trip, both. Every condition runs both builds in turn, one instance at a time, with the same five sessions of P0 and the Copilot sessions of S3. Round trip is half the delay each way on every HTTP exchange and every WebSocket byte; connection setup is not modelled, so a real network is slower.

### 7.2 The latency proxy and the scenarios

`packages/agent-remote-lab/performance/latency-proxy.mjs` (from old P1-D2 Task 1; `node --test` over real HTTP and WebSocket) delays every HTTP exchange and WebSocket byte, rewrites the origin so the instance's checks pass, and can close every WebSocket on command. `local-baselines.mjs` gains `--rtt MS`; a run through the proxy fails when no WebSocket crossed it, so a page that bypassed it cannot produce a latency result. The command line talks to the instance directly.

| Scenario | Target | What is counted or timed | Pass |
|---|---|---|---|
| `open-known` (reload, then navigate by URL) | T1 | Opening-label states, row-less states and `contentSinceMountMs` after mount; the 100 ms is at 4x CPU | 0 opening-label states and 0 row-less states, maximum over all samples, every condition; content within 100 ms (p95) at 4x CPU |
| `open-fresh` (device storage cleared, journal exists) | T2 | `contentSinceAttachMs` (first `attach` request) and since navigation; `answeredBy` | 500 ms p50 and 1,500 ms p95 at 4x CPU and at 100 ms; no slower at p50 than the control, both measures. The attach still reaches the Controller until S5; T2's "without reaching the Controller" is S5's gate |
| `return` (hidden 30 s; hidden and frozen 300 s; sockets closed by the proxy while hidden) | T3 | HTTP requests by endpoint, opening-label states, time until current | at most 2 HTTP requests while sockets are alive, 0 opening-label states, current within 1 s (p95); the dead-socket case is recorded, with no budget |
| `runtime-release` (Copilot `session release`, then open) | T2, T6 | as `open-known`, plus replacements by reason from the Relay diagnostic | rows kept, 0 row-less states |
| `restart-continuity` (whole instance restart with the page open) | T6 | every timeline row node marked; survivors counted; row-less states; labels | 0 re-keyed rows (every marked node still in the document), 0 row-less states |
| `replacement-absorbed` (new) | T6 | the runner stops the Controller, edits one item of a Copilot session it created itself in its native history file, and restarts, which forces a `changed` replacement; rows marked, composer text and focus, scroll anchor offset | every unchanged row node survives; the changed row updates in place; the composer keeps its text, focus and selection; the anchor row's offset moves at most 1 px; 0 row-less states |
| `switch` (`local-switch.mjs`) | none in P0 | cold and warm switch times, HTTP requests per switch, opening-label states | recorded; 0 opening-label states on a warm switch; warm no slower than cold |

Counted measures are counts of states the observer saw (resolution 8 ms), never clock thresholds. Clock thresholds are checked only by the runner.

### 7.3 Is the sample journal-served? A direct signal

S3's runner counted a Controller-answered open by an attach finishing before the first message and could not tell a 1 ms resident attach from a miss. The direct proof S3 found replaces it: the page's `timeline_page` frame carries the timeline epoch, and the journal's epoch is in the `meta` of the session in the instance's `journals.sqlite` (read through `node:sqlite` read-only). A sample is journal-served when the two epochs are equal and Controller-served when the page carries the Controller's own epoch. A smart-arm sample that is not journal-served is excluded from every statistic and verdict, and the summary states how many samples were used. This closes S3's open item (M6's missing signal).

### 7.4 Recording against P0

`summarize-p1d.mjs` (from old P1-D2 Task 2) reads the result files of the three arms and four conditions and prints one table per target with the P0 figure, the control, S4 and S4 crude, and a verdict per pass criterion; a miss is recorded as it is and is not worked around. Results go to `docs/superpowers/plans/2026-11-16-s4-results.md` (Task 9) with the build, machine, date and sample counts, and the raw JSON under `.tmp/s4/` (not committed). The device store's caps are set from the same runs (section 5).

## 8. Tasks

Each task leaves the repository green, changes no signature without its callers and tests, and ends with its suites run under deadlines and a commit. Rebuild a package before running its dependents' tests.

### Task 1: The latency proxy, the runner and the control measurement

**Files:** `packages/agent-remote-lab/performance/latency-proxy.mjs` (+ `.test.mjs`), `local-baselines.mjs`, `journal-measurement.mjs`, `summarize-p1d.mjs` (+ test), `create-p1d-sessions.mjs` if the five P0 sessions are absent, `README.md`.

- Proxy, `--rtt`, `--label`, attach-relative T2, counted T1 (opening-label and row-less states since mount), marked row nodes for T6, proxy validity, and the journal-served signal of section 7.3 (`answeredBy` from epochs).
- New scenarios `return` (with the dead-socket variant), `replacement-absorbed`, and the counted fields of `switch`.
- Build the control worktree `.worktrees/s4-control` at the commit before any S4 change and **run every scenario for the control arm now**, in all four conditions, before Task 2.
- Tests: the proxy test (HTTP and WebSocket delay within a tolerance, origin rewrite, socket close); the summary test with fixture results; `node --check` on the scripts.
- Gate: control results exist; the summary prints P0 and control side by side. State: runner options +2 (`--rtt`, a socket-close command; `--label` exists); no production code.

### Task 2: Item keys on the wire, behind the flag

**Files:** `agent-remote-protocol/src/{timeline,envelope,messages}.ts`, protocol fixtures, schemas and replay entries; `agent-remote-hosted/src/journal-session-stream.ts` and the Relay's forwarding of `negotiate` to a Controller; `agent-remote-relay/src/session-wire.ts` (decode only); `agent-remote-web` negotiate call.

- Interfaces in section 3.1. The client sends `itemKeys: true` on every `negotiate` of a conversation stream (not the activity observer).
- Check first where the Relay forwards `negotiate` to a Controller and whether it decodes it. Implement the strip, or stop and tell the owner that Controllers must update before the browser.
- Tests: protocol conformance (flagged negotiate accepted; unflagged client's Strict schema never sees the field); a real-transport test through `createHostJournals` and the in-process hosted Relay: a flagged client gets keys on a page and on a live frame, an unflagged client gets none; a Controller-answered stream with the flag gets no echo and no key.
- Run `pnpm compatibility:update` then `pnpm compatibility:check`. State: wire +4 optional fields and flags, replacing nothing (section 3.1).

### Task 3: Compaction `failed` and the single todo item

**Files:** `agent-remote-protocol/src/timeline.ts`, `agent-provider-copilot/src/{projector,session}.ts`, its recorded fixture, `agent-provider-sdk` (rule and conformance test), `agent-remote-web/src/react/items/CompactionItem.tsx`.

- Sections 6.1 and 6.2. Tests: the recorded failed compaction ends `failed` with its error item; the web item renders "Failed"; an adapter test with three restarts and two list changes leaves one `todo` item in a real `SessionJournal`; the SDK test rejects two live-only items of one type with different keys in one session.
- State: section 6.

### Task 4: The replica absorbs a replacement; rows keyed by item key

**Files:** `agent-remote-web/src/replica/{types,reducer,timeline-entry-key,message-outbox,store}.ts` and tests, `client/remote-session-client.ts`, `react/{AgentTimeline,ConversationEntry,timeline-render-model}.tsx`, `react/useTimelineScroll.ts` only if the anchor test fails.

- Interfaces: `rowKey` (3.2); `pendingEpoch` and the single `replaced` reduction (3.3); `absorbTail(held, page)` (3.3); the ledger of 3.6; `ConversationEntry`'s comparator and the container key without the epoch (3.4).
- `remote-session-client.ts`: the `timeline_replacement` handler and `handleTimelineReduction` mark the replacement pending instead of clearing, and fetch the tail with the larger limit; `catchUpAfterSubscription` is unchanged.
- Reducer tests (pure): unchanged rows keep `item` identity; changed row updates in place; missing row goes; new row inserts; rows older than the tail go; the new epoch's live frames buffered and drained after the tail; old-epoch frames ignored while pending; a second replacement retargets; legacy (unkeyed) entries replace wholesale without an empty state; a ledger message awaiting its echo survives a replacement that keeps `afterKey` and becomes `unconfirmed` when it does not; a pre-S4 persisted ledger reads once as `unconfirmed`.
- Component tests (jsdom): the rendered-row counter shows 0 renders for unchanged rows after a replacement; the timeline container is not remounted; a stored reference with an old key fails softly.
- State: section 2 (D1, D3, D4, D5).

### Task 5: The device store

**Files:** the old P1-D file table, rows for `browser-database.ts`, `image-drafts.ts` and its test, `session-record.ts`, `device-store.ts`, `package.json` subpath, `replica` restore (`restoredFromDevice`), `remote-session-client.ts` (`readTimeline`), `agent-remote-hosted/src/broker.ts` and its timeline admission test, the 11 places that open the database at version 2.

- Section 5. Everything from old P1-D Tasks 1 to 3, 5, 6, 6a and 7 as listed in section 1, with the changes there: keys inside records, last write wins, one byte cap and one preload budget (constants set by Task 9), simplified quota handling.
- Tests: `fake-indexeddb` unit tests for upgrade preserving drafts and images, record trimming and limits, write-behind, quota, pinning, preload; replica restore; catch-up over a fake transport for the same epoch (an `after` request only), a different epoch (tail and absorb) and older history over the socket.
- State: store 5 fields, 2 constants, 1 recovery path.

### Task 6: The lab uses the store and shows no connection word over held rows

**Files:** `agent-remote-lab/src/{workspace-cache,workspace-display-cache,conversation-connections,conversation-storage,conversation-recovery,main}.ts(x)`, `components/{SessionWorkbench,SessionConversation}.tsx`, `agent-remote-web/src/client/session-state.ts`, `react/AgentActivityStatus.tsx`.

- Old P1-D Tasks 8, 9, 10 and 10a, with the label rule of 3.5 and without the retained-display seed. The neutral shell for a conversation with no rows.
- Tests: counted states for a conversation mounted from the store (no label, no row-less frame) and for a first open (no connection word); a lost access shows no stored content and forgets the record.

### Task 7: The return budget

**Files:** the loaders named in section 4 (to be confirmed by the inventory), `session-references.ts`, `TeamMenu.tsx`, `HostCodexDaemon.tsx`, `GatewayController.tsx`, `watchPageResume` callers.

- The inventory first, committed as a table in this plan's results file. Then the invariant of section 4 (listeners that refetch removed; mount, timer and feed-reopen refetches kept).
- Tests: a lab test counts `fetch` calls over a simulated hide and return with live fake sockets: at most 2, both named (`auth/status`, `session-reads`); with a dead socket the feed reopens and its loaders refetch once; a list still refreshes on its timer.

### Task 8: Acceptance tests with real transports and a real browser

Section 9. Files: `agent-remote-lab/src/test/journal-relay.ts` (a journal-served Relay: the hosted broker over real HTTP and WebSocket, with a fake Controller), `components/SessionConversation.journal.test.tsx`, `e2e/session-replacement.spec.ts` (Playwright Chromium).

### Task 9: Measure and record

Run the three arms in all four conditions (section 7), set the device store's caps from the measurements (section 5), write `docs/superpowers/plans/2026-11-16-s4-results.md` and the Progress row of the roadmap. The gate is that T1, T2, T6 and the counted budgets are **measured and recorded with their verdicts**, whatever they show. A miss becomes a task of S6 or a decision for the owner; it is not fixed inside this task.

### Task 10: The deletion task

Delete what S4 made unnecessary, and run the suites to prove nothing needed it.

1. `retainedDisplay` and its three lines in `SessionConversation.tsx`, and `workspaceDisplayState` if nothing else reads it (the lab's visual patch for the clear-and-refill).
2. In `replica/reducer.ts`: the `reset_required` and `epoch_changed` statuses and their separate branches in `applyHistoryPage` and `reduceTimelineEvent`; the clearing `applyTimelineReplacement` (it becomes the marking of `pendingEpoch`); the call sites in `remote-session-client.ts`, `store.ts` and `useSessionCatchUp.ts` that distinguish them.
3. The `epoch` terms of the `AgentTimeline` container key, `HistoryControls` key and resource scope for a keyed stream.
4. The ledger's `epoch`, `afterSeq` and `consumedEchoSeqs` and their reconcile branches (`message-outbox.ts`, `remote-session-client.ts:482`).
5. Visibility listeners that refetch lists (Task 7's inventory).
6. Tests that pin the removed behaviour (a blank frame, a label flash, a reset after a replacement).
7. The old P1-D plans' Task 4 and the attach shortcut are not built: nothing to delete, recorded here and in the roadmap.
8. **Recorded for S6, not done here** because Controller-answered streams still need them: the `itemKeys` flag, the old row key and `itemIdentity()`, `mergeAuthoritative`'s range-overlap rule, `retiredEpochs` and the `stale_epoch` status. S6 gives the Controller's projector item keys and deletes them.

Expected line change: production about +450 (store about +350 as the old plan, keys and absorption about +150, return budget about -50 net) and about -150 deleted; tests follow. The record of actual numbers goes in the results file.

### Task 11: Documents, compatibility, the local check

`docs/current/agent-remote/web.md` and `protocol.md` (the flag, the field, the `failed` status, absorption, the store's schema); `packages/agent-remote-lab/performance/README.md`; the roadmap (Progress row, the S4 row's evidence, "Notes carried to later plans": remove the P1-D latency note, keep the Task 3 shortcut note under S5); `pnpm compatibility:update`, then `pnpm compatibility:check`; the local check of section 11 last.

## 9. Acceptance tests

Test observable behaviour, not source text. Protocol, pairing and reconnect behaviour use real transports. Clock thresholds are the runner's only.

**Real transports** (hosted broker over real HTTP and WebSocket, the journal core with a real store, a fake Controller that publishes windows; the client is the real `RemoteSessionClient` over the real session-channel transport, rendered in jsdom):

1. **Replacement absorbed.** The Controller reopens with one changed item and one removed item. Afterward: the unchanged rows' DOM nodes are the same objects and rendered 0 more times; the changed row updated in place; the removed row is gone; a new row is inserted in order; at no commit was the entry list empty; the composer's text, focus and selection are unchanged.
2. **Same epoch continues.** A reconnect with an unchanged journal issues one `after` request and no tail.
3. **Device store, old epoch.** A record saved in epoch E1 is restored with rows on the first frame; the Relay now holds E2; the tail absorbs by key; restored rows that are unchanged stay mounted; no frame without rows; no connection word while restored.
4. **A message awaiting its echo across a replacement** is confirmed by its echo, not marked unconfirmed (anchor key kept); and `unconfirmed` when its anchor row was rewritten.
5. **The flag.** A flagged stream carries keys on pages and live frames and the row keys equal the item keys; an unflagged client receives frames that pass its Strict schema; a Controller-answered stream never echoes the flag.
6. **Two replacements in a row, and a replacement during a catch-up,** end in the second epoch's rows with no stuck pending state.
7. **Return.** A hide and return with live sockets makes at most 2 HTTP requests and shows no opening label; with the sockets closed it reconnects and the feeds refetch.
8. **Copilot fixtures.** Failed compaction ends `failed`; three restarts leave one `todo` item.

**Real browser** (Playwright Chromium, headless, the lab served by the same journal-served fixture; the claims are visual):

9. **No re-keyed rows and no scroll jump.** Mark every timeline row node with an expando; read a row in the middle of the window and its offset; force a replacement; assert every unchanged node still carries the mark, the anchor offset moved at most 1 px, and a `MutationObserver` recorded no state without rows.
10. **A reader above the new window** lands on the window's first row and can scroll up through older history again (the bounded case of 3.3 step 2).
11. **Composer.** Type text, focus and select inside the editor, force a replacement, assert the text, focus and selection are unchanged and the editor never became disabled.
12. **Reload and return.** A reload of a known conversation shows rows in the first frame and no opening label; a hide and return under a fetch counter stays within the budget.

Suites to run before the commit of each task: web, lab (Node 22), protocol, hosted, relay, journal, the Copilot and SDK providers, conformance, and the Playwright spec. The counts at Gate S2 (web 893, lab 2801, hosted 967, protocol 418) are the floor; deletions may lower them and are listed in the results file.

## 10. State accounting, and the budget the client holds

| Area | Fields | Paths | Reason |
|---|---|---|---|
| Wire | +4 (two optional fields, one flag and its echo) and +1 enum value | 0 | Replace nothing on the wire until S6 (3.1); S6 deletes the flag |
| Replica | +2 (`pendingEpoch`, `restoredFromDevice`) | outcomes -1 (7 to 6), reset-and-refill -1 | A replacement and a restore are the two states in which rows are shown unconfirmed |
| Ledger | 0 (swap) | -1 | |
| Lab | -1 (`retainedDisplay`), listeners -N | -1 (refetch on visibility) | |
| Device store | 5 inside one module, 2 constants | +1 (quota) | New, but replaces six limits of the old plan and the preview cache of six sessions |
| Journal and adapter | journal items -1 per Controller start; publisher fields unchanged at 19 | 0 | The todo rule |

**Budgets for client state:**
- One conversation holds at most one pending replacement and at most twice its window in rows while absorbing. A window is at most 200 entries and 1 MiB of JSON.
- The device store has one byte cap on disk and one preload budget, each cited to a measurement in the results file. Memory copies are what the preload loaded plus mounted sessions.
- Idle cost: no timer in the store; write-behind only after a change; the lab's observer writes at most once per 2 s per session and on page hide.
- A change that raises a number above its measured value says why in the results file or goes to the owner.

## 11. The local-instance check, with Copilot journal-served

Last, after Task 10. Follow `.agents/skills/prepare-arc-local/SKILL.md`: this checkout's instance only, free ports, the headless Playwright of this repository, one browser context per script. `ARC_LOCAL_JOURNALS=1` for every `up`, restarts included.

1. Build and `pnpm local up`; the Copilot session of S3 and a Copilot session of at least 150 items made with real turns.
2. **Prove journal serving directly** (S3's method): the page's `timeline_page` epoch equals the epoch in `journals.sqlite`'s `meta`; with smart reading off it equals the Controller's.
3. Reload: rows in the first frame from the device store, no "Opening session" (counted by the runner's observer).
4. Hide and return: at most 2 HTTP requests, no label.
5. **Controller restart with the page open**: rows stay mounted (marked nodes survive), no frame without rows. Repeat three times and read the journal: the `todo` item count stays at one.
6. **Forced replacement** (`replacement-absorbed`): unchanged rows survive, the composer keeps its text and focus, the anchor offset holds. Take a screenshot before and after.
7. Switch between sessions, send a message across a restart, and release (`session release`, `released: false` is expected for a session a page watches; an open after a release is the T2 case).
8. A failed compaction cannot be forced on the local instance; the fixture test of Task 3 covers it, and the check says so.
9. The Controller log shows no `journal_open_refused`, `journal_session_unserved` or `journal_session_restarted` beyond the forced replacement; the instance is left as it was found, with the owner's own processes untouched.

Record the evidence in the results file and the roadmap row.

## 12. Risks and what is not in S4

- **A replacement while a reader is far above the window** loses that position (3.3 step 2). It is rare (S3: 0 replacements in 30 opens) and bounded; the tail limit keeps held rows inside the Controller's window. Task 9 counts replacements per open for Copilot again, so a rise is seen.
- **Opening a session still attaches the Controller** (T2's "without reaching the Controller" waits for S5). T2 here is measured from the first attach request against the control, as in P0.
- **Lists can be stale for up to their interval after a return** (section 4). That is the trade for a return that makes two requests; the dead-socket case refetches.
- **Compaction `failed` needs the Relay and the bundle first.** Controllers that emit it must not meet a Relay that rejects it; this is the ordering of a normal release.
- **Controller-answered streams get no item keys** until S6. They get the no-blank frame but not row survival across an epoch change.
- **Not in S4:** the attach shortcut for an offline Host (S5), connection labels beyond the narrow rule (P2), demand leases and use-based retention (P3), the Controller's item keys (S6), the desktop application.

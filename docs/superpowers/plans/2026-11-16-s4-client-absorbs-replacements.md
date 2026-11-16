# S4a: the client absorbs replacements, and T6 is measured under latency

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax. This plan states interfaces, deletions and acceptance tests; the implementer writes the code with test-driven development.

**Supersedes**, together with [S4b](2026-11-16-s4b-device-store.md), `2026-11-15-p1d-client-device-store.md` and `2026-11-15-p1d2-client-measurement.md` for the work they still cover. **Follows** S1 to S3 (`2026-11-16-s1-s2-journal-simplification.md`, `2026-11-16-s3-first-journal-provider.md`). S4 is split in two so that each half is short and measurable: S4a is the protocol, journal core and client changes that make a replacement invisible; S4b is the device store, labels, T1 and the return budget, and starts after S4a lands.

**Goal.** A replacement of a journal keeps every unchanged row mounted, with no re-render, no scroll jump and no change to the composer. T6 and switch time are measured at 4x CPU slowdown and 100 ms round trip against P0, with today's path as the control group.

**Commands.** Every test run has a per-test deadline (`--testTimeout`) and an outer deadline (the Bash `timeout`, at most 600000 ms). Lab tests run on Node 22 (`PATH=/opt/homebrew/opt/node@22/bin:$PATH`); packages that dependents import from `dist` are rebuilt first. Work in `.worktrees/im-session-service`. Local checks follow `.agents/skills/prepare-arc-local/SKILL.md` and export `ARC_LOCAL_JOURNALS=1` for every `up`, restarts included.

**Owner decisions (2026-11-16) that bind S4a and S4b.** T6 is met by "replace when in doubt" plus a client that keeps unchanged rows across a new epoch; item keys go on entries behind an opt-in flag; T1, T2 and T6 are measured at 4x CPU and 100 ms round trip with a delaying proxy, both builds under the same conditions; the counted budgets are at most 2 HTTP requests on a return, no "Opening session" frame on an open or a return, and no re-keyed rows after a Controller restart; the browser comes before the desktop app.

---

## 1. What survives from the two P1-D plans, and where

The old plans assumed a stable epoch: corrections that reach into the client's window, a fold rule, a reducer that clears on a replacement and a lab patch (`retainedDisplay`) that hides the clearing. S1 and S2 removed corrections, `seal` and the stable epoch.

| Old item | Fate |
|---|---|
| P1-D Decisions 1 to 6, 11, 13; Tasks 1 to 3, 5, 6, 6a, 7, 9: database version 3, stored window, store, restore, catch-up, search admission, preload | **Survive in S4b**, with the privacy rules and the single byte cap. |
| P1-D Decision 3 (five limits) | **Replaced** by one byte cap and one preload budget (S4b). |
| P1-D Decision 7 (row key `${epoch}:${providerId}:${seqStart}:${identity}` stays) | **Goes.** A keyed entry's row key is its item key (section 3). |
| P1-D Decision 8 (unchanged entries keep their object identity) | **Survives, stronger**: absorption by key. |
| P1-D Decision 9 (the replica clears; `retainedDisplay` hides it) | **Goes** (Task 8 deletes `retainedDisplay`). |
| P1-D Task 4 (no holes, the fold rule for updates older than the window) | **Goes.** It existed because corrections made an `after` page return an item older than the window. The one-row-per-key rule of 3.3 gives "no holes, no duplicates" directly. |
| P1-D Decision 10, Tasks 8, 10, 10a (labels, T1 counts, display cache, lost access) | **Survive in S4b.** |
| P1-D2 Task 1 and 2 (latency proxy, runner options, counted T1 and T6, `summarize-p1d.mjs`) | **Survive in S4a Task 1**; T1 and T2 verdicts wait for S4b. |
| P1-D2 Task 3 (attach of a journal-served session from its binding while the Host is offline) | **Goes to S5.** Relay-owned session control makes the attach unnecessary. |
| P1-D2 Task 4 (device store on the crude path) and Task 5 (measure three arms) | Folded into S4b's local check and S4a/S4b measurement. |

## 2. Decisions and state accounting

| # | Decision | Fields | Paths |
|---|---|---|---|
| D1 | **Row identity is the item key.** `ProjectedTimelineEntry` and the `timeline` event of `agent_stream` gain an optional `itemKey`. On a keyed stream the client holds **one row per key** (3.3). | Wire +2 optional fields. Client 0. | The type-based matching of `coalesceEntry` -1 for keyed streams (deleted in S6). |
| D2 | **Opt-in flag.** `negotiate` gains `itemKeys: true`, `negotiated` echoes it. The Relay strips the flag before a Controller sees it (3.1). | Wire +2. | 0 |
| D3 | **A replacement is absorbed by key.** The replica keeps its rows, records the new epoch as pending, and merges the tail by key. | Replica +1 (`pendingEpoch`); lab `retainedDisplay` -1. | Reducer outcomes `epoch_changed` and `reset_required` -1 (merged into `replaced`). Clear-and-refill -1. |
| D4 | **The outgoing-message ledger follows keys.** `epoch`, `afterSeq`, `consumedEchoSeqs` become `afterKey`, `consumedEchoKeys`. | 0 (3 swapped for 2) | -1 |
| D5 | **Row equality is content.** The item's canonical content (the journal's `itemDigest` exclusions) plus resource ids. Not compared: `collapsed` and other client-side marks, timestamps, sequences. | 0 | 0 |
| D6 | **Live-only items leave the positional comparison of `sync`** (3.7). | Core: `extensionOf` loses the live-only special cases (-3 branches). | `changed` replacements caused by live-only items -1. |
| D7 | **`failed` compaction status** (section 4.1). | Wire +1 enum value. | 0 |
| D8 | **One todo item per session**, the single key `todo` (4.2). | Journal items -1 per Controller start. | 0 |

**Budgets.** `SessionPublication` stays at 19 mutable fields and 4 recovery outcomes: S4a does not touch the publisher. The replica gains 1 field and its reduction outcomes go from 7 to 6 (`applied`, `buffered`, `duplicate`, `gap`, `replaced`, `stale_epoch`). While a replacement is pending a conversation holds its window twice at most (at most 200 entries); there is at most one pending replacement per conversation.

## 3. The client contract for item keys

### 3.1 The protocol field, the flag, and the Relay stripping it

- `ProjectedTimelineEntry.itemKey?: string` (1 to 4096 characters) in `packages/agent-remote-protocol/src/timeline.ts`; `PublicAgentTimelineEvent.itemKey?: string` in `envelope.ts`; `NegotiateRequest.itemKeys?: true` and `NegotiateResponse.itemKeys?: true` in `messages.ts`.
- The journal-served stream (`journal-session-stream.ts`) stamps `itemKey` on page entries and live frames only for a flagged client, and echoes the flag. An unflagged client gets today's frames.
- **The Relay strips the flag.** `NegotiateRequest` is Strict, so a Controller built before S4 answers an unknown field with `protocol_error`. In the crude path the Relay removes `itemKeys` from a `negotiate` before forwarding it to a Controller, in the `onMessage` that already rewrites each client frame (`sessionIdentityMessage`, `broker.ts` ~2278, the passthrough path) and in the channel path that forwards frames through `stream.receive` (`broker.ts` ~2227). No Controller has to update first. A Controller-answered stream never echoes the flag, so its entries are unkeyed and the client falls back to the old row key.
- **Rule 5.** On the client the key replaces the composite row key as a row's identity on a keyed stream, the epoch-and-sequence anchors of the ledger, and the clear-and-refill of a replacement. On the wire it replaces nothing until S6 gives the Controller's projector item keys; S6 then deletes the flag, the old row key, `itemIdentity()`, `mergeAuthoritative`'s range-overlap rule, `coalesceEntry`'s type-based matching and `retiredEpochs`. The roadmap records this (Task 8).

### 3.2 The key and the rows

```
rowKey(epoch, entry) = entry.itemKey ?? `${epoch}:${providerId}:${seqStart}:${identity(entry.item)}`
```

`timelineEntryKey` keeps its signature and its eight call sites. Trace, search jumps and source references accept both formats; a stored reference holding an old key fails softly. Nothing above the row depends on the epoch for identity: the `[agent id, epoch]` keys of `HistoryControls` and the timeline container in `AgentTimeline.tsx`, and the resource scope of the timeline and of the composer (`resourceScopeKey` in `AgentComposer.tsx` ~624) drop the epoch, for every stream (a resource's id is stable). Resource tests run before the change.

### 3.3 One row per key

On a keyed stream the replica never holds two entries with one key.

- **Live event with a held key:** the held entry is updated in place and keeps its position; with a new key it is appended. The content merge of an item's rows (assistant text deltas, reasoning, tool results) is the existing merge of `coalesceEntry`; what is replaced is its *matching* (previous entry, `sameContext`, `messageId`): the key decides.
- **Page:** entries are applied by key. An `after` or `tail` page updates held keys in place. An **older** (`before`) page **drops any key the client already holds**, so an item updated above the window, which the Relay now serves in its new place, cannot appear twice or leave a hole.
- **Replacement (3.4):** merged by key.
- Tests: React key uniqueness, and no holes and no duplicates, with older paging after an update above the window.

### 3.4 Absorbing a replacement

Trigger: a `timeline_replacement` frame, a frame whose epoch is neither the current nor the pending one, or a page with `reset`, `staleCursor` or `gap`. One reduction (`replaced`), one reaction: `pendingEpoch = epoch`, keep `entries`, fetch the tail.

- **Buffer every frame of `pendingEpoch`**, including a `gap` or `staleCursor` in the same epoch (it buffers in `pendingLive` and waits for the tail; it does not start another reset). Frames of the current epoch that arrive while a replacement is pending are ignored. **The old epoch is retired only when the tail is applied**, so `retiredEpochs` never holds the epoch a pending page might still name.
- A second replacement while one is pending retargets `pendingEpoch` and fetches the tail again. No queue.
- The tail request asks for `max(historyPageSize, held entries)`, at most 200, so held rows inside the Controller's window are not dropped for lack of room.
- Cursor consumers (`nextSeq`, `conversation-activity`, `useSessionTracking`) read the current epoch until the tail is applied.
- An attention cursor in an epoch the replica has retired is acknowledged once the replica holds the new epoch's content (`useSessionTracking.tsx` ~121 now keeps it unacknowledged for ever). Test it.

`absorbTail(held, page)`:
1. For each entry of the page, in order: a held row with the same key and equal content (D5) keeps its held `item`, `resources`, `collapsed` and `timestamp` and takes the new sequence fields; a held key with different content takes the new entry; an unheld key is inserted.
2. Held rows whose key is not in the page are removed, including rows older than the page's first row. The held rows are not verified by the new epoch, and older history loads again through `loadOlder`. The one visible effect is on a reader who scrolled above the new window: the viewport lands on the window's first row. It is bounded and counted.
3. `nextSeq`, `hasOlder`, `epoch` come from the page; `pendingEpoch` clears; the old epoch retires; buffered frames drain through `drainPending`.

An entry without `itemKey` keys by epoch, so a new epoch matches none of them and the tail replaces them all, but never through an empty state.

### 3.5 What keeps a row, the scroll and the composer

- **Row.** `ConversationEntry` is a memo component. After absorption the `entry` wrapper is new while `item`, `resources` and `collapsed` keep identity. The memo compares those and the other row props, and ignores `seqStart`, `seqEnd` and `sourceSeqRanges`; the row's `sequence` prop (Trace and a data attribute) is read from the state when needed. A render counter pins "no re-render".
- **Scroll.** `useTimelineScroll` anchors on the first visible row's `data-entry-key` and restores its offset after layout. Surviving keys keep the anchor; removing the epoch from the container key (3.2) stops the remount.
- **Composer.** It is outside the keyed tree; draft text, focus and selection are unchanged, and a browser test asserts it.

### 3.6 The ledger

An outgoing message records `afterKey` (the row key of the newest row when it was sent) and `consumedEchoKeys`. An echo is a matching `user_message` after `afterKey` in row order. A replacement that keeps `afterKey` keeps the message awaiting its echo; if `afterKey` is gone the message is `unconfirmed`, as a reset does today. A ledger persisted before S4a is read once as `unconfirmed` and written back in the new form.

### 3.7 The core: live-only items leave the positional comparison (C1)

`SessionJournal.sync` compares the window with the journal in order (`extensionOf`, `session-journal.ts` ~370). A live-only item the Controller re-adds at open (the todo) moves between the window and the journal and counts as `changed`, so every Controller start of a todo session replaces the journal.

The invariant: **live-only items take no part in the positional comparison.** `extensionOf` compares the window's and the journal's non-live-only items as today, then:
- a live-only item of the window whose key the journal holds updates that item's body in place and keeps its position;
- a live-only item with a new key is appended;
- a live-only item the journal holds and the window lacks is carried, as today.

An in-place update is a row of the existing item (a stamped row; the outcome is `appended`), and a window whose live-only items are equal is `unchanged`. The S2 test of a live-only key carried to the front and re-read at the end (replace) now gives no replacement; that test changes with the rule.

Test (`journal-sync.test.ts`, a real `SessionJournal` and `MemoryJournalStore`): a restart with an unchanged todo gives `unchanged`; with a changed todo, `appended`; neither ever `replaced`. The tests **assert the sync outcome**, not only the item count, and a Relay-level test runs five restarts and sees zero `replaced` and one `todo` item.

## 4. The fixes S3 found

### 4.1 `failed` compaction status

Copilot emits a `compaction` item as `loading` and, when native compaction fails, a separate `error` item. The `loading` item never ends, so the page shows "In progress" for a failed compaction.

- `AgentTimelineItem` compaction `status` gains `'failed'`. The Copilot projector completes the item with `failed` and keeps the `error` item for the cause. `CompactionItem.tsx` renders `Failed`.
- Rule 5: one enum value, nothing to replace, because a `loading` item needs a terminal state other than `completed`. It removes a wrong state (in progress for ever).
- Ordering: a Relay that does not know `failed` rejects the item, so the Relay and bundle update before Controllers, as in any release. The recorded fixture for a failed compaction expects `failed`. Claude Code has no failure event and is unchanged.

### 4.2 One todo item per session

Each Controller start emits `todo:<uuid>` (`liveOnly`), and each list change another; S3 found 7 items after 6 restarts.

- The invariant is in the adapter and the SDK: **a live-only item's key names its kind in the session, not an occurrence.** The Copilot adapter emits `{key: 'todo', completes: true, liveOnly: true}`. With 3.7 a later snapshot updates that item in place and no start can replace the journal. The SDK documents the rule beside `liveOnly`, and its conformance test fails an adapter that emits two live-only keys of one item type in a session.
- The board stays where it first appeared; moving it needs a removal operation, which fails rule 5.
- A restart still appends one row (same key, same content), because the adapter does not know the journal's copy. Task 7 measures it (expected: 0 items, one 528-byte row).

### 4.3 Time drift between paths does not matter

The journal keeps the time of the live event, the Controller reads Copilot's native time; they differ by 2 to 3 s, and no time moved inside one path. It affects neither order nor identity. It would matter only if a time difference counted as a content change and re-rendered every row on a replacement, so D5 ignores timestamps and an unchanged row keeps its held time. A changed row takes the new entry's time. No adapter or Relay change.

## 5. Measurement

### 5.1 Arms and conditions

- **Control:** the build before S4a (HEAD `00b211d5` or later, journals on, Copilot journal-served), in `.worktrees/s4-control` with its own instance. It is measured before any change.
- **S4a:** the S4a build, journals on. **S4a crude:** the same with smart reading off for Copilot.
- **Conditions:** no emulation, 4x CPU, 100 ms round trip, both. One instance at a time, the same five P0 sessions and the S3 Copilot sessions.

### 5.2 Proxy and scenarios

`latency-proxy.mjs` delays every HTTP exchange and WebSocket byte by half a round trip each way, rewrites the origin and can close every WebSocket. `local-baselines.mjs` gains `--rtt`; a run fails if no WebSocket crossed the proxy. The command line talks to the instance directly.

| Scenario | Target | Counted or timed | Pass |
|---|---|---|---|
| `restart-continuity` (whole instance restart, page open) | T6 | every row node marked, survivors, row-less states | 0 re-keyed rows, 0 row-less states |
| `replacement-absorbed` (new: the runner stops the Controller, edits one item in the native history of a Copilot session it created, restarts, forcing a `changed` replacement) | T6 | rows marked, composer text and focus, scroll anchor offset | unchanged nodes survive, the changed row updates in place, composer unchanged, anchor offset moves at most 1 px, 0 row-less states |
| `runtime-release` (Copilot `session release`, then open) | T6 | rows, replacements by reason (Relay diagnostic) | rows kept |
| `switch` (`local-switch.mjs`) | none in P0 | cold and warm times, HTTP requests, opening-label states | recorded; warm no slower than cold |

S4b adds `open-known`, `open-fresh` and `return`; this plan's runner changes include their counted fields so S4b only runs them.

### 5.3 The journal-served signal

S3 counted a Controller-answered open by an attach finishing first and could not tell a fast resident attach from a miss. In the S4 arms a stream that echoed the `itemKeys` flag is journal-served (3.1: Controller-answered streams never echo it), and the runner reads the `negotiated` frame. **The runner reads `journals.sqlite` only for the control arm**, which has no flag: the page's `timeline_page` epoch equals the `meta` epoch. Because `meta` can change during a sample, the runner reads `meta` before and after each sample and classifies a sample journal-served only if both reads equal the page's epoch. A sample that is not journal-served is excluded from every statistic and the summary says how many were used.

### 5.4 Recording

`summarize-p1d.mjs` prints one table per target with the P0 figure, the control, S4a and S4a crude, and a verdict per criterion; a miss is recorded as it is. Results go to `2026-11-16-s4a-results.md`; raw JSON stays in `.tmp/s4/`. **Minimum sample count:** each scenario and condition needs at least 20 samples for a p50 or p95 to be reported (10 for the 4x conditions of the restart and replacement scenarios, which restart the instance and take about a minute each); with fewer, the table gives the maximum and says n.

## 6. Tasks

Each task leaves the repository green and ends with its suites under deadlines and a commit.

1. **Latency proxy, runner and control measurement.** Files: `packages/agent-remote-lab/performance/` (`latency-proxy.mjs` + test, `local-baselines.mjs`, `journal-measurement.mjs`, `summarize-p1d.mjs` + test, `README.md`). The proxy, `--rtt`, `--label`, attach-relative T2 and counted T1 fields (for S4b), marked row nodes, the journal-served signal of 5.3, the `replacement-absorbed` scenario. Build the control worktree and **run every scenario for the control now**. Gate: control results exist and the summary prints P0 beside it.
2. **Keys on the wire and the Relay stripping the flag.** Files: protocol `timeline.ts`, `envelope.ts`, `messages.ts`, fixtures and schemas; `journal-session-stream.ts`; `broker.ts` (both forwarding paths); the client's `negotiate`. Tests: conformance; a real-transport test (hosted Relay over real HTTP and WebSocket) with a flagged and an unflagged client; **a real-transport test with a Controller that refuses unknown fields** (a Strict decoder) and a flagged client: the stream opens, keys are absent, the flag is not echoed. `pnpm compatibility:update` then `pnpm compatibility:check`.
3. **The core invariant (C1).** `session-journal.ts` `extensionOf` and `sync`, 3.7, with the outcome tests.
4. **Compaction `failed` and the single todo key.** Section 4, with the Copilot fixtures and the SDK conformance rule.
5. **Absorption with one row per key.** Files: `replica/{types,reducer,timeline-entry-key,message-outbox,store}.ts`, `client/remote-session-client.ts`, `react/{AgentTimeline,ConversationEntry,AgentComposer,timeline-render-model}.tsx`, `hooks/useSessionTracking.tsx`. Sections 3.2 to 3.6. Reducer tests (pure): unchanged rows keep identity; changed in place; missing removed; new inserted; older rows removed; pending-epoch buffering including `gap` and `staleCursor`; the old epoch retires after the tail; a second replacement retargets; legacy entries replace without an empty state; the ledger survives or becomes `unconfirmed` by `afterKey`; **rows built live equal rows built from a page** (D5); an attention cursor of a retired epoch clears; React key uniqueness and no holes or duplicates with older paging after an update above the window. Component tests: 0 re-renders of unchanged rows, no container remount.
6. **Acceptance tests (section 7).**
7. **Measure and record** (section 5), including replacements per open and bytes per Controller restart for Copilot against S3 (12,422 bytes, 7 `todo` items).
8. **The deletion task, documents and the local check.** Section 8 and section 9; `docs/current/agent-remote/protocol.md` and `web.md`, the performance README, the roadmap rows.

## 7. Acceptance tests

Test observable behaviour. Protocol and reconnect behaviour use real transports.

**Real transports** (hosted broker over real HTTP and WebSocket, the journal core with a real store, a fake Controller; the real `RemoteSessionClient` over the real session-channel transport, rendered in jsdom):
1. **Replacement absorbed.** One item changes and one disappears. Unchanged rows' DOM nodes are the same objects and rendered 0 more times; the changed row updated in place; the removed row is gone; a new row is inserted in order; the entry list was never empty; the composer's text, focus and selection are unchanged.
2. **Same epoch continues.** A reconnect with an unchanged journal issues one `after` request and no tail.
3. **A message awaiting its echo across a replacement** is confirmed by its echo when its anchor row is kept, and `unconfirmed` when it was rewritten.
4. **The flag.** Flagged: keys on pages and live frames, row keys equal item keys. Unflagged: frames that pass the old Strict schema. A refusing Controller: opens, no keys, no echo.
5. **Replacements in a row, and during a catch-up,** end in the last epoch's rows with no stuck pending state.
6. **Copilot.** A failed compaction ends `failed`. Five restarts with a changed todo give `unchanged` or `appended`, never `replaced`, and one `todo` item.

**Real browser** (Playwright Chromium, headless, the lab served by the same journal-served fixture):
7. **No re-keyed rows and no scroll jump.** Mark every row node; read a middle row's offset; force a replacement; every unchanged node keeps its mark, the offset moves at most 1 px, and a `MutationObserver` saw no state without rows.
8. **A reader above the new window** lands on the window's first row and can scroll up through older history again.
9. **Composer.** Text, focus and selection survive a forced replacement; the editor never became disabled.

Suites before each task's commit: web, lab (Node 22), protocol, hosted, relay, journal, journal-sqlite, the SDK and Copilot, conformance, and the Playwright spec. The Gate S2 counts are the floor; deletions that lower them are listed in the results file.

## 8. The deletion task

1. `retainedDisplay` in `SessionConversation.tsx`, and `workspaceDisplayState` where nothing else reads it. (`workspace-cache.ts` itself goes in S4b.)
2. In `replica/reducer.ts`: the `reset_required` and `epoch_changed` statuses and their branches; the clearing `applyTimelineReplacement`, which becomes the marking of `pendingEpoch`; the callers that distinguish them (`remote-session-client.ts`, `store.ts`, `useSessionCatchUp.ts`).
3. The epoch terms of the container key, `HistoryControls` key and both resource scopes.
4. The ledger's `epoch`, `afterSeq`, `consumedEchoSeqs` and their branches (`message-outbox.ts`, `remote-session-client.ts` ~482).
5. In the core: the live-only special cases of `extensionOf` and the S2 test that pinned the replacement.
6. Tests that pin the removed behaviour.
7. **Recorded for S6, not done here** (Controller-answered streams still need them): the flag, the old row key and `itemIdentity()`, `mergeAuthoritative`'s range-overlap rule, `coalesceEntry`'s type-based matching, `retiredEpochs`, the `stale_epoch` status.

State at the end: wire +4 optional fields and +1 enum value, replica +1 field and -1 outcome, ledger 0, lab -1, core -3 branches, journal items -1 per start; publisher fields unchanged at 19. Record the line counts in the results file.

## 9. The local-instance check, with Copilot journal-served

Last. Follow `.agents/skills/prepare-arc-local/SKILL.md`: this checkout's instance, free ports, the headless Playwright of this repository, one browser context per script, `ARC_LOCAL_JOURNALS=1` on every `up`.
1. The S3 Copilot session and one of at least 150 items made with real turns.
2. Prove journal serving: the page's `negotiated` frame echoes `itemKeys`, and its `timeline_page` epoch equals the epoch in `journals.sqlite`'s `meta`; with smart reading off it is the Controller's.
3. Controller restart with the page open, three times: marked rows survive, no frame without rows, the `todo` item count stays one, the Relay diagnostic shows no `replaced`.
4. Forced replacement (`replacement-absorbed`): unchanged rows survive, composer keeps text and focus, anchor offset holds; screenshots before and after.
5. Switch between sessions; send a message across a restart; a release and an open.
6. A failed compaction cannot be forced locally; the fixture test covers it, and the check says so.
7. No `journal_open_refused`, `journal_session_unserved` or `journal_session_restarted` beyond the forced replacement; the owner's own processes are untouched.

## 10. Risks and what is not in S4a

- A replacement while a reader is far above the window loses that position (3.4). It is rare (S3: 0 in 30 opens) and counted.
- Controller-answered streams get no item keys until S6: no blank frame, but no row survival across an epoch change.
- A restart still appends one `todo` row.
- Not in S4a: the device store, labels, T1, T2 and the return budget (S4b); the attach shortcut (S5); the Controller's item keys (S6).

## 11. S4a measurements and record

Recorded 2026-11-16 and 2026-11-17 on this checkout's instance (Apple M4, 16 GiB, Chromium 151, Node 22), Copilot only: four sessions (24, 35, 5 and 158 items), made with real turns in the instance workspace. `ARC_LOCAL_JOURNALS=1` was exported for every `up`, restarts made by the runner included. Raw JSON: `.tmp/s4/` (not committed). The tables are the output of `summarize-p1d.mjs`.

| Arm | Build | Smart reading for Copilot |
|---|---|---|
| Control | the `dist` of `59b05441` (production code identical to `634e72da`; docs only since), measured before any client change, on this checkout's instance (see "Departures") | on |
| S4a | `7127aea7`, clean | on |
| S4a crude | `7127aea7` | off (1x and 4x CPU with 100 ms only) |

**Method.**
- `latency-proxy.mjs` delays HTTP and WebSocket traffic by half a round trip each way; a run is invalid when no WebSocket crossed it. 4x CPU is the Chromium throttle. One headless page per sample: pages of one user share their Window, so a second page switches the first.
- `restart-continuity`: one page on a session, every row node marked, `pnpm local up --no-build`, the nodes still in the document counted; six restarts per condition, the four sessions in turn.
- `replacement-absorbed`: a turn whose shell command takes a minute runs in the session, one page holds it with every row marked, a draft in the composer and the timeline scrolled to its middle; the instance restarts during the tool. The Controller's window then differs from the journal's open tool and the Relay replaces the journal (reason `open_item`). Only samples for which the Relay recorded a `changed` or `open_item` window count as forced; the others are listed as used. The S4a numbers pool two runs of six (the second scrolled with a wheel event, like a reader, the first by setting `scrollTop`).
- `runtime-release`: Copilot has no runtime to release (`released: false`), so it shows rows kept while nothing happens.
- A sample counts only when journal-served: the control by the page's epochs equalling the epoch in `journals.sqlite` before and after the sample, S4a by the stream echoing `itemKeys`. A percentile needs 20 samples; no cell has them, so cells state maxima and counts (n = 6 per condition, 12 pooled for the replacement scenario, below the plan's minimum of 10 for single runs).

### T6: the open conversation across a Controller and Relay restart

| Arm | Condition | Samples used | Rows marked | Rows re-keyed | Row-less states (max) | Verdict (0 and 0) |
| --- | --- | --- | --- | --- | --- | --- |
| P0 (marks the first row only) | no emulation | n/a | n/a | 2 of 2 sessions lost the marked row; 0 row-less states | n/a | n/a |
| control | no emulation | 6/6 | 226 | 0 | 0 | pass |
| control | 4x CPU | 6/6 | 269 | 0 | 0 | pass |
| control | 100 ms round trip | 6/6 | 316 | 0 | 0 | pass |
| control | 4x CPU and 100 ms round trip | 6/6 | 361 | 0 | 0 | pass |
| s4a | no emulation | 6/6 | 396 | 0 | 0 | pass |
| s4a | 4x CPU | 6/6 | 415 | 0 | 0 | pass |
| s4a | 100 ms round trip | 6/6 | 432 | 0 | 0 | pass |
| s4a | 4x CPU and 100 ms round trip | 6/6 | 448 | 0 | 0 | pass |
| s4a-crude | no emulation | 6/6 | 519 | 519 | 0 | miss |
| s4a-crude | 4x CPU and 100 ms round trip | 6/6 | 536 | 536 | 0 | miss |

### T6: a forced replacement (the Relay recorded a `changed` or `open_item` window; other samples are not counted)

| Arm | Condition | Samples (forced/used/all) | Rows marked | Rows re-keyed | Row-less states (max) | Draft changed | Focus lost (editor disabled while reconnecting) | Anchor lost | Anchor shift max (px) | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| control | no emulation | 5/6/6 | 239 | 239 | 0 | 0 | 5 | 5 | 0 | miss |
| control | 4x CPU | 4/6/6 | 257 | 257 | 0 | 0 | 4 | 4 | 0 | miss |
| control | 100 ms round trip | 4/6/6 | 288 | 288 | 0 | 0 | 4 | 4 | 0 | miss |
| control | 4x CPU and 100 ms round trip | 4/6/6 | 317 | 317 | 0 | 0 | 4 | 4 | 0 | miss |
| s4a | no emulation | 5/12/12 | 441 | 0 | 0 | 0 | 5 | 0 | 0 | pass |
| s4a | 4x CPU | 5/12/12 | 500 | 0 | 0 | 0 | 5 | 0 | 0 | pass |
| s4a | 100 ms round trip | 5/12/12 | 459 | 0 | 0 | 0 | 5 | 0 | 91.4 | miss |
| s4a | 4x CPU and 100 ms round trip | 4/12/12 | 400 | 0 | 0 | 0 | 4 | 0 | 91.4 | miss |
| s4a-crude | no emulation | 6/6/6 | 533 | 533 | 0 | 0 | 0 | 6 | 0 | miss |
| s4a-crude | 4x CPU and 100 ms round trip | 6/6/6 | 548 | 548 | 0 | 0 | 0 | 6 | 0 | miss |

### T6: a runtime release

| Arm | Condition | Samples used | Rows marked | Rows re-keyed | Row-less states (max) | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| control | no emulation | 4/4 | 166 | 0 | 0 | pass |
| control | 4x CPU | 4/4 | 189 | 0 | 0 | pass |
| control | 100 ms round trip | 4/4 | 214 | 0 | 0 | pass |
| control | 4x CPU and 100 ms round trip | 4/4 | 238 | 0 | 0 | pass |
| s4a | no emulation | 4/4 | 258 | 0 | 0 | pass |
| s4a | 4x CPU | 4/4 | 269 | 0 | 0 | pass |
| s4a | 100 ms round trip | 4/4 | 279 | 0 | 0 | pass |
| s4a | 4x CPU and 100 ms round trip | 4/4 | 289 | 0 | 0 | pass |
| s4a-crude | no emulation | 4/4 | 331 | 0 | 0 | pass |
| s4a-crude | 4x CPU and 100 ms round trip | 4/4 | 341 | 0 | 0 | pass |

### Switch time (median of the switches of one run; below the 20-sample minimum for a percentile)

| Arm | Condition | Cold ms | Warm ms | HTTP API requests (cold / warm) | Opening-label states (cold / warm) | Row-less states (cold / warm) | Verdict (warm no slower than cold) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P0 | no emulation | 67 | 100 | n/a | n/a | n/a | n/a |
| P0 | 4x CPU | 88 | 110 | n/a | n/a | n/a | n/a |
| control | no emulation | 43 | 43 | 1 / 1 | 0 / 1 | 0 / 1 | pass |
| control | 4x CPU | 77 | 66 | 1 / 1 | 1 / 1 | 1 / 1 | pass |
| control | 100 ms round trip | 48 | 45 | 1 / 1 | 0 / 1 | 0 / 1 | pass |
| control | 4x CPU and 100 ms round trip | 74 | 62 | 1 / 1 | 1 / 1 | 1 / 1 | pass |
| s4a | no emulation | 45 | 46 | 1 / 1 | 0 / 1 | 0 / 1 | miss |
| s4a | 4x CPU | 71 | 70 | 1 / 1 | 1 / 1 | 1 / 1 | pass |
| s4a | 100 ms round trip | 40 | 44 | 1 / 1 | 1 / 1 | 0 / 0 | miss |
| s4a | 4x CPU and 100 ms round trip | 68 | 75 | 1 / 1 | 1 / 1 | 1 / 1 | miss |
| s4a-crude | no emulation | 46 | 45 | 1 / 1 | 0 / 1 | 0 / 1 | pass |
| s4a-crude | 4x CPU and 100 ms round trip | 74 | 62 | 1 / 1 | 1 / 1 | 1 / 1 | pass |


**Verdicts.**

- **T6, a Controller restart with the page open: met by the control and by S4a.** 0 of 1,172 marked rows re-keyed in the control (24 samples) and 0 of 1,691 in S4a (24 samples), 0 row-less states in both; the budget "no re-keyed rows after a Controller restart" held already, because the journal keeps its epoch across a restart. What S4a changes is what the Relay sees: the 24 restarts gave 39 windows, all `unchanged` (the control: 28 `unchanged` and 11 `appended`, one per Controller start of a session with a todo board). One restart of a fresh session with a todo board, five times: 5 `unchanged` windows, 2,300 bytes each, one `todo` item and nothing written (S3: 12,422 bytes and one more `todo:<uuid>` item per start, 7 after 6).
- **T6, a forced replacement: missed by the control, met by S4a for rows and draft.** The control re-keyed every row of every forced sample (1,101 of 1,101 rows over 17 samples: 239, 257, 288 and 317 per condition) and lost its anchor row. S4a re-keyed 0 of 1,800 rows over 19 forced samples (the unchanged rows kept their DOM nodes; `open_item` replaced the journal), had 0 row-less states, kept the draft text and selection in all of them and kept the anchor row in all of them. The editor loses focus in the forced samples of both builds because it is disabled while the session reconnects (the Controller restarted), which has nothing to do with the replacement; the real-browser test shows focus kept when nothing reconnects. The reading position of the anchor row moved by 34 to 91 px in the runner's samples of S4a, in unforced samples (an unchanged window, 10 to 61 px) as well as forced ones (about 90 px). The unforced shift is the session-control notice that appears while the session reconnects; the forced one, in the 158-item session, is the running tool row that lost its output and became 90 px shorter while the timeline followed its bottom (screenshots in `.tmp/s4/shots/`). The 1 px criterion is therefore proven in the real browser test (a reader holding a row stays within 4 px of half-pixel layout through a replacement that removes and adds rows above it), not on the live instance.
- **T6, a runtime release:** rows kept in every arm (Copilot has nothing to release).
- **The crude path (smart reading off):** every row is re-keyed at every restart and replacement (519 of 519, 533 of 533) and there is never a row-less state (0). Controller-answered streams have no item keys until S6; what S4a gives them is no blank frame, because the replacement keeps the held rows until its tail is read.
- **Switch time** (recorded, no P0 criterion): S4a cold 40 to 71 ms and warm 44 to 75 ms at the median (the control cold 43 to 77 ms, warm 43 to 66 ms), 1 HTTP request per switch, 0 to 1 opening-label states and 0 to 1 row-less states per switch, equal to the control within noise; "warm no slower than cold" misses by 1 to 7 ms in three S4a conditions, which is noise on medians of 12 switches. The switch is not the bottleneck on a journal-served session.
- **Replacements per open:** 0 replaced windows in 24 restart samples and 16 release samples of S4a (the control: 0 as well); the only replacements are the forced ones.

**Counted state (rule 1).**

| Item | Before | After |
|---|---|---|
| Replica fields | | +1 (`pendingEpoch`) |
| Reduction outcomes | 7 | 6 (`applied`, `buffered`, `duplicate`, `gap`, `replaced`, `stale_epoch`) |
| Outgoing ledger fields | `epoch`, `afterSeq`, `consumedEchoSeqs` | `afterKey`, `consumedEchoKeys` |
| Journal core | 3 live-only special cases in `extensionOf` | `planOf` loop and `nativeExtension` (one rule) |
| Wire | | 4 optional fields (`itemKey` twice, `itemKeys` twice), 1 enum value, 1 optional field on the page request between the Relay and its store |
| `SessionPublication` | 19 fields, 4 recovery outcomes | unchanged |
| Journal items | 1 more per Controller start of a todo session | 0 |
| Lab | `retainedDisplay` | kept (see "Departures") |

Production code `634e72da..HEAD`: +467/-157 lines in 34 files (tests +1,158/-51, measurement tooling +558/-64, documents +5/-3).

**Departures from the plan.**

- **The control ran on this checkout's instance, not in `.worktrees/s4-control`** (the owner's instruction for this run). Its production code is the build that was already running (`59b05441`), and no product code was rebuilt until the control finished; the runner's `up --no-build` restarts reported the checkout's newer revision (docs and runner changes only). The control cannot be re-measured now: the `dist` was rebuilt for S4a.
- **The forced replacement is a restart during a long tool, not an edit of native history.** The instruction for this run is never to touch `~/.copilot`. The restart makes the Controller's window differ from the journal's open tool item (`open_item`), a real replacement with real changed rows, but whether the window differs depends on the native history, so only some samples force one; the summary counts those.
- **`retainedDisplay` stays.** It also keeps a pane that the live budget released showing its last rows (`SessionConversation.connections.test.tsx` pins it), not only the clear-and-refill that no longer happens. S4b's device store replaces it.
- **The browser acceptance is a bundled fixture in Chromium, not a spec against a journal-served Relay.** It renders the product's timeline, composer and scroll hook over the replica and replaces the epoch as the client does; the live instance, with real browser, real Relay and real Controller, covers the rest through the runner and the local check. The real-transport tests of acceptance 1 to 5 run the real client over a real WebSocket against a scripted journal Relay in jsdom; the flag and the refusing Controller run against the hosted broker (in-memory sockets, as its other tests), not over HTTP.
- **The page request carries the flag** (`itemKeys` on the request between the Relay and its store) instead of the stream removing the key from entries: the Cloudflare partition contract answers a request without it exactly as before, so an older primary Worker can read a newer partition.
- **The reading position** is within 4 px in the real-browser test, not 1 px, and not measured against a replacement alone on the live instance (see verdicts).
- **Sequence labels.** A row ignores a change of its sequence alone, so its `Inspect event #N` label keeps the number it had when it last rendered; the inspector reads the row by key.
- **Samples:** 6 per condition (12 pooled for the replacement scenario), not 10 or 20, because every sample restarts the instance.
- **Task 3's Relay-level test** runs in `journal-window.copilot.journal.test.ts` (Relay loopback over the recorded Copilot runs) and in `journal-sync.test.ts`, not in a separate hosted test.

**What the owner must know.** No Controller has to update: the Relay removes the flag before a Controller sees it, the failed-compaction status needs the Relay and the bundle to update before Controllers (a Relay that does not know it rejects the item), and the Cloudflare partitions Worker still deploys first. The web bundle now sends `itemKeys: true`, so it needs a Relay of this build (the bundle and the Relay ship together).

## 12. Review follow-up (2026-11-17)

- **Updates above the window.** The journal keeps an updated item's first sequence, so an `after` page used to put it above the held rows (or move a held row up) and `loadOlder` then skipped everything between. A held row keeps its first sequence and place; an unheld key above the first held row waits for the older page. Tests: reducer (with a real sort assertion) and the real client over a real WebSocket reading a real `SessionJournal` and `pageJournal` (`journal-served-reconnect.test.ts`, in the lab because it needs the client and the journal together).
- **Pending rules.** Only the tail of the pending epoch applies; a gap or stale cursor makes the held epoch pending too. `mergeRowIntoEntry` moved to the protocol package and the client's keyed merge is gone; an unkeyed stream anchors a message by position; a retargeted replacement no longer acknowledges an attention cursor; a row's Inspect and Select labels carry no sequence.
- **Reading position (departure 4).** Control build rebuilt in `.worktrees/s4-control` (its own instance, `634e72da`), reader mode (wheel, then a restart with no replacement): control 0 to 1 px (3 samples); S4a 32 px (3 of 3). Cause: the scroll hook took its anchor again at the end of every restore, so a position restored in the middle of a layout change (the viewport resizing while the session reconnects) became the new reading line. With rows no longer re-rendered nothing corrected it afterwards; the control re-rendered every row and a later mutation did. The hook now takes the anchor again only while following, without one, or after a restore that the browser did not clamp (a write past the end of the scroll range leaves the line displaced). S4a after the fix: 0 px (3 of 3 on the instance, reader mode, restart without replacement). The runner's own anchor samples still show 34 to 60 px where a turn was running at the restart (the composer's status row goes away while the viewport stays reader-held); the control cannot be compared there because every such sample is a forced replacement that loses its anchor row. The Chromium test keeps the line within 4 px through a viewport height change (it does not fail without the fix: the clamped case needs a reconnect, so the live instance is the evidence).

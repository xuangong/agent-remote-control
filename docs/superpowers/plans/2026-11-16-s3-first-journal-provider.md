# S3: the first journal provider (Copilot), enabled and measured on `pnpm local`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax. This plan states interfaces, deletions and acceptance tests, not code, under the rules in the [roadmap](2026-11-15-im-session-service-roadmap.md) ("Revised order after the simplification assessment"). It supersedes the [P1-C2 plan](2026-11-15-p1c2-provider-item-identity.md); that plan's "Research for the relaxed contract" section is the evidence this plan starts from.

**Goal:** One provider, GitHub Copilot, publishes its sessions to Relay journals under the relaxed item-identity contract. Journals and the Copilot smart-reading switch are turned on in this checkout's local instance, and the numbers that decide the deferred items (I2, M3, M6, "drop oldest instead of evicting bodies") are recorded.

**Architecture:** The SDK contract is unchanged. The Copilot adapter owns keys, completion and live-only marks; the Controller never infers them. The journal core keeps its one decision (`sync`) and gains a reason on a replacement; the Relay reports each window and Controller request as a diagnostic. Client protocol and renderer are untouched (S4).

**Tech stack:** TypeScript, Vitest, `@github/copilot-sdk`, the real `copilot` CLI driven by `tests/native-fixture.ts` for recordings, Playwright through `local-baselines.mjs`.

---

## 1. Rules, gates and environment

**Worktree.** `/Users/xian/projects/agent-remote-control/.worktrees/im-session-service`, branch `design/im-session-service`, HEAD `0473df3f` or later, clean. Never touch the main checkout. Never push. Use free ports for local validation.

**Environment for every command.**

```
cd /Users/xian/projects/agent-remote-control/.worktrees/im-session-service
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
find packages/*/src -type d -name node_modules -prune -exec rm -rf {} +   # stray modules break the lab suite
```

**Per-package suite** (always a per-test and an outer deadline): `timeout 600 pnpm --filter <name> exec vitest run [files] --testTimeout=10000`.

Filters: `@orchardworks/agent-provider-sdk`, `@orchardworks/agent-provider-copilot`, `@orchardworks/agent-remote-controller` (directory `packages/agent-host`), `@orchardworks/agent-remote-journal`, `-hosted`, `-relay`, `-protocol`, `-lab` and `-web` (Node 22); Cloudflare uses `pnpm test:cloudflare`.

**Gate G, the end of every task:**

1. The task's named suites pass.
2. `timeout 900 pnpm typecheck`.
3. `timeout 300 pnpm compatibility:update && timeout 300 pnpm compatibility:check`.
4. `git --no-optional-locks diff --shortstat HEAD -- packages` recorded in the task's notes.
5. Commit in the worktree: `git add -A packages docs scripts && git commit` with the task title and its State line, ending with `Co-Authored-By: Claude <noreply@anthropic.com>`.

**Gate S3** (end of Task 7): `timeout 3000 pnpm test`, `timeout 900 pnpm test:conformance`, `timeout 900 pnpm test:cloudflare`, then Gate G, then the measurement record of Task 7.

**Preconditions, checked once before Task 1:**

- [ ] `git status --short` is empty and `git log -1 --format=%h` is `0473df3f` or later.
- [ ] `git grep -n "journal:" -- 'packages/agent-provider-*/src' ':!*.test.ts'` prints nothing (no provider is capable yet).
- [ ] The publisher field count `grep -cP '^  private (?!readonly)(?!async)(?!get )\w+\s*[:=;]' packages/agent-host/src/journal-publication.ts` is 19 (baseline for the budget).
- [ ] The Copilot native fixture runs: `pnpm --filter @orchardworks/agent-provider-copilot exec vitest run tests/native.test.ts --testTimeout=60000` (the real CLI against a scripted model, a temporary `COPILOT_HOME`, no sign-in).

## 2. Decisions and state accounting

"Fields" counts state a reader must hold in mind (persisted fields, mutable class fields, maps, flags). "Paths" counts recovery paths. Budgets: publisher at most 20 mutable fields, recovery outcomes at most 6. S3 starts at 19 and 4.

| # | Decision | Fields | Paths | Task |
|---|---|---|---|---|
| D1 | **Copilot goes first.** | 0 | 0 | all |
| D2 | **Stable keys per item kind** (Section 3), from native ids equal in the live stream and in `events.jsonl`. No key gap needs a hash. | adapter +1 (`pendingCompaction`) | 0 | 2 |
| D3 | **Completion marks**: `completes` on the last observation of an item, with an empty body for a text or reasoning item whose final text equals what was streamed. Tool and compaction rows repeat their whole content. An `abort` finishes every streamed item that never got its final message, with an empty live-only body, so none stays open. | 0 | 0 | 2 |
| D4 | **Live-only marks, the same in both deliveries**: todo snapshots, questions, forms and plan approvals (`user_input.*`, `elicitation.*`, `exit_plan_mode.*` are never written to disk), adapter-made errors, and the abort completions of D3. Tool approvals (`permission.*`) and reasoning (`assistant.reasoning` is persisted) are not live-only. | 0 | 0 | 2 |
| D5 | **A mismatch between the live stream and a reread is counted, not failed.** A corrected final message, a tool that streamed partial output, a differing tool field: each costs one `replaced`. The fixtures assert the expected outcome and reason, not equality. | 0 | 0 | 3 |
| D6 | **One reason on a replacement.** `SyncResult` `replaced` carries `reason: 'new' | 'incomplete' | 'open_item' | 'changed'`; a tool that streamed partial output is `changed`, never `open_item`. The core already decides in one place (`extensionOf`); it returns the reason instead of `undefined`. | core +1 result field | 0 | 1 |
| D7 | **Measurement through the Relay's diagnostics.** `journal_window_replaced` becomes `journal_window` (one per window, with `agentId`, `bytes`, and `reason` one of `unchanged`, `appended`, `new`, `incomplete`, `open_item`, `changed`). One new event, `journal_request` (`reason` `fill` or `older`), because eviction cannot be judged without it. The reason allowlist gains `unchanged`, `appended`, `new`, `incomplete`, `open_item`, `changed`, `fill`, `older`; the count allowlist gains `bytes`. Metadata only. | allowlist +1 count | 0 | 1 |
| D8 | **Switching on is configuration, not code.** The adapter declares `journal: { itemIdentity: 1 }`. The Relay serves journals only with `AGENT_REMOTE_JOURNALS=1` (`ARC_LOCAL_JOURNALS=1` locally) and the per-Host smart-reading switch for `copilot`, both off by default. Default production behaviour is unchanged. | 0 | 0 | 4, 6 |
| D9 | **No new publisher state, no new recovery outcome.** A mismatch heals through the existing reopen and window. | 0 | 0 | all |

**Why Copilot first** (research verified in code): every item kind has a native id equal live and in history; completion comes from native events with one empty-body case; it needs no P1-C3 read-only history; its adapter is one projector (172 lines) and one session class. Claude has key gaps (folded input, compaction rewrites) and content gaps; Codex hides its plan item live; OpenCode keys text by ordinal and needs P1-C3. Copilot's known live-versus-history differences are content differences, which the relaxed contract counts.

## 3. The relaxed contract for Copilot

**Keys** (type-prefixed, at most 4096 characters, never a delta source key, never the `controller:` prefix):

| Item | Key | Live and history |
|---|---|---|
| user message | `user:<event.id>` | same id in both |
| assistant text | `assistant:<messageId>` | deltas, final and history share it |
| reasoning | `reasoning:<reasoningId>` | read from `assistant.reasoning_delta` and `assistant.reasoning` (persisted; the delta is not) |
| tool call | `tool:<toolCallId>` | start, partial and complete rows share it |
| tool approval | `interaction:<requestId>` | `permission.*` is on disk |
| question, form, plan approval | `interaction:<requestId>`, live-only | never written to disk |
| compaction | `compaction:<start event id>` | completion and failure take the pending start (`pendingCompaction`); a failure finishes the item, it is not an `error` item. As built: the compaction item has no failed status, so a failed one ends as `loading` with `completes`, beside an `error` item; S4 adds a `failed` status and removes the error item |
| error | `error:<event.id>`; adapter-made: `error:<uuid>`, live-only | |
| todo | `todo:plan`, live-only | see Todo |
| corrected final message | `assistant:<messageId>:correction` | live only; not live-only-marked, so the next replacement drops it |

**Completion.** `user.message` and `error` complete at emit. `assistant.message` completes `assistant:<messageId>`: an empty body when the content equals what was streamed, the unsent suffix when it extends it, the whole content when nothing was streamed; an empty message with nothing streamed gives no item, live or reread. A content that does not extend the streamed text completes the base with an empty body and emits a complete correction item beside it. `assistant.reasoning` completes the same way; when its content does not start with the streamed text, the live row carries the same body the reread carries, so both deliveries agree (the `\n${content}` branch of `projector.ts` is replaced by that rule; the recordings confirm). `tool.execution_complete` and `session.compaction_complete` repeat the whole row with `completes`. `interaction_resolved` completes. A history observation completes its item unless the native record is open (a tool with no `tool.execution_complete`, a compaction with no completion); the Controller sends open items without a digest.

**Interrupted streams.** On `abort`, every text or reasoning item that was streamed and never got its final message is finished with an empty live-only body, so it does not stay open and inflate the I2 count. `tool.execution_partial_result` is not stored, so a tool that streamed output differs from its reread and replaces once, with reason `changed`. That is expected.

**Todo.** The snapshot `refreshTodos` emits when a session opens has no native position, and it lands out of order against a journal built live. The adapter emits a todo snapshot only for a live `session.todos_changed`, never at open; a reread then holds no todo, the journal's copy is live-only and carried, and a session with todos reopens `unchanged`. The recordings include a session with todos.

**Approval scope.** `interactionResponse` maps `approved-for-session` and `approved-for-location` to scope `session`, so the live item and the reread agree.

**Content mismatches** (counted):

| Case | Expected outcome of reopen |
|---|---|
| corrected final message | `replaced`, `changed`, once; the correction item is gone after it |
| tool that streamed partial output | `replaced`, `changed`, once |
| interrupted tool, same resident content | `unchanged`; a tool completed while the Controller was away: `replaced`, `open_item` |
| question, form, plan approval | `unchanged`: live-only, carried by the journal; the `approval` recording shows a question surviving a reopen |

**What stays where.** Native interpretation (what an event means, which id keys it) stays in `packages/agent-provider-copilot`. The Controller groups rows by key, merges, digests and sends the window. The Relay compares and decides. No Copilot knowledge enters the Controller or the Relay.

**What the adapter declares.** `journal: { itemIdentity: 1 }` in `provider.ts`, the last step of Task 4, after the fixtures pass. A session of a provider without it stays on forwarding.

## 4. Tasks

### Task 1: One reason on a replacement, and the window diagnostics (D6, D7)

**Files:** `packages/agent-remote-journal/src/{session-journal,types}.ts` (the reason), `packages/agent-remote-hosted/src/{host-journals,journal-uplink,relay-diagnostics}.ts` (emit `journal_window` and `journal_request`, `bytes`), `packages/agent-host/src/relay-diagnostics.ts` and its test (the Controller's delivery allowlist), `docs/current/agent-remote/protocol.md`.

**Interface.**
- `SyncResult`: `{ outcome: 'unchanged' } | { outcome: 'appended'; rows } | { outcome: 'replaced'; epoch; reason: 'new' | 'incomplete' | 'open_item' | 'changed' }`. `new`: the journal holds no item. `incomplete`: the journal was flagged. `open_item`: the first differing item is open in the journal or in the window. `changed`: a complete item differs, is missing or is out of order.
- `HostJournals.publish` result `window` gains `bytes` (the window's encoded size).
- Diagnostics: `journal_window` with `agentId`, `reason` and `bytes`; `journal_request` with `reason` `fill` or `older`.

**State:** fields +1 (core result field), allowlist +1 count (`bytes`); paths 0. Surface: `journal_window_replaced` is removed, `journal_window` replaces it; `journal_request` is new because eviction thresholds cannot be measured without it, and the reasons and count are metadata only.

**Tests** (real core and `createHostJournals`, in `packages/agent-remote-journal` and `packages/agent-remote-hosted`): each of the five outcomes and reasons is produced by a minimal window against a built journal; the diagnostic carries the reason and `bytes` and no content; fill and older requests each emit one `journal_request`; the Controller accepts and delivers the new events; the old name is gone (`git grep journal_window_replaced -- packages` prints nothing).

**Deletes:** the event name `journal_window_replaced` in `journal-uplink.ts`, `relay-diagnostics.ts` and the Controller's test list; the sentence about it in `protocol.md`.

**Run:** `-journal`, `-hosted`, `-controller` suites for those files, then Gate G.

### Task 2: Copilot identity in the adapter (D2, D3, D4)

**Files:** `packages/agent-provider-copilot/src/projector.ts` (identities; `reasoningId`; `pendingCompaction`; completion rows; the reasoning body rule; the abort completions), `session.ts` (`emit(event, identity?)`; no todo snapshot at open), `interactions.ts` (`interaction_resolved` carries its identity, live-only for questions, forms and plan approvals), `interaction-mapping.ts` (scope `session`), `projector.test.ts`, `provider.test.ts`, `docs/current/agent-remote/copilot-normalized-events.md`.

**Interface.** `Projector.projectAll` returns `{ key, event, identity? }`; `CopilotAgentSession.emit(event, identity?)`. Every timeline observation and every `interaction_resolved` carries an identity, as the SDK's `ProviderObservation.itemIdentity` requires. The declaration is not added in this task.

**State:** adapter fields +1 (`pendingCompaction`); no Controller state.

**Tests** (offline, scripted events, in `projector.test.ts`): every timeline observation of a scripted turn (user, streamed assistant, reasoning, tool with partials and completion, compaction pair, error, todo, resolved approval) has a key; keys are unique per item and equal between the live stream and `projectAll(..., 'history')` of the same events; a streamed text equal to the final text gives a completing empty body; an extending final gives the suffix with `completes`; a non-extending final gives an empty completing body plus a complete correction item `assistant:<id>:correction`; todo, questions, forms, plan approvals and adapter errors are live-only and reasoning and tool approvals are not; an `abort` finishes streamed items with an empty live-only body; a failed compaction finishes `compaction:<id>`; an empty message with nothing streamed gives no item; `approved-for-session` maps to scope `session`; a tool row without `tool.execution_complete` in history carries no `completes`; no key starts with `controller:`.

**Run:** `@orchardworks/agent-provider-copilot` suite, Gate G.

### Task 3: Recorded fixtures from the real provider (D5)

**Files:** `packages/agent-provider-copilot/tests/journal-recording.test.ts` (drives the real CLI through `tests/native-fixture.ts`, a scripted model and a temporary `COPILOT_HOME`; no sign-in), `packages/agent-provider-copilot/tests/fixtures/journal/*.json`, `packages/agent-host/src/test-utils/journal-continuity.ts`, `packages/agent-host/src/journal-continuity.copilot.test.ts`. If the recording test needs the CLI binary, name it `*.local.test.ts` and add `--exclude '**/*.local.test.ts'` to the package's `test` script, as the Claude package does.

**Recordings** (each a `ContinuityRun`: the `live` observations and the `reread` of the same native session):
1. `settled`: streamed text, a tool call with result, a second turn; released and reopened.
2. `reasoning`, including a final that does not start with the streamed reasoning.
3. `approval`: a tool approval, and a question; the question must survive a reopen.
4. `todos`: a session with todo changes; reopen gives `unchanged`.
5. `compaction`: one that succeeds, one that fails.
6. `interrupted`: a turn cancelled through the session's cancel, then released and reopened (never a killed process); and a tool that streamed partial output.
7. `restart`: `settled` with the `reread` from a new process.

**Interface** (`journal-continuity.ts`): `continuityOutcome(run)` returns `{ outcome, reason? }` (the core's result), and open items in the `reread` are allowed. `expectContinuity` is deleted (see Task 8).

**Tests** (Controller, offline, from the recordings): `settled`, `restart`, `reasoning`, `approval` (the question stays) and `todos` give `unchanged`; a second reread of any recording adds nothing; `compaction` gives the outcome the recording shows (asserted, documented, a failed one finishes its item); `interrupted` gives `unchanged` with no item left open, except the partial-output tool, which gives `replaced`/`changed` once; a tool completed while the Controller was away gives `replaced`/`open_item`; a window of the newest items of a long recording is a prefix-compatible `appended` when the session grew. Each test prints the expected outcome in its name, so a change of behaviour of the adapter is a visible test change.

**State:** none (test code and fixtures).

**Run:** `-controller` for `journal-continuity.copilot.test.ts` and `journal-continuity.test.ts`, and the recording test under `timeout 600`.

### Task 4: Real transport through `createHostJournals`, then the declaration

**Files:** `packages/agent-host/src/journal-window.copilot.journal.test.ts` (uses `relayLoopback`, which wraps `createHostJournals`, the publisher, a scripted Copilot session built from the recordings), `packages/agent-provider-copilot/src/provider.ts` (`journal: { itemIdentity: 1 }`, last), `docs/current/agent-remote/providers.md`, `copilot-normalized-events.md`.

**Tests** (real publisher, real core, real store; a virtual clock as in `journal-window.journal.test.ts`):
1. Open, publish the `settled` live run, drop the connection, reopen from the `reread`: no item write, epoch unchanged, one `journal_window` of `unchanged`.
2. Runtime release (manager closed, new manager from history), five times: epoch unchanged.
3. Controller restart (new publisher id, same Relay journal): epoch unchanged.
4. The corrected-final fixture: one replacement, `changed`, a second open `unchanged`; the journal holds the base once and no correction item. `approval` and `todos` reopen `unchanged`.
5. `interrupted`: no item stays open after an abort, and five reopens are `unchanged`; a tool completed while away replaces once with `open_item`.
6. Older history: a scroll past the window sends `journal_older_request`, lands below the oldest item, and the diagnostics count one `older` request.
7. Size: a long session whose window does not fit one message serves the newest items, and a window larger than the Host's room is refused with the journal out of serving (Copilot rows; `packages/agent-remote-lab/scripts/journal-benchmark.mjs` covers scale).
8. Production default: a Controller built from the production provider list with no Relay grant publishes nothing, a Relay built with default options serves no journal, and `ARC_LOCAL_JOURNALS` unset keeps the instance's `journals` option off (`scripts/local/runner.test.mjs`, existing). `supportsJournal(copilot)` is true; a fake adapter without it stays false.

**State:** fields 0, paths 0; the publisher count stays 19 (`grep` in the Task 4 notes).

**Run:** `-controller` for the new test and the existing `journal-*.test.ts`, the Copilot suite, `pnpm compatibility:update` then `compatibility:check`, Gate G.

### Task 5: The measuring runner

**Files:** `packages/agent-remote-lab/performance/local-baselines.mjs`, `packages/agent-remote-lab/performance/README.md`.

**Interface.** Two scenarios, using the existing `--sessions`, `--reps`, `--throttle` and `--out`:
- `journal-open`: for each Copilot session, `open-known` and `open-fresh`, recording per open which path answered (journal or Controller) and the bytes the page received (CDP `Network.webSocketFrameReceived` and response sizes). Step 1 finds the cheapest existing signal for the path: the stream's `negotiated` frame without a Controller attach.
- `journal-reopen-mix`: one session, 30 reopens in a fixed order: 10 page reloads, 10 session releases then reads, 5 Controller restarts (`pnpm local up --no-build`), 5 interruptions (a turn cancelled through `session cancel`, then released and reopened). After each, it records the `journal_window` events since the last, read from the Controller's diagnostics, and compares a full native read with a full journal-served read (the hole check).

There is no 5,000-item session and no synthetic session in the owner's profile. Scale is covered by `journal-benchmark.mjs` and Task 4 test 7; S4 measures T2 against P0.

**Counters.** All come from D7 and the Controller's existing `journal_session_restarted` and `journal_open_refused`. No production counter is added.

**Tests:** the runner's pure parts (diagnostics into counts, the hole comparison, statistics) under Node 22 in `packages/agent-remote-lab`; Gate G.

### Task 6: Enable on `pnpm local` and read a journal-served session

Follow `.agents/skills/prepare-arc-local/SKILL.md`, with free ports, keeping any services of the owner running.

- [ ] Start the instance with journals on: `ARC_LOCAL_JOURNALS=1 pnpm local up`.
- [ ] Turn smart reading on for `copilot` for the local Host: `pnpm local api` `PUT /v1/remote/hosts/<hostId>/smart-reading` (the S1/S2 record used `pnpm local api`, because the Controller's own sign-in showed `signed_out`). Check `GET` lists `["copilot"]`.
- [ ] Create a Copilot session in the local site (a real model turn; if none is available, stop and tell the owner), send a message that streams text and runs a tool. Confirm the instance's `journals.sqlite` holds the session (file mode 0600) and the Controller log shows no `journal_open_refused`, `journal_session_stopped` or `journal_session_unserved`.
- [ ] **The acceptance read:** open the session in the page. Its stream sends `negotiated` without a Controller attach, the conversation shows the user message, the streamed text and the tool call, and a screenshot (read, not just taken) shows them. Release the runtime (`session release`), reload the page: the same rows, no frame without rows, no connection label.
- [ ] Restart the Controller and the Relay (`pnpm local up --no-build`): the page keeps its rows. Record the `journal_window` reason (expected `unchanged`).
- [ ] Turn smart reading off: the same session reads through forwarding.
- [ ] Interruptions use `session cancel` and `session release`, never a killed process.
- [ ] Run the two scenarios of Task 5 and save the JSON under `.tmp/` (not committed).

### Task 7: Record the measurements and decide the deferred items

**Files:** a section "S3 measurements" appended to this plan, the roadmap Progress rows, `docs/current/agent-remote/protocol.md` if a number changes a documented limit.

**Recorded** (one table each, with the build info the runner prints and the date):

| Metric | How | Where it comes from |
|---|---|---|
| Replacements per open, by reason | `journal_window` count by reason over the opens of `journal-reopen-mix` and `journal-open` | Relay diagnostic |
| Bytes per open | `journal_window.bytes` (Controller to Relay) and page bytes (Relay to browser) | Relay diagnostic, CDP |
| First-open misses | opens answered by the Controller for a session with smart reading on | runner, per open |
| Open or interrupted item triggering a replacement | `open_item` and `changed` counts over the 10 release reopens and 5 interruptions | Relay diagnostic |
| Open time | p50 and p95 of ready for `journal-open`, journal on and off, throttle 1 and 4 (a floor on small sessions; T2 is S4's) | runner |
| Content mismatches | `changed` count, with the item type from the fixtures | Relay diagnostic, fixtures |
| Fills and older requests per open | `journal_request` by reason | Relay diagnostic |

**Thresholds. Exceeding one triggers its deferred item; staying below leaves it deferred.** These are the numbers this plan commits to; Task 7 only checks them.

| Deferred item | Triggered when |
|---|---|
| I2: in-place update of an open item | `open_item` replacements exceed 5 percent of the 30 opens of the mix, or any settled reopen gives `open_item` (a defect, fixed first) |
| M3: history holes | the hole check finds an item of native history missing from the journal-served full read after more than 1 of the 5 interruptions |
| M6 (read here as review note 9, an incomplete journal while the window waits for older pages) | a journal stays `incomplete` for more than 2 seconds at p95, or a first-open miss happens on a session of fewer than 200 items |
| Drop the oldest instead of evicting bodies | fills exceed 1 per open at p50 in the mix, or any `journal_quota_exceeded` or refused window happens in it at default limits |

The owner's own use of the local instance may be noted beside the table; it is not an input to a threshold. Gate S3 passes when the measurements are recorded, whatever they show. A triggered item becomes a task in S6 or goes to the owner; it is never added to S3.

### Task 8: Deletions

What S1, S2 and this work make unnecessary.

- [ ] `expectContinuity` and its "History must complete every item it returns" check in `packages/agent-host/src/test-utils/journal-continuity.ts` and `journal-continuity.test.ts`: the byte-equality gate of the old contract. Callers are tests only; `continuityOutcome` with an expected outcome replaces them.
- [ ] The event `journal_window_replaced` (Task 1; verify with `git grep`), the open-time todo snapshot of `session.ts`, and the `\n${content}` reasoning branch of `projector.ts` (Task 2; verify they are gone).
- [ ] In the P1-C2 plan, the bodies that S2 made false, kept only as research: "The contract each adapter implements" (corrections replace the base through `correct` and `abandon`, byte-for-byte alignment), Tasks 1 to 6 (including the interaction-hold check of Task 6, the Codex join separators, the Claude raw-row `tool_use_result` attach), and the open risks about content equality. Keep "Findings" and "Research for the relaxed contract". Remaining providers return in S6 as reduced tasks.
- [ ] In `docs/current/agent-remote/protocol.md`, any sentence that names `correct`, `seal`, the hold or the grant level (grep first; delete what is left).
- [ ] An audit, not a guess: `git grep -n "identity === undefined\|row.identity" -- packages/agent-host/src ':!*.test.ts'`. Delete a branch only when the grep shows no row without identity can reach it (a capable provider's rows all have one; the Controller's own rows are keyed `controller:`); otherwise leave it and say so in the notes. The `identityMissing` stop stays: it is the invariant that keeps a deltas-as-items journal from forming.

**State:** counts of lines deleted recorded in the notes; fields and paths 0.

## 5. Acceptance summary

Continuity across reopen, release and restart: Task 3 recordings. Real transport through `createHostJournals`: Task 4. A session read journal-served in the page: Task 6. Default production behaviour unchanged: Task 4 test 8 and Gate S3. Budgets: publisher fields at most 20 (19 expected), recovery outcomes at most 6 (4), recorded in Task 4 and 7 notes.

## 6. Risks and what is not in S3

- **Real Copilot recordings may differ from the research.** A differing key shows up in Task 3 as a failing fixture. It is fixed in the adapter, not worked around in the Controller; a kind that cannot be keyed is live-only.
- **Corrections and partial-output tools replace once per session.** That is the measured cost of the relaxed contract until S4 lets the client keep unchanged rows.
- **Production.** Declaring the capability makes a new Controller ask for `journal=1`. A Relay serves nothing without `AGENT_REMOTE_JOURNALS=1` and the Host's switch. No Controller update is required.
- **Not in S3:** the client keys (S4), Relay-owned control (S5), Claude, Codex and OpenCode (S6), a large-session measurement (S4), backfill and observation, in-place update, history comparison beyond the window, a different eviction rule.

## 7. S3 measurements

Recorded 2026-11-16 on this checkout's instance (Apple M4, 16 GiB, Chromium 151, Node 22). Production code is that of `5c1cd538`; the instance ran `5c1cd538` for the first checks and `59b05441` (lab runner fixes only) for the runs. One Copilot session of about 24 items made in the instance workspace (a shell tool with an approval, a todo list, a cancelled turn). `ARC_LOCAL_JOURNALS=1` was exported for every `up` and for the runner's own restarts; a run made without it was discarded, because a restart without it turns the Relay's journals off (`PUT smart-reading` then answers 409 `journals_unavailable`). Raw JSON: `.tmp/s3-journal-reopen-mix.json`, `.tmp/s3-journal-open*.json` (not committed).

**Task 6 observed.** The Controller registered with smart reading on for Copilot; `journals.sqlite` exists with mode 0600; the Controller reported no `journal_open_refused`, `journal_session_stopped`, `journal_session_unserved` or `journal_session_restarted`. The page showed the user message, text, `bash` tool, the approval (and, after "Allow once", its record), the `sql` tool, the todo board and the final reply. A release plus reload and a Controller and Relay restart plus reload kept the rows. The Copilot `session release` answered `released: false` (nothing to release).

| Metric (30 opens of `journal-reopen-mix`, 3 reps of `journal-open`) | Result |
|---|---|
| Replacements per open, by reason | 0 replacements in 30 opens. 5 `appended` windows, one per Controller restart; 0 `unchanged` (expected `unchanged`), 0 `changed`, 0 `open_item` |
| Bytes per open | Controller to Relay: 12,422 per restart window (the only windows). Relay to browser: p50 37.1 KB reload and release, 37.9 KB restart, 39.7 KB interruption; `journal-open` 40.5 KB (smart reading off: 33.9 KB) |
| First-open misses | The runner counts 1 of 3 fresh opens as Controller-answered in every run, on a session of about 24 items. Its signal is a Controller attach finishing before the first message, and a 1 ms resident attach does so; that open showed its first message in 85 ms, like the journal-served ones. Treat the count as unreliable, not as a measured miss |
| Open or interrupted item replacements | `open_item` 0 of 30 opens; 0 over the 10 release reopens and the 5 interruptions |
| Open time `journal-open` (ready p50 / p95, ms; known, fresh) | On, throttle 1: 145 / 166, 142 / 146. On, throttle 4: 443 / 453, 389 / 398. Off, throttle 1: 155 / 164, 144 / 146. Off, throttle 4: 406 / 443, 377 / 386 |
| Content mismatches | 0 `changed` windows; hole check found 0 missing messages in all 30 opens |
| Fills and older requests per open | 0 and 0 |
| Quota refusals, `journal_open_refused`, `journal_session_unserved` | 0 |

**Verdicts.**

- I2 (in-place update of an open item): not triggered. 0 percent `open_item` of 30 opens, none on a settled reopen.
- M3 (history holes): not triggered. 0 of 5 interruptions with a hole. The first hole check reported every open as a hole because it compared Markdown (`alpha`) with the rendered text; the runner ignores Markdown marks now.
- M6 (incomplete journal while waiting for older pages): not triggered on the evidence, but not proven. The "incomplete for more than 2 seconds" clause has no counter, and the first-open-miss counter is unreliable (above). After a restart the first open waited for the Controller (5.3 s once, before journals were back); that is Relay and Controller startup, not a journal gap. Left deferred; a trustworthy journal-versus-Controller signal per open is the open item for S4.
- Drop the oldest instead of evicting bodies: not triggered. 0 fills, 0 quota refusals.

**Unexpected, after the follow-up checks.**

- **Direct proof of journal serving.** The page's `timeline_page` frame carries the timeline epoch. With smart reading on it is `80e681ee-9231-4d7d-a113-89c76a3985d6` with `nextSeq` 60, equal to the epoch and `nextSeq` in the `meta` of the session in the instance's `journals.sqlite`. With smart reading off it is the Controller's own `2b189102-fada-4e2c-8434-4dc48cd860f6` with `nextSeq` 31. Turning the switch on again returned to the journal's epoch. This replaces the weaker evidence above: `stream_opening` does not tell the modes apart, because a journal-served stream also opens a Controller stream.
- **The rows' times that "moved".** Not a defect. My first restart ran `pnpm local up --no-build` without `ARC_LOCAL_JOURNALS=1`, so the page then read crude. The two reads differ in the page by the same 2 to 3 seconds today: journal 19:56:21 and 20:01:11, crude (Controller) 19:56:23 and 20:01:14. The journal keeps the times of the live events; the Controller reads Copilot's native times. No time moved within journal reads, and `sync` and the stream sent no updated rows for identical items.
- **The five `appended` windows.** Expected live-only items: each is a `todo:<uuid>` snapshot (`liveOnly: true`, 528 bytes, items alpha and beta) that the Controller adds when it starts serving the session, so the journal holds 7 `todo:` items (1 from the real todo call, 6 from restarts), with fresh uuids each time. They accumulate by one per Controller start of the session, not per page open, up to the 2,000 item cap, where the oldest are evicted. Each costs 528 bytes in the store; the window sent per restart (12,422 bytes) is larger than the item. If a cap of one open snapshot per session is wanted, that is S4's decision. Everything else in the journal (user, assistant, tool, interaction and reasoning items) matches the native session; the 30 `user:` items are the cancelled turns.
- **Other points.** Every Controller restart ended in `appended`, not `unchanged`, for the reason above. Smart reading on and off differ by 7 KB in page bytes (the journal also holds the todo snapshots) and not in open time for a 24-item session.

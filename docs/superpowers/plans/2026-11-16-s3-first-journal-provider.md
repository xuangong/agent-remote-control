# S3: the first journal provider (Copilot), enabled and measured on `pnpm local`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax. This plan states interfaces, deletions and acceptance tests, not code, under the rules in the [roadmap](2026-11-15-im-session-service-roadmap.md) ("Revised order after the simplification assessment"). It supersedes the [P1-C2 plan](2026-11-15-p1c2-provider-item-identity.md); that plan's "Research for the relaxed contract" section is the evidence this plan starts from.

**Goal:** One provider, GitHub Copilot, publishes its sessions to Relay journals under the relaxed item-identity contract. Journals and the Copilot smart-reading switch are turned on in this checkout's local instance, and the numbers that decide the deferred items (I2, M3, M6, "drop oldest instead of evicting bodies") are recorded.

**Architecture:** The Provider SDK keeps `ProviderItemIdentity` and `AgentJournalCapability` as they are. The Copilot adapter owns keys, completion marks and live-only marks, because it is the only place that knows what a Copilot event means. The Controller never infers them. The journal core keeps the one decision (`sync`: unchanged, appended or replaced); it gains one reason on a replacement so that the causes can be counted. The Relay reports each window and each Controller request as a diagnostic. The client protocol and the client renderer are untouched (S4).

**Tech stack:** TypeScript, Vitest, `@github/copilot-sdk`, the real `copilot` CLI for recordings, Playwright through `local-baselines.mjs`.

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

| Package | Filter or command |
|---|---|
| Provider SDK | `@orchardworks/agent-provider-sdk` |
| Copilot adapter | `@orchardworks/agent-provider-copilot` (its `test` script has `--testTimeout=10000`) |
| Controller (`packages/agent-host`) | `@orchardworks/agent-remote-controller` |
| Relay core and hosted | `@orchardworks/agent-remote-journal`, `@orchardworks/agent-remote-hosted`, `@orchardworks/agent-remote-relay` |
| Protocol | `@orchardworks/agent-remote-protocol` |
| Cloudflare | `pnpm test:cloudflare` (its own script) |
| Lab and web | `@orchardworks/agent-remote-lab`, `@orchardworks/agent-remote-web`, under Node 22 |

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
- [ ] `copilot` answers a real model turn on this machine (`/opt/homebrew/bin/copilot`, signed in). If it does not, stop and use OpenCode instead (see Decision 1, fallback); the plan's tasks then read "OpenCode" with its keys from the P1-C2 research.

## 2. Decisions and state accounting

"Fields" counts state a reader must hold in mind (persisted fields, mutable class fields, maps, flags). "Paths" counts recovery paths. Budgets: publisher at most 20 mutable fields, recovery outcomes at most 6. S3 starts at 19 and 4.

| # | Decision | Fields | Paths | Task |
|---|---|---|---|---|
| D1 | **Copilot goes first.** Fallback: OpenCode. | 0 | 0 | all |
| D2 | **Stable keys per item kind** (Section 3). Derived in the adapter from native ids that are equal in the live stream and in `events.jsonl`. No key gap needs a hash. | adapter: -0, +1 (`pendingCompaction`) | 0 | 2 |
| D3 | **Completion marks**: the adapter sets `completes` on the last observation of an item, with an empty body for a text or reasoning item whose final text equals what was streamed. Tool and compaction rows repeat their whole content. | 0 | 0 | 2 |
| D4 | **Live-only marks**: reasoning, todo snapshots, and items the adapter makes without a native event (errors of the interaction bridge). Nothing else. | 0 | 0 | 2 |
| D5 | **A mismatch between the live stream and a reread is counted, not failed.** A corrected final message, an approval scope, a tool result differing in a field: each costs one `replaced` with reason `changed`. The fixtures assert the expected outcome and reason, not equality. | 0 | 0 | 3 |
| D6 | **One reason on a replacement.** `SyncResult` `replaced` carries `reason: 'new' | 'incomplete' | 'open_item' | 'changed'`. The core already decides in one place (`extensionOf`); it returns the reason instead of `undefined`. | core +1 result field | 0 | 1 |
| D7 | **Measurement through the Relay's existing diagnostics.** `journal_window_replaced` becomes `journal_window` (one per window, `reason` = `unchanged`, `appended` or a replacement reason; count `bytes`). One new event, `journal_request` (`reason` = `fill` or `older`), because eviction cannot be judged without it. The reason allowlist gains 6 names, the count allowlist gains `bytes`. Metadata only, no content. | allowlist +1 count | 0 | 1 |
| D8 | **Switching on is configuration, not code.** The adapter declares `journal: { itemIdentity: 1 }`. The Relay serves journals only with `AGENT_REMOTE_JOURNALS=1` (`ARC_LOCAL_JOURNALS=1` locally) and the per-Host smart-reading switch for `copilot`, both off by default. Default production behaviour is unchanged. | 0 | 0 | 4, 6 |
| D9 | **No new publisher state, no new recovery outcome.** A mismatch heals through the existing reopen and window. | 0 | 0 | all |

**Why Copilot first** (from the research, verified in the code above):

| | Copilot | Claude | OpenCode | Codex |
|---|---|---|---|---|
| Keys equal live and in history | all kinds: `event.id`, `messageId`, `toolCallId`, `requestId`, compaction start id | folded and steered input, notices differ by uuid | all kinds, but text parts key by ordinal | all kinds |
| Key gaps needing a hash or a probe | none | folded input (text hash plus ordinal), compaction rewrites history | none, but `turnId` of a partial page risks moving | plan item hidden live, shown in history (owner confirmation) |
| Completion marks | native events (`assistant.message`, `tool.execution_complete`, `session.compaction_complete`); one empty-body case | native, one empty-body case | native fields, one empty-body case | native, one empty-body case |
| Needs P1-C3 (read-only history) first | no | no | yes (P1-C2 order note) | yes |
| Size of the work | one projector (172 lines), one session class | two projectors, worker, folded input | two normalizers and a reconcile layer | projector, history, daemon client |

Copilot has the fewest key gaps, native completion events, no dependency on P1-C3, and the smallest adapter. Its known differences between live and history (reasoning absent, approval scope, a corrected final message) are content differences, which the relaxed contract counts. OpenCode is the fallback only if a real Copilot turn cannot run here.

## 3. The relaxed contract for Copilot

**Keys** (type-prefixed, at most 4096 characters, never a delta source key, never the `controller:` prefix):

| Item | Key | Live and history |
|---|---|---|
| user message | `user:<event.id>` | `user.message` has the same id in both |
| assistant text | `assistant:<messageId>` | deltas, final and history share `messageId` |
| reasoning | `reasoning:<reasoningId>` | read from `assistant.reasoning_delta` and `assistant.reasoning`, which the projector ignores today |
| tool call | `tool:<toolCallId>` | start, partial, complete rows share it |
| interaction | `interaction:<requestId>` | the manager's item from `interaction_resolved`, and the history item |
| compaction | `compaction:<start event id>` | the completion takes the pending start (`pendingCompaction`); history replays both events |
| error | `error:<event.id>`; an error with no native event gets `error:<uuid>`, live-only | |
| todo | `todo:plan` | one item, the latest snapshot replaces the earlier |
| corrected final message | `assistant:<messageId>:correction` | exists only live; not live-only, so the next replacement drops it |

**Completion.** `user.message` and `error` complete at emit. `assistant.message` completes `assistant:<messageId>`: with an empty body when the content equals what was streamed, with the unsent suffix when it extends it, with the whole content when nothing was streamed. When the content does not extend the streamed text, the base item is completed with an empty body and the correction item is emitted complete beside it. `assistant.reasoning` completes the same way. `tool.execution_complete` repeats the whole tool content with `completes` (an empty body would wipe a tool row). `session.compaction_complete` repeats the whole compaction row with `completes`. `interaction_resolved` completes. A history observation completes its item unless the native record is open: a tool with no `tool.execution_complete`, a compaction with no completion. History may therefore return open items for an interrupted turn; the Controller sends them without a digest.

**Live-only.** Reasoning (history may omit it), todo snapshots, errors made by the adapter itself. Everything else has a history copy, so the next replacement may rebuild it.

**Content mismatches** (counted, with the expected reason):

| Case | Where it shows | Expected outcome of reopen |
|---|---|---|
| corrected final message | live has a correction item, history the corrected base | `replaced`, `changed`, once; the correction item is gone after it |
| resolved approval scope | live has the real scope, history falls back to `once` | `replaced`, `changed`, once per session |
| reasoning | live-only item, absent from history | `unchanged` (the journal carries it) |
| interrupted tool | history has the running row, journal the running row with equal resident content | `unchanged`; a completed-while-away tool gives `replaced`, `open_item` |

**What stays where.** Native interpretation (what an event means, which id keys it) stays in `packages/agent-provider-copilot`. The Controller groups rows by key, merges, digests and sends the window. The Relay compares and decides. No Copilot knowledge enters the Controller or the Relay.

**What the adapter declares.** `journal: { itemIdentity: 1 }` in `provider.ts`, as the last step of Task 4, after the fixtures pass. A session of a provider without it stays on forwarding.

## 4. Tasks

### Task 1: One reason on a replacement, and the window diagnostics (D6, D7)

**Files:** `packages/agent-remote-journal/src/{session-journal,types}.ts` (the reason), `packages/agent-remote-hosted/src/{host-journals,journal-uplink,relay-diagnostics}.ts` (emit `journal_window` and `journal_request`, `bytes`), `packages/agent-host/src/relay-diagnostics.ts` and its test (the Controller's delivery allowlist), `docs/current/agent-remote/protocol.md`.

**Interface.**
- `SyncResult`: `{ outcome: 'unchanged' } | { outcome: 'appended'; rows } | { outcome: 'replaced'; epoch; reason: 'new' | 'incomplete' | 'open_item' | 'changed' }`. `new`: the journal holds no item. `incomplete`: the journal was flagged. `open_item`: the first differing item is open in the journal or in the window. `changed`: a complete item differs, is missing or is out of order.
- `HostJournals.publish` result `window` gains `bytes` (the window's encoded size).
- Diagnostics: `journal_window` with `reason` and `bytes`; `journal_request` with `reason` `fill` or `older`.

**State:** fields +1 (core result field), allowlist +1 count (`bytes`); paths 0. Surface: `journal_window_replaced` is removed, `journal_window` replaces it; `journal_request` is new because eviction thresholds cannot be measured without it, and the reasons and count are metadata only.

**Tests** (real core and `createHostJournals`, in `packages/agent-remote-journal` and `packages/agent-remote-hosted`): each of the five outcomes and reasons is produced by a minimal window against a built journal; the diagnostic carries the reason and `bytes` and no content; fill and older requests each emit one `journal_request`; the Controller accepts and delivers the new events; the old name is gone (`git grep journal_window_replaced -- packages` prints nothing).

**Deletes:** the event name `journal_window_replaced` in `journal-uplink.ts`, `relay-diagnostics.ts` and the Controller's test list; the sentence about it in `protocol.md`.

**Run:** `-journal`, `-hosted`, `-controller` suites for those files, then Gate G.

### Task 2: Copilot identity in the adapter (D2, D3, D4)

**Files:** `packages/agent-provider-copilot/src/projector.ts` (each projected item carries its identity; `reasoningId`; `pendingCompaction`; completion rows), `session.ts` (`emit(event, identity?)` gives todo, interaction and error items their identities instead of random keys for items; observation source keys stay as they are), `interactions.ts` (`interaction_resolved` carries `interaction:<requestId>`, `completes`), `projector.test.ts`, `provider.test.ts`, `docs/current/agent-remote/copilot-normalized-events.md`.

**Interface.** `Projector.projectAll` returns `{ key, event, identity? }`; `CopilotAgentSession.emit(event, identity?)`. Every timeline observation and every `interaction_resolved` carries an identity, as the SDK's `ProviderObservation.itemIdentity` requires. The declaration is not added in this task.

**State:** adapter fields +1 (`pendingCompaction`); no Controller state.

**Tests** (offline, scripted events, in `projector.test.ts`): every timeline observation of a scripted turn (user, streamed assistant, reasoning, tool with partials and completion, compaction pair, error, todo, resolved approval) has a key; keys are unique per item and equal between the live stream and `projectAll(..., 'history')` of the same events; a streamed text equal to the final text gives a completing empty body; an extending final gives the suffix with `completes`; a non-extending final gives an empty completing body plus a complete correction item `assistant:<id>:correction`; reasoning and todo are live-only and the others are not; a tool row without `tool.execution_complete` in history carries no `completes`; no key starts with `controller:`.

**Run:** `@orchardworks/agent-provider-copilot` suite, Gate G.

### Task 3: Recorded fixtures from the real provider (D5)

**Files:** `packages/agent-provider-copilot/tests/journal-recording.local.test.ts` (runs on request with the real CLI: it writes the recordings), `packages/agent-provider-copilot/tests/fixtures/journal/*.json` (the recordings, committed), `packages/agent-host/src/test-utils/journal-continuity.ts`, `packages/agent-host/src/journal-continuity.copilot.test.ts`.

**Recordings** (each a `ContinuityRun`: `live` observations and the `reread` of the same native session, with paths, tokens and user names replaced by a sanitizer in the recorder, and a README line in the test file saying how to refresh):
1. `settled`: a turn with streamed text, a tool call with partial output and a result, a second turn; released, reopened.
2. `reasoning`: a turn with reasoning.
3. `approval`: a turn with a resolved approval and a question.
4. `compaction`: a manual compaction.
5. `interrupted`: the CLI is killed in the middle of a tool call; the session is reopened.
6. `restart`: `settled`, with the `reread` coming from a new process.

If the CLI cannot be driven for a case, write that fixture by hand from the nearest recorded events and say so in the test; a hand-built fixture is never the only evidence for the settled case.

**Interface** (`journal-continuity.ts`): `continuityOutcome(run)` returns `{ outcome, reason? }` (the core's result), and open items in the `reread` are allowed. `expectContinuity` is deleted (see Task 8).

**Tests** (Controller, offline, from the recordings): `settled` and `restart` give `unchanged`; a second reread of the same recording adds nothing; `reasoning` gives `unchanged` and the journal holds the live-only reasoning item; `approval` gives `replaced`/`changed` once and a second reread of the new journal gives `unchanged`; `compaction` gives the outcome the recording shows (asserted, documented); `interrupted` gives `unchanged` when the open tool's resident content equals the window's, and `replaced`/`open_item` when a tool completed while the Controller was away; a window of the newest items of a long recording is a prefix-compatible `appended` when the session grew. Each test prints the expected outcome in its name, so a change of behaviour of the adapter is a visible test change.

**State:** none (test code and fixtures).

**Run:** `-controller` for `journal-continuity.copilot.test.ts` and `journal-continuity.test.ts`; the `.local.test.ts` is run once by hand with `copilot` signed in, under `timeout 600`.

### Task 4: Real transport through `createHostJournals`, then the declaration

**Files:** `packages/agent-host/src/journal-window.copilot.journal.test.ts` (uses `relayLoopback`, which wraps `createHostJournals`, the publisher, a scripted Copilot session built from the recordings), `packages/agent-provider-copilot/src/provider.ts` (`journal: { itemIdentity: 1 }`, last), `docs/current/agent-remote/providers.md`, `copilot-normalized-events.md`.

**Tests** (real publisher, real core, real store; a virtual clock as in `journal-window.journal.test.ts`):
1. Open, publish the `settled` live run, drop the connection, reopen from the `reread`: no item write, epoch unchanged, one `journal_window` of `unchanged`.
2. Runtime release (manager closed, new manager from history), five times: epoch unchanged.
3. Controller restart (new publisher id, same Relay journal): epoch unchanged.
4. `approval` and the corrected-final fixture: one replacement, `changed`, a second open is `unchanged`; the journal holds the base item once and no correction item.
5. `interrupted`: the open tool stays open and unchanged across five reopens; a completed-while-away tool replaces once with `open_item`.
6. Older history: a scroll past the window sends `journal_older_request`, lands below the oldest item, and the diagnostics count one `older` request.
7. A long session whose window does not fit one message: the newest items are served, and a window larger than the Host's room is refused with the journal out of serving (existing behaviour, here with Copilot rows).
8. The adapter's declaration: `supportsJournal(provider)` is true; with the capability, `runtime.journals.capable()` is true; a fake adapter without it stays false.

**State:** fields 0, paths 0; the publisher count stays 19 (`grep` in the Task 4 notes).

**Run:** `-controller` for the new test and the existing `journal-*.test.ts`, the Copilot suite, `pnpm compatibility:update` then `compatibility:check`, Gate G.

### Task 5: The measuring runner

**Files:** `packages/agent-remote-lab/performance/local-baselines.mjs` (scenarios), `packages/agent-remote-lab/performance/README.md`, `packages/agent-remote-lab/performance/journal-large-session.mjs` (builds the 5,000-item session).

**Interface.** New scenarios, all using the existing `--sessions`, `--reps`, `--throttle` and `--out` options:
- `journal-open`: for each Copilot session, `open-known` and `open-fresh`, with a per-open record of which path answered (journal or Controller) and the bytes the page received (CDP `Network.webSocketFrameReceived` and response sizes). Task 5 step 1 finds the cheapest existing signal for the path: the stream's `negotiated` frame without a Controller attach, the same one the S1/S2 record used.
- `journal-reopen-mix`: one session, 30 reopens in a fixed order: 10 settled page reloads, 10 runtime releases then reads, 5 Controller restarts (`pnpm local up --no-build`), 5 interruptions (a turn with a tool call killed at the tool, then reopened). After each reopen it records the `journal_window` events the Relay produced since the last one, read from the Controller's diagnostics, and the outcome of a full native read compared with a full journal-served read (the hole check).
- `journal-large`: opens the 5,000-item session (known and fresh) at throttle 1 and 4, with smart reading on and off.

`journal-large-session.mjs` writes a synthetic Copilot session of 5,000 timeline items (about 1,700 user, assistant and tool triples with bounded results) into the state directory the instance's Copilot discovery reads; it refuses a directory outside the instance's own state (preserve the user's sessions).

**What the counters are.** All come from D7 (`journal_window`, `journal_request`) and the Controller's existing `journal_session_restarted` and `journal_open_refused` diagnostics. The runner adds no counter to production code.

**State:** none in production.

**Tests:** the runner's pure parts (reading diagnostics into counts, the hole comparison, the statistics) are covered by tests in `packages/agent-remote-lab` under Node 22; the rest is exercised by Task 6.

**Run:** the lab suite for the new tests; Gate G.

### Task 6: Enable on `pnpm local` and read a journal-served session

Follow `.agents/skills/prepare-arc-local/SKILL.md`, with free ports, keeping any services of the owner running.

- [ ] Start the instance with journals on: `ARC_LOCAL_JOURNALS=1 pnpm local up`.
- [ ] Turn smart reading on for `copilot` for the local Host: `pnpm local api` `PUT /v1/remote/hosts/<hostId>/smart-reading` (the S1/S2 record used `pnpm local api`, because the Controller's own sign-in showed `signed_out`). Check `GET` lists `["copilot"]`.
- [ ] Create a Copilot session in the local site, send a message that streams text and runs a tool. Confirm the instance's `journals.sqlite` holds the session (file mode 0600) and the Controller log shows no `journal_open_refused`, `journal_session_stopped` or `journal_session_unserved`.
- [ ] **The acceptance read:** open the session in the page. Its stream sends `negotiated` without a Controller attach, the conversation shows the user message, the streamed text and the tool call, and a screenshot (read, not just taken) shows them. Release the runtime (`session release`), reload the page: the same rows, no frame without rows, no connection label.
- [ ] Restart the Controller and the Relay (`pnpm local up --no-build`): the page keeps its rows. Record the `journal_window` reason (expected `unchanged`).
- [ ] Turn smart reading off: the same session reads through forwarding.
- [ ] Run the three scenarios of Task 5 and save the JSON under `.tmp/` (not committed).

### Task 7: Record the measurements and decide the deferred items

**Files:** a section "S3 measurements" appended to this plan, the roadmap Progress rows, `docs/current/agent-remote/protocol.md` if a number changes a documented limit.

**Recorded** (one table each, with the build info the runner prints and the date):

| Metric | How | Where it comes from |
|---|---|---|
| Replacements per open, by reason | `journal_window` count by reason over the opens of `journal-reopen-mix` and `journal-open` | Relay diagnostic |
| Bytes per open | `journal_window.bytes` (Controller to Relay) and page bytes (Relay to browser) | Relay diagnostic, CDP |
| First-open misses | opens answered by the Controller for a session with smart reading on | runner, per open |
| Open or interrupted item triggering a replacement | `open_item` count over the 10 release reopens and 5 interruptions, and over a week of the owner's use of the local instance | Relay diagnostic |
| 5,000-item open time | p50 and p95 of ready, journal on and off, throttle 1 and 4, against T2 (500 ms p50, 1.5 s p95) | runner |
| Content mismatches | `changed` count, with the item type from the fixtures | Relay diagnostic, fixtures |
| Fills and older requests per open | `journal_request` by reason | Relay diagnostic |

**Thresholds. Exceeding one triggers its deferred item; staying below leaves it deferred.** These are the numbers this plan commits to; Task 7 only checks them.

| Deferred item | Triggered when |
|---|---|
| I2: in-place update of an open item | `open_item` replacements exceed 5 percent of all opens in the mix and the week, or any settled reopen (no open item anywhere) gives `open_item` (that one is a defect, fixed first) |
| M3: history holes | the hole check finds an item of native history missing from the journal-served full read after more than 1 of the 5 interruptions |
| M6 (read here as review note 9, an incomplete journal while the window waits for older pages) | a journal stays `incomplete` for more than 2 seconds at p95, or a first-open miss happens on a session of fewer than 200 items |
| Drop the oldest instead of evicting bodies | fills exceed 1 per open at p50 on the 5,000-item session, or any `journal_quota_exceeded` or refused window happens on it at default limits |

Gate S3 passes when the measurements are recorded, whatever they show. A triggered item becomes a task in S6 or goes to the owner; it is never added to S3.

### Task 8: Deletions

What S1, S2 and this work make unnecessary.

- [ ] `expectContinuity` and its "History must complete every item it returns" check in `packages/agent-host/src/test-utils/journal-continuity.ts` and `journal-continuity.test.ts`: the byte-equality gate of the old contract. Callers are tests only; `continuityOutcome` with an expected outcome replaces them.
- [ ] The event `journal_window_replaced` (done in Task 1; verify with `git grep`).
- [ ] In the P1-C2 plan, the bodies that S2 made false, kept only as research: "The contract each adapter implements" (corrections replace the base through `correct` and `abandon`, byte-for-byte alignment), Tasks 1 to 6 (including the interaction-hold check of Task 6, the Codex join separators, the Claude raw-row `tool_use_result` attach), and the open risks about content equality. Keep "Findings" and "Research for the relaxed contract". Remaining providers return in S6 as reduced tasks.
- [ ] In `docs/current/agent-remote/protocol.md`, any sentence that names `correct`, `seal`, the hold or the grant level (grep first; delete what is left).
- [ ] An audit, not a guess: `git grep -n "identity === undefined\|row.identity" -- packages/agent-host/src ':!*.test.ts'`. Delete a branch only when the grep shows no row without identity can reach it (a capable provider's rows all have one; the Controller's own rows are keyed `controller:`); otherwise leave it and say so in the notes. The `identityMissing` stop stays: it is the invariant that keeps a deltas-as-items journal from forming.

**State:** counts of lines deleted recorded in the notes; fields and paths 0.

## 5. Acceptance summary

| Requirement | Test |
|---|---|
| Continuity across reopen, release and restart from the real provider's native history | Task 3 recordings and `journal-continuity.copilot.test.ts` |
| Real transport through `createHostJournals` | Task 4 `journal-window.copilot.journal.test.ts` |
| A session read journal-served in the page | Task 6 acceptance read |
| Default production behaviour unchanged | Task 4 test 8: no Relay serves journals without `AGENT_REMOTE_JOURNALS=1` and the Host switch; Gate S3 suites |
| Budgets | publisher fields at most 20 (19 expected), recovery outcomes at most 6 (4), recorded in Task 4 and Task 7 notes |

## 6. Risks and what is not in S3

- **Real Copilot recordings may differ from the research.** A differing key shows up in Task 3 as a failing `settled` fixture. It is fixed in the adapter, not worked around in the Controller. A kind that cannot be keyed is live-only.
- **`copilot` not signed in.** The OpenCode fallback applies. It adds P1-C3's read-only history to the work, which is a larger plan; the owner is told.
- **Interaction and correction cases replace once per session.** That is the measured cost of the relaxed contract until S4 lets the client keep unchanged rows.
- **Production.** Declaring the capability makes a new Controller ask for `journal=1`. A Relay without journals does not offer it; with `AGENT_REMOTE_JOURNALS=1` it still serves nothing until the Host's switch is on. No Controller update is required, and none is promised.
- **Not in S3:** the client keys (S4), Relay-owned control (S5), Claude, Codex and OpenCode (S6), backfill and observation, in-place update, history comparison beyond the window, a different eviction rule.

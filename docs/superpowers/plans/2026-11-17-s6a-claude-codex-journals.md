# S6a: Claude Code and Codex under the relaxed item-identity contract

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax. This plan states interfaces, deletions and acceptance tests, not code, under the rules in the [roadmap](2026-11-15-im-session-service-roadmap.md) ("Revised order after the simplification assessment"). It repeats [S3](2026-11-16-s3-first-journal-provider.md) for two providers; read S3 sections 1 to 3 first, and the "Research for the relaxed contract" section of the [P1-C2 plan](2026-11-15-p1c2-provider-item-identity.md), which is the evidence this plan starts from and corrects where the code says otherwise.

**Goal:** Claude Code and Codex publish their sessions to Relay journals the way Copilot does since S3, and a session of each is read journal-served, sent to through the S5 Relay-owned control, taken over, restarted and interrupted on this checkout's local instance. **The owner's condition for the release that follows: both providers work. Nothing is deployed until both do.** Daily work depends on these two.

**Architecture:** Unchanged from S3. The adapter owns keys, completion marks and live-only marks; the Controller never infers them; the core's `sync` decides; the client keeps one row per key (S4a). **This plan changes adapters, their recordings, two test helpers and the lab runner. It changes no protocol, no SDK type, no core rule and no Relay behaviour.**

**One plan, two providers, Codex first.** Codex has one projector, native ids equal live and in history, and no key gap; its work is mostly marks and two content fixes. Claude has the known key gaps (folded input, compaction) and a systematic content gap (tool results). Codex first proves the shared test helpers on a simple provider; Claude then reuses them. The local verification of both comes last, because the release needs both (Task 13).

---

## 1. For the owner: approve in one read

1. **No new mechanism.** Adapters give every item a key and say when it is finished. Claude gets four small fixes (Section 4.2), Codex three (Section 4.1). Nothing is added to the publisher (19 fields stay 19) or to the Relay.
2. **The release carries no switch change.** A Controller with these adapters only asks for journals. The Relay serves them only with `AGENT_REMOTE_JOURNALS=1` and the Host's per-provider smart-reading switch, both off by default. No Controller update is forced. Whether the switch goes on for the owner's own Host, and when, is decision O2 below.
3. **Cost of the relaxed contract, as measured here.** A reopen after a compaction, a Codex plan-mode turn, a withdrawn input or a corrected message replaces the journal once (the client keeps every unchanged row, S4a) and then settles. Anything else that replaces on a settled session is a defect fixed before release, not a number (Section 7 thresholds).
4. **Two decisions only the owner can make** are in Section 10 (O1 plan mode, O2 staleness while a terminal drives the session).

## 2. Rules, gates and environment

**Worktree.** `/Users/xian/projects/agent-remote-control/.worktrees/im-session-service`, branch `design/im-session-service`, after the S5 code fixes have landed, clean. Never touch the main checkout. Never push. Free ports for local validation.

**Environment, per-package suites and Gate G** are those of S3 section 1 (Node 22; `timeout 600 pnpm --filter <name> exec vitest run [files] --testTimeout=10000`; Gate G is the named suites, `timeout 900 pnpm typecheck`, `pnpm compatibility:update` then `compatibility:check`, `git diff --shortstat HEAD -- packages` in the notes, and a commit ending with `Co-Authored-By: Claude <noreply@anthropic.com>` with a State line). Filters: `@orchardworks/agent-provider-codex`, `@orchardworks/agent-provider-claude`, `@orchardworks/agent-remote-controller` (directory `packages/agent-host`), `@orchardworks/agent-provider-sdk`.

**Native tests need the real CLIs.** Claude: `AGENT_CLAUDE_TEST_EXECUTABLE=$(command -v claude)` (2.1.319 here); its local tests import `../dist/provider.js`, so build the package first (`pnpm --filter @orchardworks/agent-provider-claude build`). Codex: `BORGEE_CODEX_TEST_EXECUTABLE=$(command -v codex)` (0.169.0 here). Recording tests are `*.local.test.ts`, which each package's `test` script already excludes; they run under `timeout 900` with `--maxWorkers=1`.

**Gate S6a** (end of Task 14): `timeout 3000 pnpm test`, `timeout 900 pnpm test:conformance`, `timeout 900 pnpm test:cloudflare`, the two native recording suites, Gate G, and the measurement record of Task 13.

**Preconditions, checked once before Task 1:**

- [ ] `git status --short` is empty and S5's code fixes are committed.
- [ ] `git grep -n "journal:" -- 'packages/agent-provider-*/src' ':!*.test.ts'` prints only the Copilot declaration.
- [ ] `grep -cP '^  private (?!readonly)(?!async)(?!get )\w+\s*[:=;]' packages/agent-host/src/journal-publication.ts` prints 19 (the baseline of the budget; it stays 19).
- [ ] Copilot's recordings still pass: `pnpm --filter @orchardworks/agent-provider-copilot exec vitest run tests/journal-recording.test.ts --testTimeout=60000`.
- [ ] Both native CLIs run against a scripted model in a temporary home (Task 1 and Task 7 begin with this check).

**Never** read or write the owner's `~/.claude`, `~/.codex` or `~/.copilot` in a test, never sign in, and never start the owner's shared Codex daemon. The recordings use a temporary `CLAUDE_CONFIG_DIR` or `CODEX_HOME` and a scripted model server on a free port. Only Task 11 and Task 12 touch the owner's real homes, through the local instance, as the `prepare-arc-local` skill describes.

## 3. Decisions and state accounting

"Fields" counts state a reader must hold in mind. "Paths" counts recovery paths. Budgets: publisher at most 20 mutable fields, recovery outcomes at most 6; both unchanged by this plan (19 and 4).

| # | Decision | Fields | Paths | Task |
|---|---|---|---|---|
| D1 | **One plan, Codex first, one release gate for both.** | 0 | 0 | all |
| D2 | **Keys, completion and live-only marks per item kind live in the adapters' projectors** (Section 4), one place per provider, equal in the live and the history delivery. | Codex +2 (`runId`, per-turn compaction flag); Claude +2 (`pendingCompaction`, `foldedCounts`) | 0 | 2, 8 |
| D3 | **Live-only is for what native history cannot rebuild and the adapter emits once, at its occurrence.** A snapshot the adapter could re-emit at open (the todo) has a kind key (`todo`). An interaction, a reasoning block a reread lacks, or an error has an occurrence key. **A streamed item that was interrupted is never live-only:** it is finished with an empty body and may disappear at the next replacement (the owner's decision of 2026-11-16). | 0 | 0 | 2, 8 |
| D4 | **Abort and turn end finish what they opened.** At `turn_completed`, `turn_failed` and `turn_canceled`, every streamed text or reasoning item of the turn without a final message gets an empty-body completion; every compaction without its end gets `failed`. A tool is finished by its native result only (its status is its own); the plan does not invent a native result. | 0 (uses the existing streamed-text maps) | 0 | 2, 8 |
| D5 | **A live and a reread that differ in content are counted, not failed**, except where a systematic difference would replace on every reopen of an ordinary session. Those are removed at the source: Codex reasoning separators (4.1), Claude tool results (4.2). Each other difference is one `replaced`, named in Section 5. | 0 | 0 | 2, 4, 8, 10 |
| D6 | **Claude history carries the raw `toolUseResult` of its tool rows.** The catalog worker already reads the transcript once for folded input; the same pass attaches the raw result to the tool-result row of the same uuid, so a reopened tool row equals the live one and a reopened session keeps its file diffs. | 0 (the folded-input pass is widened, not duplicated) | 0 | 9 |
| D7 | **A user row whose native uuid differs between paths is keyed by its text** (`user-text:<16 hex of sha256(text)>:<n>`, `n` the ordinal among rows of that text in the session). Used for Claude folded input and for the native notices when the recording shows they differ. Plain turn input keeps `user:<uuid>`. | Claude +1 (`foldedCounts`, in D2) | 0 | 8 |
| D8 | **Generalize, do not copy.** `copilot-recordings.ts`, `journal-continuity.copilot.test.ts`, `journal-window.copilot.journal.test.ts` and the runner's `copilotSessions()` become provider-keyed. | helper -3 files, +3 | 0 | 3, 10 |
| D9 | **The adapters declare `journal: { itemIdentity: 1 }` last, each after its own real-transport tests.** Configuration, not code, switches serving on (S3 D8). | 0 | 0 | 5, 10 |
| D10 | **No protocol change, no new refusal, no new diagnostic.** `journal_window` and `journal_request` from S3 measure everything. If a probe shows one is missing, the plan stops and goes to the owner (rule 5). | 0 | 0 | all |

**Totals:** publisher fields 19 to 19; recovery outcomes 4 to 4; adapter fields +4 (two each); protocol surface 0; adapter recovery paths: Codex -1 (the reasoning "corrected" error row) +1 (the correction item with a key), Claude -1 (the repeat-the-whole-text append) +1 (the same correction item). A change that only adds (the four adapter fields) is justified by one invariant each: a nonce so a numeric native request id cannot collide across process lives; a flag so a legacy compaction notice is not a second row; the pending compaction so loading and end are one item; the folded counters so live and reread count identically.

## 4. The contract, per provider

Keys are type-prefixed, at most 4096 characters, never a delta source key, never `controller:`. Source keys (the timeline store's own) are untouched by this plan. "Both" means the live and the history delivery agree on the key.

### 4.1 Codex (`packages/agent-provider-codex/src/projector.ts`, `session.ts`)

The native `item.id` is the same string in `item/started`, `item/completed`, delta params and `thread/turns/list`. `session.ts` `finishBootstrap` already merges the buffered live events with history by source key; this plan changes keys, not that merge.

| Item | Key | Completion | Mark |
|---|---|---|---|
| user message (also a steered one) | `user:<item.id>` | at emit (`item/started` or `item/completed`, whichever is first; history on read) | none |
| assistant text and `plan` item | `assistant:<item.id>` | `item/completed`: final equal to streamed gives an empty body with `completes`; an extension gives the suffix with `completes`; nothing streamed gives the whole text; an empty message with nothing streamed gives no item | none |
| correction (final does not continue the streamed text) | `assistant:<item.id>:correction` | the base completes with an empty body, the correction row is complete beside it | none; the next replacement drops it (D5) |
| reasoning | `reasoning:<item.id>` | as the assistant text; **no error row** when the final does not continue the stream (that branch is deleted, Task 14) | none |
| tool: command, file change, MCP, dynamic, web search, sleep, collab, sub-agent | `tool:<item.id>` | `item/started` is the open row; `item/completed` repeats the whole content with `completes` (a tool row replaces its item) | none |
| agent communication | `comm:<item.id>` | at `item/completed` | none |
| image view or generation | `image:<item.id>` | at `item/completed` | none |
| compaction item | `compaction:<item.id>` | `item/started` loading (open); `item/completed` completed with `completes` | none |
| `thread/compacted` notice | `compaction:<turnId>` | complete at emit | **projected only when no `contextCompaction` item was seen for that turn** (`compactionItemTurns`, D2) |
| turn failure | `turn-error:<turnId>` | at emit; both paths already share it | none |
| runtime start-up notice (`mcpServer/startupStatus/updated`, `hook/*`, failed) | `error:runtime` | complete at emit | **live-only, kind key**: these arrive at every open, so they are the open-time snapshot case; a later notice updates the item in place |
| other error (turn-less `error`, unsupported or invalid notification, interaction unavailable) | `error:<fingerprint of turn, method and message>` | at emit | none; the next replacement drops it |
| plan update (`turn/plan/updated`) | `todo` | complete at emit | **live-only, kind key**; `thread/read` holds no plan updates; a later update replaces the board in place |
| tool approval, question, elicitation, permission request, plan approval | `interaction:<runId>:<requestId>`, on the `interaction_resolved` observation | with the resolution | **live-only**: nothing in `thread/read` replays an approval (fact FC2) |

**The three fixes.**

1. **Reasoning separators.** History joins `summary[]` with `\n\n`; live concatenates deltas and drops `item/reasoning/summaryPartAdded`. Without a fix every reasoning item with two or more summary parts replaces on its first reopen, which is every turn of a reasoning model. The projector emits a `\n\n` delta on `summaryPartAdded` when `summaryIndex` is above 0 and the previous part was not empty, so the streamed text equals the join and the completion is an empty body. `reasoning/textDelta` stays dropped: a reasoning item with only `content[]` arrives whole at completion, as in history.
2. **Interaction keys survive restarts.** An owned runtime numbers server requests from 1 in each process, so `tool:3` of two process lives would collide with a carried live-only item and overwrite it. The key carries a random `runId` of the session object. (The shared runtime already puts a generation in the request id; the `runId` makes the rule one and uniform.)
3. **Plan mode, stated and not changed.** In plan mode `session.ts` (about line 1368) swallows the live `plan` item and offers it as a plan-approval interaction after the turn; `thread/read` returns it as an assistant item. The first reopen after a plan turn therefore holds a `assistant:<id>` the journal lacks, mid-window: one `replaced`/`changed`, then settled. The plan counts it (Section 5) and leaves the live behaviour alone; showing the plan live as well is O1.

**Facts the recordings must show before the keys are final (Task 1).** Each has the decision to take if it is false; none needs the owner.

| # | Fact | If false |
|---|---|---|
| FC1 | Item ids are equal in notifications and in `thread/read` / `thread/turns/list` for every item type of Section 4.1. | That type is keyed `<type>:<turnId>:<ordinal>` in both paths. |
| FC2 | `thread/read` holds no approval, question or elicitation record, and no unknown item type that `mapItem` turns into an error row. | An approval that is recorded gets `interaction:<requestId>` without the live-only mark; an unknown type is skipped in the history projection. |
| FC3 | An interrupted turn: whether a partially streamed message or reasoning is in history, and what status an interrupted tool has. | D3 and D4 already cover both outcomes; the recording asserts which one happens. |
| FC4 | Plan mode: history holds the plan item and the live turn does not. | The row for plan mode in Section 5 changes from `changed` to `unchanged`. |
| FC5 | Compaction: whether `thread/read` keeps the items before the compaction, and whether both `contextCompaction` and `thread/compacted` arrive. | Keep-everything gives `unchanged` after a compaction; a rewrite is one `changed` and then settled, as for Claude. |
| FC6 | `summaryPartAdded` carries `summaryIndex`, and the separator fix makes a two-part reasoning equal its join. | The recording fails; the separator rule is rewritten to what the events say. |
| FC7 | A tool item completed live equals the same item in `thread/read` after projection (command output, file changes, MCP result, dynamic result). | A differing field is dropped from the projection in `tool-result.ts` for both paths (project only what both deliver), not worked around in the Controller. |
| FC8 | A normal scripted turn on Codex 0.169 produces no unsupported-notification error row. | The notification joins `NON_TIMELINE_NOTIFICATION_METHODS`. |
| FC9 | A steered user message has its own item id equal in both paths. | Keyed by text (D7). |

### 4.2 Claude (`packages/agent-provider-claude/src/projector.ts`, `session.ts`, `folded-input.ts`, `catalog-worker.ts`)

History comes from the SDK's `getSessionMessages` (the main chain only, no system messages) widened with folded input (`folded-input.ts`). Live comes from the SDK stream plus the Controller's own input rows. One projector, `delivery` set at construction.

| Item | Key | Completion | Mark |
|---|---|---|---|
| user turn input (typed, queued and run as the next turn) | `user:<uuid>`; the SDK echoes the uuid the Controller gave (the result's `user_message_uuid` is how `session.ts` already correlates), and the transcript keeps it (fact FL1) | at emit | none |
| input folded into a running turn | `user-text:<hash16>:<n>` (D7). The live row (`noteCommandLifecycle`, `started` while a turn runs) and the history row (the `queued_command` attachment of `folded-input.ts`) differ in uuid, so both are keyed by text. `n` counts rows of that hash in the session, in order, from `foldedCounts`, which the history projector fills at construction and the live projector continues. | at emit | none |
| input withdrawn before it ran | `user:<steer uuid>` | at emit, with `withdrawn` | none; never in the transcript, so the next replacement drops it (D3). It is not live-only: several can exist and a kind key would overwrite them. |
| native notice user rows (`[Request interrupted by user…]`, `<local-command-stdout>…`) | `user:<uuid>` if the recording shows the uuid equal, else `user-text:…` | at emit | none. If the live stream does not emit them at all, the reread holds a row the journal lacks: one `changed` per interruption, counted (Section 5). The plan does not synthesize the CLI's wording. |
| assistant text | `assistant:<message.id>:<block index>`; the stream's `index` equals the history block position because tool-use and thinking blocks take a slot (`projector.ts` 101-107); `String(uuid)` when the record has no message id | the complete assistant record completes the item even when its suffix is empty (an empty body with `completes`, the SDK's rule for text) | none |
| correction | `assistant:<message.id>:<index>:correction` | today the projector appends the whole final text again (`projector.ts` 111); the base completes with an empty body and the correction is a complete item beside it | none; dropped by the next replacement |
| reasoning (thinking) | `reasoning:<message.id>:<block index>` | as the assistant text | **live-only, occurrence key, only if the recording shows the reread lacks it** (fact FL3); otherwise none |
| tool | `tool:<tool_use_id>` | the `tool_use` block is the open `running` row; the `tool_result` user record repeats the whole content with `completes`. A tool's own `error`/`failed` status is its content. | none |
| tool image | `tool:<tool_use_id>:image:<index>` | at the tool result | none |
| TodoWrite | `todo:<tool_use_id>` | complete at emit; history holds the `tool_use`, so every call is rebuilt and none is live-only | none |
| compaction | `compaction:<status uuid>` while `compacting` (open, `pendingCompaction`); the boundary completes the same item (`completes`, with trigger and pre-tokens). A boundary with no pending status keys `compaction:<boundary uuid>`. | the boundary; at turn end without a boundary the item is finished `failed` (D4) | none. History has no compaction row (the SDK read leaves system messages out), and the chain restarts at the boundary: a compaction is one replacement at the next reopen (4.2, fix 4), after which the marker is gone, as it is on any reopen today. |
| permission prompt, `AskUserQuestion`, plan approval | `interaction:<requestId>` (`claude:<toolUseID>:<uuid>`, unique per request), on the `interaction_resolved` observation | with the resolution; at turn end `cancelAll` resolves the rest | **live-only** (the transcript holds no prompt; fact FL4). `AskUserQuestion` and `ExitPlanMode` also have their `tool:<id>` rows, which history rebuilds. |
| sub-agent activity | the parent's `tool:<id>` row of the `Task`/`Agent` tool; sidechain messages (`parent_tool_use_id`) are dropped by the projector in both paths | as a tool | none |
| child session view | same projector, scoped to the child's session id; the child's `timeline_replacement` is a window like any other | as above | none |

**The four fixes.**

1. **Tool results (D6).** The live tool row carries `tool_use_result` as a JSON part and as `file_changes`; the SDK's public history omits it, so every Edit, Write and Bash row of a session differs between the paths, and a turn run after a reopen differs again: without this fix almost every reopen replaces. The catalog worker's transcript pass (`withFoldedInput`, becoming `withTranscriptExtras`) attaches the raw `toolUseResult` to the row of the same uuid. The existing assertion that cold history contains no `file_changes` (`native-normalized.local.test.ts`) changes to its opposite; a reopened session now keeps its diffs, which the owner sees as an improvement.
2. **Folded input (D7)** as in the table. Counters reset at a compact boundary in the live projector, because the chain a reread sees restarts there.
3. **Completion rows.** An assistant record after streamed text always completes (empty suffix included); a non-extending final stops being appended and becomes the correction item.
4. **Compaction as one item**, with `pendingCompaction`, and a `failed` ending (D4). The loading item's key differs from nothing in history, so the compaction costs the one replacement that the chain rewrite costs anyway; the plan does not add `includeSystemMessages`, which would add a path and an unverified key.

**Facts the recordings must show (Task 7).**

| # | Fact | If false |
|---|---|---|
| FL1 | A typed or queued-as-next-turn input keeps its uuid in the transcript. | Keyed by text (D7) for every user row. |
| FL2 | The raw transcript row of a tool result carries `toolUseResult` and the `tool_use_id` of its block, so D6 applies. | The tool row's JSON part and `file_changes` are not journaled (dropped in both paths) and the page shows the tool without a diff after a reopen only. This goes to the owner (O3) before it ships. |
| FL3 | A streamed thinking block is in the reread with the same text. | The reasoning is live-only by occurrence (table), recorded and asserted. |
| FL4 | The transcript holds no permission prompt or question record. | The record is keyed `interaction:<requestId>` without the live-only mark. |
| FL5 | After `/compact`, the SDK read starts at the boundary; whether the status row and the boundary row both arrive live. | A read that keeps the earlier chain gives `unchanged`; the compaction rows follow the table either way. |
| FL6 | Interrupt and local-command notices: arrive live or not, uuid equal or not. | Rows of Section 5 and the notice row of the table. |
| FL7 | An interrupted turn: partial assistant text recorded or not; the tool result written for a tool in flight. | D3 and D4; the recording asserts the outcome. |
| FL8 | `turnId` on history rows (`promptTurns`) equals the live `turnId` for the same row. | Not in the digest; a differing `turnId` moves a row across a retention window, so the recording asserts equality, and a difference is fixed in `catalog-worker.ts`. |

## 5. Expected outcomes of a reopen (what the recordings assert)

Every row is asserted by a recording-based continuity test and a real-transport test; "name" is the test title, so a change of behaviour is a visible change of a test name (S3 Task 3).

| Case | Provider | Expected reopen |
|---|---|---|
| settled turns with text, tool, reasoning; released, restarted, reread twice | both | `unchanged`; a second reread adds nothing; no open item |
| turn run after a reopen (live after reread), then reopened | both | `unchanged` (this is what D6 and the separator fix make true) |
| tool approval, question, elicitation, plan approval | both | `unchanged`; the interaction items are carried, live-only |
| plan update / todo | Codex | `unchanged`; one `todo` item; Claude's `TodoWrite` rows are rebuilt, `unchanged` |
| corrected final message | both | one `replaced`/`changed`, then `unchanged`; the correction item is gone |
| plan-mode turn | Codex | one `replaced`/`changed` at the first reopen, then `unchanged` (O1) |
| compaction | Claude | one `replaced`/`changed`, then `unchanged`; Codex per FC5 |
| failed compaction | both | the item ends `failed`; one `changed` at the next reopen if the loading item is absent from history |
| folded input | Claude | `unchanged` |
| withdrawn input, interrupt notice absent live | Claude | one `changed` at the next reopen |
| interrupted turn, partial text not recorded | both | one `changed` at the next reopen, then `unchanged`; no item stays open |
| interrupted turn, partial text recorded | both | `unchanged` |
| tool still open in both deliveries | both | `unchanged` (same open content) |
| tool completed while the Controller was away | both | `replaced`/`open_item`, once |
| a terminal wrote a turn while the Controller was away | both | `appended` (new items at the end) or `changed`; settles; never `unchanged`-but-stale (see O2) |
| a session grown past the window | both | `appended`, newest items; older history by prepend |

## 6. Tasks

Order: shared helpers, Codex (1 to 5), Claude (6 to 10), the runner, local verification of both, measurements, deletions. Each task ends with Gate G. Keep the pieces of a task in one commit with a State line.

### Task 1: Codex facts and a scripted model (spike before design)

**Files:** `packages/agent-provider-codex/src/test-utils/native-responses-fixture.ts` (a scripted Responses-API server and a temporary `CODEX_HOME` with `config.toml` for a mock provider, `approval_policy` set per scenario; extracted from the four `*.local.test.ts` files that each re-implement it), `src/journal-facts.local.test.ts` (raw: drives `spawnCodexAppServer`, no adapter change, prints and asserts FC1 to FC9).

**Interface.** `startResponsesFixture(script)` where a script step is a list of Responses events for one model request (text deltas, reasoning summary parts, a function call, a stalled stream that waits for an interrupt, a final item that differs from the deltas). It returns `{ url, home, cwd, requests, close }`. The facts test records, per scenario, the raw notifications and the raw `thread/read` and `thread/turns/list`, and asserts each fact of 4.1.

**State:** none (test code). **Deadline:** the spike is done when every FC has an asserted answer; a fact that cannot be reproduced against a scripted model is listed in Section 8 with how it is verified instead.

**Run:** `BORGEE_CODEX_TEST_EXECUTABLE=$(command -v codex) timeout 900 pnpm --filter @orchardworks/agent-provider-codex exec vitest run src/journal-facts.local.test.ts --testTimeout=60000 --maxWorkers=1`.

### Task 2: Codex identity in the adapter (D2 to D5)

**Files:** `projector.ts` (keys, completion rows, the correction item, the separator delta, `compactionItemTurns`, the end-of-turn finishing of streamed items), `session.ts` (`runId`, interaction keys on `interaction_resolved`, the start-up notice key, `todo`, identity on `timeline_replacement` rows), `communication-history.ts`, `images.ts` (identity on their rows), `history.ts` (history rows carry the same keys), `tool-result.ts` only if FC7 requires it, `projector.test.ts`, `session.test.ts`, `history.test.ts`, `docs/current/agent-remote/providers.md` and a short "Item identity" section in the Codex provider doc.

**Interface.** Every timeline observation and every `interaction_resolved` observation carries `itemIdentity` as the SDK's `ProviderObservation` requires, in both deliveries. The declaration is not added in this task.

**State:** adapter fields +2 (`runId`, `compactionItemTurns`); paths -1 (reasoning error row) +1 (keyed correction).

**Tests** (offline, `createScriptedAppServer` and hand-built notifications): every timeline observation of a scripted turn has a key; keys are equal between `projectNotification` and `projectCodexThreadHistory` of the same items; a streamed text equal to the final text gives an empty completing body, an extension the suffix, a non-extension an empty completion plus a complete correction item; a two-part reasoning streamed with `summaryPartAdded` equals the history join; `thread/compacted` is not projected after a `contextCompaction` item of the same turn; `todo`, the start-up notice and interactions are live-only and nothing else is (an assertion over the whole recording set); an interrupted turn leaves no streamed item open; `liveOnlyKeyViolations` is empty for the scripted two-turn sessions.

**Run:** `@orchardworks/agent-provider-codex` suite, Gate G.

### Task 3: Shared continuity helpers, then Codex recordings (D8)

**Files:** `packages/agent-host/src/test-utils/recordings.ts` (replaces `copilot-recordings.ts`: `recording(provider, name)`), `journal-continuity.test.ts` and the Copilot test generalized into one table-driven `journal-continuity.recordings.test.ts` over `{ copilot, codex, claude }` (a provider without fixtures is skipped, and a fixture directory without a test fails); `packages/agent-provider-codex/src/journal-recording.local.test.ts` and `src/journal-fixtures/*.json` (one observation per line, ids masked, as Copilot's recorder writes them).

**Recordings** (each a `ContinuityRun`: the `live` observations and the `reread` of the same session; `RECORD_JOURNAL_FIXTURES=1` rewrites them, otherwise the run is compared by the shape of its identities):

1. `settled`: streamed text, a command tool with output, a file change, a second turn; released and reopened.
2. `reasoning`: two summary parts, and a final that does not continue the stream.
3. `approval`: a command approval and a question (`request_user_input` through the default-questions setup); the question survives a reopen.
4. `todos`: `update_plan` twice (one `todo` item).
5. `plan-mode`: a plan turn (FC4).
6. `compaction`: a compaction that succeeds (FC5).
7. `interrupted`: a turn cancelled through the session's cancel while text streams, and another during a tool (FC3).
8. `correction`: deltas `abc`, final `xyz`.
9. `steer`: input folded into a running turn (FC9).
10. `restart`: `settled` with the reread from a new app-server process.
11. `after-reopen`: a turn run after a reopen, then a second reread.

**Tests** (Controller, offline, from the recordings): the rows of Section 5 for Codex, each asserted outcome in the test name; `liveOnlyKeyViolations` empty; every row has an identity and none starts with `controller:`.

**State:** none (test code and fixtures). **Run:** `-controller` for the two continuity files; the recording test under `timeout 900`.

### Task 4: Codex real transport through `createHostJournals`

**Files:** `packages/agent-host/src/journal-window.codex.journal.test.ts` (the S3 harness: `relayLoopback`, the real publisher, the real core, the real store, a scripted Codex session built from the recordings, a virtual clock).

**Tests:**
1. Open, publish `settled`, drop the connection, reopen from the reread: no item write, epoch unchanged, one `journal_window` of `unchanged`.
2. Runtime release (manager closed, new manager from history) five times: epoch unchanged.
3. Controller restart (new publisher id, same Relay journal): epoch unchanged.
4. `after-reopen`: a turn after a reopen, then a reopen: `unchanged`.
5. `correction` and `plan-mode`: one replacement, `changed`, a second open `unchanged`; the journal holds the base once and no correction item.
6. `approval`, `todos`, `steer`: reopen `unchanged`; the question is carried.
7. `interrupted`: no item open; five reopens `unchanged` after the first settles; a tool completed while away replaces once with `open_item`.
8. Older history: a scroll past the window (Codex pages of 10 turns; `readTimelineHistory` and `olderCursor`) sends `journal_older_request`, lands below the oldest item, one `older` request in the diagnostics. A `timeline_replacement` from the shared runtime's `restoreSnapshot` recovery syncs `unchanged`.
9. Size: a long session serves the newest items; a window larger than the Host's room is refused with the journal out of serving.
10. Production default: a Controller with no Relay grant publishes nothing, a Relay with default options serves nothing; `supportsJournal(codex)` is false until Task 5.

**State:** none; publisher count stays 19 (`grep` in the notes).

### Task 5: Codex declaration

`journal: { itemIdentity: 1 }` in `packages/agent-provider-codex/src/provider.ts`, after Tasks 2 to 4 pass; `supportsJournal(codex)` is true; docs updated. **Run:** Codex and Controller suites, `pnpm compatibility:update` then `compatibility:check`, Gate G.

### Task 6: Claude facts and a scripted model (spike before design)

**Files:** `packages/agent-provider-claude/src/journal-facts.local.test.ts`, reusing `test-utils/native-fixture.ts` (`nativeFixture`, `nativeReply`: a fake Anthropic API driving the real `claude` binary in a temporary `CLAUDE_CONFIG_DIR`, `ANTHROPIC_BASE_URL` on a free port, a fake API key; nothing signs in). The fixture gains the stalled stream and the thinking block the scenarios need (`nativeReply` knows text and tool use only).

**Facts:** FL1 to FL8 asserted against the raw transcript and `getSessionMessages`, with the raw stream-json messages of the live run printed beside them. **State:** none. **Run:** `AGENT_CLAUDE_TEST_EXECUTABLE=$(command -v claude) timeout 900 pnpm --filter @orchardworks/agent-provider-claude exec vitest run src/journal-facts.local.test.ts --testTimeout=60000 --maxWorkers=1` after a build.

### Task 7: Claude history carries tool results (D6)

**Files:** `folded-input.ts` (widened to one transcript pass that restores folded input and attaches `toolUseResult` to the tool-result row of the same uuid), `catalog-worker.ts` (the two callers), `session.ts` history constructor (the row carries the raw result to the projector), `native-normalized.local.test.ts` (the assertion flips), `folded-input.test.ts`, `projector.test.ts`.

**Tests:** a transcript fixture with Write, Edit and Bash rows: the history projection equals the live projection for each tool row (same JSON part, same `file_changes`); a row without a raw result projects as today; the pass reads the file once.

**State:** fields 0; paths 0 (one pass instead of two later). **Run:** Claude suite plus the native normalized test.

### Task 8: Claude identity in the adapter (D2, D3, D4, D7)

**Files:** `projector.ts` (identity on every `item()`, the completion rows, the correction item, `pendingCompaction`, `foldedCounts`, the reset at a boundary), `session.ts` (`noteCommandLifecycle` and `withdrawSteered` give the folded and withdrawn rows their keys; end-of-turn finishing of open blocks and an open compaction; identity on `interaction_resolved`), `interactions.ts` (the live-only mark and the key on resolution, including `cancelAll`), `child-session.ts` (identity passes through the shared projector; its replacement rows are keyed), tests `projector-identity.test.ts`, `session.test.ts`, `interactions.test.ts`, `docs/current/agent-remote/claude-normalized-events.md`.

**Tests** (offline, hand-built frames as `projector.test.ts` has them): every timeline observation has a key; keys equal between a stream and the same records read as history; a streamed block followed by its complete record completes with an empty body; a non-extending final gives the correction item; a folded input and its `queued_command` attachment get the same key and a second identical input `n` 1; a status row then a boundary is one item and a status row at turn end is `failed`; a permission prompt, `AskUserQuestion` and plan approval are live-only and nothing else is except a reasoning the facts say is lost; a child session's rows have keys; `liveOnlyKeyViolations` is empty.

**State:** adapter fields +2; paths -1 +1. **Run:** Claude suite, Gate G.

### Task 9: Claude recordings (D8)

**Files:** `packages/agent-provider-claude/src/journal-recording.local.test.ts` and `src/journal-fixtures/*.json`; `recordings.ts` gains `claude`. The tests import `../dist/provider.js` as the other native tests do.

**Recordings** (`ContinuityRun`s as in Task 3): `settled` (text, Write, Edit, Bash, a second turn); `thinking`; `approval` (a permission prompt and an `AskUserQuestion`; plan approval in a plan-mode run); `todos` (`TodoWrite`); `compaction` (`/compact` through `executeCommand` against the scripted model, then a turn); `failed-compaction`; `interrupted` (cancel while text streams, and during a tool); `steer` (input folded into a running turn; input queued and run next; input withdrawn by `interrupt` with `cancelQueued`); `correction`; `subagent` (a scripted `Task` call served by the same fake API); `restart` (a new process reads the transcript); `after-reopen`.

**Tests:** the rows of Section 5 for Claude; every row has an identity; none starts with `controller:`; `liveOnlyKeyViolations` empty; a sub-agent run's sidechain is absent and its parent tool row has equal keys.

**State:** none. **Run:** `-controller` continuity tests; the recording test under `timeout 900`.

### Task 10: Claude real transport, then the declaration

**Files:** `packages/agent-host/src/journal-window.claude.journal.test.ts`, `packages/agent-provider-claude/src/provider.ts` (`journal: { itemIdentity: 1 }`, last), docs.

**Tests:** the ten of Task 4 for Claude, with these differences: test 5 is the corrected final and the compaction (`changed` once, then `unchanged`, and the epoch changes only at the replacement); test 6 adds `steer` (folded input `unchanged`; withdrawn input one `changed`); test 7 adds an interrupt with the notice absent live; test 8 serves older history from the manager's whole timeline (Claude reads the whole transcript at open and has no `readTimelineHistory`), so a prepend answers from memory.

**State:** none; the publisher count stays 19. **Run:** Claude and Controller suites, `pnpm compatibility:update` then `compatibility:check`, Gate G.

### Task 11: The measuring runner, per provider (D8)

**Files:** `packages/agent-remote-lab/performance/local-baselines.mjs`, `README.md`, and the runner's pure-part tests.

**Interface.** `journal-open` and `journal-reopen-mix` take `--provider copilot|claude|codex` (default `copilot`; `copilotSessions()` becomes `sessionsOf(provider)`). The mix is now 35 opens in a fixed order: 10 page reloads, 10 session releases then reads, 5 Controller restarts (`pnpm local up --no-build`, `ARC_LOCAL_JOURNALS=1` exported), 5 interruptions (`session cancel` then release and reopen), and 5 **turn-then-reopen** (a turn with one Edit, Write or command tool, sent through the page, then a release and a reopen). Claude adds one compaction and the open after it. Per open the runner records the `journal_window` events since the last (reason and bytes), the path that answered, the journal epoch from `journals.sqlite` `meta` against the page's `timeline_page` epoch (S4's proof of journal serving), and the hole check. Codex sessions are released after each use and the runner waits `--release-wait` for the daemon to unload them.

**State:** none in production. **Tests:** the pure parts under Node 22 in `packages/agent-remote-lab`, Gate G.

### Task 12: Enable and verify on `pnpm local`, Codex then Claude

Follow `.agents/skills/prepare-arc-local/SKILL.md` with free ports and the owner's services left running. Real sessions run in the user's own homes through the development Controller, as the skill allows; they are the only place this plan touches them.

For **each** provider, in order Codex, Claude:

- [ ] `ARC_LOCAL_JOURNALS=1 pnpm local up`; turn smart reading on for the provider through `pnpm local api` (`PUT /v1/remote/hosts/<hostId>/smart-reading`; `GET` lists it). If the provider is missing from the Host or not signed in, stop and tell the owner; never start the Codex daemon.
- [ ] **A model turn.** Create a session in the page and send a message that streams text and runs a tool (a shell command; for Claude also an Edit of a file in the instance workspace). Confirm the Controller log has no `journal_open_refused`, `journal_session_stopped`, `journal_session_unserved` or `journal_session_restarted`, and `journals.sqlite` (mode 0600) holds the session.
- [ ] **Journal-served reading, proven by the epoch check.** Release the runtime, reload the page: the `negotiated` frame echoes `itemKeys`, and the `timeline_page` epoch equals the epoch in `journals.sqlite` `meta`; the conversation shows the user message, text, the tool with its result (a Claude Edit shows its diff after the reload) and a screenshot, read and not only taken, agrees. With smart reading off the epoch is the Controller's.
- [ ] **Send through S5's Relay-owned control.** From the journal-served page, `acquire`, send a second message, see the rows arrive; the first send opens the Controller stream, no read opened one. Release and reopen: the new rows are read journal-served, the `journal_window` reason is `unchanged` or `appended`, never `replaced`.
- [ ] **Take-over.** Hold the session in a native CLI inside a detached pty (`tmux new -d`, `claude --resume <id>` or `codex resume <id>`, left idle), reload the page: it offers "Take over" with the owner; take over; the next send works and the next open is journal-served. Record the `journal_window` reason after the terminal wrote a turn. If a pty cannot be made, record that the case was not exercised.
- [ ] **Reconnect after a Controller restart** with the page open: `pnpm local up --no-build`; the page keeps its rows, no frame without rows, the reason is `unchanged`.
- [ ] **An interruption.** `session cancel` during a streaming turn and during a tool, then release and reopen: no item stays open, the reason is as Section 5 says, a second open is `unchanged`.
- [ ] **Compaction (Claude).** A small session and `/compact` through `executeCommand` (cheap: the session is a few turns). Record the reason of the next open (expected one `changed`) and the open after it (`unchanged`). If it cannot be triggered cheaply, say so; the recording covers it.
- [ ] **Codex: release every Codex session this task created** (`agent-remote-controller-dev session release <address>`), and confirm they are unloaded.
- [ ] Run the two runner scenarios for the provider and save the JSON under `.tmp/` (not committed).

### Task 13: Record the measurements and decide

A section "S6a measurements" is appended to this plan, one table per provider, with the build info the runner prints and the date. Recorded: replacements per open by reason (and, for every `changed`, the item type and the case of Section 5 that explains it), bytes per open (Controller to Relay, Relay to browser), first-open misses, open and interrupted-item replacements, open time p50 and p95 against S3's Copilot figures at throttle 1 and 4, holes, fills and older requests per open, quota refusals, and the staleness probe of O2 (a terminal wrote a turn while the journal existed: how long until the page showed it). The roadmap Progress rows for S6a and S6 are updated. A triggered item (Section 7) becomes a task of S6b or goes to the owner; it is never added to this plan.

### Task 14: Deletions

What this work makes unnecessary:

- [ ] `packages/agent-host/src/test-utils/copilot-recordings.ts`, `journal-continuity.copilot.test.ts` and the Copilot-only parts of `journal-window.copilot.journal.test.ts` that the table-driven versions cover (verify by running them first).
- [ ] The runner's `copilotSessions()` and its Copilot-only wording in the scenario descriptions.
- [ ] Codex: the reasoning error row "Codex final text corrected streamed item" in `projectCompletedTextItem`, and the `completed-suffix` and `completed-correction:<fnv>` source-key branches that only the old identity-less merge needed (verify by `git grep`; a source key the timeline store still dedupes on stays).
- [ ] Claude: the append-the-whole-final-text branch of `projector.ts` (the correction item replaces it) and the second transcript read for folded input (merged into Task 7's single pass).
- [ ] The four duplicated Responses servers of Codex's `*.local.test.ts` files, moved onto Task 1's fixture where it takes one line each; any that needs more stays and is listed.
- [ ] **Not deletable yet, written down:** S4a's Controller-answered leftovers (the opt-in flag, the old row key and `itemIdentity()`, `mergeAuthoritative`'s range-overlap rule, `coalesceEntry`'s type-based matching, `retiredEpochs`, the `stale_epoch` status) stay until OpenCode (S6b) is the last crude provider. S6a removes no protocol surface.
- [ ] The audit of S3 Task 8 re-run for the two providers: `git grep -n "identity === undefined\|row.identity" -- packages/agent-host/src ':!*.test.ts'`; a branch goes only when no row without identity can reach it. The `identityMissing` stop stays.
- [ ] The sentences of the P1-C2 plan, `providers.md` and the normalized-event docs that say Claude or Codex are not capable.

**State:** line counts of what was deleted in the notes; fields and paths 0.

## 7. Thresholds (committed here; Task 13 only checks them)

The measurement is the 35-open mix of Task 11 per provider, plus the Task 12 session. Two kinds of number: a **defect line**, which blocks the release until fixed, and a **trigger**, which opens a deferred item exactly as in S3.

| Line | Defect when |
|---|---|
| Settled reopen | Any `replaced` after a page reload, a release, a Controller restart or a turn-then-reopen on a session with only text, tools and reasoning. The reason names the item type; the fix is in the adapter (a key, a mark or a content rule), never in the Controller or the core. |
| Unexplained replacement | Any `replaced` over the 35 opens that no row of Section 5 explains. |
| Open item | Any `open_item` on a settled reopen. |
| Holes | The full journal-served read lacks an item that the full native read has, after any interruption (S3's M3 line, tightened from "more than 1 of 5" to any, because Claude and Codex are the daily providers). |
| Journal serving | A sample where the page's epoch is not the epoch in `journals.sqlite` does not count as journal-served; fewer than 30 counted opens per provider repeats the run. |

| Deferred item | Triggered when |
|---|---|
| I2: in-place update of an open item | `open_item` replacements exceed 5 percent of the opens, or any settled reopen gives `open_item` (a defect first) |
| M3: history holes | any hole (above); a hole is a defect and its cause is fixed |
| M6: an incomplete journal while the window waits | a journal stays `incomplete` more than 2 seconds at p95, or a first-open miss happens on a session of fewer than 200 items |
| Drop the oldest instead of evicting bodies | fills exceed 1 per open at p50, or any `journal_quota_exceeded` or refused window at default limits. Claude sessions are the largest the owner has: record the window size and the oldest item reachable by scrolling. |
| Bytes per unchanged window | recorded and compared with S3's Copilot figure; no number is invented here. A window of an unchanged 1,000-item session that sends row bodies is a defect to read (the `unchanged` outcome is the design's point). |

## 8. What can and cannot be recorded

**Can, against a scripted model, in a temporary home, with no sign-in.**

| | Claude Code 2.1.319 | Codex 0.169.0 |
|---|---|---|
| How | `nativeFixture`: a fake Anthropic API on a free port, `ANTHROPIC_BASE_URL`, `CLAUDE_CONFIG_DIR`, a fake key | `startResponsesFixture` (Task 1): a fake Responses API, `CODEX_HOME/config.toml` with a mock provider, `OPENAI_API_KEY=local-test`, the real `codex app-server` spawned by `spawnCodexAppServer` |
| Streamed text, thinking or reasoning parts, tools, a final that differs from the deltas | yes | yes |
| Approval, question, plan approval | yes (`canUseTool`, `AskUserQuestion`, plan mode) | yes (`approval_policy`, `request_user_input` as `default-questions.local.test.ts` does) |
| Interrupt during text and during a tool | yes (a stalled stream, then cancel) | yes (`turn/interrupt`) |
| Folded and queued input, withdrawn input | yes (`steer.local.test.ts` shows how) | yes (`turn/steer`) |
| Compaction | `/compact` through the scripted model, which returns the summary | `thread/compact/start` through the scripted model |
| Sub-agent | yes (a scripted `Task` call served by the same fake API) | collab items only if the scripted model can call the tool; otherwise a hand-built `thread/read` page (the existing `collaboration-items.test.ts` fixtures) |
| A new process reading the same session | yes | yes (a second app-server on the same `CODEX_HOME`) |

**Cannot be recorded, and how each is verified instead.**

- **The shared Codex daemon.** Production Codex sessions run in the owner's shared daemon through `codex-daemon-client` (generation-bearing request ids, `restoreSnapshot` recovery, terminal co-owners). A spawned app-server does not reproduce it. Covered by the existing `codex-shared` suite (`AGENT_REMOTE_SHARED_CODEX_TEST_EXECUTABLE`), the `timeline_replacement` sync test of Task 4, and Task 12 on the real daemon. The daemon is never started by this plan; sessions are released after use.
- **A real model's behaviour:** thinking signatures and redacted thinking, multi-part reasoning summaries of a real reasoning model, real token-limit autocompaction. The scripted model emits the protocol events, so the recordings prove what the adapter does with them; Task 12's real turns prove that a real model produces nothing else (FC6, FL3).
- **A terminal driving the session.** The native CLI's lock and pid records cannot be set up by an adapter test without a pty. Task 12 does it with a detached `tmux` session; if that fails it is reported as not exercised, and O2 stands.
- **A killed Controller or CLI process** is never used: interruptions are `cancel` and `release` (S3, the skill).
- **Versions.** Fixtures record what 2.1.319 and 0.169.0 do; a change of CLI shows as a changed test name and shape (S3 Task 3). The native test runner already pins minimum versions (`scripts/native-test-versions.test.mjs`).

## 9. Risks and what is not in S6a

- **Tool results (Claude).** The largest content gap is the one that would make the journal replace on nearly every reopen. D6 removes it at the source; if FL2 is false the plan stops (O3). Task 7's test is the first thing to run in the Claude half.
- **Reasoning separators (Codex).** Same shape: every reasoning turn of a reasoning model. The separator rule is asserted by FC6 on the real CLI and by Task 12 on a real model.
- **A terminal drives the session.** Behind-marking and read-only observation are P1-C3 pieces that are not built. A journal-served page of a session a terminal is working in shows the journal as it was at the last Controller open, until the Controller opens the session again (the first send or the take-over). Copilot has the same property and the owner uses terminals much more with these two providers. O2.
- **Open-time emissions.** Anything the adapter emits when a session opens is an open-time snapshot (the S3 lesson: no snapshots without a native position). The audit for both adapters: every observation emitted between `observe()` and the first live notification is either from history or has a kind key. The recordings assert it by opening the same session five times and counting new items (zero).
- **Occurrence keys and the SDK rule.** The SDK says a session holds at most one live-only key per item type. Copilot's reasoning (one per `reasoningId`) and every interaction are occurrence-keyed, emitted once at their occurrence, never at open; `liveOnlyKeyViolations` skips interactions (it checks timeline items). This plan applies the rule as "nothing re-emits a live-only item under a fresh key at open", which the five-opens test checks, and adds a reasoning-twice recording to Copilot's and Claude's `liveOnlyKeyViolations` runs. If the check trips on an occurrence-keyed reasoning, the SDK comment and check change to the invariant (a docs-and-test edit, no type change), and that is recorded in the Task 13 notes.
- **Window and history size.** Claude reads the whole transcript at each open (its existing cost) and serves the newest window; the manager's whole timeline answers older requests. Task 13 records the window of the longest real Claude session.
- **Codex release timing.** A released Codex session unloads after a delay; the runner's `--release-wait` and Task 12's explicit release handle it.
- **Production.** The declaration only makes the Controller ask for `journal=1`; a Relay serves nothing without `AGENT_REMOTE_JOURNALS=1` and the Host's switch. No Controller update is required by this plan, so the roadmap's "tell the owner when every Controller must update" does not trigger.
- **Not in S6a:** OpenCode (needs the read-only history capability, S6b), behind-marking and observation, backfill, the removal of S4a's Controller-answered leftovers, in-place update of open items, a different eviction rule, any protocol change.

## 10. Open questions (owner) and decisions made

**For the owner.**

- **O1. Codex plan mode: show the plan item live too?** Today the live page shows the plan only inside the plan-approval card and a reopen shows it as an assistant message. Default in this plan: no change; the first reopen after a plan turn costs one replacement (cheap, then settled). Showing it live would remove the replacement but would show the plan twice until the card is answered. Needs a product call; the plan proceeds with the default.
- **O2. A terminal drives a Claude or Codex session while its journal exists.** The journal-served page is stale until the Controller opens the session again. Recommendation: the release goes out when both providers pass Gate S6a (the switch is off by default, so nothing changes for the owner on release), and the owner turns smart reading on for Claude and Codex on the owner's Host only after S6b adds behind-marking (the Relay marks a journal behind when a catalog confirmation is newer and does not serve it). The alternative is to turn it on at release and accept the staleness for terminal-driven sessions. Task 13 measures how long the page lags.
- **O3 (only if FL2 is false).** If the raw transcript row of a tool result does not carry what the live row carries, a reopened Claude session shows a tool without its diff, as it does today after any reopen, and the journal would replace on every turn. The choice is then between dropping the diff from the journaled row (consistent, the live page loses diffs in journal mode) and not shipping Claude. The plan stops and asks.

**Decided here** (technical):

- Codex first, one plan, one gate for both providers (D1).
- Compaction in Claude is one replacement, not a key that spans the chain rewrite (4.2 fix 4); `includeSystemMessages` is not added.
- Interrupted streamed items are plain, not live-only (D3); a withdrawn Claude input is plain.
- Approvals and questions of both providers are live-only with occurrence keys; Copilot's rule that `permission.*` is on disk does not carry over (FC2, FL4 verify it).
- Tool results are made equal at the source (D6) rather than counted; the diff persists after a reopen as a side effect.
- Runner proof of journal serving is the epoch of S4 (`negotiated` echoes `itemKeys`; the page's epoch equals `journals.sqlite` `meta`), not the old attach-timing signal that S3 found unreliable.

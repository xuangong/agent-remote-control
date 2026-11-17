# S6a: Claude Code and Codex under the relaxed item-identity contract

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax. This plan states interfaces, deletions and acceptance tests, not code, under the rules in the [roadmap](2026-11-15-im-session-service-roadmap.md) ("Revised order after the simplification assessment"). It repeats [S3](2026-11-16-s3-first-journal-provider.md) for two providers; read S3 sections 1 to 3 first, and the "Research for the relaxed contract" section of the [P1-C2 plan](2026-11-15-p1c2-provider-item-identity.md), which is the evidence this plan starts from and corrects where the code says otherwise.

**Goal:** Claude Code and Codex publish their sessions to Relay journals the way Copilot does since S3, and a session of each is read journal-served, sent to through the S5 Relay-owned control, taken over, restarted and interrupted on this checkout's local instance. **The owner's condition for the release that follows: both providers work. Nothing is deployed until both do.** Daily work depends on these two.

**Architecture:** Unchanged from S3. The adapter owns keys, completion marks and live-only marks; the Controller never infers them; the core's `sync` decides; the client keeps one row per key (S4a). **This plan changes adapters, their recordings, two test helpers and the lab runner. It changes no protocol, no SDK type, no core rule and no Relay behaviour.**

**One plan, two providers, Codex first.** Codex has one projector, native ids equal live and in history, and no key gap; its work is mostly marks and two content fixes. Claude has the known key gaps (folded input, compaction) and a systematic content gap (tool results). Codex first proves the shared test helpers on a simple provider; Claude then reuses them. The local verification of both comes last, because the release needs both (Task 13).

---

## 1. For the owner: approve in one read

1. **No new mechanism.** Adapters give every item a key and say when it is finished. Claude gets four small fixes (Section 4.2), Codex three (Section 4.1). The one addition outside the adapters is a map in `host.ts` (Section 4.3, Task 10a) that keeps a terminal-driven session current. The publisher stays at 19 fields, the protocol does not change, the Relay does not change.
2. **The release carries no switch change.** A Controller with these adapters only asks for journals. The Relay serves them only with `AGENT_REMOTE_JOURNALS=1` and the Host's per-provider smart-reading switch, both off by default. No Controller update is forced. The owner turns the switch on for their own Host once Gate S6a has passed (terminal-driven sessions stay current by Task 10a).
3. **Cost of the relaxed contract, as measured here.** A reopen after a compaction, a withdrawn input or a corrected message replaces the journal once (the client keeps every unchanged row, S4a) and then settles. Anything else that replaces on a settled session is a defect fixed before release, not a number (Section 7 thresholds).
4. **Decided by the owner:** Codex plan-mode items are shown live (O1), and a session written by a terminal stays current, as a release gate of this plan (O2, Section 4.3). **Still open for the owner:** Section 10 (O3 to O5), each only if a recording shows its condition.

## 2. Rules, gates and environment

**Worktree.** `/Users/xian/projects/agent-remote-control/.worktrees/im-session-service`, branch `design/im-session-service`, after the S5 code fixes have landed, clean. Never touch the main checkout. Never push. Free ports for local validation.

**Environment, per-package suites and Gate G** are those of S3 section 1 (Node 22; `timeout 600 pnpm --filter <name> exec vitest run [files] --testTimeout=10000`; Gate G is the named suites, `timeout 900 pnpm typecheck`, `pnpm compatibility:update` then `compatibility:check`, `git diff --shortstat HEAD -- packages` in the notes, and a commit ending with `Co-Authored-By: Claude <noreply@anthropic.com>` with a State line). Filters: `@orchardworks/agent-provider-codex`, `@orchardworks/agent-provider-claude`, `@orchardworks/agent-remote-controller` (directory `packages/agent-host`), `@orchardworks/agent-provider-sdk`.

**Native tests need the real CLIs.** Claude: `AGENT_CLAUDE_TEST_EXECUTABLE=$(command -v claude)` (2.1.319 here); its local tests import `../dist/provider.js`, so build the package first (`pnpm --filter @orchardworks/agent-provider-claude build`). Codex: `BORGEE_CODEX_TEST_EXECUTABLE=$(command -v codex)` (0.169.0 here). Recording tests are `*.local.test.ts`, which each package's `test` script already excludes; they run under `timeout 900` with `--maxWorkers=1`.

**Gate S6a** (end of Task 14, with Task 10a and its local check in Task 12 passed): `timeout 3000 pnpm test`, `timeout 900 pnpm test:conformance`, `timeout 900 pnpm test:cloudflare`, the two native recording suites, Gate G, and the measurement record of Task 13.

**Preconditions, checked once before Task 1:**

- [ ] `git status --short` is empty and S5's code fixes are committed.
- [ ] `git grep -n "journal:" -- 'packages/agent-provider-*/src' ':!*.test.ts'` prints only the Copilot declaration.
- [ ] `grep -cP '^  private (?!readonly)(?!async)(?!get )\w+\s*[:=;]' packages/agent-host/src/journal-publication.ts` prints 19 (the baseline of the budget; it stays 19).
- [ ] Copilot's recordings still pass: `pnpm --filter @orchardworks/agent-provider-copilot exec vitest run tests/journal-recording.test.ts --testTimeout=60000`.
- [ ] Both native CLIs run against a scripted model in a temporary home (Task 1 and Task 7 begin with this check).

**Never** read or write the owner's `~/.claude`, `~/.codex` or `~/.copilot` in a test, never sign in, and never start the owner's shared Codex daemon. The recordings use a temporary `CLAUDE_CONFIG_DIR` or `CODEX_HOME` and a scripted model server on a free port. Only Task 12 (and the terminal turn of Task 10a's local check) touches the owner's real homes, through the local instance, as the `prepare-arc-local` skill describes.

## 3. Decisions and state accounting

"Fields" counts state a reader must hold in mind. "Paths" counts recovery paths. Budgets: publisher at most 20 mutable fields, recovery outcomes at most 6; both unchanged by this plan (19 and 4).

| # | Decision | Fields | Paths | Task |
|---|---|---|---|---|
| D1 | **One plan, Codex first, one release gate for both.** | 0 | 0 | all |
| D2 | **Keys, completion and live-only marks per item kind live in the adapters' projectors** (Section 4), one place per provider, equal in the live and the history delivery. | Codex +1 (per-turn compaction flag, +0 if FC5 lets the legacy branch go); Claude +2 (`pendingCompaction`, `foldedCounts`) | 0 | 2, 8 |
| D3 | **Live-only is for what native history cannot rebuild, and a live-only item is never emitted at open** (D12). An interaction, a reasoning block a reread lacks, and an error that history does not hold are live-only with an occurrence key (an error is keyed by a fingerprint of its message, so the same message is one item); the todo board keeps its kind key (`todo`). **A streamed item that was interrupted is never live-only:** it is finished with an empty body and may disappear at the next replacement (the owner's decision of 2026-11-16). | 0 | 0 | 2, 8 |
| D4 | **Abort and turn end finish what they opened.** At `turn_completed`, `turn_failed` and `turn_canceled`, every streamed text or reasoning item of the turn without a final message gets an empty-body completion; every compaction without its end gets `failed`. A tool is finished by its native result only (its status is its own); the plan does not invent a native result. | 0 (uses the existing streamed-text maps) | 0 | 2, 8 |
| D5 | **A live and a reread that differ in content are counted, not failed**, except where a systematic difference would replace on every reopen of an ordinary session. Those are removed at the source: Codex reasoning separators (4.1), Claude tool results (4.2). Each other difference is one `replaced`, named in Section 5. | 0 | 0 | 2, 4, 8, 10 |
| D6 | **Claude history carries the raw `toolUseResult` of its tool rows.** The catalog worker already reads the transcript once for folded input; the same pass attaches the raw result to the tool-result row of the same uuid, so a reopened tool row equals the live one and a reopened session keeps its file diffs. | 0 (the folded-input pass is widened, not duplicated) | 0 | 9 |
| D7 | **A user row whose native uuid differs between paths is keyed by its text** (`user-text:<16 hex of sha256(text)>:<n>`, `n` the ordinal among the rows of that text that the projector actually emitted, in the session). **Both paths also set the row's `messageId` to that key**, because `messageId` is in the digest and the two uuids differ. Used for Claude folded input and for the native notices when the recording shows they differ. Plain turn input keeps `user:<uuid>`. | Claude +1 (`foldedCounts`, in D2) | 0 | 8 |
| D8 | **Generalize, do not copy.** `copilot-recordings.ts`, `journal-continuity.copilot.test.ts`, `journal-window.copilot.journal.test.ts` and the runner's `copilotSessions()` become provider-keyed. | helper -3 files, +3 | 0 | 3, 10 |
| D9 | **The adapters declare `journal: { itemIdentity: 1 }` last, each after its own real-transport tests.** Configuration, not code, switches serving on (S3 D8). | 0 | 0 | 5, 10 |
| D10 | **No protocol change, no new refusal, no new diagnostic.** `journal_window` and `journal_request` from S3 measure everything. If a probe shows one is missing, the plan stops and goes to the owner (rule 5). | 0 | 0 | all |
| D11 | **A directory listing keeps terminal-driven sessions current** (owner decision O2, Section 4.3). When the Controller answers a listing, which already carries the native `updatedAt`, it attaches each journaled Claude or Codex session that is unowned, not held and newer than its last window, through the attach that crude mode runs on open; the window arrives `appended` and idle release follows. No timer, no message, no new refusal. | host +1 map in `host.ts` (`journalWindowAt`: session to the `updatedAt` of its last window) | trigger +1, recovery paths 0 (the attach and the idle release exist) | 10a |
| D12 | **The SDK rule for live-only items is the invariant, not a count.** "A live-only item is never emitted at open; occurrence keys are allowed." The five-opens recording test (open the same session five times, count new items: zero) replaces `liveOnlyKeyViolations`, which is deleted with its callers; the SDK comment beside `liveOnly` and the S4a sentence that cited the old rule are corrected. Live-only bytes stay pinned: a live-only item is carried through every replacement up to the journal's cap, so Task 14 records their total. | SDK -1 function, 0 types | 0 | 2, 14 |

**Totals:** publisher fields 19 to 19; recovery outcomes 4 to 4; adapter fields +3 (Codex 1, Claude 2); `host.ts` +1 map; protocol surface 0; SDK -1 function; adapter recovery paths: Codex -1 (the reasoning "corrected" error row) +1 (the correction item with a key), Claude -1 (the repeat-the-whole-text append) +1 (the same correction item). A change that only adds is justified by one invariant each: a flag so a legacy compaction notice is not a second row; the pending compaction so loading and end are one item; the folded counters so live and reread count identically; the map so a listing attaches a session once per native change and never in a loop.

## 4. The contract, per provider

Keys are type-prefixed, at most 4096 characters, never a delta source key, never `controller:`. Source keys (the timeline store's own) are untouched by this plan. "Both" means the live and the history delivery agree on the key.

### 4.1 Codex (`packages/agent-provider-codex/src/projector.ts`, `session.ts`)

The native `item.id` is the same string in `item/started`, `item/completed`, delta params and `thread/turns/list`. `session.ts` `finishBootstrap` already merges the buffered live events with history by source key; this plan changes keys, not that merge.

| Item | Key | Completion | Mark |
|---|---|---|---|
| user message (also a steered one) | `user:<item.id>` | at emit (`item/started` or `item/completed`, whichever is first; history on read) | none |
| assistant text and `plan` item (a plan-mode plan is shown live, O1; its `item/plan/delta` stream like text) | `assistant:<item.id>` | `item/completed`: final equal to streamed gives an empty body with `completes`; an extension gives the suffix with `completes`; nothing streamed gives the whole text; an empty message with nothing streamed gives no item | none |
| correction (final does not continue the streamed text) | `assistant:<item.id>:correction` | the base completes with an empty body, the correction row is complete beside it | none; the next replacement drops it (D5) |
| reasoning | `reasoning:<item.id>` | as the assistant text; **no error row** when the final does not continue the stream (that branch is deleted, Task 14) | none |
| tool: command, file change, MCP, dynamic, web search, sleep, collab, sub-agent | `tool:<item.id>` | `item/started` is the open row; `item/completed` repeats the whole content with `completes` (a tool row replaces its item) | none |
| agent communication | `comm:<item.id>` | at `item/completed` | none |
| image view or generation | `image:<item.id>` | at `item/completed` | none |
| compaction item | `compaction:<item.id>` | `item/started` loading (open); `item/completed` completed with `completes` | none |
| `thread/compacted` notice | `compaction:<turnId>` | complete at emit | **projected only when no `contextCompaction` item was seen for that turn** (`compactionItemTurns`, D2); the whole branch and its field are deleted if FC5 shows that the item always arrives |
| turn failure | `turn-error:<turnId>` | at emit; both paths already share it | none |
| thread-less start-up notice (`mcpServer/startupStatus/updated`, `hook/started`, `hook/completed`, failed) | none: **dropped from the timeline** (sent to `onDiagnostic`) | not an item | These carry no thread id, so the daemon delivers them to every loaded thread; one failing MCP server would put the same error into every Codex session's journal at every start. |
| other error (turn-less `error`, unsupported or invalid notification, interaction unavailable) | `error:<fingerprint of the message>` | at emit | **live-only, occurrence key** (D3): history never holds it, so a plain item would cost a replacement at the next reopen; a repeated identical message updates the same item |
| plan update (`turn/plan/updated`) | `todo` | complete at emit | **live-only, kind key**; `thread/read` holds no plan updates; a later update replaces the board in place |
| tool approval, question, elicitation, permission request, plan approval | `interaction:<itemId>` (the native item the request belongs to; `interaction:<turnId>:<requestId>` for a request with no item), on the `interaction_resolved` observation | with the resolution | **live-only**: nothing in `thread/read` replays an approval (fact FC2) |

**The three fixes.**

1. **Reasoning separators.** History joins `summary[]` with `\n\n`; live concatenates deltas and drops `item/reasoning/summaryPartAdded`. Without a fix every reasoning item with two or more summary parts replaces on its first reopen, which is every turn of a reasoning model. The projector emits a `\n\n` delta on every `summaryPartAdded` whose `summaryIndex` is above 0, with no condition, so the streamed text equals the join and the completion is an empty body. `reasoning/textDelta` stays dropped: a reasoning item with only `content[]` arrives whole at completion, as in history.
2. **Interaction keys survive restarts.** An owned runtime numbers server requests from 1 in each process, so `tool:3` of two process lives would collide with a carried live-only item and overwrite it. The native item id (`itemId` of an approval, question or permission request) is unique per item and is not a counter, so it keys the interaction; the fallback `<turnId>:<requestId>` is unique because turn ids are. No nonce and no new field.
3. **Plan mode shows the plan live (owner decision O1).** In plan mode `session.ts` (about line 1368) swallowed the live `item/plan/delta` and the `plan` item, and offered the plan only as a plan-approval interaction after the turn, while `thread/read` returns it as an assistant item. The swallowing branch is removed: the plan streams and completes as `assistant:<item.id>` like any assistant text, in both paths. `latestPlan` is still captured for the approval card, so the page shows the plan as a message and the card that approves it. A plan turn reopens `unchanged`.

**Facts the recordings must show before the keys are final (Task 1).** Each has the decision to take if it is false; none needs the owner.

| # | Fact | If false |
|---|---|---|
| FC1 | Item ids are equal in notifications and in `thread/read` / `thread/turns/list` for every item type of Section 4.1. | That type is keyed `<type>:<turnId>:<ordinal>` in both paths. |
| FC2 | `thread/read` holds no approval, question or elicitation record, and no unknown item type that `mapItem` turns into an error row. | An approval that is recorded gets `interaction:<requestId>` without the live-only mark; an unknown type is skipped in the history projection. |
| FC3 | An interrupted turn: whether a partially streamed message or reasoning is in history, and what status an interrupted tool has. | D3 and D4 already cover both outcomes; the recording asserts which one happens. |
| FC4 | Plan mode: history holds the plan item with the id the live `item/plan/delta` and `item/completed` carry. | The plan item is keyed by turn and ordinal in both paths. |
| FC5 | Compaction: whether `thread/read` keeps the items before the compaction, and whether `contextCompaction` always arrives (so `thread/compacted` is a duplicate). | Keep-everything gives `unchanged` after a compaction; a rewrite is one `changed` and then settled, as for Claude. If the item always arrives, the `thread/compacted` branch and `compactionItemTurns` are deleted (Task 14); if not, they stay. |
| FC6 | `summaryPartAdded` carries `summaryIndex`, and the separator fix makes a two-part reasoning equal its join. | The recording fails; the separator rule is rewritten to what the events say. |
| FC7 | A tool item completed live equals the same item in `thread/read` after projection (command output, file changes, MCP result, dynamic result). | A differing field that is metadata (a duration, an internal status string) is dropped from the projection in `tool-result.ts` for both paths, not worked around in the Controller. **A differing field that would remove command output or a diff is never dropped:** the plan stops and asks the owner (O4), as for O3. |
| FC8 | A normal scripted turn on Codex 0.169 produces no unsupported-notification error row, and a failing MCP server in the temporary config produces no timeline item in any thread. | The notification joins `NON_TIMELINE_NOTIFICATION_METHODS`. |
| FC9 | A steered user message has its own item id equal in both paths. | Keyed by text (D7). |

### 4.2 Claude (`packages/agent-provider-claude/src/projector.ts`, `session.ts`, `folded-input.ts`, `catalog-worker.ts`)

History comes from the SDK's `getSessionMessages` (the main chain only, no system messages) widened with folded input (`folded-input.ts`). Live comes from the SDK stream plus the Controller's own input rows. One projector, `delivery` set at construction.

| Item | Key | Completion | Mark |
|---|---|---|---|
| user turn input (typed, queued and run as the next turn) | `user:<uuid>`; the SDK echoes the uuid the Controller gave (the result's `user_message_uuid` is how `session.ts` already correlates), and the transcript keeps it (fact FL1) | at emit | none |
| input folded into a running turn | `user-text:<hash16>:<n>` (D7), **and the row's `messageId` is the same string in both paths** (the live row carries the steer uuid and the history row the attachment uuid today, and `messageId` is in the digest). The live row (`noteCommandLifecycle`, `started` while a turn runs) and the history row (the `queued_command` attachment of `folded-input.ts`) are both keyed by text. `n` counts only the rows the projector actually emitted (an empty prompt, a uuid already known, a withdrawn row and a skipped row are not counted), in order, from `foldedCounts`, which the history projector fills at construction and the live projector continues. A row with images keeps them: `folded-input.ts` today keeps only a string `prompt`, so image-bearing folded input is lost in history; it is widened to the attachment's content blocks (fix 2). | at emit | none |
| input withdrawn before it ran | `user:<steer uuid>` | at emit, with `withdrawn` | none; never in the transcript, so the next replacement drops it (D3). It is not live-only: several can exist and a kind key would overwrite them. |
| native notice user rows (`[Request interrupted by user…]`, `<local-command-stdout>…`) | `user:<uuid>` if the recording shows the uuid equal, else `user-text:…` | at emit | none. If the live stream does not emit them at all, the reread holds a row the journal lacks: one `changed` per interruption, counted (Section 5). The plan does not synthesize the CLI's wording. |
| slash-command rows and `isMeta` rows (the expanded command text, `<command-name>`, `<local-command-caveat>`, `<local-command-stdout>`), and rows a hook injects | **Live and history must agree:** both drop the row or both keep it, and the recording decides which, by what the SDK read returns (the history side cannot be changed cheaply; the live projector is aligned to it, as it already skips `isSynthetic`). A kept row is keyed as the notice row above. | at emit | none |
| assistant text | `assistant:<message.id>:<block index>`; the stream's `index` equals the history block position because tool-use and thinking blocks take a slot (`projector.ts` 101-107); `String(uuid)` when the record has no message id | the complete assistant record completes the item even when its suffix is empty (an empty body with `completes`, the SDK's rule for text) | none |
| correction | `assistant:<message.id>:<index>:correction` | today the projector appends the whole final text again (`projector.ts` 111); the base completes with an empty body and the correction is a complete item beside it | none; dropped by the next replacement |
| reasoning (thinking) | `reasoning:<message.id>:<block index>` | as the assistant text | **live-only, occurrence key, only if the recording shows the reread lacks it** (fact FL3); otherwise none |
| tool | `tool:<tool_use_id>` | the `tool_use` block is the open `running` row; the `tool_result` user record repeats the whole content with `completes`. A tool's own `error`/`failed` status is its content. **Parallel tool calls** (one assistant message with several `tool_use` blocks, results in one user record or several): each block keeps its own `tool:<id>`; the stream's block `index` and the history's position must agree, and order must agree; the structured result is attached only when a record holds exactly one `tool_result` (`projector.ts`), the same in both paths. Asserted by the `parallel-tools` recording. | none |
| tool image | `tool:<tool_use_id>:image:<index>` | at the tool result | none |
| TodoWrite | `todo:<tool_use_id>` | complete at emit; history holds the `tool_use`, so every call is rebuilt and none is live-only | none |
| compaction | `compaction:<status uuid>` while `compacting` (open, `pendingCompaction`); the boundary completes the same item (`completes`, with trigger and pre-tokens). A boundary with no pending status keys `compaction:<boundary uuid>`. | the boundary; at turn end without a boundary the item is finished `failed` (D4) | none. History has no compaction row (the SDK read leaves system messages out), and the chain restarts at the boundary: a compaction is one replacement at the next reopen (4.2, fix 4), after which the marker is gone, as it is on any reopen today. |
| permission prompt, `AskUserQuestion`, plan approval | `interaction:<requestId>` (`claude:<toolUseID>:<uuid>`, unique per request), on the `interaction_resolved` observation | with the resolution; at turn end `cancelAll` resolves the rest | **live-only** (the transcript holds no prompt; fact FL4). `AskUserQuestion` and `ExitPlanMode` also have their `tool:<id>` rows, which history rebuilds. |
| sub-agent activity | the parent's `tool:<id>` row of the `Task`/`Agent` tool; sidechain messages (`parent_tool_use_id`) are dropped by the projector in both paths | as a tool | none |
| child session view | same projector, scoped to the child's session id; the child's `timeline_replacement` is a window like any other. Its history is the subagent transcript (`getSubagentMessages`), so D6's attachment of the raw tool result covers it too | as above | none |

**The four fixes.**

1. **Tool results (D6).** The live tool row carries `tool_use_result` as a JSON part and as `file_changes`; the SDK's public history omits it, so every Edit, Write and Bash row of a session differs between the paths, and a turn run after a reopen differs again: without this fix almost every reopen replaces. The catalog worker's transcript pass (`withFoldedInput`, becoming `withTranscriptExtras`) attaches the raw `toolUseResult` to the row of the same uuid, for the main transcript and, with the same function over the subagent transcript, for `child-messages` and `children` (a child view is a session of its own and would otherwise replace on every reopen). The existing assertion that cold history contains no `file_changes` (`native-normalized.local.test.ts`) changes to its opposite; a reopened session now keeps its diffs, which the owner sees as an improvement.
2. **Folded input (D7)** as in the table: one key and one `messageId` in both paths, counting emitted rows only, image content kept, and a recording that asserts the folded row's **position** in the live order against its position in the reread (the history places it after the conversation entry it followed; the live row is emitted at the `started` lifecycle). A recording that shows a different position makes the case a row of Section 5 (`changed` once per folded input) and goes to the notes; the plan does not reorder rows. Counters reset at a compact boundary in the live projector, because the chain a reread sees restarts there.
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
| FL6 | Interrupt notices, slash-command rows, `isMeta` rows: arrive live or not, in the SDK read or not, uuid equal or not. | The two paths are made to agree (both drop or both keep); a notice the live stream lacks is the Section 5 row. |
| FL7 | An interrupted turn: partial assistant text recorded or not; the tool result written for a tool in flight. | D3 and D4; the recording asserts the outcome. |
| FL8 | `turnId` on history rows (`promptTurns`) equals the live `turnId` for the same row. | Not in the digest; a differing `turnId` moves a row across a retention window, so the recording asserts equality, and a difference is fixed in `catalog-worker.ts`. |
| FL9 | A hook (a `UserPromptSubmit` hook in the temporary config's `settings.json` that adds context) writes a user-visible row or an attachment: live and in the SDK read. | Same rule as FL6: both paths drop it or both keep it; if no recording is feasible with the CLI's hook support, the fact is checked on the local instance with a hook in the instance's workspace settings and recorded in Task 13. |

### 4.3 Terminal-driven sessions stay current (owner decision O2; a release gate)

A session that a terminal CLI writes while the Controller holds no runtime leaves the journal behind. Crude mode never shows this, because every open attaches the session and reads native history. This plan keeps that property for the two providers the owner works in, with the smallest addition: the attach that crude mode runs on open, triggered by a directory listing that is newer than the last window.

**Which listing. Verified by reading the code, and re-verified by a counting test (Task 10a, step 0).** The website does **not** list the directory on every session open or return: S4b removed the refetch on visibility, and opening a session reads the session, not the catalog. What exists today:

| Trigger | Where | Cadence | Needs the page |
|---|---|---|---|
| `catalog/revision` check | `SessionDirectory.tsx` (`watchList(inspect, 5_000)`) answered by the Controller's `/remote/catalog/revision`, which reads the provider's directory roots | every 5 s while the directory is mounted and visible | yes |
| the `catalog` page and `catalog/listing` | the same component, on mount and on refresh | on mount | yes |
| the state publisher's catalog confirmation | `session-state-publisher.ts`, `readCatalogs()` every `SESSION_STATE_CONFIRMATION_MS` (about a minute), carrying each summary's `updatedAt` (`catalogSessionStates` in `host.ts`) | about once a minute | no |

**Decision.** The trigger is the Controller's own read of a provider's directory, at the one place `host.ts` receives the summaries with their `updatedAt`, so that all three callers above trigger it and no timer, message or page change is added. A page with the directory mounted sees a terminal's turn within about 5 s of the next check plus the attach; a page without it, within about a minute. Task 10a's step 0 proves this by counting requests over a real transport; if the count shows the page does not poll as read here, the cheapest existing trigger (the minute confirmation) stays the floor and the number in Section 7 is set from the measurement, not changed in the code.

**Mechanism** (D11). `host.ts` keeps one map, `journalWindowAt`: session key to the native `updatedAt` known when its last window was published. After a listing, for each summary of a journal-capable provider (`supportsJournal`) that has an entry, is **unowned** (no native terminal owner), **not held** (no resident manager, no browser attached) and has `updatedAt` newer than the entry, the Controller attaches it through the ordinary attach path; the publication reads native history, its window arrives as `appended` (a turn written at the end) or `replaced` (anything else), the entry takes the listing's `updatedAt` read **before** the attach, and the existing idle release closes the runtime. One attach per session and per `updatedAt`; a failed attach waits for the next change of `updatedAt`; at most the existing attach concurrency runs at once, newest first. A session with no entry (never published by this Controller process) is not attached.

**Limits, stated.** (1) An interactive terminal CLI that stays open owns the session: the Controller cannot attach (`native_session_owned`), so the journal stays as it was at the last window, the page shows the owner and "Take over" (S5), and the session catches up when the terminal exits or is taken over. Reading an owned session read-only is P1-C3 observation, not built. (2) After a Controller restart the map is empty, so a turn a terminal wrote while the Controller was stopped appears at the next open that goes through the Controller, not at the next listing; closing that needs the Relay to tell the Controller which sessions it holds, which is a protocol addition (O5). Both are measured in Task 13 and stated to the owner.

## 5. Expected outcomes of a reopen (what the recordings assert)

Every row is asserted by a recording-based continuity test and a real-transport test; "name" is the test title, so a change of behaviour is a visible change of a test name (S3 Task 3).

| Case | Provider | Expected reopen |
|---|---|---|
| settled turns with text, tool, reasoning; released, restarted, reread twice | both | `unchanged`; a second reread adds nothing; no open item |
| turn run after a reopen (live after reread), then reopened | both | `unchanged` (this is what D6 and the separator fix make true) |
| tool approval, question, elicitation, plan approval | both | `unchanged`; the interaction items are carried, live-only |
| plan update / todo | Codex | `unchanged`; one `todo` item; Claude's `TodoWrite` rows are rebuilt, `unchanged` |
| corrected final message | both | one `replaced`/`changed`, then `unchanged`; the correction item is gone |
| plan-mode turn (the plan item is shown live, O1) | Codex | `unchanged` |
| turn-less error, unsupported notification | Codex | `unchanged`; the live-only error is carried; a repeated identical message is one item |
| thread-less start-up notice (a failing MCP server) | Codex | no item in any journal, no replacement |
| slash command, `isMeta` row, hook-injected row | Claude | `unchanged`: the two paths agree on dropping or keeping the row (FL6, FL9) |
| parallel tool calls | Claude | `unchanged`; order and block indices equal |
| image input, image in a tool result, folded image input | Claude | `unchanged`; no folded image is lost in history |
| compaction | Claude | one `replaced`/`changed`, then `unchanged`; Codex per FC5 |
| failed compaction | both | the item ends `failed`; one `changed` at the next reopen if the loading item is absent from history |
| folded input | Claude | `unchanged` if the recording shows live and history place the row equally; otherwise one `changed` per folded input, named in the notes |
| withdrawn input, interrupt notice absent live | Claude | one `changed` at the next reopen |
| interrupted turn, partial text not recorded | both | one `changed` at the next reopen, then `unchanged`; no item stays open |
| interrupted turn, partial text recorded | both | `unchanged` |
| tool still open in both deliveries | both | `unchanged` (same open content) |
| tool completed while the Controller was away | both | `replaced`/`open_item`, once |
| a terminal wrote a turn and exited while the Controller ran (and the session was not held) | both | after the next listing, the attach of Section 4.3: `appended`, then idle release; the journal-served view shows the turn without a send |
| a terminal wrote a turn while the Controller was stopped | both | at the next open through the Controller: `appended` or `changed`; settles (O5) |
| a terminal still owns the session | both | the journal stays as it was; the page shows the owner; catches up at exit or take-over (limit 1 of Section 4.3) |
| a session grown past the window | both | `appended`, newest items; older history by prepend |

## 6. Tasks

Order: shared helpers, Codex (1 to 5), Claude (6 to 10), terminal-driven currency (10a), the runner, local verification of both, measurements, deletions. Each task ends with Gate G. Keep the pieces of a task in one commit with a State line.

### Task 1: Codex facts and a scripted model (spike before design)

**Files:** `packages/agent-provider-codex/src/test-utils/native-responses-fixture.ts` (a scripted Responses-API server and a temporary `CODEX_HOME` with `config.toml` for a mock provider, `approval_policy` set per scenario; extracted from the eleven `*.local.test.ts` files that each carry a mock Responses server: provider, shared-runtime, session-settings, default-questions, tool-namespaces, read-only, image-input, session-fork, prompt-edit, native-evidence and child-session), `src/journal-facts.local.test.ts` (raw: drives `spawnCodexAppServer`, no adapter change, prints and asserts FC1 to FC9).

**Interface.** `startResponsesFixture(script)` where a script step is a list of Responses events for one model request (text deltas, reasoning summary parts, a function call, a stalled stream that waits for an interrupt, a final item that differs from the deltas). It returns `{ url, home, cwd, requests, close }`. The facts test records, per scenario, the raw notifications and the raw `thread/read` and `thread/turns/list`, and asserts each fact of 4.1.

**State:** none (test code). **Deadline:** the spike is done when every FC has an asserted answer; a fact that cannot be reproduced against a scripted model is listed in Section 8 with how it is verified instead.

**Run:** `BORGEE_CODEX_TEST_EXECUTABLE=$(command -v codex) timeout 900 pnpm --filter @orchardworks/agent-provider-codex exec vitest run src/journal-facts.local.test.ts --testTimeout=60000 --maxWorkers=1`.

### Task 2: Codex identity in the adapter (D2 to D5)

**Files:** `projector.ts` (keys, completion rows, the correction item, the separator delta, `compactionItemTurns`, the end-of-turn finishing of streamed items), `session.ts` (interaction keys `interaction:<itemId>` on `interaction_resolved`; the plan-mode swallowing of `item/plan/delta` and the `plan` item removed, `latestPlan` kept for the approval card; thread-less start-up notices sent to `onDiagnostic`; `error:<fingerprint>` live-only; `todo`; identity on `timeline_replacement` rows), `communication-history.ts`, `images.ts` (identity on their rows), `history.ts` (history rows carry the same keys), `tool-result.ts` only if FC7 requires it, `projector.test.ts`, `session.test.ts`, `history.test.ts`, `docs/current/agent-remote/providers.md` and a short "Item identity" section in the Codex provider doc.

**Interface.** Every timeline observation and every `interaction_resolved` observation carries `itemIdentity` as the SDK's `ProviderObservation` requires, in both deliveries. The declaration is not added in this task.

**State:** adapter fields +1 (`compactionItemTurns`, +0 if FC5 lets the branch go); paths -1 (reasoning error row) +1 (keyed correction); the swallowing branch of plan mode is deleted.

**Tests** (offline, `createScriptedAppServer` and hand-built notifications): every timeline observation of a scripted turn has a key; keys are equal between `projectNotification` and `projectCodexThreadHistory` of the same items; a streamed text equal to the final text gives an empty completing body, an extension the suffix, a non-extension an empty completion plus a complete correction item; a two-part reasoning streamed with `summaryPartAdded` equals the history join; `thread/compacted` is not projected after a `contextCompaction` item of the same turn; `todo`, the turn-less and unsupported-notification errors, and interactions are live-only and nothing else is (an assertion over the whole recording set); a thread-less start-up failure yields no timeline observation; the plan item of a plan-mode turn streams and completes as `assistant:<id>` and equals the history item; an interrupted turn leaves no streamed item open; the five-opens test (D12) opens a scripted session five times and counts zero new items.

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
12. `errors`: a model failure that fails a turn (`turn-error`, both paths), and a failing MCP server in the temporary `config.toml` (no timeline item in any thread; FC8).

**Tests** (Controller, offline, from the recordings): the rows of Section 5 for Codex, each asserted outcome in the test name; the five-opens test (zero new items after five opens of each recording); every row has an identity and none starts with `controller:`.

**State:** none (test code and fixtures). **Run:** `-controller` for the two continuity files; the recording test under `timeout 900`.

### Task 4: Codex real transport through `createHostJournals`

**Files:** `packages/agent-host/src/journal-window.codex.journal.test.ts` (the S3 harness: `relayLoopback`, the real publisher, the real core, the real store, a scripted Codex session built from the recordings, a virtual clock).

**Tests:**
1. Open, publish `settled`, drop the connection, reopen from the reread: no item write, epoch unchanged, one `journal_window` of `unchanged`.
2. Runtime release (manager closed, new manager from history) five times: epoch unchanged.
3. Controller restart (new publisher id, same Relay journal): epoch unchanged.
4. `after-reopen`: a turn after a reopen, then a reopen: `unchanged`.
5. `correction`: one replacement, `changed`, a second open `unchanged`; the journal holds the base once and no correction item. `plan-mode`: `unchanged` at the first reopen, with the plan item once.
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

**Files:** `folded-input.ts` (widened to one transcript pass that restores folded input and attaches `toolUseResult` to the tool-result row of the same uuid), `catalog-worker.ts` (the two callers), `session.ts` history constructor (the row carries the raw result to the projector), `child-session.ts` (the child's history uses the same pass), `native-normalized.local.test.ts` (the assertion flips), `folded-input.test.ts`, `projector.test.ts`.

**Tests:** a transcript fixture with Write, Edit and Bash rows: the history projection equals the live projection for each tool row (same JSON part, same `file_changes`); a row without a raw result projects as today; the pass reads the file once. **Also:** the same pass runs over a subagent transcript (`child-messages`, `children` in `catalog-worker.ts`), so a child view's tool rows equal their live rows; and a folded input whose attachment carries image blocks keeps them in history (today a non-string `prompt` is dropped).

**State:** fields 0; paths 0 (one pass instead of two later). **Run:** Claude suite plus the native normalized test.

### Task 8: Claude identity in the adapter (D2, D3, D4, D7)

**Files:** `projector.ts` (identity on every `item()`, the completion rows, the correction item, `pendingCompaction`, `foldedCounts`, the reset at a boundary), `session.ts` (`noteCommandLifecycle` and `withdrawSteered` give the folded and withdrawn rows their keys; end-of-turn finishing of open blocks and an open compaction; identity on `interaction_resolved`), `interactions.ts` (the live-only mark and the key on resolution, including `cancelAll`), `child-session.ts` (identity passes through the shared projector; its replacement rows are keyed), tests `projector-identity.test.ts`, `session.test.ts`, `interactions.test.ts`, `docs/current/agent-remote/claude-normalized-events.md`.

**Tests** (offline, hand-built frames as `projector.test.ts` has them): every timeline observation has a key; keys equal between a stream and the same records read as history; a streamed block followed by its complete record completes with an empty body; a non-extending final gives the correction item; a folded input and its `queued_command` attachment get the same key **and the same `messageId`**, a second identical input `n` 1, and a skipped or withdrawn row does not advance `n`; a slash-command, `isMeta` or hook row is dropped or kept in both paths alike; a status row then a boundary is one item and a status row at turn end is `failed`; a permission prompt, `AskUserQuestion` and plan approval are live-only and nothing else is except a reasoning the facts say is lost; a child session's rows have keys; the five-opens test (D12) on the recordings.

**State:** adapter fields +2; paths -1 +1. **Run:** Claude suite, Gate G.

### Task 9: Claude recordings (D8)

**Files:** `packages/agent-provider-claude/src/journal-recording.local.test.ts` and `src/journal-fixtures/*.json`; `recordings.ts` gains `claude`. The tests import `../dist/provider.js` as the other native tests do.

**Recordings** (`ContinuityRun`s as in Task 3): `settled` (text, Write, Edit, Bash, a second turn); `thinking`; `approval` (a permission prompt and an `AskUserQuestion`; plan approval in a plan-mode run); `todos` (`TodoWrite`); `compaction` (`/compact` through `executeCommand` against the scripted model, then a turn); `failed-compaction`; `interrupted` (cancel while text streams, and during a tool); `steer` (input folded into a running turn; input queued and run next; input withdrawn by `interrupt` with `cancelQueued`); `correction`; `subagent` (a scripted `Task` call served by the same fake API); `restart` (a new process reads the transcript); `after-reopen`; `slash-command` (a custom command in the temporary config's `commands/`, a built-in that prints `<local-command-stdout>`, FL6); `parallel-tools` (two `tool_use` blocks in one message, results in one record and in two; order and block indices); `images` (a user image, an image returned by a tool, a folded input with an image); `hook` (a `UserPromptSubmit` hook in the temporary `settings.json`, FL9, if the CLI runs it against the scripted model).

**Tests:** the rows of Section 5 for Claude; every row has an identity; none starts with `controller:`; the five-opens test; the folded row's position in the live order equals its position in the reread, or the recording names the difference; a sub-agent run's sidechain is absent and its parent tool row has equal keys.

**State:** none. **Run:** `-controller` continuity tests; the recording test under `timeout 900`.

### Task 10: Claude real transport, then the declaration

**Files:** `packages/agent-host/src/journal-window.claude.journal.test.ts`, `packages/agent-provider-claude/src/provider.ts` (`journal: { itemIdentity: 1 }`, last), docs.

**Tests:** the ten of Task 4 for Claude, with these differences: test 5 is the corrected final and the compaction (`changed` once, then `unchanged`, and the epoch changes only at the replacement); test 6 adds `steer` (folded input `unchanged`; withdrawn input one `changed`); test 7 adds an interrupt with the notice absent live; test 8 serves older history from the manager's whole timeline (Claude reads the whole transcript at open and has no `readTimelineHistory`), so a prepend answers from memory.

**State:** none; the publisher count stays 19. **Run:** Claude and Controller suites, `pnpm compatibility:update` then `compatibility:check`, Gate G.

### Task 10a: Terminal-driven sessions stay current (D11, O2; a release gate)

**Step 0: verify the trigger.** A lab test over a real transport (the hosted Relay, the Controller host runtime, the page's directory component with fake sockets) counts the requests that reach the Controller when a session is opened, when the page is hidden and returned, and while the directory is mounted for 30 s. The expected result, from the code read in Section 4.3: the open and the return issue no directory request, the mounted directory issues one `catalog/revision` per 5 s, and the Controller's state publisher reads the catalogs once per confirmation. The test's result is written into this plan; if it differs, Section 4.3's table and the Section 7 lag numbers are corrected and the cheapest existing trigger is named before the code is written.

**Files:** `packages/agent-host/src/host.ts` (the map `journalWindowAt` and the check at the point where listing summaries are consumed; the attach goes through the same `attach` binding the HTTP `/remote/attach` uses, then the existing idle release), `packages/agent-host/src/session-state-publisher.ts` only if the minute confirmation reads through a path that bypasses that point (then it calls the same function), `host-journal.test.ts` and a new `journal-terminal-refresh.journal.test.ts`, `docs/current/agent-remote/relay.md` (one paragraph).

**Interface.** No message, no flag, no diagnostic. The condition: provider `supportsJournal`; entry present in `journalWindowAt`; no native owner; no resident manager and no browser attached; listing `updatedAt` greater than the entry. Effects: attach once; the entry takes the listing's `updatedAt` read before the attach; failure retries only after the next change of `updatedAt`; concurrency is the existing attach limit, newest first.

**State:** `host.ts` +1 map; publisher fields 19 (grep in the notes); recovery outcomes 4; protocol surface 0.

**Acceptance tests over a real transport** (hosted Relay, real Controller host runtime, real publisher and store; the provider is scripted but writes native history outside any session, as a terminal would, and its directory reports the newer `updatedAt`):
1. A turn written by an external writer to a session that has a journal appears in a journal-served view **without a send**, after the next listing; the Relay diagnostic is one `journal_window` of `appended`, and the runtime is released after idle.
2. Not newer: no attach. The same `updatedAt` listed again: no second attach (no loop).
3. Owned by a terminal (native owner present): no attach, the view shows the owner; after the owner exits and the next listing, the attach happens.
4. Held (resident manager or an attached browser): no attach.
5. A provider without the capability (OpenCode): untouched. A session with no entry: untouched.
6. A failed attach does not retry at the next listing of the same `updatedAt`, and retries when `updatedAt` changes.
7. **Raw terminal CLI, real binaries, scripted model, temporary homes** (`*.local.test.ts`, one per provider): the adapter's session is published, released; `claude --resume <id> -p ...` / `codex exec resume <id> ...` runs a turn against the same scripted server and exits; the Controller's next real directory listing (read from the temporary home, so `updatedAt` is native) triggers the attach and the journal-served view shows the turn.
8. The Controller restart case (O5): after a restart the map is empty and a terminal turn written while it was down is shown at the next open through the Controller; the test asserts exactly that, so the limit is a named behaviour.

**Local check** (Task 12 runs it): on the instance's workspace, in a session already journal-served, run a turn from a terminal (the instance's own CLI wrapper, or raw `claude --resume <id> -p` / `codex exec resume <id>` with the instance's cwd), let it exit, then open the session or return to the page and read the new turn without sending; record the lag from the turn's end to its appearance with the directory mounted and with it unmounted. Repeat with an interactive terminal left open (owned): record that the page shows the owner and the stale journal, and that take-over catches it up (limit 1).

**Run:** `-controller` for the new test and `host-journal.test.ts`, the two native suites, Gate G.

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
- [ ] **A terminal-written turn appears without a send (Task 10a's local check, a release gate).**
- [ ] **Take-over.** Hold the session in a native CLI inside a detached pty (`tmux new -d`, `claude --resume <id>` or `codex resume <id>`, left idle), reload the page: it offers "Take over" with the owner; take over; the next send works and the next open is journal-served. Record the `journal_window` reason after the terminal wrote a turn. If a pty cannot be made, record that the case was not exercised.
- [ ] **Reconnect after a Controller restart** with the page open: `pnpm local up --no-build`; the page keeps its rows, no frame without rows, the reason is `unchanged`.
- [ ] **An interruption.** `session cancel` during a streaming turn and during a tool, then release and reopen: no item stays open, the reason is as Section 5 says, a second open is `unchanged`.
- [ ] **Compaction (Claude).** A small session and `/compact` through `executeCommand` (cheap: the session is a few turns). Record the reason of the next open (expected one `changed`) and the open after it (`unchanged`). If it cannot be triggered cheaply, say so; the recording covers it.
- [ ] **Codex: release every Codex session this task created** (`agent-remote-controller-dev session release <address>`), and confirm they are unloaded.
- [ ] Run the two runner scenarios for the provider and save the JSON under `.tmp/` (not committed).

### Task 13: Record the measurements and decide

A section "S6a measurements" is appended to this plan, one table per provider, with the build info the runner prints and the date. Recorded: replacements per open by reason (and, for every `changed`, the item type and the case of Section 5 that explains it), bytes per open (Controller to Relay, Relay to browser), first-open misses, open and interrupted-item replacements, open time p50 and p95 against S3's Copilot figures at throttle 1 and 4, holes, fills and older requests per open, quota refusals, the terminal lag of Task 10a (a turn written by an exited terminal: time to appearance with the directory mounted and unmounted; an open terminal: the stale journal and take-over), the live-only bytes of the longest real session, and the facts the local instance settled (FL9 hooks if no recording was feasible). The roadmap Progress rows for S6a and S6 are updated. A triggered item (Section 7) becomes a task of S6b or goes to the owner; it is never added to this plan.

### Task 14: Deletions

What this work makes unnecessary:

- [ ] `packages/agent-host/src/test-utils/copilot-recordings.ts`, `journal-continuity.copilot.test.ts` and the Copilot-only parts of `journal-window.copilot.journal.test.ts` that the table-driven versions cover (verify by running them first).
- [ ] The runner's `copilotSessions()` and its Copilot-only wording in the scenario descriptions.
- [ ] Codex: the reasoning error row "Codex final text corrected streamed item" in `projectCompletedTextItem`, and the `completed-suffix` and `completed-correction:<fnv>` source-key branches that only the old identity-less merge needed (verify by `git grep`; a source key the timeline store still dedupes on stays).
- [ ] Claude: the append-the-whole-final-text branch of `projector.ts` (the correction item replaces it) and the second transcript read for folded input (merged into Task 7's single pass).
- [ ] The mock Responses servers duplicated in the eleven Codex `*.local.test.ts` files (listed in Task 1), moved onto Task 1's fixture where it takes one line each; any that needs more stays and is listed.
- [ ] `liveOnlyKeyViolations` in `packages/agent-provider-sdk/src/item-identity.ts`, its export, and its callers in the Copilot and Controller tests; the SDK comment beside `liveOnly` and the S4a sentence that cited the old rule state the invariant instead (D12). `git grep liveOnlyKeyViolations -- packages docs` prints nothing.
- [ ] Codex: the plan-mode swallowing of `item/plan/delta` and the `plan` item in `session.ts`; the start-up notice error rows in `projector.ts` (`runtime:` source keys); the `thread/compacted` branch and `compactionItemTurns` if FC5 shows that `contextCompaction` always arrives.
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
| Terminal-written turn | A turn written by a terminal that has exited is not visible in a journal-served view within one directory check plus one attach after the listing (about 10 s with the directory mounted, about 90 s without; the numbers are set from Task 10a step 0's count) with no send. |
| Journal serving | A sample where the page's epoch is not the epoch in `journals.sqlite` does not count as journal-served; fewer than 30 counted opens per provider repeats the run. |

| Deferred item | Triggered when |
|---|---|
| I2: in-place update of an open item | `open_item` replacements exceed 5 percent of the opens, or any settled reopen gives `open_item` (a defect first) |
| M3: history holes | any hole (above); a hole is a defect and its cause is fixed |
| M6: an incomplete journal while the window waits | a journal stays `incomplete` more than 2 seconds at p95, or a first-open miss happens on a session of fewer than 200 items |
| Drop the oldest instead of evicting bodies | fills exceed 1 per open at p50, or any `journal_quota_exceeded` or refused window at default limits. Claude sessions are the largest the owner has: record the window size and the oldest item reachable by scrolling. |
| Live-only bytes | Recorded per provider for the longest real session; a live-only total above a fifth of the Host's journal room is read as a trigger to cap approvals, not ignored. |
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
- **A terminal driving the session.** The native CLI's lock and pid records cannot be set up by an adapter test without a pty. Task 12 does it with a detached `tmux` session; if that fails it is reported as not exercised and the release gate of Task 10a is not met.
- **An interactive terminal CLI that stays open** needs a pty; Task 12 uses a detached `tmux`. A terminal that runs one turn and exits (`claude -p`, `codex exec`) is recorded (Task 10a test 7).
- **A killed Controller or CLI process** is never used: interruptions are `cancel` and `release` (S3, the skill).
- **Versions.** Fixtures record what 2.1.319 and 0.169.0 do; a change of CLI shows as a changed test name and shape (S3 Task 3). The native test runner already pins minimum versions (`scripts/native-test-versions.test.mjs`).

## 9. Risks and what is not in S6a

- **Tool results (Claude).** The largest content gap is the one that would make the journal replace on nearly every reopen. D6 removes it at the source; if FL2 is false the plan stops (O3). Task 7's test is the first thing to run in the Claude half.
- **Reasoning separators (Codex).** Same shape: every reasoning turn of a reasoning model. The separator rule is asserted by FC6 on the real CLI and by Task 12 on a real model.
- **A terminal drives the session.** Handled by Task 10a for a terminal that exits (owner decision O2); the open limits are Section 4.3's: a terminal that stays open, and a Controller restart. The remaining P1-C3 pieces (read-only observation of an owned session, a Relay-told set of journaled sessions) stay in S6b.
- **Open-time emissions.** Anything the adapter emits when a session opens is an open-time snapshot (the S3 lesson: no snapshots without a native position). The audit for both adapters: every observation emitted between `observe()` and the first live notification is either from history or has a kind key. The recordings assert it by opening the same session five times and counting new items (zero).
- **Occurrence keys and live-only bytes.** The SDK rule is now "a live-only item is never emitted at open; occurrence keys are allowed" (D12), checked by the five-opens test; Copilot's per-`reasoningId` reasoning and every interaction already obey it. A live-only item is carried through every replacement and is never trimmed except by the journal's cap, so a long session of approvals and reasoning keeps those bytes pinned. Task 13 records the live-only bytes of the longest real session of each provider.
- **A terminal that stays open.** Section 4.3 limit 1: an owned session is not refreshed. This is the case the owner works in most; the page shows the owner and "Take over", and Task 13 measures the lag honestly rather than assuming it away.
- **Window and history size.** Claude reads the whole transcript at each open (its existing cost) and serves the newest window; the manager's whole timeline answers older requests. Task 13 records the window of the longest real Claude session.
- **Codex release timing.** A released Codex session unloads after a delay; the runner's `--release-wait` and Task 12's explicit release handle it.
- **Production.** The declaration only makes the Controller ask for `journal=1`; a Relay serves nothing without `AGENT_REMOTE_JOURNALS=1` and the Host's switch. No Controller update is required by this plan, so the roadmap's "tell the owner when every Controller must update" does not trigger.
- **Not in S6a:** OpenCode (needs the read-only history capability, S6b), behind-marking and observation, backfill, the removal of S4a's Controller-answered leftovers, in-place update of open items, a different eviction rule, any protocol change.

## 10. Open questions (owner) and decisions made

**Decided by the owner.**

- **O1.** Codex plan-mode items are shown live too, so live and history agree and the plan item causes no replacement (Section 4.1, fix 3).
- **O2.** Terminal-driven sessions must stay current, as a release gate inside S6a: a directory listing attaches a journaled, unowned, unheld, newer session, with the one map in `host.ts` (Section 4.3, Task 10a). S6b is not needed for this.

**Open for the owner, each only if its condition shows in a recording.**

- **O3 (only if FL2 is false).** If the raw transcript row of a tool result does not carry what the live row carries, a reopened Claude session shows a tool without its diff, as it does today after any reopen, and the journal would replace on every turn. The choice is then between dropping the diff from the journaled row (consistent, the live page loses diffs in journal mode) and not shipping Claude. The plan stops and asks.
- **O4 (only if FC7 needs a lossy fix).** A Codex tool item that differs between live and `thread/read` in a field that carries command output or a diff: dropping it loses data in one path, keeping it replaces on every reopen. The plan stops and asks; metadata fields are dropped without asking.
- **O5 (a limit, stated; the owner may ask for more).** After a Controller restart, a turn a terminal wrote while the Controller was stopped shows at the next open through the Controller, not at the next listing, because the Controller does not know which sessions the Relay holds. Closing it needs a Relay message that lists journaled sessions (a protocol addition). Also: an interactive terminal that stays open owns its session and cannot be refreshed (Section 4.3 limit 1).

**Decided here** (technical):

- Codex first, one plan, one gate for both providers (D1).
- Compaction in Claude is one replacement, not a key that spans the chain rewrite (4.2 fix 4); `includeSystemMessages` is not added.
- Interrupted streamed items are plain, not live-only (D3); a withdrawn Claude input is plain.
- Approvals and questions of both providers are live-only with occurrence keys; Codex keys them by native item id; Copilot's rule that `permission.*` is on disk does not carry over (FC2, FL4 verify it).
- Codex errors that history lacks are live-only keyed by a fingerprint of the message; thread-less start-up notices never become timeline items.
- Tool results are made equal at the source (D6), for child views too, rather than counted; the diff persists after a reopen as a side effect.
- The live-only rule is the invariant "never emitted at open" (D12); `liveOnlyKeyViolations` is deleted.
- The listing trigger rides existing reads (page revision check, minute confirmation); no timer is added (D11).
- Runner proof of journal serving is the epoch of S4 (`negotiated` echoes `itemKeys`; the page's epoch equals `journals.sqlite` `meta`), not the old attach-timing signal that S3 found unreliable.

## 11. Facts recorded by the recordings (Codex 0.169.0, Claude Code 2.1.319)

**Codex (`src/journal-facts.local.test.ts`, Task 1).**

- FC1 holds: ids of user, reasoning, assistant, file change, command, plan and compaction items are equal in notifications and in `thread/turns/list`. FC7 holds for commands and file changes: both paths project the same tool item.
- FC2 holds: an approval and a question are in no history; both requests name their native item (`itemId` `c1` and `q1`), so `interaction:<itemId>` is available.
- FC3: an interrupted turn keeps only its user message. The streamed text and reasoning are not in history, and an interrupted command is never completed live and is not in history either, so its live row stays `running` until a replacement drops it (one `open_item`, then settled). The plan does not invent a native result for it.
- FC4: the plan item id is equal in both paths, but history orders it before the message it was cut from (completion order), while the live stream saw the message first. The adapter's history projection orders a turn's items by `startedAtMs`, which is the order the live stream sees (Task 2).
- FC5: a compaction is a turn of its own whose `contextCompaction` item has equal ids; history keeps every earlier item. The generated app-server schema documents `thread/compacted` as deprecated in favor of the item, and 0.169 never sent it, so its branch is deleted, not kept (no `compactionItemTurns`).
- FC6 holds: `summaryPartAdded` carries `summaryIndex`; history joins `summary[]`.
- FC8 differs from the plan: the start-up notices of a failing MCP server carry the thread id in 0.169. They are in no history, so they still cost a replacement; the decision of the plan (not a timeline item) stands. Also new: `thread/readState/changed` arrives after every turn and the projector turns it into an "Unsupported Codex notification" error row today; it joins `NON_TIMELINE_NOTIFICATION_METHODS`.
- FC9 holds: a steered message has its own item id, equal in both.
- `turn/plan/updated` (needs `[tools.update_plan] enabled = true`) arrives live and history holds no trace of it.

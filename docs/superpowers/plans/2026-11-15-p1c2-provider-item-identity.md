> **Superseded by [S3: the first journal provider](2026-11-16-s3-first-journal-provider.md).** Kept for its findings and its "Research for the relaxed contract"; its tasks are replaced.

# P1-C2 Provider item identity Implementation Plan

This document is kept for its research only. The goal, the contract, the tasks and the risks it once held were replaced by the relaxed item-identity contract (roadmap S2) and by [S3](2026-11-16-s3-first-journal-provider.md); the remaining providers return in S6 as reduced tasks.

## Findings the tasks start from

Positions are the line numbers of the read; they may have moved.

### OpenCode (`packages/agent-provider-opencode/src`)

- One normalizer serves both paths: `normalize()` (`normalize.ts:90-153`) over `message.list` pages. Live deltas patch the in-memory part (`session.ts:167-176`) and `reconcileTimeline` (`timeline.ts:7`) stamps `delivery: 'live'` with suffixed keys (`<key>:text:<len>:<fingerprint>` at `timeline.ts:31`, `<key>:state:<fingerprint>` at `timeline.ts:33`). Every other event schedules a refresh that reads the latest page again (`session.ts:198`).
- Keys already exist and are stable: `message:<id>` (user, shell, compaction), `part:<msgId>:<ordinal>` (text and reasoning, by content ordinal, because v2 text parts have no id), `part:<msgId>:tool:<partId>`, `<toolKey>:request` and `:reply` (sub-agent communication), `error:<msgId>`, `<key>:attachment:<i>`. The identity key is the base key with the delta suffix removed.
- Completion: assistant message `info.time.completed`; tool `state.status` of `completed` or `error`; text parts have no end of their own, so they complete with their message; user message on presence; shell when `info.status` is not `running`; compaction on its status.
- Live-only: interaction records (`interaction:<id>:request`, `:resolved`, `:receipt`), unsupported-form errors (`form:<id>:unsupported`), receipts, the supplemental map (`timeline.ts:39`, lost on reopen).
- OpenCode emits no todo items (`todoItem` has no callers). A compaction can change type under one key (loading, completed, failed); the merge must let the later row replace the earlier.
- Rewrites: revert and reorder remove or move messages; `reconcileTimeline` already turns them into `timeline_replacement`. A prompt-edit fork is a new native session.
- Window: the latest page (200 messages); older pages through `readTimelineHistory` (`session.ts:498`).
- Fixtures to build on: the in-process fake server of `provider.test.ts:22-120` (`/message` serves the reversed list with offset cursors), `normalize.test.ts`, `timeline.test.ts`.
- Risk: `turnId` depends on `startsAtBeginning` (`v2-native.ts:25`), so a partial page has none until the older boundary is loaded. `turnId` is not in the digest, but it is on the journal item (page grouping and retention by turns); the first turn of a partial page must not change its `turnId` between the live run and a reread, or retention windows move.

### Codex (`packages/agent-provider-codex/src`)

- One projector, `CodexEventProjector` (`projector.ts`): live `projectNotification` (l.99), `projectTextDelta` (l.200), `projectItemLifecycle` (l.224), `projectCompletedTextItem` (l.266); history `projectHistoryItem` (l.186) and `projectTurnFailure` (l.327), driven by `projectCodexThreadHistory` (`history.ts:8-37`) from `thread/turns/list` pages of 10 turns (`codex-daemon-client/src/history-page.ts:7`). `finishBootstrap` (`session.ts:1268`) reconciles buffered live events with history by source key.
- Today's keys differ: live deltas `item:<id>:assistant:delta:<uuid>` (random), live completion `item:<id>:completed-suffix`, history `item:<id>:completed`, user message live `item:<id>:user` against history `completed`. The native `item.id` is the same string in `item/completed`, the delta params (`params.itemId`) and `thread/turns/list`.
- Keys (type-prefixed, because reasoning and assistant ids are separate namespaces): `user:<id>`, `assistant:<id>`, `reasoning:<id>`, `tool:<id>` (equal to `callId` for command, file change, MCP, dynamic, web search, collaboration and sub-agent items), `comm:<id>`, `compaction:<id>` of the `contextCompaction` item (else `compaction:<turnId>`), `turn-error:<turnId>` for turn failures (both paths already share the turn key), `todo:<turnId>`.
- Completion: `item/completed`. A text item whose streamed text equals the final text emits nothing at completion (`projector.ts:283-285,310`); the adapter emits an empty body of the same type with `completes` there. `userMessage` is emitted at `item/started` or `item/completed`, whichever first.
- Live-only: interactions (`interaction:<requestId>`), todo plan updates (`turn/plan/updated`, no history projection), turn-less errors (`error:<turn|thread>:<message>`), hook and MCP-startup failures, the `compaction` loading state, `thread/compacted` rows, and the correction rows below.
- Content differences to align: (1) multi-part reasoning: history joins `summary[]` with `\n\n` (`readReasoningText`, l.542-548), live concatenates deltas with no separator and drops `summaryPartAdded` (l.46); (2) reasoning with only `content[]` gets no live deltas because `reasoning/textDelta` is dropped; (3) a final text that does not start with the streamed text emits a correction row under a new message id (`${id}:correction:<fnv>`, l.289-298) plus an error row, which a reread never reproduces: both are live-only; the correction replaces the base (see Corrections that exist only live): the reread corrects `assistant:<id>` in place and the correction item does not remain beside it; (4) `commandExecution/outputDelta` is dropped, so a started row can lack output until `item/completed`, which carries it; (5) image labels depend on `CodexImageRegistry` state.
- Window: the latest 10 turns; older ones through `readTimelineHistory` (`session.ts:373`). A reread is not a rewrite: recovery `finishBootstrap(replacement=true)` re-reads, and `thread/rollback` is not called anywhere; a prompt-edit fork is a new session.
- Fixtures to build on: `createScriptedAppServer` (`test-utils/scripted-app-server.ts`), `session.test.ts:156-270` (history and buffered deltas on the same item ids), `history-pagination.test.ts`, `collaboration-items.test.ts:80-89`, `projector.test.ts:105,149`.

### Copilot (`packages/agent-provider-copilot/src`)

- One projector (`projector.ts:48 projectAll`, `:79 project`) for both paths; `session.ts:51-115` buffers live events, reads `getEvents()`, emits history, one boundary, then the buffered live events; `session.ts:167` builds `sourceKey = copilot:<sessionId>:<projector key>`; `emit()` (`session.ts:146`) gives non-native events a random `copilot:local:<uuid>` key.
- Keys: user `event.id`; assistant `message:<messageId>` (already the same for deltas, the final suffix and history); tool `tool:<toolCallId>`; reasoning needs the native `reasoningId` of `assistant.reasoning_delta` and `assistant.reasoning`, which the projector ignores today; compaction start and complete carry different event ids with no shared id, so the key is `compaction:<start event id>`, and the completion takes the pending start; error `event.id`; interaction `interaction:<requestId>`; todo `todo:plan`.
- Completion: `assistant.message` (`projector.ts:101`) and `assistant.reasoning` (l.119) may return nothing when the content equals the streamed text, so the adapter emits an empty body with `completes`; `tool.execution_complete` (l.155); `*.completed` for interactions; `session.compaction_complete`; user and error complete at emit.
- Live-only: reasoning (the native journal can omit it, `docs/current/agent-remote/copilot-normalized-events.md:36`), todo snapshots (no native event identity, not rebuilt), the correction message `message:<id>:correction` that history does not split (l.109), pending interactions and the live-resolved details of approvals (history falls back to scope `once`).
- Interaction detail: live emits `interaction_requested` and `interaction_resolved` as events (`interactions.ts:109/123`), which the agent manager turns into a timeline item at resolution; history emits a timeline `interaction` item `interaction:<requestId>` (`projector.ts:61`). With the same key on the resolved observation, the live item and the history item are one item whose content can differ (scope), which is a correction, not a rewrite.
- Content differences: reasoning absent in history; live deltas plus final suffix equal the content only when the final text starts with the streamed text; tool results are bounded identically in both paths (`boundToolResult`), so they match; image resources match when binary asset ids match.
- Fixtures to build on: `tests/native.test.ts:12-37` (live session then `resumeSession`, rows compared with `toEqual`), `tests/native-fixture.ts` (fake model server on a free port), `src/projector.test.ts:67-85`, `src/provider.test.ts`.

### Claude (`packages/agent-provider-claude/src`)

- `ClaudeEventProjector` (`projector.ts:24`) serves both paths with `delivery` set at construction; `stream()` (l.128) and `delta()` (l.151) emit live text; history is projected in the `ClaudeAgentSession` constructor (`session.ts:146-149`) from `catalog.timelineMessages` (`provider.ts:152`, a worker running the SDK's `getSessionMessages`).
- Today's keys: assistant and reasoning `message:<record uuid>:<blockIndex>` in history, `stream:<message.id>:<index>:<cumulative length>` live; the complete assistant record that follows a stream usually emits nothing (`suffix` empty, l.111-112). `messageId` on the item is `${message.id}:${index}` in both paths.
- Keys: `user:<uuid>`, `assistant:<message.id>:<blockIndex>`, `reasoning:<message.id>:<blockIndex>` (the stream `index` equals the history block position because tool-use and redacted blocks take a slot, l.101-107), `tool:<tool_use_id>` (running and completed rows share it, and the merge replaces the item), `todo:<tool_use_id>`, compaction the boundary record uuid.
- Completion: the complete assistant record (even with an empty suffix, so the adapter emits an empty body with `completes`), the `tool_result` user record, the boundary record.
- Live-only: the compaction `loading` row (its own uuid, probably not in the transcript, so a live item with a second key); input steered while a turn runs and withdrawn input.
- Content differences, the hardest of the four: (1) live tool items carry `tool_use_result` as a JSON content part and as `file_changes` (`projector.ts:76,81-84`) while the SDK's public history omits it (`native-normalized.local.test.ts:38-41` asserts it), so every Edit, Write and Bash result differs; the raw transcript rows do carry `toolUseResult` and `sourceToolAssistantUUID` (confirmed on this machine), so history for journal purposes attaches the `tool_use_result` of the raw row with the same uuid; (2) a final text that does not start with the streamed text is appended again (l.111); the correction is live-only and replaces the base item (the reread corrects it in place and no correction item remains beside it); (3) a native record with empty or redacted thinking gives no history reasoning item while live has delta text (unverified for the current Claude version: probe).
- Steered input: live uses the Controller's steer uuid (`session.ts:316`); history restores folded input from the `queued_command` attachment, whose uuid differs (`folded-input.ts:37-52`). Key folded and steered input by content: `folded:<first 16 hex of sha256(text)>:<n>` where `n` counts items of equal text in the session, in order, in both paths. Withdrawn input never reaches the transcript and is live-only.
- Fixtures to build on: the real-CLI fixture `test-utils/native-fixture.ts` (`nativeFixture`, `nativeReply`: a fake Anthropic API driving the real `claude` binary and a real transcript), `native-normalized.local.test.ts:9-42` (live, release, cold resume with history), hand-built frames in `projector.test.ts:15-26,53-60` and `session.test.ts:99,127`.

## Research for the relaxed contract (2026-11-16)

The P1-C2 plan rewrite paused when the owner approved "replace when in doubt" (roadmap S2). Under the relaxed contract an adapter must provide stable item keys, completion marks and live-only marks. Content no longer has to be byte-identical between the live run and the reread. The findings below were verified against real runtimes or scripted servers. They feed the S3 plan.

**Copilot**
- Keys:
  - user `user:<event.id>`;
  - assistant `assistant:<messageId>`;
  - tool `tool:<toolCallId>`;
  - interaction `interaction:<requestId>`, the same key live and from history;
  - compaction `compaction:<start event id>`.
- Missing completion: assistant text equal to what was streamed produces no row. Add an empty-body completion row. Reasoning is the same.
- Live-only: reasoning (`reasoningId`, absent from history), todo, and the adapter's own diagnostics.

**Claude**
- Keys:
  - assistant text `assistant:<message.id>:<block index>`, and reasoning likewise;
  - tool `tool:<tool_use_id>`;
  - todo `todo:<tool_use_id>`;
  - plain user messages `user:<uuid>`.
- Missing completion: a full record that follows streamed text produces no row. Add an empty body. The `tool_use` row does not complete the item; the `tool_result` row does.
- Live-only: compaction loading and boundary rows, approvals and questions, and the synthetic output of local commands (`model: '<synthetic>'`).

**OpenCode**
- Keys: the existing source-key bases are stable native ids:
  - user, shell and compaction `message:<id>`;
  - text and reasoning `part:<message>:<index>`;
  - tool `part:<message>:tool:<partId>`.
- Missing completion: text that ends with its message without a content change produces no row. Add an empty body. Compaction and tools already change state.
- Live-only: interaction receipts and unsupported-form errors.

**Codex**
- Keys: `item.id` is the same live and in history. It is prefixed by type: `user:`, `assistant:` (plan included), `reasoning:`, `tool:`, `comm:`, `compaction:`, `image:`, and `turn-error:<turnId>`.
- Missing completion: text equal to the streamed content produces no row. Add an empty body.
- Live-only:
  - interactions;
  - the todo from `turn/plan/updated`;
  - errors without a turn;
  - `thread/compacted`;
  - unsupported or invalid notifications.

**Gaps that are about keys.** These have no common native id, so the relaxed contract does not remove them:
- Claude: input folded into a running turn has a steer uuid live and an attachment uuid in the transcript. The `[Request interrupted…]` and `local-command-stdout` notices also differ in uuid. A key from a text hash plus an ordinal is the workable option.
- Claude: a compaction leaves the SDK history with only the compacted chain. That is a real rewrite and is handled by a replacement.
- Codex: plan mode hides the plan item live, but history returns it. Showing it live as well changes behaviour and needs the owner's confirmation.
- Correction items (Codex, Copilot and Claude) do not exist in history, so they have no key. Under S2 such an item simply disappears at the next replacement.

**Gaps that are only about content.** The relaxed contract no longer requires closing these:
- Claude: a tool result's `tool_use_result` is missing from the SDK history.
- Claude: wrapper text of slash commands, and the `messageId` of folded input.
- Codex: multi-part reasoning lacks `\n\n` separators.
- Codex: field differences between `item/completed` and history items.
- Copilot: an approval's scope falls back to `once` in history.

**Risks**
- Claude: a reread after `/compact` triggers a replacement.
- OpenCode: no test covers a change of compaction type, or a `turnId` change on a partial page.

The paused worker's verified probes were left in `/tmp/c2probe` (a copy of HEAD).


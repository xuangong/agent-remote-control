# P1-C2 Provider item identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**This plan is a task-level outline, not a step-level plan.** It names the files, the interfaces, the key of every item type, the completion and live-only rules, the content alignments and the tests of each provider, from a read of the four adapters (the findings below). It does not give code for the adapters: each task must start from a recorded probe of the native runtime, because the digests of a live item and the same item read again have to be equal byte for byte, and only a recording shows that. Expand each task into steps when its turn comes, from the landed state of P1-C1.

**Goal:** Each provider adapter gives every timeline observation a native item identity, marks completion and live-only items, proves with continuity fixtures that a live run and a reread of the same native session agree, and only then declares `journal: { itemIdentity: 1 }`. Until a provider declares it, its sessions stay on forwarding.

**Architecture:** The contract is the SDK's `ProviderItemIdentity` (`key`, `completes`, `liveOnly`) of P1-C1, and the proof is `expectContinuity` of `packages/agent-host/src/test-utils/journal-continuity.ts`, which runs the Controller's own item grouping, merging, digest and `planPublication`. The publisher computes digests (P1-C1 Decision 1), so an adapter owns only keys, completion marks, live-only marks, and the alignment of the content of its live rows with the content of its history rows. One provider per task, each independently shippable: the capability is declared in the last step of the task.

**Tech Stack:** TypeScript, Vitest 4.1.11, the provider packages (`packages/agent-provider-{opencode,codex,copilot,claude}`), `packages/agent-host` for the fixtures.

**Preconditions:** P1-C1 landed completely, including its documents. Read `2026-11-15-p1c1-controller-publisher.md`: Decisions 1 and 3 (the publisher computes digests; open items carry no digest), Task 1 (`item-identity.ts`: the completion contract and the key the Controller makes for an observation without identity), Task 5 (rows carry `identity`; the manager-driven fixture), Task 11 (`expectContinuity`, `continuityPlan`, `itemsOf`, which drive a real agent manager so an adapter that omits the identity of `interaction_resolved` fails), and Decisions 8, 10 and 11 (no runtime event entries, grant 2, unserve).

**Commands.** Every test command sets a per-test deadline (`--testTimeout`); run each with an outer deadline of at most 300000 ms. Lab tests run on Node 22. Provider tests that start a native CLI are the `*.local.test.ts` files; they need the native tools and run on request. All work happens in the worktree `/Users/xian/projects/agent-remote-control/.worktrees/im-session-service`.

## The contract each adapter implements

- **Key.** The native identity of the finalized item the observation belongs to, at most 4096 characters, prefixed by the item type where native ids of different types can collide. It is identical for the deltas of a live item and for the record read again, and it never contains a source key of a delta (random ids, lengths, fingerprints).
- **Completion.** An observation that finishes the item carries `completes`. A history observation completes its item unless the native record is still being written. An adapter whose last live delta carries no content emits an empty body of the same item type with `completes`; the merge appends nothing.
- **Live-only.** An item that native history cannot give back is marked `liveOnly` on every observation of it: interaction records, Controller-made items, corrections that exist only live, and whatever the research below lists per provider.
- **Content.** The item built by merging a live item's rows equals the item of the record. Where a provider's live text differs from its record, the adapter aligns the live path (join separators, final-text corrections, bounded tool output), because the Controller never repairs content.
- **Corrections that exist only live.** A provider that corrects a streamed item by emitting a new live-only item beside it (Codex's `${id}:correction:<fnv>`, Copilot's `message:<id>:correction`, Claude's repeated final text) never leaves both in a journal. The correction replaces the corrected item: once the reread brings the base item's final content, the journal holds that item once, corrected in place (`correct`, whose digest differs), and the live-only correction item is gone; a live-only correction that the reread cannot reconcile with the base reaches clients as a `timeline_replacement`, never as a silent second item. Each provider task proves it with a test that checks the journal after the reread has the base item once and no correction item beside it, and states how the correction item is removed (the Controller's `abandon` of a sealed live-only item or a `replace`); a provider that cannot meet this stays undeclared.
- **Observations that are not timeline items** (turn lifecycle, usage, runtime state) carry no identity.
- **Interaction items carry identity.** The timeline item the agent manager builds from `interaction_resolved` takes the identity of that observation (`interaction:<requestId>`, `completes`, `liveOnly`); an adapter that omits it fails the continuity fixture, which drives a real agent manager. `interaction_requested` carries none: the item is built at resolution.

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

## File structure

| File | Responsibility |
|---|---|
| `packages/agent-host/src/test-utils/journal-continuity.ts` | Modify: `recordRun`, which records a live run and a reread from an adapter and a handle. |
| `packages/agent-provider-<name>/src/*` | Modify per task: keys, completion and live-only marks, content alignment, the declaration. |
| `packages/agent-provider-<name>/src/*.test.ts` | Modify or create per task: unit tests of keys and marks. |
| `packages/agent-host/src/journal-continuity.<name>.test.ts` | Create per task: the continuity fixture of the provider, over its own test doubles. |
| `docs/current/agent-remote/providers.md`, `provider-support.md`, the provider's normalized-events document | Modify per task: the keys, marks and the declaration. |
| `packages/agent-remote-lab/compatibility.json` | Generated. |

---

### Task 1: Record a run from an adapter

**Files:** modify `packages/agent-host/src/test-utils/journal-continuity.ts`; modify `packages/agent-host/src/journal-continuity.test.ts`.

**Interface** (add to `journal-continuity.ts`):

```ts
/** Opens a native session through an adapter, lets `drive` produce live activity, disposes it, opens the same session again and reads its history. */
export async function recordRun(options: {
  open(): Promise<AgentSession>;
  reopen(): Promise<AgentSession>;
  /** Called while the first session is open; it makes the provider emit live observations (send a message, push scripted events). */
  drive(session: AgentSession): Promise<void>;
  /** How many live observations to wait for before the first session is disposed. */
  liveCount: number;
}): Promise<ContinuityRun>
```

It uses `collectProviderStream` of `@orchardworks/agent-provider-sdk/testing` for both sessions: `live` is the first session's history followed by its live observations, `reread` is the second session's `history`. It disposes both sessions in `finally`.

**Tests** (in `journal-continuity.test.ts`, over a fake adapter built from `ScriptedSession`): a run whose reopened session returns the same items passes `expectContinuity`; a run whose reopened session returns a different key fails with the plan in the message; both sessions are disposed when `drive` throws.

Steps: write the three failing tests, run them, implement, run, commit (`test(host): record a live run and a reread from a provider adapter`). Run `pnpm --filter @orchardworks/agent-remote-controller exec vitest run src/journal-continuity.test.ts --testTimeout=15000`.

### Task 2: OpenCode

**Files:**
- Modify `packages/agent-provider-opencode/src/normalize.ts` (`itemIdentity` on every observation of an item: base key, `completes` per the completion rules), `timeline.ts` (copy the identity of the base observation onto the delta and state observations that `reconcileTimeline` builds), `session.ts` (identity for the interaction receipts, unsupported-form errors and `interaction_resolved` observations: `liveOnly`), `provider.ts` (`journal: { itemIdentity: 1 }`, last).
- Modify `normalize.test.ts`, `timeline.test.ts`, `provider.test.ts`; create `packages/agent-host/src/journal-continuity.opencode.test.ts`.
- Modify `docs/current/agent-remote/providers.md`.

**Decisions:** the identity key is the base key before the `:text:` or `:state:` suffix; `turnId` of a partial page is stable between a live run and a reread (a test); compaction's later row replaces the earlier under one key.

**Tests:**
1. Unit (`normalize.test.ts`): every timeline observation of a fixture conversation (user, assistant text with several parts, reasoning, a tool that runs then completes, a shell command, a compaction, a sub-agent request and reply, an error) has a key; keys are unique per item; assistant text parts of one message have different keys (ordinal).
2. Unit (`timeline.test.ts`): a delta observation carries the same key as the final observation of its item and no suffix; a tool's running and completed rows share a key and only the last has `completes`.
3. Continuity (`journal-continuity.opencode.test.ts`, over the fake server of `provider.test.ts`): `recordRun` with a live turn made of text deltas, a tool call and a completion; `expectContinuity` passes; with an unchanged session a second reread adds nothing; a removed message gives `replace` with reason `missing`; a session read through `readTimelineHistory` pages (older pages) plans `continue` with no `replace`.
4. Local (`provider.local.test.ts` or the existing local OpenCode test, if the native CLI is installed): open a real session, run a turn, reopen, compare with `expectContinuity`.

**Order.** Task 2 (OpenCode) and Task 3 (Codex) are expanded and declared only after P1-C3's read-only history task for the same provider has landed or been ruled out, because their rereads of unopened sessions and fills read through that capability; Copilot and Claude may go first. Until then an undeclared provider stays on forwarding.

**Steps:** record the live and reread observations of the fixture first and commit the recording as the test's input; write the key tests; implement keys and marks; make the continuity test pass; declare `journal` in `provider.ts`; update the document; run the provider's suite, the Controller's `journal-continuity.opencode.test.ts` and `pnpm compatibility:update` then `pnpm compatibility:check`; check the local instance (below); commit per step.

### Task 3: Codex

**Files:**
- Modify `packages/agent-provider-codex/src/projector.ts` (keys for live and history items, completion markers where the projector emits nothing, `liveOnly` for the items listed), `session.ts` (interaction observations: `interaction:<requestId>`, `liveOnly`, `completes`), `provider.ts` (the declaration, last); the reasoning summary join in `projector.ts` (live: `summaryPartAdded` adds the `\n\n` separator; `readReasoningText` stays) and the `content[]`-only reasoning path.
- Modify `projector.test.ts`, `session.test.ts`, `history-pagination.test.ts`, `collaboration-items.test.ts`; create `packages/agent-host/src/journal-continuity.codex.test.ts`.
- Modify `docs/current/agent-remote/codex-shared-runtime.md` and `providers.md`.

**Decisions:** corrections (`${id}:correction:<fnv>` and the error row) are live-only and keep their keys; the correction replaces the base item: the reread corrects the base in place because its digest then differs, and the correction item does not remain beside it; `communication-history.ts` supplements (`item:<id>:completed`, `communication-history:<id>:unavailable`) take the key of the item they supplement or are live-only when they have none.

**Tests:**
1. Unit: every timeline observation of the projector has a key; keys of live and history observations of one item are equal (user, assistant, reasoning, tool, communication, compaction, turn failure) for a scripted turn that has all item types; a streamed text equal to the final text still produces a completion marker; a multi-part reasoning's live merge equals the history text; a correction is live-only.
2. Continuity (`journal-continuity.codex.test.ts`, over `createScriptedAppServer`): a scripted turn built as live notifications (`item/started`, deltas, `item/completed`) and the same turn as a `thread/turns/list` response; `expectContinuity` passes, including the multi-part reasoning and the equal-text completion cases; a thread of 23 turns read through its pages (the window of 10 turns) plans `continue` with the older pages as a prepend and never a `replace`; a mutated older item gives a correction after the page that holds it is read; recovery with `finishBootstrap(replacement=true)` gives `continue`.
3. Local (`*.local.test.ts` with the real binary, if installed): a real turn, a release, a reopen.

**Steps:** as Task 2.

### Task 4: Copilot

**Files:**
- Modify `packages/agent-provider-copilot/src/projector.ts` (keys; `reasoningId` read from `assistant.reasoning_delta` and `assistant.reasoning`; the compaction start-to-complete correlation; completion markers; `liveOnly` for reasoning, todo and corrections), `session.ts` (`emit()` gives todo and interaction observations their identities instead of random keys), `interactions.ts` (the `interaction_resolved` observation carries `interaction:<requestId>`), `provider.ts` (the declaration, last).
- Modify `projector.test.ts`, `provider.test.ts`, `tests/native.test.ts`; create `packages/agent-host/src/journal-continuity.copilot.test.ts`.
- Modify `docs/current/agent-remote/copilot-normalized-events.md`.

**Decisions:** reasoning is live-only in every case (history may omit it); the live interaction item and the history interaction item are one item under `interaction:<requestId>` (their content may differ in approval scope, which is a correction); `todo:plan` is one item whose latest snapshot replaces the earlier ones.

**Tests:** as Tasks 2 and 3, over `tests/native-fixture.ts` and hand-written `events.jsonl` fixtures. A reread that lacks reasoning plans `continue`; a live correction message is live-only and, after the reread, the journal holds the base once with no correction beside it; a truncated `events.jsonl` gives `replace` with reason `missing`; compaction start and complete are one item.

**Steps:** as Task 2.

### Task 5: Claude

**Files:**
- Modify `packages/agent-provider-claude/src/projector.ts` (keys, completion markers for records that emit nothing, `liveOnly` for the compaction loading row and withdrawn input, the folded-input key), `session.ts` (steer and withdrawn identities), `folded-input.ts` (history keys for restored folded input), `catalog-worker.ts` and `provider.ts` (history for journal purposes keeps `tool_use_result` from the raw transcript row with the same uuid, so live and history tool items carry the same content parts and `file_changes`), `provider.ts` (the declaration, last).
- Modify `projector.test.ts`, `session.test.ts`, `native-normalized.local.test.ts`; create `packages/agent-host/src/journal-continuity.claude.test.ts`.
- Modify `docs/current/agent-remote/claude-normalized-events.md`.

**Decisions:** folded and steered input is keyed `folded:<16 hex of sha256(text)>:<n>`, in both paths; a text correction is live-only and replaces the base item (the reread corrects it in place; no correction item remains); the history reader attaches the raw row's `toolUseResult`.

**Tests:** unit (every observation of hand-built stream and record frames has a key and the right marks; a tool's running and completed rows share `tool:<id>`; an assistant message split into blocks keeps `assistant:<message.id>:<index>`); continuity over `nativeFixture` (live, release, cold resume): a turn with text and a tool whose result carries structured output, an Edit and a Bash result, a steered message, a compaction; `expectContinuity` passes; a session whose transcript lost a record gives `replace`. The first step of the task is the probe that decides the open question in Content differences (3): record a thinking block whose text is empty or redacted and see what the history reader returns, and decide whether such a block is live-only.

**Steps:** as Task 2.

### Task 6: The local instance shows no reset (T6), per provider

Each provider task ends with this check; it needs P1-B3a's switches.

1. Start the instance with journals enabled: `ARC_LOCAL_JOURNALS=1 pnpm local up` (follow `.agents/skills/prepare-arc-local/SKILL.md`, free ports).
2. Turn smart reading on for the provider and the local Host: `PUT /v1/remote/hosts/:id/smart-reading` with the provider id, as the instance's owner (P1-B3a Decision 6).
3. Open a session of the provider in the local site and send a message. Confirm the journal exists (the instance's `journals.sqlite` holds the session) and that the page is journal-served (its stream sends `negotiated` without a Controller attach).
4. Run `node packages/agent-remote-lab/performance/local-baselines.mjs --scenarios restart-continuity --sessions <address>` (the scenario restarts the Controller and the Relay together with `pnpm local up --no-build` and records labels, row counts and re-keyed rows).
5. Also check the interaction hold: ask a question or approval in the session from the page, answer it, and watch that the page never drops a new question or shows a resolved one again while the head catches up (the Relay holds the interaction frames until the served head agrees, for at most two seconds). Then, from the Controller log and the page: after the restart no `journal_open_refused`, `journal_session_unserved` or `journal_quota_window` event appears; the head's `attentionItemKey` still points at the same item (the attention cursor does not move); a settled image or file resource still opens after the restart (stable resource ids); and an open item (a running tool) is still open after the reread, not marked complete.
6. Expected: no frame without rows, no connection label, unchanged items keep their rendered rows (T6), and the Controller log shows `journal_replacement_published` only if the session's history was genuinely rewritten. Record the result in the task's commit message.
7. Turn smart reading off for the provider and check that the same session works through forwarding.

## Verification at the end of each task

```bash
pnpm --filter @orchardworks/agent-provider-sdk run build
pnpm --filter @orchardworks/agent-provider-<name> run test
pnpm --filter @orchardworks/agent-provider-<name> run build
pnpm --filter @orchardworks/agent-remote-controller exec vitest run src/journal-continuity.<name>.test.ts --testTimeout=15000
pnpm --filter @orchardworks/agent-remote-controller run typecheck
pnpm compatibility:update
pnpm compatibility:check
```

Expected: PASS, and a compatibility digest that verifies.

## Open risks

- **Content equality is the whole risk.** A live item and the same item read again must merge to the same content. Claude's tool results and Codex's multi-part reasoning are the known gaps; others may show up in the recordings. A provider that cannot reach continuity stays undeclared and keeps forwarding, which the design allows.
- **Completion markers add empty rows.** An empty-body row per completed text item adds a row to the Controller's timeline and the journal's sequence. The merge makes them invisible in pages, but they cost a sequence number each.
- **Window and `turnId`.** OpenCode's partial page has no turn ids until the boundary is loaded; if a reread of a partial page and a live run disagree on the first turn's `turnId`, the journal's retention windows move.
- **Keys by ordinal.** OpenCode text parts are keyed by ordinal, which is stable only while content appends. A native edit that inserts a part would shift ordinals; it is a genuine rewrite and `replace` is the right answer.

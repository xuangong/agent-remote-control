# I3: Assistant view and workbench

**State: plan (2026-11-20).** I3 is the third Orchard step (roadmap "Next: Orchard"; [Orchard design](../specs/2026-11-20-orchard-im-experience-design.md), decisions 1 to 5, "Two views of the same assistants", "Phone", "Visual language", step I3 and Acceptance). It builds Bot mode and Window mode in the new design, together, from the I2 primitives ([I2 plan](2026-11-20-i2-design-system.md), section 10). It keeps the session-presentation rules of [I1](2026-11-20-i1-quiet-open.md) (`sessionNotice`, `composerAvailability`, `sessionActivityLabel`) and adds no connection word.

I3 ships in two parts. Each is a website release on its own, keeps both modes consistent, and passes its own acceptance:
- **I3a Conversation.** The timeline in `agent-client-web`: bubbles, the one-line work summary with L2 in place, the live status line, inline approvals, the session-change line, and the three process modes as one rule. It appears at once in both modes, inside today's panels. It also carries the I2 avatar follow-ups and the L2/L3 inventory.
- **I3b Layout.** Bot mode in three floating panels, the details panel, the assistant-voiced status sentences, Window tiles as small floating panels, moving between the modes, and the phone screens. It deletes the chrome the new layout replaces.

## 1. For the owner

**What you will see after I3a.**
- Your messages are dark bubbles on the right; the assistant's are neutral bubbles on the left with its avatar at the foot.
- Each turn's work is one grey line ("Read 3 files, edited notes.md"). Tap it to see every step, command, diff and path in place.
- A running turn shows one live line with the avatar: "Chief is running tests · working".
- Approvals are small cards in the conversation: Allow, Not now, Show what changes.
- A new session behind the same assistant is a thin line: "· Continued in a new session ·".
- The view options menu offers Concise, Process and Full instead of Preview, Simple conversation and Content only.
- Triangle avatars look as large as the others, and avatars clearly look somewhere.

**What you will see after I3b.**
- Bot mode is three rounded panels on the warm ground: your assistants, the conversation, and its details. Each assistant says what it is doing in one sentence ("Wants to ask you something", "Mac mini is offline. Messages go when it is back", "Resting. Wakes when you need it").
- The details panel holds the assistant's card, where it works (agent, machine, sessions), the process mode, notifications, model and settings, and files.
- In Window mode every tile is a small panel with the assistant's avatar, name and sentence; window and tile behaviour is unchanged. "Open in Bot mode" from a tile, and "Pin to a window" from Bot mode, keep your place.
- On the phone: the assistant list is home, a conversation is full screen with a back gesture, details are a sheet, and a window is a stack of tiles you swipe through. Return makes a new line; the send button sends.

**Deploy.** I3a: a Relay release (the bot details gain the per-assistant process mode, section 4.6), then a website release. I3b: a website release only. No Controller change in either part.

**Review on `pnpm local`.** Section 9 lists the screens and the order.

## 2. Today

| Piece | Where | What it does |
|---|---|---|
| Timeline | `agent-client-web/src/react/AgentTimeline.tsx` (270), `TimelineItemRenderer`, `ConversationEntry`, `TimelineEntry`, `items/*`, `styles.css` (1,063; legacy budget 448) | One card per item. No turn grouping; the only folds are `groupBackgroundActivity` and `groupRuntimeNotices`. `TimelineDisplay` (`'preview' \| 'simple' \| 'content'`) filters and opens items; `useItemDisclosure` keeps a reader's choice and opens a search result. |
| Turn data | `ProjectedTimelineEntry.turnId?` (`agent-remote-protocol/src/timeline.ts:108`); `agent.activeTurn` (`snapshot.ts:113`) | Turns exist on entries and on the agent, but nothing renders by turn. |
| Pending interactions | `AgentTimeline.tsx:223-236` aside, `InteractionPanel`, `interactions/*Card.tsx` | A pinned panel after the list: tool, permission and plan approvals, questions, forms, external actions; respond, pending, failure and capability words live in `InteractionPanel`. |
| Working indicator | Lab `TypingBubble.tsx`, passed as `timelineEnd` (`useSessionViewPresentation.tsx:185`) | "{name} is working". The elapsed time and the activity label are in `AgentActivityStatus` (in the composer). |
| Session change | Lab `EarlierConversation.tsx:90` (an unlabelled hairline, Bot mode); `SessionSuccessionHistory.tsx` (Window mode heading: "Continued from / by", "Earlier history (N)") | Bot mode shows earlier sessions above the current one without a word. |
| Bot mode | `BotWorkspace.tsx` (192), `BotRoster.tsx` (118), `BotActions.tsx` (139), `bot-roster.ts` (127), `bot-workspace.css` (157, budget 99) | A 260 px roster and the conversation. Row: picture, name, role and label tags, reply time, one status word (`botActivityLabel`: Needs you, Working as dots, Failed; idle and offline say nothing), preview, unread dot, ⌖, asks. Bot menu: Info, Label…, Sleep, Hide in Bot mode, Remove from group…. Bot mode forces `fixedDisplayMode: 'content'`, which hides every tool call. |
| Conversation heading | `useSessionViewPresentation.tsx:189-222`, `SessionWorkbench.tsx:116-147`, `LabWorkbench.tsx` | Bot mode: picture, title, label and a status word (its own chain at :219). Window mode: `sessionManager` (close, star, `ChatSessionManager`, Back/Forward, `SessionLink`, Quote), renamable title, attributions (Host, Provider, cwd, Session ID), VS Code link, view options, search, h2 "Conversation", succession heading. |
| Window mode | `SessionDocks.tsx` (149), `SessionDock.tsx` (401), `SessionWindow.tsx` (104), `SessionFamily.tsx` (256), `shell/WindowToolbar.tsx` (97), `session-dock.css` (188, budget 62) | Dock rail, primary groups, floating windows, folding, resize, subagent panes; an unfolded tile shows no avatar. Window toolbar: title, summary, Add, Show/Hide docks, Window actions. |
| Settings | `AgentSessionSettings` in `AgentComposer.tsx:642`; `PlanningControl` as `sessionControls`; `AgentSessionUsage` | Model, permissions, planning and usage sit in the composer of every pane. There is no file list. |
| Storage | `WindowBotDetails` (`agent-remote-protocol/src/window-groups.ts:28`, strict); per-device `localStorage`: `agent-remote:workbench-mode`, per-view display preferences (`useSessionDisplayPreferences.ts:16`), notifications (`useSessionAttention.tsx:12`) | Bot details are per account at the Relay. There is no per-account settings store. |
| Modes | `workbench-mode.ts` (54), `hooks/useWorkbenchMode.ts` (50) | URL `?mode=bot&section=&bot=`; the bot place and window route in session storage. No action opens a tile in Bot mode or pins a bot to a window; `pinned` is only a sort key with no writer. |
| Phone | `MobileNavigation.tsx`, `shell.css:139-160` launcher row, `useVisualViewport.ts`, `BotWorkspace.tsx:114-128` | Bot mode pushes list → chat without a history entry. A window shows only its presented tile. Return always sends (`AgentComposer.tsx:553`). `e2e/components/launcher-layout.spec.ts` holds the generic overlap helper `coveringControls` and the 390×844 launcher test. |
| Avatars | `agent-client-web/src/theme/avatar.ts` | Gaze offsets about 4.5 to 4.6 units of 64 (7 %); the triangle's visible extent is about 35 × 35 against the circle's 50 × 50, and its eyes sit low. |
| e2e provider | `agent-e2e/stack/scripted-provider.ts` | User and assistant rows only: no tool steps, no interaction. `ScriptedSession` already declares the interaction capabilities. |

## 3. Decisions

These settle the brief with the design. Each is final for I3 unless section 11 lists it.

1. **A turn is the unit of folding.** A turn is a user message and everything after it up to the next user message, keyed by the entry's `turnId` where present and by position otherwise. Within a turn, the **answer** is the run of assistant messages after the last work step; everything before it (reasoning, tool calls, file changes, todos, compaction, runtime notices, background checks, and assistant narration between steps) is the turn's **work**. The rule lives in one pure module (section 4.1). It reads only replica entries and `activeTurn`, so the client runtime does not change (design, "Where the change lives").
2. **The process mode is one pure rule** (section 4.2): given a mode, a turn state and the reader's choice, it says whether the work line is open and how each step shows. Concise: closed. Process: open while the turn runs, closed when it ends. Full: open, every step at today's preview level. A reader's toggle wins for that turn until the mode changes; a search hit inside the work opens it.
3. **The process modes replace the Lab's three display modes.** Preview, Simple conversation and Content only, `TimelineDisplay`, `fixedDisplayMode` and the per-view display preference go. Full is today's Preview level, so no detail is lost. Bot mode stops hiding tool calls: they are in L2 behind the work line.
4. **Where the mode is stored.** Per assistant and per account: `WindowBotDetails.process` (`'process' | 'full'`; absent means "follow the default"), written with the existing `bot.update`. The default for all assistants is per device (`localStorage` `agent-remote:process-mode`, absent means Concise), as the IM design keeps display choices per device. A tile whose group has no Bot section shows only the default row. This adds one optional field and no store.
5. **Inline approvals.** A pending interaction renders at the end of its turn, not in a pinned aside. Tool, permission and plan approvals use `ApprovalCard` with plain choices: Allow (allow once, or approve), Not now (deny, or request changes with no text), Show what changes (opens L2 in the card: the command, working directory, context, the full option set with Allow for session and rules, and plan feedback). Questions, forms and external actions keep their inputs, inside a `Card tone="tint"`. `InteractionPanel` keeps its respond, pending and failure logic unchanged; only its placement and its outer chrome change. An answered interaction is a one-line receipt in L1 ("Allowed once"), with today's receipt detail in L2.
6. **The live status line** replaces `TypingBubble`. Its sentence comes from the running step ("Chief is running tests", "Chief is thinking", "Chief is editing notes.md"), its detail is "working" and the elapsed time; a todo in progress adds "2 of 5 done". The activity label of I1 stays the source of state; the status line only words it.
7. **The session-change line** replaces the hairline in `EarlierConversation` and the "Continued from / by" heading. The chain's titles, providers and Return to current move to the details panel's Sessions list (L2).
8. **Assistant status sentences** are one pure rule over business facts (section 4.3): needs you, working, waiting to send, failed, ended, Host offline, resting, idle. Resting is the existing `asleep` detail; a runtime the Controller released without `asleep` is invisible by design (it wakes on open, I1). No input is a connection phase, so T5 holds by construction. Idle says the last reply's preview, which is the design's "Done reading, I have 3 thoughts".
9. **Words are English**, the product's language today; the design's Chinese sentences are its voice, not its locale (section 11, question 1).
10. **The details panel** is one component for both modes: a floating panel beside the conversation in Bot mode, a floating panel over the window opened from a tile in Window mode, and a sheet on the phone. Its sections are in section 4.5. The Info sheet and the bot menu move into it; model, permissions, planning and usage move from the composer into it.
11. **Files** are the files the loaded conversation changed or shared, derived purely from the replica (file changes of tool calls, message resources and images). Each opens the existing `FilePreview`. No protocol, no file browser.
12. **Window and tile behaviour does not change.** Docks, floating windows, folding, resizing, dragging, subagent panes and the window rule stay. What changes is each tile's chrome: an assistant header (avatar, name, sentence, details, a ⋯ menu, fold or close) built from the primitives. The per-tile heading cluster moves into the ⋯ menu and the details panel.
13. **Moving between the modes keeps your place.** "Open in Bot mode" from a tile selects that assistant in Bot mode (adding the group's Bot section with `bots.add` if it has none). "Pin to a window" from Bot mode shows the assistant's group in Window mode (`window.add`) or moves the assistant to a chosen window (the existing transfer request), then shows Window mode with that tile presented. The other mode's place is kept, so switching back returns to where you were. Both are pure place mappings (section 4.4).
14. **Phone.** At phone width (760 px) the home screen is the assistant list, whatever the stored mode, unless the URL names a window. Opening an assistant pushes a history entry, so the system back gesture and the browser's back return to the list. Details are a `Sheet` opened from the name. A window is a horizontal scroll-snap stack of its tiles, one per screen, with a page indicator. The composer keeps `useVisualViewport`. Return inserts a line under a coarse pointer and sends under a fine one (section 4.7). The launcher-row invariant holds on every new screen.
15. **Avatar follow-ups.** Each shape gets an optical scale about its centroid so that its filled area matches the circle's within 6 %, and its eyes move with it. Gaze offsets grow to 7 to 8 units of 64, clamped per shape so both eyes stay inside the outline. The hash and the golden recipes do not change: nobody's assistant re-rolls.
16. **Avatars are generated at creation.** Creating an assistant (New bot, a Side, a handoff that makes a new bot) writes `distinctAvatar(viewId, taken)` into `picture`, as I2 decision 8 left for I3. The details card has a picker over the 32 shape × colour pairs and the six gazes.

## 4. Interfaces

### 4.1 Turns (pure, `agent-client`)

New folder `packages/agent-client/src/presentation/`, in the `client` module, exported from the package index. Every file there is pure: no DOM, clock or storage; tests are vector tables.

```ts
// presentation/turns.ts
export type WorkStepKind = 'reasoning' | 'command' | 'read' | 'edit' | 'search' | 'fetch' | 'tool' | 'todo' | 'compaction' | 'notice' | 'narration' | 'background' | 'interaction_receipt';
export interface WorkStep { readonly key: string; readonly kind: WorkStepKind; readonly state: 'running' | 'done' | 'failed'; readonly entry: ProjectedTimelineEntry | readonly ProjectedTimelineEntry[] }
export interface Turn {
  readonly key: string;                       // the turnId, or `pos:<first entry key>`
  readonly prompt?: ProjectedTimelineEntry;   // the user message; absent for a turn the terminal started without one in the loaded window
  readonly work: readonly WorkStep[];
  readonly answer: readonly ProjectedTimelineEntry[];  // assistant messages after the last step
  readonly letters: readonly ProjectedTimelineEntry[]; // agent_communication, which stays in L1
  readonly state: 'running' | 'ended';        // running iff it is the last turn and agent.activeTurn matches it (or has no id and the agent is running)
}
export function foldTurns(entries: readonly ProjectedTimelineEntry[], activeTurn: { turnId: string } | null, agentStatus?: AgentStatus): readonly Turn[];
```

**Rules (vector table `presentation/turns.vectors.ts`, read by `turns.test.ts` and by the timeline's component test):**
- T-1. Every entry appears in exactly one turn, once, in order (the inventory guarantee: nothing is dropped by folding).
- T-2. A user message opens a turn; `background` user messages do not (they stay in their background group step).
- T-3. Assistant messages after the last step are the answer; assistant messages before a step are `narration` steps.
- T-4. Consecutive errors are one `notice` step (today's `groupRuntimeNotices`); a background group is one `background` step (today's `groupBackgroundActivity`, moved here and deleted from the web package).
- T-5. A step is `running` while its tool call is running, `failed` when its tool call failed, its error is not recoverable or its compaction failed; otherwise `done`.
- T-6. Only the last turn can be `running`. A turn with a pending interaction is `running`.
- T-7. With `hasOlder`, the first loaded turn may lack its prompt; it is still a turn.

### 4.2 Process mode, work summary and live status (pure, `agent-client`)

```ts
// presentation/process-mode.ts
export type ProcessMode = 'concise' | 'process' | 'full';
export interface WorkDisclosure { readonly line: 'open' | 'closed'; readonly steps: 'summary' | 'preview' }
/** Which steps of a turn are open. `choice` is the reader's toggle for this turn (undefined until they touch it); `revealed` is a search hit inside the turn's work. */
export function workDisclosure(mode: ProcessMode, turn: 'running' | 'ended', choice?: boolean, revealed?: boolean): WorkDisclosure;
export function readProcessMode(stored: unknown): ProcessMode | undefined;           // device default and bot details; anything else → undefined
export function effectiveProcessMode(assistant: ProcessMode | undefined, device: ProcessMode | undefined): ProcessMode; // assistant ?? device ?? 'concise'

// presentation/work-summary.ts
/** "Read 3 files, edited notes.md, ran 2 commands"; "1 step failed" is appended in danger text by the view. Plain English, at most three clauses. */
export function workSummary(steps: readonly WorkStep[]): { readonly text: string; readonly failed: number; readonly running: boolean };
/** The live line of a running turn: "{name} is running tests", "{name} is thinking", "{name} is editing notes.md", else "{name} is working". */
export function liveStatus(name: string, turn: Turn): { readonly sentence: string; readonly progress?: string }; // progress "2 of 5 done" from the latest todo
```

**Disclosure table** (`process-mode.test.ts`; `choice` and `revealed` absent unless stated):

| Mode | Turn | Line | Steps |
|---|---|---|---|
| concise | running | closed | summary |
| concise | ended | closed | summary |
| process | running | open | summary |
| process | ended | closed | summary |
| full | running | open | preview |
| full | ended | open | preview |
| any | any, `choice: true` | open | as the mode, `summary` for concise |
| any | any, `choice: false` | closed | as the mode |
| any | any, `revealed: true` | open | preview |

`summary` is a step's one-line header (name, one-line summary, state); `preview` is today's preview block. Opening a step shows today's full details either way. The work line always renders when the turn has work, so L2 is one tap away in every mode.

**Summary vectors** (`work-summary.test.ts`) cover each kind alone, mixtures, plurals, path shortening to the file name, more than three kinds ("and 2 more"), failures, a running step, and an empty work list (no line).

### 4.3 Assistant status (pure, `agent-client`)

```ts
// presentation/assistant-status.ts
export interface AssistantFacts {
  readonly activity: SharedSessionState;         // session-states.ts: SessionActivityState | 'unknown' | 'offline'
  readonly host?: { readonly online: boolean; readonly name?: string };
  readonly asleep: boolean;                      // WindowBotDetails.asleep
  readonly waitingToSend: boolean;               // an outbox entry
  readonly notice?: SessionNotice;               // from sessionNotice, when the replica is open
  readonly replyPreview?: string;
}
export type AssistantState = 'needs_you' | 'working' | 'waiting_to_send' | 'failed' | 'ended' | 'host_offline' | 'resting' | 'idle' | 'unknown';
export interface AssistantStatus { readonly state: AssistantState; readonly sentence: string; readonly mood: AvatarMood }
export function assistantStatus(facts: AssistantFacts): AssistantStatus;
```

**Precedence** (first match): needs you ("Wants to ask you something"), host offline ("{Host} is offline. Messages go when it is back"), failed ("Something went wrong"), ended ("This conversation has ended"), resting ("Resting. Wakes when you need it"), working ("Working on it"), waiting to send ("Will send when it is ready"), idle (the reply preview, else "Ready when you are"), unknown (the reply preview, else no sentence). Mood: needs you → `needs_you`, working → `working`, resting → `resting`, otherwise `idle`.

**Invariant A-1** (vector rows over every `activity`, both host states and every T5 input): no sentence contains a word of `SESSION_CONNECTION_PATTERN`, and `activity: 'unknown' | 'offline'` alone never produces a state other than `unknown` or `host_offline`.

`botActivityLabel` (`bot-roster.ts:51`), the header chain at `useSessionViewPresentation.tsx:219` and `activityGroups`' per-row words are replaced by it (Task B7).

### 4.4 Places between the modes (pure, Lab)

```ts
// agent-remote-lab/src/workbench-mode.ts (extended)
export function botPlaceForTile(group: WindowGroup, viewId: string): { place: BotPlace; edit?: WindowGroupEdit }; // edit: bots.add when the group has no Bot section
export function windowRouteForPin(group: WindowGroup, viewId: string, target?: string): { route: WindowRoute; request: { kind: 'show'; edit: WindowGroupEdit } | { kind: 'transfer'; target: string } | { kind: 'none' } };
```
Vectors (`workbench-mode.test.ts`): a tile in a group with and without a Bot section; a bot whose group is hidden from Window mode, shown, or pinned to another window; the place of the other mode kept on every switch.

### 4.5 Details panel (Lab)

```ts
// agent-remote-lab/src/components/assistant/AssistantDetails.tsx
export function AssistantDetails(props: { assistant: AssistantRef; surface: 'panel' | 'sheet'; onClose(): void }): JSX.Element;
```
Sections, in order (the mockup's order; each a `Card` group of rows):
1. **Card**: avatar (picker), name, label, role; actions Label…, Sleep or Wake, Hide in Bot mode, Remove from group…, Pin to a window or Open in Bot mode.
2. **Where it works**: Agent (provider, with earlier providers), Machine (Host, with the online dot or "offline"), Sessions (the succession chain: titles, current marked, Return to current; subagent sessions; star; session link; VS Code link; working directory and session id, copyable).
3. **Process**: `SegmentedControl` Concise / Process / Full for this assistant, and the device default ("All assistants on this device").
4. **Notifications**: a `Toggle` on today's per-device key.
5. **Model and settings**: `AgentSessionSettings`, `PlanningControl` and `AgentSessionUsage`, moved from the composer.
6. **Files**: `sessionFiles(replica)` rows, newest first, each opening `FilePreview`.

```ts
// agent-client/src/presentation/session-files.ts (pure)
export interface SessionFile { readonly path: string; readonly change?: 'added' | 'modified' | 'deleted' | 'renamed'; readonly source: 'change' | 'resource' | 'image'; readonly entryKey: string; readonly additions?: number; readonly deletions?: number }
export function sessionFiles(entries: readonly ProjectedTimelineEntry[]): readonly SessionFile[]; // one row per path, the newest change wins
```

### 4.6 Stored fields

- `WindowBotDetails.process: Type.Optional(Type.Union([Type.Literal('process'), Type.Literal('full')]))`. Concise is the absence (so a bot never needs the field to look like the default). The schema is strict, so the Relay deploys first. Frozen fixture `window-bots.v1.json` keeps reading; a new fixture row has `process`.
- `localStorage` `agent-remote:process-mode` (device default). It is a display choice: not in `conversation-storage`'s content prefixes, so "clear on close" keeps it.
- Deleted: `agent-remote:recovery:${scope}:view:${key}` display preferences, `agent-remote:timeline-display` and `agent-remote:show-letters` (their keys are removed once at start; that removal is deleted one release later, as S4b did).

### 4.7 Return key (pure, `agent-client-web`)

```ts
// agent-client-web/src/react/return-key.ts
export function returnKeyAction(facts: { coarsePointer: boolean; shift: boolean; composing: boolean; modifier: boolean }): 'send' | 'newline' | 'ignore';
```
Composing → ignore; coarse pointer → newline (⌘/Ctrl-Return still sends, for an iPad keyboard); fine pointer → send, Shift → newline. The editor sets `enterKeyHint` to `enter` under a coarse pointer and `send` otherwise. `ComposerEditor`'s `insertParagraph` path reads the same rule.

### 4.8 Timeline component contract (`agent-client-web`)

- `AgentTimeline` renders `foldTurns` output: per turn, the prompt `Bubble from="mine"`, the work `WorkSummaryLine` (its children are today's item renderers for each step, at `summary` or `preview` per `workDisclosure`), the answer `Bubble from="theirs"` with the avatar at the foot of the last bubble, letters as today's letter card, the turn's pending interactions inline (decision 5), and for a running turn the `StatusLine`.
- New props: `processMode: ProcessMode`, `assistant?: { name: string; avatar: ReactNode }` (the standalone Session View passes none and shows "Assistant" without an avatar), `timelineBoundary?: ReactNode` (the session-change line, placed by the host).
- Removed props and contexts: `TimelineDisplay`, `isContentOnlyItem`, `showHeader` and its header, the interactions aside. `TimelineLettersVisible` stays.
- Day separators: one centred "Today 18:57" line when the day changes or 30 minutes pass; per-message time keeps its swipe and Alt+T reveal.
- The published `--agent-*` variables are re-pointed to Orchard tokens (I2 section 5, step 2), so a standalone host keeps its override surface.

## 5. Every element visible today, and its new place

The acceptance "every piece of information visible today is reachable in L2 or L3" is this table. Each row has an id, and `e2e/components/assistant-inventory.spec.ts` has one test per id: it loads the fixture page (Task A8), takes the stated path (open the work line, open the step, open the card, open details, open Trace), and finds the element by role or text. The spec reads the ids from `e2e/fixtures/assistant-inventory.ts`, so a row without a test fails the spec.

| Id | Today's element | New place | Layer |
|---|---|---|---|
| M1 | User message text, markdown, content parts | Mine bubble | L1 |
| M2 | Resource download (label, name, size, sha256), image tag and preview | In the mine bubble | L1 |
| M3 | Quoted excerpts and session reference note | In the mine bubble | L1 |
| M4 | Withdrawn note and Copy text | Under the mine bubble | L1 |
| M5 | Assistant message text | Their bubble (answer) | L1 |
| M6 | Assistant narration between steps | `narration` step | L2 |
| M7 | Kicker "You" / "Assistant" / "Background check" | The bubble side; "Background check" on its step | L1 / L2 |
| M8 | Entry time (swipe, Alt+T) and the time title | Unchanged reveal on the bubble; day separator | L1 |
| M9 | Edit from this message, Inspect in Trace, selection | Bubble actions (unchanged triggers) | L1 |
| M10 | Agent letters (sender → recipient, payload, details drawer) | Letter card in the turn | L1 |
| R1 | Reasoning trace, full markdown | `reasoning` step, opened | L2 |
| T1 | Tool name, one-line summary, state label, session references | Step header | L2 |
| T2 | Command preview, result preview (exit code, first blocks, "No output"), error preview | Step at `preview` (Full mode, or opened) | L2 |
| T3 | Command and cwd; read/edit/write type and path; query; URL; description | Opened step details | L2 |
| T4 | Result: exit code, duration, stdout/stderr labels, text or JSON, raw result, truncated note, error | Opened step details | L2 |
| F1 | File change: kind, path, previous path, +N −M, diff lines with line numbers | Opened step; and the details Files list | L2 |
| D1 | Todo: tasks, marks, statuses | `todo` step; progress in the live line | L2 / L1 |
| C1 | Compaction: state and trigger | `compaction` step | L2 |
| E1 | Runtime notice group and messages | `notice` step; a failed turn's work line says "1 step failed" | L2 / L1 |
| B1 | Background checks group and count | `background` step | L2 |
| I1 | Pending tool approval: tool name, summary, command, working directory, context | Approval card prompt; Show what changes | L1 / L2 |
| I2 | Allow once, Allow for session, Cancel, Deny, rules drawer, Apply rule, Submitting… | Allow and Not now on the card; the rest under Show what changes | L1 / L2 |
| I3 | Permission request (access, resource, target, scope) | Approval card; detail under Show what changes | L1 / L2 |
| I4 | Plan review (plan, feedback, Approve, Approve and execute, Request changes) | Approval card; plan and feedback under Show what changes | L1 / L2 |
| I5 | Question card (tabs, options, custom text, Previous/Next, Submit, Dismiss, drafts) | Inline tint card, unchanged inputs | L1 |
| I6 | Form and external-action cards | Inline tint card, unchanged inputs | L1 |
| I7 | Waiting for connection to respond, Interaction unavailable, Invalid interaction request | The same words in the card (I1 rules unchanged) | L1 |
| I8 | Answered receipts (question, plan, tool approval, form, permission, external action) with detail | One-line receipt; detail on open | L1 / L2 |
| O1 | Outgoing message: Sending, Not sent, Check delivery, Retry, Delete, error text | Mine bubble delivery word and actions | L1 |
| O2 | Composer queue chips | Unchanged | L1 |
| S1 | Activity label, elapsed time, interrupt | Status line sentence and detail; interrupt stays in the composer | L1 |
| S2 | "{name} is working" | Status line | L1 |
| H1 | Timeline header: REMOTE SESSION, agent id, status, epoch · seq | Replica Inspector | L3 |
| H2 | Load earlier activity, loading, error | Unchanged at the top | L1 |
| H3 | Earlier conversation (Show, loading, unavailable, Retry) and its divider | Session-change line and the earlier bubbles | L1 |
| H4 | Continued from / by, Return to current, Earlier history (N) | Details, Sessions | L2 |
| H5 | Subagent sessions list | Details, Sessions; the step that spawned them links them | L2 |
| W1 | Star, `ChatSessionManager`, Back/Forward, Session link, Quote messages | Tile ⋯ menu (Window mode); details, Sessions (both) | L2 |
| W2 | Attributions: Host, Provider, cwd, Session ID; VS Code link | Details, Where it works and Sessions | L2 |
| W3 | Bot Info sheet: Group, Host (Offline), Provider, Earlier providers | Details card and Where it works | L2 |
| W4 | Bot row: role tag, label tag, reply time, preview, unread dot, ⌖, asks | Sidebar row (tags and time stay; status word becomes the sentence) | L0 |
| W5 | Bot header status word | Top bar sentence | L0 |
| W6 | Model, permissions, planning, usage | Details, Model and settings | L2 |
| W7 | Connection phases, sync, timings, raw events | Trace and Replica Inspector, unchanged | L3 |

## 6. State accounting

Roadmap rule 1: fields and paths, +N/−M.

| Change | Fields | Paths |
|---|---|---|
| `presentation/*` (new, pure) | +0 state; +7 functions (`foldTurns`, `workDisclosure`, `effectiveProcessMode`, `workSummary`, `liveStatus`, `assistantStatus`, `sessionFiles`) | 0 |
| Timeline | −1 context (`TimelineDisplay`), −1 helper (`isContentOnlyItem`), −2 groupers (moved into `foldTurns`), −1 aside, −1 header; +1 per-turn reader choice (component state) | 0 |
| Process mode | +1 optional bot detail (`process`), +1 device key; −1 per-view preference record, −2 legacy keys, −1 `fixedDisplayMode` | +1 one-time key removal, deleted a release later |
| Bot mode | Status words: 3 chains (`botActivityLabel`, header chain, `activityGroups` row words) → 1 rule | 0 |
| Details panel | −1 Info sheet, −1 bot menu, settings moved out of the composer (0 net) | 0 |
| Window tiles | Heading cluster moved (0 net); −1 succession heading, −1 h2, −1 attributions toggle | 0 |
| Modes | +2 place mappings; +1 history entry per opened conversation on the phone | 0 |
| Avatars | +1 per-shape optical scale (constant table); gaze offsets changed | 0 |
| e2e provider | +1 option (`turns`: tool steps and an approval per reply) | 0 |

**Budgets.** The legacy-token ratchet only falls: `styles.css` 448, `bot-workspace.css` 99, `session-dock.css` 62, `earlier-conversation.css` 10, `typing-bubble.css` 4 and `SessionSuccessionHistory.css` 6 all fall, the last three to 0 (deleted). Production CSS lines in the Lab and the Session View, excluding `theme.css` and `primitives.css`, do not grow net in either part. **Why something is added:** the per-assistant mode is the design's decision 3, and the place mappings are its "keeps your place"; neither exists in another form to replace.

## 7. Tasks

**For every task:**
- Work in `.worktrees/im-session-service`; run `pnpm task:start` once before Task A0 and again before Task B1.
- jsdom suites run on Node 22: prefix `PATH=/opt/homebrew/opt/node@22/bin:$PATH`, as CI does.
- Each commit states its state accounting (section 6), lowers the legacy budget it moved, and ends with `pnpm arch:check` and `pnpm test:unit <package> [file]` for what it touched.
- Commit by path; another agent may work in the same worktree.
- Before a commit that changes package exports or the protocol: `pnpm compatibility:update`, then `pnpm compatibility:check`.
- Unit tests are pure and under 50 ms. Component specs run in both themes (`?theme=light|dark`) at desktop (1440 × 900) and 390 × 844, in Chromium and in WebKit: the config's `orchard-phone-*` projects widen their `testMatch` to the new specs.
- The I1 composer handoff (a stand-in pane replaced by the window's pane in the same commit) must keep its text, queue and focus through every layout change; `AgentComposer.handoff.test.tsx` and E9 run with each I3b task.

### Part I3a: Conversation

#### Task A0. Baseline

**Steps:**
1. On `pnpm local`, capture Bot mode and Window mode at desktop and 390 × 844, light and dark, as `.tmp/i3-before-*.png`.
2. Record T1 (`local-baselines.mjs --scenarios open-known,open-fresh --throttle 4 --rtt 100 --reps 10 --out .tmp/i3-control-t1.json`) and T5 (`session-control.mjs --throttle 4 --rtt 100 --opens 10 --sends 3 --type-during-open --out .tmp/i3-control-t5.json`) on the I2 build, as the control arm.

#### Task A1. Turns

**Files:** `agent-client/src/presentation/turns.ts`, `turns.vectors.ts`, `turns.test.ts`, `index.ts` (new); `agent-client/src/index.ts`; `agent-client/src/testing/timeline-kinds.ts` (new builder: one entry of every item kind, every tool kind and state, every interaction kind pending and answered, background and withdrawn rows).

**Interfaces:** section 4.1.

**Tests:** rules T-1 to T-7 as vector rows; T-1 is checked over the every-kind builder and over the recorded rows of `agent-remote-fixtures` (`recorded-rows.ts`, Claude, Codex and Copilot): every entry appears once. **Mutation checks:** treating narration as answer fails T-3; letting an ended turn run fails T-6.

```bash
pnpm test:unit agent-client src/presentation
```

#### Task A2. Process mode, work summary, live status

**Files:** `presentation/process-mode.ts`, `work-summary.ts`, and their tests (new).

**Interfaces:** section 4.2. **Tests:** the disclosure table, row by row; the summary and live-status vectors. **Mutation checks:** Process staying open after the turn ends fails a row; a search hit not opening a concise turn fails a row; dropping the failure count fails a summary row.

#### Task A3. Timeline renders turns

**Files:** `agent-client-web/src/react/AgentTimeline.tsx`, `TimelineTurn.tsx` (new), `TimelineItemRenderer.tsx`, `ConversationEntry.tsx`, `TimelineEntry.tsx`, `items/MessageItem.tsx` (bubble body, no kicker), `TimelineDisplay.ts` (reduced to `TimelineSearchReveal`, `TimelineLettersVisible` and `useItemDisclosure` reading `WorkDisclosure`), `timeline-render-model.ts`, `styles.css`, `react.ts` exports.

**Interfaces:** section 4.8. The item renderers stay; they render inside a step instead of as top-level cards.

**Tests:**
- `AgentTimeline.turns.test.tsx` (new): for each row of the disclosure table, the work line's `aria-expanded` and the steps' level; toggling one turn leaves the others; changing the mode resets choices; a search hit opens its turn; the answer bubbles and the avatar at the foot of the last one.
- The existing `AgentTimeline*.test.tsx` and `items/*.test.tsx` are re-pointed: an assertion on a top-level card now opens the work line first. Each rewritten test keeps its rule; none is deleted without the mutation check (write-tests section 5).
- `AgentTimeline.performance.test.tsx` keeps its budget with folded turns.

```bash
pnpm test:unit agent-client-web src/react
```

#### Task A4. Inline approvals

**Files:** `AgentTimeline.tsx` (aside removed), `TimelineTurn.tsx`, `InteractionPanel.tsx` (placement prop removed; outer chrome to `ApprovalCard` or `Card`), `interactions/ToolApprovalCard.tsx`, `PermissionApprovalCard.tsx`, `PlanApprovalCard.tsx` (the plain choices plus the L2 disclosure), `items/InteractionItem.tsx` (one-line receipts).

**Tests:** `InteractionPanel.test.tsx` and `ToolApprovalCard.test.tsx` re-pointed: Allow sends allow-once, Not now sends deny, Show what changes reveals Allow for session, rules and the command; a pending interaction renders inside its turn, after the answer; read-only and disabled states unchanged; receipts open to today's detail. **Component:** `e2e/components/tool-approval.spec.ts` re-pointed to the inline card at both widths.

#### Task A5. Status line and session-change line

**Files:** `TimelineTurn.tsx` (the `StatusLine` of a running turn); Lab `useSessionViewPresentation.tsx` (passes `assistant`, drops `TypingBubble`); `EarlierConversation.tsx` (the boundary is `SessionChangeLine` "Continued in a new session"); `TypingBubble.tsx`, `typing-bubble.css` (deleted).

**Tests:** `AgentTimeline.turns.test.tsx`: the line shows only while the last turn runs, says the running step and the todo progress, and the elapsed time; `EarlierConversation.test.tsx`: the separator has its accessible name; no T5 word in either (`SESSION_CONNECTION_PATTERN`).

#### Task A6. Process mode stored and chosen

**Files:**
- `agent-remote-protocol/src/window-groups.ts` and test, `src/fixtures/window-bots.v1.json` unchanged, a new fixture row with `process`; `agent-relay-core/src/window-workspaces.ts` test; `docs/current/agent-remote/window-groups.md`.
- Lab: `hooks/useProcessMode.ts` (new: the device key, the bot detail, `effectiveProcessMode`), `components/SessionViewOptions.tsx` (Concise / Process / Full for this assistant and the device default, replacing the three display modes), `useViewModel.tsx` and `BotWorkspace.tsx` (no `fixedDisplayMode`), `hooks/useSessionDisplayPreferences.ts` (deleted; `device-store-start.ts` removes its keys once).

**Tests:** schema accepts `process` and `full`, refuses `concise` and anything else; the Relay round-trips it; `useProcessMode.test.tsx`: the assistant's value wins, the device default follows, a tile without a Bot section writes only the device default; the old keys are removed once.

```bash
pnpm test:unit agent-remote-protocol src/window-groups.test.ts
pnpm test:unit agent-relay-core src/window-workspaces
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm test:unit agent-remote-lab src/hooks src/components/SessionViewOptions
pnpm fixtures:check
```

#### Task A7. Avatar follow-ups

**Files:** `agent-client-web/src/theme/avatar.ts`, `avatar.test.ts`, `primitives/AssistantAvatar.tsx`.

**Interfaces:** `avatarShapes[shape].optical: { scale: number; centroid: [number, number] }`; `gazeOffsets` grow to about 7.5 units, and `avatarEyes(shape, gaze)` clamps the offset per shape.

**Tests:**
- Each shape's filled area after its scale is within 6 % of the circle's (flattened path, shoelace area), and its scaled outline stays inside the 64 box.
- Every gaze offset is at least 7 units for the circle and squircle and at least 6 for the triangle and sideways shapes; the existing "eyes inside the outline, off-centre" test still passes for every shape and gaze.
- The five golden recipes are byte-identical.
- **Component:** `orchard-primitives.spec.ts` measures the rendered bounding boxes of the four shapes at 40 px: the largest and smallest painted areas differ by less than 10 %.

#### Task A8. Inventory fixture and spec

**Files:** `agent-remote-lab/e2e/fixtures/assistant-conversation.html` and `.tsx` (new: the every-kind builder from A1 in one conversation with two sessions in its chain, a running turn and every pending interaction; `?mode=`, `?theme=`, `?width=phone`), `e2e/fixtures/assistant-inventory.ts` (the section 5 ids and paths as data), `e2e/components/assistant-inventory.spec.ts`, `assistant-conversation.spec.ts` (new); `playwright.components.config.ts`.

**Tests:** one test per section 5 row (I3a rows M, R, T, F, D, C, E, B, I, O, S, H1 to H3; the W and H4/H5 rows follow in Task B9); `assistant-conversation.spec.ts`: no text below AA in either theme, 44 px targets for the work line, steps and card choices under a coarse pointer, no horizontal overflow at 390 px, and the three modes' screenshots for review.

#### Task A9. Deletion (I3a)

Earlier work this part makes unnecessary:
- `TimelineDisplay` modes, `isContentOnlyItem`, `useSessionDisplayPreferences`, `fixedDisplayMode`, the display-mode strings and their tests (`TimelineDisplay.test.tsx` rows for `simple` and `content`, `content-only-view.spec.ts`, `simple-conversation.spec.ts`: each mapped to an `assistant-inventory` or `AgentTimeline.turns` test, or deleted with the feature, in `docs/superpowers/specs/2026-11-20-i3-test-mapping.md`).
- The interactions aside and its CSS; the timeline header (`showHeader`) and its CSS; the "You" / "Assistant" kickers.
- `groupBackgroundActivity` and `groupRuntimeNotices` in the web package (moved into `foldTurns`).
- `TypingBubble`, `typing-bubble.css`, the `lab-earlier-divider` rule.
- The `--agent-*` card rules the bubbles replace in `styles.css`; the budget falls with them.

**Test:** the ratchet's new numbers; `pnpm verify:changed`.

#### Task A10. I3a acceptance

**Files:** `agent-e2e/stack/scripted-provider.ts` (`turns?(text): ScriptedStep[]` with `{ tool: name, input, output, ms }`, `{ approval: tool, command }` that waits for the response, and `{ reply: text }`; `respondToInteraction` resolves it), `agent-e2e/flows/e10-assistant-conversation.e2e.ts` (new).

**E10 (desktop 1280 × 800 and 390 × 844 mobile; `E2E_BROWSER=webkit` for both):** open an assistant; send; see the live line while the tool runs; see the one-line work summary; expand it and find the command and its output; approve inline with Allow and see the receipt; switch the mode to Full from view options and see every step at preview level; no word of the T5 list in any frame (`watchWords`).

**Measure:** T1 and T5 with Task A0's commands on the I3a build. T1 must hold (100 ms p95 at 4x CPU from mount to content) and T5 must hold (no connection word, Sending within 100 ms). The runners' selectors for "content" and the composer are updated in the same commit if the bubbles change them; the measured element stays the first painted row.

**Then:** `pnpm test:components`, `pnpm test:preview-browser`, `pnpm test:e2e:flows`, full `pnpm verify`; the owner reviews section 9 steps 1 to 4 on `pnpm local`. Relay first, then the website.

### Part I3b: Layout

#### Task B1. Assistant status

**Files:** `agent-client/src/presentation/assistant-status.ts`, `assistant-status.vectors.ts`, `assistant-status.test.ts` (new).

**Interfaces:** section 4.3. **Tests:** the precedence as vector rows; invariant A-1 over the product of every `activity`, host state, asleep and waiting flag and notice kind. **Mutation checks:** putting working before needs you fails a row; letting `offline` alone say "Working on it" fails A-1.

#### Task B2. Bot mode in three panels

**Files:**
- `components/BotWorkspace.tsx`, `BotRoster.tsx`, `bot-roster.ts` (rows carry `AssistantStatus`), `bot-workspace.css` (rebuilt on `--orchard-*`), `components/assistant/AssistantTopBar.tsx` (new: avatar, name, sentence in a title pill that opens details), `shell/SidebarHeader.tsx` (the `Wordmark`, the mode switch and New assistant), `GatewayController.tsx` (the device link indicator renders in the sidebar foot, I1's one indicator).
- Layout: `FloatingPanel` sidebar (260 px), conversation (column at most 580 px), details (300 px, closable; closed by default under the compact breakpoint).

**Tests:**
- `BotRoster.test.tsx` and `BotWorkspace.test.tsx` re-pointed: a row shows the avatar with its mood, the name, the sentence and the unread dot; tags and reply time stay; the top bar says the same sentence.
- **Component** `e2e/components/assistant-view.spec.ts` (new, on `assistant-conversation.html?layout=bot`): the three panels with 10 px gaps and 22 px radii at desktop; details closed at 1180 px with the conversation column intact; both themes AA; no control covers text (`coveringControls`).

#### Task B3. Details panel

**Files:** `components/assistant/AssistantDetails.tsx`, `AssistantCard.tsx`, `AvatarPicker.tsx`, `WhereItWorks.tsx`, `SessionsList.tsx`, `FilesList.tsx` (new); `agent-client/src/presentation/session-files.ts` and test (new); `BotActions.tsx` (actions move to the card; the menu and the Info sheet go); `agent-client-web/src/react/AgentComposer.tsx` (`settings?: 'inline' | 'none'`, default `inline` for the standalone Session View; the Lab passes `none`); `useAgentCreation.ts`, `useSideSessions.ts` and the handoff's bot creation (write `distinctAvatar`).

**Interfaces:** section 4.5.

**Tests:**
- `AssistantDetails.test.tsx`: each section renders from builder state; the process segment writes `bot.update` with `process` and keeps the other details; the device default writes the key; the toggle writes the notification key; Label, Sleep, Hide and Remove behave as `BotWorkspace.menu.test.tsx` pinned them (those tests move here; none is lost); Sessions lists the chain with the current one marked and Return to current.
- `session-files.test.ts`: one row per path, newest wins, resources and images included, deleted files kept with their kind.
- `useAgentCreation.test.tsx`: a new assistant stores a picture no other assistant of the account has, while one remains.
- `AgentComposer.test.tsx`: `settings="none"` renders no settings; the default still does.

#### Task B4. Window tiles as assistant panels

**Files:** `components/SessionWindow.tsx`, `SessionDock.tsx` (`PrimaryGroupPane`, `FoldedBotCard` on the same header), `SessionConversation.tsx`, `SessionWorkbench.tsx` (heading slots reduced to the assistant header), `components/assistant/TileHeader.tsx` (new: avatar, name, sentence, details, ⋯, fold or close), `components/assistant/TileMenu.tsx` (new: star, Back/Forward, session link, Quote, Change session, Open in Bot mode), `useSessionViewPresentation.tsx` (the Bot-presentation heading becomes the only heading), `session-dock.css` (rebuilt on `--orchard-*`), `shell/WindowToolbar.tsx` (one compact window bar: title, Add, Window actions).

**Behaviour that must not change** (`App.window-*.test.tsx`, `App.succession.windows-and-teams.test.tsx`, `session-family-resize.spec.ts`, `dock-title-interactions.spec.ts`, `floating-controls-clearance.spec.ts`): the window rule, docking, floating, dragging, resizing, folding, subagent panes, rename, and the toolbar's Add and Window actions. These suites run unchanged except for selectors of moved controls, each re-pointed with the control's new accessible name.

**Tests:** `TileHeader.test.tsx`: a tile of a bot view shows its avatar, name and sentence; a tile without a bot shows the session title and the generated avatar; details open the shared `AssistantDetails` as a floating panel over the window. **Component:** `assistant-view.spec.ts?layout=window`: tiles are `FloatingPanel`s on the ground, a folded tile is the same header, both themes, both widths.

#### Task B5. Moving between the modes

**Files:** `workbench-mode.ts` and test (section 4.4), `app/useWindowModeActions.ts` (`openInBotMode`, `pinToWindow`), `TileMenu.tsx`, `AssistantCard.tsx`, `state/palette-actions.ts` (Open in Bot mode, Pin to a window).

**Tests:** the place vectors; `App.bot-mode.test.tsx` gains: open in Bot mode from a tile selects that assistant and keeps the window route; pin from Bot mode shows the tile presented and keeps the bot place; switching back returns to each place; a draft survives both moves (E6's draft rule).

#### Task B6. Phone

**Files:** `BotWorkspace.tsx` (home is the list at phone width; opening pushes history; `popstate` returns), `hooks/useWorkbenchMode.ts` (the phone home rule), `AssistantDetails.tsx` (`surface="sheet"` from the top bar name), `app/views/SessionWindows.tsx` and `components/assistant/TileStack.tsx` (new: scroll-snap stack and page indicator, presented tile kept in the route), `agent-client-web/src/react/return-key.ts` and test (new), `ComposerEditor.tsx`, `AgentComposer.tsx`, `MobileNavigation.tsx` (Bot mode shows no Sessions drawer; the launcher row stays), `e2e/components/launcher-layout.spec.ts`.

**Tests:**
- `return-key.test.ts`: the table of section 4.7.
- `useWorkbenchMode.test.tsx`: phone without a route lands on the list; a window URL still opens the window.
- **Component** `assistant-phone.spec.ts` (new; 390 × 844, iPhone WebKit and Pixel Chromium, both themes): list → conversation → back by `history.back()` and by the edge-swipe gesture, the list scroll restored; details sheet from the name with safe-area padding; swiping the tile stack moves one tile and updates the indicator; with the keyboard emulated (`visualViewport` resize) the composer stays visible and the last bubble does not jump more than 1 px; Return inserts a line and the send button sends; 44 px targets.
- `launcher-layout.spec.ts`: the generic `coveringControls` check runs on the list, the conversation, the open sheet and the tile stack.

#### Task B7. Status words become one rule

**Files:** `bot-roster.ts` (`botActivityLabel` deleted), `useSessionViewPresentation.tsx` (the header chain at :219 deleted), `session-activity-status.ts` (`activityGroups` keeps the group filter, loses the per-row words), `useAttentionAndRoster.ts` (facts for `assistantStatus`).

**Tests:** `bot-roster.test.ts` statuses re-pointed to `AssistantStatus.state`; `App.bot-attention.test.tsx` unchanged in intent; mutation check recorded in the mapping doc.

#### Task B8. Deletion (I3b)

Earlier work the new layout makes unnecessary, with its tests mapped in the I3 mapping doc:
- Bot mode: the bot menu and right-click menu, the Info sheet (`BotActions.botMenu`, `BotInfo`), the "‹ Bots" toolbar and sidebar toggle (the panel layout and the history back replace them), `.lab-bot-session-heading`, the roster's 260 px grid rules.
- Window tiles: the per-tile heading cluster (`sessionManager` assembly in `useSessionViewPresentation.tsx:202-218` and `SessionDocks.tsx:111-122`), the h2 "Conversation", the attributions toggle (its data is in details), `SessionSuccessionHistory` and its CSS, the empty-view headers ("Select session" with Close), the Show/Hide docks toolbar button (folding stays on each tile).
- Composer: the inline settings row in the Lab (`settings="none"`); `sessionControls` wiring for planning.
- The phone's single-visible-tile rule in `SessionWindows.tsx:14` (the stack replaces it).
- Legacy rules in `bot-workspace.css`, `session-dock.css`, `window-workspaces.css` and `shell.css` that the rebuilt selectors replace; their budgets fall.

**Test:** the ratchet; `pnpm verify:changed`; the mapping doc lists every deleted test with the test that now owns its rule.

#### Task B9. I3b acceptance

**Files:** `agent-e2e/flows/e10-assistant-conversation.e2e.ts` (extended), `e2e/components/assistant-inventory.spec.ts` (rows W1 to W7, H4, H5).

**E10 additions (desktop and 390 × 844, Chromium and `E2E_BROWSER=webkit`):** open details (panel on desktop, sheet on the phone) and switch this assistant to Process; the mode survives a reload and shows on a second context of the same account; open the assistant from a Window tile in Bot mode and pin it back to a window; on the phone, back returns to the list and the window's tiles swipe; no T5 word in any frame.

**Measure:** T1 and T5 again with Task A0's commands, on the I3b build; both must hold, and the results go in section 10 beside the control and I3a.

**Then:** `pnpm test:components`, `pnpm test:preview-browser`, `pnpm test:e2e:flows`, `pnpm test:e2e` (the older specs, `bot-mode.spec.ts` re-pointed), full `pnpm verify`; the owner reviews section 9 on `pnpm local`.

## 8. Acceptance

- **I3a:** sections 4.1 and 4.2 hold as vector tables; every section 5 row of I3a has a passing test; T1 and T5 hold against the control at 4x CPU and 100 ms; E10 passes at desktop and 390 × 844 in Chromium and WebKit; both themes AA; motion still stops under reduced motion; the ratchet falls.
- **I3b:** every section 5 row has a passing test; the window, dock and succession suites pass unchanged in intent; E6, E9 and E10 pass at both widths and in WebKit; the launcher-row invariant holds on every new phone screen; T1 and T5 hold; no production CSS growth net.
- **Both:** `pnpm verify`, `pnpm arch:check`, `pnpm compatibility:check`, `pnpm fixtures:check`; the owner's review on `pnpm local`.

## 9. Verification on `pnpm local`

1. `ARC_LOCAL_JOURNALS=1 pnpm local up` on free ports; open a Claude Code and a Codex assistant.
2. Send a prompt that reads and edits files; watch the live line; check the work line in Concise, Process and Full; open a step and find its diff.
3. Trigger a tool approval; answer it inline with Allow, then another with Show what changes and Allow for session.
4. Hand off to a new session; see the session-change line.
5. (I3b) The three panels; each sentence in the sidebar (working, needs you, idle, ended, Host offline by stopping the Controller, resting by Sleep); details sections; change the avatar.
6. (I3b) Window mode tiles; open one in Bot mode; pin it back.
7. On an iPhone over the local network and as an installed web app: home list, back gesture, details sheet, tile swipe, the keyboard and Return; the avatars' CPU (I2 section 9, step 5).
8. Captures as `.tmp/i3-after-*.png` beside Task A0's.

## 10. Results

Filled in per task: commits, suites and counts, the T1 and T5 table (control, I3a, I3b), the mapping doc, the ratchet's before and after, and deviations.

### I3a

**Commits** (on `design/im-session-service`, from `4cc45240`): catalogue `4ce19c78`; A1 `c5c17137`; A2 `21d757c8`; A3 `48451995`, `4a68ec5f`; A4 `32457521`; A5 `dcf7c669`; A6 `fae25120` (the stored field), `ed490f5d` (the Lab); A7 `d9be49f3`; A8 and A9 `9a2f2160`; A10 `e25e93c9` (scripted turns), `8581fd25` (E10); found on `pnpm local` and fixed: `b2689732`, `53bb8558` (one avatar per assistant in Window and Bot mode), `bfc1f691` (a person's bubble keeps its actions off its words), `8dcb81a8` (render cost); found by the full browser runs: `b68a5f6e` (revealed letters and search hits, the phone actions row, the last re-pointed specs); compatibility `2ca96b5d`, `b89cefac`, `797df78d`, `95d9c028` and in `b68a5f6e`; these results in the commit after. A0 measured the control on `4cc45240` and has no commit.

**Deploy.** The per-assistant mode is a new optional field of the stored bot details (`WindowBotDetails.process`): deploy the Relay first, then the website. The device default stays in the browser (`agent-remote:process-mode`).

**Inventory.** `assistant-inventory.spec.ts` has one test per section 5 row: the 35 I3a rows pass in chromium-desktop, chromium-mobile, orchard-phone-chromium and orchard-phone-webkit (390 × 844); the 9 I3b rows (H4, H5, W1 to W7) are skipped until B9. Its Chinese tests check the design voice, the live line and the day line in zh-CN.

**T1 and T5** (`pnpm local`, 4x CPU, 100 ms RTT, Task A0's commands; I3a twice, on `797df78d` and on `95d9c028` after the render cost fix):

| | Control `4cc45240` | I3a run 1 | I3a run 2 |
|---|---|---|---|
| T1 mount → content, p50 / p95 (n = 50 reloads) | 0 / 142 ms | 0 / 159 ms | 137 / 155 ms |
| T1 content, p50 / p95 | 258 / 396 ms | 254 / 372 ms | 341 / 404 ms |
| T1 opens whose pane mounts before its binding ("Start with a Provider" first) | 1 of 5 sessions (134–148 ms) | 1 of 5 (153–175 ms) | 3 of 5 (143–172 ms) |
| T5 opens with a connection word | 0 of 10 | 0 of 10 | 0 of 10 |
| T5 Sending, typed during the open, p50 / p95 (n = 10) | 70 / 75 ms | 85 / 106 ms | 68 / 82 ms |
| T5 Sending, first send of a view, p50 / p95 (n = 3) | 122 / 145 ms | 246 / 274 ms | 196 / 198 ms |
| T5 Sending, second send, p50 / p95 (n = 3) | 49 / 50 ms | 91 / 109 ms | 85 / 103 ms |

Every open whose pane mounts with its session paints content in the mount frame (0 ms) in every arm; T1's p95 comes from the runner's rebinding of the selected view, which leaves a pane empty for one frame, and which sessions take that path changes between runs. Run 1 found the timeline making two to four `Intl.DateTimeFormat`s per turn on every render (8.9 ms per render of 150 turns in jsdom); `8dcb81a8` caches them and memoizes the day lines (2.3 ms). The remaining send cost is style and layout of the larger bubble DOM, forced when the reading position is restored after the outgoing row appears: removing the timeline's avatar animations does not change it, removing the three new `:has()` rules takes 2 to 7 ms off, and `content-visibility: auto` on earlier turns about 7 ms (a candidate for I3b). The T5 session had grown from 254 to 286 history rows between the control and run 1. `open-fresh` stops in every arm at the Copilot session after the Relay's sign-in limit.

**Suites.** Unit (`pnpm verify`): agent-client 733 tests (1.6 s), agent-client-web 848 (9.0 s), agent-remote-lab 3,267 (73 s), agent-remote-seams 406 (9.5 s), agent-e2e 126 (3.4 s), protocol 468 (1.7 s), relay-core 1,207 (7.4 s), controller 2,008 (56 s), debugger 155 (25 s), relay-node 286 (10 s), and the other suites. Components: 679 passed and 113 skipped by project (11.0 min), whose 18 failures were the five specs that still counted separators or read the old display, re-pointed and passing (60 passed, 1.0 min). Preview browser: the first run failed 13 tests of three specs written for per-view letters and the content display; re-pointed (see the mapping), the rerun passed 72 of 73. The one left, `session-recovery` "restores sessions and failed input across mobile page lifecycles in webkit", is unchanged by I3 and fails on a WebKit "access control checks" page error of the hosts request in 2 of 3 runs alone; it passed in the first run. `pnpm test:e2e:flows`: 35 of 37, the two E1 reading flows needing Full to read tool rows and reasoning; with it E1 and E10 pass. E10 passes at 1280 × 800 and 390 × 844 in Chromium and with `E2E_BROWSER=webkit`. `pnpm verify` passes on `b68a5f6e`: compatibility, architecture, build, typecheck and 11,974 unit tests in 27 suites. `arch:check`, `compatibility:check` and `fixtures:check` pass. A Controller test (`journal-publisher` backoff) failed once under the load of a parallel real turn and passed alone three times.

**Ratchet and CSS.** `styles.css` 448 → 434, `app.css` 582 → 568, `earlier-conversation.css` 10 → 0, `session-view-options.css` 25 → 24, `typing-bubble.css` deleted. Production CSS of the Lab and the Session View without `theme.css` and `primitives.css`: 4,271 → 4,253 lines. Entry chunk 67.6 KB gzip (budget 70), App chunk 577 KB (600).

**Mapping.** `docs/superpowers/specs/2026-11-20-i3-test-mapping.md`.

**Captures.** `.tmp/i3-before-*.png` and `.tmp/i3-after-*.png`: Bot and Window mode, desktop 1440 × 900 and phone 390 × 844, light and dark, English and Chinese (16 each). A real Claude turn on `pnpm local`: `.tmp/local/i3a-turn-{live,approval,done,open,full}.png` (the live line, the inline approval answered with Allow, the one-line receipt, the work line opened, Full with the step's diff). The three modes per theme and locale: the `assistant-conversation` screenshots in `packages/agent-remote-lab/test-results/`.

**Deviations.**
- `WindowBotDetails.process` also stores Concise: an assistant can be Concise on a device whose default is not; a choice equal to the device default clears the field.
- `WorkStep.entries` is always an array. The vectors live in `@orchardworks/agent-client/testing` (`TURN_VECTORS`); the check against recorded Claude, Codex and Copilot rows is seam S6, since `agent-client` has no provider packages.
- Answered interactions are one-line receipts outside the work line (still `interaction_receipt` steps in the fold); Full keeps them one line.
- Show what changes is a `<details>` disclosure. `agent-remote:show-letters` became the device's letters choice; only `timeline-display` is removed.
- Bot mode no longer forces content: it reads the process mode as Window mode does.
- A message's bubble lists only its attachments in Concise and Process; Full lists every resource it named, as the preview display did.
- The `--agent-*` variables were not re-pointed to Orchard tokens at `:root`; the ratchet still falls rule by rule.
- Existing detail strings (step headers, Allow once and for session, tool labels) stay English; they move in I4.
- The Window view's `display` record and `window view display` remain in the protocol and the command line, unused by the Lab.
- A plain session's assistant is named by its title, so a prompt-titled session reads "Reply with … is working"; naming is I3b's.
- E10 checks Full before opening the step: a step the reader opened stays open across a mode change.
- The scripted provider reports the session running with its active turn and idle after it, as real providers' runtime updates do.
- Letters are this device's choice; a letter a search or Trace opened shows in its view while it is the target and leaves the choice as it was. A search reveal lasts while the search targets it.
- A turn wraps its rows, so a row whose turn changes (the person's message before it left the window) is rebuilt; every other row keeps its node through a journal replacement.

## 11. Open questions for the owner

1. **English or Chinese words.** The design's sentences are Chinese and the product is English today. I3 writes English in the design's voice (decision 9). A Chinese locale would be a separate step with a string table; say if you want it in I4.
2. **Narration between steps.** In Concise, an assistant's short remarks between tool calls ("Let me check the tests") fold into the work line, and only the final answer stays as a bubble (decision 1). The alternative keeps every assistant message as a bubble and folds only tool work, which is noisier for Claude Code and Codex turns.
3. **The default for all assistants is per device** (decision 4). A per-account default would need a new account settings record at the Relay; say if you want it.

## Owner decisions (2026-11-20)

1. **Language follows the browser.** Every user-facing string comes in English and Chinese, chosen from the browser's language. English is the fallback.
   - The new strings of I3 are written in both languages from the start: status sentences, work lines, approval choices and the session-change line. Chinese uses the design's voice.
   - A small message catalogue with a pure `t(key, params)` and plural rules is added in I3a, before A2. A unit test fails on a key that is missing in either language.
   - Existing English strings move to the catalogue screen by screen as I3 touches them. The rest move in I4.
2. **Concise mode** folds the assistant's short remarks between tool calls into the work line. Only the final answer of a turn stays a bubble.
3. **The default process mode is stored per device**, as planned. The per-assistant choice is stored per account.

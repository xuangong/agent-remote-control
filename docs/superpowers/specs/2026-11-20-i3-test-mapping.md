# I3 test mapping

Tests that I3 deleted, merged or re-pointed, each with the test that now owns its rule and the mutation that proves it
([write-tests](../../../.agents/skills/write-tests/SKILL.md), section 5). "Deleted with the feature" means the rule itself is
gone: the display modes, the per-view display record, Bot mode's forced Content only and the timeline header no longer exist.

## I3a

### Rules that moved into pure modules

| Old home | Rule | New owner | Mutation checked |
|---|---|---|---|
| `groupRuntimeNotices` (`RuntimeNoticeGroup.tsx`) | Consecutive notices are one group | `foldTurns` T-4, `TURN_VECTORS` "consecutive notices are one step"; the UI rows of `AgentTimeline.notices.test.tsx` | Not joining errors in `foldTurns`: 5 vector tests and 11 notice and performance UI tests fail |
| `groupBackgroundActivity` (`BackgroundActivityGroup.tsx`) | A check's quiet rows are one group; failed and visible output stays | `foldTurns` T-2, T-3, T-4 rows; `AgentTimeline.test.tsx` "groups trusted quiet checks…" (Full) | Same mutation for background groups: T-2, T-3 and T-4 rows fail |
| Timeline (no turn model) | Answer versus narration; only the last turn runs | `foldTurns` T-3, T-6 | Narration read as the answer: 2 T-3 rows fail; an ended turn allowed to run: 2 T-6 tests fail |
| `TimelineDisplay` modes | Which steps show and at which level | `workDisclosure` (the disclosure table, 40 rows); `AgentTimeline.turns.test.tsx` (6 mode rows) | Process staying open after the turn: 1 row fails; a search hit not opening Concise: 4 rows fail |
| — (new) | The work line's words | `workSummary` vectors | Dropping the failure count: 2 tests fail |

### Deleted with the feature

| Test | Rule | Where the surviving part lives |
|---|---|---|
| `LabWorkbench.display.test.tsx` "changes one view without filtering its neighboring conversation or letters" | One view's display choice | Process mode per assistant: `useProcessMode.test.tsx` "takes the assistant's own mode…" (another assistant follows the device) |
| … "restores native-session preferences without carrying them into another session or relay" | Per-session record | Deleted with the record |
| … "reveals filtered trace entries only in their owning view and preserves the letters choice afterward" | A Trace target shows in its view | `AgentTimeline.turns.test.tsx` "opens the turn a search hit is in…"; `App.test.tsx` "opens the work line of an execution event opened from Trace…", "shows a hidden letter opened from Trace…" |
| … "uses the same display controls in a standalone session view" | View options in the standalone view | `SessionViewOptions.test.tsx` (both locales) |
| … "migrates existing display choices while honoring a new view default" | Old keys | `useProcessMode.test.tsx` "removes the display modes of earlier releases once" |
| … "retains independent display owners across native replacements and checks failed unmounted writes" | Display owner retention | Deleted with the record; text and image owners keep their tests (`session-composition.test.ts` now fails the apply through a draft write) |
| … "treats damaged display storage as unknown and refuses stale retention" | Damaged storage | `useProcessMode.test.tsx` "…reads an unknown stored value as none" |
| … "recovers an absent display read without persisting an inspection default", "preserves an explicit unmounted display preference over a later content default" | Per-view record | Deleted with the record |
| `LabWorkbench.fixed-display.test.tsx` "locks Bot content without changing the Window display or text/image editor owners" | Bot mode's forced Content only | Deleted with the feature; Bot mode reads the process mode like Window mode |
| … "keeps approval, settings, interrupt and failed delivery controls available in fixed content" | Controls in Bot mode | The same controls are the normal ones: `LabWorkbench.test.tsx` (approval through Allow, interrupt, settings), `App.bot-attention.test.tsx` |
| `e2e/components/content-only-view.spec.ts` | Content only hides execution and keeps decisions | `assistant-inventory.spec.ts` (I8 receipts, D1, E1 in Concise), `assistant-conversation.spec.ts` (Concise screenshots, contrast) |
| `e2e/components/simple-conversation.spec.ts` | Headers without previews | Summary level: `AgentTimeline.turns.test.tsx` (Concise and Process rows), `TimelineDisplay.test.tsx` (step level), `assistant-inventory.spec.ts` T1 |
| `AgentTimeline.test.tsx` "keeps a host-hidden header out of the conversation without removing entries" | The timeline header | `assistant-inventory.spec.ts` H1 (agent id, status, epoch in the Replica Inspector) |
| `App.test.tsx` "switches conversation previews from View and restores the browser preference" | Choosing and keeping the level | Merged into "chooses the process mode for every assistant on this device from View, exclusively, and keeps it after remount" |
| `TypingBubble` presence (`App.bot-attention.test.tsx`) | A working bot shows presence | Re-pointed: the live line (`.agent-turn-status`) |

### Variants collapsed

Tests that ran once per display mode now run once, or once per process mode where the mode matters:
`AgentTimeline.test.tsx` tunnel actions (3 → 1, Full), `AgentTimeline.notices.test.tsx` (3 → 1 for the closed group; the search
reveal in Full and Concise), `AgentTimeline.selection.test.tsx` (Full and Concise), `AgentTimeline.prompt-edit.test.tsx` (2 → 1),
`AgentCommunication.test.tsx` letters (Concise, Process, Full), `ToolCallItem.test.tsx` (preview and summary levels),
`session-letters.browser.ts`, `conversation-previews.spec.ts`, `image-viewer.spec.ts` (the device's Concise and Full).

#### Rules that changed place

| Test | Before | Now |
|---|---|---|
| `timeline-time.spec.ts` "desktop titles show local time by default and toggle together on double click" | A message's title showed its local time on desktop | A bubble has no title: its time shows under it on hover (`.agent-bubble-time`), the date is in its label and on the day line. Steps keep their title time. A double click on a step title or Alt+T inside a message hides or shows every time, in every timeline ("desktop step titles show local time, bubbles show it on hover, …"). The mobile swipe reveal is unchanged. |
| `conversation-previews.spec.ts` "…the answered question's preview" | Preview mode showed the answered question's text | An answered question is one receipt line in every mode; the spec opens it and finds the question in its detail (inventory row I8) |
| `view-overflow.spec.ts` "…compact and readable in simple" | The simple display | Concise with the work line open, the summary level; the pending requests are counted in `.agent-turn-requests` |
| `ask-timeline-layout.spec.ts` | A bare timeline in the simple display | The same timeline in Concise with its work line open |
| `message-delivery.spec.ts` "shows a pulsing outgoing message…" | A sending message pulsed to half opacity | A sending bubble keeps full opacity (half would fail AA); "Sending…" says its state |
| `pane-navigation.spec.ts`, `session-family-resize.spec.ts`, `tpm-dock.spec.ts` | Every separator on the page was a resize handle | Day lines are separators too; the specs count and focus the handles by their "… width" names |
| `tpm-dock.spec.ts` "TPM delegation…", `trace-inspection.spec.ts` | Steps showed in the preview display | The page opens in Full, today's preview level |
| `session-letters.browser.ts` | Each view had its own letters choice | Letters are this device's choice: a side or child view hides them too, except the letter it was opened on; a letter of a turn without a prompt shows after that turn's answer, so the specs check it is brought into view, not its offset |
| `App.test.tsx` "shows a hidden letter opened from Trace…", `AgentCommunication.test.tsx` "toggles letters independently…" | Opening a hidden letter from Trace turned letters on | The letter shows in its view while it is the target and Show letters keeps the reader's choice, as the per-view rule did |
| `session-search.browser.ts` | A search hit showed in the content display only while selected | A hit opens its turn's work line while it is the target; closing the search closes it again (`AgentTimeline.turns.test.tsx` "closes the turn a search opened…") |
| `journal-replacement.browser.ts` "keeps every unchanged row node…" | Every unchanged row kept its node | Rows keep their nodes unless their turn changed: rows after a person's message that left the window join the turn before and are rebuilt there |

## Re-pointed without a rule change

Assertions on a step, a receipt's detail or an approval's full decisions open the work line, the receipt or Show what changes
first, or render Full (today's preview level): `AgentTimeline*.test.tsx`, `InteractionItem.test.tsx`, `ToolApprovalCard.test.tsx`,
`InteractionCapabilities.test.tsx`, `InteractionPanel.test.tsx`, `renderer-registry.test.tsx`, `TimelineSearch.test.tsx`, the
journal replacement transport test, and in the Lab `LabWorkbench.test.tsx`, `App.test.tsx`, `App.children.test.tsx` (activity
links live in the spawning step: these readers choose Full), `App.succession.ask-and-reconnect.test.tsx`, `TpmWorkspace.test.tsx`,
`SessionMenus.test.tsx`, `EarlierConversation.test.tsx`, `tool-approval.spec.ts`. The debugger's specs follow the same changes.

## I3b

### Rules that moved into pure modules

| Old home | Rule | New owner | Mutation checked |
|---|---|---|---|
| `botActivityLabel` (`bot-roster.ts`), the Bot heading's chain (`useSessionViewPresentation`), `activityLabel` (`session-activity-status.ts`), `botMood` (`BotRoster.tsx`) | What an assistant is doing, in words and mood | `assistantStatus` and `assistantStateWord` (`assistant-status.vectors.ts`, 40 rows; invariant A-1 over 1,280 fact combinations) | Waiting read as working: 9 Lab tests fail (`BotRoster.test.tsx` 4, `App.bot-attention.test.tsx` 2, `SessionDock.groups.test.tsx` 2, `WindowMenu.test.tsx` 1). Working before needs you: 3 vector rows. `offline` alone as working: 2 tests (a vector row and A-1). |
| — (new) | An assistant is called by a name, never its prompt | `assistantNames` (`assistant-name.vectors.ts`, 11 rows) | The display name before the short agent name: 2 rows fail |
| — (new) | The files a conversation changed or shared | `sessionFiles` (`session-files.test.ts`, 9 tests) | Keeping the oldest change: 3 tests fail |
| — (new) | Which place a tile opens in Bot mode, which Window a pin shows | `botPlaceForTile`, `windowRouteForPin` (`workbench-mode.test.ts`, 13 rows) | Vector rows only |

### Moved with the feature

| Test | Rule | Where it lives now |
|---|---|---|
| `BotWorkspace.menu.test.tsx` (7 tests: Label, details formed in the same change, Hide with Undo, Remove after confirming, Info, Sleep with Undo, asleep while open) | A bot's own actions | `components/assistant/AssistantDetails.test.tsx`, through the name card's buttons; "Info" became "shows where a bot runs in its details" |
| `App.bot-succession.test.tsx` "continues a handed-off bot…" (the Info part) | The providers of earlier sessions | The same test reads the details' Where it works ("before: …") |
| `BotWorkspace.test.tsx` "shows the shared sidebar header, a toolbar above the conversation, and collapses the roster" | The sidebar header and the conversation's heading | Kept, re-pointed to the wordmark and the top bar; collapsing went with the feature |

### Deleted with the feature

| Test | Rule | Why |
|---|---|---|
| `BotRoster.test.tsx` "offers a bot's own actions as a context menu on its row…", "leaves a long press to the phone…" | The roster's right-click menu | The actions are on the details card (B3), tested there |
| `BotWorkspace.test.tsx` "moves focus from a collapsing roster to the sidebar button" | Collapsing Bot mode's roster | The three panels replace the toggle; ⌘\ now toggles Window mode's sidebar only (`App.bot-mode` and the re-pointed sidebar header test check that it hides nothing in Bot mode) |
| `state/panels.test.ts` (the `botRoster.toggle` half of "shows and hides the sidebar…") | Bot roster collapse state | Deleted with the state (`botRosterCollapsed`) |

### Rules that changed

| Test | Before | Now |
|---|---|---|
| `session-activity-status.test.ts` `windowActivity` row `['idle', 'starting']` | A starting session needed the owner | A starting session works (`assistantStatus`: starting → working); the overview counts it as working |
| `WindowMenu.test.tsx` "marks each bot's place and status…" | `starting` read "Needs you" | The row that asks for the owner is `waiting`; words come from `assistantStateWord` |
| `bot-roster.test.ts` "uses live urgency…" | A group heading said its most urgent word | Each row says its own sentence; the group heading carries the unread dot only |
| `App.bot-mode.test.tsx` "moves the floating entries into the sidebar…", "keeps the Team entry mounted…" | Without the sidebar the entries floated | They take a row of the Window toolbar (the coordinator's overlap defect); the same element moves, its panel stays open |
| `BotWorkspace.test.tsx` "goes back to the assistant list from a chat on a phone…" | Back set the list visible at once | On a phone, opening a conversation is a history entry and Back pops it (`useWorkbenchMode.test.tsx` covers both paths) |
| `App.succession.ask-and-reconnect.test.tsx` "keeps post-upgrade view preferences…" | The tile heading's View options | The tile's details, Process |

## Re-pointed without a rule change (I3b)

`[aria-label="Bots"]` became `[aria-label="Assistants"]` in the Lab, `agent-e2e` and `bot-mode.spec.ts` selectors; `New bot` became
`New assistant`, `Back to bots` became `Back to assistants`; roster status classes (`.lab-bot-status`, `.lab-bot-preview`,
`.lab-bot-typing`) became `.lab-bot-sentence` with `data-state`; a test that clicked the Windows entry or a Track row finds it in
the launcher bar or toolbar row as well as floating.

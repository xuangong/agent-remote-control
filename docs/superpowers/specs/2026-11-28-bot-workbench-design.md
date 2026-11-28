# Two kinds of Window workbench: free and bot

Design for the owner decisions of 2026-11-28. No product code is written here. Old data may be dropped and there is no transition
layer (memory: fold-data-loss-ok, controller-upgrade-compatibility); this design needs neither. Names in code stay `Window*`;
the word "workbench" is used in this text for what the person sees (see open question 3).

## 1. Decisions this design builds on

From the owner (2026-11-28), binding:

1. A Window becomes a **workbench** of one of two kinds. A **free workbench** is today's Window, unchanged. A **bot workbench** is a
   customised free workbench bound to one bot. It shows: the bot's **main session** (primary tile); its **sub-sessions** (tiles added and
   removed automatically as the bot starts and ends them; ordered needs-you, working, idle; ended folded); the coding agent's **native
   subagents** (child sessions) under the session that ran them (openable, folded by default); its **answer sessions** (a folded group);
   the person's **`/side` sub-sessions** started from it (marked as the person's); its **ledger** as a side panel (an item's owner links
   to its tile); and its **staff bots**, for switching to their workbenches. The person can add other sessions and rearrange.
2. Accepted rules: creating a Window offers "free" or "a bot's workbench"; a bot's chat and details have **Open workbench**; a free
   workbench can be **bound** to a bot and a bot workbench **unbound** back to free, keeping its tiles. The CLI handoff's `--window`
   intent returns later, for free workbenches.
3. Reuse the current Window and group model; derive the bot workbench's tiles from the bot's live sessions instead of storing them.

From the code (checked on `main` at `89913a24`):

- A **group** is `{ window, bots?, presentation? }` (`window-groups.ts`). `window` is a strict `WorkspaceWindow` of `views`; a view is
  `primary`, `attached` (a Side or subagent view, with `attachedTo`), `dock` or `float`. A group is shown in Window mode unless
  `presentation.window === false` and in Bot mode unless `presentation.bots === false`. A **bot** is a view in a group with bot details
  (`bots.members[viewId]`, with `botId` and `chief`); one session is at most one bot (rule 5); a bot keeps its conversation (rule 1).
- A view can carry `feature: { kind, id, metadata? }` and `bindingPolicy: 'managed'`. The Relay stores the tag opaquely (`kind` and `id`
  are only pattern-checked); a page that does not know a kind treats the view as ordinary. `view.bind` on a managed view is refused;
  `layout.apply` replaces the whole layout in one revision.
- The page already holds everything the bot workbench shows, as `Team` records through `taskDirectory` (`features/tasks/task-directory.ts`):
  `owned(owner)` (a bot's sub-sessions, `TaskView` with state `queued|working|needs_input|idle|ended`, title, current step, last work,
  result, worker locator, `subSessionId` `s_…`), `sides(from)` and the `startedBy: 'person'` Teams, `answering(botId)` (answer sessions),
  `boardOf(botId)`, `assignees`, `staff(botId)`, `chief(botId)`, `openBot`. Native subagents are `runtimeInfo.childSessions` of a
  session's replica (`AgentChildSession`: id, title, role, status, `observation`), opened as an attached view (`useChildSessions`).
- The dock rail renders a Window's primary groups side by side (`SessionDockRail`, `PrimaryGroupPane`), with fold, resize and select; a
  phone stacks them one per screen and swipes (`TileStack`). Bot mode is roster, conversation and details, with a push/pop stack and kept
  conversations on a phone (`navigation-stack.md`, N1 to N12).

## 2. Summary of the design

- **One new fact is stored: which bot a Window is bound to.** It is a tag on the Window's main tile, `feature: { kind: 'bot', id: <botId> }`
  with `bindingPolicy: 'managed'`. No protocol, Relay, Controller or CLI change. An older page shows the window as an ordinary
  one-tile Window.
- **Everything else the bot workbench shows is derived** at render time from the bot's live sessions and the Window document, by one pure
  projection. The Window document is written only for what the person does (add, move, resize, bind, unbind, open a native subagent
  beside a tile), never because a sub-session started or ended.
- **A session appears once.** A stored tile (person-made) and a derived tile for the same session are one tile; the stored one wins.
- **A tile the person is using never moves under them** (the "hold" rule, section 5.4). Everything that is automatic is automatic only
  where the person is not looking.
- **Desktop: the free workbench's rail with derived tiles in it. Phone: a stack**, whose home is a list of the bot's work, and whose
  conversations are pushed full screen, as Bot mode does today.
- **Bot mode is unchanged.** It stays the chat-first surface. The workbench's main tile and Bot mode's conversation are the same
  conversation (same session, replica, draft and reading position), mounted in one place at a time.

## 3. Data model

### 3.1 Stored and derived

| Fact | Where | Why |
|---|---|---|
| Window is a bot workbench of bot B | Stored: tag `feature { kind: 'bot', id: B }` on one view of the Window | The only fact that cannot be derived; must sync across devices |
| Main tile: B's main session | Stored (the tagged view, `primary`, `managed`), kept equal to B's current main session | It is the anchor for width, selection, and native subagents attached beside it; its binding is a cache (5.1) |
| Person-added tiles, their order, widths, folds, geometry, attached native subagents | Stored: ordinary views | It is a free workbench underneath |
| Sub-session tiles (bot-started) | **Derived** from `owned(B's main session)` | Lifetime belongs to the bot; no write when one starts or ends |
| Person's `/side` tiles | **Derived** from Teams with `startedBy: 'person'` whose main is the main session or one of its tiles | Same |
| Answer sessions | **Derived** from `answering(B)` | Same |
| Native subagents of a session | **Derived** from that session's replica `childSessions`; a person-opened one is a stored attached view | Same; opening is a person's act |
| Ledger, staff, chief | **Derived** (`boardOf`, `staff`, `chief`) | Already the Relay's records |
| Which derived tiles the person expanded; which one is selected | Page state per device (`localStorage`, keyed by Window id) | A glance is not a document edit; see open question 2 |

The Window's `title` is stored as the bot's name when the workbench is created, but a bound Window displays the bot's current name.

### 3.2 How the binding is recorded

The tagged view is the first `primary` view with `feature.kind === 'bot'`. The binding is **derived from the document**: a Window is a bot
workbench if and only if it has such a view; a second tagged view (from a race or a hand edit) is an ordinary view. There is no separate
"kind" field to disagree with the views.

The group is created with `presentation: { bots: false }` (the create request already carries `presentation`), so a bot workbench does
not produce a second roster section in Bot mode and its main tile never competes with the bot's own view for rule 5 (the workbench group has no `bots`).

Why a tag and not a new group field (`workbench: { botId }` beside `window`, `bots`, `presentation`): the field is the cleaner shape but
changes the strict group schema, the Relay row, `list`/`inspect`/`changes` responses, the CLI, fixtures and compatibility metadata, and
an older Worker would refuse the strict field. The tag costs nothing beyond the page and degrades well (an older page sees a normal
Window with a managed tile). If a second kind of binding ever needs more than a tag, promote it to a field then (open question 1).

`bindingPolicy: 'managed'` on the main tile gives, with no new code, a tile that offers no "change session" and that the Relay refuses
`view.bind` for, which is the rule-1 behaviour (a bot keeps its conversation).

### 3.3 Bind, unbind, create, open (all through existing edits)

| Action | Edit |
|---|---|
| Create a bot workbench for B | `WindowGroupCreateRequest` with `presentation: { bots: false }` and one `primary` view bound to B's main session, tagged and managed. Window id `wb-<botId>` so two devices creating it at once converge (the second create is refused as existing and the page opens the first); a random id when `wb-<botId>` exists but is free (unbound) |
| Bind a free workbench to B | One `layout.apply`: if a view already shows B's main session, tag it and mark it managed (it moves to first place); otherwise add the main tile first. Other views are untouched; a stored view for a session that is B's sub-session simply becomes the stored tile of that session |
| Unbind | One `layout.apply`: remove the tag and the managed policy from the main tile. **Keeps what is shown**: each expanded derived tile and each adopted tile becomes an ordinary stored view (folded ones as folded), so "tiles kept" holds; ended and folded groups are not written |
| Rebind the main tile when B's main session changes (handoff, succession) | `layout.apply` writing the new binding, by whichever device sees the difference; idempotent. Display never waits for it: the tile shows the derived main session |
| Open workbench of B | Find the Windows that have a tag for B; open the most recently used (`window-recency.ts`); none: create |
| B is retired | The tile shows "This bot no longer exists" with Unbind; derived tiles are gone because nothing owns them |

Derived tiles do not count toward the 64-view limit of a Window; only stored ones do.

## 4. What the bot workbench shows

Order on the desktop rail, left to right (section 5.4 says why stored tiles come before derived ones):

1. **Main tile**: B's main session. Never closable while bound (Close is replaced by Unbind); can be folded.
2. **Stored tiles**: the person's own, in stored order, including attached native subagents opened beside any tile and sub-sessions the
   person adopted.
3. **Needs you**, **Working**, **Idle** sub-session tiles (derived), in that order; within a state, oldest start first (stable) so a
   tile never reorders for a reason the person cannot see. Each derived tile is **folded** (the existing folded strip: picture or mark,
   name, state, current step or last work) until the person expands it. Needs-you never expands itself; it lights its strip, the header
   count and the main tile's attention chip, because an expansion under the person's hands is a jump.
4. The person's `/side` tiles, in the same state groups, marked **You** (not counted in the bot's limit of 8).
5. **Answers**: one folded strip "Answers (n)" that opens a list (conversation asked from, number of asks, last asked); a row opens that
   answer session as a read-only tile (open question 4).
6. **Ended** (the last 10, as `SubSessionsList` shows): one folded strip "Ended (n)", newest first; a row opens the session read-only
   (history intent).

Rules for a tile:

- **Start**: a derived tile appears at its place, folded. It writes nothing.
- **End**: a sub-session that ends leaves its state group and joins Ended. If the person has it expanded or selected, it stays in place
  marked Ended until the person closes or deselects it (hold rule).
- **Person acts on a derived tile** (expand, select): page state only. **Pin** ("Keep this tile", also implied by resizing, moving or
  opening a native subagent beside it) writes a stored view bound to the same session and tagged `{ kind: 'sub', id: s_… }` for the
  label only. After that it is a stored tile: it stays after the sub-session ends and shows its state as a badge.
- **Dedupe**: a session already open as a stored tile is not derived again. Matching is by session identity (`windowSessionIdentity`).
- **Native subagents** (child sessions of the coding agent): a folded row "Subagents (n, m working)" directly under the heading of the
  session that ran them, in main and in every expanded sub-session tile, listing `childSessions` as `AgentChildSessionList` does today
  (a tree for nested ones). Opening one attaches it beside that tile (the existing Side path) and so adds stored views; the person
  closes it as any attached view. The row appears only for a session whose replica is attached and whose provider reports children
  (provider-support A1 to A6: Codex and DSH direct children, Claude direct local agents, none for pi and others), and shows nothing otherwise, never
  an empty list. The workbench does not attach sessions to look for children (open question 5).
- **Answer and ended tiles are read-only**: no composer, no Stop.
- **Staff bots**: chips in the workbench header: the chief (back) and each staff bot, with its state dot (needs you, working). Selecting
  one is **Open workbench of that bot** (3.3), so it opens its existing bot workbench or creates it on first use. Creation is lazy, so a
  staff of twelve does not make twelve Windows.
- **Header**: bot picture and name, state, attention counts (needs you / working), the staff chips, "Open in chat" (Bot mode place
  `bot`, which opens its conversation), the ledger toggle, the Window menu. Free workbenches keep today's header.

## 5. How it fits the existing code

### 5.1 One pure projection

`projectBotWorkbench(input) → WorkbenchModel` (pure, unit-tested). Input: the group, the bot's details and main session, the Teams
slice, the replica children of mounted sessions, the person's expanded set, the previous model's held tile ids, and the caps. Output:
`{ main, tiles: [{ id, source: 'stored' | 'derived', kind, state, slot, folded, mark?, locator }], answers, ended, children(byTile),
ledger, staff, chief, attention }`. Both layouts render this one model. A stored view that has no derived twin is passed through
unchanged, so a free workbench is the same code with an empty derived input.

Tile ids: stored views keep their ids; a derived tile is `sub:<s_…>`, `side:<s_…>`, `answer:<team id>`. A derived tile is never put in the
document, so `view.select`, `view.resize`, `view.move` and `view.close` still address only stored views; a derived tile's select is page
state, and the first resize, move or pin writes a stored view (the adoption above).

### 5.2 Rendering

- The rail takes `primaryGroups` from the model. A stored tile renders as today (`SessionFamily` with succession and drafts). A derived
  tile renders through the same session conversation surface Bot mode uses for a session place (`SessionConversationMount` with a
  descriptor, `BotPlace` kind `session`), so a derived tile does not need a succession slot or a Window view to be a conversation.
- A folded derived tile does not mount; it reads its strip from the Team record, with no session attached.
- The bot workbench's ledger and staff come from `taskDirectory`; no new Relay read.

### 5.3 Bot mode and Window mode: one conversation

The main tile and Bot mode's conversation for the same bot are the same conversation: the same session, the same replica (one attachment),
the same draft (keyed by session identity in `DraftStore`, which is synchronous, so the IME hazard in the native audit does not apply),
the same reading position (`ReadingPositions`, per conversation). Switching between Bot mode and the workbench therefore continues at the
same line with the same draft. They are not the same DOM: each mode mounts its own surface and only the visible one holds the composer
(invariant: a session's composer is on screen once; a test asserts it). Bot mode keeps its roster, details and navigation stack; it gains
"Open workbench" in the chat's top bar and details. The workbench's main tile heading gains "Open in chat". Pinning an assistant to a
window (`windowRouteForPin`) remains: it makes a free workbench holding the assistant.

### 5.4 Native-app standard (audit of 2026-11-27)

- **Render from local state; no false empties.** The model is a function of stored data (the cached Window, the cached Teams, the cached
  groups), so the first frame is the last known workbench; each input is `Loadable`; unknown renders reserved strips, never copy. There
  is no "no sub-sessions" text at all. Dependency: the Teams feed and Window cache must be readable before the lease confirms
  (audit finding 1, `canRead`); if the Teams are not stored locally yet, step W7 stores them (open question 6).
- **No jumps.** The **hold rule**: a tile is held when it is selected, focused, has an unsent draft or is the one the person is reading.
  A held tile keeps its position in the rail when the model reorders; a tile that left its state group stays and is marked until released.
  The rail compensates its horizontal scroll by the width inserted before the held tile, so it does not move on screen. Derived tiles are
  placed after the stored ones so an automatic change cannot shift the person's arrangement. Reordering animates (FLIP) and honours
  reduced motion.
- **Stack navigation on a phone** with the existing push/pop, kept conversations (3 mounted) and edge swipe (`navigation-stack.md`).
- **Kept-mounted views and scroll anchors.** Expanded tiles stay mounted while visible; a folded or released tile detaches and returns at
  its stored reading position (N3); a derived tile's anchor is keyed by session, so adoption, expansion and the end of the sub-session keep it.
  Desktop mounts every expanded tile; the page keeps the replicas it already retains (main, expanded, attached).
- **Touch**: the workbench uses the shared chrome rules of audit step 4.

### 5.5 The ledger panel

Desktop: a panel on the right of the rail (width resizable like Bot mode's details, 260 to 480 px, collapsed by default below 1180 px),
rendering the existing `BoardList` for `boardOf(B)`. Its owner link, which Bot mode's details use to open the owner's session, instead
**focuses the owner's tile**: scroll it into view, select it, and for a derived folded or ended tile expand it. An item owned by a staff
bot offers "Open workbench" for that bot. The link is the one `AssistantDetailsHostContext` hook (`openOwner(ownerId)`), implemented by
Bot mode as today and by the workbench as focus. Phone: a "Ledger" row on the workbench home pushes the same list; its owner link
pushes the tile's conversation.

### 5.6 Phone

A bound workbench on a phone does not use `TileStack` (eleven swiped screens are not navigable). Its home is a list:

`‹ Back` | bot picture, name, state | staff chips | rows: **Main conversation** (last reply preview), **Needs you**, **Working**, **Idle**,
**You** (the person's sides), **Added** (stored tiles), **Answers** (folded), **Ended** (folded) | **Ledger**.

Each row pushes that session's conversation full screen (the existing push, pop and edge swipe, kept conversations, reading positions); a
native subagent row inside a conversation pushes its child. This is the phone shape of the same model, a list instead of columns. It
overlaps Bot mode's details sheet, which keeps mission, memory, pages and settings; the workbench home is for work in progress. A free
workbench on a phone is unchanged. The entry is **Open workbench** in a chat's top bar and in Windows.

## 6. Creating, binding and opening (page flows)

- **New Window** (`createWindowFromMenu`, the Windows page, the keyboard shortcut) opens a two-choice sheet: **Free workbench** (today's
  path) and **A bot's workbench**, which lists standing bots (the primary bot first, then by recent use) and creates and opens the chosen
  bot's workbench, or opens the existing one. Sub-sessions are not listed: they are not bots.
- **Open workbench**: in a bot's chat top bar and its details (Bot mode), in the roster row menu, in a workbench's staff chips, and
  from an item's owner in the ledger. All call `openWorkbench(botId)` (3.3).
- **Bind to a bot** and **Unbind** are in the Window menu (`WindowMenu`); Unbind confirms with one line saying what is kept.
- The Windows list marks a bot workbench with the bot's picture and shows the bot's current name; its tooltip says it follows a bot.
- A bound workbench is excluded from the default targets of the CLI handoff's `--window` when that intent returns (it adds tiles to a
  free workbench); naming a bound one explicitly still works because it is free underneath.
- **Strings**: English and Chinese together in `agent-client/src/presentation/messages/areas` (new `workbench.*` keys); the key-parity check applies.

## 7. What changes in protocol, Relay and Controller

**Nothing.** The binding is a view tag the strict `WindowView` schema already allows; the Relay stores it; the CLI prints it in
`window inspect`. The sub-session, answer-session, ledger, staff and child-session data are already on the page. Contract-level work:

- A fixture of a Window with a tagged managed main tile (`window-bot-workbench.v1.json` beside the existing Window fixtures), read by the
  protocol decoder, the Relay store and the page; it proves the tag round-trips and that a reader that does not know the kind treats the
  view as ordinary.
- No compatibility metadata or schema digest change (`compatibility.json` is not touched on the task branch).
- The agent skill's text on Windows gains one sentence about the tag (documentation only).

The cases where a Relay or Controller change would be needed are listed so the owner sees what was avoided: a stored group field for
the binding (question 1); children of sessions the page does not hold (question 5); live answer-session opening if the Relay refuses a
page attaching to an ask seat (question 4).

## 8. Tests

Per `AGENTS.md`: unit and integration with mock data; component specs on builder states in a real browser at both widths; one e2e flow.
Each rule below is proved with a mutation check (the rule is broken and the test fails), as the test-mapping documents do.

| Layer | What | Where |
|---|---|---|
| Unit | `projectBotWorkbench`: order by state then start; dedupe stored over derived; ended cap 10 and fold; answers fold; "You" mark and not counted for the bot; folded by default; derived never in the document; hold rule keeps a held tile in place and releases it; `Loadable` unknown yields reserved strips and no copy; a free Window gives the model unchanged | `features/windows` (or a `features/workbench` module declared in `architecture/modules.json`; `pnpm arch:check` decides) |
| Unit | Binding edits: bind tags an existing main tile or adds one; unbind keeps shown derived tiles and writes none of the folded groups; deterministic id and its fallback; `openWorkbench` finds, picks the most recent, creates; a second tagged view is ordinary; managed refusal of `view.bind` | same module; the protocol's own tests are untouched |
| Unit | Rail scroll compensation arithmetic; strip text from a `TaskView`; children row gating by provider support | same |
| Contract | The workbench fixture decoded by the protocol, stored and listed by the Relay store test (existing Window store suite), read by the page | `agent-remote-fixtures`, `pnpm test:unit` for the three packages |
| Integration | `useBotWorkbench` with an in-memory Window authority and a fake Teams feed: a sub-session starting and ending changes the tiles and performs **zero** Window writes; adopt-on-resize writes exactly one view; ended-while-expanded stays; bind and unbind each one revision | page seam |
| Component (browser), desktop 1280 and phone 393 | Builder states: no sub-sessions; one of each state; twelve sub-sessions with ended and answers; native subagents under main and under a tile; ledger with owners. Desktop: strips fold and expand, a derived change before the selected tile leaves its bounding box unchanged (jump check), needs-you does not expand, ledger owner link focuses a tile. Phone: home list, push, back with edge swipe, reading position kept, no horizontal tile swipe. Both: unknown state shows no empty copy | `packages/agent-remote-lab/e2e/components/bot-workbench.spec.ts` and `bot-workbench-phone.spec.ts`; run `pnpm test:components` |
| E2E flow | `e17-bot-workbench.e2e.ts`: real Relay and Controller with a scripted provider. Create a bot workbench; the bot starts two sub-sessions (tiles appear folded, needs-you first); one ends (moves to Ended); the person `/side`s (tile marked You); the person opens a native subagent beside the main tile; bind a free workbench and unbind it (tiles kept); reload keeps place and reading position; staff chip opens the staff bot's workbench. Run in Chromium and with `E2E_BROWSER=webkit` | `packages/agent-e2e/flows` |
| Local | `pnpm local up`: a real Claude Code bot with a sub-session and a native subagent, desktop and phone-sized, screenshots; the iPhone-only checks of the audit list (edge swipe, safe area) stay "device only" | by hand |

Component clauses go in a new `docs/current/agent-remote/components/bot-workbench.md` (one file, one row in `components.md`):
binding, derivation (stored vs derived), order and hold, folding and ended, native subagents, answers, ledger focus, phone list,
local-first. Open items, if any, are one file each in `docs/superpowers/open-items/`.

## 9. Steps (each a commit that builds and tests green; none pushes)

1. **W1 Model.** `projectBotWorkbench`, binding and unbind edit builders, `openWorkbench` resolution, the contract fixture, the unit
   tests with mutation checks, the module declaration in `architecture/modules.json`. No visible change.
2. **W2 Create, bind, open.** The two-choice New Window sheet, Open workbench entries, Bind and Unbind in the Window menu, the Windows
   list marks, lazy creation, `presentation: { bots: false }`. A bound Window shows only its main tile (still no derived tiles). Strings.
3. **W3 Desktop tiles.** Derived tiles in the rail through the conversation surface, folded strips, expand, adopt on touch, the hold
   rule with scroll compensation, the header with attention counts and staff chips, "Open in chat". Component spec desktop.
4. **W4 Ledger.** The right panel with `BoardList`, the `openOwner` host hook, focus on the owner's tile, staff "Open workbench".
5. **W5 Children, answers, sides.** The native subagent row (capability-gated), the Answers and Ended folds with read-only tiles, the "You"
   mark. Component spec states.
6. **W6 Phone.** The home list and pushes on the navigation stack, Ledger row, entry points. Component spec phone.
7. **W7 Local-first and finish.** Teams stored for first-frame render if not yet; `Loadable` inputs; kept-mounted and reading-anchor
   checks; the e2e flow in both engines; `pnpm local up` check; component clauses, `lab.md`, the "Window" to "workbench" wording in strings
   (question 3); `pnpm verify`.

W1 to W3 are the smallest useful release (open a bot's workbench, see its sub-sessions as strips, expand them). W4 and W6 are
independent of each other after W3 and can run in parallel; W5 follows W3.

## 10. Risks

- **Two tile sources in one rail.** Stored tiles and derived tiles render through different content paths (succession slot vs session
  surface). Mitigation: one model and one tile frame; derived tiles never need Window authority; adoption is the single crossing point,
  tested in the integration seam.
- **Jumps from automatic change.** Mitigated by the hold rule and by placing derived tiles after stored ones; a component test measures
  the selected tile's bounding box across a derived change.
- **Memory.** Many expanded tiles are many replicas. Folded by default, no automatic expansion, the bot's limit of 8 live sub-sessions;
  the page already retains only attached replicas.
- **Rebind races.** Two devices rewrite the main tile after a handoff. The write is idempotent by `expectedBinding`; display ignores the
  stored binding.
- **Old pages.** An older page shows the bot workbench as a Window with one managed tile and does not rewrite the tag (it has no code that
  touches `feature` of an unknown kind).

## 11. Open questions, with recommendations

1. **Binding as a view tag or a group field.** Recommend the tag (page-only, degrades safely). Promote to a field only if a second binding kind appears.
2. **Is a person's expand or select of a derived tile stored?** Recommend device-local state; the Window records only adopted tiles. A shared
   expand state would make an automatic tile a document edit.
3. **Naming.** "Workbench" is already the app's word (`WorkbenchView`, `WorkbenchMode`, "the standalone workbench"). Recommend the UI says
   "free workbench" and "bot workbench" and replaces "Window" in strings at the end (W7), while `Window*` stays in code and protocol. The
   owner may prefer to keep "Window" in the UI for the free kind.
4. **Can the person open an answer session, and write in it?** Recommend open **read-only** (it is the bot's session for one asking
   conversation; a person's turn there would join the bot's chain). Needs a check that the page can attach to an ask seat; if the Relay
   refuses, the Answers fold lists rows without opening (as today's details do).
5. **Native subagents of sessions the page has not attached.** Recommend show them only for attached sessions (main, expanded tiles). Retaining
   every working sub-session's replica to count its subagents costs connections for a strip decoration. Revisit if the owner wants counts on
   folded strips.
6. **Are the Teams stored on the device?** If not, the first frame cannot show derived tiles offline. Recommend storing the sub-session
   slice per bot in W7 (a Loadable, `canRead` split of the audit); until then the strips appear when the feed answers, with reserved space.
7. **More than one workbench per bot.** Recommend tolerate it (deterministic id on first creation; Open picks the most recent; extra ones
   are ordinary bound Windows). Enforcing one needs a Relay rule.
8. **Unbind keeps which tiles.** Recommend: the main tile, stored tiles and the derived tiles the person had expanded; not folded groups.
9. **Phone list instead of a swipe through tiles.** Recommend the list: a phone cannot swipe through a dozen screens. A free workbench keeps `TileStack`.
10. **Should the primary bot's workbench be a home destination** (the app opening on it)? Out of scope; the roster and Windows entries come first.
11. **Staff workbench creation on first open** writes a Window per staff bot used. Recommend yes, lazily, hidden from the Bot roster, named by the bot.
12. **The CLI handoff `--window`** returns for free workbenches with this design unchanged; confirm that a bound workbench is not a default target.

## 12. As built (feat/workbench)

Built as designed, with these differences. Main moved to Controller 0.3.10 while the design waited (`read_sub_session`, the timer's roster, CLI link and QR handoff); none of it touches the workbench, which reads the same Teams.

- The rebind of the main tile after a handoff was dropped: the bot keeps its conversation (rule 1) and each Window's succession follows a handed-off session already, so the tile needs no extra write. `rebindWorkbenchMain` was removed.
- The main session that owns sub-sessions is the bot's inbox seat (its current main session), with the tile's binding as the fallback while the inbox is unknown.
- The open choice (new, bind, unbind) lives in `BotWorkbenchProvider` and is requested through a ref, so opening it does not render the whole page.
- The folded Ended and Answers groups are strips of the rail; a row opens its tile (held while selected, as the hold rule says); an opened answer session is read only and stays until folded.
- Opening a native subagent from a derived tile keeps the tile first, since an attached view needs a stored parent.
- The phone list is the whole phone workbench; a free workbench keeps the tile stack. Its Back is the page's history (one entry per pushed screen).
- Teams (tasks, inboxes, answer sessions) are stored on the device (`kernel/team-roster-store.ts`) and stand in until the Relay answers, which is the offline first frame (W7). The roster refreshes every 4 s while a bot workbench is open.
- Not built: the Window menu's Bind and Unbind on a phone (the Windows list has no row menu for them); the stored tiles do not yet show their sub-session state as a badge.

# Bot view: one session grouping, two ways to manage it

Status: proposed on 2026-11-08. The direction (one grouping, a Window view and a Bot view, usable alone or side by side) was agreed with the owner in conversation; this document turns it into rules, data and milestones for review before implementation.

## Problem

A Window arranges several sessions: primary groups, docks, floats, and the Sides and Asks attached to them. It is the right place to follow details, but it does not feel like working with teammates. The common way bots are organized today, as in Grok Bot (xAI, beta since 2026-08-11), is a chat roster: sections in a sidebar, and under each section a list of long-lived bots, each with a name, a picture, a job, one continuing conversation, and a status that says whether it needs you, has a new result or is working.

Our sessions already form groups (the views of a Window), and a Window view already behaves like a long-lived identity: when a session is handed off, the view is rebound to the session that continues it (`windowSuccessionLayout` in `packages/agent-remote-lab/src/window-composition.ts`). What is missing is a second way to look at and manage the same grouping.

## Principles

The two views serve two mental models over one set of data.

- **Window view: details.** Follow the work, compare sessions side by side, open Sides and Asks, quote messages, see tool calls and reasoning, adjust settings. It stays as it is.
- **Bot view: requirements and results.** Say what you need, see what came back, and answer what needs you. Process is collapsed unless asked for.

A grouping can be used in only one of them, or in both. Neither view is the source of the other: they read and change the same grouping. The two views are not exclusive modes: on a wide screen they are open side by side, so a bot's results and its details can be followed at the same time, and either can be closed to use the other alone.

## Model

A **group** is today's Window document (its views and their session bindings) plus two optional appearances. At least one appearance is present.

| | Window appearance | Bot appearance |
|---|---|---|
| Shown as | a Window in the Window view | a section in the Bot view |
| Holds | layout: placement, width, geometry, collapsed, display mode, selection (the existing Window document) | section rank; per bot: label, picture, pinned, hidden; later the read position |
| Members | every view | the group's **bots**: ordinary views (below) |

Every existing Window is a group with only the Window appearance. Nothing changes for it until its owner adds the Bot appearance.

A **bot** is an ordinary view of a group with the Bot appearance: placement `primary`, `dock` or `float` (not `attached`), a session binding that is not a history view (`sessionIntent` absent), no `feature`, and a binding policy other than `managed`. Its name is its session's title (native titles since 2026-11-07, or a rename). Empty views, history views, Subagent views and Ask, Team and TPM views are not bots.

| Bot view | Group data |
|---|---|
| Section | the group (its title is the section name) |
| Bot | an ordinary view |
| A bot's threads | the Sides and Asks attached to its view |
| Group chat | a Team (milestone 5) |
| Lead bot | the group's manager session (milestone 5) |
| Bot status | the session's shared state |

## Rules

1. **A bot keeps its conversation.** A bot's view changes session only when the session is handed off. Opening another session "here" on a bot's view in the Window view opens it beside, as a new view. The Relay refuses a `view.bind` that changes the target session of a bot's view (`bot_view`); updates that keep the target, such as titles, are allowed, and succession keeps using `layout.apply`.
2. **Closing a bot's view in the Window view only puts it away.** The page sends `view.collapse` instead of `view.close`, so the bot stays in its section. Removing a bot is an explicit action in either view and sends `view.close`. Clients that do not know about bots still send `view.close`, which removes the bot; that is consistent with what they show.
3. **Only ordinary views are bots** (definition above). Sides and Asks are threads of the bot they are attached to.
4. **A Window appearance added to a section** keeps the existing layout. Groups created in the Bot view are laid out as they are built: their first bot is the primary view, the others are collapsed docks, so the Window starts tidy however many bots there are.
5. **A session is at most one bot.** Across all of a user's groups with the Bot appearance, no two bots bind the same session (`hostId`, `providerId`, `nativeSessionId`). The Relay checks this after every change and refuses one that would break it (`bot_session_taken`). Views of groups without the Bot appearance may reference any session, as today. A Window view that would create a second bot is refused with a pointer to the section that has it.
6. **The two views coexist and follow each other.** The Bot view and the Window view can be open at the same time. Choosing a bot shows its section's Window in the Window view with the bot's view selected; selecting a bot's view in the Window view opens that bot in the Bot view. A section without a Window appearance leaves the Window view showing what it showed, and offers **Show as Window**, which adds the appearance. The same session may then be open in both views: they share one live connection, the Bot view shows its results and the Window view its details, and each keeps its own draft.

## Bot view

**Layout.** On a wide screen the Bot view is a panel on one side of the page, a roster column and the open bot's conversation, and the Window workbench takes the rest. The panel can be resized, and either side can be closed: Bot view only (the panel takes the page), Window view only (today's page), or both. Which views are open, and the panel's width, are remembered per browser (local storage).

**Sidebar.**
- **+**: New bot (creates a session in the current section, as **New session** does), Add existing session (the session directory, choosing a session that is not yet a bot), New section.
- Sections in rank order, each with its bots: pinned first, then by rank. A section shows the most urgent status of its bots (`windowActivity` in `session-activity-status.ts`).
- Each bot: picture, name, label, and one status: **Needs you** (the session is `waiting` or `starting`: a question, an approval), **Working** (`running`), **Failed** (`failed`), otherwise nothing. **New result** is added with the read position in milestone 5.
- **Hidden bots** at the bottom.
- Bot menu: Rename, Edit label and picture, Pin, Hide, Move to section, Show in Window, Remove bot.

**A bot's page.**
- Header: picture, name, label, status; Threads (its Sides and Asks); Show in Window (opens the Window view beside it when it is closed).
- The conversation in Content only display: requests, plans and progress, decisions, results, errors (`isContentOnlyItem` in `packages/agent-remote-web/src/react/TimelineDisplay.ts`). Tool calls and reasoning stay collapsed. This presentation is fixed for the Bot view and does not change the view's own display setting, which belongs to the Window view.
- Interactions (questions, approvals) and the composer work as in any Session View; model, effort and permission settings stay in the session's settings menu.

**Compact screens.** There is room for one view at a time, so the two are switched rather than shown together, and keep following each other (rule 6). In the Bot view the roster is the home screen and a bot opens full screen with Back; Show in Window switches to the section's Window with the bot's view selected, as the compact workbench shows it today.

## Window view changes

- Groups without a Window appearance are not listed.
- Rule 1: on a bot's view, opening a session from the directory opens it beside.
- Rule 2: Close on a bot's view collapses it; its menu also has Remove bot.
- Rule 5: a refused binding names the section that already has that session as a bot and offers to open it there.
- The Window menu gains **Show as section** (adds the Bot appearance) and, for a group with both, **Separate** (below).

## Linking and conversion

| The owner wants | Operation |
|---|---|
| a section to also be a Window | add the Window appearance |
| a Window to also be a section | add the Bot appearance (its ordinary views become bots; rule 5 applies) |
| to link an existing section and an existing Window | **merge**: the Window's views are added to the section's group, which keeps both appearances; the other group is deleted |
| to separate them again | **split**: the group keeps the Window appearance and its views; a new group gets a copy of the views and the Bot appearance with the bots' labels, pictures and ranks |
| to convert | add one appearance, then remove the other |
| to move a bot to another section | **transfer**: the view, its attached views and its bot details move to the other group |

## Data and Relay

**Storage beside the Window document.** The Window document (`WorkspaceWindow`, schema version 3, strict) does not change. The Relay row that holds it (`SavedWorkspaceWindow` in `packages/agent-remote-hosted/src/window-workspaces.ts`) gains, like its `manager`:

```ts
interface WindowBots {
  rank: string;                       // section order, a fractional index
  members: Record<string, {           // by view ID; absent members use defaults
    label?: string;                   // up to 120 characters
    picture?: { shape: 'circle' | 'rounded' | 'hexagon'; color: string };
    pinned?: true; hidden?: true;
    rank?: string;                    // order within the section
  }>;
}
// on the row:
bots?: WindowBots;
presentation?: { window: false };    // absent: the Window appearance is present
```

Why beside and not inside: `WindowWorkspaceClient.list()` (`packages/agent-remote-web/src/client/window-client.ts`) throws "Invalid Window list." when any one Window fails strict decoding, and so does the Controller's `window list`. A new field inside the document would make every older browser tab and every Controller up to 0.2.77 unable to list any Window once one group had bots.

**Responses.** `list` keeps `windows` (groups with a Window appearance, unchanged) and adds `groups: { window, bots?, presentation? }[]` with every group. `inspect` and `changes` add `bots` and `presentation` next to `manager`. Older clients ignore the new fields and never see groups that have only the Bot appearance.

**Edits.** New edit types go through the existing mutation endpoint, with `baseRevision`, receipts and idempotent operation IDs, and advance the Window revision like any other edit, so every change to a group is ordered once: `bots.add { rank }`, `bots.remove`, `window.add`, `window.remove`, `bot.update { viewId, label?, picture?, pinned?, hidden?, rank? }`, `section.rank { rank }`. A pure `applyGroupOperation` in the protocol package applies them and delegates layout edits to `applyWindowOperation`; after any edit it drops member details for views that are no longer bots. The browser's `WindowWorkspaceStore` keeps the bot appearance next to the Window and applies these edits optimistically like layout edits; the local-first Lab mode stores it beside its local Window.

**Across groups.** `merge`, `split` and `transfer` change two rows. Each runs in one `state.mutate` (the whole deployment is one Durable Object), carries an operation ID and the base revisions of both groups, and leaves a receipt on both rows.

**Checks.** After every edit the Relay checks rule 5 across the subject's rows, and rule 1 for `view.bind`. Bot details are bounded (labels, at most `WINDOW_VIEW_LIMIT` members); the group stays within the existing input size limit.

**Compatibility and deployment.** The Worker is deployed first; it changes nothing visible until a client adds a Bot appearance. Before that deployment, check whether an older Worker accepts a stored state with the new row fields (`validWindowState` ignores unknown row keys, but the Relay snapshot format may not); if not, record the version below which the Worker can no longer be rolled back, as earlier Window changes did.

## Command line

`window inspect` and `window list` print `bots` and `presentation`. New commands: `window bots add|remove`, `window show|hide` (the Window appearance), `window bot <window-id> <view-id> [--label] [--picture] [--pin] [--hide] [--rank]`, `window merge`, `window split`, `window transfer`. The `agent-remote` skill describes bots and sections so a lead session can arrange them.

## Milestones

1. **Data.** Protocol types and `applyGroupOperation`; Relay storage, responses, edits, `merge`, `split`, `transfer`, rules 1 and 5; web client and store. No visible change. Deploy the Worker.
2. **Bot view.** The Bot view panel beside the Window workbench, each closable; roster of sections and bots with status; a bot's page in Content only; Show as section on a Window; New section; the two views following each other (rule 6); compact layout.
3. **Managing bots.** New bot, Add existing session, rename, label and picture, pin, hide and Hidden bots, ordering, Move to section, Remove bot; Window view rules 1, 2 and 5.
4. **Linking.** Add and remove appearances, merge, split, the layout of groups built in the Bot view; command line and skill.
5. **Teammates.** Read position and New result (stored per user without advancing the Window revision, so opening a bot does not wake every page), per-bot notifications, threads, the lead bot, Team as a group chat, a bot's results (files, previews and links it produced).

## Testing

- Protocol: every edit type, pruning of member details, rule 1 and rule 5 checks, merge, split and transfer on documents.
- Relay: responses for older and newer clients (an older `decodeWorkspaceWindow` still lists every Window with a Window appearance), cross-row atomicity and receipts, refusals and their codes.
- Lab: roster, statuses, bot page display, opening and closing each view, rule 6 in both directions, the same session open in both views (one connection, separate drafts), Window view rules; browser tests on desktop and compact sizes.
- End to end on a local instance (`pnpm local`, the `prepare-arc-local` skill): build a section in the Bot view, open its Window, hand a session off and see the bot keep its place, link and split, and list Windows with the 0.2.77 `window` command against the new Relay.

## Open questions

- Which views are open by default: both on wide screens, and the Bot view on compact screens, once milestone 2 ships?
- Which side of the page does the Bot view panel take (left, beside today's session sidebar, or right)?
- Pictures: shape and color only, or also generated and uploaded images (which need storage)?
- Should hidden bots still notify, as in Grok Bot, where hiding keeps a bot's routines running?
- Should sessions that are not in any group (for example started in a terminal) appear as an "Unsorted" section, or stay in the session directory?

## References

- Grok Bot documentation: [Create and manage Bots](https://docs.x.ai/grok-bot/bots), [Message and collaborate](https://docs.x.ai/grok-bot/chat-and-collaboration), [Settings and notifications](https://docs.x.ai/grok-bot/settings-and-notifications), [How Grok Bot works](https://docs.x.ai/grok-bot/how-grok-bot-works).
- Experience reports: [Hacker News launch thread](https://news.ycombinator.com/item?id=49261514), [I Run Grok Bot with BotOps](https://granda.org/en/2026/09/06/how-i-run-grok-bot/).

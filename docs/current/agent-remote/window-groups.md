# Window groups

A Window group is a Window document with two appearances: a **Window** (its layout, shown in Window mode) and a **section** (its bots, for Bot mode, which the website adds in a later milestone). Every group has at least one. Every Window created before sections existed is a group with only the Window appearance. Design: [Bot mode](../../superpowers/specs/2026-11-08-bot-view-design.md).

## Data

The Relay stores a group's section (`bots`: a rank and, per bot, an optional `name` of 1 to 60 characters (the assistant's own name; absent, every client calls the bot by the same generated name and stores it with the bot's first edit, and a session's title is never the name), a label, a picture of a shape (`circle`, `squircle`, `triangle` or `sideways`), a color and an optional gaze from 0 to 5, an optional `process` mode (`concise`, `process` or `full`: how much of a turn the assistant view shows for this bot; absent follows the device's default, and all three values are accepted so a bot can be Concise on a device whose default is Process or Full), pinned, hidden, `muted` (the chat sends no reminders and its unread replies show a quiet dot) and a rank, plus the group's own settings: `muted` and `notifications` (`needs_you` sends only the needs-you reminder; absent, or `all`, sends both reminders)) and its `presentation` (`{ window: false }` when it is not shown as a Window) beside the Window document, not inside it, so older pages and `agent-remote-controller window` still decode every Window (`packages/agent-relay-core/src/window-workspaces.ts`). A stored picture of the older shapes `rounded` or `hexagon` reads as `squircle` with its color (`readBotPicture`); writes accept only the current shapes. Schemas and pure operations are in `packages/agent-remote-protocol/src/window-groups.ts`; the browser reads and changes groups through `WindowWorkspaceClient` in `packages/agent-client/src/client/window-client.ts`.

A **bot** is a view of a section that is not attached, shows a current session (not its history and not a subagent's), and is not an Ask or Team view. Details of views that stop being bots are dropped by every edit and ignored when a group is read.

Ranks are fractional indexes: lowercase letters and digits that compare as strings and never end in `0`, so a new rank fits between any two others.

## Requests

| Request | Answer |
|---|---|
| `GET /v1/windows` | `windows`: the groups with a Window appearance, as before; `groups`: every group with `bots` and `presentation` |
| `GET /v1/windows/:id`, `.../changes` | the Window with `bots`, `presentation` and `manager` |
| `POST /v1/windows` | creates a group; `bots` and `presentation` are optional |
| `POST /v1/windows/:id/operations` | Window edits and `bots.add {rank}`, `bots.remove`, `window.add`, `window.remove`, `bot.update {viewId, details}` (replaces the bot's details), `section.rank {rank}`, `section.settings {muted?, notifications?}` (replaces the group's settings; `all` is stored as nothing), alone or in a batch; the answer carries `bots` and `presentation` |
| `POST /v1/windows/:id/merge` | `{source, sourceRevision, baseRevision}`: the source's views join this group, which gets every appearance either had; the source is deleted |
| `POST /v1/windows/:id/split` | `{newId, baseRevision}`: a group that is both keeps the Window; a new group with the same views gets the section |
| `POST /v1/windows/:id/transfer` | `{viewId, target, targetRevision, baseRevision}`: a bot, the views that close with it and their details move to another section |

Cross-group requests change every group they name in one step, answer with `groups` (exactly those groups; null for a deleted one) and leave the same receipt on each group. A receipt answers a retry only when the same operation is sent to the same group with the same body; `GET /v1/windows/:id/operations/:operationId` reads it from either group.

## Rules

- A group keeps at least one appearance (`last_appearance`).
- A bot keeps its conversation: an edit that binds a bot's view to another session, or to its history, is refused (`bot_view`); title updates are allowed, and succession rebinds through `layout.apply`.
- A session is at most one bot across a user's groups (`bot_session_taken`, naming the section that has it). The check covers the bots of the groups a request changes, so a duplicate an older Worker left behind blocks only edits to the groups involved until one of the two bots is removed. Views of groups without a section may show any session.
- Cross-group refusals: `same_group`, `not_linked` (split needs a group that is both), `view_exists` (both groups have a view with the same ID), `view_limit` (more than 64 views), `bot_attached_elsewhere` (a view that closes with the bot is attached to a view that stays).
- Other refusals: `section_exists`, `section_missing`, `window_exists`, `window_missing`, `bot_not_found`. Layout errors keep the generic `invalid_operation`.

## Compatibility

Older pages and Controllers read only `windows`, so they never see a group that is only a section. Older Workers load rows with `bots` and `presentation` (their state check ignores unknown row fields) and keep them, but list sections as Windows, and their edits do not know the rules: they can delete a group without clearing its section, close or rebind a bot's view, or make a session a bot twice. The current Relay ignores what they leave behind (a deleted row's section, details of views that are no longer bots) and drops it on the next write, so the Worker can be rolled back and forward again.

## Groups as one concept

Chats, the Assistants directory and Window mode show the same groups in the same order (`packages/agent-remote-lab/src/kernel/assistant-groups.ts`):
- **The default group.** New assistant starts every assistant in a group of its own, named after its session. While that group keeps its session's name (one primary bot whose session's title is the group's title, the same test `windowTitleEdits` uses), its assistant is in no group of its own and sits in the default group ("Ungrouped", 未分组). Renaming the group, or moving the assistant into another group, ends that. The default group is not stored, so it has no settings; its chats can be muted one by one.
- **Order.** Groups with a rank by rank, then the others in catalog order; the default group comes last. Moving a group up or down gives it a rank between its new neighbours (`section.rank`, or `bots.add` for a group without a section).
- **Moving an assistant.** Out of its group of one it takes that group along (`merge`, which leaves nothing behind); out of a group of several it moves with its Sides and what closes with it (`transfer`). Into the default group it gets a new group named after its session (create, then `transfer`). A first edit keeps its name and picture and gives a view whose id the target already has a new id (`layout.apply` and `bot.update`). Each plan is checked against the protocol's own rules before anything is sent. A Side moves with the assistant it is beside, and Team members stay in their group.
- **Reminders.** A muted chat or group sends none; a group whose `notifications` is `needs_you` sends only the needs-you reminder; otherwise both. The device's switch in Settings > Assistants comes first.

## In the browser

`WindowWorkspaceStore` (`packages/agent-remote-lab/src/kernel/window-workspace-store.ts`) holds a group. It reads a Window, a group or a Relay snapshot as one group, because every Window is a group with only the Window appearance, and keeps its Window-shaped readers: `getSnapshot()` and `getCommittedSnapshot()` answer the Window, `getGroup()` and `getCommittedGroup()` the group. Group edits are applied at once and saved in the background like layout edits, through the same receipts and revisions. Its recovery journal is version 2 and holds the group; a version 1 journal, written before groups, is read as a Window.

`useWindowWorkspace` keeps a catalog of groups (`listGroups`) and offers `windows`, the groups with a Window appearance, to the Window workbench: a group that is only a section is in `groups` but not in `windows`, and is never automatically restored as the open Window. The local-first Lab mode stores each group whole under `agent-remote:recovery:<scope>:shared-window:<id>`; a Window stored there before groups still loads, as the group with only the Window appearance.

Each session view offers **Info** next to its heading, grouping its Host name and ID, Provider, working directory and native Session ID. A disconnected view uses its saved snapshot for the working directory; when there is no snapshot, it says that the value is unavailable.

**Disconnect** stops that view's native attachment, conversation subscription and automatic activity observer. Its saved conversation and draft remain visible, and **Connect** activates it again. Connection choices are local to the current browser and user scope, keyed by Window and view; views with no saved choice connect by default. A different enabled view of the same session keeps its shared connection. Recent-Window retention cannot keep an explicitly disconnected session alive by itself. Pending input must settle before the view's Disconnect control is available.

Disconnecting a view does not cancel agent work. When no client needs a session, the Host's existing idle policy releases native resources after the session is safe and idle for its grace period (five minutes by default).

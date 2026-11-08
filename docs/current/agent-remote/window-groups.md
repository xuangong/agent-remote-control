# Window groups

A Window group is a Window document with two appearances: a **Window** (its layout, shown in Window mode) and a **section** (its bots, for Bot mode, which the website adds in a later milestone). Every group has at least one. Every Window created before sections existed is a group with only the Window appearance. Design: [Bot mode](../../superpowers/specs/2026-11-08-bot-view-design.md).

## Data

The Relay stores a group's section (`bots`: a rank and, per bot, a label, a picture of a shape and a color, pinned, hidden and a rank) and its `presentation` (`{ window: false }` when it is not shown as a Window) beside the Window document, not inside it, so older pages and `agent-remote-controller window` still decode every Window (`packages/agent-remote-hosted/src/window-workspaces.ts`). Schemas and pure operations are in `packages/agent-remote-protocol/src/window-groups.ts`; the browser reads and changes groups through `WindowWorkspaceClient` in `packages/agent-remote-web/src/client/window-client.ts`.

A **bot** is a view of a section that is not attached, shows a current session (not its history and not a subagent's), and is not an Ask, Team or TPM view. Details of views that stop being bots are dropped by every edit and ignored when a group is read.

Ranks are fractional indexes: lowercase letters and digits that compare as strings and never end in `0`, so a new rank fits between any two others.

## Requests

| Request | Answer |
|---|---|
| `GET /v1/windows` | `windows`: the groups with a Window appearance, as before; `groups`: every group with `bots` and `presentation` |
| `GET /v1/windows/:id`, `.../changes` | the Window with `bots`, `presentation` and `manager` |
| `POST /v1/windows` | creates a group; `bots` and `presentation` are optional |
| `POST /v1/windows/:id/operations` | Window edits and `bots.add {rank}`, `bots.remove`, `window.add`, `window.remove`, `bot.update {viewId, details}` (replaces the bot's details), `section.rank {rank}`, alone or in a batch; the answer carries `bots` and `presentation` |
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

## In the browser

`WindowWorkspaceStore` (`packages/agent-remote-lab/src/window-workspace-store.ts`) holds a group. It reads a Window, a group or a Relay snapshot as one group, because every Window is a group with only the Window appearance, and keeps its Window-shaped readers: `getSnapshot()` and `getCommittedSnapshot()` answer the Window, `getGroup()` and `getCommittedGroup()` the group. Group edits are applied at once and saved in the background like layout edits, through the same receipts and revisions. Its recovery journal is version 2 and holds the group; a version 1 journal, written before groups, is read as a Window.

`useWindowWorkspace` keeps a catalog of groups (`listGroups`) and offers `windows`, the groups with a Window appearance, to the Window workbench: a group that is only a section is in `groups` but not in `windows`, and is never automatically restored as the open Window. The local-first Lab mode stores each group whole under `agent-remote:recovery:<scope>:shared-window:<id>`; a Window stored there before groups still loads, as the group with only the Window appearance.

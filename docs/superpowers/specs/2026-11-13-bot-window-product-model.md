# Bot and Window: product model

Status: direction confirmed by the owner on 2026-11-13. This document supersedes the conflicting rules of [Bot mode: one session grouping, two ways to manage it](2026-11-08-bot-view-design.md) (bot membership, threads, sections and the manual Show as section step). It describes the product, not an implementation plan; each change still needs its own plan and review.

Earlier 2026-11-13 review documents (roster layout, function organization, reply presence) are inputs to this model, not decisions on their own.

## What the product is

An AI teammate workbench: the owner's agents run on their own machines, and the website shows them in two ways over one set of data.

- **Window mode: the desk.** Arrange several sessions side by side and follow the details: tool calls, reasoning, Sides, Asks, quotes, settings.
- **Bot mode: the team chat.** A roster of long-lived teammates organized in groups. Say what is needed, see what came back, answer what needs you. Process stays collapsed (Content only).

The Session View is the shared core of both modes and stays as it is; only targeted fixes are allowed there. Modernization concerns identity, groups, relationships, status and moving between the two modes.

## Terms

- **Group.** One grouping of sessions: today's Window document. Bot mode shows it as a group in the roster; Window mode shows it as a Window. The word *section* is retired in product language; the protocol's `bots` appearance remains an implementation detail until renamed.
- **Bot.** A long-lived identity in a group: name, picture, role tag, one continuing conversation, status. The native session behind it is an implementation detail.
- **Role tag.** The bot's position, shown like a job title next to a person's name in office software: `Side`, `Team Leader`, `Team member`, `TPM`, `Support`. Ordinary bots have no tag unless the owner gives a label. The tag is separate from the name and from live status.
- **Ask.** A side discussion owned by one bot. It is the only secondary level.

## Rules

1. **Bot membership.** Every session the owner works with in a group is a first-level bot: ordinary sessions, Sides, Team Leaders and members, TPM sessions and Support coordinators. Only Asks are nested under the bot they belong to. Empty views, history views and provider subagents are not bots; subagents stay inside their parent's Session View (confirmed).
2. **Roles come from existing data.** A role tag is derived from the view's `feature` (team with leader/member role, tpm, support) and from a Side's source relationship. A custom label may add to it but does not replace the derived role.
3. **Relationships are metadata, not levels.** A Side's source, a Team's source and members, a TPM's source session are shown as relations on the bot (tag, detail, navigation to the related bot), never as nesting in the roster.
4. **Handoff is invisible in Bot mode.** When a bot's session is handed off, even to another provider, the bot keeps its name, picture, role, place, draft and conversation continuity. Bot mode does not announce the change; the bot's details may state the current provider for those who look. Window mode may show succession history as it does today.
5. **Groups form automatically.** A new session starts a group as its first member, and the group takes that first bot's title until renamed (confirmed). Creating a Side, Team, TPM or Support session from a bot adds the new session to that bot's group. As a Window is assembled, its group grows with it; there is no separate step to show a Window in Bot mode. Sessions started elsewhere (for example in a terminal) stay in **Other sessions** until added to a group.
6. **A bot keeps its conversation.** Opening another session on a bot's view opens it beside, as a new bot. Closing a bot's pane in Window mode collapses it; removing a bot is explicit.
7. **A session is at most one bot** across all groups.
8. **One mode at a time.** Each mode remembers what it had open. A bot's draft is its view's draft in both modes.
9. **Attention follows the mode.** Bot mode reminds of its bots (needs you, failed, finished); Window mode keeps today's scope.
10. **Shared by default, hidden per side.** Both modes show the same groups and bots. The owner may hide a group or a bot in one mode only: hidden in Bot mode, it stays a Window or pane; hidden in Window mode, it stays in the roster. This replaces Show as section, Separate, merge and split in everyday UI. The existing appearances (`bots`, `presentation.window: false`) and per-bot `hidden` already carry most of it.

## Large groups: live, folded and asleep

A group can hold many bots. Opening it as a Window must not open a live conversation for each of them. Today every shown view keeps its own Relay subscription and renders its timeline, while the states of all sessions arrive together on one shared `session_states` channel. The model uses that difference.

| State | What the owner sees | Live conversation | Status and presence |
|---|---|---|---|
| **Live** | the full Session View | subscribed and rendered | yes |
| **Folded** | a slim card: picture, name, role tag, status | released; cached history kept | from the shared channel |
| **Asleep** | dimmed, quiet; wakes when opened | released; cached history kept | quiet (see open questions) |

- **Folding is layout.** It is today's collapsed pane, shared with the Window. A folded bot still shows Working, Needs you and the typing indicator from the shared channel, without its own subscription.
- **Sleep is quiet.** Like sleeping browser tabs: a bot the owner has not looked at for a while, or has put to sleep, releases its conversation and stops live updates and reminders. The agent keeps working on its Host. Opening it shows the cached history at once and catches up.
- **Expanding a large group** opens the selected bot live and the others folded, then keeps a limited number of live panes: the visible ones and those recently used. A pane that leaves the budget folds or sleeps instead of staying subscribed. The budget is set by measuring a local instance, not guessed.
- **Disconnect goes away.** Its purpose, fewer interruptions and less load, is served by fold and sleep. Its wording (Connect, Disconnect, saved history) describes the network rather than what the owner wants, and is retired.

## IM feel

Bot mode presents agents as teammates in a chat app.

- **Rows:** picture, name, role tag, a short preview of the latest reply and its time, status. The preview needs a light summary from the Relay; until then the row omits it.
- **Unread without numbers.** A new result shows as a dot and a stronger name, never a count, in rows, group headers or the page title. Counts create pressure to clear them.
- **Needs you stands apart** from unread: it is the one signal that asks for action.
- **Presence:** see below.

## Presence

In Bot mode a bot that is responding shows an IM-style typing indicator under its latest reply, covering hidden reasoning and tool work. It stops when the bot finishes, waits for the owner, fails or disconnects. It is not a message and does not change message layout. See [the reply presence study](2026-11-13-content-only-reply-indicator.md).

## Differences from the current code

| Area | Today | This model |
|---|---|---|
| `isBotView` (`window-groups.ts`) | excludes `feature` views, attached views and `managed` bindings | includes Side, Team, TPM and Support views; still excludes Ask, history, subagents, empty views |
| Bot threads | Sides and Asks attached to a bot | Asks only |
| Group in Bot mode | only after **Show as section** (`bots.add`) | every group, as soon as it has a session |
| Roster row | name, label, Host · provider, status | name, role tag, status; Host and provider in details |
| Handoff | view rebinds; title may change | identity and place unchanged and unannounced |
| Team, TPM, Support creation | views added to the open Window | sessions added to the source bot's group |
| Reducing load and noise | per-view Disconnect, browser-local | fold (shared layout) and sleep |
| Appearances | Show as section, Separate, merge, split | hide in one mode |
| Unread | not shown | dot, no count |

Existing groups gain their Side, Team, TPM and Support views as bots once membership changes, because membership is derived from views. Relay rule checks (one bot per session, `bot_view` rebinding) then apply to them as well and must be reviewed for Team members that are rebound by their manager.

## Open questions

- Whether a sleeping bot still shows Needs you, and whether it may notify.
- Whether sleep is a choice of this device (like today's disconnect) or follows the owner across devices; folding is shared with the Window.
- When a bot falls asleep on its own, and the live-pane budget, both from measurement.
- Desktop and phone walkthroughs of real work (create, delegate to Team/TPM, answer a request, return) to validate this model before the roster is redesigned.

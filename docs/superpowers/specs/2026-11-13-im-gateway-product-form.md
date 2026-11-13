# IM gateway: product form

Status: product form for review, 2026-11-13. No implementation is authorized by this document. It builds on [Bot and Window: product model](2026-11-13-bot-window-product-model.md).

## Why

Bot mode presents agents as teammates in a chat app, and the workbench should be one place on every device. Today the IM experience is assembled by each browser: it opens a live subscription per conversation, keeps read positions for at most eight tracked sessions in local storage, keeps drafts per tab, retries unsent messages per page and notifies only while a page is open. The session gateway (the hosted Relay) knows the owner's groups and the live state of every session, but nothing about conversations. To feel like IM, the gateway has to own the IM layer.

## Who owns what today

| Layer | Owns | Does not own |
|---|---|---|
| Host (Controller with its embedded Agent Relay) | native sessions, the canonical timeline, history pages, interactions, execution | anything shared across devices |
| Session gateway (hosted Relay, one Durable Object or Node process) | identity and routing between browsers and Hosts; groups and Windows with bot details; stars, titles, successions, Teams, relations, support roles; the shared `session_states` channel | transcript content (by design); the whole state is bounded at 16 MB |
| Browser | live replicas and history caches, drafts, Track read cursors, notifications, the pending-send queue | anything another device can see |

## The IM layer

What the owner should experience, independent of storage:

| IM concept | In this product | Today | With the IM gateway |
|---|---|---|---|
| Contact | a bot: name, picture, role tag, label | a view of a group plus bot details | a bot the gateway knows directly, pointing at its current native session; handoff moves the pointer and nothing else |
| Presence | responding, needs you, asleep, Host offline | `session_states`, without asleep | one presence per bot, on every device |
| Conversation | one per bot; Asks nested | the session's timeline on its Host | unchanged source; the gateway indexes it |
| Message | requests, replies, request cards (questions, approvals), results, messages between bots | timeline items; Content only filters them | the IM layer is exactly the Content-only items; process stays in the Session View |
| Conversation list | rows with preview, time, unread, status | rows with title, Host · provider, status | rows from the gateway's index, without opening a conversation |
| Read state | unread dot, no count | browser-local, Track only | a read position per bot, shared across devices |
| Delivery | sending, accepted, working, replied | page-local retries | quiet send states; messages to an offline Host wait in an outbox any device can see and cancel |
| Draft | one draft per bot | tab-local | shared across devices |
| Notification | Needs you stands out; results are subtle; asleep is low-key; no counts | in-page `Notification` while open | the gateway decides and can reach a device with no page open |
| Group chat | a Team (later): Leader and members in one conversation | Team messages and letters between sessions | a later stage; called a *group chat*, distinct from a *group* in the roster |
| Search | across conversations | session search per Host | later, scoped by what the gateway stores (decision 1) |

What does not change: the Session View, Window mode's detail, and the Host as the place where agents run and conversations are recorded.

## Decisions for the owner

1. **How much message content the gateway keeps.**
   - A. Metadata only (positions, times, kinds); previews come from the Host while it is online. Keeps today's boundary; an offline Host shows no preview or history beyond the browser cache.
   - B. The full IM layer (requests, replies, cards; no process). Real IM: read and search while a Host is offline, notifications with content. Changes the no-transcript boundary and needs new storage beyond the bounded state (for example per-account SQLite or object storage).
   - C. A short preview of each bot's latest message only. Rows feel like IM now; history still comes from the Host.
   - Recommendation: C first, keeping B open as a later stage once storage is designed.
2. **Outbox.** Allow sending to a bot whose Host is offline, delivered when it returns, shown as waiting and cancellable from any device. Recommendation: yes; a long-delayed message shows its age before delivery.
3. **Notifications with no page open** (Web Push and an installable app). Recommendation: yes, after the read state and presence exist.
4. **Roster order.** IM apps sort by recent activity; a workbench benefits from stable places. Recommendation: groups and bots keep their order; recency appears as time and the unread dot, not as movement. An optional Recent list can be added later.
5. **Bots as gateway entities.** Today a bot is a view in a Window group. Making the bot a gateway entity (profile, group, current session) lets it exist without a pane and keeps identity stable through handoff by construction. Window panes then show bots rather than define them. Recommendation: yes; it is the foundation for the rest.

## Stages

1. Bot entities, presence including asleep, shared read positions and the unread dot; previews if decision 1 is C.
2. Shared drafts, fold and sleep state, the outbox.
3. Notifications without an open page.
4. Group chats for Teams; stored history and search if decision 1 moves to B.

Each stage ships on its own and keeps Window mode working unchanged.

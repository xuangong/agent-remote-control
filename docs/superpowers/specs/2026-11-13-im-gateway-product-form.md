# IM gateway: product form

Status: product form confirmed by the owner on 2026-11-13, including every recommendation under Decisions (C-style previews first, outbox, notifications without an open page, stable roster order, bots as gateway entities, reading across a handoff). Each stage still needs its own implementation plan and review. It builds on [Bot and Window: product model](2026-11-13-bot-window-product-model.md).

## Why

Bot mode presents agents as teammates in a chat app, and the workbench should be one place on every device. Today the IM experience is assembled by each browser: it opens a live subscription per conversation, keeps read positions for at most eight tracked sessions in local storage, keeps drafts per tab, retries unsent messages per page and notifies only while a page is open. The session gateway (the hosted Relay) knows the owner's groups and the live state of every session, but nothing about conversations. To feel like IM, the gateway has to own the IM layer.

## Principle: the conversation is the agent session

Confirmed by the owner on 2026-11-13. What drives an AI is its agent session, and a bot's conversation is that session's content. The two are equivalent in both directions:

- **Nothing in the conversation that is not in the session.** The gateway never authors or keeps a second, diverging conversation. Whatever it stores (positions, previews, caches) is derived from sessions and can be rebuilt from them.
- **Nothing in the session that the conversation cannot reach.** Messages typed in a terminal, sent by the command line or by another agent, and the work in between, all belong to the conversation. Content only and Bot mode choose what to show, not what exists.
- **Every IM action is a session operation.** Sending is input to the session, answering a card resolves its interaction, editing a request is prompt editing, a branch is a fork. IM gestures with no session meaning (reactions, deleting a reply, editing a bot's message) are not added.
- **A bot's conversation is the chain of its sessions.** The current session drives the AI. After a handoff, the earlier sessions remain the conversation's history, each part exactly its own session's content.

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
| Conversation | one per bot, equal to its sessions; Asks nested | the session's timeline on its Host | unchanged source; the gateway indexes it and may cache it, never replaces it |
| Message | a timeline entry of the session: requests, replies, cards, results, messages between bots, and the work between them | timeline items; Content only chooses what to show | unchanged: the session's timeline; Bot mode shows the Content-only items and keeps the rest one step away |
| Conversation list | rows with preview, time, unread, status | rows with title, Host · provider, status | rows from the gateway's index, without opening a conversation |
| Read state | unread dot, no count | browser-local, Track only | a timeline cursor per bot, shared across devices |
| Delivery | sending, accepted, working, replied | page-local retries | quiet send states; a message to an offline Host waits in an outbox any device can see and cancel. It is shown as not yet sent and becomes part of the conversation only when the session accepts it |
| Draft | one draft per bot | tab-local | shared across devices |
| Notification | Needs you stands out; results are subtle; asleep is low-key; no counts | in-page `Notification` while open | the gateway decides and can reach a device with no page open |
| Group chat | a Team (later) | Team messages and letters between sessions | a later stage: a view over the sessions' real messages to one another, not a new conversation; called a *group chat*, distinct from a *group* in the roster |
| Search | across conversations | session search per Host | later, scoped by what the gateway stores (decision 1) |

What does not change: the Session View, Window mode's detail, and the Host as the place where agents run and conversations are recorded.

## Decisions (confirmed: the recommendations)

1. **How much of the session the gateway caches.** In every option the session stays the only source, and anything cached is a copy that can be rebuilt from it.
   - A. Index only (cursors, times, kinds); previews come from the Host while it is online. An offline Host shows no preview or history beyond the browser cache.
   - B. A full cache of session timelines. Read and search while a Host is offline, notifications with content. Changes today's no-transcript boundary and needs storage beyond the bounded state (for example per-account SQLite or object storage).
   - C. A short preview of each bot's latest message only, refreshed from the session.
   - Recommendation: C first, keeping B open as a later stage once storage is designed.
2. **Outbox.** Allow sending to a bot whose Host is offline, delivered when it returns, shown as waiting and cancellable from any device. Recommendation: yes; a long-delayed message shows its age before delivery.
3. **Notifications with no page open** (Web Push and an installable app). Recommendation: yes, after the read state and presence exist.
4. **Roster order.** IM apps sort by recent activity; a workbench benefits from stable places. Recommendation: groups and bots keep their order; recency appears as time and the unread dot, not as movement. An optional Recent list can be added later.
5. **Bots as gateway entities.** Today a bot is a view in a Window group. Making the bot a gateway entity (profile, group, its chain of sessions with the current one driving it) lets it exist without a pane and keeps identity stable through handoff by construction. Window panes then show bots rather than define them. Recommendation: yes; it is the foundation for the rest.
6. **Reading across a handoff.** Today the earlier session is reached through history links. Since the conversation is the chain of sessions and handoff is invisible in Bot mode, scrolling up past the start of the current session could continue into the previous session's content, read-only, with a quiet divider. Recommendation: yes in Bot mode; Window mode keeps its explicit history links.

## Stages

1. Bot entities, presence including asleep, shared read positions and the unread dot; previews if decision 1 is C.
2. Shared drafts, fold and sleep state, the outbox.
3. Notifications without an open page.
4. Group chats for Teams; stored history and search if decision 1 moves to B.

Each stage ships on its own and keeps Window mode working unchanged.

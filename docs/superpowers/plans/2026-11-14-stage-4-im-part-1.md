# Stage 4: IM layer, part 1 — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bot mode reads like a team chat on every device without opening a conversation per bot: each row shows the latest reply's preview and time, an unread dot (never a count) shared across devices, and a typing indicator while the bot works; the phone moves from the list to a chat and back with "‹ Bots" ([IM gateway](../specs/2026-11-13-im-gateway-product-form.md), decision 1 C; [product model, "IM feel" and "Presence"](../specs/2026-11-13-bot-window-product-model.md)).

**Architecture:** The shared `session_states` channel already brings every session's state to every page without session streams. It gains two derived facts per session, reported by the Controller that runs it: `replyAt`, when its latest reply was produced, and `preview`, a short plain-text excerpt of that reply (decision C). The Controller reads them from the tails of the timelines it holds open, remembers them after a session is released, and keeps them on disk, so nothing on the Relay is a second copy of a conversation: facts stay in the broker's memory like states and are rebuilt from the sessions. Read positions are the one new piece of durable Relay state: per account and session, the `replyAt` the owner has seen, plus the time the account started keeping them (`since`, so replies from before stage 4 are not unread). A reply is unread when its `replyAt` is after the read position, or after `since` when the session has none. Bot mode then stops opening one activity stream per bot (decision 11): attention and notifications come from the shared channel's state changes, which also lifts Bot mode's dependence on the account's 64-stream limit and on a Controller session lease per bot.

**Compatibility:** facts travel only between parties that asked for them. A Controller sends them after the Relay acknowledges `sessionStates: 2`; a page receives them on a channel opened with `states=2`; older pages (`states=1`) and older Controllers keep working without them, and rows simply omit preview, time and unread. Read positions add a Relay record kind: once one is stored, Workers before this stage cannot read the Relay state, so fix forward. Deploy the Worker before publishing the Controller.

**Tech stack:** TypeBox (`agent-remote-protocol`), the Controller (`agent-host`), the hosted Relay (`agent-remote-hosted`, Durable Object storage via `agent-remote-cloudflare`), the web client (`agent-remote-web`), React Lab, Vitest, `pnpm local` (its Controller is built from the checkout, so replies of real sessions exercise the whole path).

## Task 1: Reply facts on the shared channel (protocol)

**Files:** `packages/agent-remote-protocol/src/session-states.ts` (+ test), `remote-host-uplink.ts` (`registered.sessionStates`), `session-channel.ts` (channel query and `session_states` frames).

- [x] Tests: `HostSessionState` and `SessionStateUpdate` accept optional `replyAt` (milliseconds) and `preview` (1–200 characters); they reject a longer preview, an empty one and other extra fields; `registered.sessionStates` accepts 1 and 2.
- [x] Add `SESSION_PREVIEW_LENGTH = 160` (what Controllers produce) beside the schema bound, and document both facts: derived from the session, never authored.
- [x] Commit `feat(protocol): carry each session's latest reply time and preview with its state`.

## Task 2: The Controller reports reply facts

**Files:** `packages/agent-host/src/session-replies.ts` (new, + test), `session-state-publisher.ts` (+ test), `host.ts` (wiring), `remote-host-uplink-client.ts` (+ test).

- [x] `SessionReplies` tests: reading an open session's tail (`fetchTimeline({ direction: 'tail', limit: 12 })`) finds its latest `assistant_message` and records `{ replyAt: Date.parse(entry.timestamp), preview }`, only when the session's timeline cursor moved since the last reading; a tail without a reply keeps the previous facts; the preview is plain text (Markdown emphasis, headings, code fences and link targets removed, whitespace collapsed) cut to 160 characters with an ellipsis; facts outlive the session's release; at most 4096 sessions are remembered (oldest `replyAt` dropped); they persist debounced to a JSON file in the Controller's state directory and load on start, ignoring a corrupt file.
- [x] The publisher merges remembered facts into every state it reports (open or catalog); a change of facts is a change; `snapshot()` includes them.
- [x] The uplink client strips facts unless the Relay acknowledged `sessionStates: 2`.
- [x] Commit `feat(controller): report each session's latest reply time and preview`.

## Task 3: The Relay forwards reply facts

**Files:** `packages/agent-remote-hosted/src/broker.ts`, `gateway.ts` (+ tests).

- [x] Tests: the broker acknowledges `sessionStates: 2` to a Controller that asked for states; it keeps facts with each state and drops them with it; a `states=2` channel receives them in snapshots and updates; a `states=1` channel never does (and receives no update when only facts changed); facts are never logged.
- [x] Commit `feat(relay): share reply facts with pages that ask for them`.

## Task 4: Shared read positions

**Files:** `packages/agent-remote-protocol/src/session-reads.ts` (new schema, + test), `packages/agent-remote-hosted/src/session-reads.ts` (new service, + test), `state.ts` (`sessionReads`, `sessionReadsSince`, validation and limits), `record-codec.ts` (kind `sessionRead`), `gateway.ts` (route and channel flag).

- [x] Tests: `POST /v1/session-reads { reads: [{ hostId, providerId, nativeSessionId, readAt }] }` (at most 256) only advances positions; the first request of an account sets `since` (an empty `reads` list does only that); positions are bounded at 4096 per account, dropping the oldest `readAt`; another account never sees them; they survive a restart through the record codec; a channel opened with `reads=1` receives a `session_reads` snapshot (`since` and every position) when accepted and each later change.
- [x] Commit `feat(relay): keep read positions per account and session`.

## Task 5: The web client keeps facts and read positions

**Files:** `packages/agent-remote-web/src/client/session-states.ts`, `session-channel-transport.ts`, `http-websocket-transport.ts`, a new `client/session-reads.ts` (+ tests).

- [x] Tests: the state store keeps `replyAt` and `preview` per session (removed with the state); the transport opens its states channel with `states=2&reads=1`; `watchSessionReads` delivers `since` and positions; `markSessionRead(session, replyAt)` posts only when it advances the known position, coalescing calls within 500 ms.
- [x] Commit `feat(web): keep reply facts and shared read positions`.

## Task 6: Bot attention from the shared channel (decision 11)

**Files:** `packages/agent-remote-lab/src/App.tsx` (Track call), a new `src/bot-attention.ts` (+ test), `src/hooks/useSessionAttention.tsx`.

- [x] Tests: Bot mode opens no activity stream per bot (no `RemoteActivityClient` for roster bots); a bot whose shared state becomes `waiting` notifies "needs your input", and `running` → `idle` notifies "completed", once per transition and not for the bot on screen; the roster status still follows the shared state.
- [x] Commit `feat(lab): follow bots through the shared channel instead of a stream each`.

## Task 7: Rows with preview, time and the unread dot

**Files:** `src/bot-roster.ts` (row facts), `src/components/BotRoster.tsx` (+ css), a new `src/reply-time.ts` (+ test), `src/hooks/useSessionReads.ts` (new), `src/App.tsx` (marking read).

- [x] Tests: a row shows its preview on one line and its time (today `10:42`, yesterday `Yesterday`, this week the weekday, older the date, in the page's locale); a reply after the read position (or after `since`) shows a dot and a stronger name, never a number; a group header shows a dot when any of its bots is unread; a bot whose conversation is on screen (Bot mode's selected bot, or a Window pane on screen and not folded, with the page visible) is marked read up to its `replyAt`; marking on one page clears the dot on another; a sleeping bot's unread stays quiet (dot dimmed).
- [x] Commit `feat(lab): show each bot's latest reply and an unread dot`.

## Task 8: Typing presence

**Files:** `packages/agent-remote-web/src/react/AgentTimeline.tsx` (an optional trailing presence slot; a targeted Session View addition the spec asks for), Lab Bot mode conversation, `BotRoster.tsx`, folded card.

- [x] Tests: in Bot mode a working bot's conversation shows a typing bubble after its latest entry, which goes away when it finishes, waits for the owner, fails or disconnects; Window mode's Session View is unchanged; a working bot's row shows animated dots in place of its preview, and a folded card's status dot pulses; reduced motion shows them still.
- [x] Commit `feat: show a typing indicator while a bot works`.

## Task 9: Phone "‹ Bots"

**Files:** `src/components/BotWorkspace.tsx` (+ css, test).

- [x] Tests: on a phone the chat's back control reads "‹ Bots" (chevron and label, 44-pixel target) and returns to the list at the same scroll position; the list → chat change slides like a navigation push (none with reduced motion).
- [x] Commit `feat(lab): navigate from the bot list to a chat and back like a phone app`.

## Known gaps (stage 7)

- A Controller learns a session's latest reply only while it holds the session open (then remembers it across restarts), so a bot nobody has opened since its Controller started keeping replies shows no preview until it replies or is opened.
- After a handoff, the latest reply may still be in the predecessor; rows continue into it only where this device knows the bot's chain (its group was composed here). The Controller could report the chain's latest reply itself.
- Notifications without an open page (IM stage 3) and the low-key dot on the mode switch are not part of this stage.

## Ship

Full `pnpm verify` (Controller code changed); local check on desktop and phone, light and dark, with real replies in the local instance (preview and time arrive, unread on one page clears on another, typing while working, notifications); merge, push; Worker deploy (Relay facts, read positions, website); then Controller release with the Window CLI unchanged; record versions in the roadmap and the release memory. Rolling the Worker back below this stage is not possible once a read position is stored.

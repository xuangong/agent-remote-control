# Stage 5: IM layer, part 2 — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bot's unsent message follows the owner across devices, and a message to a bot whose Host is offline waits in an outbox that every device can see and cancel, delivered by the Host's Controller when it returns, without any page open ([IM gateway](../specs/2026-11-13-im-gateway-product-form.md): "Draft: one draft per bot, shared across devices", decision 2 "Outbox").

**Architecture:** Two parts that ship one after the other.

*5a, shared drafts.* The Relay keeps one draft text per account and session (bounded, text only; images and files stay on the device that holds them) and shares drafts on the account's states channel. Each draft carries a revision assigned by the Relay; an empty text marks a draft that was cleared (sent or erased), so a device that was away learns it too. A page publishes its composer's text debounced (800 ms) and follows a newer remote draft only while it has no unpublished edits of its own: typing on one device is never overwritten by another, and the last device to edit wins. Pages remember, per composer and session, the revision and a hash of the text they last agreed on (tab storage, next to the drafts), so a reloaded tab tells "unchanged since the last sync" from "edited here". Bot rows show a draft like a chat list ("Draft" and its text) where the reply preview would be.

*5b, the outbox.* Sending to a session whose Host is offline puts the message (text only) into the account's outbox on the Relay, if that Host's Controller can deliver from it (it said so when it last connected; the Relay keeps that with the Host). The message shows at the end of the conversation on every device as not yet sent, with its age and Cancel. When the Host's Controller connects, and whenever the Relay tells it a message is waiting, it claims each message, records a local receipt, resumes the session through its succession routing, sends the text as a new turn (or the next turn when one is running), and settles the outcome. Accepted messages leave the outbox and are part of the conversation from then on; a rejected one stays as "Not delivered" with Retry and Cancel; a claim that lost its receipt (a crash between claim and send) becomes "Check delivery", never resent automatically. This mirrors how Team messages are delivered.

**Compatibility:** Drafts and outbox entries are new Relay record kinds: once stored, Worker versions before this stage cannot read the Relay state, so fix forward (as in stage 4). Channels receive drafts with `drafts=1` and the outbox with `outbox=1`; older pages ask for neither. A Controller asks for outbox delivery with `outbox=1` and receives `outbox_ready` frames only after the Relay acknowledged `outbox: 1`; older Controllers keep working and their Hosts simply do not offer sending while offline. Deploy the Worker before publishing the Controller.

**Tech stack:** TypeBox (`agent-remote-protocol`), the hosted Relay (`agent-remote-hosted`, Durable Object storage via `agent-remote-cloudflare`), the Controller (`agent-host`, uplink client in `agent-remote-relay`), the web client (`agent-remote-web`), React Lab, Vitest, `pnpm local`.

## Part 5a: Shared drafts

### Task 1: Draft schema (protocol)

**Files:** `packages/agent-remote-protocol/src/session-drafts.ts` (new, + test), `session-channel.ts` (`session_drafts` frame), `index.ts`.

- [ ] Tests: `SessionDraft` is `{ hostId, providerId, nativeSessionId, text, revision }` with `text` at most `SESSION_DRAFT_BYTES` (8192) UTF-8 bytes (an empty text is a cleared draft) and `revision` a positive safe integer; `isSessionDraftRequest` accepts `{ hostId, providerId, nativeSessionId, text }` and rejects a text over 8192 bytes even when it has fewer characters (CJK), extra fields and empty identities; the channel accepts `{ type: 'session_drafts', snapshot?: true, drafts }` with at most `SESSION_DRAFT_LIMIT` (64) drafts.
- [ ] Commit `feat(protocol): describe drafts shared across devices`.

### Task 2: The Relay keeps drafts

**Files:** `packages/agent-remote-hosted/src/session-drafts.ts` (new service, + test), `state.ts` (`sessionDrafts`, validation, `MAX_SESSION_DRAFTS = 1024`), `record-codec.ts` (kind `sessionDraft`, key `[subject, hostId, providerId, nativeSessionId]`), `gateway.ts` (`GET`/`PUT /v1/session-drafts`, channel flag `drafts=1`, publishing).

- [ ] Tests: `PUT` stores the text with a revision greater than the draft's previous one (the Relay's clock, or previous + 1), returns the draft, and does not commit when the text is unchanged; an empty text stays as a cleared draft; an account keeps at most 64 (cleared drafts are dropped first, then the oldest revision); beyond 1024 drafts in all, a new draft is refused with 409 `drafts_limit`; another account never sees them; they survive a restart through the record codec; a channel opened with `drafts=1` receives a `session_drafts` snapshot when accepted and then only the drafts whose revision changed; texts are never logged.
- [ ] Commit `feat(relay): keep each account's drafts and share them on its channel`.

### Task 3: The web client follows drafts

**Files:** `packages/agent-remote-web/src/client/session-drafts.ts` (new `SessionDraftStore`, + test), `http-websocket-transport.ts`, `session-channel-transport.ts`, `transport.ts`, `headless.ts`.

- [ ] Tests: the store replaces its drafts on a snapshot and updates them on later frames, ignoring a revision older than the one it has; `view.draft(session)` returns `{ text, revision }`; the transport opens its channel with `drafts=1`, `watchSessionDrafts` delivers the view and `saveSessionDraft(session, text)` sends `PUT /v1/session-drafts` and applies the returned draft to the store at once.
- [ ] Commit `feat(web): follow and save drafts shared across devices`.

### Task 4: Composers share their drafts

**Files:** `packages/agent-remote-lab/src/shared-draft-sync.ts` (new, + test), `src/hooks/useSharedDraft.ts` (new), `src/draft-store.ts` (public `scope`), `src/components/SessionConversation.tsx` (mount the hook for the composer's session), `src/App.tsx` (provide the transport through a `SharedDraftsContext`).

- [ ] Tests (`createSharedDraftSync`, fake timers): a page with an empty composer takes the remote draft; a local edit is published 800 ms after the last keystroke and becomes the agreed text; a newer remote draft replaces the composer text only while the text equals the agreed one (no unpublished edits), so typing is never overwritten and the next publish wins; a cleared remote draft clears an unchanged composer; a send (the composer becoming empty) publishes the clear; a reloaded tab whose text still hashes to the remembered agreement follows a newer remote draft, and one whose text changed keeps it and publishes it; a text over 8192 bytes is not published and keeps its local copy.
- [ ] Tests (Lab): typing in a bot's conversation saves the draft; a draft arriving from another device appears in an idle composer and not in one being edited; sending clears it everywhere.
- [ ] Commit `feat(lab): share each conversation's draft across devices`.

### Task 5: Drafts in bot rows

**Files:** `src/bot-roster.ts` (`BotRow.draft`), `src/components/BotRoster.tsx` (+ css).

- [ ] Tests: a bot that is not on screen and has a non-empty draft shows "Draft" (accent label color) and the draft's first line where the preview would be; a status that asks for something still comes first; screen readers hear "Draft: …"; the bot on screen shows its preview instead.
- [ ] Commit `feat(lab): show a bot's unsent draft in its row`.

### Ship 5a

`pnpm verify:changed`; local check on desktop and phone, light and dark (two pages: type on one, see it on the other; send on one, see both clear; type on both and see the last edit win); merge, push, Worker deploy; record versions in the roadmap and the release memory.

## Part 5b: The outbox

### Task 6: Outbox schema (protocol)

**Files:** `packages/agent-remote-protocol/src/session-outbox.ts` (new, + test), `session-channel.ts` (`session_outbox` frame), `remote-host-uplink.ts` (`registered.outbox`, `outbox_request`, `outbox_response`, `outbox_ready`), `index.ts`.

- [ ] Tests: `OutboxEntry` is `{ id (UUID), hostId, providerId, nativeSessionId, text (1 to 16384 bytes), createdAt, status: 'waiting' | 'delivering' | 'failed' | 'unknown', error? (≤ 512) }`; `isOutboxRequest` accepts `{ id, hostId, providerId, nativeSessionId, text }`; `OutboxHostCall` is `{ action: 'poll' }`, `{ action: 'claim', id }` or `{ action: 'settle', id, outcome: 'accepted' | 'rejected' | 'unknown', error? }`; the uplink accepts the three frames and `registered.outbox: 1`; the channel accepts `{ type: 'session_outbox', snapshot?: true, entries, removed? }` with at most `OUTBOX_LIMIT` (32) entries.
- [ ] Commit `feat(protocol): describe the outbox for offline Hosts`.

### Task 7: The Relay keeps the outbox

**Files:** `packages/agent-remote-hosted/src/session-outbox.ts` (new service, + test), `state.ts` (`outbox`, `MAX_OUTBOX = 512`, Host `outbox?: 1`), `record-codec.ts` (kind `outboxEntry`, key `[subject, id]`), `gateway.ts` (routes, channel flag `outbox=1`), `broker.ts` (registration flag, host listing, `outbox_request`, `outbox_ready`).

- [ ] Tests: `POST /v1/outbox` stores a waiting entry for one of the account's Hosts whose Controller can deliver (403 `outbox_unavailable` otherwise) and is idempotent by `id`; at most 32 per account (409 `outbox_full`); `DELETE /v1/outbox/<id>` removes a waiting, failed or unknown entry and refuses a delivering one (409 `outbox_delivering`); `POST /v1/outbox/<id>/retry` makes a failed or unknown entry waiting again; a Controller that connected with `outbox=1` is acknowledged with `outbox: 1`, the Host record keeps `outbox: 1` (listed to pages) until it connects without it; its `poll` returns its Host's waiting and delivering entries only; `claim` moves waiting to delivering and refuses anything else; `settle` removes an accepted entry, marks a rejected one failed and an uncertain one unknown, with the error; a new or retried entry for a connected Host sends it `outbox_ready`; channels with `outbox=1` receive a snapshot and then changes and removals; texts are never logged.
- [ ] Commit `feat(relay): keep messages for offline Hosts until their Controller takes them`.

### Task 8: The Controller delivers from the outbox

**Files:** `packages/agent-remote-relay/src/transport/remote-host-uplink-client.ts` (+ test: `outbox=1`, `outboxRequest`, `onOutboxReady`), `packages/agent-host/src/session-outbox.ts` (new `OutboxDelivery`, + test), `host.ts` (wiring with the automation access and succession routing).

- [ ] Tests: once the Relay acknowledged `outbox: 1`, the Controller polls when registered, on `outbox_ready` and every 30 s; for a waiting entry whose session can take input it claims, writes a receipt, resumes the session (following its succession), sends the text as a new turn, or as the next turn while one runs, settles `accepted` and forgets the receipt; a session that cannot take input now is left waiting for the next poll; a rejected send (missing session, provider disabled) settles `rejected` with the reason; a delivering entry without a local receipt settles `unknown` ("Check the conversation before sending it again."), and one with a receipt re-settles it after a lost response; nothing is sent twice across a restart; message texts never reach logs.
- [ ] Commit `feat(controller): deliver messages that waited for this Host`.

### Task 9: The web client follows the outbox

**Files:** `packages/agent-remote-web/src/client/session-outbox.ts` (new `SessionOutboxStore`, + test), `http-websocket-transport.ts`, `session-channel-transport.ts`, `transport.ts`, `headless.ts`.

- [ ] Tests: the store keeps entries by session from snapshots, changes and removals; the transport opens its channel with `outbox=1`; `queueMessage(session, text)` posts with a fresh UUID and applies the entry at once; `cancelQueuedMessage(id)` and `retryQueuedMessage(id)` call their routes and apply the result.
- [ ] Commit `feat(web): follow the outbox and queue messages for offline Hosts`.

### Task 10: Sending to an offline Host

**Files:** `packages/agent-remote-web/src/react/AgentComposer.tsx` (an optional `sendLater` path for a draft-only composer; a targeted Session View addition), `packages/agent-remote-lab/src/components/OutboxMessages.tsx` (new, + css, test), `src/App.tsx` (presentation for offline Hosts), `src/bot-roster.ts` and `BotRoster.tsx` (waiting status).

- [ ] Tests (composer): with `sendLater` a draft-only composer sends text with Enter or the send button (labeled "Send when <Host> is back"), clears the draft once it is queued and shows the error when queueing fails; drafts with images or files, commands and skills are not sent later and say why; without `sendLater` nothing changes.
- [ ] Tests (Lab): a session on an offline Host whose Controller can deliver offers sending later; on a Host that cannot, the composer stays draft-only and says "Update the Controller on <Host> to send while it is offline."; queued messages show after the conversation's last entry on every page as outgoing bubbles marked "Waiting for <Host>" with their age once over a minute, "Sending…" while delivering, "Not delivered" with the reason, Retry and Cancel when failed, and "Check delivery" with Dismiss when uncertain; Cancel removes it on every page; a bot with waiting messages says "Waiting to send" in its row when nothing more urgent shows; reduced motion has no animation.
- [ ] Commit `feat: send to a bot whose Host is offline and see it wait in the outbox`.

### Ship 5b

Full `pnpm verify` (Controller code changed); local check on desktop and phone, light and dark, with the local instance's own Controller stopped and started again (queue, cancel on the other page, deliver on return, failure on a missing session); merge, push, Worker deploy, then a Controller release; record versions in the roadmap and the release memory. Rolling the Worker back below this stage is not possible once a draft or an outbox entry is stored.

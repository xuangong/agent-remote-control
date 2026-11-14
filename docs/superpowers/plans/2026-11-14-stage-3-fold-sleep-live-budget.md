# Stage 3: Fold, sleep and the live budget — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A group of many bots never opens a live conversation for each of them: a device keeps a bounded set of conversations live, folded panes are slim cards without a conversation, sleeping bots are quiet everywhere, and the per-view Disconnect is gone ([product model, "Large groups"](../specs/2026-11-13-bot-window-product-model.md)).

**Architecture:** Today nothing but Disconnect releases a mounted conversation: collapsed panes, hidden Window panes in Bot mode and inactive families keep their streams, and Window retention keeps up to 24 more. A per-device `LiveBudget` decides which mounted conversations are live: those on screen, those with pending input, and the few most recently seen, with a grace period so scrolling and switching do not thrash. Everything else is released through the path Disconnect used (the conversation shows its cached history; status comes from the shared channel) and reattaches when it comes back. Fold is the existing `view.collapsed` (shared with the Window); sleep is a per-bot detail stored with the group. Both are owner choices shared across devices; the budget is invisible device-local resource management and never folds or sleeps a bot.

**Tech stack:** React, Lab hooks, `agent-remote-protocol` (TypeBox), the hosted Relay validation, Vitest, `pnpm local`.

**Measured later (stage 6):** the budget's size (recent conversations kept live beyond those on screen) and grace period start as provisional constants, 4 and 20 seconds, and Window retention's loose limit drops from 24 to the same 4.

## Task 1: The live budget replaces Disconnect

**Files:** create `packages/agent-remote-lab/src/live-budget.ts` (+ test); replace `src/hooks/useWindowConnections.ts` with `src/hooks/useLiveBudget.ts` (+ test); `src/components/SessionConversation.tsx`; `src/App.tsx` (succession `attachmentAllowed`, retention, Track's `sessionEnabled`, the context provider); `src/hooks/useWindowSessionRetention.ts`.

- [x] `LiveBudget` model tests: a registered slot is live while visible or pinned; when it leaves the screen it stays live for the grace period, then only while it is among the 4 most recently seen; an unregistered slot is live; a slot registered twice (Bot and Window surfaces of one target) is visible if either is; listeners hear each change, including the grace timer's.
- [x] Implement `LiveBudget` with an injected clock and timer.
- [x] `useLiveBudget(scope)` provides `LiveConnectionsContext { live(slotId), register(slotId, { visible, pinned }) }`; it removes the old `agent-remote:window-connections:<scope>` key once.
- [x] `SessionConversation`: registers with `visible = visible && active` and `pinned = pending input`; a released conversation behaves as a disconnected one did (session cleared, cached display shown, input kept) but without the Connect/Disconnect button or its notice; it reattaches by itself when live again.
- [x] App: succession `attachmentAllowed`, `useWindowSessionRetention` and Track's `sessionEnabled` read the budget; retention's loose limit becomes 4.
- [x] Tests: no Disconnect control remains; a Window pane hidden by Bot mode is released after the grace period and shows its cached history; it reattaches when Window mode returns; a pane with pending input is never released.
- [x] Commit `feat(lab): keep a bounded set of conversations live on each device`.

## Task 2: Folded panes are slim cards

**Files:** `src/components/SessionDock.tsx` (`PrimaryGroupPane`), `src/components/SessionFamily.tsx` (collapsed attached panes), a new `src/components/FoldedBot.tsx` (+ css, test), `src/App.tsx`.

- [x] A folded (collapsed) bot pane shows a slim card: picture, name, role tag, status from the shared channel (`windowSessionStatus`), and Restore; its conversation is released at once (the budget's `folded` flag), cached history shown at once on Restore.
- [x] Tests: the folded card (picture, name, role, status, Restore) and a folded pane released at once while another stays live. A folded Side releases through the same `folded` flag.
- [x] Commit `feat(lab): fold a pane into a slim card that releases its conversation`.

## Task 3: Sleep

**Files:** `packages/agent-remote-protocol/src/window-groups.ts` (`WindowBotDetails.asleep`), hosted validation tests, `src/components/BotActions.tsx` (Sleep), `src/bot-roster.ts` / `BotRoster.tsx` (dimmed row, quiet status), `src/components/BotWorkspace.tsx` (opening wakes), Window panes of sleeping bots (folded card, dimmed).

- [ ] Protocol and Relay accept `asleep: true` in bot details; tests.
- [ ] The bot menu offers Sleep; a sleeping bot's row is dimmed with a quiet "Asleep" (or a quiet "Needs you" when it waits for the owner, which also shows in its group header — the low-key reminder, no sound or pop-up); opening it wakes it for every device (`bot.update` without `asleep`) and shows the cached history at once.
- [ ] A sleeping bot is never live (budget) and its Window pane shows the dimmed folded card.
- [ ] Commit `feat: put a bot to sleep from its menu`.
- Deferred: automatic sleep of idle bots needs a shared "last opened" time (with stage 4's Relay-side read positions).

## Ship

`pnpm verify:changed`; local check on desktop and phone, light and dark (a group with many bots, fold, sleep, switching modes); merge, push, Worker deploy (the protocol change: once a bot sleeps, older Workers reject the Relay state; fix forward).

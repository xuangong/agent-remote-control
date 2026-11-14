# Stage 6: Performance — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The workbench stays quick as it grows: activity of one bot costs the page work for that bot only, switching bots renders the conversations that change and nothing else, an idle page stops polling for what nobody looks at, and the code loaded after sign-in has a size budget the build enforces.

**Architecture:** Measure first, then remove the measured waste, and guard every budget with a deterministic test (render and request counts, bytes), never with wall-clock thresholds in CI. Wall-clock numbers are recorded here from repeatable runs (jsdom harness, local instance with Chromium and CPU slowdown).

**Tech stack:** React 18 Lab (`agent-remote-lab`), Vitest with module spies for render counts, Vite/Rollup build hooks for the bundle budget, Playwright with CDP metrics against `pnpm local`, `wrangler tail` for production request mix.

## Baselines (2026-11-14, main 8babb2b9)

**Client render fan-out** (jsdom, the production App with the bot-mode fixture transport; 12 groups × 10 bots in Bot mode, the first bot open, `?window=G0`):

| Change | Roster renders | Roster projections | Conversation renders | jsdom time |
|---|---:|---:|---:|---:|
| State, reply preview, read or draft of a bot not on screen | 1 | 4 | 20 (all 10 views of G0, hidden Window panes, twice each) | 800–970 ms |
| The same with conversations stubbed out | 1 | 4 | — | ~105 ms |
| Switching to another bot | — | 12–16 | 76–90 | 3.3–4.0 s (0.3 s stubbed) |
| Window mode, status change of one of 10 panes | — | — | 40 (every pane, four times) | 1.6–1.9 s |

Conversations rendered again by parents and contexts are about 87% of the work of a frame. Causes, read in the code: App provides `SessionViewOperationsContext` and `SessionDescriptionsContext` as new objects on every render, so every conversation re-renders on any App render; `SharedDraftsContext` changes with every drafts frame; `SessionConversation` is not memoized; the conversation surfaces re-render every portal on every registration; hidden conversations (the Window panes while in Bot mode, the retained recent bots) re-render like visible ones; the roster is projected twice per render.

**Local instance** (`.tmp/local/switch-timing.mjs`, Chromium 1440 × 900, six bots, short conversations): roster after load 256 ms; switch until shown median 101 ms cold / 79 ms warm, main-thread task 73 / 59 ms; with 4× CPU slowdown 116 / 125 ms shown, task 143 / 137 ms; idle 10 s task 35 ms.

**Network** (production Worker, `wrangler tail`, 150 s with the owner's pages open): 292 requests — 81 `GET /v1/remote/teams` (the Team roster polls every 4 s on every signed-in page, also in Bot mode with no Team in view), 77 `GET /v1/remote/hosts/<id>/tpm` (TPM catalogs every 10 s per Host), 35 `GET /v1/session-relations` (10 s), 28 catalog revisions, 20 previews, 15 Window change waits. Worker CPU per request p50 0 ms, p99 2 ms: the Relay is not the bottleneck, the clients' polling is (battery and radio on phones, Controller work for TPM).

**Relay** (Controller-side Relay diagnostics, 2,225 streams over two days): stream open → ready p50 74 ms, p90 190 ms, p99 1.2 s. Commits encode only changed records (existing `record-cache.test.ts`); drafts, reads and the outbox (stages 4–5) are new record kinds whose commit cost is not yet guarded.

**Bundle** (Lab production build): entry 197 KB raw / 63.5 KB gzip (the e2e sign-in check keeps it under 300 KB decoded); the App chunk loaded after sign-in 1.99 MB raw / 600 KB gzip / 476 KB brotli, of which Lab 945 KB, web 358 KB, prosemirror ~210 KB, protocol and TypeBox 165 KB, `jsqr` 130 KB and `qrcode` 24 KB (QR scanning and QR display, both rare). No budget guards the App chunk.

## Budgets

1. A state, reply, read, draft or outbox change of a bot that is not on screen renders no conversation and projects the roster once per App render.
2. Switching bots renders only the conversations whose visibility changes (the one left and the one opened), at most twice each.
3. In Window mode, a change in one pane's session renders that pane's conversation only.
4. A visible page with no Team or TPM interface in view polls the Team roster at most twice a minute and TPM catalogs at most once a minute per Host; pages in the background do not poll them.
5. The App chunk stays under 600 KB gzip and the entry under 70 KB gzip; the build fails otherwise (about 10% over the sizes after this stage).
6. A draft, read or outbox change on a Relay holding thousands of records encodes one record (and the header when a record is added).

## Task 1: Render budget tests (red)

**Files:** `packages/agent-remote-lab/src/App.render-budget.test.tsx` (new).

- [x] Tests, with the bot-mode fixture and 12 groups × 10 bots, spying on `SessionConversation` (counting renders by session) and `projectBotRoster`: budget 1 for a states frame, a reply preview, a read, a draft and an outbox change of an off-screen bot (no conversation and no App render, one projection); budget 2 for switching between three bots; budget 3 for a status change of one pane in Window mode. They failed on main with the counts above.

## Task 2: Stable context values

**Files:** `src/App.tsx`, `src/hooks/useSharedDraft.ts`.

- [x] `SessionViewOperationsContext` and `SessionDescriptionsContext` keep their identity and read the latest App state through a ref: shown conversations render with App and read it then; hidden ones keep their last render (Task 3). The Track command keeps its identity; each conversation follows its own liveness through a subscription instead of a live-budget context that changed with every release.
- [x] Shared IM state (states, reads, drafts, outbox) lives in a `SharedFeeds` store outside React state (`src/shared-feeds.ts`): the roster projects it itself, folded cards read their status, a conversation's outbox bubbles subscribe to its entries, Window status lists follow the states, reminders and read marks follow it from effects, and composers receive other devices' drafts through a subscription, without rendering.
- [x] Tests: the shared-draft, outbox and App suites pass; `shared-feeds.test.tsx`; the render budget for every IM frame holds.

## Task 3: Conversations render when their inputs change

**Files:** `src/components/SessionConversationSurfaces.tsx`, `src/components/SessionConversation.tsx` (a memoized boundary), new `src/components/conversation-props.ts` (+ test).

- [x] A hidden conversation (not shown in the current mode) does not render again for its parent while its lifecycle props (everything but functions and elements, compared as data) are unchanged; it still renders for its own session's events and contexts, and renders with the latest props when shown.
- [x] A shown conversation renders with its parent, as before: its presentation reads App state when it renders, so it is never stale.
- [x] Surfaces render a portal again only when its registrations changed (a revision per entry), once per App render instead of twice.
- [x] Tests: `conversation-props.test.ts`; the render budgets hold; the full Lab suite passes.

## Task 4: One roster projection per render

**Files:** `src/App.tsx`.

- [x] An IM frame projects the roster once, in the roster; App projects it without IM state for its own use. A projection of 120 bots costs ~0.2 ms, so App renders keep projecting without memoization.

## Task 5: Polling only what is in view

**Files:** `src/components/TeamMenu.tsx`, `src/hooks/useTpmWork.ts`, App wiring (+ tests).

- [x] The Team roster polls every 4 s while the Team menu is open or a Team is forming (a member is still reserved); every 30 s otherwise; never while the page is hidden; at once when the menu opens or the page becomes visible.
- [x] TPM catalogs poll every 10 s while TPM is in view (its list or a TPM workspace); every 60 s otherwise; never while hidden; at once on focus.
- [x] Tests (fake timers): requests per minute in each case. Session relations already skip hidden pages and refresh on local changes; they keep their 10 s.

## Task 6: QR code on demand and a bundle budget

**Files:** `src/components/SessionScanner.tsx`, `src/components/SessionLink.tsx`, `packages/agent-remote-lab/bundle-budget.ts` (new Vite plugin, + test), `vite.config.ts`.

- [x] `jsqr` loads when scanning starts and `qrcode` when a QR code is first drawn; both keep working (existing tests).
- [x] The build measures each JavaScript chunk gzip-compressed and fails when the entry exceeds 70 KB or the App chunk 600 KB; `bundle-budget.test.ts` covers the limits, and a build with a 500 KB budget fails with the chunk named.

## Task 7: Relay commit cost of the IM records

**Files:** `packages/agent-remote-hosted/src/record-cache.test.ts` (or the services' tests).

- [x] Tests: with 1,000 drafts, 2,000 read positions and 32 outbox entries stored, saving a changed draft, advancing a read and settling an outbox entry each encode one record; adding a draft encodes the draft and the header. No kind encoded more.
- [x] Measured at the Relay's limits (1,024 drafts, 16,384 reads): a commit that advances one read spends ~21 ms (max 36 ms) walking and validating references, against p99 2 ms per request in production today. Caching each reference's key per frozen record would remove most of it if states ever grow that large.

## Ship

Full `pnpm verify`; the switch timing script on the local instance (with and without 4× CPU slowdown) and the jsdom harness, recorded here as after numbers; local check on desktop and phone, light and dark (Bot and Window modes, switching, typing, drafts across two pages, offline send); merge, push, Worker deploy (the website ships with the Worker). No Controller change is planned; if one becomes necessary, release it as in stage 5.

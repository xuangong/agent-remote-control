# Stage 7: Stability — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The workbench stays correct when things fail and over time, across Hosts:
- Attach failures back off instead of storming the Relay.
- The suites pass under load.
- Real-browser tests cover two Hosts, an offline Host and a handoff across providers.
- An hour-long soak shows no growth in memory, sockets or requests.
- The behaviours earlier stages promised but deferred ship.

**Architecture:** Every fix starts from a failing deterministic test: request counts with fake timers, Playwright against the in-process hosted Relay with real Controller runtimes and fake natives, and render or attach counts. Wall-clock numbers appear only in the soak report.

**Tech stack:** React 18 Lab, Vitest (jsdom, fake timers), Playwright with the production uplink and `createHostedRelay`, `createAgentHostRuntime` with fake native sessions, CDP metrics for the soak, `pnpm local` for the closing check.

## Baselines (2026-11-14, main 0ba5350c)

**Relay diagnostics** (Controller-side `relay-diagnostics.log`, one Host):
- **503 storm.** On 11-12 from 16:00 to 19:59Z, 2,715 `attach` RPCs failed with 503 (about 14 a minute for 3 hours). `restoreSession` (`src/session-restoration.ts`) retries every 5 s after a 5xx, 408, 429 or network error, for as long as the conversation or Track entry stays open. It has no backoff and no limit.
- **404s.** From 11-11 to 11-13, about 470 `attach` RPCs a day failed with 404 `native_session_unavailable`. They came in bursts of four simultaneous requests with the same duration, 5 to 70 s apart. A 404 ends one `restoreSession`, but a new one starts each time the inputs of the effect that owns it change. This applies to Track's attachment for each tracked session, a conversation's attach effect and others. On 11-14 there were 44 such failures, none after 12:00Z.

**Flakes seen during this roadmap's verifies:**
- agent-host `session-succession-capacity.test.ts`: "concurrent unrelated role writes…" takes 4.1 s alone (the file takes 16 s) against the package's 10 s `--testTimeout`.
- Lab `App.succession.test.tsx`: 70 of its 101 full-App tests run on the 10 s default. Only 31 pass the file's own `testDeadline` (30 s).
- The Lab e2e `bot-mode.spec.ts` still drives "Show as section" and "New section", which stage 1 replaced, so all ten of its tests fail before reaching what they check.

**Carried gaps:**
- *Stage 2, roadmap row 2:* the bot ⋯ menu has no New Side, TPM, Team or Call for support.
- *Stage 2:* desktop roster rows have no context menu.
- *Stage 3:* a sleeping bot shown in a compact Window layout stays live.
- *Stage 4:* after a handoff, only devices that composed the group continue a bot's row into its predecessor's reply.
- *Stage 4, not addressed here:* bots not opened since their Controller started keeping replies show no preview. Native history has neither a tail read nor reply times, so backfilling would read whole transcripts; previews arrive with the next reply or open.

## Task 1: Attach failures back off

**Files:** `packages/agent-remote-lab/src/session-restoration.ts` (+ test), `src/hooks/useSessionTracking.tsx`, `src/components/SessionConversation.tsx`, a new `src/unavailable-sessions.ts` (+ test).

- [x] `restoreSession` retries with exponential backoff: 5 s, 10 s, 20 s and so on, doubling up to 5 min. Jitter only shortens a wait, by up to a fifth. Page resume and coming back online retry at once and reset the delay; so do the Host returning and an explicit Retry, since both start a new restoration.
- [x] A session the Host reported unavailable (404 `native_session_unavailable`) is remembered per page (`src/unavailable-sessions.ts`). Conversation and Track attaches skip it, and so does the selected primary's binding through App. The memory is cleared by an explicit Retry, the Host coming back or 10 minutes passing.
- [x] Found while testing: the 404 bursts came from remounts. On load, a missing session's conversation mounted four times, as a view moving between Bot and Window mode mounts anew, and each mount asked again: six asks before, at most two now (the binding and its conversation ask together).
- [x] Tests (fake timers):
  - A session answering 503 for 30 min is attached 11 times without jitter, and at most 13 with the shortest waits (361 before).
  - One answering 404 is attached once across a mode switch, an access refresh, ten state frames, three bot switches and a page resume, and again after Retry.
  - A Host coming back attaches each waiting conversation once.

## Task 2: Flake sweep

**Files:** `packages/agent-host/src/session-succession-capacity.test.ts`, `packages/agent-remote-lab/src/App.succession.test.tsx`, others as found.

- [x] The capacity tests write and reread state files of up to 8 MiB, so the file gets a 60 s deadline with a comment saying why.
- [x] Every full-App test in `App.succession.test.tsx` uses the file's `testDeadline`. The file sets it with `vi.setConfig` at the top, so new tests inherit it.
- [ ] Run `pnpm test` three times in a row with the machine busy. For each failure, find the cause and fix it, or bound a deadline that is legitimately long with a comment. Record each one here.

## Task 3: Bot mode e2e matches the shipped model

**Files:** `packages/agent-remote-lab/e2e/bot-mode.spec.ts`.

- [x] Use the current model in the helpers:
  - Every group appears in Bot mode; there is no Show as section.
  - Bot mode's `+` is New bot; there is no New section or "Empty section".
  - Hiding is per mode, from the group menu.
  - Removing the selected bot returns to the roster.
- [x] Rewrite the section-only route test as a route to a group hidden in Window mode, which opens in Bot mode. A history view replaces the managed view as an ineligible bot (managed views are bots). In Bot mode the palette lists bots, since stage 1 lists sessions in Window mode. The palette test is desktop-only.
- [x] Run in chromium-desktop and chromium-mobile; the spec also runs in webkit-ask-desktop and webkit-ask-mobile. 31 pass, 1 skipped.
- [x] Found: a stage 6 regression. A bot's Handoff progress is portaled over the page but rendered in the bot's conversation, which a hidden-conversation gate kept frozen in Window mode, so Details did nothing. App now renders a bot's Handoff once, at its root. The e2e fails without the fix and passes with it.

## Task 4: Cross-Host end to end

**Files:**
- A new `packages/agent-remote-lab/e2e/cross-host-fixture.ts`.
- A shared `e2e/fake-native.ts` extracted from `session-succession-joined-fixture.ts`.
- A new `e2e/cross-host.spec.ts`.

The fixture is one hosted Relay (`createHostedRelay`, in memory) behind the Lab's static pages, with two Controllers ("Studio" and "Laptop"). Each Controller is a `createAgentHostRuntime` with its own installation and state directory, so it has an outbox. Each runtime registers providers `alpha` and `beta` with fake natives, which reply "<Host>/<provider>: <text>" to each message and support succession enrollment. Two uplinks connect the Controllers with outbox support. The fixture can disconnect and reconnect each Host and seed groups through `WindowWorkspaceClient`.

- [x] Two Hosts:
  - A group holds one bot on each Host. Bot mode lists both with their Host names.
  - Each send reaches its own Host, and the reply previews and unread dots of both arrive.
  - Switching between them keeps each draft.
- [x] An offline Host:
  - Disconnecting Laptop shows its bot offline while Studio's keeps working.
  - "Send when Laptop is back" queues a message that two pages show waiting.
  - Cancelling on one page removes it from both.
  - A second message is delivered exactly once after reconnecting and shows as sent.
- [x] Handoff across providers:
  - A bot on Studio `alpha` hands off to `beta`. The bot keeps its place and group, and the conversation continues across the divider.
  - Info lists `alpha` among previous providers, and a send reaches `beta`.
- [x] Runs in chromium-desktop and chromium-mobile: 18 of 18 runs passed, about 35 s for both projects.
- [x] Found on the phone run: a Host going offline reached the composer only at the Host list's next refresh, up to 30 s with the sidebar closed. The states channel says it at once: its view tells each Host's state, and App refreshes the Host list when that disagrees with it.

## Task 5: Create from a bot in Bot mode

**Files:** `src/components/BotActions.tsx`, `src/components/BotWorkspace.tsx`, `src/App.tsx` (the existing Side, TPM, Team and Call for support creation flows), tests.

- [x] Changed scope: Bot mode now offers **/side** (and /btw). Since Bot mode was a content-only view, Sides there had nowhere to go; now a Side joins the bot's group beside it, even when that group is not the Window shown in Window mode, and Bot mode opens it. Team, TPM and Call for support are created from their Window-mode panels, which have no Bot mode counterpart; they stay one switch away, from the bot's group in Window mode.
- [x] Test: /side from a bot of group B, while Window A is shown, attaches the Side to the bot's view in B, leaves A unchanged and selects the Side in B's section.

## Task 6: Sleeping bots in compact Window layouts

**Files:** `src/App.tsx`, `src/components/SessionDock.tsx` or `SessionWindow.tsx` as found, tests.

- [x] In a compact layout, a sleeping bot is not live (it counts against no budget). Where the wide layout shows the dimmed folded card, the compact layout shows the quiet Asleep bar with Wake, which wakes it for every device.
- [x] Found: the selected primary's binding asked the live budget, which counts a slot it has not met yet as live, so a sleeping primary was attached once on load, resuming its native session, in every layout. The binding now also checks the group's sleep.
- [x] Test: a sleeping primary and a sleeping dock in a 390 px Window are not attached; Wake wakes them, and the shown one attaches.

## Task 7: Context menu on desktop roster rows

**Files:** `src/ui/Menu.tsx` (point-anchored placement), `src/components/BotRoster.tsx`, tests.

- [x] A right click, or Shift+F10 or the context-menu key on a focused row, opens the row's bot menu at the pointer or the row. It has the same entries as the conversation toolbar's ⋯ menu and stays inside the viewport. Escape returns focus to the row. The ⋯ menu's popup became `MenuPanel`, shared by both.
- [x] Phones keep long-press free for scrolling and text selection: no context menu there.
- [x] Tests: the menu opens at the point, keeps within the viewport edges and runs an entry for that row (not the selected one).

## Task 8: A handoff's latest reply from the Controller

**Files:** `packages/agent-host/src/host.ts`, `src/session-replies.ts` or the succession service's lookup (+ tests).

- [x] Not needed: a second, fresh device already continues a handed-off bot's row with its latest reply, learning the chain from the Relay's succession records. The cross-Host Handoff test checks it from a second device. A Controller-side fallback was written and reverted, since the test passes without it, so stage 7 ships no Controller release.


## Task 9: Soak

**Files:** a new `packages/agent-remote-lab/e2e/soak.spec.ts` (runs only with `ARC_SOAK_MINUTES`); results in `performance/README.md`.

- [ ] Run for 60 minutes against the cross-host fixture (fake natives, no model cost) in headless Chromium:
  - every 5 s, switch bots;
  - every 20 s, send a message;
  - every 2 min, Window mode and back (no reloads, so growth shows);
  - one minute in every ten, Laptop away.
- [ ] Every minute after a forced garbage collection, record JS heap, DOM nodes, event listeners, open WebSockets, requests per minute and console errors.
- [ ] Budgets:
  - The heap and DOM nodes at minute 60 stay within 15% of minute 10.
  - Open WebSockets stay within the live budget plus the fixed channels.
  - Requests per minute stay flat.
  - No console errors.
- [ ] A 20-minute read-only soak on the local instance (prepare-arc-local, own sessions, no sends) records the same figures with real sessions.

## Task 10: Docs and release notes

**Files:**
- `docs/superpowers/plans/2026-11-14-bot-window-workbench-roadmap.md` (stages and outcomes).
- A new `docs/guides/bot-window-workbench.md`, a user guide covering Bot and Window modes, groups, fold and sleep, the IM layer, the outbox, the live budget and cross-Host use.
- `README.md` (feature tour).

- [x] The guide (`docs/guides/bot-window-workbench.md`) describes what ships, with the limits that remain (notifications without an open page, group chats, preview backfill, Worker rollback). The README gains a Bot mode section.

## Ship

Stage 7 changes no Controller code (Task 8 needed none), so it ships as a Worker deploy, website only:
1. Full `pnpm verify`.
2. The Lab e2e sweep in chromium-desktop and chromium-mobile for the Bot mode and cross-Host specs.
3. The soak report.
4. A local check on desktop and phone, light and dark.
5. Merge, push and deploy the Worker; record versions in the roadmap and the release memory.
6. Update this Mac's Controller to 0.2.82 last, after the final report: it runs this session.

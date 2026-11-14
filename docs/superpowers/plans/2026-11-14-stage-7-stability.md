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

- [ ] `restoreSession` retries with exponential backoff: 5 s, 10 s, 20 s and so on, doubling up to 5 min, with ±20% jitter. Page resume and coming back online retry at once and reset the delay; so do the Host returning and an explicit Retry, since both start a new restoration.
- [ ] A session the Host reported unavailable (404 `native_session_unavailable`) is remembered per page for its Host. Automatic attaches skip it (Track, conversations, docks, previews); none starts while the browser is offline or the page is hidden. The memory is cleared by an explicit Retry, the Host reconnecting, its catalog listing the session again or 10 minutes passing.
- [ ] Tests (fake timers):
  - A session answering 503 for 30 min is attached at most 12 times.
  - One answering 404 is attached once across a mode switch, an access refresh, ten state frames, three bot switches and a page resume, and again after Retry.
  - A Host coming back attaches each waiting conversation once.

## Task 2: Flake sweep

**Files:** `packages/agent-host/src/session-succession-capacity.test.ts`, `packages/agent-remote-lab/src/App.succession.test.tsx`, others as found.

- [ ] The capacity tests write and reread state files of up to 8 MiB, so the file gets a 60 s deadline with a comment saying why.
- [ ] Every full-App test in `App.succession.test.tsx` uses the file's `testDeadline`. The file sets it with `vi.setConfig` at the top, so new tests inherit it.
- [ ] Run `pnpm test` three times in a row with the machine busy. For each failure, find the cause and fix it, or bound a deadline that is legitimately long with a comment. Record each one here.

## Task 3: Bot mode e2e matches the shipped model

**Files:** `packages/agent-remote-lab/e2e/bot-mode.spec.ts`.

- [ ] Use the current model in the helpers:
  - Every group appears in Bot mode; there is no Show as section.
  - Bot mode's `+` is New bot; there is no New section or "Empty section".
  - Hiding is per mode, from the group menu.
  - Removing the selected bot returns to the roster.
- [ ] Rewrite the section-only route test as a route to a group hidden in Bot mode.
- [ ] Run in chromium-desktop and chromium-mobile; the spec also runs in webkit-ask-desktop and webkit-ask-mobile.

## Task 4: Cross-Host end to end

**Files:**
- A new `packages/agent-remote-lab/e2e/cross-host-fixture.ts`.
- A shared `e2e/fake-native.ts` extracted from `session-succession-joined-fixture.ts`.
- A new `e2e/cross-host.spec.ts`.

The fixture is one hosted Relay (`createHostedRelay`, in memory) behind the Lab's static pages, with two Controllers ("Studio" and "Laptop"). Each Controller is a `createAgentHostRuntime` with its own installation and state directory, so it has an outbox. Each runtime registers providers `alpha` and `beta` with fake natives, which reply "<Host>/<provider>: <text>" to each message and support succession enrollment. Two uplinks connect the Controllers with outbox support. The fixture can disconnect and reconnect each Host and seed groups through `WindowWorkspaceClient`.

- [ ] Two Hosts:
  - A group holds one bot on each Host. Bot mode lists both with their Host names.
  - Each send reaches its own Host, and the reply previews and unread dots of both arrive.
  - Switching between them keeps each draft.
- [ ] An offline Host:
  - Disconnecting Laptop shows its bot offline while Studio's keeps working.
  - "Send when Laptop is back" queues a message that two pages show waiting.
  - Cancelling on one page removes it from both.
  - A second message is delivered exactly once after reconnecting and shows as sent.
- [ ] Handoff across providers:
  - A bot on Studio `alpha` hands off to `beta`. The bot keeps its place and group, and the conversation continues across the divider.
  - Info lists `alpha` among previous providers, and a send reaches `beta`.
- [ ] Runs in chromium-desktop and chromium-mobile within the e2e's 2-worker sweep time.

## Task 5: Create from a bot in Bot mode

**Files:** `src/components/BotActions.tsx`, `src/components/BotWorkspace.tsx`, `src/App.tsx` (the existing Side, TPM, Team and Call for support creation flows), tests.

- [ ] The bot ⋯ menu offers New Side, New TPM, New Team and Call for support where the bot's Host and provider support them, as the Session View menu does in Window mode.
- [ ] Each runs the existing creation flow with the bot as source, and the new session joins the bot's group: a Side attaches to the bot's view; TPM, Team and Support views are added to the group. Bot mode then selects the new bot.
- [ ] Tests: each entry creates its session once and adds the view to the bot's group without changing another group. Unsupported entries are absent. A failure shows in the bot's error bar with Retry.

## Task 6: Sleeping bots in compact Window layouts

**Files:** `src/App.tsx`, `src/components/SessionDock.tsx` or `SessionWindow.tsx` as found, tests.

- [ ] In a compact layout, a sleeping bot is not live (it counts against no budget). Where the wide layout shows the dimmed folded card, the compact layout shows the quiet Asleep bar with Wake, which wakes it for every device.
- [ ] Test: a sleeping primary, dock and Side in a 390 px Window hold no conversation stream, and Wake attaches.

## Task 7: Context menu on desktop roster rows

**Files:** `src/ui/Menu.tsx` (point-anchored placement), `src/components/BotRoster.tsx`, tests.

- [ ] A right click, or Shift+F10 or the context-menu key on a focused row, opens the row's bot menu at the pointer or the row. It has the same entries as the conversation toolbar's ⋯ menu and stays inside the viewport. Escape returns focus to the row.
- [ ] Phones keep long-press free for scrolling and text selection: no context menu there.
- [ ] Tests: the menu opens at the point, keeps within the viewport edges and runs an entry for that row (not the selected one).

## Task 8: A handoff's latest reply from the Controller

**Files:** `packages/agent-host/src/host.ts`, `src/session-replies.ts` or the succession service's lookup (+ tests).

- [ ] When a session that is a role's current has no reply of its own yet, the Controller reports the role's previous session's latest reply for it. It stops once the successor replies. Every device then shows the bot's row continuing across a handoff without knowing the chain.
- [ ] Tests: after a committed succession, the successor's state carries the predecessor's facts until its own first reply. A session outside roles is unchanged.
- [ ] This changes the Controller, so it ships with a Controller release (0.2.83). Older Controllers keep today's behaviour.

## Task 9: Soak

**Files:** a new `packages/agent-remote-lab/performance/soak.mjs`; results in `performance/README.md`.

- [ ] Run for 60 minutes against the cross-host fixture (fake natives, no model cost) in headless Chromium:
  - every 5 s, switch bots;
  - every 20 s, send a message;
  - every 2 min, switch modes and reload;
  - every 10 min, disconnect and reconnect Laptop.
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
- A new `docs/bot-window-workbench.md`, a user guide covering Bot and Window modes, groups, fold and sleep, the IM layer, the outbox, the live budget and cross-Host use.
- The Controller release notes.

- [ ] The guide describes what ships, with the limits that remain (notifications without an open page, group chats, preview backfill).

## Ship

1. Full `pnpm verify` (Controller code changed), `pnpm test:setup` and `host-package`.
2. The Lab e2e sweep in chromium-desktop and chromium-mobile, comparing failures with the main baseline.
3. The soak report.
4. A local check on desktop and phone, light and dark.
5. Merge, push and deploy the Worker.
6. Release Controller 0.2.83, and record versions in the roadmap and the release memory.
7. Update this Mac's Controller last, after the final report.

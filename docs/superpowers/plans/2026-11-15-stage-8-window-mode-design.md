# Stage 8: Window mode as designed — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Window mode looks like the approved walkthrough's Window scene ([walkthrough](../../design-previews/2026-11-13-bot-window-walkthrough.html), "切到 Window：一个展开，其余折叠"). The Session View inside each pane stays as it is.

**Why now:** On 2026-11-15 the owner found Window mode unchanged ("window模式和现在长得没有变化，不是说重新设计的吗？"). Stages 1-7 shipped the walkthrough's Window behaviors: fold, sleep, open beside, the live budget and per-mode hiding. They did not ship its look. The product model says modernization concerns identity, groups, relationships, status and moving between the modes, and the roadmap counted the walkthrough's layout proposals as reviewed. So this stage applies them.

**Architecture:** Window mode reuses Bot mode's identity helpers (`botRole`, `botDisplayName`, `botActivityLabel`, the group's bot details), so a bot reads the same in both modes. The canvas is CSS on the existing dock rail (desktop, not compact): panes become cards without clipping, so popovers and resize handles keep working. Compact layouts keep their layout.

**Tech stack:** React 18 Lab, Vitest with Testing Library, Playwright e2e, `pnpm local` for the visual check on desktop and phone, light and dark.

## The gap

| Walkthrough | Before this stage |
| --- | --- |
| Windows rows: "6 bots · 1 open" | "Idle · 6 session views" |
| In this Window: each bot with its role tag, then Open, Folded or Asleep, and Working or Needs you | "Top-level", "Attached", "Floating", "Dock"; Sides nested under their source |
| Toolbar: "Release 2.4" and "6 bots" beside it | "6 session views" under the title |
| A grouped canvas with the panes as rounded cards and gaps between them | Panes edge to edge with hairlines |
| Folded bots as slim cards with picture, name, role and status | 44 px strips with a × always showing |
| No "View · Window" row under the mode switch | A View button and a "Window" eyebrow |
| Pane controls drawn as icons | A boxed × beside the icon-drawn star and ⋯ |

## Task 1: In this Window lists the group's bots

**Files:** `src/components/WindowWorkspaces.tsx` (+ test), `src/window-outline.ts` (+ test), `src/components/window-workspaces.css`, `src/App.tsx`.

- [x] A bot's row shows its name, its role tag and its label tag (Bot mode's `.lab-bot-role` and `.lab-bot-label`). Its second line is its place (Open, Folded or Asleep), then Working, Needs you or Failed when it has one; an asleep bot shows Needs you only.
- [x] Sides are first-level rows (relationships are metadata, not levels). Asks stay one level in under their bot, as one line: "Ask" and its title.
- [x] Other views keep their title; a history view says "Earlier session".
- [x] Tests: role and label tags, Folded · Working, Asleep, Asleep · Needs you, a Side at the top level, an Ask under its bot.

## Task 2: Windows count their bots

**Files:** a new `src/window-summary.ts` (+ test), `WindowWorkspaces.tsx`, `src/App.tsx` (command palette subtitles), `src/shell/WindowToolbar.tsx` (+ test).

- [x] `windowSummary(views, folded)` returns "6 bots · 1 open" when some bots are folded or asleep, "3 bots" otherwise, "1 view" or "2 views" without bots, and "Empty" with no views.
- [x] Window rows show Working, Needs you or Failed before it, never Idle.
- [x] The toolbar shows the count beside the title, and the command palette uses the same words.

## Task 3: The canvas

**Files:** `src/components/session-dock.css`, `src/components/SessionDock.tsx` (+ test).

- [x] In a desktop Window, the rail is a grouped background with 8 px padding and gaps. Each pane is a card (`--ui-radius-pane`, `--ui-shadow-pane`). Corners are drawn by an overlay in the canvas color rather than by clipping, so menus, Info and floating Asks are never cut.
- [x] Resize handles sit in the gaps and show a line on hover or focus. Selection follows the card's corners.
- [x] Folded bots are 64 px cards; their × shows on hover or keyboard focus. Other minimized panes keep 44 px.

## Task 4: The sidebar heading and pane controls

**Files:** `src/App.tsx`, `src/components/SessionWindow.tsx`, e2e specs that located the old heading.

- [x] The "View · Window" row goes. With a desktop Window shown, View options sits at the start of its toolbar. Elsewhere it keeps its current slots, and the sidebar slot stays only while no toolbar is shown.
- [x] A pane's × (fold or close) is an icon button like the heading's other icons.

## Task 5: Check, docs and ship

- [x] Run the local instance on desktop and phone, in light and dark, against the walkthrough.
- [x] The Lab e2e specs that cover Windows (window-workspaces, window-pane-lifecycle, session-view-ownership, modernization, bot-mode, cross-host) in chromium-desktop and chromium-mobile.
- [x] Update the guide's Window section and add roadmap row 8.
- [x] `pnpm verify:changed` (Lab 2,788 tests); merged and pushed (main b7b68f61); Worker e95b70ab deployed (previous 69cc5571), website only. The Relay reported it five minutes later. The stored format did not change, so rolling back to 69cc5571 is safe.

## Findings

- **The e2e sweep.** 13 Window, pane, Team and Bot mode specs ran in chromium-desktop and chromium-mobile, 264 tests. 67 failures matched a baseline run of the same specs on the code before this stage (6fbb5362): session-forks, window-pane-lifecycle, Team and others, as recorded since October. Two did not:
  - `modernization.spec.ts:44` looked for View in the sidebar. A desktop Window now keeps it in its toolbar, and in the heading of Trace or a page while one shows, so the sidebar never gains or loses a row. The check was updated.
  - `team.spec.ts` "Add member Browse" on mobile passed 3 of 3 alone, so it is flaky.
- **A loading Window opened scrolled away from its selection.** Every dock brought itself into view as it mounted, so the last dock won and the first pane was cut off at the left. Now only the selected view's dock does; opening a view beside still selects and reveals it.
- **Kept as they are:** the sidebar's Window options disclosure (the e2e reach Copy link and Agent control through it; on desktop the toolbar's ⋯ offers the same), the phone's Window layout (the walkthrough's phone scene is Bot mode) and Team's Gather button.

## Follow-up: two errors the owner met after the release

- **"A bot keeps its conversation. Open the other session beside it."** In a group with bot details (a bot labeled, asleep or hidden, or a group started with + New bot), **Continued from** above a handed-off bot's pane bound the pane to the earlier session as a history view, and the group refuses any edit that takes a bot's conversation away (rule 1). The pane's session list and links in the conversation asked the same of the bot's view. Now:
  - The bot's Window pane reads its earlier sessions in place, above the quiet divider, as Bot mode does; **Continued from** scrolls there. Reading uses HTTP pages only, so no second stream is opened and nothing is rebound.
  - Every other way of opening a session over a bot in such a group opens it beside the bot. `rebindsBot` in the protocol is the one test the Relay and the clients share.
  - Windows without bot details keep opening the earlier session in the pane, with **Return to current**; nothing refuses that.
- **"Retry message: The operation may have reached the native runtime…"** A send whose outcome the Host cannot settle came back on Retry as the Host's operator text, in a toast. Now the outgoing message carries plain words ("This message may not have arrived. If it is not in the conversation, Retry sends it again."), no toast repeats the raw text, and the next Retry sends with a new operation, as it already did.
- Tests: protocol (`rebindsBot`), web (the message and its retry), Lab (the bot pane, the session list over a bot, the retry toast) and a Playwright check on desktop and phone (`bot-mode.spec.ts`, "reads a handed-off bot's earlier session in its Window pane").
- **A UUID for a name.** A page that never showed a bot's earlier session knows no title for it, so Continued from named it by its native ID. It now says "previous session" (older ones "Earlier session"), with the ID in the tooltip.
- Checked on the local instance with a real Claude handoff: an ordinary Window still opens the earlier session in the pane and returns; once the bot has a label, the pane reads it in place and Continued from scrolls there, with no error. The e2e sweep (bot-mode, session-succession, session-succession-joined, message-delivery, pending-send, session-connection-errors, session-link, window-workspaces, session-view-ownership; desktop and phone) had 26 failures, all failing on the code before this change too (20 in stage 8's baseline list, 6 rerun on 724bf155). `pnpm verify:changed` passed. Shipped from main ddc64456 as Worker 8162e064 (previous e95b70ab), website only. The stored format did not change, so rolling back to e95b70ab is safe.

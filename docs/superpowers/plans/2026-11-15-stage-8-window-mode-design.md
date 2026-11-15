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

- [ ] A bot's row shows its name, its role tag and its label tag (Bot mode's `.lab-bot-role` and `.lab-bot-label`). Its second line is its place (Open, Folded or Asleep), then Working, Needs you or Failed when it has one; an asleep bot shows Needs you only.
- [ ] Sides are first-level rows (relationships are metadata, not levels). Asks stay one level in under their bot, as one line: "Ask" and its title.
- [ ] Other views keep their title; a history view says "Earlier session".
- [ ] Tests: role and label tags, Folded · Working, Asleep, Asleep · Needs you, a Side at the top level, an Ask under its bot.

## Task 2: Windows count their bots

**Files:** a new `src/window-summary.ts` (+ test), `WindowWorkspaces.tsx`, `src/App.tsx` (command palette subtitles), `src/shell/WindowToolbar.tsx` (+ test).

- [ ] `windowSummary(views, folded)` returns "6 bots · 1 open" when some bots are folded or asleep, "3 bots" otherwise, "1 view" or "2 views" without bots, and "Empty" with no views.
- [ ] Window rows show Working, Needs you or Failed before it, never Idle.
- [ ] The toolbar shows the count beside the title, and the command palette uses the same words.

## Task 3: The canvas

**Files:** `src/components/session-dock.css`, `src/components/SessionDock.tsx` (+ test).

- [ ] In a desktop Window, the rail is a grouped background with 8 px padding and gaps. Each pane is a card (`--ui-radius-pane`, `--ui-shadow-pane`). Corners are drawn by an overlay in the canvas color rather than by clipping, so menus, Info and floating Asks are never cut.
- [ ] Resize handles sit in the gaps and show a line on hover or focus. Selection follows the card's corners.
- [ ] Folded bots are 64 px cards; their × shows on hover or keyboard focus. Other minimized panes keep 44 px.

## Task 4: The sidebar heading and pane controls

**Files:** `src/App.tsx`, `src/components/SessionWindow.tsx`, e2e specs that located the old heading.

- [ ] The "View · Window" row goes. With a desktop Window shown, View options sits at the start of its toolbar. Elsewhere it keeps its current slots, and the sidebar slot stays only while no toolbar is shown.
- [ ] A pane's × (fold or close) is an icon button like the heading's other icons.

## Task 5: Check, docs and ship

- [ ] Run the local instance on desktop and phone, in light and dark, against the walkthrough.
- [ ] `pnpm verify:changed`, and the Lab e2e specs that cover Windows (window-workspaces, window-pane-lifecycle, session-view-ownership, modernization, bot-mode, cross-host) in chromium-desktop and chromium-mobile.
- [ ] Update the guide's Window section and add roadmap row 8.
- [ ] Merge, push and deploy the Worker (website only); record versions.

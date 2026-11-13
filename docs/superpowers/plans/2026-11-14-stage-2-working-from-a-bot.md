# Stage 2: Working from a bot — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bot's conversation survives handoffs in Bot mode, a bot can be managed and extended from its own menu, and Window panes follow rule 6 as a whole.

**Architecture:** Reading across a handoff reuses the succession chain the Lab already validates (`succession.historyNavigationFor`) and loads each earlier session read-only over HTTP (attach, snapshot, timeline pages) into a private replica, shown through a new optional top slot of the shared timeline; no session stream, no control, no composer. Bot actions operate on the group document (details, views) and on the existing creation flows. Window panes gain fold-on-close and explicit removal before "open beside" applies to them.

**Tech stack:** React, the shared `AgentTimeline` (`agent-remote-web`), Lab hooks, Vitest, `pnpm local`.

## 2a — reading across a handoff, the bot menu, new sessions start groups

### Task 1: A top slot in the shared timeline

**Files:** `packages/agent-remote-web/src/react/AgentTimeline.tsx`, `packages/agent-remote-lab/src/components/SessionWorkbench.tsx` (`WorkbenchTimeline`), tests beside them.

- [x] Test: with `timelineStart` and `hasOlder: false`, the slot renders before the entries and the empty-content text is not shown; with `hasOlder: true` the slot is not rendered (History controls are); without the prop nothing changes.
- [x] Implement `readonly timelineStart?: ReactNode` rendered as `{state.timeline.hasOlder ? <HistoryControls …/> : timelineStart}`; suppress the empty paragraph when `timelineStart` is present.
- [x] Thread `timelineStart` from `SessionWorkbench` props to `WorkbenchTimeline` and keep its memo stable.
- [x] Commit `feat(web): let a conversation show earlier content above its own timeline`.

### Task 2: An earlier session, read-only

**Files:** create `packages/agent-remote-lab/src/components/EarlierConversation.tsx` (+ `.css`, `.test.tsx`).

Behavior: given `{ baseUrl, transport, sessions: SessionEntry[] }` (newest first: predecessor, then ancestors), show the newest earlier session's cached display (`readWorkspaceSnapshot`) at once, attach it with `SessionDirectoryClient(baseUrl, undefined, hostId).attach(providerId, nativeSessionId, signal)`, fetch `fetchSnapshot` and `fetchTimeline(agentId, 'tail', undefined, 100)` into a private `AgentReplica`, and render `AgentTimeline` (no header, no interactions, `onLoadOlder` over HTTP `before` pages). When that session has no older pages, a quiet "Earlier" button reveals the next ancestor above it. Between the earlier content and the current conversation, a hairline divider (entries keep their own times, so the divider carries no label); Bot mode does not announce a handoff. Failures show a quiet retry line, never an alert over the conversation.

- [x] Tests with a fake transport and directory: cached entries show before the fetch resolves; the fetched tail replaces them; Load older requests `before` the first entry; the next ancestor appears only after the first has no older pages; no `connect` is ever called; the divider is a labelled separator.
- [x] Implement; CSS with native restraint (divider: hairline with a small centered label in the secondary color).
- [x] Commit `feat(lab): read an earlier session of a bot without opening it`.

### Task 3: Bot mode continues into earlier sessions

**Files:** `packages/agent-remote-lab/src/App.tsx` (`sessionViewPresentation`), a test in `src/App.succession.test.tsx` or `src/App.bot-mode.test.tsx` using the fixture's succession replays.

- [x] Test: after a handoff replay, Bot mode's conversation shows the predecessor's content above the successor's (read-only, content only) and Window mode keeps its "Continued from" link instead.
- [x] Implement: in Bot mode, `const navigation = succession.historyNavigationFor(source)`; when it has a predecessor, `timelineStart = <EarlierConversation sessions={[navigation.predecessor, ...navigation.ancestors]} … />`, memoized by those sessions' keys. Earlier sessions attach through the selected Host's directory client like every other session. The chain appears once the handoff's role checkpoint is applied; switching bots while it applies can leave it pending (`image_cancelled`) until the next synchronization, as in Window mode.
- [x] Verify on the local instance with a real handoff (the 2026-11-14 check left "Release check" empty; it now shows the predecessor's exchange above the divider on desktop and phone, light and dark).
- [x] Commit `feat(lab): continue a bot's conversation into its earlier sessions`.

### Task 4: The bot menu

**Files:** `packages/agent-remote-lab/src/components/BotWorkspace.tsx` (conversation toolbar trailing ⋯), `BotRoster.tsx` (row context menu on desktop via the same entries), tests.

Entries: Info (Host name, provider, model when known, previous providers from the succession chain), Label… (set or clear `details.label`), Hide in Bot mode (per-bot `details.hidden`; the bot stays a pane in Window mode), Remove from group (closes the view; confirmation sheet, as Window deletion does).

- [ ] Tests for each entry's group operation and for Info's content.
- [ ] Implement with `ui/Menu`, `ui/Sheet`; a group without details gets `bots.add` in the same batch as `bot.update`.
- [ ] Commit `feat(lab): manage a bot from its menu`.

### Task 5: A new session in Bot mode starts a group

**Files:** `BotWorkspace.tsx` (the roster `+`), `App.tsx` (the existing New session flow), tests.

- [ ] Test: Bot mode's `+` opens New session; creating a session there creates a group whose Window holds it as the primary view, titled after the session, hidden in no mode, and selects the new bot; the empty New section form is gone.
- [ ] Implement by reusing the New session panel in a sheet (desktop) or the compact page (phone) and `useWindowWorkspace`'s creation with the session bound.
- [ ] Commit `feat(lab): start a group from a new session in Bot mode`.

## 2b — rule 6 in Window panes, creation joins the bot's group

Written after 2a ships: open beside in every pane, closing a bot's pane folds it, Remove from group is explicit, navigation within a bot's chain stays in place; Side, TPM, Team and Support created from a bot join its group.

# UI modernization: state, open issues and next steps

Updated: 2026-11-12. This document hands the work over to another computer. It covers:

- where things stand;
- how to set up and work;
- what to do about each open issue;
- how to carry out the remaining phases of the UI modernization;
- what work remains beyond those phases.

Spec: [`docs/superpowers/specs/2026-11-09-ui-modernization-design.md`](../superpowers/specs/2026-11-09-ui-modernization-design.md).

Plans already carried out are in `docs/superpowers/plans/`:

- `2026-11-09-ui-modernization-phase-1.md`
- `2026-11-10-ui-modernization-phase-2a.md`
- `2026-11-10-ui-modernization-phase-2b.md`
- `2026-11-12-ui-modernization-phase-2c.md`

Each plan ends with "Changes made during execution", which records what differed from the plan and what was left over. Read those sections before planning the next phase.

## 1. Where things stand

| Item | State |
|---|---|
| main | `a05b4266` (phase 2c merged), plus this document |
| Phases | 1, 2a, 2b and 2c are done, merged and deployed |
| Worker (Cloudflare) | Version `1a30aa8c` is live (2c). Roll back to `750bd262` (fix/e2e-repair) if needed |
| Controller | No release is needed for phases 1–2. fix/clean-baseline fixes `session set --title`, which always failed with "operationId is required"; it reaches users with the next Controller release |
| origin/main | The user pushes main by hand from the first computer; before that, main was about 190 commits ahead. On the new computer, `git log origin/main..main` should be empty after cloning, and the latest commits should include this document; if they don't, the push has not happened yet (§4.1) |

What phases 1–2 delivered:

- **Phase 1.** Semantic `--ui-*` tokens with a dark appearance that follows the system. The `--obs-*` variables are mapped onto them. System typography, an own icon set (`src/ui/Icon.tsx`), and the primitives in `packages/agent-remote-lab/src/ui/`: Button, IconButton, SegmentedControl, ListRow, Avatar, StatusBadge, Menu, Sheet and Toolbar.
- **Phase 2a.** The shared shell frame:
  - the Window / Bot mode switch and the **+** menu at the top of the sidebar (`src/shell/SidebarHeader.tsx`);
  - an Apple-style sidebar, and a toolbar above the Bot conversation;
  - shortcuts: ⌘\ collapses the sidebar, and ⌥⌘1 / ⌥⌘2 switch modes.
- **Phase 2b.** Window-mode sidebar content: Windows, In this Window and Shortcuts.
  - The All sessions page and the Settings page live in `#lab-sessions-page`.
  - The floating capsules hide while the desktop sidebar is visible; their entries move into the sidebar through `src/shell/movable-host.tsx`.
  - On a cold start, the cached Window is shown read-only until the server confirms it.
- **Phase 2c.** The Window toolbar (`src/shell/WindowToolbar.tsx`):
  - rename in place;
  - **+**: New session view, Open session…;
  - Hide / Show docks;
  - ⋯: Show as section, Copy link, Agent control…, and Delete Window… with a confirmation.

  It also added the ⌘K command palette:
  - `src/shell/command-search.ts` ranks the results;
  - `CommandPalette.tsx` is the dialog;
  - `command-items.ts` builds the items.

  `src/hooks/useWindowActions.ts` is shared by the sidebar and the toolbar.

## 2. Setting up the new computer

1. **Node 24, not Node 26.** Use Node 24 (nvm `v24.22.1` worked). Node 26 has a built-in `localStorage` global, which hides jsdom's: every Lab unit test that touches `localStorage` then fails with `Cannot read properties of undefined (reading 'setItem')`. This also breaks `pnpm verify` and `pnpm verify:changed`. Check with `node --version` before running tests.
2. **Clone and install.**
   1. Clone, then run `pnpm install` at the root.
   2. Run `pnpm exec playwright install chromium webkit` in `packages/agent-remote-lab`.
   3. No git hooks are needed. Pushing runs no checks since 2026-11-12; see §3.
3. **Deploy access.** Run `pnpm exec wrangler login` in `packages/agent-remote-cloudflare`. Deploying needs a Cloudflare account that can reach the `agent-remote-control` Worker. The site is `https://agents.xianliao.de5.net`.
4. **Local instance.** Use the `prepare-arc-local` skill (`.claude/skills/prepare-arc-local/`), then `pnpm local up` in a worktree. It needs a session that may listen on ports and start background processes.
5. **Claude memory is per computer.** The facts that mattered are repeated here (§3, §4, §6). The older notes in `.claude` memory on the first computer are not carried over.

## 3. Working rules (learned the hard way)

**Branches and worktrees**

- Work in `.worktrees/<name>` on a feature branch. Merge into main with `--no-ff`.
- Never use `--no-verify`. Fix what the hooks report.

**Every Lab change**

- From the root, run `pnpm compatibility:update` then `pnpm compatibility:check`, and commit `packages/agent-remote-lab/compatibility.json`.
- If you skip this, `src/server/codex.test.ts` and `src/server/live-launcher.test.ts` fail.

**Unit tests**

- Run these from `packages/agent-remote-lab`:
  - `pnpm --silent typecheck`;
  - `npx tsc --noEmit -p tsconfig.e2e.json`;
  - `pnpm --silent test` (about 2,650 tests, 100 s).
- Server tests need python3 and local sockets, so run them outside any sandbox.
- **Known flakes under parallel load.** A failure in one of these files alone is not evidence; rerun the file by itself:
  - `App.succession.test.tsx`
  - `hosted-runtime.test.ts`
  - `devbox`
  - `gateway-state`
  - `dsh-plugin-package`
  - `authority-renewal` (cloudflare)
  - `team-resource-files` mkfifo (agent-host)

**e2e (Playwright)**

- Rebuild the Lab `dist` first (`pnpm --filter @orchardworks/agent-remote-lab build`). Many specs serve the built `dist`, and a stale build once produced about 130 false failures.
- Run one spec at a time on a project, with private ports so parallel agents don't collide:
  `AGENT_REMOTE_TEST_RELAY_PORT=5981 AGENT_REMOTE_TEST_WEB_PORT=6246 npx playwright test e2e/<spec>.spec.ts --project=chromium-desktop --reporter=line`
- Never wait for `networkidle`: the Window long poll keeps the network busy.
- Session views sit in `.lab-session-conversation-destination > .lab-session-conversation-host`. Use descendant selectors, not `> .lab-session-view`.
- **Branch vs baseline.** To compare a branch with main, run the baseline in a separate worktree at main's commit. Compare by test title, because line numbers move. Afterwards, kill any leftover servers that hold the ports (`lsof -i :5981`).

**Controller-hosted sessions**

- A Controller restart or update ends hosted sessions. Ask first, and make the restart the last action.
- The Worker is always deployed before a Controller release.

**Deploy (website / Worker)**

1. At the root: `pnpm -r run build && pnpm build:relay`.
2. In `packages/agent-remote-cloudflare`, run `pnpm exec wrangler deployments list` and note the current version for rollback.
3. Deploy: `pnpm exec wrangler deploy --message "<sha>: <summary>"`.
4. Check the live site: `curl -s https://agents.xianliao.de5.net/ | grep -o 'assets/index-[^"]*\.js'` must name a file that exists in `dist/relay/web/assets/`, and `/health` must return 200.

Push, deploy and publish only with the user's go-ahead. They approve each milestone separately.

**Pushing and checks**

- Tests are decoupled from pushing: there is no pre-push hook, and `git push` is quick. This was the user's decision on 2026-11-12.
- Before a merge or a push, when you want the checks, run `pnpm verify:changed` (`scripts/verify-changed.sh`). It covers:
  - the compatibility check;
  - the build and the type check;
  - the unit tests of the packages changed since the merge base with `origin/main`, and of their dependents;
  - the full `pnpm verify` when files outside `packages/` and `docs/` changed.

  Releases still run `pnpm verify`.
- If a test fails, rerun its file alone. If it passes alone, it is a known flake (§3); otherwise, fix it.

**Secrets**

- Never print `~/.agent-remote-control/agents-cloud-cli/connection.json`, tokens or gateway keys.

## 4. Open issues and how to handle each

The user's rule: an issue that was not introduced by the current change still gets fixed if at all possible. The test may be the thing that is wrong. Decide which side is wrong before you change anything.

### 4.1 Push main (do first)

If this document's commit is not on `origin/main`, push it. The push runs no tests (§3). Before 2026-11-12 the push hook failed only on flakes:

- cloudflare `authority-renewal` timed out;
- agent-host `team-resource-files` failed on mkfifo;
- debugger `cli-process` reported `wait_timeout` instead of `command_timeout`. This one is fixed: `withinDeadline` maps it.

The first two pass 3 out of 3 times when run alone.

### 4.2 The `modernization` e2e spec (resolved)

The spec passes in chromium-desktop (fix/clean-baseline). The five failures had three causes:

- **TPM 404 (product).** The TPM catalog polled every selectable Host, including the "Lab server" that local providers add. The Lab server is not a Controller and has no TPM route, so a workbench with local providers logged a 404 every ten seconds. TPM now polls paired Hosts only.
- **Timeline width (test).** Window views have their own width (440px by default) since multiple primary groups, so hiding the sidebar widens the Window and not the timeline.
- **"Load resource" (test).** The button exists; the Settings and New session pages cover the Window, so the test now returns to the Window before measuring it. The test also counted the feature-view switches (Ask, Window, TPM, Team) as panels.

In chromium-mobile the spec still fails 4 tests (main failed 8): "opens session settings…", "keeps one View entry…", "meets AA contrast…" and "provides coarse-pointer controls…". They belong to §4.4.

### 4.3 `App.succession.test.tsx` cascades under load (resolved)

**Cause.** Under load, a test ran past its deadline. Vitest moved on, but the test kept running, and its `act()` calls overlapped the next test's ("overlapping act() calls"). That broke React's act environment for every later test in the file. Load set it off because 40 waits used `vi.waitFor`'s 1 s default.

**Fix.**
- Waits share one loop. It finishes each attempt before the next, gives up after 5 s, and stops once its test has ended.
- `act` is tracked, and the cleanup lets running work finish before it unmounts.
- The file's tests have a 30 s deadline.

**Result.** Running alone, the file takes as long as before. With the full Lab suite and three more copies of the file running at once, it passes 163 of 163, where it failed 151.

**Reproducing the cascade.** Make one test outlive its deadline while a wait loop runs, then run it with the next tests (`-t "first|second|third"`); the later tests fail at once with `succession` undefined.

**Other load-sensitive tests.** Under that same load, these other tests still timed out; they pass under a normal run:
- "keeps Window A/A2 and both display settings while Bot B1 shares its exact view draft";
- "rejects new owners beyond the durable catalogue bounds…";
- "refuses a near-ceiling handoff…";
- "keeps a native Codex session usable when an independent Host pairs to a restarted backend".

Treat them one file at a time, in the same way: first look for a test outliving its deadline, then for short waits.

### 4.4 Sweep the mobile and WebKit e2e projects

Only chromium-desktop has been cleared (fix/e2e-repair, 9b58607f). The other projects are listed in `packages/agent-remote-lab/playwright.config.ts`:

- `chromium-mobile`
- `webkit-ask-desktop`
- `webkit-ask-mobile`
- `webkit-mobile-viewport`

Known causes there:

- **Duplicate "New session" buttons.** The sidebar's "＋ New session" and the workbench button both match `getByRole('button', { name: 'New session', exact: true })` (strict-mode violation). Examples: `mobile.spec.ts:247` and `:258`, and about 15 tests in provider-layout. Decide which control the test means and scope the locator to its region.
- **`toHaveValue` on the composer.** The composer is ProseMirror, not an input, so `toHaveValue` throws "Not an input element". Use `toHaveText` on the editor instead.
- **Side conversations moved.** `session-unlink` and `session-forks` wait for a `complementary` "Side conversation", but Sides now open as attached Window panes. chromium-desktop already rewrote these against the pane, using `e2e/paired-host.ts` for the forks; port the same changes.
- **`tap()` without touch.** `mobile-keyboard-controls` calls `tap()` in a project without `hasTouch`.
- **Hidden controls at 320/390px.** Narrow layouts hide controls behind "Expand session actions": `content-only-view`, `view-overflow`, `dock-title-interactions:170` and `session-family-resize:259`. Decide whether the product should keep the control reachable; often the right fix is the test opening the overflow first.

Method:

1. Run each project spec by spec.
2. Fix the test or the product.
3. Record anything that cannot be fixed, with its reason, in this document.

Phase 5 (phones) changes these layouts again, so prefer locators by accessible name and region over CSS structure.

### 4.5 `e2e/*.browser.ts` files (resolved)

All 14 browser test files pass (`npx vitest run -c vitest.preview.config.ts`, about 60 tests in Chromium and WebKit). Rebuild agent-remote-web first: the fixtures bundle its `dist`.

- **Build.** `pending-send` and `session-search` had no esbuild output path. They now take the product's styles from the bundle (`session-view-styles.ts`), as the other fixtures do.
- **`pending-send`.** Its session state predated the rule that a session is synchronized only once its Timeline is initialized.
- **`session-search`.** The reasoning stayed shown because the workbench chooses its own display mode from the view's preferences, so the outer content-only context no longer applied. `useItemDisclosure` was not at fault: in the content display, closing the search hides the revealed reasoning.
- **`session-recovery`.** The fixture's directory pointed at the legacy `local` route, so the session never connected. In the 390px view, the floating TPM, Window and Team capsules cover the first message's Retry and Delete (see §5.4).
- **`session-letters`.** Besides test updates, there were two product fixes:
  - Tapping the entry that a search revealed closed the search and removed a hidden letter.
  - At 402px the expanded session actions overflowed under their toggle. They are now 42px wide below 480px; see §5.4.
- **`preview-subdomain`** failed on this machine only: a system proxy and a resolver that answers every name kept Chromium from honoring `--host-resolver-rules`. The test now connects directly and bypasses proxies.

### 4.6 Smaller items found in the 2c review

- **Delete from the sidebar has no confirmation.** The Windows sidebar ⋯ menu deletes a Window without asking, but the spec requires a confirmation. Reuse the toolbar's `Sheet`, "Delete this Window?", by moving it into `useWindowActions` or a shared component.
- **The palette rebuilds its items on every render.** While it is open, `commandItems()` runs on each App render. Memoize it if profiling shows a cost.

### 4.7 Cleanup on the first computer only

The old worktrees and local instances stay on the first computer.

- These local instances are stale and can go: `ui-modern`, `ui-modern-2`, `ui-modern-3`, `e2e-repair` and `bot-mode-ui`.
- The `ui-modern-4` instance is still running.

In each worktree, run `pnpm local down` and then `pnpm local remove --yes` before `git worktree remove`.

These worktrees are merged and safe to remove:

- `ui-modern`, `ui-modern-2`, `ui-modern-3`, `ui-modern-4`
- `e2e-repair`
- `e2e-baseline` (detached)

Check the others in `git worktree list` with `git rev-list --count main..<branch>` before removing them.

## 5. How to carry out the remaining phases

### 5.1 Process for every phase

The spec is approved, so no new brainstorming is needed unless a decision is open. For each phase:

1. Create a worktree from the current main, for example `.worktrees/ui-modern-5` on `feat/ui-modern-5`. Phases build on each other, so start each one only after the previous one has merged.
2. Write the plan with the `superpowers:writing-plans` skill: `docs/superpowers/plans/<date>-ui-modernization-phase-N.md`. Include the leftovers listed below for that phase, plus anything in earlier plans' "Changes made during execution". If the phase is large, split it like phase 2 (a/b/c), each part merged and deployed on its own.
3. Execute with `superpowers:subagent-driven-development`: one implementer per task, then a spec review and a code-quality review.
   - Give subagents the full task text.
   - Subagents sometimes fail with a false "content safety" 422. Retry them, or do the step inline.
4. Verify:
   1. typecheck in both configs, the unit suite and compatibility;
   2. the primitives browser test: `npx vitest run -c vitest.preview.config.ts e2e/ui-primitives.browser.ts`;
   3. the touched e2e specs on chromium-desktop, plus `ask-session`, `session-succession` and `team`;
   4. from phase 5 on, also chromium-mobile and webkit-mobile-viewport;
   5. on the local instance, real Claude Code turns, plus a headless Playwright script at 1440×900 and 390×844 that drives the new UI. Take screenshots in light and dark mode, and read each image.
5. Run a final whole-branch review with the `superpowers:code-reviewer` agent. It finds problems that the per-task reviews miss.
6. Record deviations in the plan, then report to the user and ask before merging and deploying.

Rules from the spec:

- A control that still exists keeps its accessible name, so existing tests keep working.
- Contrast meets WCAG AA in both appearances.
- Keyboard-only use works.
- `prefers-reduced-motion` is honored.
- Measure Window switching and bot switching (long tasks, Playwright) before and after each phase.

### 5.2 Phase 3: Bot mode

This is the spec's "Bot mode" section. Files:

- `src/components/BotWorkspace.tsx`, `BotRoster.tsx`, `bot-workspace.css`;
- `src/bot-roster.ts` (projection), `src/hooks/useBotWorkspace.ts`;
- the conversation and composer in `packages/agent-remote-web/src/react/`: `AgentTimeline.tsx`, `ConversationEntry.tsx`, `AgentComposer.tsx`, `InteractionPanel.tsx`, `MarkdownContent.tsx`.

The Window-mode timeline also uses the conversation and composer files, so put Bot-only styling under the Bot mode root, or behind the content-only display.

Suggested split:

- **3a: roster.**
  - Rows: Avatar, name, and a subtitle (the label, or the start of the latest reply).
  - One trailing status by priority: needs you (orange count) > failed > working (spinner) > new result (blue dot).
  - Pinned section, section ⋯ menus, Other sessions collapsed with "Host · provider", Hidden Bots.
  - A row context menu at the pointer. The anchored `Menu` cannot open at the pointer yet; that gap is listed in phase 1's notes.
  - New-result tracking stores, in local storage, what this browser last showed for each bot.
- **3b: New Bot sheet and bot details.**
  - Name, picture (3 shapes × 8 colors), label, provider / Host / workspace / model defaulting to the last choice, and an optional first message.
  - Details open from the toolbar name and allow editing in place.
  - The toolbar title currently repeats the Session View header (noted in 2a); phase 3 owns that header and should remove the duplicate.
- **3c: conversation and composer.**
  - User bubbles on the right; full-width Markdown replies with the avatar at each turn.
  - Tool activity and reasoning folded into one line per turn, which expands in place.
  - "Needs you" cards for approvals, questions and plans; red failure cards with Retry.
  - Day separators and "Jump to latest".
  - Composer pills; Send becomes Stop.
- **3d: Threads panel.** Sides and Asks of the bot in a collapsible right panel on desktop, full screen on phones.

Leftovers from phase 1 to fold in:

- **Status colors.** Working is blue in the spec, but running session titles and the tracking pulse are still green.
- **Contrast.** These pairs need fixing:

  | Pair | Contrast |
  |---|---|
  | Destructive text on `--ui-fill` | 4.22:1 light, 3.79:1 dark |
  | Primary hover in dark | 3.94:1 |
  | ListRow subtitle on a hovered dark row | 3.72:1 |
  | Unread dot in dark | 2.86:1; use `--ui-accent-text` |

  Check whether 2a already fixed them, then extend `tokens.test.ts` with composited pairs.

### 5.3 Phase 4: Window mode panes

This is the spec's "Window mode → Panes" section. Files:

- `src/components/SessionHeading.tsx`, `SessionHeadingActions.tsx`, `SessionViewOptions.tsx`;
- `SessionDock.tsx` and `session-dock.css`;
- the float and Window layout code around `WindowLayoutContext` in `App.tsx`;
- the Team, TPM and Ask views.

Scope:

- **Pane header.** A status dot, the title, the state (idle / working / needs you / failed), a ⋯ menu, and ✕ on hover. The menu holds Favorite, New Side, Ask, Search in conversation, Display (full / preview / content only), Session settings, Hand off, Rename and Close.
- **Focus and resizing.** An accent focus ring on the focused pane. Hairline separators become handles on hover.
- **Docks and floats.** Collapsed docks are vertical title strips. Floats are rounded windows with a shadow.
- **Timeline and composer.** The timeline uses Bot mode's message styles, so do phase 3c first, but keeps full detail by default; the compact composer is shared with Bot mode.
- **Feature views.** Team, TPM and Ask views take the same header and card styles; their content does not change.
- **Sidebar "In this Window".** A status dot per view, attached Sides and Asks indented under their view, and collapsed docks dimmed. Check what 2b already did.

Risks:

- Pane headers carry most of the accessible names that e2e tests use, such as "Session view options", "Expand session actions" and "Back to Primary". Keep the names, or update every test that uses them in the same change.
- At 320/390px the overflow behavior is what §4.4 tests exercise.

### 5.4 Phase 5: phones

This is the spec's "App shell → Phone" and "Window mode → Phone" sections. The compact layout (≤1180px today) has been left unchanged on purpose until this phase.

Scope:

- **Bot mode.** A navigation stack: the roster with a large "Bots" title, then the conversation full screen with Back. Back uses browser history, so the edge swipe works.
- **Mode switching.** A small tab bar switches Bots / Windows.
- **Window mode.**
  - Keep the floating capsules' placement, dragging and behavior, with the Apple look (white capsules, soft shadow, counts).
  - They open `Sheet`s at half or full height with the sidebar's content. Today they open the "Sessions & Hosts" dialog.
  - The current view goes full screen with the desktop pane header.
- **Notifications.** Toasts become banners: top on phones, top right on desktop. A "needs you" banner opens its bot or view.
- **Type size.** 17px body text on phones, from phase 1's leftovers.
- **Medium width.** The spec wants three bands (desktop ≥900, medium 700–900 with a slide-over sidebar, phone <700), but the code has one 1180px compact breakpoint. Decide with the user whether to adopt the spec's bands before planning. Dozens of tests pin the 1180px breakpoint.

Found while clearing the browser tests (§4.5), to settle in this phase:

- **Capsules over the first message.** In a short conversation at 390px, the TPM, Window and Team capsules sit over the first message's Retry and Delete. Keep their placement and dragging, but they must not cover message actions.
- **42px session actions.** Below 480px the expanded session actions are 42px wide, and they wrap instead of running under their toggle. On a real Host, with the VS Code entry, they take two rows at 402px and cover the top of the conversation while expanded. Restore 44px targets and one row when the pane header moves these actions into its ⋯ menu (phase 4).

Run chromium-mobile, webkit-mobile-viewport and webkit-ask-mobile as part of verification, after §4.4 has cleared their baseline.

## 6. More work beyond phases 3–5

These items come from the spec or earlier plans but are not assigned to any phase yet. Each needs either a decision or a small plan.

- **Sidebar width.** The spec says 260px, resizable from 220 to 360px. The code keeps the old 320px default and its 260–560 range. Decide whether to adopt the spec's values.
- **Primitive API gaps** (phase 1 notes):
  - SegmentedControl always renders `<nav>`; offer `role="group"`.
  - Button, IconButton and ListRow need `forwardRef`.
  - Menu cannot open at the pointer.
  - Decide whether the spec's popover API is still wanted, or the portal stays.
- **Literal values.** `ui.css` still has literal radii and sizes (7px, 10px, 15px). `--ui-size-large-title`, `--ui-size-title` and `--ui-radius-input` are unused. Clean these up when phases 3–4 touch the files.
- **Forced colors** (Windows high contrast) for SegmentedControl, Button, IconButton, StatusBadge and ListRow; check what 2a covered.
- **New-result sync.** Syncing the "new result" state to the account is out of scope for phase 3 ("later"). It needs a Relay field, a Worker deploy, and possibly a Controller change.
- **Performance baseline (recorded).** [`docs/investigations/2026-11-12-switch-timing-baseline.md`](../investigations/2026-11-12-switch-timing-baseline.md) has the numbers for main at `22f1ead1` and how to measure a phase on the same data. `perf-fixture.mjs` and `switch-timing.mjs` are in the `prepare-arc-local` skill's scripts. Window switches cost about 450 ms at 4× CPU throttling, mostly long tasks, and bot switches about 95 ms.
- **An accessibility pass**, after phase 5: keyboard-only walkthroughs of both modes, VoiceOver on macOS and iOS, and contrast checks in both appearances.
- **`App.tsx` is about 3,300 lines.** Phases 2a–2c moved UI into `src/shell/` and `src/hooks/`. Phase 4 should keep extracting pane and dock wiring rather than adding to `App.tsx`; the spec lists this as a risk.

## 7. Suggested order

1. **Set up and push.** §2, then §4.1. Confirm that `git log origin/main..main` is empty.
2. **Clear known failures.** §4.2 (`modernization` spec), §4.5 (browser builds) and §4.3 (succession flake), so the next phase starts from a clean chromium-desktop baseline.
3. **Record the performance baseline** (§6).
4. **Phase 3**, as 3a → 3d, each merged and deployed.
5. **Sweep the other projects** (§4.4): mobile and WebKit, before phase 5.
6. **Phase 4.**
7. **Phase 5**, after the breakpoint decision.
8. **The rest of §6**, and the accessibility pass.

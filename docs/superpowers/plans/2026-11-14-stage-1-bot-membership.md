# Stage 1: Bot membership and automatic groups — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every session the owner works with in a group is a first-level bot with a role tag, every group appears in Bot mode unless hidden there, and per-mode hiding replaces Show as section.

**Architecture:** Membership stays derived from views (`isBotView`), now including attached Sides and managed Team/TPM/Support views and excluding only Asks, history, subagents and empty views. A group's `presentation` gains `bots: false` for "hidden in Bot mode"; `bots` keeps rank and per-bot details. The Lab roster projects every visible group, shows each session once, tags roles and nests Asks. Bot mode keeps one live lease (the selected group) and reads the rest from the catalog. Decisions: [roadmap](2026-11-14-bot-window-workbench-roadmap.md#decisions-taken-under-the-mandate).

**Tech stack:** TypeBox, Vitest, React, the hosted Relay, `pnpm local`.

**Commands** (from the worktree root, Node 22.23.2 or 24.22.1 on `PATH`, never Homebrew Node 26):
- Protocol tests: `pnpm --filter @orchardworks/agent-remote-protocol exec vitest run src/window-groups.test.ts`
- Hosted tests: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/window-workspaces.test.ts`
- Lab tests: `pnpm --filter @orchardworks/agent-remote-lab exec vitest run <files>`
- After a protocol change, rebuild its dist before Lab or hosted tests: `pnpm --filter @orchardworks/agent-remote-protocol run build`

---

### Task 1: Widen bot membership

**Files:**
- Modify: `packages/agent-remote-protocol/src/window-groups.ts` (`isBotView`, new `botViews`, `groupBotViews`, `isWindowGroup`, `pruneBotDetails`, `bot.update`, `view.bind` rule)
- Test: `packages/agent-remote-protocol/src/window-groups.test.ts`

- [ ] **Step 1: Rewrite the membership test to the new rule**

Replace the test `counts only ordinary views with a current session as bots` with:

```ts
it('counts every view with a current session as a bot except Asks, history, subagents and empty views', () => {
  expect(isBotView(createWindowView('main', session('a'), 'primary'))).toBe(true);
  expect(isBotView(createWindowView('dock', session('b')))).toBe(true);
  expect(isBotView({ ...createWindowView('side', session('d'), 'attached'), attachedTo: 'main' })).toBe(true);
  expect(isBotView({ ...createWindowView('team', session('f')), feature: { kind: 'team', id: 'release', metadata: { role: 'member' } }, bindingPolicy: 'managed' })).toBe(true);
  expect(isBotView({ ...createWindowView('tpm', session('t')), feature: { kind: 'tpm', id: 'work', metadata: { hostId: 'mac' } }, bindingPolicy: 'managed' })).toBe(true);
  expect(isBotView({ ...createWindowView('ask', session('e'), 'float'), feature: { kind: 'ask', id: 'ask-1' }, bindingPolicy: 'managed' })).toBe(false);
  expect(isBotView(createWindowView('empty'))).toBe(false);
  expect(isBotView(createWindowView('past', { ...session('c'), sessionIntent: 'history' }))).toBe(false);
  expect(isBotView(createWindowView('child', { ...session('g'), parentNativeSessionId: 'a' }))).toBe(false);
});

it('lets a feature rebind its managed bot but keeps an ordinary bot on its conversation', () => {
  const managed = { ...createWindowView('member', session('m1')), feature: { kind: 'team', id: 'release', metadata: { role: 'member' } }, bindingPolicy: 'managed' as const };
  const group = section(windowOf('w', createWindowView('main', session('a'), 'primary'), managed));
  expect(applyGroupOperation(group, { type: 'view.bind', viewId: 'member', binding: session('m2') }).window.views[1]?.binding?.nativeSessionId).toBe('m2');
  expect(refusal(() => applyGroupOperation(group, { type: 'view.bind', viewId: 'main', binding: session('b') }))).toBe('bot_view');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @orchardworks/agent-remote-protocol exec vitest run src/window-groups.test.ts`
Expected: FAIL — attached, team and TPM views are not bots yet; the managed rebind is refused with `bot_view`.

- [ ] **Step 3: Implement**

In `window-groups.ts` replace `isBotView` and `groupBotViews`, and add `botViews`:

```ts
/** A bot is a view showing a current session: anything but an Ask, a history view, a subagent's view or an empty view. */
export function isBotView(view: WindowView): view is WindowView & { binding: WindowSessionBinding } {
  return view.binding !== undefined && view.binding.sessionIntent === undefined
    && view.binding.parentNativeSessionId === undefined && view.feature?.kind !== 'ask';
}
/** Every view of the group that is a bot, whether or not the group appears in Bot mode. */
export function botViews(group: WindowGroup): Array<WindowView & { binding: WindowSessionBinding }> {
  return group.window.views.filter(isBotView);
}
/** The bots the one-bot-per-session rule counts: those of a group with bot details that appears in Bot mode. */
export function groupBotViews(group: WindowGroup): Array<WindowView & { binding: WindowSessionBinding }> {
  return group.bots && hasBotAppearance(group) ? botViews(group) : [];
}
```

`hasBotAppearance` arrives in Task 2; until then define it next to `hasWindowAppearance` as `export const hasBotAppearance = (group: WindowGroup): boolean => group.presentation?.bots !== false;` and widen `WindowPresentation` in Task 2.

Use `botViews` instead of `groupBotViews` where details are checked or kept: in `isWindowGroup` (`const bots = new Set(botViews(value).map(view => view.id))`), in `pruneBotDetails`, and in the `bot.update` case (`if (!group.bots || !view || !isBotView(view))` stays; it already uses `isBotView`). In the default case of `edit`, exempt managed views from the `bot_view` rule:

```ts
if (view && view.bindingPolicy !== 'managed' && isBotView(view) && (!isBotView({ ...view, binding: item.binding })
  || windowSessionIdentity(view.binding) !== windowSessionIdentity(item.binding))) {
```

Update the comment on rule 1 to say a managed bot is rebound by its feature.

- [ ] **Step 4: Run the protocol tests**

Run: `pnpm --filter @orchardworks/agent-remote-protocol exec vitest run`
Expected: the two new tests pass. Fix other tests in `window-groups.test.ts` that asserted the old membership (attached or managed views refused as bots, details on them refused) so they assert the new rule.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-remote-protocol/src/window-groups.ts packages/agent-remote-protocol/src/window-groups.test.ts
git commit -m "feat(protocol): make Sides, Teams, TPM and Support sessions bots and nest only Asks"
```

### Task 2: Hide a group in one mode

**Files:**
- Modify: `packages/agent-remote-protocol/src/window-groups.ts` (`WindowPresentation`, `hasBotAppearance`, `GroupEdit`, `isWindowGroup`, `edit`)
- Test: `packages/agent-remote-protocol/src/window-groups.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace `requires a Window or a section, and bot details only for bots` with:

```ts
it('keeps every group visible in at least one mode, with bot details only for bots', () => {
  const window = windowOf('w', createWindowView('main', session('a'), 'primary'), createWindowView('empty'));
  expect(isWindowGroup({ window })).toBe(true);
  expect(isWindowGroup({ window, presentation: { window: false } })).toBe(true);
  expect(isWindowGroup({ window, presentation: { bots: false } })).toBe(true);
  expect(isWindowGroup({ window, presentation: { window: false, bots: false } })).toBe(false);
  expect(isWindowGroup({ window, presentation: {} })).toBe(false);
  expect(isWindowGroup({ window, bots: { rank: 'm', members: { main: { label: 'Release notes' } } } })).toBe(true);
  expect(isWindowGroup({ window, bots: { rank: 'm', members: { empty: { label: 'Nobody' } } } })).toBe(false);
  expect(isWindowGroup({ window, bots: { rank: 'M', members: {} } })).toBe(false);
});

it('hides and shows a group in Bot mode and never hides it in both modes', () => {
  const group: WindowGroup = { window: windowOf('w', createWindowView('main', session('a'), 'primary')) };
  const hidden = applyGroupOperation(group, { type: 'bots.hide' });
  expect(hidden.presentation).toEqual({ bots: false });
  expect(hasBotAppearance(hidden)).toBe(false);
  expect(refusal(() => applyGroupOperation(hidden, { type: 'bots.hide' }))).toBe('bots_hidden');
  expect(refusal(() => applyGroupOperation(hidden, { type: 'window.remove' }))).toBe('last_appearance');
  expect(applyGroupOperation(hidden, { type: 'bots.show' }).presentation).toBeUndefined();
  expect(refusal(() => applyGroupOperation(group, { type: 'bots.show' }))).toBe('bots_shown');
  const windowHidden = applyGroupOperation(group, { type: 'window.remove' });
  expect(windowHidden.presentation).toEqual({ window: false });
  expect(refusal(() => applyGroupOperation(windowHidden, { type: 'bots.hide' }))).toBe('last_appearance');
  expect(applyGroupOperation(windowHidden, { type: 'window.add' }).presentation).toBeUndefined();
});
```

Add `hasBotAppearance` to the import list. In `accepts plain Window requests as group requests and checks group creation`, change the expectation for a creation request hidden in Window mode without `bots` to `true`, and add `expect(isWindowGroupMutation({ operationId: 'op', issuedAt: 1, baseRevision: 0, operation: { type: 'bots.hide' } })).toBe(true);`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @orchardworks/agent-remote-protocol exec vitest run src/window-groups.test.ts`
Expected: FAIL — `presentation.bots` is not in the schema; `bots.hide` is not an operation.

- [ ] **Step 3: Implement**

```ts
/** Present only for a group hidden in a mode: `window: false` hides it in Window mode, `bots: false` in Bot mode. */
export const WindowPresentation = Type.Object({ window: Type.Optional(Type.Literal(false)), bots: Type.Optional(Type.Literal(false)) }, { ...strict, minProperties: 1 });
export const hasWindowAppearance = (group: WindowGroup): boolean => group.presentation?.window !== false;
export const hasBotAppearance = (group: WindowGroup): boolean => group.presentation?.bots !== false;
```

`GroupEdit` gains `Type.Object({ type: Type.Literal('bots.hide') }, strict)` and `Type.Object({ type: Type.Literal('bots.show') }, strict)`. A helper writes presentation without empty objects:

```ts
function present(group: WindowGroup, presentation: { window?: false; bots?: false }): WindowGroup {
  const { presentation: _old, ...rest } = group;
  return Object.keys(presentation).length ? { ...rest, presentation } : rest;
}
```

`edit` cases:

```ts
case 'bots.hide':
  if (!hasBotAppearance(group)) fail('bots_hidden', 'This group is already hidden in Bot mode.');
  if (!hasWindowAppearance(group)) fail('last_appearance', 'A group stays visible in Window mode or Bot mode.');
  return present(group, { ...group.presentation, bots: false });
case 'bots.show': {
  if (hasBotAppearance(group)) fail('bots_shown', 'This group already appears in Bot mode.');
  const { bots: _hidden, ...presentation } = group.presentation!;
  return present(group, presentation);
}
case 'window.add': {
  if (hasWindowAppearance(group)) fail('window_exists', 'This group is already a Window.');
  const { window: _hidden, ...presentation } = group.presentation!;
  return present(group, presentation);
}
case 'window.remove':
  if (!hasWindowAppearance(group)) fail('window_missing', 'This group is not a Window.');
  if (!hasBotAppearance(group)) fail('last_appearance', 'A group stays visible in Window mode or Bot mode.');
  return present(group, { ...group.presentation, window: false });
```

`bots.remove` keeps refusing a group hidden in Window mode only while it has no other appearance: replace its second check with `if (!hasWindowAppearance(group) && !hasBotAppearance({ ...group, bots: undefined })) …` — simpler: keep `bots.remove` as "drop bot details" and allow it whenever `group.bots` exists. In `isWindowGroup`, replace `if (!hasWindowAppearance(value) && !value.bots) return false;` with `if (!hasWindowAppearance(value) && !hasBotAppearance(value)) return false;`. `splitGroup` and `mergeGroups` keep compiling; `mergeGroups` must merge both flags: shown in a mode when either group is.

- [ ] **Step 4: Run the protocol tests**

Run: `pnpm --filter @orchardworks/agent-remote-protocol exec vitest run`
Expected: PASS after aligning remaining old assertions (a Window-hidden group without details is now valid).

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(protocol): hide a group in Bot mode or Window mode instead of showing it as a section"
```

### Task 3: The Relay stores and enforces the new groups

**Files:**
- Test: `packages/agent-remote-hosted/src/window-workspaces.test.ts` (and `state.test.ts` if it pins presentation shapes)
- Modify only if a test fails: `packages/agent-remote-hosted/src/window-workspaces.ts`

- [ ] **Step 1: Write the failing tests** — a group created without details and hidden in Bot mode with `bots.hide` is stored, listed with `presentation: { bots: false }`, survives `validWindowState`, and `bots.show` restores it; a Side view in a group with details counts for `bot_session_taken` (create two groups with `bots`, the second holding the first's session as an attached Side → 409).
- [ ] **Step 2: Run** `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/window-workspaces.test.ts` after rebuilding the protocol dist. Expected: the Side duplicate test passes only with Task 1, the hide test only with Task 2.
- [ ] **Step 3: Fix any Relay code that assumed `presentation.window` is always present** (search `presentation` in `agent-remote-hosted/src`).
- [ ] **Step 4: Run the hosted suite** `pnpm --filter @orchardworks/agent-remote-hosted run test`. Expected: PASS.
- [ ] **Step 5: Commit** `test(hosted): store groups hidden in Bot mode and count Sides as bots`.

### Task 4: The roster shows every group, once per session, with roles and Asks

**Files:**
- Modify: `packages/agent-remote-lab/src/bot-roster.ts`
- Test: `packages/agent-remote-lab/src/bot-roster.test.ts`

Model changes:

```ts
export type BotRole = 'Side' | 'Team Leader' | 'Team member' | 'Support' | 'TPM';
export interface BotAsk { viewId: string; title: string }
export interface BotRow {
  groupId: string; viewId: string; binding: WindowSessionBinding; details: WindowBotDetails;
  role?: BotRole; asks: BotAsk[]; status?: 'Needs you' | 'Working' | 'Failed';
}
export interface BotSection { groupId: string; title: string; rows: BotRow[]; status?: BotRow['status']; hidden?: boolean }
export interface BotRosterOptions { status(binding: WindowSessionBinding): SessionActivityStatus; supportTeam?(teamId: string): boolean }
```

`projectBotRoster(groups, directory, options)`:
1. Order groups: those with `bots.rank` by rank then id; then the rest in input (catalog) order. Skip groups where `hasBotAppearance` is false.
2. For each group, candidate rows are `botViews(group)` minus `details.hidden`, minus sessions already shown by an earlier group or row (key `windowSessionIdentity(binding)`), sorted as today (pin, rank, document order).
3. `role`: `view.feature?.kind === 'tpm'` → `TPM`; team feature with `metadata.role === 'leader'` → `Support` when `supportTeam(feature.id)` else `Team Leader`; member → `Team member`; `view.placement === 'attached'` → `Side`; otherwise none.
4. `asks`: views with `feature.kind === 'ask'` whose `closeWith` is the row's view id, titled by their binding title or `Ask`.
5. Groups with no rows are omitted. `other` stays as today.

- [ ] **Step 1: Write the failing tests** — (a) a group without `bots` appears; a group with `presentation: { bots: false }` does not; (b) attached, team leader/member, support leader and TPM views appear with roles `Side`, `Team Leader`, `Team member`, `Support`, `TPM`; (c) an Ask closing with a bot appears in that row's `asks` and not as a row; (d) the same session in two groups shows once, in the ranked group; (e) unranked groups keep input order after ranked ones; (f) a group whose only bot is a duplicate is omitted. Update the existing tests to the options object and the widened membership (the old "includes only ordinary eligible" test now expects attached and managed views).
- [ ] **Step 2: Run** `pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/bot-roster.test.ts` — FAIL.
- [ ] **Step 3: Implement** the projection above; update callers of `projectBotRoster` (App) to pass `{ status, supportTeam }`, where `supportTeam` looks the team up in the Teams the App already loads (`team.callForSupport !== undefined`).
- [ ] **Step 4: Run** the roster tests and `src/App.bot-mode.test.tsx`. Expected: PASS after updating expectations that relied on "Show as section".
- [ ] **Step 5: Commit** `feat(lab): show every group in Bot mode with role tags, nested Asks and each session once`.

### Task 5: Roster rows look like a team chat

**Files:**
- Modify: `packages/agent-remote-lab/src/components/BotRoster.tsx`, `packages/agent-remote-lab/src/components/bot-workspace.css`
- Test: `packages/agent-remote-lab/src/components/BotRoster.test.tsx`

Row content: picture, name (`details.label` is not the name; the name is the session title), a separate role tag element `<span className="lab-bot-role">TPM</span>`, the custom label as a quieter tag when present, status at the end. Host and provider leave the row and go to its `title` tooltip (`Host · provider`) and the conversation's Info (stage 2). Ask rows render nested under their bot as a list with a smaller indent, each a button selecting `{ kind: 'bot', groupId, viewId: askViewId }` only when the Ask is a bot place — in stage 1 Asks open their source bot (`viewId` of the row) since Ask conversations open inside the Session View. Empty-section hint "Organize sessions in a Window, then choose Show as section." is removed.

- [ ] **Step 1: Write the failing test** — rendering a row with role `TPM`, label `Release`, one Ask: the row's text has the name, a `.lab-bot-role` element with `TPM`, a `.lab-bot-label` with `Release`, no `host · provider` text, `title` contains `host · recorded`; the Ask is listed under the row inside `[data-bot-asks]`.
- [ ] **Step 2: Run** `pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/components/BotRoster.test.tsx` — FAIL.
- [ ] **Step 3: Implement** markup and CSS (tag style: `font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--ui-fill); color: var(--ui-label-secondary)`; never inside the name text).
- [ ] **Step 4: Run** the Bot roster and Bot workspace tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lab): show bot roles as tags and keep Host details out of roster rows`.

### Task 6: Bot mode leases only the selected group

**Files:**
- Modify: `packages/agent-remote-lab/src/hooks/useBotWorkspace.ts`
- Test: `packages/agent-remote-lab/src/App.bot-mode.test.tsx` or a new `src/hooks/useBotWorkspace.test.tsx`

Change `ids` to only the selected group (`selectedId && !deleted ? [selectedId] : []`). Replace `group?.bots` checks with `hasBotAppearance(group)`; the selected bot is any `botViews(group)` view not hidden in details. Enrol every catalog group's bot views with `succession.ensureWindowView` in one effect keyed by the catalog's bot locators, so handed-off bots in unselected groups still resolve to their current sessions for status.

- [ ] **Step 1: Write the failing test** — with three groups in the catalog and a bot of the second selected, `workspace.acquireGroup` is called once, for the second; switching to a bot of the third releases the second lease and acquires the third.
- [ ] **Step 2: Run** — FAIL (today every section is acquired).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `src/App.bot-mode.test.tsx` and `src/components/BotWorkspace.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `perf(lab): keep a live lease only for the selected bot's group`.

### Task 7: Per-mode hiding replaces Show as section

As shipped: "open beside" stays limited to groups with bot details (roadmap decision 8); stage 2 applies rule 6 to every Window pane together with folding on close.

**Files:**
- Modify: `packages/agent-remote-lab/src/hooks/useWindowActions.ts` (`showAsSection` → `setBotAppearance(shown)`), `packages/agent-remote-lab/src/shell/WindowToolbar.tsx` (menu item "Hide in Bot mode" / "Show in Bot mode"), `packages/agent-remote-lab/src/components/WindowWorkspaces.tsx` (remove the Show as section button), `packages/agent-remote-lab/src/App.tsx` (open-beside condition and confirmed-bot check use `hasBotAppearance` instead of `group.bots`), `packages/agent-remote-lab/src/window-workspace-store.ts` (idempotence for `bots.hide`/`bots.show`)
- Tests: `src/shell/WindowToolbar.test.tsx`, `src/components/WindowWorkspaces.test.tsx`, `src/App.bot-mode.test.tsx`

- [ ] **Step 1: Write the failing tests** — the Window toolbar menu offers "Hide in Bot mode" for a visible group and "Show in Bot mode" for a hidden one, sending `bots.hide` / `bots.show`; no "Show as section" anywhere; opening a directory session while a bot view of a group without `bots` details is selected creates a new primary view beside it instead of rebinding.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** In the store's idempotence map: `case 'bots.hide': return !hasBotAppearance(group); case 'bots.show': return hasBotAppearance(group);`.
- [ ] **Step 4: Run** the three test files plus `src/App.window-retention.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lab): hide a group in one mode instead of showing it as a section`.

### Task 8: Group actions in Bot mode

**Files:**
- Modify: `packages/agent-remote-lab/src/components/BotRoster.tsx` (group header ⋯ menu: Rename, Hide in Bot mode, Show in Window mode / Hide in Window mode), `packages/agent-remote-lab/src/components/BotWorkspace.tsx` (wire to `workspace.operateGroup`; the roster's "New section" button becomes "New group"? — no: groups form automatically, so the header `+` opens New session, see stage 2; in stage 1 remove the New section form)
- Test: `src/components/BotWorkspace.test.tsx`

- [ ] **Step 1: Write the failing test** — the group header menu hides the group in Bot mode (`bots.hide` sent, group leaves the roster) and toggles its Window appearance; the New section form is gone.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** with `ui/Menu`.
- [ ] **Step 4: Run** Bot workspace tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lab): manage a group's appearance from its Bot mode header`.

### Task 9: Verify and ship

- [ ] Rebuild everything: `pnpm -r run build`.
- [ ] `pnpm verify:changed` (protocol changes reach every package: expect the full suite). Rerun single failures alone; a failure that does not pass alone is a defect to fix.
- [ ] `pnpm local up`; create sessions with `agent-remote-controller-dev`: an ordinary session, a Side of it (website), a TPM work and a Team; check desktop and phone (light and dark) that the roster shows one group with role tags, Asks nested, no Host IDs in rows, Show as section gone, hide in Bot mode works and the group returns with Show in Bot mode.
- [ ] Merge to `main`, push with the owner's token, `pnpm -r run build && pnpm build:relay`, record `wrangler deployments list`, `wrangler deploy --keep-vars --message "<sha>: stage 1 bot membership"`, check `/health` and asset hashes.
- [ ] Update the roadmap's stage table with the shipped commit and Worker version.

Note for the handoff check: `windowSuccessionLayout` (`window-composition.ts`) rebinds a handed-off view to its successor with `layout.apply`, which the `bot_view` rule does not inspect, and takes the successor slot's title; `window-titles.ts` then follows the current session's title. If a real handoff in the local instance changes the bot's name, keep the name stable (rule 4) by keeping the view's title through succession, and record that in stage 2.

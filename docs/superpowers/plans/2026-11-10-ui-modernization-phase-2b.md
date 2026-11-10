# UI modernization phase 2b: the Window sidebar and the All sessions page

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On desktop, Window mode's sidebar becomes what the spec describes:
- **Windows**: the list of Windows.
- **In this Window**: the current Window's views, in layout order.
- **Shortcuts**: All sessions, Favorites, Teams, TPM, Track and Ask.
- **A footer**: Host status and Settings.

The Host / provider / directory / new-session panels move out of the sidebar onto an **All sessions** page in the main area. The sidebar width becomes 260px by default, adjustable from 220 to 360.

**Architecture:**
- **Design:** this implements the "Window mode → Sidebar" and "App shell → Desktop" parts of `docs/superpowers/specs/2026-11-09-ui-modernization-design.md`. Phase 2c (the Window toolbar and ⌘K) follows separately.
- **Compact layouts (≤1180px) do not change.** The "Sessions & Hosts" dialog keeps today's tabs and panels; phase 5 redesigns phones. The panel content is therefore written once (a JSX value in `App.tsx`) and placed in the compact rail or on the desktop page.
- **Floating capsules.** Decided by the user on 2026-11-10: while the desktop sidebar is visible, the floating Window, Team, TPM, Track and Ask capsules are not shown. Their entries live in the sidebar instead: Windows as a section, the rest as Shortcuts rows. When the sidebar is hidden (⌘\, View options) or on compact layouts, the capsules float as today.
- **Same components, two placements.** The Team, TPM, Track and Ask components render as sidebar rows through a placement context, with the same accessible names. Their panels open beside the sidebar.
- **Accessible names.** Controls that still exist keep their names ("Windows", "Session views", "Teams", "TPM works", "Tracked sessions", "Ask about this session", "Favorites", "Discover sessions", "Sidebar settings", …). Tests that relied on where a control used to be are updated to its new place.

**Tech Stack:**
- React 18 + TypeScript.
- Plain CSS with the `--ui-*` tokens.
- Vitest: jsdom for components, `vitest.preview.config.ts` for `e2e/*.browser.ts`.
- Playwright e2e.

**Working rules for every task:**
- Work in the worktree `/Volumes/Projects/agent-remote-control/.worktrees/ui-modern-3` (branch `feat/ui-modern-3`).
- Run package commands from `packages/agent-remote-lab`, after `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH";`.
- Never use `--no-verify`.
- Use English in code, comments and commits. End commit messages with a blank line and `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Read a file before editing it; line numbers below are approximate (from `ee371488`). If the real code differs from what is quoted, keep the intent and report the difference.
- Stylesheet guards (`src/ui/stylesheets.test.ts`): no literal colors outside `tokens.css`, no undefined variables.
- After Lab source changes, run `pnpm compatibility:update` then `pnpm compatibility:check` from the worktree root before the final commit of a task, and commit `packages/agent-remote-lab/compatibility.json` with it.

---

## File structure

| File | Responsibility |
|---|---|
| `src/components/SidebarResize.tsx` | Width 260 by default, 220–360, older saved widths clamped |
| `src/window-outline.ts` (new) | The current Window's views in layout order, with attached Sides and Asks under their view |
| `src/components/WindowWorkspaces.tsx`, `window-workspaces.css` | "In this Window" from the outline, focus and expand on click, an "All Windows" button, an `onNavigate` callback |
| `src/shell/shortcut-placement.ts` (new) | `ShortcutPlacement` context: `'floating'` or `'sidebar'` |
| `src/components/TeamMenu.tsx`, `TpmMenu.tsx`, `SessionTrackingMenu.tsx`, `AskButton.tsx` | Render as sidebar rows when the placement is `'sidebar'` |
| `src/shell/SidebarFooter.tsx` (new), `src/shell/shell.css` | Host status and Settings at the bottom of the sidebar; shortcut row and panel styles |
| `src/App.tsx` | The desktop sidebar content, the All sessions page, where the capsules render |
| `e2e/all-sessions.ts` (new) and the specs it affects | Opening the page in tests |

---

### Task 1: Sidebar width 260, from 220 to 360

**Files:**
- Modify: `packages/agent-remote-lab/src/components/SidebarResize.tsx` (lines 3–13) and `packages/agent-remote-lab/src/app.css` (`var(--lab-sidebar-width, 320px)` near line 164).
- Create the test: `packages/agent-remote-lab/src/components/SidebarResize.test.tsx`.
- Modify: `packages/agent-remote-lab/e2e/sidebar.spec.ts` (lines 5–40).

- [ ] **Step 1: Write the failing test** `src/components/SidebarResize.test.tsx`:

```tsx
import { afterEach, expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { SidebarResize, useSidebarWidth } from './SidebarResize.js';

afterEach(() => localStorage.clear());

function Probe({ inspector = false }: { inspector?: boolean }) {
  const sidebar = useSidebarWidth(inspector);
  return <SidebarResize width={sidebar.width} maximum={sidebar.maximum} onChange={sidebar.setWidth} />;
}

it('starts at 260 and keeps a saved width inside 220–360', async () => {
  const fresh = await render(<Probe />);
  const handle = fresh.querySelector('[role="separator"]')!;
  expect(handle.getAttribute('aria-valuenow')).toBe('260');
  expect(handle.getAttribute('aria-valuemin')).toBe('220');
  localStorage.setItem('agent-remote.sidebar-width', '500');
  const clamped = await render(<Probe />);
  expect(clamped.querySelector('[role="separator"]')!.getAttribute('aria-valuenow')).toBe('360');
  localStorage.setItem('agent-remote.sidebar-width', '300');
  const kept = await render(<Probe />);
  expect(kept.querySelector('[role="separator"]')!.getAttribute('aria-valuenow')).toBe('300');
});
```

If `render` from `src/test/setup.js` mounts into a shared container, query the last separator instead (`[...document.querySelectorAll('[role="separator"]')].at(-1)`), or render each case in its own `it`.

- [ ] **Step 2: Run it and see it fail.** `npx vitest run src/components/SidebarResize.test.tsx` → FAIL (320).

- [ ] **Step 3: Implement.** In `SidebarResize.tsx`, set `defaultWidth = 260`, `minWidth = 220` and `maxWidth = 360`. `savedWidth()` currently returns `undefined` for an out-of-range value. Clamp it instead, so that a width saved under the old 260–560 range survives as the nearest allowed value:

```ts
function savedWidth(): number | undefined {
  const value = Number(localStorage.getItem(storageKey));
  return Number.isFinite(value) && value > 0 ? Math.min(maxWidth, Math.max(minWidth, Math.round(value))) : undefined;
}
```

Keep the existing try/catch around `localStorage` if there is one. Update the JSDoc and the `aria-valuetext` code only if they mention 320. In `app.css`, change every `var(--lab-sidebar-width, 320px)` fallback to `260px`; do not touch the Replica Inspector's own `320px` column.

- [ ] **Step 4: Update `e2e/sidebar.spec.ts`.** The test drives the handle with these steps, from line 5:
  - default 320 → 260;
  - drag +140 → 360 (the new maximum; assert 360 and a rail width of 360);
  - ArrowLeft → 350;
  - Home → 220;
  - End → 360;
  - at 1181px with the Inspector open the maximum is `max(220, min(360, 1181 − 480 − 320))` = 360 → assert 360;
  - double-click → 260.

  Rewrite the expected numbers to match. Keep the other assertions as they are, including the main stage being at least 479px wide.

- [ ] **Step 5: Run.** `npx vitest run src/components/SidebarResize.test.tsx`, then `AGENT_REMOTE_TEST_RELAY_PORT=5951 AGENT_REMOTE_TEST_WEB_PORT=6216 npx playwright test e2e/sidebar.spec.ts:5 --project=chromium-desktop --reporter=line` (use the real first test line and desktop project name from the file and `playwright.config.ts`). Expected: PASS.

- [ ] **Step 6: Commit** with the message "feat(lab): a 260px sidebar, adjustable from 220 to 360".

---

### Task 2: The current Window's views in layout order

**Files:** Create `packages/agent-remote-lab/src/window-outline.ts` and `src/window-outline.test.ts`.

The order is the order of the layout:
1. Top-level (primary) views.
2. Docks.
3. Floats.

Each view is followed by the views attached to it (Sides: `attachedTo`) and the Asks that close with it (`closeWith`). Attached views are indented one level. A view whose owner no longer exists is listed at the top level, at the end.

- [ ] **Step 1: Write the failing test** `src/window-outline.test.ts`:

```ts
import { expect, it } from 'vitest';
import { createWindowView, type WindowView } from '@orchardworks/agent-remote-protocol';
import { windowOutline } from './window-outline.js';

const view = (id: string, extra: Partial<WindowView> = {}): WindowView => ({ ...createWindowView(id), ...extra });

it('lists top-level views, then docks, then floats, each followed by its Sides and Asks', () => {
  const views = [
    view('float', { placement: 'float' }),
    view('dock', { placement: 'dock', collapsed: true }),
    view('side', { placement: 'attached', attachedTo: 'main' }),
    view('main', { placement: 'primary' }),
    view('ask', { placement: 'dock', closeWith: 'dock', feature: { kind: 'ask', id: 'a1' } }),
    view('orphan', { placement: 'attached', attachedTo: 'gone' }),
  ];
  expect(windowOutline(views).map(entry => [entry.view.id, entry.depth])).toEqual([
    ['main', 0], ['side', 1], ['dock', 0], ['ask', 1], ['float', 0], ['orphan', 0],
  ]);
});
```

Check `createWindowView` in `packages/agent-remote-protocol/src/window-workspace.ts`. If its defaults make `placement` something other than what the test overrides, the overrides above still decide. If `feature` needs more fields, add them as the type requires.

- [ ] **Step 2: Run it and see it fail.** `npx vitest run src/window-outline.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `src/window-outline.ts`:

```ts
import type { WindowView } from '@orchardworks/agent-remote-protocol';

export type OutlineEntry = { view: WindowView; depth: 0 | 1 };

/** The views a Window shows, in the order of its layout: top-level views, docks, floats; each followed by the Sides
 *  attached to it and the Asks that close with it. A view whose owner is gone is listed last, at the top level. */
export function windowOutline(views: readonly WindowView[]): OutlineEntry[] {
  const ids = new Set(views.map(view => view.id));
  const owner = (view: WindowView) => view.attachedTo ?? view.closeWith;
  const owned = (view: WindowView) => { const id = owner(view); return !!id && id !== view.id && ids.has(id); };
  const children = (id: string) => views.filter(view => owned(view) && owner(view) === id);
  const rank = (view: WindowView) => view.placement === 'primary' ? 0 : view.placement === 'dock' ? 1 : view.placement === 'float' ? 2 : 3;
  const roots = views.filter(view => !owned(view)).map((view, index) => ({ view, index }))
    .sort((a, b) => rank(a.view) - rank(b.view) || a.index - b.index).map(entry => entry.view);
  return roots.flatMap(view => [{ view, depth: 0 as const }, ...children(view.id).map(child => ({ view: child, depth: 1 as const }))]);
}
```

- [ ] **Step 4: Run** `npx vitest run src/window-outline.test.ts` → PASS.

- [ ] **Step 5: Commit** with the message "feat(lab): order a Window's views as its layout shows them".

---

### Task 3: "In this Window" in the Windows panel

**Files:** Modify `packages/agent-remote-lab/src/components/WindowWorkspaces.tsx` and `src/components/window-workspaces.css`; test `src/components/WindowWorkspaces.test.tsx`.

`WindowWorkspaces` already renders three things: the Windows list (`nav[aria-label="Windows"]`), the current Window's views (`nav[aria-label="Session views"]`) and Window options. The floating Window capsule shows it today, and Task 6 places it in the sidebar. This task changes it as follows:
- The views heading reads "In this Window". The nav keeps its name "Session views", and the button "New session view" stays.
- Views follow `windowOutline`: rows carry `data-depth="1"` for attached views and `data-collapsed` for collapsed docks.
- Choosing a view selects it, expands it if it is collapsed, and scrolls it into view.
- An optional `onOverview` adds an "All Windows" button (label "Show all Windows") to the Windows heading.
- An optional `onNavigate` is called after a Window is opened or a view is chosen. The All sessions page uses it to return to the Window.

- [ ] **Step 1: Write the failing tests.** Read the existing tests in `WindowWorkspaces.test.tsx` and reuse their workspace fixture (the object passed as `workspace`, with `operate` as a mock). Append:

```tsx
it('lists the current Window in layout order and focuses a chosen view', async () => {
  // Use the file's fixture with a window whose views are, in array order:
  // float (placement float), dock (placement dock, collapsed true), side (attached to main), main (primary).
  // Render <WindowWorkspaces workspace={workspace} onNavigate={navigate} /> with navigate = vi.fn().
  const views = container.querySelector('nav[aria-label="Session views"]')!;
  expect(container.textContent).toContain('In this Window');
  expect([...views.querySelectorAll('[data-window-view-row]')].map(row => [row.getAttribute('data-window-view-row'), row.getAttribute('data-depth')]))
    .toEqual([['main', null], ['side', '1'], ['dock', null], ['float', null]]);
  expect(views.querySelector('[data-window-view-row="dock"]')?.hasAttribute('data-collapsed')).toBe(true);
  const pane = document.createElement('div'); pane.dataset.viewId = 'dock'; pane.scrollIntoView = vi.fn(); document.body.append(pane);
  await act(async () => (views.querySelector('[data-window-view-id="dock"]') as HTMLButtonElement).click());
  expect(workspace.operate).toHaveBeenCalledWith({ type: 'batch', operations: [
    { type: 'view.collapse', viewId: 'dock', collapsed: false }, { type: 'view.select', viewId: 'dock' }] });
  await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
  expect(pane.scrollIntoView).toHaveBeenCalled();
  expect(navigate).toHaveBeenCalled();
  pane.remove();
});

it('offers All Windows when an overview is available', async () => {
  // Render with onOverview = vi.fn(); click button[aria-label="Show all Windows"]; expect the mock to have been called.
});
```

Write both tests out fully using the file's fixture helpers. The comments above describe the fixture setup to write; they are not code to leave in place.

Also keep the existing tests passing. If one asserts the old flat order or the "Session views" heading text, update only that assertion, and list it in your report.

- [ ] **Step 2: Run** `npx vitest run src/components/WindowWorkspaces.test.tsx` → FAIL.

- [ ] **Step 3: Implement** in `WindowWorkspaces.tsx`:
  1. Add the props `onOverview?(): void` and `onNavigate?(): void`, and document them in the props comment.
  2. In the Windows heading (`<div className="lab-window-section-heading"><span>Windows</span>…`), before "New Window", add `{onOverview ? <button type="button" className="lab-window-overview-trigger" aria-label="Show all Windows" title="Show all Windows (Ctrl+Shift+Up)" aria-keyshortcuts="Control+Shift+ArrowUp" onClick={onOverview}>All Windows</button> : null}`.
  3. In `openWindow`, after `await workspace.open(id)` succeeds, call `onNavigate?.()`.
  4. Change the views heading `<span>Session views</span>` to `<span>In this Window</span>`.
  5. Map `windowOutline(workspace.window.views)` instead of `workspace.window.views`, and destructure `({ view, depth })`. On the row `div`, add `data-depth={depth || undefined}` and `data-collapsed={view.collapsed || undefined}`.
  6. Replace the row button's `onClick={() => edit({ type: 'view.select', viewId: view.id })}` with `onClick={() => chooseView(view)}`:

```tsx
  function chooseView(view: WindowView) {
    const select: WindowOperation = { type: 'view.select', viewId: view.id };
    edit(view.collapsed ? { type: 'batch', operations: [{ type: 'view.collapse', viewId: view.id, collapsed: false }, select] } : select);
    // The pane may render or expand on the next frame; bring it into view then.
    requestAnimationFrame(() => document.querySelector(`[data-view-id="${CSS.escape(view.id)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    onNavigate?.();
  }
```

  7. Import `windowOutline` from `../window-outline.js`.

  In `window-workspaces.css`, add:

```css
.lab-window-row[data-depth="1"] { padding-left: 16px; }
.lab-window-row[data-collapsed] .lab-window-open { color: var(--ui-label-secondary); }
```

  Check `jsdom` support: if `CSS.escape` is missing in the test environment, use a manual `querySelectorAll('[data-view-id]')` scan matching `element.dataset.viewId === view.id`.

- [ ] **Step 4: Run** `npx vitest run src/components/WindowWorkspaces.test.tsx src/components/WindowMenu.test.tsx src/window-outline.test.ts` → PASS.

- [ ] **Step 5: Commit** with the message "feat(lab): show the current Window in layout order and focus a chosen view".

---

### Task 4: Team, TPM, Track and Ask as sidebar rows

**Files:**
- Create: `packages/agent-remote-lab/src/shell/shortcut-placement.ts`.
- Modify: `src/components/TeamMenu.tsx` (root around line 155), `src/components/TpmMenu.tsx` (root around line 56), `src/components/SessionTrackingMenu.tsx` (root around line 39), `src/components/AskButton.tsx` (root around line 15), `src/shell/shell.css`.
- Test: `src/shell/shortcut-placement.test.tsx`.

Each of these components renders a floating root: `ref={root} style={style} {...handlers} className="lab-tracking-floating lab-…-floating" data-edge={edge}`, positioned by `useTrackingPosition`. In the sidebar placement, a component renders:
- a root without `ref`, `style`, `handlers` and `data-edge`;
- with class `lab-sidebar-shortcut lab-sidebar-shortcut-<name>` instead of the floating classes;
- the same trigger and panel inside it.

The floating classes must not be applied in the sidebar, because rules such as `.lab-team-floating { top: 220px; right: 12px }` would position the row.

- [ ] **Step 1: Check the hook.** Read `src/hooks/useTrackingPosition.ts`. Confirm that when the returned `root` ref is never attached (`root.current` stays `null`), the hook registers no floating entry and does nothing on resize. If it does register or act on `null`, add an option instead: `useTrackingPosition(key, selector, { enabled })`, with `enabled === false` meaning no registration, no listeners and an empty `style`. Pass `enabled: placement === 'floating'`. Report which case applied.

- [ ] **Step 2: Write the failing test** `src/shell/shortcut-placement.test.tsx`. Render `AskButton` (it has the fewest props) in both placements:

```tsx
import { createRef } from 'react';
import { expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { AskButton } from '../components/AskButton.js';
import { ShortcutPlacement } from './shortcut-placement.js';

it('renders a capsule as a sidebar row with the same name, without floating placement', async () => {
  const floating = await render(<AskButton triggerRef={createRef()} disabled={false} onOpen={() => {}} />);
  expect(floating.querySelector('.lab-tracking-floating.lab-ask-floating')).not.toBeNull();
  const docked = await render(<ShortcutPlacement.Provider value="sidebar"><AskButton triggerRef={createRef()} disabled={false} onOpen={() => {}} /></ShortcutPlacement.Provider>);
  const row = docked.querySelector('.lab-sidebar-shortcut.lab-sidebar-shortcut-ask')!;
  expect(row).not.toBeNull();
  expect(row.matches('.lab-tracking-floating')).toBe(false);
  expect(row.getAttribute('style')).toBeNull();
  expect(row.querySelector('button')?.getAttribute('aria-label')).toBe('Ask about this session');
});
```

Add one more case for `TpmMenu`, rendered with the minimal props its existing test uses (see `src/components/TpmMenu.test.tsx` if it exists, otherwise build the props from its type). Assert the same: class `lab-sidebar-shortcut-tpm`, no floating class, trigger named "TPM works".

- [ ] **Step 3: Run** `npx vitest run src/shell/shortcut-placement.test.tsx` → FAIL.

- [ ] **Step 4: Implement.** Create `src/shell/shortcut-placement.ts`:

```ts
import { createContext } from 'react';

/** Where the Team, TPM, Track and Ask entries render: as floating capsules, or as rows in the desktop sidebar's Shortcuts. */
export const ShortcutPlacement = createContext<'floating' | 'sidebar'>('floating');
```

In each of the four components, read the placement with `const placement = useContext(ShortcutPlacement);` and build the root's attributes in one place:

```tsx
  const floating = placement === 'floating';
  const rootProps = floating ? { ref: root, style, ...handlers, 'data-edge': edge, className: 'lab-tracking-floating lab-team-floating' }
    : { className: 'lab-sidebar-shortcut lab-sidebar-shortcut-team' };
```

Use each component's own floating class (`lab-tpm-floating`, `lab-ask-floating`; the Track root has only `lab-tracking-floating`) and its own sidebar modifier (`-team`, `-tpm`, `-track`, `-ask`). Spread `{...rootProps}` on the root and keep every other attribute (`hidden`, `data-attention`, `inert`, `onKeyDown`). Where the root's `onKeyDown` calls `handlers.onKeyDown?.(event)`, call it only when `floating`. Drop the trigger's "Drag to move…" title text and `aria-description` / `aria-keyshortcuts` about dragging when not floating.

In `src/shell/shell.css`, add:

```css
/* Shortcuts in the desktop sidebar: the capsules' triggers as full-width rows; their panels open beside the sidebar. */
.lab-sidebar-shortcut > .lab-session-popover-trigger, .lab-sidebar-shortcut .lab-session-popover > .lab-session-popover-trigger {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 30px; padding: 4px 10px; border: 0; border-radius: var(--ui-radius-control);
  color: var(--ui-label); background: transparent; box-shadow: none; font: var(--ui-size-body)/1.2 var(--ui-font); text-align: start;
}
.lab-sidebar-shortcut > .lab-session-popover-trigger:hover:not(:disabled), .lab-sidebar-shortcut .lab-session-popover > .lab-session-popover-trigger:hover:not(:disabled) { color: var(--ui-label); background: var(--ui-row-hover); }
.lab-sidebar-shortcut .lab-session-popover-trigger > :last-child:not(:first-child) { margin-inline-start: auto; color: var(--ui-label-secondary); }
.lab-sidebar-shortcut .lab-session-popover-panel {
  position: fixed; top: 12px; right: auto; bottom: auto; left: calc(var(--lab-sidebar-width, 260px) + 8px);
  width: min(420px, calc(100vw - var(--lab-sidebar-width, 260px) - 24px)); max-height: calc(100dvh - 24px); overflow: auto; z-index: 40;
}
```

Read the existing `.lab-session-popover-panel` and `.lab-tracking-floating` rules (grep `app.css` and `src/components/*.css`). If a rule with higher specificity positions the panel using the capsule's `data-edge`, raise this selector until it wins, and report it. Check that the panel's z-index puts it above the main stage and below dialogs; use the value the floating panels use today.

- [ ] **Step 5: Run** `npx vitest run src/shell src/components/TeamMenu.test.tsx src/components/TpmMenu.test.tsx src/components/SessionTrackingMenu.test.tsx src/ui/stylesheets.test.ts`. Skip any path that does not exist. Expected: PASS.

- [ ] **Step 6: Commit** with the message "feat(lab): let the Team, TPM, Track and Ask entries render as sidebar rows".

---

### Task 5: The sidebar footer: Host status and Settings

**Files:** Create `packages/agent-remote-lab/src/shell/SidebarFooter.tsx` and `src/shell/SidebarFooter.test.tsx`; modify `src/shell/shell.css`.

- [ ] **Step 1: Write the failing test.**

```tsx
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { SidebarFooter, hostSummary } from './SidebarFooter.js';

it('summarizes Hosts', () => {
  expect(hostSummary([], true)).toBe('No Hosts paired');
  expect(hostSummary([], false)).toBe('Checking Hosts…');
  expect(hostSummary([{ online: true }, { online: false }], true)).toBe('1 of 2 Hosts online');
  expect(hostSummary([{ online: true }], true)).toBe('1 Host online');
});

it('opens the Hosts and Settings pages', async () => {
  const onHosts = vi.fn(), onSettings = vi.fn();
  const container = await render(<SidebarFooter hosts={[{ online: false }]} loaded onHosts={onHosts} onSettings={onSettings} settingsPressed={false} />);
  const footer = container.querySelector('footer.lab-sidebar-footer')!;
  expect(footer.querySelector('[data-host-state]')?.getAttribute('data-host-state')).toBe('offline');
  await act(async () => (footer.querySelector('.lab-sidebar-hosts') as HTMLButtonElement).click());
  await act(async () => (footer.querySelector('button[aria-label="Sidebar settings"]') as HTMLButtonElement).click());
  expect(onHosts).toHaveBeenCalledOnce(); expect(onSettings).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run** `npx vitest run src/shell/SidebarFooter.test.tsx` → FAIL.

- [ ] **Step 3: Implement** `src/shell/SidebarFooter.tsx`:

```tsx
import { IconButton } from '../ui/IconButton.js';

export function hostSummary(hosts: readonly { online: boolean }[], loaded: boolean): string {
  if (!hosts.length) return loaded ? 'No Hosts paired' : 'Checking Hosts…';
  const online = hosts.filter(host => host.online).length;
  return online === hosts.length ? `${online} ${online === 1 ? 'Host' : 'Hosts'} online` : `${online} of ${hosts.length} Hosts online`;
}

/** The bottom of the desktop Window sidebar: how many Hosts are online (opening All sessions, where Hosts are chosen) and Settings. */
export function SidebarFooter({ hosts, loaded, onHosts, onSettings, settingsPressed }: {
  hosts: readonly { online: boolean }[]; loaded: boolean; onHosts(): void; onSettings(): void; settingsPressed: boolean;
}) {
  const online = hosts.filter(host => host.online).length;
  const state = !hosts.length ? 'none' : online === hosts.length ? 'online' : online ? 'partial' : 'offline';
  return <footer className="lab-sidebar-footer">
    <button type="button" className="lab-sidebar-hosts" onClick={onHosts}>
      <span className="lab-sidebar-host-dot" data-host-state={state} aria-hidden="true" />{hostSummary(hosts, loaded)}
    </button>
    <IconButton icon="gear" label="Sidebar settings" title="Settings" aria-pressed={settingsPressed} onClick={onSettings} />
  </footer>;
}
```

Check that `gear` is an `IconName` in `src/ui/Icon.tsx`. If it is not, add a gear path in the existing style.

Append to `shell.css`:

```css
.lab-sidebar-footer { display: flex; align-items: center; gap: 4px; padding: 6px 8px; border-top: 1px solid var(--ui-separator); }
.lab-sidebar-hosts { display: flex; flex: 1; align-items: center; gap: 8px; min-width: 0; min-height: 28px; padding: 4px 8px; border: 0;
  border-radius: var(--ui-radius-control); color: var(--ui-label-secondary); background: transparent; font: var(--ui-size-callout)/1.2 var(--ui-font); text-align: start; }
.lab-sidebar-hosts:hover:not(:disabled) { color: var(--ui-label); background: var(--ui-row-hover); }
.lab-sidebar-host-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--ui-label-tertiary); }
.lab-sidebar-host-dot[data-host-state="online"] { background: var(--ui-success); }
.lab-sidebar-host-dot[data-host-state="partial"] { background: var(--ui-warning); }
.lab-sidebar-host-dot[data-host-state="offline"] { background: var(--ui-failure); }
@media (forced-colors: active) { .lab-sidebar-host-dot { forced-color-adjust: none; background: CanvasText; } }
```

Use the real status token names from `tokens.css` (grep `--ui-` for success / warning / failure / tertiary). The guard test rejects undefined variables.

- [ ] **Step 4: Run** `npx vitest run src/shell src/ui/stylesheets.test.ts` → PASS.

- [ ] **Step 5: Commit** with the message "feat(lab): add the sidebar footer with Host status and Settings".

---

### Task 6: The desktop sidebar and the All sessions page

**Files:** Modify `packages/agent-remote-lab/src/App.tsx`, `src/shell/shell.css`, `src/app.css`; test `src/App.bot-mode.test.tsx`, or a new `src/App.window-sidebar.test.tsx` that uses the `mountBotApp` fixtures from `src/test/bot-mode-fixtures.ts`.

The target structure on desktop (`!compactLayout`) is shown below. Only these parts change; the compact rail keeps its tabs, panels and footer exactly as today.

```
SupportingRail#lab-context (aside "Context")
  SidebarHeader (mode switch, New menu)                        unchanged
  .lab-rail-heading (View options slot, "Window")              unchanged
  .lab-sidebar-scroll
    section.lab-sidebar-section "Windows"   → <WindowWorkspaces onOverview onNavigate …/>
    nav.lab-sidebar-section "Shortcuts"     → All sessions, Favorites (userScoped), then the Team / TPM / Track / Ask entries
  SidebarFooter                                                 Host status, Settings ("Sidebar settings")
main stage (.lab-main-stage)
  section#lab-sessions-page.lab-sessions-page (aria-label = page title), hidden unless a page is open
    Toolbar: Back to Window · title · (nothing trailing)
    "Open in: …" status
    the panel content (.lab-sidebar-content) for the page's panel
  #lab-workbench                                                hidden while a page is open
```

- [ ] **Step 1: Write the failing App-level tests.** Use the existing fixtures: read `src/test/bot-mode-fixtures.ts` and the 2a tests at the end of `src/App.bot-mode.test.tsx` (they mount on desktop, where `matchMedia` is not stubbed). Write:

```tsx
it('shows Windows, In this Window and Shortcuts in the desktop sidebar, and sessions on their own page', async () => {
  const scope = 'http://localhost/window-sidebar/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    const rail = () => app.container.querySelector('#lab-context')!;
    await until(() => expect(rail().querySelector('nav[aria-label="Windows"]')).not.toBeNull());
    expect(rail().querySelector('nav[aria-label="Session views"]')).not.toBeNull();
    expect(rail().querySelector('nav[aria-label="Shortcuts"]')).not.toBeNull();
    expect(rail().querySelector('section[aria-label="Discover sessions"]')).toBeNull();
    expect(rail().querySelector('footer.lab-sidebar-footer')).not.toBeNull();
    await act(async () => app.button('All sessions').click());
    const page = app.container.querySelector<HTMLElement>('#lab-sessions-page')!;
    expect(page.hidden).toBe(false);
    expect(page.getAttribute('aria-label')).toBe('All sessions');
    expect(app.container.querySelector<HTMLElement>('#lab-workbench')!.hidden).toBe(true);
    await until(() => expect(page.querySelector('section[aria-label="Discover sessions"]')).not.toBeNull());
    await act(async () => app.button('Back to Window').click());
    expect(page.hidden).toBe(true);
    expect(app.container.querySelector<HTMLElement>('#lab-workbench')!.hidden).toBe(false);
  } finally { await app.close(); }
});

it('moves the floating entries into the sidebar while it is visible', async () => {
  const scope = 'http://localhost/window-shortcuts/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(app.container.querySelector('#lab-context nav[aria-label="Shortcuts"]')).not.toBeNull());
    // The Window capsule gives way to the sidebar's Windows section.
    expect(app.container.querySelector('.lab-window-floating:not([data-hidden])')).toBeNull();
    const apple = /Mac|iPhone|iPad/.test(navigator.platform);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', metaKey: apple, ctrlKey: !apple, bubbles: true, cancelable: true })); });
    expect(app.container.querySelector('.lab-window-floating:not([data-hidden])')).not.toBeNull();
  } finally { await app.close(); }
});
```

In the second test, also assert that a Shortcuts row exists for every entry the fixture enables. Read which of Team, TPM, Track and Ask are visible by default in the fixture (`teamView` defaults on; TPM depends on `pointer: coarse`; Track needs `userScoped`; Ask defaults off). For each enabled one, assert that its trigger is inside `#lab-context` while the sidebar is visible and outside it after ⌘\.

Then a third test: choosing "New session" in the **New** menu opens the page with the title "New session" and the provider controls. It replaces the 2a assertion on `.lab-sidebar-new`, which no longer exists on desktop. Update that 2a test (search `App.bot-mode.test.tsx` for `lab-sidebar-new`) to assert `#lab-sessions-page[aria-label="New session"]` is visible instead.

- [ ] **Step 2: Run** `npx vitest run src/App.bot-mode.test.tsx` → the new tests FAIL.

- [ ] **Step 3: Page state.** In `AppContent`, near `sessionPanel` (around line 367), add:

```tsx
  // Desktop: the sidebar's All sessions, Favorites, New session and Settings entries open their panel as a page in place of the Window.
  const [sessionsPage, setSessionsPage] = useState(false);
  const pageOpen = windowMode && !compactLayout && sessionsPage;
  const openPage = useCallback((panel: typeof sessionPanel) => {
    setSessionPanel(panel); setActiveView('workbench'); setSessionsPage(true);
    if (panel === 'favorites') void favorites.refresh();
  }, [favorites]);
  const pageTitle = sessionPanel === 'list' ? 'All sessions' : sessionPanel === 'favorites' ? 'Favorites' : sessionPanel === 'new' ? 'New session' : 'Settings';
```

Place it after `compactLayout`, `windowMode` and `favorites` are defined. If `favorites` is not stable, drop `useCallback`.

Change `openNewSessionPanel` (from 2a) so that on desktop it calls `openPage('new')`; keep its compact branch as it is. Close the page whenever the user goes back to the Window:
- **The central open path.** Find the function every session open goes through (`openSession(...)` around line 1300; check that `openDirectorySession`, `openPreviewSource`, `openTrackedSession` and `openScannedSession` reach it). Call `setSessionsPage(false)` there once the open has started.
- **Creating and resuming.** Call it after `createAgent()` and `resumeAgent()` start a session.
- **The Windows panel's navigation.** Pass `onNavigate={() => setSessionsPage(false)}` to the sidebar's `WindowWorkspaces`.
- **The "Back to Window" button.**
- **Bot mode and compact.** Switching to Bot mode does not need to close it. On compact the page is not shown, because `pageOpen` is false.

- [ ] **Step 4: Panel content once, in two places.** Cut the whole `<div className="lab-sidebar-content"> … </div>` block (from `{sessionPanel === 'settings' ? <section className="lab-mobile-settings"` through the `failure` alert) into a constant declared just before the `return`:

```tsx
  const sessionPanelContent = <div className="lab-sidebar-content">{/* the block, unchanged */}</div>;
```

The block contains `polling={windowMode && (compactLayout ? contextOpen : desktopContextVisible)}` in three places (VS Code tunnel, previews). On desktop the panels are now visible when the page is open, so change those to `polling={windowMode && (compactLayout ? contextOpen : pageOpen)}`. The two `VscodeTunnelScope` / `PreviewScope` wrappers at the top of the tree also poll on `desktopContextVisible`. Make them `compactLayout ? contextOpen : (desktopContextVisible || pageOpen)`: previews show in the sidebar's other places too, so keep polling while the sidebar is open. Discovery in `useRemoteHosts` (around line 552) is on while the sidebar is open; also turn it on while `pageOpen`. The footer's count needs fresh Hosts, and the existing poll already runs every 30 s, so nothing else changes.

In the rail:
- Compact: render the compact tabs nav, `{sessionPanelContent}` and the compact footer exactly as today.
- Desktop: replace the desktop tabs nav, the `Open in` status and the content with the new structure:

```tsx
      {!compactLayout ? <>
        <div className="lab-sidebar-scroll">
          <section className="lab-sidebar-section" aria-label="Windows">
            <WindowWorkspaces workspace={windowWorkspace} current={menuCurrentBinding} active={desktopContextVisible} sessionStatus={windowSessionStatus}
              onOverview={windowOverviewAvailable ? () => setWindowOverviewOpen(true) : undefined} onNavigate={() => setSessionsPage(false)} />
          </section>
          <nav className="lab-sidebar-section lab-sidebar-shortcuts" aria-label="Shortcuts">
            <h2 className="lab-sidebar-section-title">Shortcuts</h2>
            <button type="button" className="lab-sidebar-link" aria-current={pageOpen && sessionPanel === 'list' ? 'page' : undefined} onClick={() => openPage('list')}>All sessions</button>
            {userScoped ? <button type="button" className="lab-sidebar-link" aria-current={pageOpen && sessionPanel === 'favorites' ? 'page' : undefined} onClick={() => openPage('favorites')}>Favorites</button> : null}
            <ShortcutPlacement.Provider value="sidebar">{shortcutEntries}</ShortcutPlacement.Provider>
          </nav>
        </div>
        <SidebarFooter hosts={remoteHosts} loaded={hostsLoaded} onHosts={() => openPage('list')} onSettings={() => openPage('settings')} settingsPressed={pageOpen && sessionPanel === 'settings'} />
      </> : null}
```

Notes on the names above:
- `menuCurrentBinding` is the `current` value `WindowMenu` receives today: `sharedWindow ? directoryView?.binding : currentSession ? windowSessionBinding(currentSession) : undefined`. Hoist it into a constant and use it for both.
- `hostsLoaded` is `useRemoteHosts`'s `loaded`; destructure it where the hook is called.
- `aria-label="Windows"` on the section duplicates the nav's name inside it. Give the section `aria-labelledby` pointing at the Windows heading instead, or no label; avoid two landmarks named "Windows". Tests find `nav[aria-label="Windows"]`.

- [ ] **Step 5: The capsules.** Group the four entries currently rendered between `WindowOverview` and the Ask surfaces into one constant, keeping their props unchanged: `SessionTrackingMenu` (with its `userScoped && attention.trackVisible` condition), `TeamMenu`, `TpmMenu` and the `AskButton`. The Ask surfaces (`askSources…renderAsk`) stay where they are.

```tsx
  const sidebarShortcuts = windowMode && !compactLayout && desktopContextVisible && !windowWorkspace.unavailable;
  const shortcutEntries = <>{/* SessionTrackingMenu, TeamMenu, TpmMenu, AskButton — as rendered today */}</>;
```

Where they render today, render `{!sidebarShortcuts ? shortcutEntries : null}`. The `AskButton` was inside `.lab-ask-workspaces`; keep it there in the floating case. The Shortcuts nav renders them in the sidebar case (Step 4).

`WindowMenu` gets `visible={windowMode && windowView.visible && !sidebarShortcuts}`.

The "Window view" checkbox in View options still decides whether the capsule shows when the sidebar is hidden. The Windows section in the sidebar does not depend on it.

Read `TeamMenu`'s `visible` prop: in the sidebar the row follows the same `teamView.visible`. The same goes for TPM (`tpmView.visible`), Track (`attention.trackVisible`) and Ask (`askSurfaceVisible`).

- [ ] **Step 6: The page.** In `PreviewWorkspace className="lab-main-stage"`, before `<section … id="lab-workbench"`, add:

```tsx
      {!compactLayout ? <section id="lab-sessions-page" className="lab-sessions-page" aria-label={pageTitle} hidden={!pageOpen}>
        <Toolbar className="lab-sessions-page-toolbar" title={pageTitle}
          leading={<IconButton icon="chevron-left" label="Back to Window" onClick={() => setSessionsPage(false)} />} />
        {sessionPanel !== 'settings' ? <div className="lab-session-open-target" role="status">Open in: <strong>{directoryView?.binding?.title ?? (directoryView ? 'Empty session view' : sidebarWindow?.target?.title ?? 'Main session')}</strong></div> : null}
        <div className="lab-sessions-page-body">{sessionPanelContent}</div>
      </section> : null}
```

On `#lab-workbench`, change `hidden={activeView !== 'workbench'}` to `hidden={activeView !== 'workbench' || pageOpen}`. In the `SessionWindow` `visible` expression, add `&& !pageOpen`. Check the same for the Trace panel: while a page is open, the page replaces whatever the main stage showed. Make `#lab-trace` hidden too when `pageOpen`, and report what you chose.

Escape on the page goes back to the Window: add `onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); setSessionsPage(false); } }}` to the section.

`sessionPanelContent` is a single element and React cannot render it in two places at once. The desktop rail no longer renders it, and the compact rail does not render the page, so it appears exactly once.

- [ ] **Step 7: Styles.** Append to `shell.css`:

```css
.lab-sidebar-scroll { display: flex; flex: 1; flex-direction: column; gap: 14px; min-height: 0; padding: 4px 8px 12px; overflow: auto; }
.lab-sidebar-section { display: flex; flex-direction: column; gap: 1px; }
.lab-sidebar-section-title { margin: 0 0 4px; padding: 0 10px; color: var(--ui-label-secondary); font: 600 var(--ui-size-caption)/1.3 var(--ui-font); }
.lab-sidebar-link { display: flex; align-items: center; width: 100%; min-height: 30px; padding: 4px 10px; border: 0; border-radius: var(--ui-radius-control);
  color: var(--ui-label); background: transparent; font: var(--ui-size-body)/1.2 var(--ui-font); text-align: start; }
.lab-sidebar-link:hover:not(:disabled) { color: var(--ui-label); background: var(--ui-row-hover); border-color: transparent; }
.lab-sidebar-link[aria-current="page"] { background: var(--ui-selection); }
.lab-sessions-page { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; background: var(--ui-background); }
.lab-sessions-page[hidden] { display: none; }
.lab-sessions-page-body { flex: 1; min-height: 0; overflow: auto; }
.lab-sessions-page-body > .lab-sidebar-content { max-width: 720px; margin: 0 auto; padding: 16px 20px 32px; }
```

The global `button:hover:not(:disabled)` rule (0,2,1) beats `.lab-sidebar-link:hover:not(:disabled)` (0,2,1) only when it loads later. Check the order: `shell.css` is imported by `SidebarHeader.tsx`. If `app.css` wins, double the class (`.lab-sidebar-link.lab-sidebar-link:hover…`). Inside `WindowWorkspaces`, the Windows panel's own styles (`window-workspaces.css`) were written for the floating panel; look at them in the sidebar (Task 9) before changing any.

In `app.css`, the desktop rail rules (`@media (min-width: 1181px) .lab-context-rail { display: flex; flex-direction: column; … }`) stay. Remove the sticky rules that targeted `.lab-sidebar-content .lab-session-search` inside the desktop rail (Task 11 of 2a made them `--ui-sidebar`), or limit them to `.lab-sidebar-content` inside the rail. On the page, the search bar can stay sticky against the page background: change its background to `--ui-background` there.

- [ ] **Step 8: Run** `npx vitest run src/App.bot-mode.test.tsx` → PASS. Then run all App tests: `npx vitest run src/App*.test.tsx`. Several existing tests open desktop panels through `#lab-context` (for example `App.host-providers.test.tsx` and `App.test.tsx` "Discover sessions", `App.tracking.test.tsx` `.lab-sidebar-tabs`). Update each one to the new place:
  - the panel is on `#lab-sessions-page`, opened by "All sessions" / "Favorites" / "Sidebar settings";
  - the Track entry is inside `#lab-context` while the sidebar is visible.

  Change only how the test reaches the control, never what it asserts about the control. List every test you changed. A test that passes when its file is rerun alone is load flake; say so.

- [ ] **Step 9: Run** `npx tsc --noEmit -p .`, then from the worktree root `pnpm compatibility:update && pnpm compatibility:check`.

- [ ] **Step 10: Commit** with the message "feat(lab): Windows, In this Window and Shortcuts in the desktop sidebar, sessions on their own page".

---

### Task 7: End-to-end tests follow the new places

**Files:** Create `packages/agent-remote-lab/e2e/all-sessions.ts`. Modify the desktop-project specs that reach the moved controls.

- [ ] **Step 1: The helper.**

```ts
import type { Locator, Page } from '@playwright/test';

/** Opens a sessions page on desktop (All sessions, Favorites or Settings) and returns it; on compact layouts the panels stay in the Context dialog. */
export async function openSessionsPage(page: Page, entry: 'All sessions' | 'Favorites' | 'Settings' = 'All sessions'): Promise<Locator> {
  const rail = page.locator('#lab-context');
  if (entry === 'Settings') await rail.getByRole('button', { name: 'Sidebar settings', exact: true }).click();
  else await rail.getByRole('navigation', { name: 'Shortcuts' }).getByRole('button', { name: entry, exact: true }).click();
  const sessions = page.locator('#lab-sessions-page');
  await sessions.waitFor({ state: 'visible' });
  return sessions;
}
```

- [ ] **Step 2: Find the affected tests.** From `packages/agent-remote-lab`:

```bash
grep -lE "#lab-context|'Discover sessions'|name: 'Sessions'|name: 'Favorites'|Sidebar settings|'Sidebar sections'|lab-sidebar-content|name: 'Windows'|'Teams'|'TPM works'|'Tracked sessions'|'Ask about this session'|lab-window-floating|lab-team-floating|lab-tpm-floating" e2e/*.spec.ts e2e/*.ts | sort
```

For each file, look at the projects it runs in (`playwright.config.ts` maps specs to projects and viewports). Only desktop-width runs (>1180px) are affected.

- [ ] **Step 3: Run them on this branch and on the baseline**, as in the verification task of phase 2a:
  - **Baseline:** the worktree `/Volumes/Projects/agent-remote-control/.worktrees/e2e-baseline`. Run `git -C … checkout --detach ee371488`, then `pnpm install --frozen-lockfile` and `pnpm --filter "@orchardworks/agent-remote-lab^..." run build`.
  - **Order:** run the branch first, then the baseline, **not at the same time**. In phase 2a, concurrent runs under load failed about 100 tests on both sides.
  - **Ports:** use private ports, 5951/6216 for the branch and 5961/6226 for the baseline.
  - **Failures to fix:** every test that passes on the baseline and fails here.

- [ ] **Step 4: Fix each failing test.** A test that needs a moved control reaches it through its new place:
  - **Directory, Hosts, new session, previews:** use `openSessionsPage(page)` and search inside the returned locator instead of `#lab-context`. The same applies to the "Sessions" tab and to "Discover sessions".
  - **Favorites:** use `openSessionsPage(page, 'Favorites')`.
  - **Settings, Controller updates, VS Code:** use `openSessionsPage(page, 'Settings')`.
  - **Windows capsule:** on desktop with the sidebar visible, use the sidebar's `#lab-context nav[aria-label="Windows"]` / `"Session views"`. Alternatively, hide the sidebar first via View options → Sidebar (`e2e/view-options.ts`) when the test is about the capsule itself (dragging, placement).
  - **Team, TPM, Track, Ask capsules:** the triggers keep their names and are found anywhere on the page. Tests about floating placement or dragging hide the sidebar first.
  - **Sidebar width:** see Task 1.

  Do not weaken an assertion about the control itself. If a test checks something the redesign removed on purpose, say what and why, and change the test to the new behavior. Examples: the desktop "Sidebar sections" tabs, the "＋ New session" sidebar button, and the sidebar showing the directory at load.

- [ ] **Step 5: Run the changed specs again** on this branch until every test that passes on the baseline passes here. Then commit with the message "test(lab): reach sessions, Favorites and Settings through the sidebar's pages".

---

### Task 8: Verify the phase

- [ ] **Step 1:** From `packages/agent-remote-lab`, run `pnpm --silent typecheck` and `pnpm --silent test`. Rerun a failing file alone, and report it as load flake if it then passes.
- [ ] **Step 2:** `npx vitest run -c vitest.preview.config.ts e2e/ui-primitives.browser.ts`.
- [ ] **Step 3:** Compare Playwright against the baseline, as in Task 7 Step 3. Run these specs, sequentially, not alongside the baseline run:
  - `bot-mode`, `modernization`, `sidebar`, `mobile-sidebar`, `session-view-ownership`, `workspace-layout`, `window-workspaces`, `floating-controls-layout`, `mobile`, `directory`;
  - plus every spec changed in Task 7.
- [ ] **Step 4:** From the worktree root, run `pnpm compatibility:update` and `pnpm compatibility:check`, and commit if the file changed.
- [ ] **Step 5: Local instance.** Follow `prepare-arc-local`: `pnpm local up` in this worktree, one Claude turn from the command line (`cli-turn.mjs`) and one through the page (`session-turn.mjs`). Then, with a headless script at 1440×900, check that:
  - the sidebar shows Windows / In this Window / Shortcuts / the footer;
  - choosing a view in In this Window selects it and expands a collapsed dock;
  - All sessions opens the page, opening a session from it returns to the Window, and the session shows;
  - Teams / TPM / Track open their panels beside the sidebar;
  - ⌘\ hides the sidebar and the capsules float again;
  - Settings opens.

  Take screenshots in light and dark, plus the phone layout (390×844, unchanged from 2a apart from what the shared components changed). Read each image.
- [ ] **Step 6:** Record deviations under "Changes made during execution" at the end of this file, and commit.

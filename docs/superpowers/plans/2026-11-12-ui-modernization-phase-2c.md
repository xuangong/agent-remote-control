# UI modernization phase 2c: the Window toolbar and ⌘K search

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give desktop Window mode a toolbar above the session views and add a ⌘K search that works in both modes.
- **Toolbar contents:** the Window name (renamed in place) and its view count, a **+** menu (New session view, Open session…), a Docks toggle, and a ⋯ menu (Show as section, Copy link, Agent control…, Delete Window…).
- **⌘K search:** a command palette over actions, Windows, Bots and known sessions.

**Architecture:**
- **Spec sections:** this implements "Window mode → Toolbar" and "App shell → Search (⌘K)" of `docs/superpowers/specs/2026-11-09-ui-modernization-design.md`, the last part of phase 2 (2a and 2b are merged).
- **Shared Window actions:** today they live inside `src/components/WindowWorkspaces.tsx` (its local `run()`/`notice`). They move into a hook, `useWindowActions`, and an `AgentControl` component that the sidebar and the toolbar both use.
- **The toolbar:** it uses the existing `Toolbar` primitive and is desktop-only. Compact layouts don't change, since phase 5 does phones. When the desktop sidebar is hidden, View options moves into the toolbar instead of the first pane heading, so it has one predictable place.
- **The palette:**
  - It is a modal `<dialog>` with a combobox input and a listbox, using `aria-activedescendant`.
  - The ranking is a pure function. App builds the items from data that is already on the client; the palette makes no network calls.
  - ⌘K / Ctrl+K joins `useShellShortcuts`, and a Search button joins both sidebar headers.

**Tech Stack:**
- React 18 and TypeScript.
- Plain CSS with the `--ui-*` tokens.
- Vitest (jsdom) and Playwright.

**Working rules for every task:**
- **Where to work:** the worktree `/Volumes/Projects/agent-remote-control/.worktrees/ui-modern-4` (branch `feat/ui-modern-4`, from main 9b58607f; deps installed and built). Run package commands from `packages/agent-remote-lab` after `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH";`.
- **Commits:**
  - Never use `--no-verify`.
  - Write code, comments and commits in English.
  - End commit messages with a blank line and `Co-Authored-By: Claude <noreply@anthropic.com>`.
  - Before the final commit of a task, run `pnpm compatibility:update && pnpm compatibility:check` from the worktree root. It can stall for minutes; use a 10-minute timeout.
- **Before editing:**
  - Read a file before editing it. Line numbers are approximate. If the code differs from what is quoted, keep the intent and report it.
  - `src/App.tsx` is about 3000 lines: grep it rather than reading all of it.
- **Stylesheet guard** (`src/ui/stylesheets.test.ts`): tokens only, no undefined variables.
- **Accessible names stay:** a control that still exists keeps its accessible name. Pinned names include "New session view" (`.lab-session-dock-add`), "Window options" (`.lab-window-options`), "Show as section", "Copy link", "Agent control", "Delete Window: …", "Rename Window: …" and "Window title".
- **Playwright:** run it with `AGENT_REMOTE_TEST_RELAY_PORT=5981 AGENT_REMOTE_TEST_WEB_PORT=6246 npx playwright test e2e/<spec>.spec.ts --project=chromium-desktop --reporter=line`. Keep each call under 9 minutes and never use `networkidle`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/hooks/useWindowActions.ts` (new) | Copy link, Show as section, rename, delete the current Window (switching away first); serialized, with a notice |
| `src/components/AgentControl.tsx` (new) | The Window manager assignment UI, shared by the sidebar's Window options and the toolbar's sheet |
| `src/components/WindowWorkspaces.tsx` | Uses the two above; its behaviour doesn't change |
| `src/shell/WindowToolbar.tsx` (new), `src/shell/shell.css` | The desktop Window toolbar |
| `src/components/SessionDock.tsx` | A `docksHidden` option that hides dock panes without unmounting them |
| `src/shell/command-search.ts` (new) | Ranking palette items for a query |
| `src/shell/CommandPalette.tsx` (new), `src/shell/shell.css` | The ⌘K dialog |
| `src/hooks/useShellShortcuts.ts` | ⌘K / Ctrl+K |
| `src/shell/SidebarHeader.tsx` | An optional Search button |
| `src/App.tsx` | Mounting the toolbar and the palette, building the palette items, the View options target |

---

### Task 1: Window actions as a hook, Agent control as a component

**Files:**
- Create: `src/hooks/useWindowActions.ts`, `src/hooks/useWindowActions.test.tsx`, `src/components/AgentControl.tsx`.
- Modify: `src/components/WindowWorkspaces.tsx`.

Move the logic out of `WindowWorkspaces` (the `run`/`background`/`edit` helpers, the `notice` state, the scope guard `currentScope`, Copy link, Show as section, saving a rename, Delete). `WindowWorkspaces` then calls the hook. Its DOM, names and behaviour don't change, and its existing tests must pass unchanged.

- [ ] **Step 1: Write the failing test** `src/hooks/useWindowActions.test.tsx`.
  - Build the `workspace` object the same way `WindowWorkspaces.test.tsx`'s `fixture()` does; reuse or export that helper.
  - Test these:
    - `copyLink()` writes the URL with `window=<id>` and without `mode`, `section` or `bot` (mock `navigator.clipboard.writeText`), and sets the notice "Window link copied.".
    - `showAsSection()` calls `operateGroup(id, { type: 'bots.add', rank })`, using the same rank rule as today, and sets "Shown as a section in Bot mode.".
    - While one action is running, a second `run` returns `false` (`busy` is true).
    - An error from an action becomes the notice.
    - `deleteCurrent()`, given another Window, opens it and then removes the old one. With no other Window, it creates one first and then removes. On failure the notice says so and the current Window stays.
- [ ] **Step 2: Run it.** `npx vitest run src/hooks/useWindowActions.test.tsx` should FAIL (the module is missing).
- [ ] **Step 3: Implement.**
  - **`useWindowActions(workspace)`** returns `{ notice, setNotice, busy, run, edit, copyLink, showAsSection, saveRename(id, title) → Promise<boolean>, deleteCurrent(), deleteWindow(id) }`.
    - Move the bodies of `run`, `background`, `edit`, Copy link, Show as section, `saveRename` and Delete verbatim from `WindowWorkspaces.tsx`. `saveRename` returns whether the edit is finished, so the caller can close its form.
    - Keep the reset effect that clears the notice when `workspace.client` or `workspace.window?.id` changes.
  - **`deleteCurrent()`** is new:
    1. Take the other Windows in recent-use order. `WindowOverview`'s `byRecentUse(scope, catalog)` provides the order; export it if needed and pass `scope` in.
    2. Open the first one with `workspace.open(id)`. If there is none, call `await workspace.create()`.
    3. Remove the previous id with `workspace.remove(previousId)`.
    4. Run all of this inside `run()`.
  - **`AgentControl`** gets the content of today's `<details className="lab-window-agent">` (manager status, "Use current session", "Clear manager", notes). Its props are `{ client, windowId, current?, active }`, and it calls `useWindowManager` itself. In `WindowWorkspaces`, keep the `<details className="lab-window-agent"><summary>Agent control</summary>` wrapper and render `<AgentControl active={active && agentControl} …/>` inside it.
- [ ] **Step 4: Run** `npx vitest run src/hooks/useWindowActions.test.tsx src/components/WindowWorkspaces.test.tsx src/components/WindowMenu.test.tsx` → PASS. Then `npx tsc --noEmit -p .`.
- [ ] **Step 5: Commit** "refactor(lab): share the Window actions and Agent control outside the Windows panel".

---

### Task 2: Hide docks without unmounting them

**Files:**
- Modify: `src/components/SessionDock.tsx`.
- Test: `src/components/SessionDock.test.tsx`.

The toolbar's Docks toggle hides the dock panes of the current page. This is a personal view preference stored per browser (localStorage `agent-remote:docks-hidden`), not a Window edit. The panes stay mounted and attached, and the main area takes the width.

- [ ] **Step 1: Write the failing test.** Read the existing tests in `SessionDock.test.tsx` and render a rail with two docked panes the way they do. Assert:
  - with `docksHidden` set on `SessionDockProvider`, each `.lab-session-dock-pane` has the `hidden` attribute and its children are still in the DOM (the same element before and after);
  - the `+` (`.lab-session-dock-add`) stays visible.
- [ ] **Step 2: Run it**: FAIL.
- [ ] **Step 3: Implement.**
  - Add `docksHidden?: boolean` to `SessionDockProvider` and expose it in the context.
  - In `SessionDockRail`, render `DockPane`s with `hidden={docksHidden}` and add `data-docks-hidden` to `.lab-session-dock-rail`.
  - Make sure a hidden dock pane neither reserves width nor keeps a resize handle. Check the rail's CSS in `session-dock.css` and add `.lab-session-dock-pane[hidden] { display: none; }` if a rule overrides `[hidden]`.
- [ ] **Step 4: Run** `npx vitest run src/components/SessionDock.test.tsx`: PASS.
- [ ] **Step 5: Commit** "feat(lab): let the dock rail hide its panes without detaching them".

---

### Task 3: The Window toolbar

**Files:**
- Create: `src/shell/WindowToolbar.tsx`, `src/shell/WindowToolbar.test.tsx`.
- Modify: `src/shell/shell.css`.

- [ ] **Step 1: Write the failing tests** `src/shell/WindowToolbar.test.tsx`. Render with a fixture Window (title "Research", 3 views) and callbacks as `vi.fn()`.
  - **Title and rename:**
    - The `header.ui-toolbar.lab-window-toolbar` shows the h2 "Research" and the subtitle "3 session views" ("1 session view" when there is one).
    - Clicking the title button (accessible name "Rename Window: Research") replaces it with an input named "Window title" holding the title, with all text selected.
    - Enter saves through `onRename('New name')`. Escape cancels without saving. Blur saves.
    - An empty or unchanged title doesn't save.
    - After a save or a cancel, focus returns to the title button.
  - **The Add menu:** opening the `Menu` labelled "Add" shows the items "New session view" and "Open session…". Each calls `onNewView` / `onOpenSession`.
  - **The Docks toggle:** the IconButton labelled "Hide docks" has `aria-pressed="false"` and calls `onToggleDocks`. When `docksHidden` is set, it is labelled "Show docks" with `aria-pressed="true"`. It is absent when `hasDocks` is false.
  - **The Window actions menu:** the `Menu` labelled "Window actions" lists "Show as section" (only when `canShowAsSection`), "Copy link", "Agent control…" (only when `agentControl` is available) and "Delete Window…" (destructive). Each calls its callback.
  - **The leading slot:** `leading` content (the View options slot) renders before the title.
- [ ] **Step 2: Run**: FAIL.
- [ ] **Step 3: Implement** `src/shell/WindowToolbar.tsx`:

```tsx
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Toolbar } from '../ui/Toolbar.js';
import { IconButton } from '../ui/IconButton.js';
import { Menu, type MenuEntry } from '../ui/Menu.js';
import './shell.css';

/** The toolbar above a desktop Window: its name (renamed in place) and view count, adding views, the dock rail, and Window actions. */
export function WindowToolbar({ title, viewCount, leading, disabled, onRename, onNewView, onOpenSession, hasDocks, docksHidden, onToggleDocks,
  canShowAsSection, onShowAsSection, onCopyLink, onAgentControl, onDelete }: {
  title: string; viewCount: number; leading?: ReactNode; disabled?: boolean; onRename(title: string): void;
  onNewView(): void; onOpenSession(): void; hasDocks: boolean; docksHidden: boolean; onToggleDocks(): void;
  canShowAsSection: boolean; onShowAsSection(): void; onCopyLink(): void; onAgentControl?(): void; onDelete(): void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const button = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => { if (!editing && returnFocus.current) { returnFocus.current = false; button.current?.focus(); } }, [editing]);
  const finish = (save: boolean) => {
    const next = draft.trim();
    returnFocus.current = true; setEditing(false);
    if (save && next && next !== title) onRename(next);
  };
  const actions: MenuEntry[] = [
    ...(canShowAsSection ? [{ label: 'Show as section', icon: 'sidebar' as const, onSelect: onShowAsSection }] : []),
    { label: 'Copy link', icon: 'link', onSelect: onCopyLink },
    ...(onAgentControl ? [{ label: 'Agent control…', onSelect: onAgentControl }] : []),
    { kind: 'separator' },
    { label: 'Delete Window…', icon: 'trash', destructive: true, onSelect: onDelete },
  ];
  return <Toolbar className="lab-window-toolbar" leading={leading}
    title={editing ? <input className="lab-window-toolbar-input" aria-label="Window title" autoFocus maxLength={256} value={draft}
        onFocus={event => event.currentTarget.select()} onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); finish(true); } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); } }}
        onBlur={() => { if (editing) finish(true); }} />
      : <button ref={button} type="button" className="lab-window-toolbar-title" aria-label={`Rename Window: ${title}`} title="Rename this Window"
        disabled={disabled} onClick={() => { setDraft(title); setEditing(true); }}>{title}</button>}
    subtitle={`${viewCount} ${viewCount === 1 ? 'session view' : 'session views'}`}
    trailing={<>
      <Menu label="Add" icon="plus" items={[
        { label: 'New session view', onSelect: onNewView },
        { label: 'Open session…', onSelect: onOpenSession },
      ]} />
      {hasDocks ? <IconButton icon="sidebar" label={docksHidden ? 'Show docks' : 'Hide docks'} aria-pressed={docksHidden} onClick={onToggleDocks} /> : null}
      <Menu label="Window actions" items={actions} />
    </>} />;
}
```

  Before relying on the code above, check these against the real primitives:
  - `MenuEntry` supports `icon`, `destructive` and `{ kind: 'separator' }` (`src/ui/Menu.tsx`).
  - The `Icon` names used exist (`link`, `trash`, `sidebar`, `plus`). Choose an existing icon for the docks toggle; add a `dock` icon in the existing style if none fits.
  - The `Toolbar` `title` accepts a ReactNode. Its h2 then wraps the button or the input; that's acceptable, and the h2 keeps the Window name for assistive technology through the button text.

  CSS in `shell.css`:
  - `.lab-window-toolbar-title`: a borderless button with the title type, an `--ui-row-hover` background on hover and the shared focus ring.
  - `.lab-window-toolbar-input`: the title font, a 1px `--ui-separator` border and `--ui-radius-control`.
  - Use doubled classes, so the rules win over the global `button` rules.
- [ ] **Step 4: Run** `npx vitest run src/shell/WindowToolbar.test.tsx src/ui/stylesheets.test.ts`: PASS.
- [ ] **Step 5: Commit** "feat(lab): add the Window toolbar".

---

### Task 4: The toolbar in Window mode

**Files:**
- Modify: `src/App.tsx`, `src/components/SessionDock.tsx` (only if the dock heading slot is removed), `src/shell/shell.css`.
- Test: `src/App.bot-mode.test.tsx`, or a new `src/App.window-toolbar.test.tsx` that uses `src/test/bot-mode-fixtures.ts`.

- [ ] **Step 1: Write the failing App tests.**
  - **Placement.** On desktop (`matchMedia` not stubbed), with `?window=A`, `header.lab-window-toolbar` is the first child of `#lab-workbench` and shows Window A's title. On compact (stub `matchMedia('(max-width: 1180px)')`), it is absent.
  - **Rename.** Renaming through the toolbar renames the Window: the sidebar row shows the new title.
  - **Add menu.** "New session view" adds a view (one more `[data-window-view-row]` in the sidebar's "Session views"). "Open session…" also opens `#lab-sessions-page` with "All sessions".
  - **Docks.** "Hide docks" hides the dock panes (`.lab-session-dock-pane[hidden]`), the choice survives a remount (localStorage), and "Show docks" brings them back.
  - **View options.** With the sidebar hidden (⌘\), the View options trigger (`button[aria-label="View options"]`) is inside `header.lab-window-toolbar`.
  - **Delete Window…** opens a confirmation dialog (a `Sheet` titled "Delete this Window?" with "Delete Window" and "Cancel"). Confirming leaves a different current Window and the old one disappears from the sidebar's "Windows".
- [ ] **Step 2: Run**: FAIL.
- [ ] **Step 3: Implement in `App.tsx`.**
  1. Create `const windowActions = useWindowActions(windowWorkspace, baseUrl)` once, after `windowWorkspace` exists. Pass it down to the sidebar's `WindowWorkspaces`, adding an optional `actions` prop to `WindowWorkspaces` that defaults to its own hook. That way the toolbar and the sidebar share one `busy` state and one notice. Show `windowActions.notice` through the existing toast: `toast?.show('window-action', 'Window', notice, 'info')`, then clear it.
  2. Add the state:
     - `docksHidden`: `useState(() => localStorage.getItem('agent-remote:docks-hidden') === '1')`, persisted in an effect, and passed to `SessionDockProvider`.
     - `agentControlOpen`.
     - `deleteConfirmOpen`.
  3. In `#lab-workbench`, as its first child (before the `.lab-window-controls` slot), render for `sharedWindow && !compactLayout && !windowWorkspace.unavailable`:

```tsx
<WindowToolbar title={sharedWindow.title} viewCount={sharedWindow.views.length}
  leading={<div ref={setWindowToolbarViewTarget} data-pane-selection-ignore className="lab-global-view-slot" />}
  disabled={windowActions.busy} onRename={title => void windowActions.saveRename(sharedWindow.id, title)}
  onNewView={() => { try { sessionWindows.create(); } catch (error) { setSessionNotice(sessionConnectionFailure(error, false)); } }}
  onOpenSession={createSessionView}
  hasDocks={sharedWindow.views.some(view => view.placement === 'dock')} docksHidden={docksHidden} onToggleDocks={() => setDocksHidden(value => !value)}
  canShowAsSection={!windowWorkspace.group?.bots} onShowAsSection={() => void windowActions.showAsSection()}
  onCopyLink={() => void windowActions.copyLink()} onAgentControl={windowWorkspace.client ? () => setAgentControlOpen(true) : undefined}
  onDelete={() => setDeleteConfirmOpen(true)} />
```

     - Read `createSessionView` (around line 1233). It creates a view and opens the chooser, which matches "Open session…". "New session view" only creates and selects one.
     - Add `windowToolbarViewTarget` state next to the other View options slots (around line 375).
  4. **The View options `target`.** Around line 2716, for a shared Window in the workbench with the sidebar hidden, use the toolbar slot:

```tsx
target={!headerHidden ? headerViewTarget : compactLayout ? mobileViewTarget : desktopContextVisible ? sidebarViewTarget
  : pageOpen ? pageViewTarget : activeView === 'trace' ? traceViewTarget
  : sharedWindow && !windowWorkspace.unavailable ? windowToolbarViewTarget
  : minimizedViewTarget ?? sessionViewTarget}
```

     Then remove the now-unused shared-Window slots:
     - the `.lab-window-controls` div;
     - the `SessionDockProvider` `leadingControls` (`dockViewTarget`);
     - `setSessionViewTarget` in the shared branch (around line 2475 and the empty-primary heading near line 2900).

     Keep the legacy (no shared Window) branch as it is. If `leadingControls` has no other user, drop the prop from `SessionDockProvider` and its consumers (`useSessionDockHeadingStart`). Otherwise leave it, and report.
  5. **Agent control** goes in a `Sheet` titled "Agent control", containing `<AgentControl client={windowWorkspace.client} windowId={sharedWindow.id} current={menuCurrentBinding} active={agentControlOpen} />`.
  6. **Delete confirmation:**

```tsx
<Sheet open={deleteConfirmOpen} title="Delete this Window?" onClose={() => setDeleteConfirmOpen(false)}>
  <p>{`“${sharedWindow.title}” and its layout are deleted. Its agent sessions keep running and stay in All sessions.`}</p>
  <div className="lab-sheet-actions"><Button onClick={() => setDeleteConfirmOpen(false)}>Cancel</Button>
    <Button variant="destructive" onClick={() => { setDeleteConfirmOpen(false); void windowActions.deleteCurrent(); }}>Delete Window</Button></div>
</Sheet>
```

  7. **Styles.** The toolbar is sticky at the top of `#lab-workbench`, uses `--ui-background` with a `--ui-separator` bottom border, and the session views take the remaining height. Read the `#lab-workbench` / `.lab-window-workbench` layout in `app.css` and `session-dock.css`: if it is a flex column, the toolbar is `flex: none`. Check that docked panes' heights and the floats' geometry still fit. Floats are positioned against the workbench, so they must not slide under the toolbar.
- [ ] **Step 4: Run** `npx vitest run src/App*.test.tsx src/components src/shell` and `npx tsc --noEmit -p .`. Existing tests that looked for View options in a dock or primary heading on desktop with the sidebar hidden now find it in the toolbar. Change only how they reach it, and list each change.
- [ ] **Step 5: e2e.**
  1. Rebuild with `pnpm --filter @orchardworks/agent-remote-lab build` from the worktree root.
  2. Run on chromium-desktop: `window-pane-lifecycle` (it pins View options in dock headings at :97–112 and :216–222, and `.lab-window-controls` at :252), `window-workspaces`, `bot-mode`, `tpm-dock`, `session-view-binding`, `workspace-layout`, `modernization`.
  3. Update tests whose View options location or `.lab-window-controls` expectation changed on purpose. Use the toolbar slot, and keep each test's purpose.
  4. Every spec must pass. These specs passed on main 9b58607f in chromium-desktop.
- [ ] **Step 6: Commit** "feat(lab): show the Window toolbar above the session views".

---

### Task 5: Ranking palette items

**Files:**
- Create: `src/shell/command-search.ts`, `src/shell/command-search.test.ts`.

- [ ] **Step 1: Write the failing test.**

```ts
import { expect, it } from 'vitest';
import { searchCommands, type CommandItem } from './command-search.js';

const item = (id: string, title: string, kind: CommandItem['kind'] = 'session', extra: Partial<CommandItem> = {}): CommandItem =>
  ({ id, kind, title, run: () => {}, ...extra });

it('ranks title prefixes, then word prefixes, then substrings, and drops non-matches', () => {
  const items = [item('a', 'Refactor parser'), item('b', 'Fix the parser'), item('c', 'Sparse arrays'), item('d', 'Unrelated')];
  expect(searchCommands(items, 'par').map(entry => entry.id)).toEqual(['b', 'a', 'c']);
  expect(searchCommands(items, 'refactor').map(entry => entry.id)).toEqual(['a']);
});

it('matches every word of the query, in any order, across title, subtitle and keywords', () => {
  const items = [item('a', 'Research', 'window', { subtitle: '3 session views' }), item('b', 'New Window', 'action', { keywords: ['create'] })];
  expect(searchCommands(items, 'views research').map(entry => entry.id)).toEqual(['a']);
  expect(searchCommands(items, 'create').map(entry => entry.id)).toEqual(['b']);
});

it('ignores case and diacritics, and keeps the given order for an empty query, actions first', () => {
  const items = [item('s', 'Café notes'), item('w', 'Main', 'window'), item('n', 'New session', 'action')];
  expect(searchCommands(items, 'CAFE').map(entry => entry.id)).toEqual(['s']);
  expect(searchCommands(items, '').map(entry => entry.id)).toEqual(['n', 'w', 's']);
});

it('caps each kind', () => {
  const items = Array.from({ length: 30 }, (_, index) => item(`s${index}`, `Session ${index}`));
  expect(searchCommands(items, 'session', { perKind: 8 })).toHaveLength(8);
});
```

- [ ] **Step 2: Run**: FAIL.
- [ ] **Step 3: Implement** `src/shell/command-search.ts`:

```ts
export type CommandKind = 'action' | 'window' | 'bot' | 'session';
export type CommandItem = { id: string; kind: CommandKind; title: string; subtitle?: string; keywords?: readonly string[]; shortcut?: string; run(): void };

const kindOrder: Record<CommandKind, number> = { action: 0, window: 1, bot: 2, session: 3 };
const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** How well one query word matches a title: 3 title prefix, 2 word prefix, 1 substring, 0 none. */
function wordScore(title: string, word: string): number {
  if (title.startsWith(word)) return 3;
  if (title.split(/[^\p{L}\p{N}]+/u).some(part => part.startsWith(word))) return 2;
  return title.includes(word) ? 1 : 0;
}

/**
 * The palette's results for a query: every query word must appear in the title, subtitle or keywords. Results rank by how
 * the words meet the title, then by kind (actions, Windows, Bots, sessions), then by the order given; each kind keeps at
 * most `perKind` results. An empty query returns the items in kind order, so the caller's order (for example recent use) holds.
 */
export function searchCommands(items: readonly CommandItem[], query: string, { perKind = 8 }: { perKind?: number } = {}): CommandItem[] {
  const words = fold(query).trim().split(/\s+/).filter(Boolean);
  const ranked = items.map((item, index) => {
    const title = fold(item.title), rest = fold([item.subtitle ?? '', ...(item.keywords ?? [])].join(' '));
    let score = 0;
    for (const word of words) {
      const inTitle = wordScore(title, word);
      if (!inTitle && !rest.includes(word)) return undefined;
      score += inTitle;
    }
    return { item, index, score };
  }).filter((entry): entry is NonNullable<typeof entry> => !!entry)
    .sort((a, b) => b.score - a.score || kindOrder[a.item.kind] - kindOrder[b.item.kind] || a.index - b.index);
  const counts = new Map<CommandKind, number>();
  return ranked.filter(({ item }) => { const count = counts.get(item.kind) ?? 0; counts.set(item.kind, count + 1); return count < perKind; }).map(entry => entry.item);
}
```

- [ ] **Step 4: Run**: PASS.
- [ ] **Step 5: Commit** "feat(lab): rank command palette items for a query".

---

### Task 6: The command palette

**Files:**
- Create: `src/shell/CommandPalette.tsx`, `src/shell/CommandPalette.test.tsx`.
- Modify: `src/shell/shell.css`.

- [ ] **Step 1: Write the failing tests.** Render `<CommandPalette open items={…} onClose={close} />` with items covering all four kinds.
  - **On open:**
    - It renders a `dialog[aria-label="Search"]`, opened with `showModal`. If jsdom lacks it, stub `HTMLDialogElement.prototype.showModal` the same way existing dialog tests do (grep `showModal` in `src/**/*.test.tsx`).
    - The `input[role="combobox"]` has `aria-expanded="true"` and `aria-controls` pointing at the `role="listbox"`, and has focus.
    - Results are grouped under headings "Actions", "Windows", "Bots" and "Sessions" (`role="group"` with `aria-label`). Options are `role="option"`.
  - **Keyboard:**
    - Typing filters the results through `searchCommands`.
    - ArrowDown / ArrowUp move the active option. `aria-activedescendant` follows, and `aria-selected="true"` is on the active option. Movement wraps.
    - Home / End move to the first and last option.
    - Enter runs the active item and calls `onClose` before `run`.
    - Clicking an option runs it.
    - Escape calls `onClose`.
  - **States:**
    - With no results it shows "No results" in a `role="status"`.
    - Reopening resets the query and the active option.
- [ ] **Step 2: Run**: FAIL.
- [ ] **Step 3: Implement** `src/shell/CommandPalette.tsx`:

```tsx
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { searchCommands, type CommandItem, type CommandKind } from './command-search.js';
import './shell.css';

const groupLabels: Record<CommandKind, string> = { action: 'Actions', window: 'Windows', bot: 'Bots', session: 'Sessions' };

/** ⌘K: search actions, Windows, Bots and known sessions, and run one. A modal dialog with a combobox and a listbox. */
export function CommandPalette({ open, items, onClose }: { open: boolean; items: readonly CommandItem[]; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchCommands(items, query), [items, query]);
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!open || !node) return;
    setQuery(''); setActive(0);
    if (!node.open) node.showModal();
    input.current?.focus();
    return () => node.close();
  }, [open]);
  useEffect(() => { setActive(0); }, [query]);
  const optionId = (index: number) => `${listId}-${index}`;
  const choose = (item: CommandItem | undefined) => { if (!item) return; onClose(); item.run(); };
  const move = (next: number) => { if (results.length) setActive((next + results.length) % results.length); };
  useEffect(() => { document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' }); }, [active, results]);
  const groups = (['action', 'window', 'bot', 'session'] as const).map(kind => ({ kind, entries: results.flatMap((item, index) => item.kind === kind ? [{ item, index }] : []) }))
    .filter(group => group.entries.length);
  return <dialog ref={dialog} className="lab-command-palette" aria-label="Search" onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === dialog.current) onClose(); }}>
    {open ? <>
      <input ref={input} className="lab-command-input" role="combobox" aria-label="Search" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={results.length ? optionId(active) : undefined} placeholder="Search Windows, Bots, sessions and actions" value={query}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') { event.preventDefault(); move(active + 1); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); move(active - 1); }
          else if (event.key === 'Home') { event.preventDefault(); move(0); }
          else if (event.key === 'End') { event.preventDefault(); move(results.length - 1); }
          else if (event.key === 'Enter') { event.preventDefault(); choose(results[active]); }
        }} />
      <div id={listId} role="listbox" aria-label="Results" className="lab-command-results">
        {groups.map(group => <div key={group.kind} role="group" aria-label={groupLabels[group.kind]} className="lab-command-group">
          <div className="lab-command-group-title" aria-hidden="true">{groupLabels[group.kind]}</div>
          {group.entries.map(({ item, index }) => <div key={item.id} id={optionId(index)} role="option" aria-selected={index === active}
            className="lab-command-option" onPointerMove={() => setActive(index)} onClick={() => choose(item)}>
            <span className="lab-command-title">{item.title}</span>
            {item.subtitle ? <span className="lab-command-subtitle">{item.subtitle}</span> : null}
            {item.shortcut ? <kbd className="lab-command-shortcut">{item.shortcut}</kbd> : null}
          </div>)}
        </div>)}
      </div>
      {!results.length ? <p className="lab-command-empty" role="status">No results</p> : null}
    </> : null}
  </dialog>;
}
```

  The input and the dialog both carry the name "Search". Give the dialog `aria-labelledby` pointing at a visually hidden heading "Search" if that reads better, and keep the test in step with your choice.

  The results' order equals `results` order only if `searchCommands` sorts by kind within equal scores. Grouping can reorder items across scores, so after grouping, renumber: build the flat display order from `groups`, and use display indices for `active`, `aria-activedescendant` and the arrow keys, so the keys follow what is shown. Write the code that way, and add a test where the top-scoring item is a session and an action has a lower score: ArrowDown goes in display order.

  CSS:
  - **Dialog:** centered near the top (`margin: 12vh auto auto`), `width: min(640px, calc(100vw - 32px))`, `max-height: 70vh`, a `--ui-background-elevated` surface, `--ui-radius-sheet` (or the radius tokens that exist), and the overlay shadow token. Give the `::backdrop` a token color (see how `ui.css` styles `.ui-sheet::backdrop`).
  - **Input:** large (`--ui-size-title3` or the nearest token), borderless, with a bottom separator.
  - **Results:** scroll inside the dialog.
  - **Options:** 36px rows, with the active one `[aria-selected="true"]` in `--ui-selection`.
  - **Group titles:** caption size, secondary label color.
  - **Forced colors:** the active option is `Highlight` / `HighlightText`.
- [ ] **Step 4: Run** `npx vitest run src/shell src/ui/stylesheets.test.ts` → PASS.
- [ ] **Step 5: Commit** "feat(lab): add the command palette".

---

### Task 7: ⌘K, the Search button, and the palette's items

**Files:**
- Modify: `src/hooks/useShellShortcuts.ts` (+ its test), `src/shell/SidebarHeader.tsx` (+ its test), `src/App.tsx`, `src/components/BotWorkspace.tsx`.
- Test: an App-level test.

- [ ] **Step 1: Write the failing tests.**
  - **`useShellShortcuts`:** ⌘K (Ctrl+K elsewhere, matched by `code === 'KeyK'` without Alt or Shift) calls `openSearch` and prevents the default. It works while focus is in a text field or the composer, because it's a global search. It is ignored while a dialog is open; the existing guard covers this.
  - **`SidebarHeader`:** with `onSearch`, it renders an IconButton "Search" (icon `search`, `title="Search (⌘K)"`, or "Ctrl+K" on non-Apple systems; use `applePlatform()`) before the actions.
  - **App:**
    - ⌘K opens `dialog[aria-label="Search"]`.
    - Typing the name of another Window and pressing Enter makes that Window current and closes the dialog.
    - Typing "All sessions" and pressing Enter opens `#lab-sessions-page`.
    - In Bot mode, typing a bot's name and pressing Enter selects that bot (its conversation shows).
    - Escape returns focus to where it was.
- [ ] **Step 2: Run**: FAIL.
- [ ] **Step 3: Implement.**
  1. `useShellShortcuts({ toggleSidebar?, setMode, openSearch? })`: handle `!event.altKey && event.code === 'KeyK' && current.current.openSearch`. Update the doc comment.
  2. `SidebarHeader`: add an `onSearch?(): void` prop that renders the Search IconButton first in `.lab-sidebar-header-actions`.
  3. In App, add `const [searchOpen, setSearchOpen] = useState(false)` and render `<CommandPalette open={searchOpen} items={searchOpen ? commandItems : []} onClose={() => setSearchOpen(false)} />` once, outside both modes' roots, so it serves both. Pass `openSearch: () => setSearchOpen(true)` to `useShellShortcuts`, and `onSearch` to the Window `SidebarHeader` and to `BotWorkspace`, which passes it to its `SidebarHeader`.
  4. Build `commandItems` (a `useMemo` while `searchOpen`) from client-side data only:
     - **Actions:**
       - "New session" (`openNewSessionPanel`);
       - "New Window" (`createWindowFromMenu`);
       - "New session view" (Window mode with a shared Window: `sessionWindows.create()`);
       - "All sessions", "Favorites" (if `userScoped`), "Settings" (`openPage(...)`, after `navigation.setMode('window')`);
       - "Show sidebar" / "Hide sidebar" (the same lambda as ⌘\), with `shortcut` "⌘\\" or "Ctrl+\\";
       - "Switch to Bot mode" / "Switch to Window mode" (`navigation.setMode`), with shortcut "⌥⌘2" / "⌥⌘1" or the Ctrl+Alt forms;
       - "All Windows" (`setWindowOverviewOpen(true)` when `windowOverviewAvailable`).
     - **Windows:** the catalog the sidebar shows (`windowWorkspace.windows` ∪ `window`, with `hasWindowAppearance`), in recent-use order (`byRecentUse`). Use the title, with subtitle "N session views". Run: `navigation.setMode('window')`, then `windowWorkspace.open(id)`, then `closePage()`.
     - **Bots:** `botRoster.sections` rows (`App.tsx` computes `botRoster`). Use the title `botDisplayName(row.binding)` and the subtitle = section title. Run: `navigation.select({ kind: 'bot', groupId: row.groupId, viewId: row.viewId })`.
     - **Sessions:** the union of `sessionEntries`, `favorites.stars` and every Window view binding, deduplicated by `sessionKey`. The subtitle is the Host name and provider when known. Run:
       - if a view in the current Window shows that session, select it with the same batch `chooseView` uses (expand, select, scroll);
       - if a view in another Window shows it, open that Window and then select that view;
       - otherwise `navigation.setMode('window')` and `openDirectorySession(item)`, which opens it in the presented view, the same as All sessions.
     - **Mode-specific items:** keep the Bot-mode-only and Window-mode-only items valid in the other mode; each `run` switches mode first.
  5. Add `aria-keyshortcuts="Meta+K"` (or `Control+K`) to the Search buttons.
- [ ] **Step 4: Run** `npx vitest run src/hooks/useShellShortcuts.test.tsx src/shell src/App*.test.tsx src/components/BotWorkspace.test.tsx` and `npx tsc --noEmit -p .`, then rebuild and run the e2e specs `bot-mode`, `modernization`, `window-workspaces` and `sidebar` on chromium-desktop. All must pass.
- [ ] **Step 5: Commit** "feat(lab): open the command palette with ⌘K or the sidebar's Search".

---

### Task 8: Verify the phase

- [ ] **Step 1:** Run, from `packages/agent-remote-lab`:
  - `pnpm --silent typecheck`;
  - `npx tsc --noEmit -p tsconfig.e2e.json`;
  - `pnpm --silent test`, with the sandbox disabled because some server tests need python3 and local sockets. Rerun any failing file alone; known load-only flakes are `App.succession`, `hosted-runtime`, `devbox`, `gateway-state` and `dsh-plugin-package`.
- [ ] **Step 2:** Run `npx vitest run -c vitest.preview.config.ts e2e/ui-primitives.browser.ts`.
- [ ] **Step 3:** Run the chromium-desktop e2e specs touched in Tasks 4 and 7, plus `ask-session`, `session-succession` and `team`, sequentially. All of them passed on main 9b58607f.
- [ ] **Step 4:** Run `pnpm compatibility:update && pnpm compatibility:check` from the worktree root. Commit if the result changed.
- [ ] **Step 5: Local instance.** Use the `prepare-arc-local` skill.
  1. `pnpm local up` in this worktree.
  2. Run `cli-turn.mjs claude` and `session-turn.mjs "Claude Code"`.
  3. Write a headless script at 1440×900 that checks:
     - the toolbar shows the Window name and count;
     - rename in place works;
     - + → New session view adds a view;
     - Hide docks / Show docks work;
     - ⋯ → Copy link shows a toast;
     - ⋯ → Delete Window… confirms and switches Windows (create a spare Window first);
     - with the sidebar hidden, View options sits in the toolbar;
     - ⌘K opens the palette, and typing a Window name + Enter switches;
     - ⌘K in Bot mode selects a bot.
  4. Take screenshots in light and dark mode, plus the palette and the phone layout, which should be unchanged. Read each image.
- [ ] **Step 6:** Record deviations under "Changes made during execution" at the end of this file, and commit.

# UI modernization phase 2a: primitive follow-ups and the shared shell frame

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish what phase 1 left for the primitives, then give Window mode and Bot mode one shell vocabulary: the mode switch and a **+** menu at the top of the sidebar, an Apple-style sidebar, a toolbar above the Bot conversation, ⌘\ to collapse the sidebar and ⌥⌘1 / ⌥⌘2 to switch modes.

**Architecture:** Phase 2 of `docs/superpowers/specs/2026-11-09-ui-modernization-design.md` is split into three plans that each ship on their own: **2a** (this plan: primitive follow-ups and the shell frame), **2b** (the Window-mode toolbar, the Window sidebar content — Windows, In this Window, Shortcuts — and the All sessions page) and **2c** (⌘K search). Each mode keeps its root (`main.lab-shell` for Window mode, `main.lab-bot-workspace` for Bot mode), its state and logic; the "AppShell" of the spec is realised as shared shell parts (`src/shell/`) and the `src/ui/` primitives placed inside those roots. Dozens of Playwright and unit tests pin `#lab-context`, `.lab-main-stage`, `.lab-app-bar`, "View options", "Open sessions", "Workbench mode", "Window mode", "Bot mode", "New section", "Back to bots" and the 1180px compact breakpoint; all of them keep working. The compact breakpoint (1180px) and the Window sidebar width (default 320, 260–560) stay as they are in 2a.

**Tech Stack:** React 18 + TypeScript, plain CSS with the `--ui-*` tokens of `packages/agent-remote-lab/src/ui/tokens.css`, Vitest (jsdom for components, node for stylesheet tests, `vitest.preview.config.ts` + esbuild + Playwright Chromium for `e2e/*.browser.ts`), Playwright e2e.

**Working rules for every task:** work in the worktree `/Volumes/Projects/agent-remote-control/.worktrees/ui-modern-2` (branch `feat/ui-modern-2`); run package commands from `packages/agent-remote-lab` with `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH";`; never `--no-verify`; English in code, comments and commits; end commit messages with a blank line and `Co-Authored-By: Claude <noreply@anthropic.com>`. The guard test `src/ui/stylesheets.test.ts` forbids literal colors outside `tokens.css` (system colors such as `Highlight` inside `@media (forced-colors: active)` are allowed) and undefined variables.

---

## File structure

| File | Responsibility |
|---|---|
| `src/app.css` | The global focus ring reads `--ui-focus-ring` and `--ui-focus-offset`; the Window sidebar uses the sidebar colors |
| `src/ui/ui.css` | Primitive styles: doubled-class Button/IconButton, focus offsets, state colors, forced colors |
| `src/ui/tokens.css`, `src/ui/tokens.test.ts` | New tokens `--ui-accent-hover`, `--ui-failure-on-fill`, `--ui-row-hover` and their contrast checks |
| `src/ui/Button.tsx`, `IconButton.tsx`, `ListRow.tsx` | `forwardRef` |
| `src/ui/SegmentedControl.tsx` | `landmark` option: `<nav>` only when asked, otherwise `role="group"` |
| `src/ui/Menu.tsx` | Its trigger is an `IconButton` |
| `src/ui/Toolbar.tsx` | `className`, `titleRef`, `titleFocusable` |
| `e2e/ui-primitives.browser.ts`, `vitest.preview.config.ts` | A real-browser test of the primitives inside the Lab's containers, coarse pointer and forced colors |
| `src/shell/SidebarHeader.tsx`, `src/shell/shell.css` | The top of either sidebar: mode switch and actions |
| `src/hooks/useShellShortcuts.ts` | ⌘\ and ⌥⌘1 / ⌥⌘2 |
| `src/components/WorkbenchModeSwitch.tsx` | Passes `landmark` |
| `src/components/BotWorkspace.tsx`, `bot-workspace.css`, `BotRoster.tsx` | Bot sidebar header, toolbar, collapsible roster |
| `src/App.tsx` | Window sidebar header and **+** menu, the app bar without the mode switch, shortcuts, the Bot roster collapse state |

---

### Task 1: One focus ring for global rules and primitives

**Files:** Modify `packages/agent-remote-lab/src/app.css` (the global focus block, about lines 86–95), `packages/agent-remote-lab/src/ui/ui.css`; Test `packages/agent-remote-lab/src/ui/stylesheets.test.ts`.

Today the global rule draws `3px solid var(--obs-action)` offset 2px and each primitive draws `3px solid var(--ui-focus-ring)` with its own offset; inside `.agent-remote-surface` the global rule (0,3,1) wins over the primitives, so the ring changes shape and color depending on where a primitive sits. After this task both draw the same ring and only the offset varies, through a custom property.

- [ ] **Step 1: Write the failing test.** Append to `src/ui/stylesheets.test.ts` (it already reads the Lab stylesheets; reuse its helper that returns a file's text — if it has none, read `new URL('../app.css', import.meta.url)` with `readFileSync`):

```ts
it('draws one focus ring: the global rule reads the token and the primitive offset', () => {
  const app = readFileSync(new URL('../app.css', import.meta.url), 'utf8');
  const start = app.indexOf('button:focus-visible,\ninput:focus-visible');
  expect(start, 'the global focus rule').toBeGreaterThanOrEqual(0);
  const body = app.slice(app.indexOf('{', start) + 1, app.indexOf('}', start));
  expect(body).toContain('outline: 3px solid var(--ui-focus-ring);');
  expect(body).toContain('outline-offset: var(--ui-focus-offset, 2px);');
  const ui = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');
  for (const [selector, offset] of [['.ui-button.ui-button {', '1px'], ['.ui-icon-button.ui-icon-button {', '1px'],
    ['.ui-segmented > button[aria-pressed] {', '1px'], ['.ui-list-row.ui-list-row {', '-1px']] as const) {
    const at = ui.indexOf(selector);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    expect(ui.slice(at, ui.indexOf('}', at)), selector).toContain(`--ui-focus-offset: ${offset};`);
  }
});
```

(`readFileSync` is already imported in that file; if not, add `import { readFileSync } from 'node:fs';`.)

- [ ] **Step 2: Run it and see it fail.** `npx vitest run src/ui/stylesheets.test.ts` → FAIL (the global rule still uses `--obs-action`; `.ui-button.ui-button {` does not exist yet — Task 2 adds it, so this test passes only after Task 2; keep it failing for the button selectors until then and commit Task 1 and Task 2 together, see Task 2 Step 5).

- [ ] **Step 3: Change the global rule.** In `src/app.css` replace

```css
  outline: 3px solid var(--obs-action);
  outline-offset: 2px;
}
```

(the body of the block whose selectors start with `button:focus-visible,` and end with `:is(.lab-shell, .lab-session-view) .agent-remote-surface a:focus-visible {`) with

```css
  outline: 3px solid var(--ui-focus-ring);
  outline-offset: var(--ui-focus-offset, 2px);
}
```

- [ ] **Step 4: Primitive offsets.** In `src/ui/ui.css`, inside `.ui-segmented > button[aria-pressed] { … }` add `--ui-focus-offset: 1px;` and change its `:focus-visible` rule to `outline: 3px solid var(--ui-focus-ring); outline-offset: var(--ui-focus-offset);`. Inside `.ui-list-row.ui-list-row { … }` add `--ui-focus-offset: -1px;` and change `.ui-list-row.ui-list-row:focus-visible` to `outline-offset: var(--ui-focus-offset);`. The Button and IconButton rules are rewritten in Task 2.

---

### Task 2: Button and IconButton outrank container rules

**Files:** Modify `packages/agent-remote-lab/src/ui/ui.css` (the header comment and the `.ui-button` / `.ui-icon-button` rules, from `.ui-button {` through the `@media (pointer: coarse)` line before the segmented control comment).

- [ ] **Step 1: Replace the header comment** at the top of `ui.css` with:

```css
/* Primitives of src/ui. Colors come from ui/tokens.css only.
   app.css styles every button through bare `button` rules (0,0,1), container rules such as `.agent-composer button`
   (0,1,1), `button:hover:not(:disabled)` (0,2,1), `button:focus-visible` and `button:disabled` (0,1,1). Every primitive
   root rule therefore doubles its class (0,2,0) and its states reach (0,3,0) or more. A phase that places a primitive
   inside a container with stronger rules (for example `:is(.lab-shell, .lab-session-view) .agent-remote-surface button`,
   (0,2,1)) removes those rules for it. Focus rings read --ui-focus-ring and the primitive's --ui-focus-offset, like
   the global rule in app.css, so whichever rule wins draws the same ring. */
```

- [ ] **Step 2: Replace the Button and IconButton rules** (everything from `.ui-button {` up to and including the line `@media (pointer: coarse) { .ui-icon-button { width: 44px; height: 44px; } .ui-button { min-height: 44px; } }`) with:

```css
.ui-button.ui-button {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 0; min-height: 28px; margin: 0;
  padding: 4px 12px; border: 0; border-radius: var(--ui-radius-control); font: 500 var(--ui-size-callout)/1.2 var(--ui-font);
  cursor: pointer; opacity: 1; transform: none; --ui-focus-offset: 1px;
  transition: background-color var(--ui-duration-short) var(--ui-ease), opacity var(--ui-duration-short) var(--ui-ease);
}
.ui-button.ui-button[data-variant="secondary"] { color: var(--ui-label); background: var(--ui-fill); }
.ui-button.ui-button[data-variant="primary"] { color: var(--ui-on-accent); background: var(--ui-accent); }
.ui-button.ui-button[data-variant="plain"] { color: var(--ui-accent-text); background: transparent; }
.ui-button.ui-button[data-variant="destructive"] { color: var(--ui-failure-on-fill); background: var(--ui-fill); }
.ui-button.ui-button[data-size="small"] { min-height: 22px; padding: 2px 8px; font-size: var(--ui-size-caption); }
.ui-button.ui-button[data-variant="secondary"]:hover:not(:disabled) { color: var(--ui-label); background: var(--ui-fill-strong); }
.ui-button.ui-button[data-variant="primary"]:hover:not(:disabled) { color: var(--ui-on-accent); background: var(--ui-accent-hover); }
.ui-button.ui-button[data-variant="plain"]:hover:not(:disabled) { color: var(--ui-accent-text); background: transparent; text-decoration: underline; }
.ui-button.ui-button[data-variant="destructive"]:hover:not(:disabled) { color: var(--ui-failure-on-fill); background: var(--ui-fill-strong); }
.ui-button.ui-button:disabled { opacity: 0.45; cursor: default; }

.ui-icon-button.ui-icon-button {
  display: inline-grid; place-items: center; width: 28px; height: 28px; min-width: 0; min-height: 28px; margin: 0; padding: 0;
  border: 0; border-radius: var(--ui-radius-control); color: var(--ui-label-secondary); background: transparent; cursor: pointer;
  opacity: 1; transform: none; --ui-focus-offset: 1px;
  transition: background-color var(--ui-duration-short) var(--ui-ease), color var(--ui-duration-short) var(--ui-ease);
}
.ui-icon-button.ui-icon-button:hover:not(:disabled), .ui-icon-button.ui-icon-button[aria-expanded="true"]:not(:disabled) { color: var(--ui-label); background: var(--ui-fill); }
.ui-icon-button.ui-icon-button:disabled { color: var(--ui-label-secondary); background: transparent; opacity: 0.45; cursor: default; }

.ui-button.ui-button:focus-visible, .ui-icon-button.ui-icon-button:focus-visible { outline: 3px solid var(--ui-focus-ring); outline-offset: var(--ui-focus-offset); }
.ui-button.ui-button:active:not(:disabled), .ui-icon-button.ui-icon-button:active:not(:disabled) { transform: none; }
@media (pointer: coarse) {
  .ui-icon-button.ui-icon-button { width: 44px; height: 44px; min-height: 44px; }
  .ui-button.ui-button, .ui-button.ui-button[data-size] { min-height: 44px; }
}
```

`--ui-failure-on-fill` and `--ui-accent-hover` are added in Task 3; until then the stylesheet guard reports them as undefined, so run Task 3 before committing (Step 5).

- [ ] **Step 3: Check the Button and IconButton unit tests still pass.** `npx vitest run src/ui/Button.test.tsx src/ui/Menu.test.tsx` → PASS (class names on the elements did not change).

- [ ] **Step 4: Do Task 3, then come back.**

- [ ] **Step 5: Commit Tasks 1–3 together** after Task 3 Step 5 passes:

```bash
git add packages/agent-remote-lab/src/app.css packages/agent-remote-lab/src/ui
git commit -m "fix(lab): one focus ring, stronger button primitives and readable state colors"
```

---

### Task 3: State colors that pass on fills

**Files:** Modify `packages/agent-remote-lab/src/ui/tokens.css`, `packages/agent-remote-lab/src/ui/tokens.test.ts`, `packages/agent-remote-lab/src/ui/ui.css`.

Measured on phase 1: destructive text on `--ui-fill` 4.22:1 (light) / 3.79:1 (dark); primary hover in dark 3.94:1 (it mixed toward the light label); plain hover on a sidebar fill 4.37:1 / 3.77:1; a ListRow subtitle on a hovered dark sidebar row 3.72:1; the unread dot in dark 2.86:1. The plain hover now underlines instead of filling (Task 2).

- [ ] **Step 1: Write the failing test.** In `tokens.test.ts`, below `mix`, add:

```ts
/** A token such as `rgb(120 120 128 / 0.12)` painted over a #rrggbb surface. */
function over(token: string, surface: string): string {
  const match = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(token);
  if (!match) throw new Error(`${token} is not an rgb(r g b / a) color`);
  const hex = `#${[match[1], match[2], match[3]].map(value => Number(value).toString(16).padStart(2, '0')).join('')}`;
  return mix(hex, surface, Number(match[4]));
}
```

and append a test:

```ts
it.each([['light', light], ['dark', dark]] as const)('keeps %s state colors readable on their fills', (_appearance, tokens) => {
  const t = (name: string) => tokens.get(name)!;
  expect(contrast(t('--ui-on-accent'), t('--ui-accent-hover')), 'primary hover').toBeGreaterThanOrEqual(4.5);
  for (const surface of ['--ui-background', '--ui-background-grouped', '--ui-background-elevated', '--ui-sidebar']) {
    for (const fill of ['--ui-fill', '--ui-fill-strong']) {
      expect(contrast(t('--ui-failure-on-fill'), over(t(fill), t(surface))), `destructive on ${fill} over ${surface}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t('--ui-label'), over(t(fill), t(surface))), `label on ${fill} over ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  }
  const hoveredRow = over(t('--ui-row-hover'), t('--ui-sidebar'));
  expect(contrast(t('--ui-label'), hoveredRow), 'row title on a hovered row').toBeGreaterThanOrEqual(4.5);
  expect(contrast(t('--ui-label-secondary'), hoveredRow), 'row subtitle on a hovered row').toBeGreaterThanOrEqual(4.5);
  for (const surface of ['--ui-sidebar', '--ui-background', '--ui-selection']) {
    expect(contrast(t('--ui-accent-text'), t(surface)), `unread dot on ${surface}`).toBeGreaterThanOrEqual(3);
  }
});
```

- [ ] **Step 2: Run it and see it fail.** `npx vitest run src/ui/tokens.test.ts` → FAIL (`--ui-accent-hover` is undefined).

- [ ] **Step 3: Add the tokens.** In the light `:root` block of `tokens.css`, after `--ui-accent-text`, add:

```css
  --ui-accent-hover: #0064c8; /* Primary buttons under the pointer: the accent moved toward black */
  --ui-failure-on-fill: #b8000e; /* Destructive text on a gray fill */
  --ui-row-hover: rgb(120 120 128 / 0.12); /* A hovered sidebar or list row */
```

and in the dark block, after its `--ui-accent-text`:

```css
    --ui-accent-hover: #0064c8;
    --ui-failure-on-fill: #ffa39e;
    --ui-row-hover: rgb(118 118 128 / 0.06);
```

If a pair still fails, move that token's value the least needed (darker in light, lighter in dark; for `--ui-row-hover` lower the alpha) until the test passes, and list the change in your report.

- [ ] **Step 4: Use them.** In `ui.css`: change `.ui-list-row.ui-list-row:hover:not(:disabled) { color: var(--ui-label); background: var(--ui-fill); }` to use `background: var(--ui-row-hover);`, and `.ui-status[data-kind="unread"] { … background: var(--ui-accent); }` to `background: var(--ui-accent-text);`.

- [ ] **Step 5: Run.** `npx vitest run src/ui` → PASS (including Task 1's test). Then commit Tasks 1–3 as in Task 2 Step 5.

---

### Task 4: Forced colors for the remaining primitives

**Files:** Modify `packages/agent-remote-lab/src/ui/ui.css` (append at the end).

- [ ] **Step 1: Append:**

```css
/* Forced colors drop fills and shadows: buttons keep an edge, the chosen segment and the current row stay highlighted,
   and badges keep their shape. */
@media (forced-colors: active) {
  .ui-button.ui-button, .ui-icon-button.ui-icon-button, .ui-segmented { border: 1px solid ButtonText; }
  .ui-segmented > button[aria-pressed="true"], .ui-segmented > button[aria-pressed="true"]:hover:not(:disabled),
  .ui-list-row.ui-list-row[aria-current="true"], .ui-list-row.ui-list-row[aria-current="true"]:hover:not(:disabled) {
    forced-color-adjust: none; color: HighlightText; background: Highlight;
  }
  .ui-status[data-kind="unread"] { forced-color-adjust: none; background: CanvasText; }
  .ui-status[data-kind="attention"], .ui-status[data-kind="failed"] { border: 1px solid CanvasText; }
  .ui-status[data-kind="working"] { border-color: CanvasText; border-top-color: Highlight; }
}
```

- [ ] **Step 2: Run** `npx vitest run src/ui/stylesheets.test.ts` → PASS. The browser test in Task 6 checks the result.

- [ ] **Step 3: Commit.**

```bash
git add packages/agent-remote-lab/src/ui/ui.css
git commit -m "fix(lab): keep primitive states visible in forced colors"
```

---

### Task 5: Refs, a non-landmark segmented control, and the menu trigger

**Files:** Modify `packages/agent-remote-lab/src/ui/Button.tsx`, `IconButton.tsx`, `ListRow.tsx`, `SegmentedControl.tsx`, `Menu.tsx`, `src/components/WorkbenchModeSwitch.tsx`; Test `src/ui/Button.test.tsx`, `src/ui/SegmentedControl.test.tsx`, `src/ui/ListRow.test.tsx`.

- [ ] **Step 1: Write the failing tests.** Append to `src/ui/Button.test.tsx`:

```tsx
it('forwards refs to the button element', async () => {
  const button = createRef<HTMLButtonElement>(), icon = createRef<HTMLButtonElement>();
  await render(<><Button ref={button}>Save</Button><IconButton ref={icon} icon="gear" label="Settings" /></>);
  expect(button.current?.textContent).toBe('Save');
  expect(icon.current?.getAttribute('aria-label')).toBe('Settings');
});
```

(add `createRef` to its `react` import and make sure `IconButton` is imported from `./IconButton.js`).

Append to `src/ui/ListRow.test.tsx`:

```tsx
it('forwards its ref to the row button', async () => {
  const row = createRef<HTMLButtonElement>();
  await render(<ListRow ref={row} title="Pinned" />);
  expect(row.current?.className).toBe('ui-list-row');
});
```

(add `import { createRef } from 'react';` next to the existing `act` import).

In `src/ui/SegmentedControl.test.tsx`, change line 15 `expect(container.querySelector('nav')?.getAttribute('aria-label')).toBe('Mode');` to

```tsx
  expect(container.querySelector('nav')).toBeNull();
  expect(container.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Mode');
```

(the Workbench mode test at lines 76–77 keeps expecting a `nav`).

- [ ] **Step 2: Run** `npx vitest run src/ui/Button.test.tsx src/ui/ListRow.test.tsx src/ui/SegmentedControl.test.tsx` → FAIL (refs are not forwarded; the segmented control is a `nav`).

- [ ] **Step 3: Implement.**

`src/ui/Button.tsx`:

```tsx
import { forwardRef, type ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'plain' | 'destructive';
export type ButtonSize = 'regular' | 'small';

/** A button that never submits a form unless asked: primary for the main action, secondary by default, plain for text-like actions. */
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }>(
  function Button({ variant = 'secondary', size = 'regular', className, type = 'button', ...props }, ref) {
    return <button {...props} ref={ref} type={type} className={className ? `ui-button ${className}` : 'ui-button'} data-variant={variant} data-size={size} />;
  });
```

`src/ui/IconButton.tsx`:

```tsx
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from './Icon.js';

/** An icon-only button; its label is its accessible name and tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> & { icon: IconName; label: string }>(
  function IconButton({ icon, label, className, type = 'button', title, ...props }, ref) {
    return <button {...props} ref={ref} type={type} className={className ? `ui-icon-button ${className}` : 'ui-icon-button'} aria-label={label} title={title ?? label}>
      <Icon name={icon} />
    </button>;
  });
```

`src/ui/ListRow.tsx`: wrap the existing function in `forwardRef<HTMLButtonElement, …props type…>(function ListRow({ … }, ref) { … })`, add `ref={ref}` to the `<button>` after `{...props}` (before `type`), and change the import to `import { forwardRef, useId } from 'react';`. Keep the JSDoc above the `export const ListRow =` line.

`src/ui/SegmentedControl.tsx`: add `landmark?: boolean` to the props (document it in the JSDoc: "A `landmark` control is a `<nav>`, for navigation between places such as the workbench modes; otherwise it is a `role="group"`."), destructure `landmark = false`, and render the root as

```tsx
  const Root = landmark ? 'nav' : 'div';
  return <Root className={className ? `ui-segmented ${className}` : 'ui-segmented'} role={landmark ? undefined : 'group'} aria-label={label}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(undefined); }}>
    …the same buttons…
  </Root>;
```

`src/components/WorkbenchModeSwitch.tsx`: pass `landmark` to `SegmentedControl`.

`src/ui/Menu.tsx`: replace the trigger `<button ref={button} type="button" className="ui-icon-button" aria-label={label} title={label} aria-haspopup="menu" … > <Icon name={icon} /> </button>` with

```tsx
    <IconButton ref={button} icon={icon} label={label} aria-haspopup="menu"
      aria-expanded={Boolean(open)} aria-controls={open ? id : undefined} onClick={event => toggle(event.detail)}
      onKeyDown={event => {
        if (open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
        event.preventDefault();
        show(event.key === 'ArrowDown' ? 'first' : 'last');
      }} />
```

and add `import { IconButton } from './IconButton.js';` (keep the `Icon` import: menu items still use it).

- [ ] **Step 4: Run** `npx vitest run src/ui src/components/WorkbenchModeSwitch.test.tsx` (skip the second path if it does not exist) and `npx tsc --noEmit -p .` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-lab/src/ui packages/agent-remote-lab/src/components/WorkbenchModeSwitch.tsx
git commit -m "feat(lab): forward primitive refs, render segmented groups outside navigation, reuse IconButton for menus"
```

---

### Task 6: A browser test of the primitives in the Lab's containers

**Files:** Create `packages/agent-remote-lab/e2e/ui-primitives.browser.ts`; Modify `packages/agent-remote-lab/vitest.preview.config.ts` (add the file to `include`).

- [ ] **Step 1: Write the test.**

```ts
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let script = '', css = '', url = '', browser: Browser;
const server = createServer((request, response) => {
  response.setHeader('content-type', request.url === '/fixture.js' ? 'application/javascript' : 'text/html; charset=utf-8');
  response.end(request.url === '/fixture.js' ? script
    : `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`);
});

beforeAll(async () => {
  // Every primitive, inside the containers whose button rules are strongest today.
  const source = `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import './session-view-styles.ts';
    import { Button } from './ui/Button.tsx'; import { IconButton } from './ui/IconButton.tsx';
    import { SegmentedControl } from './ui/SegmentedControl.tsx'; import { ListRow } from './ui/ListRow.tsx';
    import { StatusBadge } from './ui/StatusBadge.tsx';
    const set = <>
      <Button data-test="secondary">Secondary</Button><Button data-test="primary" variant="primary">Primary</Button>
      <Button data-test="small" size="small">Small</Button><IconButton data-test="icon" icon="gear" label="Settings" />
      <SegmentedControl label="Mode" value="a" onChange={() => {}} options={[{ value: 'a', label: 'One' }, { value: 'b', label: 'Two' }]} />
      <ListRow data-test="row" title="Current" selected /><StatusBadge status={{ kind: 'unread' }} />
    </>;
    createRoot(document.getElementById('root')).render(<>
      <div id="plain">{set}</div>
      <main className="lab-shell" style={{ display: 'block' }}><div className="agent-remote-surface"><div className="agent-composer" id="contained">{set}</div></div></main>
    </>);`;
  const bundle = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) }, bundle: true, write: false,
    outfile: 'fixture.js', loader: { '.woff2': 'dataurl' }, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
  script = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); });

const styles = (page: Page, scope: string, test: string) => page.$eval(`${scope} [data-test="${test}"]`, element => {
  const s = getComputedStyle(element);
  return { padding: s.padding, border: s.borderTopWidth, minHeight: s.minHeight, width: s.width, background: s.backgroundColor };
});

it('renders primitives the same inside the Lab containers as on their own', async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(url); await page.locator('#contained [data-test="icon"]').waitFor();
  for (const test of ['secondary', 'primary', 'small', 'icon', 'row']) expect(await styles(page, '#contained', test), test).toEqual(await styles(page, '#plain', test));
  await page.keyboard.press('Tab');
  await page.locator('#contained [data-test="secondary"]').focus();
  const ring = await page.$eval('#contained [data-test="secondary"]', element => [getComputedStyle(element).outlineWidth, getComputedStyle(element).outlineOffset]);
  expect(ring).toEqual(['3px', '1px']);
  await page.close();
});

it('keeps 44px touch targets in the containers', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage(); await page.goto(url); await page.locator('#contained [data-test="icon"]').waitFor();
  for (const test of ['secondary', 'small', 'icon']) {
    const box = await page.locator(`#contained [data-test="${test}"]`).boundingBox();
    expect(box!.height, test).toBeGreaterThanOrEqual(44);
  }
  await context.close();
});

it('keeps the chosen segment, the current row and the unread dot visible in forced colors', async () => {
  const page = await browser.newPage({ forcedColors: 'active' });
  await page.goto(url); await page.locator('#plain [data-test="row"]').waitFor();
  const colors = await page.evaluate(() => {
    const bg = (selector: string) => getComputedStyle(document.querySelector(selector)!).backgroundColor;
    return { pressed: bg('#plain [aria-pressed="true"]'), unpressed: bg('#plain [aria-pressed="false"]'), row: bg('#plain [data-test="row"]'),
      canvas: getComputedStyle(document.body).backgroundColor, dot: bg('#plain .ui-status[data-kind="unread"]') };
  });
  expect(colors.pressed).not.toBe(colors.unpressed);
  expect(colors.row).not.toBe(colors.canvas);
  expect(colors.dot).not.toBe(colors.canvas);
  await page.close();
});
```

- [ ] **Step 2: Register and run it.** Add `'e2e/ui-primitives.browser.ts'` to the `include` array of `vitest.preview.config.ts`, then `npx vitest run -c vitest.preview.config.ts e2e/ui-primitives.browser.ts` → PASS. If an assertion fails, find the CSS rule responsible (container rules in `app.css` or the shared `agent-remote-web` styles) and fix the primitive's rule in `ui.css` — do not loosen the assertion. If the forced-colors assertions fail because Chromium's emulation leaves the colors equal, inspect the computed values and report them.

- [ ] **Step 3: Commit.**

```bash
git add packages/agent-remote-lab/e2e/ui-primitives.browser.ts packages/agent-remote-lab/vitest.preview.config.ts packages/agent-remote-lab/src/ui/ui.css
git commit -m "test(lab): check the primitives inside the Lab containers, on touch and in forced colors"
```

---

### Task 7: Toolbar options for focusable headings

**Files:** Modify `packages/agent-remote-lab/src/ui/Toolbar.tsx`; Test `packages/agent-remote-lab/src/ui/Toolbar.test.tsx`.

- [ ] **Step 1: Write the failing test.** Append to `Toolbar.test.tsx`:

```tsx
it('can carry a class and a focusable heading for its owner', async () => {
  const heading = createRef<HTMLHeadingElement>();
  const container = await render(<Toolbar className="lab-bot-conversation-toolbar" title="API caching" titleRef={heading} titleFocusable />);
  expect(container.querySelector('header')?.className).toBe('ui-toolbar lab-bot-conversation-toolbar');
  expect(heading.current?.textContent).toBe('API caching');
  expect(heading.current?.tabIndex).toBe(-1);
});
```

(add `import { createRef } from 'react';`).

- [ ] **Step 2: Run** `npx vitest run src/ui/Toolbar.test.tsx` → FAIL.

- [ ] **Step 3: Implement** `Toolbar.tsx`:

```tsx
import type { ReactNode, Ref } from 'react';

/** The 52px bar above content: the current object (picture, title heading, subtitle) and its actions. Place it inside the app's main region (outside it a header becomes a banner landmark); `title` is phrasing content, such as text or inline elements. A `titleFocusable` heading can take focus from script (tabIndex -1), for owners that move focus to it. */
export function Toolbar({ leading, title, subtitle, trailing, className, titleRef, titleFocusable }: {
  leading?: ReactNode; title: ReactNode; subtitle?: ReactNode; trailing?: ReactNode; className?: string;
  titleRef?: Ref<HTMLHeadingElement>; titleFocusable?: boolean;
}) {
  return <header className={className ? `ui-toolbar ${className}` : 'ui-toolbar'}>
    {leading ? <span className="ui-toolbar-leading">{leading}</span> : null}
    <div className="ui-toolbar-heading">
      <h2 ref={titleRef} className="ui-toolbar-title" tabIndex={titleFocusable ? -1 : undefined}>{title}</h2>
      {subtitle ? <div className="ui-toolbar-subtitle">{subtitle}</div> : null}
    </div>
    {trailing ? <div className="ui-toolbar-trailing">{trailing}</div> : null}
  </header>;
}
```

In `ui.css`, add `gap: 6px;` to `.ui-toolbar-leading` and `.ui-toolbar-title:focus { outline: none; }` after the `.ui-toolbar-title` rule (the heading takes focus only from script, as the Bot conversation heading does today).

- [ ] **Step 4: Run** `npx vitest run src/ui/Toolbar.test.tsx src/ui/stylesheets.test.ts` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-lab/src/ui/Toolbar.tsx packages/agent-remote-lab/src/ui/Toolbar.test.tsx packages/agent-remote-lab/src/ui/ui.css
git commit -m "feat(lab): let a toolbar carry a class and a focusable heading"
```

---

### Task 8: The sidebar header and the shell shortcuts

**Files:** Create `packages/agent-remote-lab/src/shell/SidebarHeader.tsx`, `src/shell/shell.css`, `src/shell/SidebarHeader.test.tsx`, `src/hooks/useShellShortcuts.ts`, `src/hooks/useShellShortcuts.test.tsx`.

- [ ] **Step 1: Write the failing tests.**

`src/shell/SidebarHeader.test.tsx`:

```tsx
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { SidebarHeader } from './SidebarHeader.js';

it('puts the mode switch first and the actions after it', async () => {
  const onModeChange = vi.fn();
  const container = await render(<SidebarHeader mode="window" onModeChange={onModeChange} actions={<button type="button">New section</button>} />);
  const header = container.querySelector('.lab-sidebar-header')!;
  expect([...header.children].map(child => child.className)).toEqual(['ui-segmented lab-workbench-mode', 'lab-sidebar-header-actions']);
  expect(header.querySelector('nav[aria-label="Workbench mode"] [aria-pressed="true"]')?.textContent).toBe('Window mode');
  await act(async () => (header.querySelector('nav [aria-pressed="false"]') as HTMLButtonElement).click());
  expect(onModeChange).toHaveBeenCalledWith('bot');
  expect(header.querySelector('.lab-sidebar-header-actions button')?.textContent).toBe('New section');
});
```

`src/hooks/useShellShortcuts.test.tsx`:

```tsx
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { useShellShortcuts } from './useShellShortcuts.js';

const platform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
afterEach(() => { if (platform) Object.defineProperty(Navigator.prototype, 'platform', platform); });
const onPlatform = (value: string) => Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => value });
const press = (init: KeyboardEventInit) => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });

function Harness(props: Parameters<typeof useShellShortcuts>[0]) { useShellShortcuts(props); return null; }

it('toggles the sidebar with Command-Backslash and switches modes with Option-Command-1 and 2 on Apple platforms', async () => {
  onPlatform('MacIntel');
  const toggleSidebar = vi.fn(), setMode = vi.fn();
  await render(<Harness toggleSidebar={toggleSidebar} setMode={setMode} />);
  await press({ key: '\\', code: 'Backslash', metaKey: true });
  await press({ key: '¡', code: 'Digit1', metaKey: true, altKey: true });
  await press({ key: '™', code: 'Digit2', metaKey: true, altKey: true });
  expect(toggleSidebar).toHaveBeenCalledOnce();
  expect(setMode.mock.calls).toEqual([['window'], ['bot']]);
  await press({ key: '\\', code: 'Backslash', ctrlKey: true });
  await press({ key: '1', code: 'Digit1', metaKey: true });
  expect(toggleSidebar).toHaveBeenCalledOnce();
  expect(setMode).toHaveBeenCalledTimes(2);
});

it('uses Control elsewhere, ignores AltGraph and events already handled, and works without a sidebar', async () => {
  onPlatform('Win32');
  const setMode = vi.fn();
  await render(<Harness setMode={setMode} />);
  await press({ key: '\\', code: 'Backslash', ctrlKey: true });
  await press({ key: '1', code: 'Digit1', ctrlKey: true, altKey: true });
  expect(setMode).toHaveBeenCalledWith('window');
  await act(async () => {
    const event = new KeyboardEvent('keydown', { key: '2', code: 'Digit2', ctrlKey: true, altKey: true, cancelable: true });
    Object.defineProperty(event, 'getModifierState', { value: (key: string) => key === 'AltGraph' });
    window.dispatchEvent(event);
  });
  await act(async () => {
    const event = new KeyboardEvent('keydown', { key: '2', code: 'Digit2', ctrlKey: true, altKey: true, cancelable: true });
    event.preventDefault(); window.dispatchEvent(event);
  });
  expect(setMode).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run** `npx vitest run src/shell src/hooks/useShellShortcuts.test.tsx` → FAIL (modules missing).

- [ ] **Step 3: Implement.**

`src/shell/SidebarHeader.tsx`:

```tsx
import type { ReactNode } from 'react';
import type { WorkbenchMode } from '../workbench-mode.js';
import { WorkbenchModeSwitch } from '../components/WorkbenchModeSwitch.js';
import './shell.css';

/** The top of either mode's sidebar: the Window / Bot mode switch, then the mode's actions (its + menu or button). */
export function SidebarHeader({ mode, onModeChange, actions }: { mode: WorkbenchMode; onModeChange(mode: WorkbenchMode): void; actions?: ReactNode }) {
  return <div className="lab-sidebar-header">
    <WorkbenchModeSwitch mode={mode} onChange={onModeChange} />
    <div className="lab-sidebar-header-actions">{actions}</div>
  </div>;
}
```

`src/shell/shell.css`:

```css
/* Shell parts shared by Window mode and Bot mode. */
.lab-sidebar-header { display: flex; align-items: center; gap: 6px; padding: 10px 8px 8px 10px; }
.lab-sidebar-header > .lab-workbench-mode { flex: 1; min-width: 0; }
.lab-sidebar-header-actions { display: flex; flex: none; align-items: center; gap: 2px; }
.lab-sidebar-header-actions:empty { display: none; }
```

`src/hooks/useShellShortcuts.ts`:

```ts
import { useEffect, useRef } from 'react';
import type { WorkbenchMode } from '../workbench-mode.js';

const apple = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/**
 * Shell shortcuts that browsers leave free: Command-Backslash (Control elsewhere) shows or hides the sidebar, and
 * Option-Command-1 / 2 (Control-Alt elsewhere) choose Window mode and Bot mode in the order of the mode switch.
 * Keys are matched by `code`, since Option changes `key` on Apple keyboards; AltGraph combinations type characters
 * on many layouts and are left alone.
 */
export function useShellShortcuts(actions: { toggleSidebar?(): void; setMode(mode: WorkbenchMode): void }) {
  const current = useRef(actions); current.current = actions;
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.getModifierState?.('AltGraph')) return;
      const primary = apple() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!primary || event.shiftKey) return;
      if (!event.altKey && event.code === 'Backslash' && current.current.toggleSidebar) {
        event.preventDefault(); current.current.toggleSidebar();
      } else if (event.altKey && (event.code === 'Digit1' || event.code === 'Digit2')) {
        event.preventDefault(); current.current.setMode(event.code === 'Digit1' ? 'window' : 'bot');
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);
}
```

- [ ] **Step 4: Run** `npx vitest run src/shell src/hooks/useShellShortcuts.test.tsx src/ui/stylesheets.test.ts` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-lab/src/shell packages/agent-remote-lab/src/hooks/useShellShortcuts.ts packages/agent-remote-lab/src/hooks/useShellShortcuts.test.tsx
git commit -m "feat(lab): add the shared sidebar header and the shell shortcuts"
```

---

### Task 9: Window mode: the sidebar header and the + menu

**Files:** Modify `packages/agent-remote-lab/src/App.tsx`; Test `packages/agent-remote-lab/src/App.bot-mode.test.tsx`.

- [ ] **Step 1: Write the failing test.** Append to `src/App.bot-mode.test.tsx` (it already imports `act`, `botGroup`, `mountBotApp`, `seedGroup`, `until`):

```tsx
it('puts the mode switch and the New menu at the top of the Window sidebar, not in the app bar', async () => {
  const scope = 'http://localhost/sidebar-header/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  await until(() => expect(app.container.querySelector('#lab-context .lab-sidebar-header')).not.toBeNull());
  const header = app.container.querySelector('#lab-context .lab-sidebar-header')!;
  expect(header.querySelector('nav[aria-label="Workbench mode"] [aria-pressed="true"]')?.textContent).toBe('Window mode');
  expect(app.container.querySelector('.lab-app-bar nav[aria-label="Workbench mode"]')).toBeNull();
  await act(async () => (header.querySelector('button[aria-label="New"]') as HTMLButtonElement).click());
  expect([...document.querySelectorAll('[role="menu"][aria-label="New"] [role="menuitem"]')].map(item => item.textContent)).toEqual(['New session', 'New Window']);
  await act(async () => (document.querySelector('[role="menu"][aria-label="New"] [role="menuitem"]') as HTMLElement).click());
  expect(app.container.querySelector('.lab-sidebar-new')?.getAttribute('aria-pressed')).toBe('true');
  await app.close();
});
```

- [ ] **Step 2: Run** `npx vitest run src/App.bot-mode.test.tsx -t "top of the Window sidebar"` → FAIL.

- [ ] **Step 3: Implement in `App.tsx`.**
  1. Imports: `import { SidebarHeader } from './shell/SidebarHeader.js';` and `import { Menu } from './ui/Menu.js';`.
  2. Remove the line `      <WorkbenchModeSwitch mode={navigation.mode} onChange={navigation.setMode} />` that is the first child of `<header className="lab-app-bar" …>` (keep the other `WorkbenchModeSwitch` uses: the recovery view and View options' `modeControls`).
  3. Inside `<SupportingRail id="lab-context" …>`, directly before `<div className="lab-rail-heading">`, insert:

```tsx
      {!compactLayout ? <SidebarHeader mode={navigation.mode} onModeChange={navigation.setMode} actions={<Menu label="New" icon="plus" items={[
        { label: 'New session', onSelect: () => { setActiveView('workbench'); setSessionPanel('new'); setDesktopContextVisible(true); } },
        { label: 'New Window', onSelect: () => {
          void windowWorkspace.create().catch((error: unknown) => toast?.show('new-window', 'Window not created', error instanceof Error ? error.message : String(error), 'error'));
        } },
      ]} />} /> : null}
```

  (`toast` is the `useToast(windowMode)` value defined near the top of `AppContent`; `windowWorkspace.create` is the function `WindowWorkspaces` calls for its "New Window" button. If TypeScript reports a different name or signature, use what `WindowWorkspaces.tsx` line ~103 uses.)

- [ ] **Step 4: Run** `npx vitest run src/App.bot-mode.test.tsx src/App.test.tsx` and `npx tsc --noEmit -p .` → PASS. If an existing test looked for the mode switch in the app bar, it now finds it in the sidebar or View options; update only a selector that names `.lab-app-bar` for the switch, and list it in your report.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-lab/src/App.tsx packages/agent-remote-lab/src/App.bot-mode.test.tsx
git commit -m "feat(lab): move the mode switch to the top of the Window sidebar with a New menu"
```

---

### Task 10: Bot mode: sidebar header, toolbar, collapsible roster, shortcuts

**Files:** Modify `packages/agent-remote-lab/src/components/BotWorkspace.tsx`, `src/components/bot-workspace.css`, `src/components/BotRoster.tsx`, `src/App.tsx`; Test `src/components/BotWorkspace.test.tsx`, `src/components/BotRoster.test.tsx` (if it passes `onNewSection`).

- [ ] **Step 1: Write the failing test.** Append to `src/components/BotWorkspace.test.tsx` (it mounts the whole App with `mountBotApp`, so the collapse state kept in `App` is covered too; on desktop `matchMedia` is not stubbed, so the layout is not compact):

```tsx
it('shows the shared sidebar header, a toolbar above the conversation, and collapses the roster', async () => {
  const scope = 'http://localhost/bot-shell-frame/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?mode=bot&section=A&bot=A1');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).not.toBeNull());
    const roster = app.container.querySelector<HTMLElement>('.lab-bot-roster')!;
    expect(roster.querySelector('.lab-sidebar-header nav[aria-label="Workbench mode"] [aria-pressed="true"]')?.textContent).toBe('Bot mode');
    expect(roster.querySelector('.lab-sidebar-header-actions button[aria-label="New section"]')).not.toBeNull();
    expect(app.container.querySelector('header.ui-toolbar.lab-bot-conversation-toolbar h2.ui-toolbar-title')).not.toBeNull();
    await act(async () => app.button('Hide sidebar').click());
    expect(roster.hidden).toBe(true);
    expect(app.container.querySelector('.lab-bot-workspace')?.hasAttribute('data-roster-collapsed')).toBe(true);
    await act(async () => app.button('Show sidebar').click());
    expect(roster.hidden).toBe(false);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', ctrlKey: !/Mac/.test(navigator.platform), metaKey: /Mac/.test(navigator.platform), bubbles: true, cancelable: true })); });
    expect(roster.hidden).toBe(true);
  } finally { await app.close(); }
});
```

The existing test 'creates an empty section only after Save…' clicks `app.button('New section')`; after this task that finds the icon button by its accessible name, so it keeps working unchanged. In `src/components/BotRoster.test.tsx` line 13, drop `onNewSection={() => {}}`.

- [ ] **Step 2: Run** `npx vitest run src/components/BotWorkspace.test.tsx` → FAIL.

- [ ] **Step 3: Implement.**

`BotRoster.tsx`: remove the `onNewSection` prop from the props type and the destructuring, and remove `<div className="lab-bot-roster-actions"><button type="button" onClick={onNewSection}>New section</button></div>`. Update any test that passed `onNewSection`.

`BotWorkspace.tsx`:
  - props: add `rosterCollapsed: boolean; onToggleRoster(): void;` to `BotWorkspaceProps` and the destructuring.
  - imports: `SidebarHeader` from `../shell/SidebarHeader.js`, `Toolbar` from `../ui/Toolbar.js`, `IconButton` from `../ui/IconButton.js`, `Button` from `../ui/Button.js`; keep `WorkbenchModeSwitch` (the compact toolbar still uses it).
  - add `const startSection = () => { setCreating(true); setError(undefined); };` and use it where `onNewSection` was passed.
  - root `<main …>`: add `data-roster-collapsed={!compact && rosterCollapsed || undefined}`.
  - `<aside className="lab-bot-roster" hidden={compact && showConversation}>` → `hidden={(compact && showConversation) || (!compact && rosterCollapsed)}`.
  - roster heading:

```tsx
      <header className="lab-bot-roster-heading"><h1>Bots</h1>
        <SidebarHeader mode={navigation.mode} onModeChange={navigation.setMode} actions={<IconButton icon="plus" label="New section" onClick={startSection} />} />
      </header>
```

  - `<BotRoster … onNewSection={…} …>`: drop the prop.
  - conversation header: replace the whole `<header className="lab-bot-conversation-toolbar"> … </header>` with

```tsx
      <Toolbar className="lab-bot-conversation-toolbar" titleRef={heading} titleFocusable
        leading={compact ? <Button variant="plain" aria-label="Back to bots" onClick={back}>Back</Button>
          : <IconButton icon="sidebar" label={rosterCollapsed ? 'Show sidebar' : 'Hide sidebar'} aria-expanded={!rosterCollapsed} onClick={onToggleRoster} />}
        title={place?.kind === 'session' ? place.session.title : selected.view?.binding.title ?? descriptor?.props.target.title ?? selected.group?.window.title ?? 'Choose a bot'}
        trailing={compact ? <WorkbenchModeSwitch mode={navigation.mode} onChange={navigation.setMode} /> : undefined} />
```

  (`heading` stays `useRef<HTMLHeadingElement>(null)`.)

`bot-workspace.css`:
  - `.lab-bot-workspace`: `background: var(--ui-background); color: var(--ui-label);` instead of `--obs-canvas` / `--obs-text`.
  - `.lab-bot-roster { overflow: auto; background: var(--ui-sidebar); border-right: 1px solid var(--ui-separator); }`
  - `.lab-bot-roster-heading { padding: 0; border-bottom: 0; }` and replace `.lab-bot-roster-heading h1 { … }` with
    `.lab-bot-roster-heading h1 { margin: 12px 12px 0; font: 700 var(--ui-size-large-title)/1.15 var(--ui-font); }` plus
    `.lab-bot-workspace:not([data-compact]) .lab-bot-roster-heading h1 { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }` (a large "Bots" title on phones only, as the spec's navigation stack; the heading stays for assistive technology on desktop).
  - remove the two rules `.lab-bot-conversation-toolbar { … }` and `.lab-bot-conversation-toolbar h2 { … }` (the toolbar primitive styles it now) and the `.lab-bot-roster-actions` selector from the shared padding rule.
  - add `.lab-bot-workspace[data-roster-collapsed] { grid-template-columns: minmax(0, 1fr); }`.

`App.tsx`:
  - near the other shell state (`headerHidden`, `desktopContextVisible`), add `const [botRosterCollapsed, setBotRosterCollapsed] = useState(false);`.
  - pass `rosterCollapsed={botRosterCollapsed} onToggleRoster={() => setBotRosterCollapsed(value => !value)}` to `<BotWorkspace …/>`.
  - import `useShellShortcuts` from `./hooks/useShellShortcuts.js` and call it in `AppContent` after `compactLayout` and `windowMode` are known:

```tsx
  useShellShortcuts({
    setMode: navigation.setMode,
    toggleSidebar: compactLayout ? undefined : windowMode ? () => setDesktopContextVisible(value => !value) : () => setBotRosterCollapsed(value => !value),
  });
```

- [ ] **Step 4: Run** `npx vitest run src/components/BotWorkspace.test.tsx src/components/BotRoster.test.tsx src/App.bot-mode.test.tsx src/App.test.tsx src/ui src/shell` and `npx tsc --noEmit -p .` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-lab/src
git commit -m "feat(lab): give Bot mode the shared sidebar header, a toolbar and a collapsible roster, with shell shortcuts"
```

---

### Task 11: Sidebar appearance in Window mode

**Files:** Modify `packages/agent-remote-lab/src/app.css`.

- [ ] **Step 1: Restyle the desktop sidebar.** In `app.css`:
  - `.lab-context-rail { border-right: 1px solid var(--obs-border); … }` (about line 286) → `border-right: 1px solid var(--ui-separator);`, and add `background: var(--ui-sidebar);` to the rule inside `@media (min-width: 1181px)` that sets `.lab-context-rail { display: flex; flex-direction: column; … }` (about line 299).
  - the sticky heading `… .lab-context-rail > .lab-rail-heading { position: sticky; … background: var(--obs-surface); }` (about line 910) → `background: var(--ui-sidebar);`.
  - keep the compact (≤1180px) rail as it is: it is the "Sessions & Hosts" sheet, white like other sheets.
  Inputs, selects and the session directory inside the rail keep their own backgrounds; check them in step 2.

- [ ] **Step 2: Look at it.** `pnpm local up` in the worktree (see the `prepare-arc-local` skill; the instance is new for this worktree), then screenshot `/?mode=window` and `/?mode=bot` at 1440×900 in light and dark and read the images: the Window sidebar and the Bot roster share the gray sidebar color, the mode switch and **+** sit at the top of both, the Bot conversation is white with the toolbar above it, controls inside the sidebar stay readable. Fix any control that blends into the gray (for example a white select on gray is fine; a gray-on-gray button is not) with tokens only.

- [ ] **Step 3: Run** `npx vitest run src/ui/stylesheets.test.ts` → PASS, and commit:

```bash
git add packages/agent-remote-lab/src/app.css
git commit -m "feat(lab): give the Window sidebar the sidebar colors"
```

---

### Task 12: Verify the phase

- [ ] **Step 1:** From `packages/agent-remote-lab`: `pnpm --silent typecheck` and `pnpm --silent test` (the full unit suite; a failure that passes when its file runs alone is a load flake — rerun it alone and say so).
- [ ] **Step 2:** `npx vitest run -c vitest.preview.config.ts e2e/ui-primitives.browser.ts`.
- [ ] **Step 3: Playwright, compared with main.** Run with private ports, on this branch and on a baseline worktree at `e00b0dae` (reuse `/Volumes/Projects/agent-remote-control/.worktrees/e2e-baseline`: `git -C … checkout --detach e00b0dae`, `pnpm install --frozen-lockfile`, `pnpm --filter "@orchardworks/agent-remote-lab^..." run build`):
  `AGENT_REMOTE_TEST_RELAY_PORT=5931 AGENT_REMOTE_TEST_WEB_PORT=6196 npx playwright test e2e/bot-mode.spec.ts e2e/modernization.spec.ts e2e/sidebar.spec.ts e2e/mobile-sidebar.spec.ts e2e/session-view-ownership.spec.ts e2e/workspace-layout.spec.ts e2e/standalone-layout.spec.ts e2e/window-workspaces.spec.ts e2e/floating-controls-layout.spec.ts e2e/mobile.spec.ts --reporter=line` (use 5941/6206 for the baseline). Every test that passes on the baseline must pass here; investigate any that does not (rerun it alone to rule out load).
- [ ] **Step 4:** From the worktree root: `pnpm compatibility:update` then `pnpm compatibility:check` → `Compatibility verified`; commit `packages/agent-remote-lab/compatibility.json` with "chore: update compatibility for the shell frame".
- [ ] **Step 5: Real sessions.** On the worktree's local instance (`prepare-arc-local`), run one Claude Code turn from the command line and one through the page in each mode, switch modes with the sidebar switch and with ⌥⌘1 / ⌥⌘2, collapse and restore each sidebar with ⌘\ and with the Bot toolbar button, create a section from the **+** button and a session from the **New** menu, and screenshot desktop and phone in light and dark. Report per the skill's verification layers.
- [ ] **Step 6:** Record any deviation from this plan at the end of this file under "Changes made during execution" and commit it.

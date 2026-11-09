# UI modernization, phase 1: tokens, dark appearance and primitives — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the whole website the new Apple-style colors and type with a dark appearance that follows the system, and add the primitives later phases build on.

**Architecture:** One stylesheet, `src/ui/tokens.css`, holds every literal color as semantic `--ui-*` tokens for light and dark. The Lab's existing `--obs-*` variables and the shared Session View's `--agent-*` variables are redefined in terms of those tokens, so every page changes at once. A guard test keeps literal colors out of every other stylesheet. New primitives live in `src/ui/`, one component per file, styled by `src/ui/ui.css`; two existing components adopt them now (the mode switch and the bot picture).

**Tech Stack:** React 18, TypeScript, plain CSS, Vitest with jsdom, Playwright for screenshots.

Spec: `docs/superpowers/specs/2026-11-09-ui-modernization-design.md` (phase 1).

---

## Conventions for every task

- Work in the worktree `.worktrees/ui-modern` (branch `feat/ui-modern`).
- Use Node 22 for Lab tests (Node 26's global Web Storage breaks jsdom `localStorage`):
  `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"`.
- Run Lab tests from `packages/agent-remote-lab`: `npx vitest run <file>`.
- Tests render with `render()` from `src/test/setup.ts`.
- jsdom has no `HTMLDialogElement.showModal`; tests stub it (see Task 11).
- Commit messages end with the line `Co-Authored-By: Claude <noreply@anthropic.com>`. Never use `--no-verify`.

## File structure

| File | Responsibility |
|---|---|
| `packages/agent-remote-lab/src/ui/tokens.css` (new) | Every literal color, and the type, radius, shadow and motion tokens, for light and dark |
| `packages/agent-remote-lab/src/ui/tokens.test.ts` (new) | Light and dark define the same tokens; text tokens meet WCAG AA |
| `packages/agent-remote-lab/src/ui/stylesheets.test.ts` (new) | No literal color outside `tokens.css` (and the shared stylesheet's own defaults) |
| `packages/agent-remote-lab/src/ui/ui.css` (new) | Styles of the primitives |
| `packages/agent-remote-lab/src/ui/Icon.tsx` (new) | The line icon set |
| `packages/agent-remote-lab/src/ui/Button.tsx`, `IconButton.tsx`, `SegmentedControl.tsx`, `Avatar.tsx`, `StatusBadge.tsx`, `ListRow.tsx`, `Menu.tsx`, `Sheet.tsx`, `Toolbar.tsx` (new) | One primitive each, with a `*.test.tsx` beside it |
| `packages/agent-remote-lab/src/session-view-styles.ts` | Imports `ui/tokens.css` first and `ui/ui.css` last |
| `packages/agent-remote-lab/src/app.css` | `--obs-*` and `--agent-*` mapped to tokens; literal colors replaced |
| `packages/agent-remote-web/src/styles.css` | Shared defaults for code blocks and overlay shadow; undefined-variable fallbacks removed |
| `packages/agent-remote-lab/src/session-view-responsive.css`, `src/components/team.css` | Literal shadows replaced |
| `packages/agent-remote-lab/index.html`, `public/app/manifest.webmanifest` | Theme colors for light and dark |
| `packages/agent-remote-lab/src/components/WorkbenchModeSwitch.tsx` | Uses `SegmentedControl` |
| `packages/agent-remote-lab/src/components/BotRoster.tsx` | `BotPicture` uses `Avatar` |

---

### Task 1: Semantic tokens for light and dark

**Files:**
- Create: `packages/agent-remote-lab/src/ui/tokens.css`
- Create: `packages/agent-remote-lab/src/ui/tokens.test.ts`
- Modify: `packages/agent-remote-lab/src/session-view-styles.ts`

- [ ] **Step 1: Write the failing test**

`packages/agent-remote-lab/src/ui/tokens.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const source = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

/** The declarations of the first `:root` block after `start` in the token stylesheet. */
function block(start: number): Map<string, string> {
  const open = source.indexOf(':root', start);
  const body = source.slice(source.indexOf('{', open) + 1, source.indexOf('}', open));
  return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(match => [match[1]!, match[2]!.trim()]));
}
const light = block(0);
const dark = block(source.indexOf('@media (prefers-color-scheme: dark)'));

function luminance(hex: string): number {
  const channel = (index: number) => {
    const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}
function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

const colorTokens = [...light.keys()].filter(name => /^#|^rgb/.test(light.get(name)!));
const surfaces = ['--ui-background', '--ui-background-grouped', '--ui-background-elevated', '--ui-sidebar', '--ui-selection'];
const texts = ['--ui-label', '--ui-label-secondary', '--ui-accent-text', '--ui-status-failure', '--ui-status-success', '--ui-status-attention'];

it('defines every color token for both appearances', () => {
  expect(colorTokens.length).toBeGreaterThan(20);
  for (const name of colorTokens) expect(dark.has(name), `${name} has no dark value`).toBe(true);
  expect(source).toContain('color-scheme: light dark');
});

it.each([['light', light], ['dark', dark]] as const)('keeps %s text readable on every surface (WCAG AA)', (_appearance, tokens) => {
  for (const text of texts) for (const surface of surfaces) {
    expect(contrast(tokens.get(text)!, tokens.get(surface)!), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
  }
  expect(contrast(tokens.get('--ui-on-accent')!, tokens.get('--ui-accent')!)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(tokens.get('--ui-on-attention')!, tokens.get('--ui-status-attention')!)).toBeGreaterThanOrEqual(4.5);
  for (const surface of ['--ui-background', '--ui-background-grouped', '--ui-sidebar']) {
    expect(contrast(tokens.get('--ui-control-border')!, tokens.get(surface)!), `control border on ${surface}`).toBeGreaterThanOrEqual(3);
  }
});

it('turns motion off when the system asks for reduced motion', () => {
  expect(source).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*{\s*:root\s*{[^}]*--ui-duration: 0ms/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/tokens.test.ts`
Expected: FAIL with `ENOENT: no such file or directory, open '…/src/ui/tokens.css'`.

- [ ] **Step 3: Write the token stylesheet**

`packages/agent-remote-lab/src/ui/tokens.css`:

```css
/* Semantic design tokens. Light by default, dark with the system appearance.
   Every literal color of the Lab lives in this file; stylesheets.test.ts enforces it. */
:root {
  color-scheme: light dark;

  --ui-background: #ffffff;
  --ui-background-grouped: #f2f2f7;
  --ui-background-elevated: #ffffff;
  --ui-sidebar: #f2f2f7;
  --ui-selection: #e8f0fc;

  --ui-label: #1d1d1f;
  --ui-label-secondary: #636366;
  --ui-label-tertiary: #aeaeb2;
  --ui-separator: rgb(60 60 67 / 0.18);
  --ui-control-border: #7c7c80;
  --ui-fill: rgb(120 120 128 / 0.12);
  --ui-fill-strong: rgb(120 120 128 / 0.2);

  --ui-accent: #0071e3;
  --ui-accent-text: #0066cc;
  --ui-on-accent: #ffffff;
  --ui-focus-ring: rgb(0 113 227 / 0.5);

  --ui-status-attention: #c93400;
  --ui-on-attention: #ffffff;
  --ui-status-working: #0071e3;
  --ui-status-success: #1a7431;
  --ui-status-failure: #d70015;

  --ui-code-background: #f5f5f7;
  --ui-code-text: #1d1d1f;
  --ui-backdrop: rgb(0 0 0 / 0.25);
  --ui-shadow-pane: 0 1px 3px rgb(0 0 0 / 0.08), 0 0 0 0.5px rgb(0 0 0 / 0.06);
  --ui-shadow-overlay: 0 12px 40px rgb(0 0 0 / 0.16), 0 0 0 0.5px rgb(0 0 0 / 0.1);

  --ui-radius-control: 6px;
  --ui-radius-pane: 10px;
  --ui-radius-input: 18px;
  --ui-radius-sheet: 16px;

  --ui-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
  --ui-font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --ui-size-large-title: 26px;
  --ui-size-title: 20px;
  --ui-size-headline: 15px;
  --ui-size-body: 14px;
  --ui-size-callout: 13px;
  --ui-size-caption: 11px;

  --ui-duration-short: 150ms;
  --ui-duration: 220ms;
  --ui-ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --ui-ease-spring: cubic-bezier(0.16, 1, 0.3, 1);
}

@media (prefers-color-scheme: dark) {
  :root {
    --ui-background: #1c1c1e;
    --ui-background-grouped: #000000;
    --ui-background-elevated: #2c2c2e;
    --ui-sidebar: #2c2c2e;
    --ui-selection: #16304d;

    --ui-label: #f5f5f7;
    --ui-label-secondary: #98989d;
    --ui-label-tertiary: #636366;
    --ui-separator: rgb(255 255 255 / 0.15);
    --ui-control-border: #8e8e93;
    --ui-fill: rgb(118 118 128 / 0.24);
    --ui-fill-strong: rgb(118 118 128 / 0.36);

    --ui-accent: #0071e3;
    --ui-accent-text: #409cff;
    --ui-on-accent: #ffffff;
    --ui-focus-ring: rgb(64 156 255 / 0.6);

    --ui-status-attention: #ffb340;
    --ui-on-attention: #000000;
    --ui-status-working: #409cff;
    --ui-status-success: #30d158;
    --ui-status-failure: #ff6961;

    --ui-code-background: #2c2c2e;
    --ui-code-text: #f5f5f7;
    --ui-backdrop: rgb(0 0 0 / 0.5);
    --ui-shadow-pane: 0 1px 3px rgb(0 0 0 / 0.4), 0 0 0 0.5px rgb(255 255 255 / 0.08);
    --ui-shadow-overlay: 0 12px 40px rgb(0 0 0 / 0.5), 0 0 0 0.5px rgb(255 255 255 / 0.12);
  }
}

@media (prefers-reduced-motion: reduce) {
  :root { --ui-duration-short: 0ms; --ui-duration: 0ms; }
}
```

- [ ] **Step 4: Import the tokens before every other stylesheet**

In `packages/agent-remote-lab/src/session-view-styles.ts`, replace the first import block so the file reads:

```ts
// Keep the product and standalone Session View cascade in the same order.
import './ui/tokens.css';
import './app.css';
import '@orchardworks/agent-remote-web/styles.css';
import './session-view-responsive.css';
import './session-view-options.css';
import './ask-resize.css';
```

(Keep any further lines of the file unchanged.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/ui/tokens.test.ts`
Expected: PASS (4 tests). If a contrast assertion fails, it names the token pair; adjust only that token's value in `tokens.css` until it passes.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-remote-lab/src/ui/tokens.css packages/agent-remote-lab/src/ui/tokens.test.ts packages/agent-remote-lab/src/session-view-styles.ts
git commit -m "feat(lab): add semantic design tokens for light and dark appearances

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Map the existing variables onto the tokens

**Files:**
- Modify: `packages/agent-remote-lab/src/app.css:14-43` (the `:root` block) and `:124-142` (the `.lab-shell, .lab-session-view` block)
- Modify: `packages/agent-remote-web/src/styles.css` (`:root` block, `.agent-markdown pre`, `.agent-tool-result*`)
- Modify: `packages/agent-remote-lab/index.html:6`, `packages/agent-remote-lab/public/app/manifest.webmanifest:8-9`
- Test: `packages/agent-remote-lab/src/ui/tokens.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/agent-remote-lab/src/ui/tokens.test.ts`:

```ts
const app = readFileSync(new URL('../app.css', import.meta.url), 'utf8');
const shared = readFileSync(new URL('../../../agent-remote-web/src/styles.css', import.meta.url), 'utf8');

it('derives every Lab and Session View variable from the tokens', () => {
  const root = app.slice(app.indexOf(':root'), app.indexOf('}', app.indexOf(':root')));
  for (const [name, value] of root.matchAll(/(--obs-[\w-]+)\s*:\s*([^;]+);/g)) {
    expect(value, `${name}`).toMatch(/var\(--ui-|color-mix\(/);
  }
  const mapping = app.slice(app.indexOf('.lab-shell, .lab-session-view {'), app.indexOf('}', app.indexOf('.lab-shell, .lab-session-view {')));
  for (const name of ['--agent-code-block-background', '--agent-code-block-text', '--agent-code-background', '--agent-overlay-shadow', '--agent-running']) {
    expect(mapping, name).toMatch(new RegExp(`${name}\\s*:\\s*var\\(--ui-`));
  }
  expect(shared).toMatch(/\.agent-markdown pre \{[^}]*background: var\(--agent-code-block-background\)/);
  expect(shared).toMatch(/\.agent-markdown pre \{[^}]*color: var\(--agent-code-block-text\)/);
});

it('gives the browser a theme color for each appearance', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  expect(html).toContain('<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />');
  expect(html).toContain('<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1c1c1e" />');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/tokens.test.ts`
Expected: FAIL in "derives every Lab and Session View variable" (`--obs-canvas` is `oklch(...)`) and in "gives the browser a theme color".

- [ ] **Step 3: Rewrite the Lab `:root` block**

In `packages/agent-remote-lab/src/app.css`, replace lines 14–43 (from `:root {` through `--obs-mono: …;` and the closing `}`) with:

```css
:root {
  color: var(--ui-label);
  background: var(--obs-surface);
  font-family: var(--ui-font);
  font-size: var(--ui-size-body);
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  /* The Lab's names for the semantic tokens in ui/tokens.css. */
  --obs-canvas: var(--ui-background-grouped);
  --obs-surface: var(--ui-background);
  --obs-surface-selected: var(--ui-selection);
  --obs-text: var(--ui-label);
  --obs-text-secondary: var(--ui-label-secondary);
  --obs-border: var(--ui-separator);
  --obs-signal: var(--ui-accent);
  --obs-action: var(--ui-accent-text);
  --obs-success: var(--ui-status-success);
  --obs-success-text: var(--ui-status-success);
  --obs-warning: var(--ui-status-attention);
  --obs-danger: var(--ui-status-failure);
  --obs-control-border: var(--ui-control-border);
  --obs-border-strong: color-mix(in oklab, var(--obs-text-secondary) 48%, var(--obs-surface));
  --obs-danger-soft: color-mix(in oklab, var(--obs-danger) 9%, var(--obs-surface));
  --obs-warning-soft: color-mix(in oklab, var(--obs-warning) 9%, var(--obs-surface));
  --obs-overlay-shadow: var(--ui-shadow-overlay);
  --obs-radius-sm: var(--ui-radius-control);
  --obs-radius-md: var(--ui-radius-pane);
  --obs-mono: var(--ui-font-mono);
}
```

- [ ] **Step 4: Map the Session View variables in the Lab**

In `packages/agent-remote-lab/src/app.css`, replace the `.lab-shell, .lab-session-view { … }` block with:

```css
.lab-shell, .lab-session-view {
  --agent-canvas: var(--obs-canvas);
  --agent-panel: var(--obs-surface);
  --agent-panel-raised: var(--obs-surface-selected);
  --agent-ink: var(--obs-text);
  --agent-muted: var(--obs-text-secondary);
  --agent-rule: var(--obs-border);
  --agent-signal: var(--obs-action);
  --agent-action-text: var(--obs-action);
  --agent-running: var(--ui-status-working);
  --agent-success: var(--obs-success);
  --agent-success-text: var(--obs-success-text);
  --agent-danger: var(--obs-danger);
  --agent-surface-selected: var(--obs-surface-selected);
  --agent-surface-muted: var(--obs-canvas);
  --agent-surface-danger: var(--obs-danger-soft);
  --agent-radius: var(--obs-radius-sm);
  --agent-code-block-background: var(--ui-code-background);
  --agent-code-block-text: var(--ui-code-text);
  --agent-code-background: var(--ui-code-background);
  --agent-overlay-shadow: var(--ui-shadow-overlay);
}
```

- [ ] **Step 5: Give the shared Session View its own defaults**

In `packages/agent-remote-web/src/styles.css`:

1. In the `:root` block at the top, after `--agent-radius: 8px;`, add:

```css
  --agent-code-block-background: #17212b;
  --agent-code-block-text: #fbfdff;
  --agent-code-background: #f3f6f9;
  --agent-overlay-shadow: 0 8px 24px oklch(0.2 0.01 248 / 0.1);
```

2. Replace the line starting `.agent-markdown pre {` with:

```css
.agent-markdown pre { overflow: auto; padding: 12px; color: var(--agent-code-block-text); background: var(--agent-code-block-background); border: 1px solid var(--agent-rule); border-radius: var(--agent-radius); }
```

3. In the line starting `.agent-tool-result {`, replace `var(--agent-border, #dce3eb)` with `var(--agent-rule)`.
4. In the line starting `.agent-tool-result-header span,`, replace `var(--agent-muted, #526372)` with `var(--agent-muted)`.
5. In the line starting `.agent-tool-result-block pre {`, replace `var(--agent-code-bg, #f3f6f9)` with `var(--agent-code-background)`.

The standalone Session View keeps its look; the Lab now themes code blocks.

- [ ] **Step 6: Theme colors for the browser**

In `packages/agent-remote-lab/index.html`, replace `<meta name="theme-color" content="#fbfdff" />` with:

```html
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1c1c1e" />
```

In `packages/agent-remote-lab/public/app/manifest.webmanifest`, set `"background_color": "#ffffff"` and `"theme_color": "#ffffff"`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/ui/tokens.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/agent-remote-lab/src/app.css packages/agent-remote-web/src/styles.css packages/agent-remote-lab/index.html packages/agent-remote-lab/public/app/manifest.webmanifest packages/agent-remote-lab/src/ui/tokens.test.ts
git commit -m "feat(lab): derive the Lab and Session View colors from the tokens, with themed code blocks

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: No literal colors outside the tokens

**Files:**
- Create: `packages/agent-remote-lab/src/ui/stylesheets.test.ts`
- Modify: `packages/agent-remote-lab/src/app.css` (lines found by the test), `packages/agent-remote-lab/src/session-view-responsive.css:39`, `packages/agent-remote-lab/src/components/team.css:32`, `packages/agent-remote-web/src/styles.css` (lines found by the test)

- [ ] **Step 1: Write the failing test**

`packages/agent-remote-lab/src/ui/stylesheets.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const lab = fileURLToPath(new URL('..', import.meta.url));
const shared = fileURLToPath(new URL('../../../agent-remote-web/src/styles.css', import.meta.url));
const literal = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(|:\s*(?:white|black)\b/;

function stylesheets(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? stylesheets(path) : name.endsWith('.css') ? [path] : [];
  });
}
/** Lines with a literal color, comments removed; `allowed` skips lines a file may keep. */
function offenders(path: string, allowed: (line: string) => boolean): string[] {
  const text = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '));
  return text.split('\n').flatMap((line, index) => literal.test(line) && !allowed(line) ? [`${path}:${index + 1}: ${line.trim().slice(0, 120)}`] : []);
}

it('keeps every Lab color in the token stylesheet, so dark mode covers it', () => {
  const found = stylesheets(lab).filter(path => !path.endsWith(join('ui', 'tokens.css'))).flatMap(path => offenders(path, () => false));
  expect(found).toEqual([]);
});

it('keeps the shared Session View colors in its own default variables', () => {
  // HTML file previews render the file itself on white, whatever the appearance.
  expect(offenders(shared, line => /^\s*--agent-[\w-]+\s*:/.test(line) || line.includes('.agent-file-html'))).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/stylesheets.test.ts`
Expected: FAIL. The first test lists the remaining literal colors in `app.css`, `session-view-responsive.css` and `components/team.css`; the second lists the shared stylesheet's shadows, the `#888` and `#ddd` fallbacks and the pending title color.

- [ ] **Step 3: Replace the Lab literals**

In `packages/agent-remote-lab/src/app.css`, make these replacements (each on the line that starts with the given selector):

| Line starts with | Replace | With |
|---|---|---|
| `.lab-session-panel-footer button {` | `color: white;` | `color: var(--ui-on-accent);` |
| `.lab-session-link-dialog::backdrop {` | `rgb(15 25 40 / 35%)` | `var(--ui-backdrop)` |
| `.lab-folder-dialog {` | `0 18px 60px oklch(20% 0.02 250 / 0.2)` | `var(--ui-shadow-overlay)` |
| `.lab-folder-dialog::backdrop {` | `oklch(20% 0.02 250 / 0.35)` | `var(--ui-backdrop)` |
| `--tracking-pending-surface:` | `oklch(0.8 0.16 87) 40%` | `var(--ui-status-attention) 22%` |
| `background: var(--tracking-pending-surface); --tracking-edge-color:` | `oklch(0.52 0.108 87)` | `var(--ui-status-attention)` |
| `.lab-tracked-change[data-attention="pending"] {` | `oklch(0.52 0.108 87)` | `var(--ui-status-attention)` |
| `.lab-controller-health li[data-severity="warning"] small {` | `var(--agent-danger, #b42318)` | `var(--obs-danger)` |
| `.lab-favorite-menu {` | `0 4px 16px rgb(20 35 50 / .12)` | `var(--ui-shadow-overlay)` |
| `.lab-favorite-dialog {` | `0 10px 40px rgb(20 35 50 / .18)` | `var(--ui-shadow-overlay)` |
| `.lab-favorite-dialog::backdrop {` | `rgb(20 35 50 / .22)` | `var(--ui-backdrop)` |
| the line containing `box-shadow: 0 2px 8px #0000000c` | `0 2px 8px #0000000c` | `var(--ui-shadow-pane)` |
| `.lab-cache-setting [role="switch"] span {` | `0 1px 3px rgb(0 0 0 / .2)` | `var(--ui-shadow-pane)` |

In `packages/agent-remote-lab/src/session-view-responsive.css:39`, replace `-8px 0 24px oklch(0.2 0.01 248 / .08)` with `var(--ui-shadow-overlay)`.

In `packages/agent-remote-lab/src/components/team.css:32`, replace `0 4px 16px #0002` with `var(--ui-shadow-overlay)`.

- [ ] **Step 4: Replace the shared stylesheet literals**

In `packages/agent-remote-web/src/styles.css`:

| Line starts with | Replace | With |
|---|---|---|
| `.agent-command-menu {` | `0 8px 24px oklch(0.2 0.01 248 / .1)` | `var(--agent-overlay-shadow)` |
| `.agent-session-title[data-session-status="starting"] {` | `oklch(0.52 0.108 87)` | `var(--agent-setting-pending)` |
| `.agent-image-preview .agent-image-preview-close {` | `0 2px 12px oklch(0.18 0.01 250 / .1)` | `var(--agent-overlay-shadow)` |
| `.agent-image-preview-controls {` | `0 2px 12px oklch(0.18 0.01 250 / .1)` | `var(--agent-overlay-shadow)` |
| `.agent-composer .agent-image-upload-status button {` | `0 3px 12px oklch(0.2 0.01 250 / .1)` | `var(--agent-overlay-shadow)` |
| `.agent-composer-editor:empty::before {` | `var(--agent-text-muted, #888)` | `var(--agent-muted)` |
| `.agent-session-todo-panel {` | `0 8px 16px oklch(20% 0.01 250 / 0.12)` | `var(--agent-overlay-shadow)` |
| `.agent-resource-draft {` | `var(--agent-border, #ddd)` | `var(--agent-rule)` |

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/ui/stylesheets.test.ts src/ui/tokens.test.ts`
Expected: PASS. If the first test still lists a line, replace that literal with the closest token from `tokens.css` (text → `--ui-label*`, borders → `--ui-separator`, shadows → `--ui-shadow-*`, backdrops → `--ui-backdrop`).

- [ ] **Step 6: Commit**

```bash
git add packages/agent-remote-lab/src packages/agent-remote-web/src/styles.css
git commit -m "fix(lab): replace literal colors with tokens so every surface follows the appearance

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Icon set

**Files:**
- Create: `packages/agent-remote-lab/src/ui/Icon.tsx`
- Create: `packages/agent-remote-lab/src/ui/Icon.test.tsx`

- [ ] **Step 1: Write the failing test**

`packages/agent-remote-lab/src/ui/Icon.test.tsx`:

```tsx
import { expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { Icon, ICON_NAMES } from './Icon.js';

it('draws every icon as a decorative line drawing', async () => {
  const container = await render(<>{ICON_NAMES.map(name => <Icon key={name} name={name} />)}</>);
  const svgs = [...container.querySelectorAll('svg')];
  expect(svgs).toHaveLength(ICON_NAMES.length);
  for (const svg of svgs) {
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.querySelector('path')?.getAttribute('d')).toBeTruthy();
  }
});

it('sizes an icon in pixels', async () => {
  const container = await render(<Icon name="plus" size={20} />);
  expect(container.querySelector('svg')?.getAttribute('width')).toBe('20');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/Icon.test.tsx`
Expected: FAIL with `Failed to resolve import "./Icon.js"`.

- [ ] **Step 3: Write the icon set**

`packages/agent-remote-lab/src/ui/Icon.tsx`:

```tsx
/** Line icons on a 24-pixel grid with round caps and joins, drawn for this app (SF Symbols are licensed for Apple platforms only). */
const PATHS = {
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4.5a6.5 6.5 0 1 1 0 13a6.5 6.5 0 1 1 0-13zM15.8 15.8L20 20',
  sidebar: 'M4 5.5h16v13H4zM9.5 5.5v13',
  ellipsis: 'M6 11a1 1 0 1 1 0 2a1 1 0 1 1 0-2zM12 11a1 1 0 1 1 0 2a1 1 0 1 1 0-2zM18 11a1 1 0 1 1 0 2a1 1 0 1 1 0-2z',
  close: 'M6 6l12 12M18 6L6 18',
  star: 'M12 3.8l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8z',
  'chevron-right': 'M9.5 6l6 6-6 6',
  'chevron-left': 'M14.5 6l-6 6 6 6',
  'chevron-down': 'M6 9.5l6 6 6-6',
  'arrow-up': 'M12 19V5M6 11l6-6 6 6',
  stop: 'M7 7h10v10H7z',
  gear: 'M12 9a3 3 0 1 1 0 6a3 3 0 1 1 0-6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1',
  window: 'M3.5 5.5h17v13h-17zM3.5 9h17',
  team: 'M9 11a3 3 0 1 1 0-6a3 3 0 1 1 0 6zM3.5 19c.7-3 2.9-4.5 5.5-4.5s4.8 1.5 5.5 4.5M16 11a2.5 2.5 0 1 0 0-5M17.5 14.6c1.6.5 2.6 1.9 3 4.4',
  list: 'M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01',
  question: 'M12 21a9 9 0 1 1 0-18a9 9 0 1 1 0 18zM9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.8M12 17h.01',
  sessions: 'M12 4l8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4',
  person: 'M12 12a4 4 0 1 1 0-8a4 4 0 1 1 0 8zM4.5 20c.9-3.8 3.9-6 7.5-6s6.6 2.2 7.5 6',
  pin: 'M9 4h6l-1 5 3 3H7l3-3zM12 12v8',
  'eye-off': 'M3 3l18 18M10.6 6.1A9.9 9.9 0 0 1 12 6c5 0 8.5 4.5 9.5 6-.5.8-1.6 2.3-3.2 3.6M6.6 7.7C4.6 9 3.2 10.9 2.5 12c1 1.5 4.5 6 9.5 6 1.5 0 2.9-.4 4.1-1',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  warning: 'M12 4l9 16H3zM12 10v4.5M12 17.5h.01',
  refresh: 'M19 12a7 7 0 1 1-2.05-4.95M19 4.5v4h-4',
} as const;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg className="ui-icon" aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
    <path d={PATHS[name]} />
  </svg>;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/Icon.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-remote-lab/src/ui/Icon.tsx packages/agent-remote-lab/src/ui/Icon.test.tsx
git commit -m "feat(lab): add a line icon set

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Button and IconButton, and the primitives stylesheet

**Files:**
- Create: `packages/agent-remote-lab/src/ui/Button.tsx`, `packages/agent-remote-lab/src/ui/IconButton.tsx`
- Create: `packages/agent-remote-lab/src/ui/Button.test.tsx`
- Create: `packages/agent-remote-lab/src/ui/ui.css`
- Modify: `packages/agent-remote-lab/src/session-view-styles.ts`

- [ ] **Step 1: Write the failing test**

`packages/agent-remote-lab/src/ui/Button.test.tsx`:

```tsx
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { Button } from './Button.js';
import { IconButton } from './IconButton.js';

it('renders a non-submitting button with its variant and size', async () => {
  const onClick = vi.fn();
  const container = await render(<form><Button variant="primary" size="small" onClick={onClick}>Create</Button></form>);
  const button = container.querySelector('button')!;
  expect(button.type).toBe('button');
  expect(button.className).toBe('ui-button');
  expect(button.dataset.variant).toBe('primary');
  expect(button.dataset.size).toBe('small');
  await act(async () => button.click());
  expect(onClick).toHaveBeenCalledOnce();
});

it('defaults to a regular secondary button and keeps extra classes', async () => {
  const container = await render(<Button className="lab-extra">Cancel</Button>);
  const button = container.querySelector('button')!;
  expect(button.dataset.variant).toBe('secondary');
  expect(button.dataset.size).toBe('regular');
  expect(button.className).toBe('ui-button lab-extra');
});

it('names an icon button by its label', async () => {
  const container = await render(<IconButton icon="plus" label="New Bot" />);
  const button = container.querySelector('button')!;
  expect(button.getAttribute('aria-label')).toBe('New Bot');
  expect(button.title).toBe('New Bot');
  expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/Button.test.tsx`
Expected: FAIL with `Failed to resolve import "./Button.js"`.

- [ ] **Step 3: Write the buttons**

`packages/agent-remote-lab/src/ui/Button.tsx`:

```tsx
import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'plain' | 'destructive';

/** A button that never submits a form unless asked: primary for the main action, secondary by default, plain for text-like actions. */
export function Button({ variant = 'secondary', size = 'regular', className, type = 'button', ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'regular' | 'small' }) {
  return <button {...props} type={type} className={className ? `ui-button ${className}` : 'ui-button'} data-variant={variant} data-size={size} />;
}
```

`packages/agent-remote-lab/src/ui/IconButton.tsx`:

```tsx
import type { ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from './Icon.js';

/** An icon-only button; its label is its accessible name and tooltip. */
export function IconButton({ icon, label, className, type = 'button', title, ...props }:
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> & { icon: IconName; label: string }) {
  return <button {...props} type={type} className={className ? `ui-icon-button ${className}` : 'ui-icon-button'} aria-label={label} title={title ?? label}>
    <Icon name={icon} />
  </button>;
}
```

- [ ] **Step 4: Create the primitives stylesheet**

`packages/agent-remote-lab/src/ui/ui.css`:

```css
/* Primitives of src/ui. Colors come from ui/tokens.css only. */
.ui-icon { flex: none; display: block; }

.ui-button {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 28px; padding: 4px 12px; border: 0; border-radius: var(--ui-radius-control);
  font: 500 var(--ui-size-callout)/1.2 var(--ui-font); color: var(--ui-label); background: var(--ui-fill);
  cursor: pointer; transition: background-color var(--ui-duration-short) var(--ui-ease), opacity var(--ui-duration-short) var(--ui-ease);
}
.ui-button[data-size="small"] { min-height: 22px; padding: 2px 8px; font-size: var(--ui-size-caption); }
.ui-button:hover:not(:disabled) { background: var(--ui-fill-strong); }
.ui-button[data-variant="primary"] { color: var(--ui-on-accent); background: var(--ui-accent); }
.ui-button[data-variant="primary"]:hover:not(:disabled) { background: color-mix(in srgb, var(--ui-accent) 88%, var(--ui-label)); }
.ui-button[data-variant="plain"] { color: var(--ui-accent-text); background: transparent; }
.ui-button[data-variant="plain"]:hover:not(:disabled) { background: var(--ui-fill); }
.ui-button[data-variant="destructive"] { color: var(--ui-status-failure); background: var(--ui-fill); }
.ui-button:disabled { opacity: 0.45; cursor: default; }

.ui-icon-button {
  display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0;
  border-radius: var(--ui-radius-control); color: var(--ui-label-secondary); background: transparent; cursor: pointer;
  transition: background-color var(--ui-duration-short) var(--ui-ease), color var(--ui-duration-short) var(--ui-ease);
}
.ui-icon-button:hover:not(:disabled), .ui-icon-button[aria-expanded="true"] { color: var(--ui-label); background: var(--ui-fill); }
.ui-icon-button:disabled { opacity: 0.45; cursor: default; }

:where(.ui-button, .ui-icon-button):focus-visible { outline: 3px solid var(--ui-focus-ring); outline-offset: 1px; }
@media (pointer: coarse) { .ui-icon-button { width: 44px; height: 44px; } .ui-button { min-height: 44px; } }
```

In `packages/agent-remote-lab/src/session-view-styles.ts`, add as the last import line:

```ts
import './ui/ui.css';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/ui/Button.test.tsx src/ui/stylesheets.test.ts`
Expected: PASS (3 + 2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/agent-remote-lab/src/ui packages/agent-remote-lab/src/session-view-styles.ts
git commit -m "feat(lab): add Button and IconButton primitives

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: SegmentedControl, used by the mode switch

**Files:**
- Create: `packages/agent-remote-lab/src/ui/SegmentedControl.tsx`, `packages/agent-remote-lab/src/ui/SegmentedControl.test.tsx`
- Modify: `packages/agent-remote-lab/src/components/WorkbenchModeSwitch.tsx`
- Modify: `packages/agent-remote-lab/src/ui/ui.css`, `packages/agent-remote-lab/src/components/bot-workspace.css` (the two `.lab-workbench-mode` rules)

- [ ] **Step 1: Write the failing test**

`packages/agent-remote-lab/src/ui/SegmentedControl.test.tsx`:

```tsx
import { act, useState } from 'react';
import { expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { SegmentedControl } from './SegmentedControl.js';
import { WorkbenchModeSwitch } from '../components/WorkbenchModeSwitch.js';

function Harness() {
  const [value, setValue] = useState<'bots' | 'windows'>('bots');
  return <SegmentedControl label="Mode" value={value} onChange={setValue} options={[{ value: 'bots', label: 'Bots' }, { value: 'windows', label: 'Windows' }]} />;
}

it('marks the chosen segment and changes on click', async () => {
  const container = await render(<Harness />);
  const [bots, windows] = [...container.querySelectorAll('button')];
  expect(container.querySelector('nav')?.getAttribute('aria-label')).toBe('Mode');
  expect(bots!.getAttribute('aria-pressed')).toBe('true');
  await act(async () => windows!.click());
  expect(windows!.getAttribute('aria-pressed')).toBe('true');
  expect(bots!.getAttribute('aria-pressed')).toBe('false');
});

it('moves the choice with the arrow keys, wrapping around', async () => {
  const container = await render(<Harness />);
  const [bots, windows] = [...container.querySelectorAll('button')];
  bots!.focus();
  await act(async () => bots!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(windows!.getAttribute('aria-pressed')).toBe('true');
  expect(document.activeElement).toBe(windows);
  await act(async () => windows!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(bots!.getAttribute('aria-pressed')).toBe('true');
});

it('keeps the mode switch names the page and its tests rely on', async () => {
  let mode: 'window' | 'bot' = 'window';
  const container = await render(<WorkbenchModeSwitch mode="window" onChange={next => { mode = next; }} />);
  expect(container.querySelector('nav')?.getAttribute('aria-label')).toBe('Workbench mode');
  expect(container.querySelector('nav')?.classList.contains('lab-workbench-mode')).toBe(true);
  const bot = [...container.querySelectorAll('button')].find(button => button.textContent === 'Bot mode')!;
  expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Window mode')?.getAttribute('aria-pressed')).toBe('true');
  await act(async () => bot.click());
  expect(mode).toBe('bot');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/SegmentedControl.test.tsx`
Expected: FAIL with `Failed to resolve import "./SegmentedControl.js"`.

- [ ] **Step 3: Write the control**

`packages/agent-remote-lab/src/ui/SegmentedControl.tsx`:

```tsx
import { useRef, type KeyboardEvent } from 'react';

/** A macOS-style segmented control: one pressed segment; Left and Right move the choice. */
export function SegmentedControl<T extends string>({ label, options, value, onChange, className }: {
  label: string; options: readonly { value: T; label: string }[]; value: T; onChange(value: T): void; className?: string;
}) {
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = options[(index + (event.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length]!;
    onChange(next.value);
    buttons.current.get(next.value)?.focus();
  };
  return <nav className={className ? `ui-segmented ${className}` : 'ui-segmented'} aria-label={label}>
    {options.map((option, index) => <button key={option.value} type="button" aria-pressed={option.value === value}
      ref={node => { if (node) buttons.current.set(option.value, node); else buttons.current.delete(option.value); }}
      onClick={() => onChange(option.value)} onKeyDown={event => move(event, index)}>{option.label}</button>)}
  </nav>;
}
```

`packages/agent-remote-lab/src/components/WorkbenchModeSwitch.tsx` (whole file):

```tsx
import type { WorkbenchMode } from '../workbench-mode.js';
import { SegmentedControl } from '../ui/SegmentedControl.js';

const MODES = [{ value: 'window', label: 'Window mode' }, { value: 'bot', label: 'Bot mode' }] as const;

export function WorkbenchModeSwitch({ mode, onChange }: { mode: WorkbenchMode; onChange(mode: WorkbenchMode): void }) {
  return <SegmentedControl label="Workbench mode" className="lab-workbench-mode" options={MODES} value={mode} onChange={onChange} />;
}
```

Append to `packages/agent-remote-lab/src/ui/ui.css`:

```css
.ui-segmented { display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--ui-fill); }
.ui-segmented button {
  flex: 1; min-height: 24px; padding: 2px 10px; border: 0; border-radius: 6px;
  font: 500 var(--ui-size-callout)/1.2 var(--ui-font); color: var(--ui-label); background: transparent; cursor: pointer;
  transition: background-color var(--ui-duration-short) var(--ui-ease), box-shadow var(--ui-duration-short) var(--ui-ease);
}
.ui-segmented button[aria-pressed="true"] { background: var(--ui-background-elevated); box-shadow: var(--ui-shadow-pane); }
.ui-segmented button:focus-visible { outline: 3px solid var(--ui-focus-ring); outline-offset: 1px; }
@media (pointer: coarse) { .ui-segmented button { min-height: 36px; } }
```

In `packages/agent-remote-lab/src/components/bot-workspace.css`, delete the two rules `.lab-workbench-mode { … }` and `.lab-workbench-mode button { … }` and `.lab-workbench-mode button[aria-pressed="true"] { … }` (the segmented control styles it now).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/ui/SegmentedControl.test.tsx src/hooks/useWorkbenchMode.test.tsx src/components/BotWorkspace`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-remote-lab/src/ui packages/agent-remote-lab/src/components/WorkbenchModeSwitch.tsx packages/agent-remote-lab/src/components/bot-workspace.css
git commit -m "feat(lab): switch modes with a segmented control

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Avatar, used by bot pictures

**Files:**
- Create: `packages/agent-remote-lab/src/ui/Avatar.tsx`, `packages/agent-remote-lab/src/ui/Avatar.test.tsx`
- Modify: `packages/agent-remote-lab/src/components/BotRoster.tsx:7-11` and its call at `:29`, `packages/agent-remote-lab/src/App.tsx:2449` (pass the bot's title as `name`)
- Modify: `packages/agent-remote-lab/src/ui/ui.css`, `packages/agent-remote-lab/src/components/bot-workspace.css` (the three `.lab-bot-picture` rules)

- [ ] **Step 1: Write the failing test**

`packages/agent-remote-lab/src/ui/Avatar.test.tsx`:

```tsx
import { expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { Avatar, AVATAR_COLORS, avatarColor } from './Avatar.js';

it('draws the stored shape and color with the first letter of the name', async () => {
  const container = await render(<Avatar name="release notes" picture={{ shape: 'hexagon', color: '#123456' }} size={30} />);
  const avatar = container.querySelector('.ui-avatar') as HTMLElement;
  expect(avatar.getAttribute('aria-hidden')).toBe('true');
  expect(avatar.dataset.shape).toBe('hexagon');
  expect(avatar.textContent).toBe('R');
  expect(avatar.getAttribute('style')).toContain('#123456');
  expect(avatar.getAttribute('style')).toContain('30px');
});

it('picks a stable palette color for a bot without a picture, and ignores invalid colors', async () => {
  expect(avatarColor('API caching')).toBe(avatarColor('API caching'));
  expect(AVATAR_COLORS).toContain(avatarColor('API caching'));
  const container = await render(<Avatar name="API caching" picture={{ shape: 'circle', color: 'red;background:url(x)' }} />);
  expect(container.querySelector('.ui-avatar')?.getAttribute('style')).toContain(avatarColor('API caching'));
});

it('draws no letter for a nameless picture', async () => {
  const container = await render(<Avatar name="" />);
  expect(container.querySelector('.ui-avatar')?.textContent).toBe('');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/Avatar.test.tsx`
Expected: FAIL with `Failed to resolve import "./Avatar.js"`.

- [ ] **Step 3: Write the avatar**

`packages/agent-remote-lab/src/ui/Avatar.tsx`:

```tsx
import type { CSSProperties } from 'react';
import type { WindowBotDetails } from '@orchardworks/agent-remote-protocol';

/** Colors that keep a white letter readable (contrast of at least 4.5:1). */
export const AVATAR_COLORS = ['#0071e3', '#8944ab', '#c93400', '#1a7431', '#d70015', '#0071a4', '#a05a00', '#636366'] as const;

export function avatarColor(seed: string): string {
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

/** A bot's picture: its stored shape and color with the first letter of its name. */
export function Avatar({ name, picture, size = 28 }: { name: string; picture?: WindowBotDetails['picture']; size?: number }) {
  const color = picture?.color && /^#[0-9a-f]{6}$/.test(picture.color) ? picture.color : avatarColor(name);
  const initial = [...name.trim()][0]?.toUpperCase() ?? '';
  return <span aria-hidden="true" className="ui-avatar" data-shape={picture?.shape ?? 'circle'}
    style={{ '--ui-avatar-color': color, '--ui-avatar-size': `${size}px` } as CSSProperties}>{initial}</span>;
}
```

Append to `packages/agent-remote-lab/src/ui/ui.css`:

```css
.ui-avatar {
  display: inline-grid; place-items: center; flex: none; width: var(--ui-avatar-size, 28px); height: var(--ui-avatar-size, 28px);
  border-radius: 50%; color: var(--ui-on-accent); background: var(--ui-avatar-color, var(--ui-accent));
  font: 600 calc(var(--ui-avatar-size, 28px) * 0.43)/1 var(--ui-font); user-select: none;
}
.ui-avatar[data-shape="rounded"] { border-radius: 28%; }
.ui-avatar[data-shape="hexagon"] { border-radius: 0; clip-path: polygon(25% 4%, 75% 4%, 100% 50%, 75% 96%, 25% 96%, 0 50%); }
```

- [ ] **Step 4: Use it for bot pictures**

In `packages/agent-remote-lab/src/components/BotRoster.tsx`, replace the `BotPicture` function (lines 7–11) with:

```tsx
export function BotPicture({ picture, name = '' }: Pick<WindowBotDetails, 'picture'> & { name?: string }) {
  return <Avatar name={name} picture={picture} size={26} />;
}
```

add `import { Avatar } from '../ui/Avatar.js';` to its imports, remove the now unused `CSSProperties` import, and at the row (line 29) pass the name:

```tsx
<BotPicture picture={row.details.picture} name={row.binding.title || row.binding.nativeSessionId} />
```

In `packages/agent-remote-lab/src/App.tsx` at line 2449, the heading renders `<strong>{source.title}</strong>` beside the picture; give the picture the same name. Replace

```tsx
<BotPicture picture={botGroup?.bots?.members[options.bot.viewId]?.picture} />
```

with

```tsx
<BotPicture picture={botGroup?.bots?.members[options.bot.viewId]?.picture} name={source.title} />
```

In `packages/agent-remote-lab/src/components/bot-workspace.css`, delete the three `.lab-bot-picture…` rules.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/ui/Avatar.test.tsx src/components/BotRoster.test.tsx src/App.bot`
Expected: PASS. `BotRoster.test.tsx` still finds `[data-shape="hexagon"]` with `#123456` in its style.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-remote-lab/src/ui packages/agent-remote-lab/src/components/BotRoster.tsx packages/agent-remote-lab/src/components/bot-workspace.css packages/agent-remote-lab/src/App.tsx
git commit -m "feat(lab): draw bot pictures as avatars with the bot's initial

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: StatusBadge

**Files:**
- Create: `packages/agent-remote-lab/src/ui/StatusBadge.tsx`, `packages/agent-remote-lab/src/ui/StatusBadge.test.tsx`
- Modify: `packages/agent-remote-lab/src/ui/ui.css`

- [ ] **Step 1: Write the failing test**

`packages/agent-remote-lab/src/ui/StatusBadge.test.tsx`:

```tsx
import { expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { StatusBadge } from './StatusBadge.js';

it.each([
  [{ kind: 'attention', count: 2 } as const, 'Needs you: 2', '2'],
  [{ kind: 'failed' } as const, 'Failed', '!'],
  [{ kind: 'working' } as const, 'Working', ''],
  [{ kind: 'unread' } as const, 'New result', ''],
])('names the %o status for assistive technology', async (status, name, text) => {
  const container = await render(<StatusBadge status={status} />);
  const badge = container.querySelector('.ui-status') as HTMLElement;
  expect(badge.getAttribute('role')).toBe('img');
  expect(badge.getAttribute('aria-label')).toBe(name);
  expect(badge.dataset.kind).toBe(status.kind);
  expect(badge.textContent).toBe(text);
});

it('caps a large count', async () => {
  const container = await render(<StatusBadge status={{ kind: 'attention', count: 120 }} />);
  expect(container.querySelector('.ui-status')?.textContent).toBe('99+');
  expect(container.querySelector('.ui-status')?.getAttribute('aria-label')).toBe('Needs you: 120');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/StatusBadge.test.tsx`
Expected: FAIL with `Failed to resolve import "./StatusBadge.js"`.

- [ ] **Step 3: Write the badge**

`packages/agent-remote-lab/src/ui/StatusBadge.tsx`:

```tsx
export type RowStatus = { kind: 'attention'; count: number } | { kind: 'failed' } | { kind: 'working' } | { kind: 'unread' };

const NAMES = { failed: 'Failed', working: 'Working', unread: 'New result' } as const;

/** One trailing status of a row: a count of requests that need you, a failure, work in progress or a new result. */
export function StatusBadge({ status }: { status: RowStatus }) {
  const name = status.kind === 'attention' ? `Needs you: ${status.count}` : NAMES[status.kind];
  const text = status.kind === 'attention' ? (status.count > 99 ? '99+' : String(status.count)) : status.kind === 'failed' ? '!' : '';
  return <span className="ui-status" data-kind={status.kind} role="img" aria-label={name}>{text}</span>;
}
```

Append to `packages/agent-remote-lab/src/ui/ui.css`:

```css
.ui-status { flex: none; display: inline-grid; place-items: center; font: 600 var(--ui-size-caption)/1 var(--ui-font); }
.ui-status[data-kind="attention"], .ui-status[data-kind="failed"] { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; }
.ui-status[data-kind="attention"] { color: var(--ui-on-attention); background: var(--ui-status-attention); }
.ui-status[data-kind="failed"] { color: var(--ui-on-accent); background: var(--ui-status-failure); }
.ui-status[data-kind="unread"] { width: 9px; height: 9px; border-radius: 50%; background: var(--ui-accent); }
.ui-status[data-kind="working"] {
  width: 13px; height: 13px; border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--ui-status-working) 25%, transparent); border-top-color: var(--ui-status-working);
  animation: ui-spin 0.9s linear infinite;
}
@keyframes ui-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ui-status[data-kind="working"] { animation: none; border-color: var(--ui-status-working); } }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/StatusBadge.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-remote-lab/src/ui
git commit -m "feat(lab): add the row status badge

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: ListRow

**Files:**
- Create: `packages/agent-remote-lab/src/ui/ListRow.tsx`, `packages/agent-remote-lab/src/ui/ListRow.test.tsx`
- Modify: `packages/agent-remote-lab/src/ui/ui.css`

- [ ] **Step 1: Write the failing test**

`packages/agent-remote-lab/src/ui/ListRow.test.tsx`:

```tsx
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { ListRow } from './ListRow.js';

it('lays out a picture, title, subtitle and trailing accessory in one button', async () => {
  const onClick = vi.fn();
  const container = await render(<ListRow leading={<span data-testid="pic" />} title="API caching" subtitle="Backend review"
    trailing={<span data-testid="badge" />} selected onClick={onClick} data-bot-place="x" />);
  const row = container.querySelector('button')!;
  expect(row.className).toBe('ui-list-row');
  expect(row.getAttribute('aria-current')).toBe('true');
  expect(row.dataset.botPlace).toBe('x');
  expect(row.querySelector('.ui-list-row-title')?.textContent).toBe('API caching');
  expect(row.querySelector('.ui-list-row-subtitle')?.textContent).toBe('Backend review');
  expect(row.querySelector('[data-testid="pic"]')).not.toBeNull();
  expect(row.querySelector('[data-testid="badge"]')).not.toBeNull();
  await act(async () => row.click());
  expect(onClick).toHaveBeenCalledOnce();
});

it('leaves out what a row does not have', async () => {
  const container = await render(<ListRow title="Release notes" />);
  const row = container.querySelector('button')!;
  expect(row.hasAttribute('aria-current')).toBe(false);
  expect(row.querySelector('.ui-list-row-subtitle')).toBeNull();
  expect(row.querySelector('.ui-list-row-leading')).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/ListRow.test.tsx`
Expected: FAIL with `Failed to resolve import "./ListRow.js"`.

- [ ] **Step 3: Write the row**

`packages/agent-remote-lab/src/ui/ListRow.tsx`:

```tsx
import type { ButtonHTMLAttributes, ReactNode } from 'react';

/** A sidebar or list row: optional picture, a title with an optional subtitle, and an optional trailing accessory. */
export function ListRow({ leading, title, subtitle, trailing, selected, className, type = 'button', ...props }:
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'children'> & {
    leading?: ReactNode; title: ReactNode; subtitle?: ReactNode; trailing?: ReactNode; selected?: boolean;
  }) {
  return <button {...props} type={type} className={className ? `ui-list-row ${className}` : 'ui-list-row'} aria-current={selected || undefined}>
    {leading ? <span className="ui-list-row-leading">{leading}</span> : null}
    <span className="ui-list-row-text">
      <span className="ui-list-row-title">{title}</span>
      {subtitle ? <span className="ui-list-row-subtitle">{subtitle}</span> : null}
    </span>
    {trailing ? <span className="ui-list-row-trailing">{trailing}</span> : null}
  </button>;
}
```

Append to `packages/agent-remote-lab/src/ui/ui.css`:

```css
.ui-list-row {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 36px; padding: 5px 8px; border: 0;
  border-radius: 7px; text-align: left; color: var(--ui-label); background: transparent; font: var(--ui-size-callout)/1.3 var(--ui-font); cursor: pointer;
}
.ui-list-row:hover { background: var(--ui-fill); }
.ui-list-row[aria-current="true"] { background: var(--ui-selection); }
.ui-list-row:focus-visible { outline: 3px solid var(--ui-focus-ring); outline-offset: -1px; }
.ui-list-row-leading, .ui-list-row-trailing { flex: none; display: inline-flex; align-items: center; }
.ui-list-row-text { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 1px; }
.ui-list-row-title, .ui-list-row-subtitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-list-row-title { font-weight: 500; }
.ui-list-row-subtitle { color: var(--ui-label-secondary); font-size: var(--ui-size-caption); }
@media (pointer: coarse) { .ui-list-row { min-height: 52px; padding: 8px 10px; font-size: 15px; } }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/ListRow.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-remote-lab/src/ui
git commit -m "feat(lab): add the list row primitive

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Menu

**Files:**
- Create: `packages/agent-remote-lab/src/ui/Menu.tsx`, `packages/agent-remote-lab/src/ui/Menu.test.tsx`
- Modify: `packages/agent-remote-lab/src/ui/ui.css`

- [ ] **Step 1: Write the failing test**

`packages/agent-remote-lab/src/ui/Menu.test.tsx`:

```tsx
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { Menu } from './Menu.js';

const key = (target: Element, name: string) => act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })); });

async function open() {
  const rename = vi.fn(), remove = vi.fn();
  const container = await render(<Menu label="Bot actions" items={[
    { label: 'Rename', icon: 'gear', onSelect: rename },
    { label: 'Pin', disabled: true, onSelect: vi.fn() },
    { kind: 'separator' },
    { label: 'Remove bot', destructive: true, onSelect: remove },
  ]} />);
  const trigger = container.querySelector('button')!;
  await act(async () => trigger.click());
  return { trigger, rename, remove, menu: document.querySelector('[role="menu"]')! };
}

it('opens a named menu and focuses its first enabled item', async () => {
  const { trigger, menu } = await open();
  expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(menu.getAttribute('aria-label')).toBe('Bot actions');
  expect([...menu.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(['Rename', 'Pin', 'Remove bot']);
  expect(document.activeElement?.textContent).toBe('Rename');
});

it('moves with the arrow keys past disabled items and selects with a click', async () => {
  const { menu, remove } = await open();
  await key(menu, 'ArrowDown');
  expect(document.activeElement?.textContent).toBe('Remove bot');
  expect((document.activeElement as HTMLElement).dataset.destructive).toBe('true');
  await key(menu, 'ArrowDown');
  expect(document.activeElement?.textContent).toBe('Rename');
  await act(async () => (menu.querySelectorAll('[role="menuitem"]')[2] as HTMLElement).click());
  expect(remove).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it('closes on Escape and returns focus to its button, without selecting', async () => {
  const { trigger, menu, rename } = await open();
  await key(menu, 'Escape');
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(rename).not.toHaveBeenCalled();
});

it('ignores a disabled item and closes on a click outside', async () => {
  const { menu } = await open();
  await act(async () => (menu.querySelectorAll('[role="menuitem"]')[1] as HTMLElement).click());
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  await act(async () => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
  expect(document.querySelector('[role="menu"]')).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/Menu.test.tsx`
Expected: FAIL with `Failed to resolve import "./Menu.js"`.

- [ ] **Step 3: Write the menu**

`packages/agent-remote-lab/src/ui/Menu.tsx`:

```tsx
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon.js';

export type MenuEntry =
  | { kind?: 'item'; label: string; icon?: IconName; destructive?: boolean; disabled?: boolean; onSelect(): void }
  | { kind: 'separator' };

const ENABLED = '[role="menuitem"]:not([aria-disabled="true"])';

/** A ⋯ (or custom) button that opens a menu below it: arrow keys move, Escape closes and returns focus. */
export function Menu({ label, icon = 'ellipsis', trigger, items }: { label: string; icon?: IconName; trigger?: ReactNode; items: readonly MenuEntry[] }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (restoreFocus: boolean) => { setOpen(false); if (restoreFocus) button.current?.focus(); };

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const anchor = button.current.getBoundingClientRect();
    const width = menu.current?.offsetWidth || 220;
    setPosition({ top: anchor.bottom + 4, left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)) });
    menu.current?.querySelector<HTMLElement>(ENABLED)?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) close(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    if (event.key === 'Tab') { close(false); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const enabled = [...(menu.current?.querySelectorAll<HTMLElement>(ENABLED) ?? [])];
    const index = enabled.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
    enabled[next]?.focus();
  };

  return <>
    <button ref={button} type="button" className="ui-icon-button" aria-label={label} title={label} aria-haspopup="menu"
      aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}
      onKeyDown={event => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); } }}>
      {trigger ?? <Icon name={icon} />}
    </button>
    {open ? createPortal(<div ref={menu} id={id} role="menu" aria-label={label} className="ui-menu" style={position} onKeyDown={onKeyDown}>
      {items.map((item, index) => item.kind === 'separator'
        ? <div key={index} role="separator" className="ui-menu-separator" />
        : <button key={index} type="button" role="menuitem" tabIndex={-1} className="ui-menu-item" data-destructive={item.destructive || undefined}
            aria-disabled={item.disabled || undefined} onClick={() => { if (item.disabled) return; close(true); item.onSelect(); }}>
            {item.icon ? <Icon name={item.icon} size={16} /> : <span className="ui-menu-item-spacer" />}<span>{item.label}</span>
          </button>)}
    </div>, document.body) : null}
  </>;
}
```

Append to `packages/agent-remote-lab/src/ui/ui.css`:

```css
.ui-menu {
  position: fixed; z-index: 2000; min-width: 200px; max-width: min(320px, calc(100vw - 16px)); max-height: calc(100dvh - 16px); overflow-y: auto;
  padding: 5px; border-radius: 10px; background: var(--ui-background-elevated); box-shadow: var(--ui-shadow-overlay);
  animation: ui-menu-in var(--ui-duration-short) var(--ui-ease);
}
@keyframes ui-menu-in { from { opacity: 0; transform: scale(0.97) translateY(-4px); } }
.ui-menu-item {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 26px; padding: 3px 8px; border: 0; border-radius: 5px;
  text-align: left; color: var(--ui-label); background: transparent; font: var(--ui-size-callout)/1.3 var(--ui-font); cursor: pointer;
}
.ui-menu-item:focus, .ui-menu-item:hover { outline: none; color: var(--ui-on-accent); background: var(--ui-accent); }
.ui-menu-item[data-destructive] { color: var(--ui-status-failure); }
.ui-menu-item[data-destructive]:focus, .ui-menu-item[data-destructive]:hover { color: var(--ui-on-accent); background: var(--ui-status-failure); }
.ui-menu-item[aria-disabled="true"] { color: var(--ui-label-tertiary); background: transparent; cursor: default; }
.ui-menu-item-spacer { width: 16px; flex: none; }
.ui-menu-separator { height: 1px; margin: 4px 8px; background: var(--ui-separator); }
@media (pointer: coarse) { .ui-menu-item { min-height: 44px; font-size: 15px; } }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/Menu.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-remote-lab/src/ui
git commit -m "feat(lab): add the menu primitive with keyboard navigation

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: Sheet

**Files:**
- Create: `packages/agent-remote-lab/src/ui/Sheet.tsx`, `packages/agent-remote-lab/src/ui/Sheet.test.tsx`
- Modify: `packages/agent-remote-lab/src/ui/ui.css`

- [ ] **Step 1: Write the failing test**

`packages/agent-remote-lab/src/ui/Sheet.test.tsx`:

```tsx
import { act, useState } from 'react';
import { beforeEach, expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { Sheet } from './Sheet.js';

beforeEach(() => {
  // jsdom has no modal dialogs.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); } });
});

function Harness() {
  const [open, setOpen] = useState(false);
  return <><button type="button" onClick={() => setOpen(true)}>Open</button>
    <Sheet open={open} title="Windows" detent="large" onClose={() => setOpen(false)}><p>Body</p></Sheet></>;
}

it('opens as a named modal sheet and closes from its button', async () => {
  const container = await render(<Harness />);
  const dialog = container.querySelector('dialog')!;
  expect(dialog.open).toBe(false);
  await act(async () => container.querySelector('button')!.click());
  expect(dialog.open).toBe(true);
  expect(dialog.getAttribute('aria-label')).toBe('Windows');
  expect(dialog.dataset.detent).toBe('large');
  expect(dialog.querySelector('h2')?.textContent).toBe('Windows');
  await act(async () => (dialog.querySelector('button[aria-label="Close Windows"]') as HTMLButtonElement).click());
  expect(dialog.open).toBe(false);
});

it('closes on Escape and on a tap outside its content', async () => {
  const container = await render(<Harness />);
  const dialog = container.querySelector('dialog')!;
  await act(async () => container.querySelector('button')!.click());
  await act(async () => { dialog.dispatchEvent(new Event('cancel', { cancelable: true })); });
  expect(dialog.open).toBe(false);
  await act(async () => container.querySelector('button')!.click());
  await act(async () => dialog.click());
  expect(dialog.open).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/Sheet.test.tsx`
Expected: FAIL with `Failed to resolve import "./Sheet.js"`.

- [ ] **Step 3: Write the sheet**

`packages/agent-remote-lab/src/ui/Sheet.tsx`:

```tsx
import { useEffect, useRef, type ReactNode } from 'react';
import { IconButton } from './IconButton.js';

/** A bottom sheet on a modal dialog: half height (`medium`) or nearly full (`large`); Escape, a tap outside or Close dismiss it. */
export function Sheet({ open, title, onClose, detent = 'medium', children }: {
  open: boolean; title: string; onClose(): void; detent?: 'medium' | 'large'; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);
  return <dialog ref={dialog} className="ui-sheet" data-detent={detent} aria-label={title}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="ui-sheet-grabber" aria-hidden="true" />
    <header className="ui-sheet-header"><h2>{title}</h2><IconButton icon="close" label={`Close ${title}`} onClick={onClose} /></header>
    <div className="ui-sheet-body">{children}</div>
  </dialog>;
}
```

Append to `packages/agent-remote-lab/src/ui/ui.css`:

```css
.ui-sheet {
  position: fixed; inset: auto 0 0; width: 100%; max-width: 640px; margin: 0 auto; padding: 0; border: 0;
  border-radius: var(--ui-radius-sheet) var(--ui-radius-sheet) 0 0; color: var(--ui-label); background: var(--ui-background-elevated);
  box-shadow: var(--ui-shadow-overlay); max-height: 50dvh; overflow: hidden;
}
.ui-sheet[data-detent="large"] { max-height: calc(100dvh - 44px); }
.ui-sheet[open] { display: flex; flex-direction: column; animation: ui-sheet-in var(--ui-duration) var(--ui-ease-spring); }
.ui-sheet::backdrop { background: var(--ui-backdrop); }
@keyframes ui-sheet-in { from { transform: translateY(100%); } }
.ui-sheet-grabber { width: 36px; height: 5px; margin: 6px auto 0; border-radius: 3px; background: var(--ui-fill-strong); }
.ui-sheet-header { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 16px; }
.ui-sheet-header h2 { flex: 1; margin: 0; font: 600 var(--ui-size-headline)/1.3 var(--ui-font); }
.ui-sheet-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 12px max(12px, env(safe-area-inset-bottom)); }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/Sheet.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-remote-lab/src/ui
git commit -m "feat(lab): add the bottom sheet primitive

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 12: Toolbar

**Files:**
- Create: `packages/agent-remote-lab/src/ui/Toolbar.tsx`, `packages/agent-remote-lab/src/ui/Toolbar.test.tsx`
- Modify: `packages/agent-remote-lab/src/ui/ui.css`

- [ ] **Step 1: Write the failing test**

`packages/agent-remote-lab/src/ui/Toolbar.test.tsx`:

```tsx
import { expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { Toolbar } from './Toolbar.js';

it('shows the current object on the left and its actions on the right', async () => {
  const container = await render(<Toolbar leading={<span data-testid="avatar" />} title="API caching" subtitle="Backend review · Idle"
    trailing={<button type="button">Threads</button>} />);
  const bar = container.querySelector('header.ui-toolbar')!;
  expect(bar.querySelector('[data-testid="avatar"]')).not.toBeNull();
  expect(bar.querySelector('.ui-toolbar-title')?.textContent).toBe('API caching');
  expect(bar.querySelector('.ui-toolbar-subtitle')?.textContent).toBe('Backend review · Idle');
  expect(bar.querySelector('.ui-toolbar-trailing button')?.textContent).toBe('Threads');
});

it('leaves out an empty subtitle', async () => {
  const container = await render(<Toolbar title="Product" />);
  expect(container.querySelector('.ui-toolbar-subtitle')).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/Toolbar.test.tsx`
Expected: FAIL with `Failed to resolve import "./Toolbar.js"`.

- [ ] **Step 3: Write the toolbar**

`packages/agent-remote-lab/src/ui/Toolbar.tsx`:

```tsx
import type { ReactNode } from 'react';

/** The 52px bar above content: the current object (picture, title, subtitle) and its actions. */
export function Toolbar({ leading, title, subtitle, trailing }: { leading?: ReactNode; title: ReactNode; subtitle?: ReactNode; trailing?: ReactNode }) {
  return <header className="ui-toolbar">
    {leading ? <span className="ui-toolbar-leading">{leading}</span> : null}
    <div className="ui-toolbar-heading">
      <div className="ui-toolbar-title">{title}</div>
      {subtitle ? <div className="ui-toolbar-subtitle">{subtitle}</div> : null}
    </div>
    {trailing ? <div className="ui-toolbar-trailing">{trailing}</div> : null}
  </header>;
}
```

Append to `packages/agent-remote-lab/src/ui/ui.css`:

```css
.ui-toolbar {
  display: flex; align-items: center; gap: 10px; flex: none; min-height: 52px; padding: 0 12px 0 16px;
  border-bottom: 1px solid var(--ui-separator); background: var(--ui-background);
}
.ui-toolbar-leading { flex: none; display: inline-flex; }
.ui-toolbar-heading { flex: 1; min-width: 0; }
.ui-toolbar-title, .ui-toolbar-subtitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-toolbar-title { font: 600 var(--ui-size-body)/1.25 var(--ui-font); }
.ui-toolbar-subtitle { color: var(--ui-label-secondary); font-size: var(--ui-size-caption); }
.ui-toolbar-trailing { display: flex; align-items: center; gap: 4px; flex: none; }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/Toolbar.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-remote-lab/src/ui
git commit -m "feat(lab): add the toolbar primitive

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 13: Verify the phase

**Files:** none new; compatibility manifest `packages/agent-remote-lab/compatibility.json` is regenerated.

- [ ] **Step 1: Typecheck and the full Lab unit suite**

Run from `packages/agent-remote-lab`:

```bash
npx tsc --noEmit -p .
pnpm test
```

Expected: no type errors; the suite passes. A failure in a test that asserts colors, class names of the mode switch or bot pictures is updated to the new primitives' output; any other failure is investigated before continuing (run it alone to rule out load flakes).

- [ ] **Step 2: Update and check compatibility**

Run from the worktree root:

```bash
pnpm compatibility:update
pnpm compatibility:check
```

Expected: `Compatibility verified: sha256:…`.

- [ ] **Step 3: Screenshots in both appearances**

Run `pnpm local up` in the worktree (see the `prepare-arc-local` skill), place a few real sessions in a Window and add the Bot appearance as in that skill's references, then save `.tmp/ui/phase1.mjs` and run `node .tmp/ui/phase1.mjs` from the worktree root:

```js
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = process.cwd();
const { origin } = JSON.parse(execFileSync('pnpm', ['--silent', 'local', 'status', '--json'], { cwd: root, encoding: 'utf8' }));
const { chromium } = createRequire(join(root, 'packages/agent-remote-lab/package.json'))('@playwright/test');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
try {
  const page = await context.newPage();
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    await page.locator('main.lab-shell').waitFor();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `.tmp/ui/phase1-window-${scheme}.png` });
    await page.goto(origin + '/?mode=bot', { waitUntil: 'domcontentloaded' });
    await page.locator('main.lab-bot-workspace').waitFor();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `.tmp/ui/phase1-bot-${scheme}.png` });
  }
} finally {
  for (const open of context.pages()) await open.close().catch(() => {});
  await context.request.post(origin + '/auth/logout', { headers: { origin, 'content-type': 'application/json' }, data: '{}' }).catch(() => {});
  await browser.close();
}
```

Expected: four screenshots. Open each and check: no white or light-gray block remains in the dark ones (a remaining one is a literal color to replace with a token); text is readable; code blocks follow the appearance; the mode switch is a segmented control; bot pictures show initials.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-remote-lab/compatibility.json
git commit -m "chore: update compatibility for the UI tokens and primitives

Co-Authored-By: Claude <noreply@anthropic.com>"
```

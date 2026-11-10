// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const lab = fileURLToPath(new URL('..', import.meta.url));
const shared = fileURLToPath(new URL('../../../agent-remote-web/src/styles.css', import.meta.url));
const literal = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\(|:\s*(?:white|black)\b/g;

function stylesheets(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? stylesheets(path) : name.endsWith('.css') ? [path] : [];
  });
}
/** The file's text with every comment blanked out, keeping its offsets and line numbers. */
function uncommented(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '));
}
/** The offsets of the flat rule from `opening` through its first `}`; throws when either is missing. */
function block(path: string, text: string, opening: string): { start: number; end: number } {
  const start = text.indexOf(opening);
  if (start < 0) throw new Error(`${path} has no "${opening}"`);
  const end = text.indexOf('}', start);
  if (end < 0) throw new Error(`${path} has no "}" after "${opening}"`);
  return { start, end: end + 1 };
}
/** Each literal color as `path:line: text`, comments removed, except inside the rules that start with one of `exempt`. */
function offenders(path: string, exempt: string[] = []): string[] {
  const text = uncommented(path);
  const lines = text.split('\n');
  const kept = exempt.map(opening => block(path, text, opening));
  // Matching the whole text also catches a declaration split across lines.
  return [...new Set([...text.matchAll(literal)]
    .filter(match => !kept.some(({ start, end }) => match.index >= start && match.index < end))
    .map(match => {
      const line = text.slice(0, match.index).split('\n').length;
      return `${path}:${line}: ${lines[line - 1]!.trim().slice(0, 120)}`;
    }))];
}

it('keeps every Lab color in the token stylesheet, so dark mode covers it', () => {
  const found = stylesheets(lab).filter(path => !path.endsWith(join('ui', 'tokens.css'))).flatMap(path => offenders(path));
  expect(found).toEqual([]);
});

it('keeps the shared Session View colors in its own default variables', () => {
  // HTML file previews render the file itself on white, whatever the appearance.
  expect(offenders(shared, [':root {', '.agent-file-html {'])).toEqual([]);
});

/** Each declaration of the innermost rules in `text`, with the selector of its rule and its offset. */
function declarations(text: string): { selector: string; property: string; value: string; offset: number }[] {
  return [...text.matchAll(/([^{}]*)\{([^{}]*)\}/g)].flatMap(rule => {
    const body = rule.index + rule[1]!.length + 1;
    return [...rule[2]!.matchAll(/([\w-]+)\s*:([^;]*)/g)].map(declaration => ({
      selector: rule[1]!.trim(), property: declaration[1]!, value: declaration[2]!.trim(), offset: body + declaration.index,
    }));
  });
}
const textColor = /var\(\s*--(?:obs-text|ui-label|agent-ink)\s*[,)]/;

it('mixes no shadow or backdrop from a text color, which would glow in dark mode', () => {
  // Shadows mix from --ui-shadow-ink or --agent-shadow-ink, backdrops use --ui-backdrop or --agent-backdrop.
  // Defining those from a text color, as the shared :root does for standalone pages, is fine.
  const found = [...stylesheets(lab), shared].flatMap(path => {
    const text = uncommented(path);
    return declarations(text)
      .filter(({ selector, property, value }) => (property === 'box-shadow' || selector.includes('::backdrop')) && textColor.test(value))
      .map(({ offset, property, value }) => `${path}:${text.slice(0, offset).split('\n').length}: ${property}: ${value.slice(0, 120)}`);
  });
  expect(found).toEqual([]);
});

/** The `--agent-*` variables the flat rule from `opening` declares. */
function declared(path: string, opening: string): string[] {
  const text = uncommented(path);
  const { start, end } = block(path, text, opening);
  return [...text.slice(start, end).matchAll(/(--agent-[\w-]+)\s*:/g)].map(match => match[1]!);
}
/** Set by components' inline styles (PreviewWorkspace, TimelineEntry, Avatar), not by a stylesheet. */
const scripted = ['--agent-preview-width', '--agent-time-offset', '--agent-time-top', '--ui-avatar-color', '--ui-avatar-size'];

it('gives every shared Session View variable a Lab value and uses no undefined one', () => {
  const defaults = declared(shared, ':root {');
  expect(defaults.length, 'variables in the shared :root block').toBeGreaterThanOrEqual(20);
  const mapped = new Set(declared(join(lab, 'app.css'), '.lab-shell, .lab-session-view, .agent-image-preview, .agent-preview-browser {'));
  // An unmapped variable keeps its light default in the Lab, whatever the appearance.
  expect(defaults.filter(name => !mapped.has(name)), 'shared variables app.css does not map').toEqual([]);

  // An undefined variable leaves its property unset or falls back to a literal, so no token reaches it.
  const files = [...stylesheets(lab), shared];
  const defined = new Set([...scripted, ...files.flatMap(path => [...uncommented(path).matchAll(/(--(?:agent|obs|ui)-[\w-]+)\s*:/g)].map(match => match[1]!))]);
  const undefinedUses = files.flatMap(path => uncommented(path).split('\n').flatMap((line, index) =>
    [...line.matchAll(/var\(\s*(--(?:agent|obs|ui)-[\w-]+)/g)].flatMap(match => defined.has(match[1]!) ? [] : [`${path}:${index + 1}: ${match[1]}`])));
  expect(undefinedUses, 'uses of undefined --agent-*, --obs-* or --ui-* variables').toEqual([]);
});

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

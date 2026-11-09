// @vitest-environment node
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
/** The file's text with every comment blanked out, keeping its line numbers. */
function uncommented(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '));
}
/** Lines with a literal color, comments removed; `allowed` skips lines a file may keep. */
function offenders(path: string, allowed: (line: string) => boolean): string[] {
  return uncommented(path).split('\n').flatMap((line, index) => literal.test(line) && !allowed(line) ? [`${path}:${index + 1}: ${line.trim().slice(0, 120)}`] : []);
}

it('keeps every Lab color in the token stylesheet, so dark mode covers it', () => {
  const found = stylesheets(lab).filter(path => !path.endsWith(join('ui', 'tokens.css'))).flatMap(path => offenders(path, () => false));
  expect(found).toEqual([]);
});

it('keeps the shared Session View colors in its own default variables', () => {
  // HTML file previews render the file itself on white, whatever the appearance.
  expect(offenders(shared, line => /^\s*--agent-[\w-]+\s*:/.test(line) || line.includes('.agent-file-html'))).toEqual([]);
});

/** The `--agent-*` variables a flat rule declares, from `opening` to its first `}`; throws when either is missing. */
function declared(path: string, opening: string): string[] {
  const text = uncommented(path);
  const start = text.indexOf(opening);
  if (start < 0) throw new Error(`${path} has no "${opening}"`);
  const end = text.indexOf('}', start);
  if (end < 0) throw new Error(`${path} has no "}" after "${opening}"`);
  return [...text.slice(start, end).matchAll(/(--agent-[\w-]+)\s*:/g)].map(match => match[1]!);
}
/** Set by the Session View components' inline styles (PreviewWorkspace, TimelineEntry), not by a stylesheet. */
const scripted = ['--agent-preview-width', '--agent-time-offset', '--agent-time-top'];

it('gives every shared Session View variable a Lab value and uses no undefined one', () => {
  const defaults = declared(shared, ':root {');
  expect(defaults.length, 'variables in the shared :root block').toBeGreaterThanOrEqual(20);
  const mapped = new Set(declared(join(lab, 'app.css'), '.lab-shell, .lab-session-view {'));
  // An unmapped variable keeps its light default in the Lab, whatever the appearance.
  expect(defaults.filter(name => !mapped.has(name)), 'shared variables app.css does not map').toEqual([]);

  // An undefined variable leaves its property unset or falls back to a literal, so no token reaches it.
  const files = [...stylesheets(lab), shared];
  const defined = new Set([...scripted, ...files.flatMap(path => [...uncommented(path).matchAll(/(--(?:agent|obs|ui)-[\w-]+)\s*:/g)].map(match => match[1]!))]);
  const undefinedUses = files.flatMap(path => uncommented(path).split('\n').flatMap((line, index) =>
    [...line.matchAll(/var\(\s*(--agent-[\w-]+)/g)].flatMap(match => defined.has(match[1]!) ? [] : [`${path}:${index + 1}: ${match[1]}`])));
  expect(undefinedUses, 'uses of undefined --agent-* variables').toEqual([]);
});

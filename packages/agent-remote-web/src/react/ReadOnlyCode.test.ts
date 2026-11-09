// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { readOnlyHighlight } from './ReadOnlyCode.js';

const syntaxVariables = ['--agent-syntax-keyword', '--agent-syntax-string', '--agent-syntax-literal', '--agent-syntax-comment',
  '--agent-syntax-type', '--agent-syntax-definition', '--agent-syntax-invalid'];

it('colors source only from the syntax variables, so a host can theme each appearance', () => {
  const rules = readOnlyHighlight.module?.getRules() ?? '';
  for (const name of syntaxVariables) expect(rules, name).toContain(`var(${name})`);
  expect(rules, 'literal colors in the highlight style').not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\(/i);
  // A standalone page takes the defaults from the shared :root.
  const root = /:root \{[^}]*\}/.exec(readFileSync(new URL('../styles.css', import.meta.url), 'utf8'))?.[0] ?? '';
  for (const name of syntaxVariables) expect(root, name).toMatch(new RegExp(`${name}:\\s*#[0-9a-f]{6};`));
});

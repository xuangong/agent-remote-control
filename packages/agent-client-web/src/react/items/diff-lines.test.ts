import { expect, it } from 'vitest';
import { diffLines } from './diff-lines.js';

it('tracks separate line numbers across multiple hunks and preserves patch prefixes', () => {
  expect(diffLines('--- a/a\r\n+++ b/a\r\n@@ -1,2 +1,3 @@\r\n keep\r\n---old\r\n+++new\r\n+next\r\n\\ No newline at end of file\r\n@@ -20 +30 @@\r\n-old\r\n+new\r\n')).toEqual([
    { text: '--- a/a', kind: 'meta' }, { text: '+++ b/a', kind: 'meta' },
    { text: '@@ -1,2 +1,3 @@', kind: 'hunk' }, { text: ' keep', kind: 'context', oldLine: 1, newLine: 1 },
    { text: '---old', kind: 'deleted', oldLine: 2 }, { text: '+++new', kind: 'added', newLine: 2 },
    { text: '+next', kind: 'added', newLine: 3 }, { text: '\\ No newline at end of file', kind: 'meta' },
    { text: '@@ -20 +30 @@', kind: 'hunk' }, { text: '-old', kind: 'deleted', oldLine: 20 }, { text: '+new', kind: 'added', newLine: 30 },
  ]);
});

it('does not invent line numbers for snippets, binary notices or unsupported combined hunks', () => {
  for (const patch of ['+snippet\n-old', 'Binary files differ', '@@@ -1,1 -2,2 +3,3 @@@\n+combined']) {
    expect(diffLines(patch).every(line => line.oldLine === undefined && line.newLine === undefined)).toBe(true);
  }
  expect(diffLines('')).toEqual([]);
});

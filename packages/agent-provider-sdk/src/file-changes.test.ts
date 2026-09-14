import { expect, it } from 'vitest';
import { fileChangesResult } from './file-changes.js';
import { TOOL_RESULT_MAX_CHARS } from './tool-result.js';

it('retains a detached snapshot of exact diff text and rename paths', () => {
  const files = [{ path: 'after.ts', previousPath: 'before.ts', kind: 'renamed' as const, diff: '@@ -1 +1 @@\n-old\n+new\n' }];
  const result = fileChangesResult(files);
  expect(result).toEqual({ content: [{ type: 'json', value: { format: 'file_changes', version: 1, files } }] });
  files[0]!.diff = 'changed';
  expect(JSON.stringify(result)).toContain('-old');
});

it('falls back to explicitly truncated text within the existing result budget', () => {
  const result = fileChangesResult([{ path: 'large.ts', kind: 'modified', diff: 'x'.repeat(TOOL_RESULT_MAX_CHARS * 2) }]);
  expect(result.truncated).toBe(true);
  expect(result.content[0]?.type).toBe('text');
  expect(result.content[0]?.type === 'text' && result.content[0].text.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
});

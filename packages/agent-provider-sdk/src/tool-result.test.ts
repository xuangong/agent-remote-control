import { expect, it } from 'vitest';
import { boundToolResult, TOOL_RESULT_MAX_CHARS } from './tool-result.js';
it('bounds long results and preserves command metadata and truncation', () => {
  const result = boundToolResult({ content: [{ type: 'text', text: 'x'.repeat(TOOL_RESULT_MAX_CHARS + 1), stream: 'stdout' }], exitCode: 0 });
  expect(result).toEqual({ content: [{ type: 'text', text: 'x'.repeat(TOOL_RESULT_MAX_CHARS), stream: 'stdout' }], exitCode: 0, truncated: true });
});
it('retains JSON values and empty output without inventing command metadata', () => {
  const result = { content: [{ type: 'json' as const, value: { n: 0, ok: false, empty: null } }, { type: 'text' as const, text: '' }] };
  expect(boundToolResult(result)).toEqual(result);
});

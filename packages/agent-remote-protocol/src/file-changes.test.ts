import { expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { isAgentFileChangesResult } from './file-changes.js';
import { AgentToolResult } from './tool-result.js';

it('uses the existing JSON result contract while validating the versioned presentation format', () => {
  const value = { format: 'file_changes', version: 1, files: [{ path: 'a.ts', kind: 'added', diff: '+first\n' }] };
  expect(isAgentFileChangesResult(value)).toBe(true);
  expect(Value.Check(AgentToolResult, { content: [{ type: 'json', value }] })).toBe(true);
  for (const invalid of [{ ...value, version: 2 }, { ...value, files: [{ path: 'a.ts', kind: 'native-update', diff: '' }] },
    { ...value, files: [{ path: '', kind: 'added', diff: '' }] }, { ...value, extra: true }]) {
    expect(isAgentFileChangesResult(invalid)).toBe(false);
  }
});

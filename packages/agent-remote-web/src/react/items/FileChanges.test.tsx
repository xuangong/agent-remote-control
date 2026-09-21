import { act } from 'react';
import { expect, it } from 'vitest';
import type { AgentToolResultJson } from '@orchardworks/agent-remote-protocol';
import { render } from '../../test/setup.js';
import { ToolCallItem } from './ToolCallItem.js';

const diff = '--- a/a.ts\n+++ b/a.ts\n@@ -4,2 +4,2 @@\n keep\n-old\n+<img src=x onerror=alert(1)>\n\\ No newline at end of file';
async function renderResult(value: AgentToolResultJson) {
  const container = await render(<ToolCallItem item={{ type: 'tool_call', callId: 'edit', name: 'file_change',
    status: 'completed', error: null, detail: { type: 'edit', filePath: 'a.ts' }, result: { content: [{ type: 'json', value }] },
  }} />);
  await act(async () => container.querySelector<HTMLButtonElement>('.agent-tool-toggle')!.click());
  return container;
}

it('renders normalized changes with file identity, counts and hunk line numbers as inert text', async () => {
  const container = await renderResult({ format: 'file_changes', version: 1, files: [
    { path: 'a.ts', kind: 'modified', diff },
    { path: 'new.ts', previousPath: 'old.ts', kind: 'renamed', diff: '' },
  ] });
  expect(container.querySelectorAll('.agent-file-change')).toHaveLength(2);
  expect(container.textContent).toContain('Modified');
  expect(container.textContent).toContain('Renamed');
  expect(container.textContent).toContain('old.ts');
  expect(container.querySelector('.agent-diff-stats')?.textContent).toBe('+1−1');
  const added = container.querySelector('[data-line-kind="added"]')!;
  expect(added.querySelector('[data-new-line]')?.textContent).toBe('5');
  expect(added.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(container.querySelector('[data-line-kind="deleted"] [data-old-line]')?.textContent).toBe('5');
  expect(container.querySelector('img')).toBeNull();
});

it('renders legacy path/diff arrays without interpreting native kind metadata', async () => {
  const container = await renderResult([{ path: 'a.ts', kind: { type: 'update' }, diff }]);
  expect(container.querySelectorAll('.agent-file-change')).toHaveLength(1);
  expect(container.textContent).toContain('File change');
  expect(container.textContent).toContain('Raw result');
});

it('keeps unknown versions and malformed change payloads in the generic result view', async () => {
  for (const value of [{ format: 'file_changes', version: 2, files: [] }, [{ path: 'a.ts', diff: 12 }]]) {
    const container = await renderResult(value);
    expect(container.querySelector('.agent-file-change')).toBeNull();
    expect(container.querySelector('.agent-tool-result pre')?.textContent).toContain(JSON.stringify(value, null, 2));
  }
});

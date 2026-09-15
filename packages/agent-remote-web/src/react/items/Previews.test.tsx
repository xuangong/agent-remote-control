import { act } from 'react';
import { expect, it } from 'vitest';
import type { AgentTimelineItem } from '@borgee/agent-remote-protocol';
import { render, rerender } from '../../test/setup.js';
import { ToolCallItem } from './ToolCallItem.js';
import { ReasoningItem } from './ReasoningItem.js';
import { ErrorItem } from './ErrorItem.js';
import { CompletedQuestionItem } from './CompletedQuestionItem.js';

const output = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n');
const tool: Extract<AgentTimelineItem, { type: 'tool_call' }> = { type: 'tool_call', callId: 'read', name: 'read', status: 'completed',
  error: null, detail: { type: 'read', filePath: '/workspace/file.ts' }, result: { content: [{ type: 'text', text: output }] } };

it('shows bounded tool output by default and preserves a manual collapse on updates', async () => {
  const container = await render(<ToolCallItem item={tool} />);
  expect(container.querySelector('.agent-tool-preview')?.textContent).toContain('line 0');
  expect(container.querySelector('.agent-tool-preview')?.textContent).not.toContain('line 29');
  await act(async () => container.querySelector<HTMLButtonElement>('.agent-tool-toggle')!.click());
  expect(container.querySelector('.agent-tool-details')?.textContent).toContain('line 29');
  await act(async () => container.querySelector<HTMLButtonElement>('.agent-tool-toggle')!.click());
  await rerender(container, <ToolCallItem item={{ ...tool, result: { content: [{ type: 'text', text: 'new output' }] } }} />);
  expect(container.querySelector('.agent-tool-preview')).toBeNull();
  expect(container.querySelector<HTMLElement>('.agent-tool-details')?.hidden).toBe(true);
});

it('exposes a file diff preview without opening the tool disclosure', async () => {
  const container = await render(<ToolCallItem item={{ ...tool, detail: { type: 'edit', filePath: 'a.ts' }, result: { content: [{ type: 'json', value: [
    { path: 'a.ts', diff: '@@ -1 +1 @@\n-old\n+new' },
  ] }] } }} />);
  expect(container.querySelector('.agent-file-preview')?.textContent).toContain('+new');
  expect(container.querySelector('.agent-file-preview')?.textContent).toContain('a.ts');
  expect(container.querySelector('.agent-tool-toggle')?.getAttribute('aria-expanded')).toBe('false');
});

it('previews supplied reasoning and multiline diagnostics as inert text', async () => {
  for (const Component of [ReasoningItem, ErrorItem]) {
    const container = await render(Component === ReasoningItem
      ? <ReasoningItem item={{ type: 'reasoning', text: '<script>alert(1)</script>\nNext step' }} />
      : <ErrorItem item={{ type: 'error', message: '<script>alert(1)</script>\nNext step' }} />);
    expect(container.querySelector('.agent-content-preview')?.textContent).toContain('Next step');
    expect(container.querySelector('script')).toBeNull();
  }
});

it('shows question context alongside the answer while retaining sensitive answer redaction', async () => {
  const container = await render(<CompletedQuestionItem request={{ kind: 'question', requestId: 'q', questions: [{
    questionId: 'one', header: 'Choice', prompt: 'Which directory should be used?', selection: 'single', required: true,
    options: [], allowCustomText: true, allowDismiss: false, sensitive: true,
  }] }} response={{ kind: 'question', answers: [{ questionId: 'one', selectedValues: [], customText: 'secret-value' }] }} />);
  expect(container.querySelector('.agent-content-preview')?.textContent).toContain('Which directory');
  expect(container.textContent).not.toContain('secret-value');
});

it('makes a reported empty search result explicit without inventing output for pending tools', async () => {
  const container = await render(<ToolCallItem item={{ ...tool, detail: { type: 'search', query: 'missing symbol' },
    result: { content: [{ type: 'json', value: [] }] } }} />);
  expect(container.querySelector('.agent-tool-preview')?.textContent).toContain('No results.');
  await rerender(container, <ToolCallItem item={{ ...tool, status: 'running', result: undefined }} />);
  expect(container.querySelector('.agent-tool-preview')?.textContent).not.toContain('No results.');
  expect(container.querySelector('.agent-tool-result-preview')).toBeNull();
});

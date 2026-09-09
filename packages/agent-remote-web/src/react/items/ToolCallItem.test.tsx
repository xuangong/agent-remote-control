import { act } from 'react';
import { describe, expect, it } from 'vitest';
import type { AgentTimelineItem } from '@borgee/agent-remote-protocol';

import { render, rerender } from '../../test/setup.js';
import { ToolCallItem } from './ToolCallItem.js';

describe('ToolCallItem', () => {
  it('discloses complete tool details and preserves the disclosure while the call updates', async () => {
    const item: Extract<AgentTimelineItem, { type: 'tool_call' }> = {
      type: 'tool_call', callId: 'shell-one', name: 'shell', status: 'running', error: null,
      detail: { type: 'shell', command: 'git status\n  --short', cwd: '/workspace/project' },
    };
    const container = await render(<ToolCallItem item={item} />);
    const toggle = container.querySelector<HTMLButtonElement>('.agent-tool-toggle');

    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.textContent).toContain('shell');
    expect(toggle?.textContent).toContain('Running');
    expect(container.querySelector('.agent-tool-summary')?.textContent).toBe('git status --short');
    const details = container.querySelector<HTMLElement>('.agent-tool-details')!;
    expect(details.hidden).toBe(true);
    await act(async () => toggle?.click());
    expect(details.hidden).toBe(false);
    expect(details.textContent).toContain('/workspace/project');

    await rerender(container, <ToolCallItem item={{ ...item, status: 'completed' }} />);
    expect(container.querySelector('.agent-tool-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.agent-state-label')?.textContent).toBe('Completed');
    expect(container.querySelector<HTMLElement>('.agent-tool-details')?.hidden).toBe(false);
  });

  it('keeps a failed call and its error visible with the details collapsed', async () => {
    const container = await render(<ToolCallItem item={{
      type: 'tool_call', callId: 'read-one', name: 'read', status: 'failed', error: 'File is unavailable.',
      detail: { type: 'read', filePath: '/workspace/missing.txt' },
    }} />);

    expect(container.querySelector('.agent-tool-toggle')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.agent-tool-summary')?.textContent).toBe('/workspace/missing.txt');
    expect(container.querySelector('[role="alert"]')?.closest('[hidden]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('File is unavailable.');
  });
});

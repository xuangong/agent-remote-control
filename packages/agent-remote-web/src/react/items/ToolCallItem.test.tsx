import { act } from 'react';
import { describe, expect, it } from 'vitest';
import type { AgentTimelineItem } from '@agent-remote-controller/agent-remote-protocol';

import { render, rerender } from '../../test/setup.js';
import { ToolCallItem } from './ToolCallItem.js';
import { TimelineDisplay } from '../TimelineDisplay.js';

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

  it.each(['preview', 'simple'] as const)('keeps failure status visible while disclosing the full error in %s mode', async mode => {
    const error = `File is unavailable.\n${Array.from({ length: 20 }, (_, index) => `Diagnostic line ${index}`).join('\n')}`;
    const item: Extract<AgentTimelineItem, { type: 'tool_call' }> = {
      type: 'tool_call', callId: 'read-one', name: 'read', status: 'failed', error,
      detail: { type: 'read', filePath: '/workspace/missing.txt' },
    };
    const renderItem = (message = error) => <TimelineDisplay.Provider value={mode}><ToolCallItem item={{ ...item, error: message }} /></TimelineDisplay.Provider>;
    const container = await render(renderItem());

    const toggle = container.querySelector<HTMLButtonElement>('.agent-tool-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('Failed');
    expect(container.querySelector('.agent-tool-summary')?.textContent).toBe('/workspace/missing.txt');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    if (mode === 'simple') expect(container.querySelector('.agent-tool-preview')).toBeNull();
    else expect(container.querySelector('.agent-tool-preview')?.textContent).toContain('File is unavailable.');
    expect(container.textContent).not.toContain('Diagnostic line 19');

    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.agent-tool-details [role="alert"]')?.textContent).toBe(error);
    await act(async () => toggle.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('.agent-tool-preview')).toBeNull();
    await rerender(container, renderItem(`${error}\nMore diagnostics`));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('More diagnostics');
  });
});

it('shows output and command metadata inside the existing disclosure without interpreting output as HTML', async () => {
  const container = await render(<ToolCallItem item={{
    type: 'tool_call', callId: 'command-result', name: 'shell', status: 'completed', error: null,
    detail: { type: 'shell', command: 'echo hello' },
    result: { content: [{ type: 'text', stream: 'combined', text: '<img src=x onerror=alert(1)>\nhello' }, { type: 'json', value: { count: 2 } }], exitCode: 0, durationMs: 12, truncated: true },
  }} />);
  await act(async () => container.querySelector<HTMLButtonElement>('.agent-tool-toggle')!.click());
  const result = container.querySelector('[aria-label="Tool result"]');
  expect(result?.textContent).toContain('hello');
  expect(result?.textContent).toContain('Exit code 0');
  expect(result?.textContent).toContain('12 ms');
  expect(result?.textContent).toContain('truncated');
  expect(result?.textContent).toContain('"count": 2');
  expect(container.querySelector('img')).toBeNull();
});

it('links normalized session identity independently of the tool disclosure and reports navigation failure', async () => {
  const opened: string[] = [];
  const item: Extract<AgentTimelineItem, { type: 'tool_call' }> = {
    type: 'tool_call', callId: 'activity', name: 'agent.activity', status: 'completed', error: null,
    detail: { type: 'other', description: 'Agent /root/review: interacted', sessionReference: { nativeSessionId: 'review-id', title: '/root/review' } },
  };
  const container = await render(<ToolCallItem item={item} resolveSessionLink={id => ({ href: '/?session=review-id', open: async () => { opened.push(id); } })} />);
  const link = container.querySelector<HTMLAnchorElement>('a')!;
  expect(link.textContent).toBe('/root/review');
  expect(link.closest('button')).toBeNull();
  await act(async () => link.click());
  expect(opened).toEqual(['review-id']);
  expect(container.querySelector<HTMLElement>('.agent-tool-details')!.hidden).toBe(true);
  await act(async () => container.querySelector<HTMLButtonElement>('.agent-tool-name-toggle')!.click());
  expect(container.querySelector<HTMLElement>('.agent-tool-details')!.hidden).toBe(false);
  await rerender(container, <ToolCallItem item={item} resolveSessionLink={() => ({ href: '/?session=review-id', open: async () => { throw new Error('Child is unavailable'); } })} />);
  await act(async () => container.querySelector<HTMLAnchorElement>('a')!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Child is unavailable');
  await rerender(container, <ToolCallItem item={item} resolveSessionLink={() => undefined} />);
  expect(container.querySelector('a')).toBeNull();
  expect(container.querySelector('.agent-tool-summary')?.textContent).toBe('Agent /root/review: interacted');
});

it('shows all wait targets using resolved paths while retaining unresolved identities', async () => {
  const opened: string[] = [];
  const item: Extract<AgentTimelineItem, { type: 'tool_call' }> = {
    type: 'tool_call', callId: 'wait', name: 'agent.wait', status: 'running', error: null,
    detail: { type: 'other', description: 'Waiting for agent updates:', sessionReferences: [
      { nativeSessionId: 'review-id', title: 'review-id' },
      { nativeSessionId: 'test-id', title: 'test-id' },
      { nativeSessionId: 'missing-id', title: 'missing-id' },
    ] },
  };
  const container = await render(<ToolCallItem item={item} resolveSessionLink={id => id === 'missing-id' ? undefined : ({
    title: id === 'review-id' ? '/root/review' : '/root/tests', href: `/?session=${id}`, open: async () => { opened.push(id); },
  })} />);
  const summary = container.querySelector('.agent-tool-summary')!;
  expect(summary.textContent).toBe('Waiting for agent updates: /root/review, /root/tests, missing-id');
  const links = [...summary.querySelectorAll('a')];
  expect(links).toHaveLength(2);
  for (const link of links) {
    expect(link.closest('button')).toBeNull();
    await act(async () => link.click());
  }
  expect(opened).toEqual(['review-id', 'test-id']);
  expect(container.querySelector<HTMLElement>('.agent-tool-details')!.hidden).toBe(true);
  await rerender(container, <ToolCallItem item={item} />);
  expect(container.querySelector('.agent-tool-summary')!.textContent).toBe('Waiting for agent updates: review-id, test-id, missing-id');
});

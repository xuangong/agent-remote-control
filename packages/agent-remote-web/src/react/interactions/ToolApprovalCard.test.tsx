import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentInteractionRequest, AgentInteractionResponse } from '@orchardworks/agent-remote-protocol';

import { render } from '../../test/setup.js';
import { InteractionPanel } from '../InteractionPanel.js';
import { InteractionItem } from '../items/InteractionItem.js';

const request: Extract<AgentInteractionRequest, { kind: 'tool_approval' }> = {
  kind: 'tool_approval', requestId: 'command', toolCallId: 'call', toolName: 'command',
  summary: 'Read the source before changing permissions.',
  detail: { type: 'shell', command: 'curl.exe -L https://example.test/source.ts', cwd: 'C:\\Users\\developer\\project' },
  context: [{ label: 'Environment', value: 'local' }],
  allowedDecisions: ['allow', 'cancel', 'deny'], allowScopes: ['once', 'session', 'policy'],
  policies: [{ policyId: 'deny-host', description: 'Deny network host example.test for future requests' }],
};

describe('tool approval', () => {
  it('keeps exact rule descriptions separate from actions and never infers their decision semantics', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const container = await render(<InteractionPanel request={request} onResponse={respond} />);
    const rules = container.querySelector('details')!;
    expect(rules.open).toBe(false);
    await act(async () => rules.querySelector('summary')!.click());
    expect(rules.open).toBe(true);
    expect(respond).not.toHaveBeenCalled();
    const apply = rules.querySelector('button')!;
    expect(apply.textContent).toBe('Apply rule');
    expect(document.getElementById(apply.getAttribute('aria-describedby')!)?.textContent).toBe(request.policies![0]!.description);
    await act(async () => apply.click());
    expect(respond).toHaveBeenCalledExactlyOnceWith('command', { kind: 'tool_approval', decision: 'allow', scope: 'policy', policyId: 'deny-host' });
    expect([...container.querySelectorAll('button')].every(button => button.disabled)).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Submitting…');
  });

  it.each(['once', 'session'] as const)('submits only the chosen %s scope and preserves the request after failure', async scope => {
    const respond = vi.fn().mockRejectedValueOnce(new Error('Host disconnected')).mockResolvedValue(undefined);
    const container = await render(<InteractionPanel request={request} onResponse={respond} />);
    const button = container.querySelector<HTMLButtonElement>(`[data-scope="${scope}"]`)!;
    await act(async () => button.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Host disconnected');
    expect(container.querySelector('pre')?.textContent).toBe(request.detail.type === 'shell' ? request.detail.command : '');
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond).toHaveBeenLastCalledWith('command', { kind: 'tool_approval', decision: 'allow', scope });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(['cancel', 'deny'] as const)('only offers and submits the permitted %s decision', async decision => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const container = await render(<InteractionPanel request={{ ...request, allowedDecisions: [decision] }} onResponse={respond} />);
    expect(container.querySelector('details')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(1);
    await act(async () => container.querySelector('button')!.click());
    expect(respond).toHaveBeenCalledExactlyOnceWith('command', { kind: 'tool_approval', decision });
  });

  it.each([
    [{ kind: 'tool_approval', decision: 'allow', scope: 'once' }, 'Allowed once'],
    [{ kind: 'tool_approval', decision: 'allow', scope: 'session' }, 'Allowed for session'],
    [{ kind: 'tool_approval', decision: 'allow', scope: 'policy', policyId: 'deny-host' }, 'Rule applied'],
    [{ kind: 'tool_approval', decision: 'cancel' }, 'Canceled'],
    [{ kind: 'tool_approval', decision: 'deny', message: 'Needs review first.' }, 'Denied'],
  ] satisfies [Extract<AgentInteractionResponse, { kind: 'tool_approval' }>, string][])('keeps completed approvals compact and discloses the full receipt: %s', async (response, label) => {
    const container = await render(<InteractionItem item={{ type: 'interaction', request, response }} />);
    const toggle = container.querySelector('button')!;
    const details = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(toggle.textContent).toContain(label);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(details.hidden).toBe(true);
    expect(container.querySelector('pre')).toBeNull();
    await act(async () => toggle.click());
    expect(details.hidden).toBe(false);
    expect(details.textContent).toContain(request.summary);
    expect(details.textContent).toContain('C:\\Users\\developer\\project');
    expect(details.textContent).toContain('Environment');
    expect(details.textContent).toContain('local');
    if (response.decision === 'allow' && response.scope === 'policy') expect(details.textContent).toContain(request.policies![0]!.description);
    if (response.decision === 'deny') expect(details.textContent).toContain(response.message);
    expect(container.querySelectorAll('button')).toHaveLength(1);
    await act(async () => toggle.click());
    expect(details.hidden).toBe(true);
  });
});

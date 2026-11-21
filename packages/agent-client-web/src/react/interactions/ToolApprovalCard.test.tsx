// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentInteractionRequest, AgentInteractionResponse } from '@orchardworks/agent-remote-protocol';

import { render } from '../../test/setup.js';
import { InteractionPanel } from '../InteractionPanel.js';
import { InteractionItem } from '../items/InteractionItem.js';
import { showChanges } from '../../test/interactions.js';

const request: Extract<AgentInteractionRequest, { kind: 'tool_approval' }> = {
  kind: 'tool_approval', requestId: 'command', toolCallId: 'call', toolName: 'command',
  summary: 'Read the source before changing permissions.',
  detail: { type: 'shell', command: 'curl.exe -L https://example.test/source.ts', cwd: 'C:\\Users\\developer\\project' },
  context: [{ label: 'Environment', value: 'local' }],
  allowedDecisions: ['allow', 'cancel', 'deny'], allowScopes: ['once', 'session', 'policy'],
  policies: [{ policyId: 'deny-host', description: 'Deny network host example.test for future requests' }],
};

describe('tool approval', () => {
  it('asks in plain words: Allow sends allow once, Not now sends deny, Show what changes opens every decision and the command', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const container = await render(<InteractionPanel request={{ ...request, detail: { type: 'write', filePath: '/w/notes.md' } }} onResponse={respond} assistantName="Chief" />);
    expect(container.querySelector('.orchard-approval-prompt')?.textContent).toBe('Chief wants to write notes.md');
    const pills = [...container.querySelectorAll<HTMLElement>('.orchard-approval-choices > button, .orchard-approval-choices > details > summary')];
    expect(pills.map(pill => pill.textContent)).toEqual(['Allow', 'Not now', 'Show what changes']);
    const changes = container.querySelector<HTMLDetailsElement>('details.agent-approval-changes')!;
    expect(changes.open).toBe(false);
    await act(async () => pills[2]!.click());
    expect(changes.open).toBe(true);
    expect(pills[2]!.textContent).toBe('Hide what changes');
    expect(container.querySelector('[data-scope="session"]')?.textContent).toBe('Allow for session');
    expect(container.querySelector('.agent-approval-rules summary')?.textContent).toContain('Rules for future requests');
    expect(container.textContent).toContain('/w/notes.md');
    await act(async () => pills[0]!.click());
    expect(respond).toHaveBeenLastCalledWith('command', { kind: 'tool_approval', decision: 'allow', scope: 'once' });
    const refusing = await render(<InteractionPanel request={request} onResponse={respond} assistantName="Chief" />);
    await act(async () => refusing.querySelector<HTMLButtonElement>('.orchard-approval-choices > button[data-decision="deny"]')!.click());
    expect(respond).toHaveBeenLastCalledWith('command', { kind: 'tool_approval', decision: 'deny' });
  });


  it('keeps exact rule descriptions separate from actions and never infers their decision semantics', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const container = await render(<InteractionPanel request={request} onResponse={respond} />);
    expect(container.querySelector<HTMLDetailsElement>('details.agent-approval-changes')!.open).toBe(false);
    await showChanges(container);
    const rules = container.querySelector<HTMLDetailsElement>('details.agent-approval-rules')!;
    expect(rules.open).toBe(false);
    await act(async () => rules.querySelector('summary')!.click());
    expect(rules.open).toBe(true);
    expect(respond).not.toHaveBeenCalled();
    const apply = rules.querySelector('button')!;
    expect(apply.textContent).toBe('Apply rule');
    expect(document.getElementById(apply.getAttribute('aria-describedby')!)?.textContent).toBe(request.policies![0]!.description);
    await act(async () => apply.click());
    expect(respond).toHaveBeenCalledExactlyOnceWith('command', { kind: 'tool_approval', decision: 'allow', scope: 'policy', policyId: 'deny-host' });
    expect([...container.querySelectorAll<HTMLButtonElement>('[data-decision], [data-policy-id]')].every(button => button.disabled)).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Submitting…');
  });

  it.each(['once', 'session'] as const)('submits only the chosen %s scope and preserves the request after failure', async scope => {
    const respond = vi.fn().mockRejectedValueOnce(new Error('Host disconnected')).mockResolvedValue(undefined);
    const container = await render(<InteractionPanel request={request} onResponse={respond} />);
    // Allow is once; every scope, with the command, is under Show what changes.
    expect(container.querySelector('[data-scope="session"]')?.closest('details:not([open])')).not.toBeNull();
    await showChanges(container);
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

  it.each([
    ['[data-decision="deny"]', { kind: 'tool_approval', decision: 'deny' }],
    ['[data-decision="cancel"]', { kind: 'tool_approval', decision: 'cancel' }],
    ['[data-scope="once"]', { kind: 'tool_approval', decision: 'allow', scope: 'once' }],
  ] as const)('sends the decision of the button %s chosen in the list of changes', async (selector, response) => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const container = await render(<InteractionPanel request={request} onResponse={respond} />);
    await showChanges(container);
    await act(async () => container.querySelector<HTMLButtonElement>(`.agent-approval-actions ${selector}`)!.click());
    expect(respond).toHaveBeenCalledExactlyOnceWith('command', response);
  });

  it.each(['cancel', 'deny'] as const)('only offers and submits the permitted %s decision', async decision => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const container = await render(<InteractionPanel request={{ ...request, allowedDecisions: [decision] }} onResponse={respond} />);
    expect(container.querySelector('details.agent-approval-rules')).toBeNull();
    expect(container.querySelectorAll('.orchard-approval-choices > [data-decision]')).toHaveLength(1);
    expect(container.querySelector('[data-decision]')?.textContent).toBe('Not now');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-decision]')!.click());
    expect(respond).toHaveBeenCalledExactlyOnceWith('command', { kind: 'tool_approval', decision });
  });

  it.each([
    [{ kind: 'tool_approval', decision: 'allow', scope: 'once' }, 'Allowed once'],
    [{ kind: 'tool_approval', decision: 'allow', scope: 'session' }, 'Allowed for this session'],
    [{ kind: 'tool_approval', decision: 'allow', scope: 'policy', policyId: 'deny-host' }, 'Rule applied'],
    [{ kind: 'tool_approval', decision: 'cancel' }, 'Canceled'],
    [{ kind: 'tool_approval', decision: 'deny', message: 'Needs review first.' }, 'Not allowed'],
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

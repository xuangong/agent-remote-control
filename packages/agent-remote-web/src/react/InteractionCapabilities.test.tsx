import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { AgentInteractionRequest } from '@borgee/agent-remote-protocol';
import { render, rerender } from '../test/setup.js';
import { InteractionPanel } from './InteractionPanel.js';
import { InteractionItem } from './items/InteractionItem.js';

const form = {
  kind: 'form', requestId: 'form', title: 'Connect workspace', message: 'Choose settings', fields: [
    { type: 'text', fieldId: 'token', label: 'Access token', required: true, sensitive: true },
    { type: 'number', fieldId: 'count', label: 'Count', required: true, integer: true, minimum: 1, maximum: 10 },
    { type: 'boolean', fieldId: 'enabled', label: 'Enabled', required: true, defaultValue: false },
    { type: 'select', fieldId: 'region', label: 'Region', required: true, options: [{ value: 'west', label: 'West' }] },
  ],
} as AgentInteractionRequest;

it('submits typed form values, masks sensitive input, and retains input after failure', async () => {
  const respond = vi.fn().mockRejectedValueOnce(new Error('Try again')).mockResolvedValue(undefined);
  const container = await render(<InteractionPanel request={form} onResponse={respond} />);
  const token = container.querySelector<HTMLInputElement>('input[name="token"]')!;
  expect(token?.type).toBe('password');
  await type(token, 'local-secret');
  await type(container.querySelector<HTMLInputElement>('input[name="count"]')!, '3');
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('select[name="region"]')!;
    select.value = 'west'; select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(respond).toHaveBeenLastCalledWith('form', { kind: 'form', action: 'submit', values: { token: 'local-secret', count: 3, enabled: false, region: 'west' } });
  expect(container.textContent).toContain('Try again');
  expect(token.value).toBe('local-secret');
});

it('renders exact permission scope buttons and returns only the chosen scope', async () => {
  const respond = vi.fn();
  const request = { kind: 'permission_approval', requestId: 'permission', summary: 'Read source', permissions: [{ resource: 'filesystem', access: 'read', target: '/workspace/src' }], allowScopes: ['turn'] } as AgentInteractionRequest;
  const container = await render(<InteractionPanel request={request} onResponse={respond} />);
  expect(container.textContent).toContain('/workspace/src');
  expect(container.querySelector('[data-scope="session"]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-scope="turn"]')!.click());
  expect(respond).toHaveBeenCalledWith('permission', { kind: 'permission_approval', decision: 'allow', scope: 'turn' });
});

it('requires explicit acknowledgement for an external action and rejects executable URLs', async () => {
  const respond = vi.fn();
  const request = { kind: 'external_action', requestId: 'external', title: 'Authorize service', message: 'Continue in browser', url: 'https://example.com/connect' } as AgentInteractionRequest;
  const container = await render(<InteractionPanel request={request} onResponse={respond} />);
  expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/connect');
  expect(respond).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-action="completed"]')!.click());
  expect(respond).toHaveBeenCalledWith('external', { kind: 'external_action', action: 'completed' });
  const invalid = await render(<InteractionPanel request={{ ...request, url: 'javascript:alert(1)' } as AgentInteractionRequest} onResponse={respond} />);
  expect(invalid.querySelector('a')).toBeNull();
  expect(invalid.querySelector('[data-action="completed"]')).toBeNull();
});

it('renders a policy choice without inventing other approval scopes', async () => {
  const respond = vi.fn();
  const request = { kind: 'tool_approval', requestId: 'tool', toolCallId: 'call', toolName: 'command', summary: 'Connect to docs', detail: { type: 'other', description: 'Network request' }, allowedDecisions: ['allow', 'cancel'], allowScopes: ['policy'], policies: [{ policyId: 'allow-host', description: 'Allow docs.example.com for future requests' }] } as AgentInteractionRequest;
  const container = await render(<InteractionPanel request={request} onResponse={respond} />);
  expect(container.querySelector('[data-scope="session"]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-policy-id="allow-host"]')!.click());
  expect(respond).toHaveBeenCalledWith('tool', { kind: 'tool_approval', decision: 'allow', scope: 'policy', policyId: 'allow-host' });
});

it('does not render sensitive question answers or form values in completed receipts', async () => {
  const request = { kind: 'question', requestId: 'secret', questions: [{ questionId: 'token', header: 'Token', prompt: 'Enter token', required: true, selection: 'single', options: [], allowCustomText: true, allowDismiss: true, sensitive: true }] } as AgentInteractionRequest;
  const container = await render(<InteractionItem item={{ type: 'interaction', request, response: { kind: 'question', answers: [{ questionId: 'token', selectedValues: [], customText: 'never-display' }] } }} />);
  expect(container.textContent).not.toContain('never-display');
  expect(container.textContent).toContain('Hidden');
  const receipt = await render(<InteractionItem item={{ type: 'interaction', request: form, response: { kind: 'form', action: 'submit', values: { token: 'never-display', count: 3, enabled: false, region: 'west' } } } as never} />);
  expect(receipt.textContent).not.toContain('never-display');
  expect(receipt.textContent).toContain('Hidden');
});

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('preserves exact sensitive question text on submission', async () => {
  const respond = vi.fn();
  const request = { kind: 'question', requestId: 'secret', questions: [{ questionId: 'token', header: 'Token', prompt: 'Enter token', required: true, selection: 'single', options: [], allowCustomText: true, allowDismiss: true, sensitive: true }] } as AgentInteractionRequest;
  const container = await render(<InteractionPanel request={request} onResponse={respond} />);
  await type(container.querySelector<HTMLInputElement>('input[type="password"]')!, '  exact secret  ');
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(respond).toHaveBeenCalledWith('secret', { kind: 'question', answers: [{ questionId: 'token', selectedValues: [], customText: '  exact secret  ' }] });
});

it('submits explicit empty multiselect arrays when the request permits them', async () => {
  const respond = vi.fn();
  const request = { kind: 'form', requestId: 'empty', title: 'Choose', message: '', fields: [
    { type: 'multiselect', fieldId: 'required', label: 'Required', required: true, minItems: 0, defaultValue: [], options: [{ value: 'one', label: 'One' }] },
    { type: 'multiselect', fieldId: 'absent', label: 'Unselected optional', required: false, minItems: 1, options: [{ value: 'one', label: 'One' }] },
    { type: 'multiselect', fieldId: 'optional', label: 'Optional', required: false, defaultValue: ['one'], options: [{ value: 'one', label: 'One' }] },
  ] } as AgentInteractionRequest;
  const container = await render(<InteractionPanel request={request} onResponse={respond} />);
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('select[name="optional"]')!;
    select.options[0]!.selected = false;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(respond).toHaveBeenCalledWith('empty', { kind: 'form', action: 'submit', values: { required: [], optional: [] } });
});

it('keeps form drafts in memory across offline and reconnect without submitting', async () => {
  const respond = vi.fn();
  const container = await render(<InteractionPanel request={form} onResponse={respond} />);
  await type(container.querySelector<HTMLInputElement>('input[name="token"]')!, 'retained-secret');
  await rerender(container, <InteractionPanel request={form} />);
  expect(container.querySelector<HTMLInputElement>('input[name="token"]')?.value).toBe('retained-secret');
  expect(container.querySelector('fieldset')?.disabled).toBe(true);
  expect(respond).not.toHaveBeenCalled();
  await rerender(container, <InteractionPanel request={form} onResponse={respond} />);
  expect(container.querySelector<HTMLInputElement>('input[name="token"]')?.value).toBe('retained-secret');
  expect(container.querySelector('fieldset')?.disabled).toBe(false);
  expect(respond).not.toHaveBeenCalled();
});

it('distinguishes required property presence from a nonempty text constraint', async () => {
  const respond = vi.fn();
  const request = { kind: 'form', requestId: 'text', title: 'Details', message: '', fields: [
    { type: 'text', fieldId: 'empty', label: 'Empty allowed', required: true },
    { type: 'text', fieldId: 'nonempty', label: 'Nonempty', required: true, minLength: 1 },
  ] } as AgentInteractionRequest;
  const container = await render(<InteractionPanel request={request} onResponse={respond} />);
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(respond).not.toHaveBeenCalled();
  await type(container.querySelector<HTMLInputElement>('input[name="nonempty"]')!, 'value');
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(respond).toHaveBeenCalledWith('text', { kind: 'form', action: 'submit', values: { empty: '', nonempty: 'value' } });
});

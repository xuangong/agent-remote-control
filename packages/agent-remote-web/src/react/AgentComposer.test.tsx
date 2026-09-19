import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { createReplicaState } from '../replica/reducer.js';
import type { AgentReplicaState } from '../replica/types.js';
import { render, rerender } from '../test/setup.js';
import { AgentComposer } from './AgentComposer.js';

it('allows cached-session drafts while synchronizing but waits for readiness to send or execute commands', async () => {
  const state: AgentReplicaState = { ...createReplicaState(), agent: {
    id: 'cached', providerId: 'test', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', status: 'idle', activeTurn: null,
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false },
    pendingInteractions: [], runtimeInfo: { providerId: 'test', status: 'idle' },
  } };
  let resolve!: () => void;
  const send = vi.fn(() => new Promise<void>(done => { resolve = done; }));
  const command = vi.fn(async () => ({}));
  const draft = vi.fn();
  const view = (disabled: boolean, current = state) => <AgentComposer state={current} disabled={disabled} onDraftChange={draft}
    onSendMessage={send} consoleCommands={[{ id: 'side', name: 'side', kind: 'command', description: 'Open a side conversation' }]} onExecuteConsoleCommand={command} />;
  const container = await render(view(true));
  const input = container.querySelector('textarea')!;
  const type = (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const enter = () => act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(input.disabled).toBe(false);
  expect(input.placeholder).toBe('Message…');
  expect(container.querySelector('[data-testid="agent-activity"]')?.getAttribute('data-active')).toBe('false');
  expect(container.querySelector('[data-testid="agent-activity-label"]')?.textContent).toBe('Waiting for session');
  await type('Draft during synchronization');
  expect(draft).toHaveBeenLastCalledWith('Draft during synchronization');
  expect(container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
  await enter();
  expect(send).not.toHaveBeenCalled();
  await type('/side');
  await enter();
  expect(command).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Open chat commands"]')!.disabled).toBe(true);
  await type('Draft during synchronization');
  await rerender(container, view(false));
  expect(input.placeholder).toBe('Message…');
  expect(input.value).toBe('Draft during synchronization');
  await enter();
  expect(send).toHaveBeenCalledExactlyOnceWith('Draft during synchronization');
  expect(input.disabled).toBe(true);
  await act(async () => resolve());
  expect(input.disabled).toBe(false);
  await rerender(container, view(true, { ...state, agent: { ...state.agent!, capabilities: { ...state.agent!.capabilities, sendMessage: false } } }));
  expect(input.disabled).toBe(true);
  await rerender(container, view(true, createReplicaState()));
  expect(input.disabled).toBe(true);
});

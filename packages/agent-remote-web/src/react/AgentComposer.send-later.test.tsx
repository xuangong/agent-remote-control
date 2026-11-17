// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { createReplicaState } from '../replica/reducer.js';
import { render } from '../test/setup.js';
import { AgentComposer, type AgentComposerProps } from './AgentComposer.js';

async function setup(props: Partial<AgentComposerProps> = {}) {
  const container = await render(<AgentComposer state={undefined} draftOnly {...props} />);
  const input = () => container.querySelector('textarea')!;
  const button = () => container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!;
  const type = (text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
  const enter = () => act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
  return { container, input, button, type, enter };
}

it('sends text later from a draft-only composer and clears the draft once it waits', async () => {
  const send = vi.fn(async () => {});
  const view = await setup({ sendLater: { label: 'Send when Mac mini is back', send } });
  expect(view.button().disabled).toBe(true);
  await view.type('  Run the suite  ');
  expect(view.button().disabled).toBe(false);
  expect(view.button().getAttribute('aria-label')).toBe('Send when Mac mini is back');
  await act(async () => view.button().click());
  expect(send).toHaveBeenCalledWith('Run the suite');
  expect(view.input().value).toBe('');
  await view.type('And then the release notes');
  await view.enter();
  expect(send).toHaveBeenLastCalledWith('And then the release notes');
});

it('sends later while the Host is offline even if the session still looks attached', async () => {
  const send = vi.fn(async () => {}), sendMessage = vi.fn(async () => {});
  const view = await setup({ draftOnly: false, onSendMessage: sendMessage, sendLater: { label: 'Send when Mac mini is back', send } });
  await view.type('Run the suite');
  expect(view.button().getAttribute('aria-label')).toBe('Send when Mac mini is back');
  await act(async () => view.button().click());
  expect(send).toHaveBeenCalledWith('Run the suite');
  expect(sendMessage).not.toHaveBeenCalled();
});

it('sends later with Enter while the reconnecting session reads as read-only', async () => {
  const send = vi.fn(async () => {});
  const state = { ...createReplicaState(), timeline: { ...createReplicaState().timeline, initialized: true }, agent: {
    id: 'one', providerId: 'test', createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z', status: 'idle' as const, activeTurn: null,
    capabilities: { history: true, sendMessage: false, steer: false, cancel: false, readResource: false },
    pendingInteractions: [], runtimeInfo: { providerId: 'test', status: 'idle' as const } } };
  const view = await setup({ draftOnly: false, state, sendLater: { label: 'Send when Mac mini is back', send } });
  // It stays writable, without the read-only hint.
  expect(view.input().disabled).toBe(false);
  expect(view.input().placeholder).toBe('Message…');
  await view.type('Run the suite');
  await view.enter();
  expect(send).toHaveBeenCalledWith('Run the suite');
});

it('keeps the draft and says why when the message cannot wait', async () => {
  const send = vi.fn(async () => { throw new Error('The outbox is full. Cancel a waiting message first.'); });
  const view = await setup({ sendLater: { label: 'Send when Mac mini is back', send } });
  await view.type('Run the suite');
  await act(async () => view.button().click());
  expect(view.input().value).toBe('Run the suite');
  expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('The outbox is full. Cancel a waiting message first.');
});

it('does not send commands later, and without a way to send later nothing changes', async () => {
  const send = vi.fn(async () => {});
  const view = await setup({ sendLater: { label: 'Send when Mac mini is back', send } });
  await view.type('/compact');
  expect(view.button().disabled).toBe(true);
  expect(view.container.textContent).toContain('Commands need the Host. Send them when it is back.');
  await view.enter();
  expect(send).not.toHaveBeenCalled();
  const plain = await setup({ onSendMessage: vi.fn(async () => {}) });
  await plain.type('Run the suite');
  expect(plain.button().disabled).toBe(true);
  expect(plain.button().getAttribute('aria-label')).toBe('Send message');
});

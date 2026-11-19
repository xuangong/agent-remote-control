// @vitest-environment jsdom
// A message typed or queued into a session survives the view that shows the session being replaced: the text, the waiting queue and
// the focus belong to the session, not to the composer instance.
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render, rerender } from '../test/setup.js';
import { AgentComposer, type AgentComposerProps } from './AgentComposer.js';
import { createReplicaState, remoteSessionState, type AgentReplicaState, type RemoteSessionStatus } from '@orchardworks/agent-client';

const state: AgentReplicaState = { ...createReplicaState(), timeline: { ...createReplicaState().timeline, initialized: true }, agent: {
  id: 'one', providerId: 'test', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, queueMessage: true, steer: false, cancel: true, commands: true, readResource: false },
  pendingInteractions: [], runtimeInfo: { providerId: 'test', status: 'idle' },
} };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/** A page that shows the session in the pane `pane`; a different pane is a different component instance, mounted in the same commit as the old one is removed. */
function page(options: { pane: string; connection: RemoteSessionStatus; send: AgentComposerProps['onSendMessage']; also?: string; draftOnly?: boolean; opening?: boolean }) {
  const props = { state, sessionKey: 'target-one', draftScope: 'scope', onSendMessage: options.send, draftOnly: options.draftOnly, opening: options.opening };
  return <>
    <AgentComposer key={options.pane} {...props} sessionState={remoteSessionState(state, options.connection)} />
    {options.also ? <AgentComposer key={options.also} {...props} sessionState={remoteSessionState(state, options.connection)} /> : null}
  </>;
}
const typeInto = (input: HTMLTextAreaElement, text: string) => act(async () => {
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const submit = (container: HTMLElement) => act(async () => container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.click());

it('keeps the draft, the waiting message and the focus when another composer replaces the one that held them, and sends the message once', async () => {
  vi.useFakeTimers();
  const send = vi.fn(async () => {});
  const container = await render(page({ pane: 'stand-in', connection: 'disconnected', send }));
  await typeInto(container.querySelector('textarea')!, 'Queued while opening');
  await submit(container);
  expect(container.querySelector('[data-testid="pending-send"]')?.textContent).toContain('Sending');
  await typeInto(container.querySelector('textarea')!, 'Draft in progress');
  const before = container.querySelector('textarea')!;
  expect(document.activeElement).toBe(before);

  await rerender(container, page({ pane: 'window', connection: 'disconnected', send }));
  const after = container.querySelector('textarea')!;
  expect(after).not.toBe(before);
  expect(after.value).toBe('Draft in progress');
  expect(container.querySelectorAll('[data-testid="pending-send"]')).toHaveLength(1);
  expect(document.activeElement).toBe(after);
  expect([after.selectionStart, after.selectionEnd]).toEqual([after.value.length, after.value.length]);
  expect(send).not.toHaveBeenCalled();

  await rerender(container, page({ pane: 'window', connection: 'ready', send }));
  await advance(1000);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith('Queued while opening');
  expect(container.querySelector('[data-testid="pending-send"]')).toBeNull();
});

it('does not take the focus for the replacing composer when the old one did not have it', async () => {
  vi.useFakeTimers();
  const send = vi.fn(async () => {});
  const container = await render(page({ pane: 'stand-in', connection: 'disconnected', send }));
  await typeInto(container.querySelector('textarea')!, 'Some text');
  container.querySelector('textarea')!.blur();
  await rerender(container, page({ pane: 'window', connection: 'disconnected', send }));
  expect(container.querySelector('textarea')!.value).toBe('Some text');
  expect(document.activeElement).not.toBe(container.querySelector('textarea'));
});

it('sends a waiting message once when two composers for the same session are mounted', async () => {
  vi.useFakeTimers();
  const send = vi.fn(async () => {});
  const container = await render(page({ pane: 'first', also: 'second', connection: 'disconnected', send }));
  await typeInto(container.querySelectorAll('textarea')[0]!, 'Only once');
  await submit(container);
  await rerender(container, page({ pane: 'first', also: 'second', connection: 'ready', send }));
  await advance(1000);
  expect(send).toHaveBeenCalledTimes(1);
});

it('drops a session\'s draft and queue once every composer for it has unmounted', async () => {
  vi.useFakeTimers();
  const send = vi.fn(async () => {});
  const container = await render(page({ pane: 'first', connection: 'disconnected', send }));
  await typeInto(container.querySelector('textarea')!, 'Left behind');
  await submit(container);
  await typeInto(container.querySelector('textarea')!, 'Draft left behind');
  await rerender(container, <p>no composer</p>);
  await advance(10);
  await rerender(container, page({ pane: 'later', connection: 'disconnected', send }));
  expect(container.querySelector('textarea')!.value).toBe('');
  expect(container.querySelector('[data-testid="pending-send"]')).toBeNull();
});

it('takes a message typed into a stand-in that is still opening as Sending, and the pane that replaces it sends it once the session is ready', async () => {
  vi.useFakeTimers();
  const send = vi.fn(async () => {});
  const container = await render(page({ pane: 'stand-in', connection: 'catching_up', draftOnly: true, opening: true, send }));
  await typeInto(container.querySelector('textarea')!, 'Typed while opening');
  await submit(container);
  expect(container.querySelector('[data-testid="pending-send"]')?.textContent).toContain('Sending');
  expect(container.querySelector('textarea')!.value).toBe('');
  await advance(1000);
  expect(send).not.toHaveBeenCalled();
  await rerender(container, page({ pane: 'window', connection: 'ready', send }));
  await advance(1000);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith('Typed while opening');
});

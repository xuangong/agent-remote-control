import { act, useState, type ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { LabWorkbench } from './LabWorkbench.js';
import { ToastProvider } from './Toast.js';

type Props = ComponentProps<typeof LabWorkbench>;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
async function workbench(initial: Partial<Props> = {}) {
  vi.useFakeTimers();
  let update!: (props: Partial<Props>) => void;
  function Harness() {
    const [props, setProps] = useState<Props>({ state: replicaState, sessionStatus: 'ready', actions: {}, ...initial });
    update = patch => setProps(current => ({ ...current, ...patch }));
    return <ToastProvider><LabWorkbench {...props} onMessageDraftChange={props.onMessageDraftChange ?? (messageDraft => setProps(current => ({ ...current, messageDraft })))} /></ToastProvider>;
  }
  const container = await render(<Harness />);
  return { container, toast: () => container.querySelector('.lab-toast'), update: (props: Partial<Props>) => act(async () => update(props)) };
}

// Target T5: a session says nothing about its connection. The page's one indicator is the device link (GatewayController).
it('raises no toast and shows no connection word through disconnects, retries, catch-up and a recovering runtime', async () => {
  const view = await workbench();
  for (const sessionStatus of ['disconnected', 'connecting', 'catching_up', 'disconnected', 'ready'] as const) {
    await view.update({ sessionStatus });
    await advance(10_000);
    expect(view.toast()).toBeNull();
    expect(view.container.textContent).not.toMatch(/Opening session|Checking access|Synchronizing|Reconnecting|Restoring|Awaiting Agent|Loading conversation/i);
  }
  for (const state of ['reconnecting', 'restoring', 'connected'] as const) {
    await view.update({ state: runtime(state) });
    await advance(10_000);
    expect(view.toast()).toBeNull();
    expect(view.container.textContent).not.toMatch(/Opening session|Checking access|Synchronizing|Reconnecting|Restoring|Awaiting Agent|Loading conversation/i);
  }
});

it('does not treat an initial connection as a disconnect', async () => {
  const view = await workbench({ sessionStatus: 'connecting' });
  await advance(6000);
  await view.update({ sessionStatus: 'catching_up' });
  await advance(6000);
  expect(view.toast()).toBeNull();
});

function runtime(state: 'connected' | 'reconnecting' | 'restoring' | 'unavailable') {
  return { ...replicaState, agent: { ...replicaState.agent!, runtimeInfo: { ...replicaState.agent!.runtimeInfo, connection: { state } } } };
}

it.each([
  { state: runtime('unavailable'), message: 'The agent is not available on its Host.' },
  { state: { ...replicaState, diagnostics: [{ code: 'unauthorized', message: 'Access denied.', recoverable: false }] }, sessionStatus: 'connecting' as const, message: 'Access denied.' },
])('says $message once above the timeline, without a toast', async ({ message, ...props }) => {
  const view = await workbench(props);
  expect(view.toast()).toBeNull();
  const notes = [...view.container.querySelectorAll('.lab-control-note')].map(note => note.textContent);
  expect(notes).toEqual([message]);
});

it('shows agent failures inline without a runtime toast', async () => {
  const view = await workbench({ state: { ...replicaState,
    agent: { ...replicaState.agent!, status: 'failed', lastError: 'Permission denied.' } } });
  expect(view.container.querySelector('.lab-control-note[role="alert"]')?.textContent).toBe('Permission denied.');
  expect(view.toast()).toBeNull();
});

it('reports send failures immediately', async () => {
  const view = await workbench({ messageDraft: 'Hello', actions: { sendMessage: async () => { throw new Error('Send failed.'); } } });
  await act(async () => view.container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.click());
  expect(view.toast()?.textContent).toContain('Send failed.');
});

it('keeps an unsent message pending across recovery phases and uses the ready action once', async () => {
  const staleSend = vi.fn(async () => {}), send = vi.fn(async () => {});
  const view = await workbench({ sessionStatus: 'disconnected', actions: { sendMessage: staleSend } });
  await act(async () => {
    const input = view.container.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Send after recovery');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => view.container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.click());
  const pending = () => view.container.querySelector('[data-testid="pending-send"]');
  expect(pending()?.textContent).toContain('Send after recovery');
  await advance(2000);
  await view.update({ sessionStatus: 'connecting' });
  await advance(2000);
  await view.update({ sessionStatus: 'catching_up' });
  expect(pending()?.textContent).toContain('Send after recovery');
  expect(staleSend).not.toHaveBeenCalled();
  await view.update({ sessionStatus: 'ready', actions: { sendMessage: send } });
  expect(send).toHaveBeenCalledExactlyOnceWith('Send after recovery');
  expect(staleSend).not.toHaveBeenCalled();
  expect(pending()).toBeNull();
});

it.each(['shared', 'exclusive'] as const)('keeps the %s draft editable and focused while control is synchronizing', async mode => {
  const state = { ...replicaState, agent: { ...replicaState.agent!, capabilities: { ...replicaState.agent!.capabilities, sessionControl: mode } }, sessionControl: { access: 'control' as const, available: false } };
  const sendMessage = vi.fn(async () => {});
  const view = await workbench({ state, messageDraft: 'Keep typing', actions: { sendMessage } });
  const input = view.container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
  input.focus(); input.setSelectionRange(4, 4);
  for (const sessionStatus of ['disconnected', 'connecting', 'catching_up', 'ready'] as const) {
    await view.update({ sessionStatus, state: { ...state, sessionControl: { access: 'checking', available: false } } });
    expect(view.container.querySelector('[data-testid="prompt-input"]')).toBe(input);
    expect(input.disabled).toBe(false);
    expect(input.readOnly).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(4);
    expect(view.container.querySelector('.lab-session-control')).toBeNull();
    expect(view.container.textContent).not.toContain('Take control');
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Keep typing during recovery');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(input.value).toBe('Keep typing during recovery');
  expect(sendMessage).not.toHaveBeenCalled();
  await view.update({ sessionStatus: 'ready', state });
  expect(view.container.querySelector('[data-testid="prompt-input"]')).toBe(input);
  expect(input.value).toBe('Keep typing during recovery');
  expect(document.activeElement).toBe(input);
  expect(sendMessage).not.toHaveBeenCalled();
});

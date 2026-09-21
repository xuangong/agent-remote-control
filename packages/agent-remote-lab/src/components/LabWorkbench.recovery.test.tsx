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
    return <ToastProvider><LabWorkbench {...props} /></ToastProvider>;
  }
  const container = await render(<Harness />);
  return { container, toast: () => container.querySelector('.lab-toast'), update: (props: Partial<Props>) => act(async () => update(props)) };
}

it('filters short disconnects and allows a later prolonged disconnect without a cooldown', async () => {
  const view = await workbench();
  await view.update({ sessionStatus: 'disconnected' });
  expect(view.toast()).toBeNull();
  expect(view.container.querySelector('.lab-conversation-status')?.textContent).toBe('Reconnecting');
  await advance(4999);
  expect(view.toast()).toBeNull();
  await view.update({ sessionStatus: 'ready' });
  await advance(1000);
  expect(view.toast()).toBeNull();
  await view.update({ sessionStatus: 'disconnected' });
  await advance(5000);
  expect(view.toast()?.textContent).toContain('Timeline synchronization is reconnecting.');
  await view.update({ sessionStatus: 'ready' });
  expect(view.toast()).toBeNull();
  await view.update({ sessionStatus: 'disconnected' });
  await advance(5000);
  expect(view.toast()).not.toBeNull();
});

it('keeps the original disconnect deadline through retries and catch-up until ready', async () => {
  const view = await workbench({ sessionStatus: 'disconnected' });
  await advance(2000);
  await view.update({ sessionStatus: 'connecting' });
  await advance(2000);
  await view.update({ sessionStatus: 'catching_up' });
  await advance(999);
  expect(view.toast()).toBeNull();
  await advance(1);
  expect(view.toast()).not.toBeNull();
  await view.update({ sessionStatus: 'connecting' });
  expect(view.toast()).not.toBeNull();
  await view.update({ sessionStatus: 'ready' });
  expect(view.toast()).toBeNull();
});

it('does not treat an initial connection as a disconnect', async () => {
  const view = await workbench({ sessionStatus: 'connecting' });
  await advance(6000);
  await view.update({ sessionStatus: 'catching_up' });
  await advance(6000);
  expect(view.toast()).toBeNull();
});

it.each(['visibility', 'page'] as const)('requires five fresh foreground seconds after %s suspension', async kind => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const view = await workbench({ sessionStatus: 'disconnected' });
  await advance(3000);
  const hide = () => act(async () => {
    if (kind === 'visibility') { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')); }
    else window.dispatchEvent(new Event('pagehide'));
  });
  const show = () => act(async () => {
    if (kind === 'visibility') { visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')); }
    else window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await hide();
  await advance(20000);
  expect(view.toast()).toBeNull();
  await show();
  await advance(4999);
  expect(view.toast()).toBeNull();
  await advance(1);
  expect(view.toast()).not.toBeNull();
  await hide();
  expect(view.toast()).toBeNull();
  await show();
  await advance(4999);
  expect(view.toast()).toBeNull();
  await advance(1);
  expect(view.toast()).not.toBeNull();
});

it('cancels pending notifications on session switches and panel hiding', async () => {
  const view = await workbench({ sessionStatus: 'disconnected', draftSessionKey: 'first' });
  await advance(4000);
  await view.update({ draftSessionKey: 'second', sessionStatus: 'connecting' });
  await advance(6000);
  expect(view.toast()).toBeNull();
  await view.update({ sessionStatus: 'disconnected' });
  await advance(4000);
  await view.update({ visible: false });
  await advance(6000);
  expect(view.toast()).toBeNull();
  await view.update({ visible: true });
  await advance(4999);
  expect(view.toast()).toBeNull();
  await advance(1);
  expect(view.toast()).not.toBeNull();
  await view.update({ visible: false });
  expect(view.toast()).toBeNull();
});

function runtime(state: 'connected' | 'reconnecting' | 'restoring' | 'unavailable') {
  return { ...replicaState, agent: { ...replicaState.agent!, runtimeInfo: { ...replicaState.agent!.runtimeInfo, connection: { state } } } };
}

it('debounces native recovery through restoring and dismisses it when connected', async () => {
  const view = await workbench({ state: runtime('reconnecting') });
  expect(view.toast()).toBeNull();
  await advance(3000);
  await view.update({ state: runtime('restoring') });
  await advance(2000);
  expect(view.toast()?.textContent).toContain('Native runtime is restoring');
  await view.update({ state: runtime('connected') });
  expect(view.toast()).toBeNull();
});

it.each([
  { state: runtime('unavailable'), message: 'Native runtime is unavailable.' },
  { state: { ...replicaState, agent: { ...replicaState.agent!, status: 'failed' as const, lastError: 'Permission denied.' } }, message: 'Permission denied.' },
  { state: { ...replicaState, diagnostics: [{ code: 'unauthorized', message: 'Access denied.', recoverable: false }] }, sessionStatus: 'connecting' as const, message: 'Access denied.' },
])('reports $message immediately', async ({ message, ...props }) => {
  const view = await workbench(props);
  expect(view.toast()?.textContent).toContain(message);
  expect(view.toast()?.getAttribute('data-tone')).toBe('error');
});

it('reports send failures immediately', async () => {
  const view = await workbench({ messageDraft: 'Hello', actions: { sendMessage: async () => { throw new Error('Send failed.'); } } });
  await act(async () => view.container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.click());
  expect(view.toast()?.textContent).toContain('Send failed.');
});

it('does not accumulate time when the disconnect begins in the background', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  const view = await workbench({ sessionStatus: 'disconnected' });
  await advance(30000);
  expect(view.toast()).toBeNull();
  await act(async () => { visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')); });
  await advance(4999);
  expect(view.toast()).toBeNull();
  await advance(1);
  expect(view.toast()).not.toBeNull();
});

it('cancels the recovery timer when the workbench unmounts', async () => {
  vi.useFakeTimers();
  let close!: () => void;
  function Harness() {
    const [open, setOpen] = useState(true);
    close = () => setOpen(false);
    return <ToastProvider>{open ? <LabWorkbench state={replicaState} sessionStatus="disconnected" actions={{}} /> : null}</ToastProvider>;
  }
  const container = await render(<Harness />);
  await advance(4000);
  await act(async () => close());
  await advance(6000);
  expect(container.querySelector('.lab-toast')).toBeNull();
});

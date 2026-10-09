import { act, StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSessionAttention, TrackViewScope } from './useSessionAttention.js';
import { LabWorkbench } from '../components/LabWorkbench.js';
import { replicaState } from '../test/fixtures.js';
import { render, unmount } from '../test/setup.js';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
function Harness() {
  const attention = useSessionAttention('workspace', true, () => {});
  return <TrackViewScope.Provider value={attention.executeTrack}>
    <div data-testid="track" hidden={!attention.trackVisible}>Track</div>
    {attention.controls}
    <LabWorkbench state={replicaState} sessionStatus="ready" actions={{ sendMessage: async () => { throw new Error('Local command must not send a message'); } }} />
  </TrackViewScope.Provider>;
}
async function command(container: HTMLElement, text: string) {
  const input = container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.click());
}
it.each([false, true])('defaults Track to mobile=%s and persists explicit slash commands', async mobile => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: mobile, addEventListener() {}, removeEventListener() {} })));
  let container = await render(<Harness />);
  const visible = () => !container.querySelector<HTMLElement>('[data-testid="track"]')!.hidden;
  expect(visible()).toBe(mobile);
  await command(container, '/track');
  expect(visible()).toBe(!mobile);
  await command(container, '/track off');
  expect(visible()).toBe(false);
  await command(container, '/track enable');
  expect(visible()).toBe(true);
  await unmount(container);
  container = await render(<Harness />);
  expect(visible()).toBe(true);
  await command(container, '/track invalid');
  expect(visible()).toBe(true);
  expect(container.textContent).toContain('Use /track');
});
it('requests notification permission on desktop entry and provides blocked feedback', async () => {
  const requestPermission = vi.fn(async () => { Object.defineProperty(Notification, 'permission', { value: 'denied', configurable: true }); return 'denied'; });
  vi.stubGlobal('Notification', { permission: 'default', requestPermission });
  const container = await render(<Harness />);
  expect(requestPermission).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('Notifications are blocked');
});

it('keeps notification observation active through StrictMode effect cleanup', async () => {
  const notices: unknown[] = [];
  vi.stubGlobal('Notification', class {
    static permission = 'granted';
    constructor() { notices.push(this); }
    close() {}
  });
  let observe!: ReturnType<typeof useSessionAttention>['observe'];
  function Observer() { observe = useSessionAttention('strict', true, () => {}).observe; return null; }
  await render(<StrictMode><Observer /></StrictMode>);
  const session = { providerId: 'codex', nativeSessionId: 'native', title: 'Research' };
  await act(async () => {
    observe(session, { connection: 'ready', activity: 'running', cursor: { epoch: 'epoch', seq: 1 } });
    observe(session, { connection: 'ready', activity: 'waiting', cursor: { epoch: 'epoch', seq: 2 } });
  });
  await vi.waitFor(() => expect(notices).toHaveLength(1));
});

it('requests on each desktop visit, ignoring the old gesture-request preference, once under StrictMode', async () => {
  localStorage.setItem('agent-remote:notifications-requested', 'true');
  const requestPermission = vi.fn(async () => 'default');
  vi.stubGlobal('Notification', { permission: 'default', requestPermission });
  const first = await render(<StrictMode><Harness /></StrictMode>);
  expect(requestPermission).toHaveBeenCalledOnce();
  await unmount(first);
  await render(<Harness />);
  expect(requestPermission).toHaveBeenCalledTimes(2);
});
it.each(['mobile', 'disabled', 'granted', 'denied'] as const)('does not request permission for %s', async reason => {
  const requestPermission = vi.fn(async () => 'default');
  vi.stubGlobal('Notification', { permission: reason === 'granted' || reason === 'denied' ? reason : 'default', requestPermission });
  if (reason === 'mobile') vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })));
  if (reason === 'disabled') localStorage.setItem('agent-remote:desktop-notifications', 'false');
  await render(<Harness />);
  expect(requestPermission).not.toHaveBeenCalled();
});
it('keeps a manual retry when the page-load request requires a gesture', async () => {
  const requestPermission = vi.fn().mockRejectedValueOnce(new Error('User gesture required')).mockResolvedValueOnce('granted');
  vi.stubGlobal('Notification', { permission: 'default', requestPermission });
  const container = await render(<Harness />);
  expect(requestPermission).toHaveBeenCalledOnce();
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Allow browser notifications')!.click());
  expect(requestPermission).toHaveBeenCalledTimes(2);
});
it('retains the gesture retry when automatic prompting returns denied without changing site permission', async () => {
  const requestPermission = vi.fn().mockResolvedValueOnce('denied').mockImplementationOnce(async () => {
    Object.defineProperty(Notification, 'permission', { value: 'granted', configurable: true });
    return 'granted';
  });
  vi.stubGlobal('Notification', { permission: 'default', requestPermission });
  const container = await render(<Harness />);
  expect(requestPermission).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain('Notifications are blocked');
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Allow browser notifications')!.click());
  expect(requestPermission).toHaveBeenCalledTimes(2);
  expect(container.textContent).not.toContain('Allow browser notifications');
});
it('does not issue overlapping permission requests while the entry prompt is open', async () => {
  let resolve!: (permission: string) => void;
  const requestPermission = vi.fn(() => new Promise<string>(done => { resolve = done; }));
  vi.stubGlobal('Notification', { permission: 'default', requestPermission });
  const container = await render(<StrictMode><Harness /></StrictMode>);
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Allow browser notifications')!.click());
  expect(requestPermission).toHaveBeenCalledOnce();
  await act(async () => resolve('default'));
});

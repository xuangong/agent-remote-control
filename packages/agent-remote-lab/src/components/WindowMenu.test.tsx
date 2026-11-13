import { act, useReducer } from 'react';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { createWindowView, type WindowSessionBinding, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import type { useWindowWorkspace } from '../hooks/useWindowWorkspace.js';
import type { SessionActivityStatus } from '../session-activity-status.js';
import { render } from '../test/setup.js';
import { WindowMenu } from './WindowMenu.js';
import { WindowWorkspaceClient } from '@orchardworks/agent-remote-web';

const dialogMethods = ['showModal', 'close'] as const;
const originalDialog = Object.fromEntries(dialogMethods.map(name => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)]));
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
});
afterAll(() => {
  for (const name of dialogMethods) {
    const original = originalDialog[name];
    if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original);
    else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>)[name];
  }
});

const bind = (id: string): WindowSessionBinding => ({ hostId: 'host', providerId: 'claude', nativeSessionId: id, title: `Session ${id}` });
const windowOf = (id: string, sessions: string[]): WorkspaceWindow => ({ schemaVersion: 3, id, title: `Window ${id}`, revision: 0,
  selectedPrimaryViewId: `${id}-0`, selectedViewId: `${id}-0`,
  views: sessions.map((session, index) => createWindowView(`${id}-${index}`, bind(session), index ? 'dock' : 'primary')) });

async function menu(statuses: Record<string, SessionActivityStatus>) {
  const current = windowOf('current', ['a', 'b']);
  const others = [windowOf('busy', ['c', 'd']), windowOf('quiet', ['e'])];
  const workspace = { window: current, windows: [current, ...others], hasActiveWindow: true, unavailable: false,
    open: async () => {}, create: async () => {}, remove: async () => {}, operate: async () => {} } as unknown as ReturnType<typeof useWindowWorkspace>;
  const container = await render(<WindowMenu workspace={workspace} visible sessionStatus={session => statuses[session.nativeSessionId] ?? 'unknown'} />);
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Windows"]')!.click());
  const windowRow = (id: string) => container.querySelector(`[data-window-row="${id}"]`)!;
  const viewRow = (id: string) => container.querySelector(`[data-window-view-row="${id}"]`)!;
  return { container, windowRow, viewRow };
}

it('marks each session view and summarizes each Window as pending, failed, working, then idle', async () => {
  const { windowRow, viewRow } = await menu({ a: 'running', b: 'starting', c: 'failed', d: 'running', e: 'idle' });
  expect(viewRow('current-0').querySelector('strong')!.dataset.sessionStatus).toBe('running');
  expect(viewRow('current-0').querySelector('small')!.textContent).toBe('Working · Top-level');
  expect(viewRow('current-1').querySelector('small')!.textContent).toBe('Pending · Dock');
  expect(windowRow('current').querySelector('small')!.textContent).toBe('Pending · 2 session views');
  expect(windowRow('busy').querySelector('strong')!.dataset.sessionStatus).toBe('failed');
  expect(windowRow('busy').querySelector('small')!.textContent).toBe('Failed · 2 session views');
  expect(windowRow('quiet').querySelector('small')!.textContent).toBe('Idle · 1 session view');
});

it('keeps a session view quiet while its status is unknown', async () => {
  const { windowRow, viewRow } = await menu({ a: 'idle' });
  expect(viewRow('current-1').querySelector('strong')!.dataset.sessionStatus).toBeUndefined();
  expect(viewRow('current-1').querySelector('small')!.textContent).toBe('Dock');
  expect(windowRow('current').querySelector('small')!.textContent).toBe('Idle · 2 session views');
  expect(windowRow('busy').querySelector('small')!.textContent).toBe('2 session views');
});

it('reminds of sessions waiting in another Window, not in the current one', async () => {
  const elsewhere = await menu({ a: 'running', d: 'waiting' });
  const root = elsewhere.container.querySelector<HTMLElement>('.lab-window-floating')!;
  expect(root.dataset.attention).toBe('true');
  expect(root.querySelector('.lab-tracking-attention')).not.toBeNull();
  expect(root.querySelector('[role="status"]')!.textContent).toBe('Another Window has pending sessions.');
  const here = await menu({ a: 'waiting', d: 'running', e: 'starting' });
  const quiet = here.container.querySelector<HTMLElement>('.lab-window-floating')!;
  expect(quiet.dataset.attention).toBeUndefined();
  expect(quiet.querySelector('.lab-tracking-attention')).toBeNull();
});

async function deletionMenu() {
  const current = windowOf('current', ['a']), other = windowOf('other', ['b']);
  let client: ReturnType<typeof useWindowWorkspace>['client'];
  let visible = true, redraw!: () => void;
  const removed = new Set<string>();
  let removeWindow: () => Promise<void> = async () => {};
  const remove = vi.fn(async (id: string) => { await removeWindow(); removed.add(id); redraw(); });
  function Harness() {
    [, redraw] = useReducer(value => value + 1, 0);
    const workspace = { client, window: current, windows: [current, other].filter(window => !removed.has(window.id)),
      hasActiveWindow: true, unavailable: false, remove } as unknown as ReturnType<typeof useWindowWorkspace>;
    return <WindowMenu workspace={workspace} visible={visible} />;
  }
  const container = await render(<Harness />);
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Windows"]')!;
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === label)!;
  const openConfirmation = () => act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Delete Window: Window other"]')!.click());
  await act(async () => trigger.click());
  return { container, trigger, button, openConfirmation, remove,
    setRemove(action: typeof removeWindow) { removeWindow = action; },
    async changeScope() { await act(async () => { client = new WindowWorkspaceClient('http://localhost/menu-delete-scope/'); redraw(); }); },
    async setVisible(value: boolean) { await act(async () => { visible = value; redraw(); }); },
  };
}

// jsdom does not implement Escape's native dialog default action. Dispatch cancel only when keydown permits it.
const escape = (target: HTMLElement) => act(async () => {
  const allowed = target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  if (allowed) target.closest('dialog[open]')?.dispatchEvent(new Event('cancel', { cancelable: true }));
});

it('lets Escape close only the idle deletion confirmation and keeps the Windows panel open', async () => {
  const test = await deletionMenu();
  await test.openConfirmation();
  expect(test.container.querySelector('dialog')?.open).toBe(true);
  await escape(test.button('Cancel'));
  expect(test.trigger.getAttribute('aria-expanded')).toBe('true');
  expect(test.container.querySelector('dialog')).toBeNull();
  expect(test.container.querySelector('[data-window-id="other"]')).not.toBeNull();
  expect(test.remove).not.toHaveBeenCalled();
});

it.each(['success', 'failure'] as const)('keeps pending confirmation and its Windows panel open through Escape until %s', async outcome => {
  const test = await deletionMenu();
  let finish!: () => void, fail!: (error: Error) => void;
  test.setRemove(() => new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; }));
  await test.openConfirmation();
  const dialog = test.container.querySelector('dialog')!;
  await act(async () => test.button('Delete Window').click());
  expect(test.button('Delete Window').disabled).toBe(true);
  await escape(test.button('Delete Window'));
  expect(test.trigger.getAttribute('aria-expanded')).toBe('true');
  expect(test.container.querySelector('dialog')).toBe(dialog);
  expect(dialog.open).toBe(true);
  expect(test.remove).toHaveBeenCalledExactlyOnceWith('other');
  if (outcome === 'failure') {
    await act(async () => fail(new Error('Deletion is unavailable. Try again.')));
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('Deletion is unavailable. Try again.');
    expect(test.button('Delete Window').disabled).toBe(false);
    expect(test.container.querySelector('[data-window-id="other"]')).not.toBeNull();
    test.setRemove(async () => {});
    await act(async () => test.button('Delete Window').click());
    expect(test.remove).toHaveBeenNthCalledWith(2, 'other');
  } else await act(async () => finish());
  expect(test.trigger.getAttribute('aria-expanded')).toBe('true');
  expect(test.container.querySelector('dialog')).toBeNull();
  expect(test.container.querySelector('[data-window-id="other"]')).toBeNull();
});

it.each(['scope', 'panel'] as const)('still invalidates nested confirmation after a %s change', async change => {
  const test = await deletionMenu();
  await test.openConfirmation();
  expect(test.container.querySelector('dialog')?.open).toBe(true);
  if (change === 'scope') await test.changeScope();
  else {
    await test.setVisible(false);
    await test.setVisible(true);
    await act(async () => test.trigger.click());
  }
  expect(test.trigger.getAttribute('aria-expanded')).toBe('true');
  expect(test.container.querySelector('dialog')).toBeNull();
  expect(test.container.querySelector('[data-window-id="other"]')).not.toBeNull();
  expect(test.remove).not.toHaveBeenCalled();
});

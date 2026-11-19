import { act } from 'react';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { render } from '../../test/setup.js';
import { buildView, buildWindow } from '../../test/window-builders.js';
import { WindowSheets } from './WindowSheets.js';

// jsdom has no modal dialogs.
const dialogMethods = ['showModal', 'close'] as const;
const originalDialog = Object.fromEntries(dialogMethods.map(name => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)]));
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
});
afterAll(() => {
  for (const name of dialogMethods) {
    const original = originalDialog[name];
    if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original); else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>)[name];
  }
});

type Scope = Parameters<typeof WindowSheets>[0]['scope'];
function scopeOf(overrides: Partial<Record<keyof Scope, unknown>> = {}, others: ReturnType<typeof buildWindow>[] = []) {
  const sharedWindow = buildWindow([buildView('a')], 'a', { id: 'A', title: 'Alpha' });
  const scope = {
    agentControlOpen: false, deleteConfirmOpen: true, menuCurrentBinding: undefined, setAgentControlOpen: vi.fn(), setDeleteConfirmOpen: vi.fn(),
    sharedWindow, windowMode: true, windowToolbarShown: true,
    windowActions: { busy: false, deleteCurrent: vi.fn(async () => {}) },
    windowWorkspace: { provisional: false, client: undefined, window: sharedWindow, windows: [sharedWindow, ...others] },
    ...overrides,
  };
  return scope as typeof scope & Scope;
}
const dialog = (title: string) => [...document.querySelectorAll<HTMLDialogElement>('dialog.orchard-sheet')].find(item => item.querySelector('h2')?.textContent === title);
const button = (sheet: HTMLElement, label: string) => [...sheet.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;

it('names the Window it deletes and says its sessions stay in All sessions', async () => {
  await render(<WindowSheets scope={scopeOf({}, [buildWindow([buildView('x')], 'x', { id: 'B' })])} />);
  const text = dialog('Delete this Window?')!.querySelector('.lab-sheet-message')!.textContent;
  expect(text).toBe('“Alpha” and its layout are deleted. Its agent sessions keep running and stay in All sessions.');
});

it('says that deleting the only Window opens a new empty one in its place', async () => {
  await render(<WindowSheets scope={scopeOf()} />);
  expect(dialog('Delete this Window?')!.querySelector('.lab-sheet-message')!.textContent).toContain('A new empty Window opens in its place.');
});

it('closes without deleting on Cancel', async () => {
  const scope = scopeOf();
  await render(<WindowSheets scope={scope} />);
  await act(async () => button(dialog('Delete this Window?')!, 'Cancel').click());
  expect(scope.setDeleteConfirmOpen).toHaveBeenCalledExactlyOnceWith(false);
  expect(scope.windowActions.deleteCurrent).not.toHaveBeenCalled();
});

it('closes the delete sheet through its own flag and leaves Agent control alone', async () => {
  const scope = scopeOf();
  await render(<WindowSheets scope={scope} />);
  await act(async () => dialog('Delete this Window?')!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
  expect(scope.setDeleteConfirmOpen).toHaveBeenCalledWith(false);
  expect(scope.setAgentControlOpen).not.toHaveBeenCalled();
  expect(scope.windowActions.deleteCurrent).not.toHaveBeenCalled();
});

it('closes and deletes the current Window on Delete Window', async () => {
  const scope = scopeOf();
  await render(<WindowSheets scope={scope} />);
  await act(async () => button(dialog('Delete this Window?')!, 'Delete Window').click());
  expect(scope.setDeleteConfirmOpen).toHaveBeenCalledExactlyOnceWith(false);
  expect(scope.windowActions.deleteCurrent).toHaveBeenCalledOnce();
});

it('keeps Delete Window from acting while another Window action runs or the Window is not confirmed', async () => {
  await render(<WindowSheets scope={scopeOf({ windowActions: { busy: true, deleteCurrent: vi.fn() } })} />);
  expect(button(dialog('Delete this Window?')!, 'Delete Window').disabled).toBe(true);
  await render(<WindowSheets scope={scopeOf({ windowWorkspace: { provisional: true, client: undefined, windows: [] } })} />);
  expect([...document.querySelectorAll('dialog.orchard-sheet')].every(item => button(item as HTMLElement, 'Delete Window').disabled)).toBe(true);
});

const inspect = vi.fn(async (_windowId: string | undefined) => ({ manager: undefined }));
const agentClient = { inspect, assign: vi.fn(async () => ({})) } as never;
const sheetsOf = () => [...document.querySelectorAll('dialog.orchard-sheet')].map(item => item.querySelector('h2')?.textContent);

it.each([
  ['the sheet is closed', { deleteConfirmOpen: false }],
  ['there is no shared Window', { sharedWindow: undefined }],
  ['the toolbar is hidden', { windowToolbarShown: false }],
  ['the Workbench is not in Window mode', { windowMode: false }],
])('mounts no sheet while %s', async (_name, change) => {
  await render(<WindowSheets scope={scopeOf({ agentControlOpen: false, deleteConfirmOpen: true, ...change })} />);
  expect(sheetsOf()).toEqual([]);
});

it('mounts the Agent control sheet only in Window mode, with the toolbar, over a shared Window', async () => {
  const open = { deleteConfirmOpen: false, agentControlOpen: true, windowWorkspace: { provisional: false, client: agentClient, windows: [] } };
  await render(<WindowSheets scope={scopeOf(open)} />);
  expect(sheetsOf()).toEqual(['Agent control']);
  for (const change of [{ sharedWindow: undefined }, { windowToolbarShown: false }, { windowMode: false }, { agentControlOpen: false }]) {
    await render(<WindowSheets scope={scopeOf({ ...open, ...change })} />);
  }
  expect(sheetsOf()).toEqual(['Agent control']);
});

it('closes the Agent control sheet through its own flag and leaves the delete flag alone', async () => {
  const scope = scopeOf({ deleteConfirmOpen: false, agentControlOpen: true, windowWorkspace: { provisional: false, client: agentClient, windows: [] } });
  await render(<WindowSheets scope={scope} />);
  await act(async () => dialog('Agent control')!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
  expect(scope.setAgentControlOpen).toHaveBeenCalledWith(false);
  expect(scope.setDeleteConfirmOpen).not.toHaveBeenCalled();
});

it('opens the Agent control sheet for the shown Window', async () => {
  inspect.mockClear();
  const scope = scopeOf({ deleteConfirmOpen: false, agentControlOpen: true, windowWorkspace: { provisional: false, client: agentClient, windows: [] } });
  await render(<WindowSheets scope={scope} />);
  expect(dialog('Agent control')!.textContent).toContain('Name the session that arranges this Window.');
  expect(inspect).toHaveBeenCalledWith('A', expect.anything());
});

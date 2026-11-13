import { act, useReducer } from 'react';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyWindowOperation, createWindowView, type WindowOperation, type WindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import type { useWindowWorkspace } from '../hooks/useWindowWorkspace.js';
import { render } from '../test/setup.js';
import { WindowWorkspaces } from './WindowWorkspaces.js';
import { useWindowActions } from '../hooks/useWindowActions.js';
import { WindowWorkspaceClient } from '@orchardworks/agent-remote-web';
import { botGroup, mountBotApp, seedGroup, until } from '../test/bot-mode-fixtures.js';

const dialogMethods = ['showModal', 'close'] as const;
const originalDialog = Object.fromEntries(dialogMethods.map(name => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)]));
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => {
  for (const name of dialogMethods) {
    const original = originalDialog[name];
    if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original);
    else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>)[name];
  }
});

it('does not append a selected section-only group to the Window catalog', async () => {
  const group = botGroup('section'); group.presentation = { window: false };
  const workspace = { window: group.window, group, windows: [], groups: [group], readGroup: () => group, hasActiveWindow: false } as unknown as ReturnType<typeof useWindowWorkspace>;
  const container = await render(<WindowWorkspaces workspace={workspace} />);
  expect(container.querySelector('[data-window-id="section"]')).toBeNull();
});

it('copies a Window link without Bot route fields and surfaces section conflicts without changing selection', async () => {
  const scope = 'http://localhost/window-section-options/'; seedGroup(scope, botGroup('A', false)); history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope, { hosted: true });
  await until(() => expect(app.workspace().hasActiveWindow).toBe(true));
  await act(async () => app.button('Windows').click());
  let copied = '';
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied = value; } } });
  history.replaceState(null, '', '/?window=A&mode=bot&section=B&bot=B1');
  await act(async () => app.button('Copy link').click());
  const url = new URL(copied); expect(url.searchParams.get('window')).toBe('A');
  expect(['mode', 'section', 'bot'].some(key => url.searchParams.has(key))).toBe(false);
  const before = structuredClone(app.workspace().window);
  vi.spyOn(WindowWorkspaceClient.prototype, 'mutate').mockImplementation(async (id, mutation) => ({ ...app.hostedGroups.get(id)!, result: {
    operationId: mutation.operationId, status: 'rejected', revision: before!.revision, code: 'bot_session_taken',
    message: 'This session is already a bot in "Release".', committedAt: Date.now(), expiresAt: Date.now() + 86400000,
  } }));
  await act(async () => app.button('Show as section').click());
  expect(app.container.textContent).toContain('This session is already a bot in "Release".');
  expect(app.workspace().window).toEqual(before); expect(app.workspace().readGroup('A')?.bots).toBeUndefined();
  await app.close(); localStorage.clear(); sessionStorage.clear();
});

async function fixture({ views = [createWindowView('main', undefined, 'primary')], sharedActions = false, ...props }: { views?: WindowView[]; sharedActions?: boolean } & Pick<Parameters<typeof WindowWorkspaces>[0], 'onNavigate' | 'onOverview' | 'placement'> = {}) {
  let window: WorkspaceWindow = { schemaVersion: 3, id: 'window', title: 'Project', revision: 0, selectedPrimaryViewId: 'main', selectedViewId: 'main', views };
  let other: WorkspaceWindow = { ...window, id: 'other', title: 'Window' };
  const renamed = vi.fn();
  const removed = new Set<string>();
  let removeWindow: (id: string) => Promise<void> = async () => {};
  const remove = vi.fn(async (id: string) => { await removeWindow(id); removed.add(id); update(); });
  let client: ReturnType<typeof useWindowWorkspace>['client'];
  let active = true, hasActiveWindow = true, currentWindow = 'window';
  let renameOther: (title: string) => Promise<{ saved: Promise<void> }> = async title => { other = { ...other, title, revision: other.revision + 1 }; return { saved: Promise.resolve() }; };
  let rejectSave!: (error: Error) => void;
  const saved = new Promise<void>((_resolve, reject) => { rejectSave = reject; });
  let redraw!: () => void, rejectLocal = false;
  let saveState = { state: 'saving' as 'saving' | 'offline' | 'error', pending: 1, error: undefined as string | undefined };
  const retry = vi.fn(async () => {});
  const discard = vi.fn(() => saved);
  let update!: () => void;
  const operate = vi.fn((operation: WindowOperation) => {
    if (rejectLocal) throw new Error('This Window cannot be edited.');
    window = applyWindowOperation(window, operation); update(); return saved;
  });
  function Harness() {
    [, update] = useReducer(value => value + 1, 0); redraw = update;
    const workspace = { client, window: currentWindow === 'window' ? window : other, windows: [window, other].filter(item => !removed.has(item.id)), hasActiveWindow, unavailable: false, saveState,
      retrySave: retry, discardLocalChanges: discard, open: async () => {}, create: async () => {}, remove, operate,
      async rename(id: string, title: string) {
        renamed(id, title);
        if (id === window.id) return { saved: operate({ type: 'rename', title }) };
        const result = await renameOther(title); update(); return result;
      },
    } as unknown as ReturnType<typeof useWindowWorkspace>;
    const actions = useWindowActions(workspace);
    return <WindowWorkspaces workspace={workspace} actions={sharedActions ? actions : undefined} active={active} {...props} />;
  }
  const container = await render(<Harness />);
  const button = (title: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === title)!;
  const rename = async (id: string, title: string) => {
    await act(async () => container.querySelector<HTMLButtonElement>(`[data-window-rename="${id}"]`)!.click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Window title"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, title);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  };
  return { container, button, rename, renamed, operate, remove,
    setRemove(value: typeof removeWindow) { removeWindow = value; },
    async changeScope() { await act(async () => { client = new WindowWorkspaceClient('http://localhost/changed-window-scope/'); redraw(); }); },
    async changeWindow() { await act(async () => { currentWindow = 'other'; redraw(); }); },
    async setActive(value: boolean) { await act(async () => { active = value; redraw(); }); },
    async deactivateWindow() { await act(async () => { hasActiveWindow = false; redraw(); }); },
    read: () => window, readOther: () => other, retry, discard, rejectSave,
    setRenameOther(value: typeof renameOther) { renameOther = value; },
    rejectLocal: () => { rejectLocal = true; },
    async offline() { await act(async () => { saveState = { state: 'offline', pending: 1, error: 'Network unavailable' }; redraw(); }); },
    async unsettled() { await act(async () => { saveState = { state: 'error', pending: 1, error: 'The save receipt expired' }; redraw(); }); },
  };
}

it('keeps pane controls available and closes rename immediately while layout saves remain pending', async () => {
  const test = await fixture();
  await act(async () => test.button('New session view').click());
  expect(test.container.querySelectorAll('[data-window-view-id]')).toHaveLength(2);
  expect(test.button('New session view').disabled).toBe(false);
  await act(async () => test.container.querySelector<HTMLButtonElement>('[data-window-view-id="main"]')!.click());
  expect(test.read().selectedViewId).toBe('main');
  await test.rename('window', 'Renamed');
  expect(test.read().title).toBe('Renamed');
  expect(test.container.querySelector('form')).toBeNull();
  expect(test.button('New session view').disabled).toBe(false);
  expect(test.container.textContent).toContain('Saving');
});

it('preserves local pane edits and exposes a save retry while offline', async () => {
  const test = await fixture();
  await act(async () => test.button('New session view').click());
  await test.offline();
  expect(test.container.textContent).toContain('not saved');
  expect(test.button('New session view').disabled).toBe(false);
  await act(async () => test.button('Retry').click());
  expect(test.retry).toHaveBeenCalledOnce();
  expect(test.container.querySelectorAll('[data-window-view-id]')).toHaveLength(2);
  await act(async () => test.rejectSave(new Error('The server refused this change.')));
  expect(test.container.textContent).toContain('The server refused this change.');
  expect(test.container.querySelectorAll('[data-window-view-id]')).toHaveLength(2);
});

it('keeps the rename form open when local validation rejects the operation', async () => {
  const test = await fixture();
  test.rejectLocal();
  await test.rename('window', 'Rejected');
  expect(test.read().title).toBe('Project');
  expect(test.container.querySelector('form')).not.toBeNull();
  expect(test.container.textContent).toContain('This Window cannot be edited.');
});

it('offers an explicit saved-layout fallback without blocking pane edits during recovery', async () => {
  const test = await fixture();
  await test.unsettled();
  const fallback = test.button('Use saved layout');
  expect(fallback).toBeDefined();
  expect(fallback.title).toContain('Discard unsaved local layout edits');
  await act(async () => fallback.click());
  expect(test.discard).toHaveBeenCalledOnce();
  expect(test.button('New session view').disabled).toBe(false);
  await act(async () => test.button('New session view').click());
  expect(test.container.querySelectorAll('[data-window-view-id]')).toHaveLength(2);
});

it('closes every pane locally, including the last one, and can create a view in the same empty Window', async () => {
  const test = await fixture();
  await act(async () => test.button('New session view').click());
  const selected = test.read().selectedViewId;
  await act(async () => test.container.querySelector<HTMLButtonElement>('[data-window-view-close="main"]')!.click());
  expect(test.read().selectedViewId).toBe(selected);
  expect(test.read().views).toHaveLength(1);
  await act(async () => test.container.querySelector<HTMLButtonElement>('[data-window-view-close]')!.click());
  expect(test.read()).toMatchObject({ id: 'window', selectedViewId: null, selectedPrimaryViewId: null, views: [] });
  expect(test.container.textContent).toContain('No session views. Add one or open one from Sessions.');
  expect(test.button('New session view').disabled).toBe(false);
  await act(async () => test.button('New session view').click());
  expect(test.read().id).toBe('window');
  expect(test.read().views).toHaveLength(1);
  expect(test.read().selectedViewId).toBe(test.read().views[0]!.id);
});

it('renames any Window from its row, including one that is not open, and reports a failed save', async () => {
  const test = await fixture();
  await test.rename('other', '  Research  ');
  expect(test.renamed).toHaveBeenLastCalledWith('other', 'Research');
  expect(test.container.querySelector('[data-window-id="other"]')?.textContent).toContain('Research');
  expect(test.container.querySelector('form')).toBeNull();
  expect(test.container.querySelector('[aria-current="true"][data-window-id="window"]')).not.toBeNull();
  let fail!: (error: Error) => void;
  test.setRenameOther(async () => ({ saved: new Promise<void>((_resolve, reject) => { fail = reject; }) }));
  await test.rename('other', 'Later');
  expect(test.container.querySelector('form')).toBeNull();
  await act(async () => fail(new Error('The server refused this change.')));
  expect(test.container.textContent).toContain('The server refused this change.');
  test.setRenameOther(async () => { throw new Error('This Window is unavailable.'); });
  await test.rename('other', 'Missing');
  expect(test.container.querySelector('form')).not.toBeNull();
  expect(test.container.textContent).toContain('This Window is unavailable.');
});

it('cancels a rename with Escape, keeps an unchanged title without saving, and returns focus to the row action', async () => {
  const test = await fixture();
  await act(async () => test.container.querySelector<HTMLButtonElement>('[data-window-rename="other"]')!.click());
  const input = test.container.querySelector<HTMLInputElement>('input[aria-label="Window title"]')!;
  expect(input.value).toBe('Window');
  // Only one row is edited at a time.
  expect(test.container.querySelector<HTMLButtonElement>('[data-window-rename="window"]')!.disabled).toBe(true);
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(test.container.querySelector('form')).toBeNull();
  await act(async () => {});
  expect(document.activeElement?.getAttribute('data-window-rename')).toBe('other');
  await test.rename('other', 'Window');
  expect(test.renamed).not.toHaveBeenCalled();
  expect(test.container.querySelector('form')).toBeNull();
});

it('lists the current Window in layout order and focuses a chosen view', async () => {
  const navigate = vi.fn();
  // A Side follows its source in the array, as the layout requires.
  const test = await fixture({ onNavigate: navigate, views: [
    createWindowView('float', undefined, 'float'), { ...createWindowView('dock'), collapsed: true },
    createWindowView('main', undefined, 'primary'), { ...createWindowView('side', undefined, 'attached'), attachedTo: 'main' },
  ] });
  const views = test.container.querySelector('nav[aria-label="Session views"]')!;
  expect(test.container.textContent).toContain('In this Window');
  expect([...views.querySelectorAll('[data-window-view-row]')].map(row => [row.getAttribute('data-window-view-row'), row.getAttribute('data-depth')]))
    .toEqual([['main', null], ['side', '1'], ['dock', null], ['float', null]]);
  expect(views.querySelector('[data-window-view-row="dock"]')?.hasAttribute('data-collapsed')).toBe(true);
  expect(views.querySelector('[data-window-view-row="float"]')?.hasAttribute('data-collapsed')).toBe(false);
  const pane = document.createElement('div'); pane.dataset.viewId = 'dock'; pane.scrollIntoView = vi.fn(); document.body.append(pane);
  try {
    await act(async () => views.querySelector<HTMLButtonElement>('[data-window-view-id="dock"]')!.click());
    expect(test.operate).toHaveBeenCalledWith({ type: 'batch', operations: [
      { type: 'view.collapse', viewId: 'dock', collapsed: false }, { type: 'view.select', viewId: 'dock' }] });
    expect(test.read()).toMatchObject({ selectedViewId: 'dock' });
    expect(test.read().views.find(view => view.id === 'dock')?.collapsed).toBe(false);
    expect(navigate).toHaveBeenCalledOnce();
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
    expect(pane.scrollIntoView).toHaveBeenCalled();
    // An expanded view is only selected.
    await act(async () => views.querySelector<HTMLButtonElement>('[data-window-view-id="float"]')!.click());
    expect(test.operate).toHaveBeenLastCalledWith({ type: 'view.select', viewId: 'float' });
  } finally { pane.remove(); }
});

it('offers All Windows in the sidebar when an overview is available, and reports opening a Window', async () => {
  const overview = vi.fn(), navigate = vi.fn();
  const test = await fixture({ placement: 'sidebar', onOverview: overview, onNavigate: navigate });
  await act(async () => test.container.querySelector<HTMLButtonElement>('button[aria-label="Show all Windows"]')!.click());
  expect(overview).toHaveBeenCalledOnce();
  await act(async () => test.container.querySelector<HTMLButtonElement>('[data-window-id="other"]')!.click());
  expect(navigate).toHaveBeenCalledOnce();
});

it('shows no All Windows button without an overview', async () => {
  const test = await fixture({ placement: 'sidebar' });
  expect(test.container.querySelector('button[aria-label="Show all Windows"]')).toBeNull();
});

it('names All sessions in the sidebar\'s empty-views note', async () => {
  const test = await fixture({ placement: 'sidebar', views: [] });
  expect(test.container.textContent).toContain('No session views. Add one or open one from All sessions.');
});

it('neither scrolls nor navigates when choosing a view is refused', async () => {
  const navigate = vi.fn(), frame = vi.spyOn(window, 'requestAnimationFrame');
  const test = await fixture({ onNavigate: navigate });
  test.rejectLocal();
  await act(async () => test.container.querySelector<HTMLButtonElement>('[data-window-view-id="main"]')!.click());
  expect(test.container.textContent).toContain('This Window cannot be edited.');
  expect(frame).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
});

it('shows sidebar headings with icon actions, flat rows without check marks, and no delete note', async () => {
  const overview = vi.fn();
  const test = await fixture({ placement: 'sidebar', onOverview: overview, views: [
    createWindowView('main', undefined, 'primary'), { ...createWindowView('side', undefined, 'attached'), attachedTo: 'main' },
  ] });
  const root = test.container.querySelector('.lab-window-workspaces')!;
  expect(root.getAttribute('data-placement')).toBe('sidebar');
  expect([...root.querySelectorAll('.lab-window-section-heading > h2.lab-sidebar-section-title')].map(heading => heading.textContent)).toEqual(['Windows', 'In this Window']);
  const named = (name: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.getAttribute('aria-label') === name);
  for (const name of ['New Window', 'Show all Windows', 'New session view']) {
    const [button, ...others] = named(name);
    expect(others).toHaveLength(0);
    expect(button?.classList.contains('ui-icon-button')).toBe(true);
    expect(button?.textContent).toBe('');
    expect(button?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  }
  expect(named('Show all Windows')[0]!.classList.contains('lab-window-overview-trigger')).toBe(true);
  await act(async () => named('Show all Windows')[0]!.click());
  expect(overview).toHaveBeenCalledOnce();
  await act(async () => named('New session view')[0]!.click());
  expect(test.read().views).toHaveLength(3);
  expect(root.textContent).not.toContain('✓');
  expect(root.querySelector('.lab-window-selected')).toBeNull();
  expect(root.textContent).not.toContain('before deleting');
  // Current and selected rows keep aria-current, and indented views keep their depth.
  expect(root.querySelector('[data-window-id="window"]')?.getAttribute('aria-current')).toBe('true');
  expect(root.querySelector(`[data-window-view-id="${test.read().selectedViewId}"]`)?.getAttribute('aria-current')).toBe('true');
  expect(root.querySelector('[data-window-view-row="side"]')?.getAttribute('data-depth')).toBe('1');
  // Row actions keep their classes, names, titles and data attributes.
  const rename = root.querySelector<HTMLButtonElement>('.lab-window-rename-trigger[data-window-rename="other"]')!;
  expect([rename.getAttribute('aria-label'), rename.title]).toEqual(['Rename Window: Window', 'Rename this Window']);
  const deletes = [...root.querySelectorAll<HTMLButtonElement>('.lab-window-delete')];
  expect(deletes.map(button => [button.getAttribute('aria-label'), button.title, button.disabled])).toEqual([
    ['Delete Window: Project', 'Switch to another Window before deleting this one.', true],
    ['Delete Window: Window', 'Delete this layout. Agent sessions keep running.', false],
  ]);
  const close = root.querySelector<HTMLButtonElement>('.lab-window-view-close[data-window-view-close="main"]')!;
  expect([close.getAttribute('aria-label'), close.title, close.textContent]).toEqual(['Close session view: Empty view', 'Close this session view. Agent sessions keep running.', '']);
  for (const button of [rename, ...deletes, close]) expect(button.classList.contains('ui-icon-button')).toBe(true);
  await test.rename('other', 'Research');
  expect(test.renamed).toHaveBeenLastCalledWith('other', 'Research');
});

it('keeps the floating panel text buttons, check marks and delete note by default', async () => {
  const test = await fixture();
  const root = test.container.querySelector('.lab-window-workspaces')!;
  expect(root.getAttribute('data-placement')).toBe('panel');
  expect(test.button('New Window')).toBeDefined();
  // The floating panel's WindowMenu offers All Windows itself.
  expect(root.querySelector('button[aria-label="Show all Windows"]')).toBeNull();
  expect(root.querySelector('.lab-window-selected[aria-label="Current Window"]')?.textContent).toBe('✓');
  expect(root.querySelector('.lab-window-selected[aria-label="Selected view"]')?.textContent).toBe('✓');
  expect(root.textContent).toContain('Switch to another Window before deleting the active one.');
  expect(root.querySelector('.ui-icon-button')).toBeNull();
});

it.each(['panel', 'sidebar'] as const)('confirms deletion from the %s and cancels without removing a Window', async placement => {
  const test = await fixture({ placement });
  const trigger = () => test.container.querySelector<HTMLButtonElement>('[aria-label="Delete Window: Window"]')!;
  await act(async () => trigger().click());
  expect(test.remove).not.toHaveBeenCalled();
  let dialog = test.container.querySelector('dialog')!;
  expect(dialog?.open).toBe(true);
  expect(dialog?.dataset.detent).toBe('content');
  expect(dialog?.textContent).toContain('Delete this Window?');
  expect(dialog?.textContent).toContain('“Window”');
  expect(dialog?.textContent).toContain('agent sessions keep running');
  await act(async () => test.button('Cancel').click());
  expect(test.container.querySelector('dialog')).toBeNull();
  expect(test.container.querySelector('[data-window-id="other"]')).not.toBeNull();
  await act(async () => trigger().click());
  dialog = test.container.querySelector('dialog')!;
  await act(async () => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
  expect(test.container.querySelector('dialog')).toBeNull();
  expect(test.remove).not.toHaveBeenCalled();
  expect(test.container.querySelector('[data-window-id="other"]')).not.toBeNull();
});

it('deletes only the confirmed Window and keeps the open Window', async () => {
  const test = await fixture();
  await act(async () => test.container.querySelector<HTMLButtonElement>('[aria-label="Delete Window: Window"]')!.click());
  expect(test.remove).not.toHaveBeenCalled();
  await act(async () => test.button('Delete Window').click());
  expect(test.remove).toHaveBeenCalledExactlyOnceWith('other');
  expect(test.container.querySelector('[data-window-id="other"]')).toBeNull();
  expect(test.container.querySelector('[data-window-id="window"]')?.getAttribute('aria-current')).toBe('true');
  expect(test.container.querySelector('dialog')).toBeNull();
});

it('keeps pending deletion open and prevents another submission or dismissal', async () => {
  const test = await fixture();
  let finish!: () => void;
  test.setRemove(() => new Promise<void>(resolve => { finish = resolve; }));
  await act(async () => test.container.querySelector<HTMLButtonElement>('[aria-label="Delete Window: Window"]')!.click());
  const dialog = test.container.querySelector('dialog')!;
  const confirm = test.button('Delete Window');
  expect(confirm).toBeDefined();
  await act(async () => { confirm.click(); confirm.click(); });
  expect(confirm.disabled).toBe(true);
  expect(test.button('Cancel').disabled).toBe(true);
  expect(test.remove).toHaveBeenCalledExactlyOnceWith('other');
  await act(async () => {
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    dialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click();
  });
  expect(test.container.querySelector('dialog')).toBe(dialog);
  expect(dialog.open).toBe(true);
  await act(async () => finish());
  expect(test.container.querySelector('dialog')).toBeNull();
  expect(test.container.querySelector('[data-window-id="other"]')).toBeNull();
});

it.each([false, true])('keeps a failed deletion visible and retryable inside its sheet (shared actions: %s)', async sharedActions => {
  const test = await fixture({ sharedActions });
  test.setRemove(async () => { throw new Error('This Window could not be deleted. Try again.'); });
  await act(async () => test.container.querySelector<HTMLButtonElement>('[aria-label="Delete Window: Window"]')!.click());
  expect(test.button('Delete Window')).toBeDefined();
  await act(async () => test.button('Delete Window').click());
  const dialog = test.container.querySelector('dialog')!;
  expect(dialog?.open).toBe(true);
  expect(dialog?.querySelector('[role="alert"]')?.textContent).toBe('This Window could not be deleted. Try again.');
  expect(test.container.querySelector('[data-window-id="other"]')).not.toBeNull();
  expect(test.button('Delete Window').disabled).toBe(false);
  test.setRemove(async () => {});
  await act(async () => test.button('Delete Window').click());
  expect(test.remove).toHaveBeenNthCalledWith(2, 'other');
  expect(test.container.querySelector('dialog')).toBeNull();
  expect(test.container.querySelector('[data-window-id="other"]')).toBeNull();
});

it.each(['scope', 'window', 'panel'] as const)('closes stale deletion confirmation after a %s change', async change => {
  const test = await fixture();
  await act(async () => test.container.querySelector<HTMLButtonElement>('[aria-label="Delete Window: Window"]')!.click());
  expect(test.container.querySelector('dialog')?.open).toBe(true);
  if (change === 'scope') await test.changeScope();
  else if (change === 'window') await test.changeWindow();
  else { await test.setActive(false); await test.setActive(true); }
  expect(test.container.querySelector('dialog')).toBeNull();
  expect(test.remove).not.toHaveBeenCalled();
  expect(test.container.querySelector('[data-window-id="other"]')).not.toBeNull();
});

it('keeps Window deletion unavailable until another active Window is open', async () => {
  const test = await fixture();
  expect(test.container.querySelector<HTMLButtonElement>('[aria-label="Delete Window: Project"]')!.disabled).toBe(true);
  await test.deactivateWindow();
  const trigger = test.container.querySelector<HTMLButtonElement>('[aria-label="Delete Window: Window"]')!;
  expect(trigger.disabled).toBe(true);
  await act(async () => trigger.click());
  expect(test.container.querySelector('dialog')).toBeNull();
  expect(test.remove).not.toHaveBeenCalled();
});

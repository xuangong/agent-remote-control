import { act, useReducer } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { applyWindowOperation, createWindowView, type WindowOperation, type WindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import type { useWindowWorkspace } from '../hooks/useWindowWorkspace.js';
import { render } from '../test/setup.js';
import { WindowWorkspaces } from './WindowWorkspaces.js';
import { WindowWorkspaceClient } from '@orchardworks/agent-remote-web';
import { botGroup, mountBotApp, seedGroup, until } from '../test/bot-mode-fixtures.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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

async function fixture({ views = [createWindowView('main', undefined, 'primary')], ...props }: { views?: WindowView[] } & Pick<Parameters<typeof WindowWorkspaces>[0], 'onNavigate' | 'onOverview'> = {}) {
  let window: WorkspaceWindow = { schemaVersion: 3, id: 'window', title: 'Project', revision: 0, selectedPrimaryViewId: 'main', selectedViewId: 'main', views };
  let other: WorkspaceWindow = { ...window, id: 'other', title: 'Window' };
  const renamed = vi.fn();
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
    const workspace = { window, windows: [window, other], hasActiveWindow: true, unavailable: false, saveState,
      retrySave: retry, discardLocalChanges: discard, open: async () => {}, create: async () => {}, remove: async () => {}, operate,
      async rename(id: string, title: string) {
        renamed(id, title);
        if (id === window.id) return { saved: operate({ type: 'rename', title }) };
        const result = await renameOther(title); update(); return result;
      },
    } as unknown as ReturnType<typeof useWindowWorkspace>;
    return <WindowWorkspaces workspace={workspace} {...props} />;
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
  return { container, button, rename, renamed, operate, read: () => window, readOther: () => other, retry, discard, rejectSave,
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
  expect(test.container.textContent).toContain('No session views');
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

it('offers All Windows when an overview is available, and reports opening a Window', async () => {
  const overview = vi.fn(), navigate = vi.fn();
  const test = await fixture({ onOverview: overview, onNavigate: navigate });
  await act(async () => test.container.querySelector<HTMLButtonElement>('button[aria-label="Show all Windows"]')!.click());
  expect(overview).toHaveBeenCalledOnce();
  await act(async () => test.container.querySelector<HTMLButtonElement>('[data-window-id="other"]')!.click());
  expect(navigate).toHaveBeenCalledOnce();
});

it('shows no All Windows button without an overview', async () => {
  const test = await fixture();
  expect(test.container.querySelector('button[aria-label="Show all Windows"]')).toBeNull();
});

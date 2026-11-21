import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createWindowView, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { WindowWorkspaceClient } from '@orchardworks/agent-client';
import { botGroup, botTarget, mountBotApp, seedGroup, until } from './test/bot-mode-fixtures.js';

// jsdom has no modal dialogs; like browsers, closing queues the close event. The stubs are removed after each test.
const dialogMethods = ['showModal', 'close'] as const;
const originalDialog = Object.fromEntries(dialogMethods.map(name => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)]));
afterEach(() => {
  for (const name of dialogMethods) {
    const original = originalDialog[name];
    if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original); else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>)[name];
  }
});
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) {
    if (!this.open) return;
    this.removeAttribute('open');
    setTimeout(() => this.dispatchEvent(new Event('close')));
  } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/'); });

/** A Window without bot details; Bot mode shows it, so the toolbar offers "Hide in Bot mode". */
const windowGroup = (id: string, extra: WindowGroup['window']['views'] = []): WindowGroup => {
  const group = botGroup(id, false);
  return { ...group, window: { ...group.window, views: [...group.window.views, ...extra] } };
};
const toolbar = (container: ParentNode) => container.querySelector<HTMLElement>('header.lab-window-toolbar');
const titleButton = (container: ParentNode) => toolbar(container)!.querySelector<HTMLButtonElement>('button.lab-window-toolbar-title')!;
const sidebarRows = (container: ParentNode, nav: string) => [...container.querySelectorAll<HTMLElement>(`#lab-context nav[aria-label="${nav}"] .lab-window-row`)];
const type = (field: HTMLInputElement, text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, text);
  field.dispatchEvent(new Event('input', { bubbles: true }));
});
const press = (target: Element, key: string) => act(async () => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
});
async function choose(container: ParentNode, menu: string, label: string) {
  await act(async () => toolbar(container)!.querySelector<HTMLButtonElement>(`button[aria-label="${menu}"]`)!.click());
  const entry = [...document.querySelectorAll<HTMLElement>(`[role="menu"][aria-label="${menu}"] [role="menuitem"]`)].find(item => item.textContent === label);
  expect(entry, `${menu} → ${label}`).toBeDefined();
  await act(async () => entry!.click());
}
const sheet = (title: string) => [...document.querySelectorAll<HTMLDialogElement>('dialog.orchard-sheet')].find(dialog => dialog.querySelector('h2')?.textContent === title);
const sheetButton = (dialog: HTMLElement, label: string) => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!;

it('puts the toolbar first in the desktop workbench, showing the Window, and leaves it out of compact layouts', async () => {
  const scope = 'http://localhost/window-toolbar-placement/'; seedGroup(scope, windowGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(app.workspace().window?.id).toBe('A'));
    await until(() => expect(toolbar(app.container)).not.toBeNull());
    expect(app.container.querySelector('#lab-workbench')!.firstElementChild).toBe(toolbar(app.container));
    expect(toolbar(app.container)!.querySelector('h2')?.textContent).toBe('A');
    expect(toolbar(app.container)!.querySelector('.ui-toolbar-subtitle')?.textContent).toBe('2 bots');
    // The old shared-Window View options slot above the views is gone.
    expect(app.container.querySelector('.lab-window-controls')).toBeNull();
  } finally { await app.close(); }

  vi.stubGlobal('matchMedia', (media: string) => ({ matches: media === '(max-width: 1180px)', media, addEventListener() {}, removeEventListener() {} }));
  const compact = await mountBotApp(scope);
  try {
    await until(() => expect(compact.workspace().window?.id).toBe('A'));
    expect(toolbar(compact.container)).toBeNull();
  } finally { await compact.close(); }
});

it('renames the Window in place, and Escape cancels without leaving the Window', async () => {
  const scope = 'http://localhost/window-toolbar-rename/'; seedGroup(scope, windowGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(toolbar(app.container)).not.toBeNull());
    await act(async () => titleButton(app.container).click());
    let field = toolbar(app.container)!.querySelector<HTMLInputElement>('input[aria-label="Window title"]')!;
    await type(field, 'Discarded');
    await press(field, 'Escape');
    expect(toolbar(app.container)!.querySelector('input')).toBeNull();
    expect(document.activeElement).toBe(titleButton(app.container));
    expect(app.container.querySelector<HTMLElement>('#lab-sessions-page')!.hidden).toBe(true);
    expect(app.workspace().window?.title).toBe('A');

    await act(async () => titleButton(app.container).click());
    field = toolbar(app.container)!.querySelector<HTMLInputElement>('input[aria-label="Window title"]')!;
    await type(field, 'Research');
    await press(field, 'Enter');
    await until(() => expect(sidebarRows(app.container, 'Windows').find(row => row.dataset.windowRow === 'A')?.querySelector('strong')?.textContent).toBe('Research'));
    expect(titleButton(app.container).textContent).toBe('Research');
    expect(document.activeElement).toBe(titleButton(app.container));
  } finally { await app.close(); }
});

it('adds a session view, or opens All sessions for one, from the Add menu', async () => {
  const scope = 'http://localhost/window-toolbar-add/'; seedGroup(scope, windowGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(sidebarRows(app.container, 'Session views')).toHaveLength(2));
    await choose(app.container, 'Add', 'New session view');
    await until(() => expect(sidebarRows(app.container, 'Session views')).toHaveLength(3));
    const page = app.container.querySelector<HTMLElement>('#lab-sessions-page')!;
    expect(page.hidden).toBe(true);
    await choose(app.container, 'Add', 'Open session…');
    await until(() => expect(page.hidden).toBe(false));
    expect(page.getAttribute('aria-label')).toBe('All sessions');
    expect(sidebarRows(app.container, 'Session views')).toHaveLength(4);
  } finally { await app.close(); }
});

it('keeps View options at the toolbar\'s start when the sidebar is hidden', async () => {
  const scope = 'http://localhost/window-toolbar-view-options-hidden/'; seedGroup(scope, windowGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  const apple = /Mac|iPhone|iPad/.test(navigator.platform);
  try {
    await until(() => expect(toolbar(app.container)).not.toBeNull());
    const shown = toolbar(app.container)!.querySelector<HTMLButtonElement>('.ui-toolbar-leading button[aria-label="View options"]');
    expect(shown).not.toBeNull();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', metaKey: apple, ctrlKey: !apple, bubbles: true, cancelable: true })); });
    expect(app.container.querySelector<HTMLElement>('#lab-context')!.hidden).toBe(true);
    const trigger = toolbar(app.container)!.querySelector<HTMLButtonElement>('.ui-toolbar-leading button[aria-label="View options"]');
    expect(trigger).not.toBeNull();
    expect(app.button('View options')).toBe(trigger);
  } finally { await app.close(); }
});

it('moves the one View options entry into the Header while the Header shows, and back to the toolbar when it is hidden', async () => {
  const scope = 'http://localhost/window-toolbar-view-options-header/'; seedGroup(scope, windowGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  const header = () => app.container.querySelector<HTMLElement>('header.lab-app-bar')!;
  const triggers = () => app.container.querySelectorAll<HTMLButtonElement>('button[aria-label="View options"]');
  const toggleHeader = async () => {
    await act(async () => app.button('View options')!.click());
    await act(async () => app.container.querySelector<HTMLInputElement>('input[data-view-control="header"]')!.click());
    await act(async () => { if (app.container.querySelector('#lab-view-options-panel')) app.button('View options')!.click(); });
  };
  try {
    await until(() => expect(toolbar(app.container)).not.toBeNull());
    expect(header().hidden).toBe(true);
    expect(triggers()).toHaveLength(1);
    expect(toolbar(app.container)!.contains(triggers()[0]!)).toBe(true);
    await toggleHeader();
    await until(() => expect(header().hidden).toBe(false));
    expect(triggers()).toHaveLength(1);
    expect(header().contains(triggers()[0]!)).toBe(true);
    await toggleHeader();
    await until(() => expect(header().hidden).toBe(true));
    expect(triggers()).toHaveLength(1);
    expect(toolbar(app.container)!.contains(triggers()[0]!)).toBe(true);
  } finally { await app.close(); }
});

it('confirms before deleting the Window, then shows another one', async () => {
  const scope = 'http://localhost/window-toolbar-delete/'; seedGroup(scope, windowGroup('A')); seedGroup(scope, windowGroup('B'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(sidebarRows(app.container, 'Windows').map(row => row.dataset.windowRow).sort()).toEqual(['A', 'B']));
    await choose(app.container, 'Window actions', 'Delete Window…');
    const dialog = sheet('Delete this Window?')!;
    expect(dialog?.open).toBe(true);
    expect(dialog.textContent).toContain('Its agent sessions keep running');
    expect(dialog.textContent).not.toContain('new empty Window');
    await act(async () => sheetButton(dialog, 'Cancel').click());
    expect(sheet('Delete this Window?')?.open ?? false).toBe(false);
    expect(app.workspace().window?.id).toBe('A');

    await choose(app.container, 'Window actions', 'Delete Window…');
    await act(async () => sheetButton(sheet('Delete this Window?')!, 'Delete Window').click());
    await until(() => expect(app.workspace().window?.id).toBe('B'));
    await until(() => expect(sidebarRows(app.container, 'Windows').map(row => row.dataset.windowRow)).toEqual(['B']));
  } finally { await app.close(); }
});

it('shares Window actions with the sidebar and shows their notices as toasts', async () => {
  const scope = 'http://localhost/window-toolbar-notice/'; seedGroup(scope, windowGroup('A'));
  history.replaceState(null, '', '/?window=A');
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => {}) } });
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(toolbar(app.container)).not.toBeNull());
    await choose(app.container, 'Window actions', 'Copy link');
    await until(() => expect([...document.querySelectorAll('.lab-toast')].some(node => node.textContent?.includes('Window link copied.'))).toBe(true));
    // The sidebar does not repeat the notice the toast shows.
    expect(app.container.querySelector('#lab-context .lab-window-workspaces')!.textContent).not.toContain('Window link copied.');
  } finally { await app.close(); }
});

it('shows a cached Window read-only during a cold start: only Copy link acts, and nothing is changed', async () => {
  const scope = 'http://localhost/window-toolbar-provisional/'; seedGroup(scope, windowGroup('A')); seedGroup(scope, windowGroup('B'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope, { hosted: true, holdInspect: true });
  const mutate = vi.mocked(WindowWorkspaceClient.prototype.mutate);
  try {
    await until(() => expect(toolbar(app.container)).not.toBeNull());
    expect(app.container.querySelector('#lab-workbench')!.getAttribute('data-window-provisional')).toBe('true');
    expect(titleButton(app.container).disabled).toBe(true);
    const disabled = (label: string) => [...document.querySelectorAll<HTMLElement>(`[role="menu"][aria-label="${label}"] [role="menuitem"]`)]
      .filter(item => item.getAttribute('aria-disabled') === 'true').map(item => item.textContent);
    const pick = (menu: string, label: string) => act(async () => [...document.querySelectorAll<HTMLElement>(`[role="menu"][aria-label="${menu}"] [role="menuitem"]`)]
      .find(item => item.textContent === label)!.click());
    const open = (menu: string) => act(async () => { if (!document.querySelector(`[role="menu"][aria-label="${menu}"]`)) toolbar(app.container)!.querySelector<HTMLButtonElement>(`button[aria-label="${menu}"]`)!.click(); });
    await open('Add');
    expect(disabled('Add')).toEqual(['New session view', 'Open session…']);
    await pick('Add', 'New session view');
    await press(document.querySelector('[role="menu"][aria-label="Add"]') ?? document.body, 'Escape');
    await open('Window actions');
    expect(disabled('Window actions')).toEqual(['Hide in Bot mode', 'Delete Window…']);
    await pick('Window actions', 'Delete Window…');
    expect(sheet('Delete this Window?')).toBeUndefined();
    await pick('Window actions', 'Hide in Bot mode');
    expect(app.workspace().window?.views).toHaveLength(2);
    expect(mutate).not.toHaveBeenCalled();
    app.releaseInspect();
    await until(() => expect(app.container.querySelector('#lab-workbench')!.hasAttribute('data-window-provisional')).toBe(false));
    expect(titleButton(app.container).disabled).toBe(false);
  } finally { await app.close(); }
});

it('closes the toolbar sheets when the toolbar goes away', async () => {
  const scope = 'http://localhost/window-toolbar-sheet-mode/'; seedGroup(scope, windowGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(toolbar(app.container)).not.toBeNull());
    await choose(app.container, 'Window actions', 'Delete Window…');
    expect(sheet('Delete this Window?')?.open).toBe(true);
    await app.switchMode('bot');
    expect(sheet('Delete this Window?')).toBeUndefined();
    await app.switchMode('window');
    await until(() => expect(toolbar(app.container)).not.toBeNull());
    expect(sheet('Delete this Window?')).toBeUndefined();
  } finally { await app.close(); }
});

it('shows a failed Window action as an error toast', async () => {
  const scope = 'http://localhost/window-toolbar-error-toast/'; seedGroup(scope, windowGroup('A'));
  history.replaceState(null, '', '/?window=A');
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error('Clipboard blocked'); }) } });
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(toolbar(app.container)).not.toBeNull());
    await choose(app.container, 'Window actions', 'Copy link');
    await until(() => expect([...document.querySelectorAll<HTMLElement>('.lab-toast')].find(node => node.textContent?.includes('Clipboard blocked'))?.dataset.tone).toBe('error'));
  } finally { await app.close(); }
});

it.each([
  ['no session views', () => [] as WindowGroup['window']['views'], {}],
  ['floating views only', () => [createWindowView('float', botTarget('F'), 'float')], {}],
  ['docks only', () => [createWindowView('dock', botTarget('D'), 'dock')], {}],
  ['a minimized primary group', () => [{ ...createWindowView('primary', botTarget('P'), 'primary'), collapsed: true }], {}],
  ['a provisional Window', () => [createWindowView('primary', botTarget('P'), 'primary')], { hosted: true, holdInspect: true }],
] as const)('keeps View options in the toolbar, with the sidebar hidden, for %s', async (_case, views, options) => {
  const scope = `http://localhost/window-toolbar-view-${_case.replace(/\W+/g, '-')}/`;
  const group = botGroup('A', false);
  seedGroup(scope, { ...group, window: { ...group.window, views: views(), selectedPrimaryViewId: views().find(view => view.placement === 'primary')?.id ?? null, selectedViewId: views()[0]?.id ?? null } });
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope, options);
  const apple = /Mac|iPhone|iPad/.test(navigator.platform);
  try {
    await until(() => expect(toolbar(app.container)).not.toBeNull());
    if (options === undefined || !('holdInspect' in options)) expect(app.container.querySelector('#lab-workbench')!.hasAttribute('data-window-provisional')).toBe(false);
    else expect(app.container.querySelector('#lab-workbench')!.getAttribute('data-window-provisional')).toBe('true');
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', metaKey: apple, ctrlKey: !apple, bubbles: true, cancelable: true })); });
    expect(app.container.querySelector<HTMLElement>('#lab-context')!.hidden).toBe(true);
    await until(() => expect(app.button('View options')?.closest('header.lab-window-toolbar')).toBe(toolbar(app.container)));
    expect(app.container.querySelectorAll('button[aria-label="View options"]')).toHaveLength(1);
  } finally { await app.close(); }
});

it('keeps View options at the start of the Window toolbar while the sidebar shows, with no heading row above the Windows', async () => {
  const scope = 'http://localhost/window-toolbar-view-options/'; seedGroup(scope, windowGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(toolbar(app.container)).not.toBeNull());
    await until(() => expect(app.container.querySelector('#lab-context nav[aria-label="Windows"]')).not.toBeNull());
    // One place for View options in a desktop Window, as Bot mode's toolbar keeps its sidebar control at its start.
    expect(app.button('View options').closest('header.lab-window-toolbar .ui-toolbar-leading')).not.toBeNull();
    // The sidebar starts with the mode switch, then its Windows: the old View and "Window" row is gone.
    expect(app.container.querySelector('#lab-context .lab-rail-heading')).toBeNull();
    expect(app.container.querySelector('#lab-context .lab-eyebrow')).toBeNull();
  } finally { await app.close(); }
});

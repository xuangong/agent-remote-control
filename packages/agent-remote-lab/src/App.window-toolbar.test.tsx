import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createWindowView, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { botGroup, botTarget, mountBotApp, seedGroup, until } from './test/bot-mode-fixtures.js';

// jsdom has no modal dialogs; like browsers, closing queues the close event.
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) {
    if (!this.open) return;
    this.removeAttribute('open');
    setTimeout(() => this.dispatchEvent(new Event('close')));
  } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/'); });

/** A Window that is not a Bot section, so the toolbar offers "Show as section". */
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
const sheet = (title: string) => [...document.querySelectorAll<HTMLDialogElement>('dialog.ui-sheet')].find(dialog => dialog.querySelector('h2')?.textContent === title);
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
    expect(toolbar(app.container)!.querySelector('.ui-toolbar-subtitle')?.textContent).toBe('2 session views');
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

it('hides and shows the docks, remembering the choice, without dropping focus from a hidden dock', async () => {
  const scope = 'http://localhost/window-toolbar-docks/';
  seedGroup(scope, windowGroup('A', [createWindowView('A-dock', botTarget('Adock'), 'dock')]));
  history.replaceState(null, '', '/?window=A');
  const toggle = (container: ParentNode, label: string) => toolbar(container)!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  let app = await mountBotApp(scope);
  try {
    await until(() => expect(app.container.querySelector('.lab-session-dock-pane')).not.toBeNull());
    expect(app.container.querySelector('.lab-session-dock-pane[hidden]')).toBeNull();
    const hide = toggle(app.container, 'Hide docks')!;
    expect(hide.getAttribute('aria-pressed')).toBe('false');
    // Focus inside a dock pane moves to the toggle rather than falling to the page when the pane hides.
    const inside = app.container.querySelector<HTMLElement>('.lab-session-dock-pane button, .lab-session-dock-pane [tabindex]')!;
    inside.focus();
    expect(document.activeElement).toBe(inside);
    await act(async () => hide.click());
    expect(app.container.querySelector('.lab-session-dock-pane[hidden]')).not.toBeNull();
    expect(toggle(app.container, 'Show docks')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(toggle(app.container, 'Show docks'));
  } finally { await app.close(); }

  app = await mountBotApp(scope);
  try {
    await until(() => expect(toggle(app.container, 'Show docks')).not.toBeNull());
    await until(() => expect(app.container.querySelector('.lab-session-dock-pane[hidden]')).not.toBeNull());
    await act(async () => toggle(app.container, 'Show docks')!.click());
    expect(app.container.querySelector('.lab-session-dock-pane[hidden]')).toBeNull();
    expect(toggle(app.container, 'Hide docks')).not.toBeNull();
  } finally { await app.close(); }
});

it('moves View options into the toolbar when the sidebar is hidden', async () => {
  const scope = 'http://localhost/window-toolbar-view-options/'; seedGroup(scope, windowGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  const apple = /Mac|iPhone|iPad/.test(navigator.platform);
  try {
    await until(() => expect(toolbar(app.container)).not.toBeNull());
    expect(toolbar(app.container)!.querySelector('button[aria-label="View options"]')).toBeNull();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', metaKey: apple, ctrlKey: !apple, bubbles: true, cancelable: true })); });
    expect(app.container.querySelector<HTMLElement>('#lab-context')!.hidden).toBe(true);
    const trigger = toolbar(app.container)!.querySelector<HTMLButtonElement>('.ui-toolbar-leading button[aria-label="View options"]');
    expect(trigger).not.toBeNull();
    expect(app.button('View options')).toBe(trigger);
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

it('says that deleting the only Window leaves a new empty one', async () => {
  const scope = 'http://localhost/window-toolbar-delete-last/'; seedGroup(scope, windowGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(toolbar(app.container)).not.toBeNull());
    await choose(app.container, 'Window actions', 'Delete Window…');
    expect(sheet('Delete this Window?')!.textContent).toContain('A new empty Window opens in its place.');
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

it('opens Agent control in a sheet', async () => {
  const scope = 'http://localhost/window-toolbar-agent-control/'; seedGroup(scope, windowGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope, { hosted: true });
  try {
    await until(() => expect(app.workspace().client).toBeDefined());
    await until(() => expect(toolbar(app.container)).not.toBeNull());
    await choose(app.container, 'Window actions', 'Agent control…');
    const dialog = sheet('Agent control')!;
    expect(dialog?.open).toBe(true);
    expect(dialog.textContent).toContain('Name the session that arranges this Window.');
  } finally { await app.close(); }
});

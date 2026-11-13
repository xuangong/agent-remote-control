import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWindowView, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { botGroup, botTarget, mountBotApp, seedGroup, until, visibleButton } from './test/bot-mode-fixtures.js';

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

/** A Window that is not a Bot section, with its own title. */
const windowGroup = (id: string, title: string): WindowGroup => { const group = botGroup(id, false); return { ...group, window: { ...group.window, title } }; };
/** A Bot section whose first bot has a name of its own. */
const section = (id: string, title: string, bot: string): WindowGroup => {
  const group = botGroup(id);
  return { ...group, window: { ...group.window, title, views: [createWindowView(`${id}1`, { ...botTarget(`${id}1`), title: bot }, 'primary'), ...group.window.views.slice(1)] } };
};
const palette = (container: ParentNode) => container.querySelector<HTMLDialogElement>('dialog[aria-label="Search"]')!;
/** The palette is mounted only while it is open. */
const paletteOpen = (container: ParentNode) => !!container.querySelector<HTMLDialogElement>('dialog[aria-label="Search"]')?.open;
const field = (container: ParentNode) => palette(container).querySelector<HTMLInputElement>('input[role="combobox"]')!;
/** Command-K on Apple systems; jsdom reports no platform, so Control-K. */
const shortcut = (target: Element = document.body) => act(async () => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true }));
});
async function search(container: ParentNode, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(container), text);
    field(container).dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { field(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve)); });
}
const releaseAndSettle = (app: Awaited<ReturnType<typeof mountBotApp>>) => act(async () => { app.releaseInspect(); await new Promise(resolve => setTimeout(resolve, 20)); });
const currentBot = (container: ParentNode) => container.querySelector('[aria-label="Bots"] [aria-current="true"]')?.getAttribute('aria-label');

it('opens with Control-K from the composer, switches Windows and opens pages, and closes on Escape', async () => {
  const scope = 'http://localhost/palette-window/';
  seedGroup(scope, windowGroup('A', 'Alpha')); seedGroup(scope, windowGroup('R', 'Research'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(app.workspace().window?.id).toBe('A'));
    // Both sidebars hold a Search button; only the current mode's is reachable.
    expect(app.container.querySelectorAll('button[aria-label="Search"]')).toHaveLength(2);
    expect([...app.container.querySelectorAll('button[aria-label="Search"]')].filter(button => !button.closest('[hidden], [inert]'))).toHaveLength(1);
    expect(palette(app.container)).toBeNull();
    await until(() => expect(app.container.querySelector('.lab-window-mode [role="textbox"]')).not.toBeNull());
    const composer = app.container.querySelector<HTMLElement>('.lab-window-mode [role="textbox"]')!;
    composer.focus();
    await shortcut(composer);
    expect(paletteOpen(app.container)).toBe(true);
    expect(document.activeElement).toBe(field(app.container));
    await search(app.container, 'Research');
    await until(() => expect(app.workspace().window?.id).toBe('R'));
    expect(paletteOpen(app.container)).toBe(false);

    await shortcut();
    await search(app.container, 'All sessions');
    expect(paletteOpen(app.container)).toBe(false);
    const page = app.container.querySelector<HTMLElement>('#lab-sessions-page')!;
    expect(page.hidden).toBe(false);
    expect(page.getAttribute('aria-label')).toBe('All sessions');

    await shortcut();
    expect(paletteOpen(app.container)).toBe(true);
    await act(async () => { palette(app.container).dispatchEvent(new Event('cancel', { cancelable: true })); });
    expect(paletteOpen(app.container)).toBe(false);
    // Browsers return focus to the opener when the modal closes (see the command-palette e2e); jsdom does not.
  } finally { await app.close(); }
});

it('opens a session in the view that shows it, in the current Window or in another one', async () => {
  const scope = 'http://localhost/palette-sessions/';
  seedGroup(scope, windowGroup('A', 'Alpha')); seedGroup(scope, windowGroup('R', 'Research'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(app.workspace().window?.selectedViewId).toBe('A2'));
    await shortcut();
    await search(app.container, 'A1');
    await until(() => expect(app.workspace().window?.selectedViewId).toBe('A1'));
    expect(app.workspace().window?.id).toBe('A');

    // R1 shows only in Window R, which still selects R2.
    await shortcut();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(app.container), 'R1');
      field(app.container).dispatchEvent(new Event('input', { bubbles: true }));
    });
    const result = palette(app.container).querySelector('[role="group"][aria-label="Sessions"] [role="option"]');
    expect(result?.querySelector('.lab-command-title')?.textContent).toBe('R1');
    expect(result?.querySelector('.lab-command-subtitle')?.textContent).toBe('Lab server · Recorded Provider');
    await search(app.container, 'R1');
    await until(() => expect(app.workspace().window?.id).toBe('R'));
    await until(() => expect(app.workspace().window?.selectedViewId).toBe('R1'));
  } finally { await app.close(); }
});

it('selects a bot from Bot mode, and opens a Window from Bot mode in Window mode', async () => {
  const scope = 'http://localhost/palette-bots/';
  seedGroup(scope, windowGroup('A', 'Alpha')); seedGroup(scope, windowGroup('R', 'Research')); seedGroup(scope, section('S', 'Support', 'Helper'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(app.workspace().window?.id).toBe('A'));
    await app.switchMode('bot');
    const button = visibleButton(app.container, 'Search');
    expect(button.closest('[data-workbench-mode="bot"]')).not.toBeNull();
    await act(async () => button.click());
    expect(paletteOpen(app.container)).toBe(true);
    await search(app.container, 'Helper');
    await until(() => expect(currentBot(app.container)).toBe('Helper'));
    await until(() => expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).not.toBeNull());

    await shortcut();
    await search(app.container, 'Research');
    await until(() => expect(app.workspace().window?.id).toBe('R'));
    expect(app.container.querySelector<HTMLElement>('[data-workbench-mode="window"]')!.hidden).toBe(false);
    // The opener was in Bot mode, now hidden: focus moves to the shown mode's Search button.
    expect(document.activeElement).toBe(visibleButton(app.container, 'Search'));
    expect(document.activeElement!.closest('[data-workbench-mode="window"]')).not.toBeNull();
    await shortcut();
    await search(app.container, 'Switch to Bot mode');
    await until(() => expect(document.activeElement?.closest('[data-workbench-mode="bot"]')).not.toBeNull());
    expect(document.activeElement).toBe(visibleButton(app.container, 'Search'));

    // A Window made from Bot mode stays open once Window mode restores its Window.
    await app.switchMode('bot');
    await shortcut();
    await search(app.container, 'New Window');
    await until(() => expect(app.workspace().window?.id).toMatch(/^(?!(A|R|S)$)/));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(app.workspace().window?.id).toMatch(/^(?!(A|R|S)$)/);
    expect(app.workspace().windows.map(window => window.id)).toEqual(expect.arrayContaining(['A', 'R', app.workspace().window!.id]));
  } finally { await app.close(); }
});

describe('from Bot mode while the hosted Window is still loading', () => {
  const start = async (scope: string) => {
    // Hidden in Bot mode, the Window's sessions are no bots there, so search offers them as sessions that open in Window mode.
    seedGroup(scope, { ...windowGroup('A', 'Alpha'), presentation: { bots: false } });
    history.replaceState(null, '', '/?window=A');
    const app = await mountBotApp(scope, { hosted: true, holdInspect: true });
    await until(() => expect(app.workspace().window?.id).toBe('A'));
    expect(app.workspace().provisional).toBe(true);
    await app.switchMode('bot');
    return app;
  };
  const notices = (container: ParentNode) => [...(container.ownerDocument ?? document).querySelectorAll('[role="status"], [role="alert"]')].map(node => node.textContent).join(' ');

  it('opens a session shown in the restored Window once the Window loads', async () => {
    const app = await start('http://localhost/palette-held-session/');
    try {
      await shortcut();
      await search(app.container, 'A1');
      expect(app.container.querySelector<HTMLElement>('[data-workbench-mode="window"]')!.hidden).toBe(false);
      expect(app.workspace().window?.selectedViewId).toBe('A2');
      await releaseAndSettle(app);
      await until(() => expect(app.workspace().provisional).toBe(false));
      await until(() => expect(app.workspace().window?.selectedViewId).toBe('A1'));
      expect(notices(app.container)).not.toContain('Wait for this Window to load');
    } finally { await app.close(); }
  });

  it('adds a session view once the Window loads', async () => {
    const app = await start('http://localhost/palette-held-view/');
    try {
      await shortcut();
      await search(app.container, 'New session view');
      expect(app.workspace().window?.views).toHaveLength(2);
      await releaseAndSettle(app);
      await until(() => expect(app.workspace().window?.views).toHaveLength(3));
      const added = app.workspace().window!.views.find(view => !['A1', 'A2'].includes(view.id))!;
      expect(app.workspace().window?.selectedViewId).toBe(added.id);
    } finally { await app.close(); }
  });

  it('drops the step when Window mode is left before the Window loads', async () => {
    const app = await start('http://localhost/palette-held-left/');
    try {
      await shortcut();
      await search(app.container, 'A1');
      await app.switchMode('bot');
      await releaseAndSettle(app);
      await until(() => expect(app.workspace().readGroup('A')?.window.revision).toBeDefined());
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
      await app.switchMode('window');
      await until(() => expect(app.workspace().provisional).toBe(false));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
      expect(app.workspace().window?.selectedViewId).toBe('A2');
    } finally { await app.close(); }
  });
});

it('keeps focus on the page when Hide sidebar runs from the sidebar Search button', async () => {
  const scope = 'http://localhost/palette-hide-sidebar/';
  seedGroup(scope, windowGroup('A', 'Alpha'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(app.workspace().window?.id).toBe('A'));
    const searchButton = app.container.querySelector<HTMLButtonElement>('#lab-context button[aria-label="Search"]')!;
    searchButton.focus();
    await act(async () => searchButton.click());
    expect(paletteOpen(app.container)).toBe(true);
    await search(app.container, 'Hide sidebar');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(paletteOpen(app.container)).toBe(false);
    expect(app.container.querySelector<HTMLElement>('#lab-context')!.closest('[hidden]')).not.toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.getElementById('lab-context')!.contains(document.activeElement)).toBe(false);
  } finally { await app.close(); }
});

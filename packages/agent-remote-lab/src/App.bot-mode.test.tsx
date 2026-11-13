import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createWindowView } from '@orchardworks/agent-remote-protocol';
import { botGroup, botTarget, mountBotApp, seedGroup, until } from './test/bot-mode-fixtures.js';
import * as workspaceHooks from './hooks/useWindowWorkspace.js';
import * as trackingHooks from './hooks/useSessionTracking.js';
import { promptText, setPromptText } from './test/setup.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

it('keeps Window A/A2 and both display settings while Bot B1 shares its exact view draft', async () => {
  const scope = 'http://localhost/bot-place/';
  const a = botGroup('A'), b = botGroup('B', false);
  seedGroup(scope, a); seedGroup(scope, b); history.replaceState(null, '', '/?window=B');
  const app = await mountBotApp(scope);
  await until(() => expect(app.workspace().window?.id).toBe('B'));
  await act(async () => app.button('Windows').click());
  await act(async () => app.button('Show as section').click());
  await until(() => expect(app.workspace().readGroup('B')?.bots).toBeDefined());
  await act(async () => app.workspace().open('A'));
  const before = structuredClone(app.workspace().window);
  const bDisplay = structuredClone(app.workspace().readGroup('B')!.window.views.map(view => view.display));
  await app.switchMode('bot');
  await act(async () => app.button('B1').click());
  await until(() => expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).not.toBeNull());
  const editor = app.container.querySelector<HTMLElement>('.lab-bot-conversation [role="textbox"]')!;
  await act(async () => { setPromptText(editor, 'B1 draft'); editor.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(app.workspace().window).toEqual(before);
  expect(app.workspace().readGroup('B')?.window.selectedViewId).toBe('B2');
  expect(app.sendMessages).toHaveLength(0);
  await app.switchMode('window');
  expect(app.workspace().window).toEqual(before);
  await act(async () => app.workspace().open('B'));
  await until(() => expect([...app.container.querySelectorAll<HTMLElement>('.lab-window-mode [role="textbox"]')].some(input => promptText(input) === 'B1 draft')).toBe(true));
  await app.switchMode('bot');
  expect(app.container.querySelector('[aria-label="Bots"] [aria-current="true"]')?.getAttribute('aria-label')).toBe('B1');
  expect(promptText(app.container.querySelector<HTMLElement>('.lab-bot-conversation [role="textbox"]')!)).toBe('B1 draft');
  expect(app.workspace().readGroup('B')!.window.views.map(view => view.display)).toEqual(bDisplay);
  await app.close();
});

it('restores independent bot selection and mode on reload and ignores corrupt preferences', async () => {
  const scope = 'http://localhost/bot-reload/'; seedGroup(scope, botGroup('A')); seedGroup(scope, botGroup('B'));
  history.replaceState(null, '', '/?window=A');
  let app = await mountBotApp(scope);
  await app.switchMode('bot');
  await act(async () => app.button('A1').click());
  await act(async () => app.button('B1').click());
  await act(async () => app.button('A1').click());
  await app.close(); history.replaceState(null, '', '/');
  app = await mountBotApp(scope);
  await until(() => expect(app.container.querySelector('[aria-label="Bots"] [aria-current="true"]')?.getAttribute('aria-label')).toBe('A1'));
  expect(app.button('Bot mode').getAttribute('aria-pressed')).toBe('true');
  await app.close(); localStorage.setItem('agent-remote:workbench-mode', 'broken'); history.replaceState(null, '', '/');
  app = await mountBotApp(scope);
  expect(app.container.querySelector('[data-workbench-mode="window"]')?.hasAttribute('hidden')).toBe(false);
  await app.close();
});

it('keeps mode navigation available when the Window is unavailable', async () => {
  const scope = 'http://localhost/bot-unavailable/'; seedGroup(scope, botGroup('B'));
  history.replaceState(null, '', '/?window=missing');
  const app = await mountBotApp(scope);
  await until(() => expect(app.workspace().unavailable).toBe(true));
  await app.switchMode('bot');
  await act(async () => app.button('B1').click());
  await until(() => expect(app.attachments).toContain('B1'));
  expect(app.workspace().window?.id).not.toBe('B');
  await app.close();
});

it('opens section-only routes without restoring stale session query parameters', async () => {
  const scope = 'http://localhost/bot-section/'; const group = botGroup('B'); group.presentation = { window: false };
  seedGroup(scope, group); history.replaceState(null, '', '/?mode=bot&section=B&session=stale&provider=recorded&host=local');
  const app = await mountBotApp(scope);
  await until(() => expect(app.container.querySelector('[aria-label="Bots"]')).not.toBeNull());
  expect(app.attachments).not.toContain('stale');
  expect(app.container.querySelector('[data-window-id="B"]')).toBeNull();
  await app.close();
});

it('keeps the same visible Bot editor and content while Access suspends and resumes its live operations', async () => {
  const scope = 'http://localhost/bot-access/'; seedGroup(scope, botGroup('B')); history.replaceState(null, '', '/?mode=bot&section=B&bot=B1');
  const app = await mountBotApp(scope, { hosted: true, timeline: [{ providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: 'now', turnId: 'B1-turn',
    resources: [], collapsed: [], sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], item: { type: 'assistant_message', text: 'Readable Bot content' } }] });
  const pane = () => app.container.querySelector('.lab-bot-conversation')!;
  try {
    await until(() => expect(pane().querySelector('[role="textbox"]')).not.toBeNull());
    const editor = pane().querySelector<HTMLElement>('[role="textbox"]')!;
    await act(async () => { setPromptText(editor, 'retain Bot draft'); editor.dispatchEvent(new Event('input', { bubbles: true })); });
    await until(() => expect(pane().textContent).toContain('Readable Bot content'));
    const attachments = [...app.attachments], connect = vi.spyOn(app.transport, 'connect');
    await act(async () => app.setAccessReady(false));
    expect(editor.isConnected).toBe(true); expect(editor.closest('[hidden]')).toBeNull();
    expect(pane().querySelector('[role="textbox"]')).toBe(editor);
    expect(pane().textContent).toContain('Readable Bot content'); expect(promptText(editor)).toBe('retain Bot draft');
    expect(pane().querySelector('[data-testid="prompt-submit"]:enabled')).toBeNull();
    await act(async () => { pane().querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')?.click(); });
    expect(app.sendMessages).toEqual([]); expect(app.attachments).toEqual(attachments); expect(connect).not.toHaveBeenCalled();
    await expect(app.workspace().operateGroup('B', { type: 'rename', title: 'Forbidden' })).rejects.toThrow(/access|scope/);
    await act(async () => app.setAccessReady(true));
    await until(() => expect(pane().querySelector('[data-testid="prompt-submit"]:enabled')).not.toBeNull());
    expect(pane().querySelector('[role="textbox"]')).toBe(editor); expect(editor.closest('[hidden]')).toBeNull();
    expect(promptText(editor)).toBe('retain Bot draft'); expect(pane().textContent).toContain('Readable Bot content');
    expect(app.sendMessages).toEqual([]);
  } finally { await app.close(); }
});

// A Side (attached) or managed view stays a bot, so the changes that end a bot are deletion, another session, history, becoming an Ask and another scope.
it.each(['deleted', 'rebound', 'history', 'ask', 'scope'] as const)('does not retain an Access-suspended Bot presentation after %s replacement', async change => {
  const scope = `http://localhost/bot-access-${change}/`; seedGroup(scope, botGroup('B')); history.replaceState(null, '', '/?mode=bot&section=B&bot=B1');
  const app = await mountBotApp(scope, { hosted: true });
  try {
    await until(() => expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).not.toBeNull());
    const editor = app.container.querySelector('.lab-bot-conversation [role="textbox"]')!;
    await act(async () => app.setAccessReady(false));
    expect(editor.isConnected).toBe(true);
    if (change === 'scope') await act(async () => app.setScope(`${scope}other/`));
    else {
      const group = structuredClone(app.hostedGroups.get('B')!); group.window.revision++;
      if (change === 'deleted') group.window.views = group.window.views.filter(view => view.id !== 'B1');
      else if (change === 'history') group.window.views[0]!.binding = { ...group.window.views[0]!.binding!, sessionIntent: 'history' };
      else if (change === 'ask') { group.window.views[0]!.feature = { kind: 'ask', id: 'ask-1' }; group.window.views[0]!.bindingPolicy = 'managed'; }
      else group.window.views[0]!.binding = botTarget('replacement');
      app.hostedGroups.set('B', group);
      await act(async () => app.setAccessReady(true));
      await act(async () => app.workspace().refreshGroups());
    }
    await until(() => expect(editor.isConnected).toBe(false));
    expect(app.sendMessages).toEqual([]);
  } finally { await app.close(); }
});

it('puts the mode switch and the New menu at the top of the Window sidebar, not in the app bar', async () => {
  const scope = 'http://localhost/sidebar-header/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(app.container.querySelector('#lab-context .lab-sidebar-header')).not.toBeNull());
    await until(() => expect(app.workspace().window?.id).toBe('A'));
    const header = app.container.querySelector('#lab-context .lab-sidebar-header')!;
    expect(header.querySelector('nav[aria-label="Workbench mode"] [aria-pressed="true"]')?.textContent).toBe('Window mode');
    expect(app.container.querySelector('.lab-app-bar nav[aria-label="Workbench mode"]')).toBeNull();
    const newSessionPanel = () => app.container.querySelector('#lab-sessions-page .lab-provider-controls')!;
    expect(newSessionPanel().closest('[hidden]')).not.toBeNull();
    const open = async () => act(async () => (header.querySelector('button[aria-label="New"]') as HTMLButtonElement).click());
    const item = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menu"][aria-label="New"] [role="menuitem"]')].find(entry => entry.textContent === label)!;
    await open();
    expect([...document.querySelectorAll('[role="menu"][aria-label="New"] [role="menuitem"]')].map(entry => entry.textContent)).toEqual(['New session', 'New Window']);
    await act(async () => item('New session').click());
    expect(newSessionPanel().closest('[hidden]')).toBeNull();
    expect(app.container.querySelector<HTMLElement>('#lab-sessions-page[aria-label="New session"]')?.hidden).toBe(false);
    await open();
    await act(async () => item('New Window').click());
    await until(() => expect(app.workspace().window?.id).toMatch(/^(?!A$)/));
    expect(app.workspace().windows.map(window => window.id)).toContain('A');
  } finally { await app.close(); }
});

it('creates one Window at a time from the New menu and clears its error toast after a success', async () => {
  const scope = 'http://localhost/sidebar-new-window/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    const pending: { resolve(): void; reject(error: Error): void }[] = [];
    const create = vi.fn(() => new Promise<void>((resolve, reject) => pending.push({ resolve, reject })));
    const hook = vi.mocked(workspaceHooks.useWindowWorkspace), original = hook.getMockImplementation()!;
    hook.mockImplementation((...args) => ({ ...original(...args), create }));
    await until(() => expect(app.workspace().window?.id).toBe('A'));
    // Re-render App so its handlers read the stubbed create. Opening All sessions is only a convenient state change here; the page plays no part in this test.
    await act(async () => app.button('All sessions').click());
    const header = app.container.querySelector('#lab-context .lab-sidebar-header')!;
    const item = async () => {
      if (!document.querySelector('[role="menu"][aria-label="New"]')) await act(async () => (header.querySelector('button[aria-label="New"]') as HTMLButtonElement).click());
      return [...document.querySelectorAll<HTMLElement>('[role="menu"][aria-label="New"] [role="menuitem"]')].find(entry => entry.textContent === 'New Window')!;
    };
    const toast = () => [...document.querySelectorAll('.lab-toast')].find(node => node.textContent?.includes('Window not created'));
    const first = await item();
    await act(async () => first.click());
    expect(create).toHaveBeenCalledTimes(1);
    const repeat = await item();
    expect(repeat.getAttribute('aria-disabled')).toBe('true');
    await act(async () => repeat.click());
    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => pending[0]!.reject(new Error('Relay offline')));
    await until(() => expect(toast()?.textContent).toContain('Relay offline'));
    const again = await item();
    expect(again.getAttribute('aria-disabled')).toBeNull();
    await act(async () => again.click());
    expect(create).toHaveBeenCalledTimes(2);
    await act(async () => pending[1]!.resolve());
    await until(() => expect(toast()).toBeUndefined());
  } finally { await app.close(); }
});

it('moves focus out of the Window sidebar, and closes its open New menu, when Command-Backslash hides it', async () => {
  const scope = 'http://localhost/window-shell-focus/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/');
  const app = await mountBotApp(scope);
  const backslash = () => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', ctrlKey: !/Mac/.test(navigator.platform), metaKey: /Mac/.test(navigator.platform), bubbles: true, cancelable: true })); });
  try {
    await until(() => expect(app.container.querySelector<HTMLElement>('#lab-context')?.hidden).toBe(false));
    const context = app.container.querySelector<HTMLElement>('#lab-context')!;
    context.querySelector<HTMLButtonElement>('.lab-sidebar-header button[aria-label="New"]')!.focus();
    await backslash();
    expect(context.hidden).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
    expect(context.contains(document.activeElement)).toBe(false);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('View options');

    await backslash();
    expect(context.hidden).toBe(false);
    const newButton = context.querySelector<HTMLButtonElement>('.lab-sidebar-header button[aria-label="New"]')!;
    await act(async () => newButton.click());
    expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull();
    await backslash();
    expect(context.hidden).toBe(true);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(newButton.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('View options');
  } finally { await app.close(); }
});

it('shows Windows, In this Window and Shortcuts in the desktop sidebar, and sessions on their own page', async () => {
  const scope = 'http://localhost/window-sidebar/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    const rail = () => app.container.querySelector('#lab-context')!;
    await until(() => expect(rail().querySelector('nav[aria-label="Windows"]')).not.toBeNull());
    expect(rail().querySelector('nav[aria-label="Session views"]')).not.toBeNull();
    expect(rail().querySelector('nav[aria-label="Shortcuts"]')).not.toBeNull();
    expect(rail().querySelector('section[aria-label="Discover sessions"]')).toBeNull();
    expect(rail().querySelector('footer.lab-sidebar-footer')).not.toBeNull();
    // The footer counts the Lab server, which has local providers here, as the Hosts select does.
    await until(() => expect(rail().querySelector('.lab-sidebar-hosts')?.textContent).toBe('1 Host online'));
    await act(async () => app.button('All sessions').click());
    const page = app.container.querySelector<HTMLElement>('#lab-sessions-page')!;
    expect(page.hidden).toBe(false);
    expect(page.getAttribute('aria-label')).toBe('All sessions');
    expect(app.container.querySelector<HTMLElement>('#lab-workbench')!.hidden).toBe(true);
    await until(() => expect(page.querySelector('section[aria-label="Discover sessions"]')).not.toBeNull());
    await act(async () => app.button('Back to Window').click());
    expect(page.hidden).toBe(true);
    expect(app.container.querySelector<HTMLElement>('#lab-workbench')!.hidden).toBe(false);
    // Escape on the page returns to the Window too, unless something inside the page handled it.
    await act(async () => app.button('All sessions').click());
    expect(page.hidden).toBe(false);
    const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    handled.preventDefault();
    await act(async () => { page.dispatchEvent(handled); });
    expect(page.hidden).toBe(false);
    await act(async () => { page.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(page.hidden).toBe(true);
  } finally { await app.close(); }
});

it('moves the floating entries into the sidebar while it is visible', async () => {
  const scope = 'http://localhost/window-shortcuts/'; seedGroup(scope, botGroup('A'));
  // Team shows by default; TPM (coarse pointers only) and Ask are turned on here so every entry the fixture can show is covered.
  localStorage.setItem('agent-remote:tpm-view', 'true'); localStorage.setItem('agent-remote:ask-view', 'true');
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(app.container.querySelector('#lab-context nav[aria-label="Shortcuts"]')).not.toBeNull());
    const shortcuts = () => app.container.querySelector('#lab-context nav[aria-label="Shortcuts"]')!;
    const triggers = ['Teams', 'TPM works', 'Ask about this session'];
    await until(() => { for (const label of triggers) expect(shortcuts().querySelector(`button[aria-label="${label}"]`), label).not.toBeNull(); });
    // The Window capsule gives way to the sidebar's Windows section.
    expect(app.container.querySelector('.lab-window-floating:not([data-hidden])')).toBeNull();
    const apple = /Mac|iPhone|iPad/.test(navigator.platform);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', metaKey: apple, ctrlKey: !apple, bubbles: true, cancelable: true })); });
    expect(app.container.querySelector('.lab-window-floating:not([data-hidden])')).not.toBeNull();
    for (const label of triggers) {
      const trigger = app.container.querySelector(`button[aria-label="${label}"]`);
      expect(trigger, label).not.toBeNull();
      expect(trigger!.closest('#lab-context'), label).toBeNull();
    }
  } finally { await app.close(); }
});

it('keeps the Team entry mounted, with its panel open, when the sidebar is hidden and shown', async () => {
  const scope = 'http://localhost/window-shortcuts-mounted/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  const apple = /Mac|iPhone|iPad/.test(navigator.platform);
  const backslash = () => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', metaKey: apple, ctrlKey: !apple, bubbles: true, cancelable: true })); });
  try {
    const context = () => app.container.querySelector<HTMLElement>('#lab-context')!;
    await until(() => expect(context().querySelector('nav[aria-label="Shortcuts"] button[aria-label="Teams"]')).not.toBeNull());
    const trigger = context().querySelector<HTMLButtonElement>('button[aria-label="Teams"]')!;
    trigger.focus();
    await act(async () => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    await backslash();
    expect(context().hidden).toBe(true);
    // The same element floats now: a remount would drop the open panel (and a pending Team creation with it).
    expect(app.container.querySelector('button[aria-label="Teams"]')).toBe(trigger);
    expect(trigger.closest('#lab-context')).toBeNull();
    expect(trigger.closest('.lab-team-floating')).not.toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    // The moved control keeps the focus it had.
    expect(document.activeElement).toBe(trigger);
    await backslash();
    expect(context().hidden).toBe(false);
    expect(context().querySelector('button[aria-label="Teams"]')).toBe(trigger);
    expect(trigger.closest('.lab-sidebar-shortcut-team')).not.toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  } finally { await app.close(); }
});

it('opens New session from the New menu as a page with the provider controls', async () => {
  const scope = 'http://localhost/window-new-session-page/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(app.container.querySelector('#lab-context .lab-sidebar-header')).not.toBeNull());
    const header = app.container.querySelector('#lab-context .lab-sidebar-header')!;
    await act(async () => (header.querySelector('button[aria-label="New"]') as HTMLButtonElement).click());
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menu"][aria-label="New"] [role="menuitem"]')].find(entry => entry.textContent === 'New session')!.click());
    const page = app.container.querySelector<HTMLElement>('#lab-sessions-page[aria-label="New session"]');
    expect(page?.hidden).toBe(false);
    expect(page!.querySelector('.lab-provider-controls')?.closest('[hidden]')).toBeNull();
    expect(app.container.querySelector('#lab-context .lab-provider-controls')).toBeNull();
  } finally { await app.close(); }
});

it('keeps the desktop sidebar when a session opens from the sessions page, and closes the page', async () => {
  const scope = 'http://localhost/window-page-open/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    const context = () => app.container.querySelector<HTMLElement>('#lab-context')!;
    await until(() => expect(context().querySelector('nav[aria-label="Shortcuts"]')).not.toBeNull());
    expect(context().hidden).toBe(false);
    await act(async () => app.button('All sessions').click());
    const page = app.container.querySelector<HTMLElement>('#lab-sessions-page')!;
    await until(() => expect(page.querySelector('[aria-label="Discover sessions"] .lab-session-row')).not.toBeNull());
    await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="Discover sessions"] .lab-session-row')!.click());
    await until(() => expect(page.hidden).toBe(true));
    expect(app.workspace().readGroup('A')?.window.views.map(view => view.binding?.nativeSessionId)).toContain('Other');
    await until(() => expect(app.attachments).toContain('Other'));
    const group = app.workspace().readGroup('A')!;
    expect(group.window.views.find(view => view.id === 'A1')?.binding).toEqual(botTarget('A1'));
    expect(group.window.views.find(view => view.id === 'A2')?.binding).toEqual(botTarget('A2'));
    const added = group.window.views.find(view => view.binding?.nativeSessionId === 'Other');
    expect(added?.placement).toBe('primary');
    expect(group.window.selectedViewId).toBe(added?.id);
    expect(app.container.textContent).not.toContain('A bot keeps its conversation');
    expect(context().hidden).toBe(false);
    expect(app.container.querySelector('.lab-shell')!.classList.contains('lab-context-hidden')).toBe(false);
  } finally { await app.close(); }
});

it('does not count the hidden Window as seen while the sessions page is open', async () => {
  // Acknowledgement is driven by the visible sessions passed to useSessionTracking; the test reads that input.
  const useTracking = trackingHooks.useSessionTracking;
  let visible: readonly unknown[] = [];
  vi.spyOn(trackingHooks, 'useSessionTracking').mockImplementation((...args) => { visible = args[7] ?? []; return useTracking(...args); });
  const scope = 'http://localhost/window-page-seen/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(visible.length).toBeGreaterThan(0));
    await act(async () => app.button('All sessions').click());
    expect(visible).toEqual([]);
    await act(async () => app.button('Back to Window').click());
    await until(() => expect(visible.length).toBeGreaterThan(0));
  } finally { await app.close(); }
});

it('returns focus to the Window when the sessions page closes, and leaves Escape to fields', async () => {
  const scope = 'http://localhost/window-page-focus/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(app.container.querySelector('#lab-context nav[aria-label="Shortcuts"]')).not.toBeNull());
    const page = app.container.querySelector<HTMLElement>('#lab-sessions-page')!;
    const workbench = app.container.querySelector<HTMLElement>('#lab-workbench')!;
    await act(async () => app.button('All sessions').click());
    const back = app.button('Back to Window');
    back.focus();
    await act(async () => back.click());
    expect(page.hidden).toBe(true);
    expect(document.activeElement).toBe(workbench);

    await act(async () => app.button('All sessions').click());
    await until(() => expect(page.querySelector('.lab-session-search input')).not.toBeNull());
    const search = page.querySelector<HTMLInputElement>('.lab-session-search input')!;
    search.focus();
    await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(page.hidden).toBe(false);
    const backAgain = app.button('Back to Window');
    backAgain.focus();
    await act(async () => { backAgain.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(page.hidden).toBe(true);
    expect(document.activeElement).toBe(workbench);

    // Only text fields keep Escape: a checkbox on the page leaves it.
    await act(async () => app.button('All sessions').click());
    const checkbox = Object.assign(document.createElement('input'), { type: 'checkbox' });
    page.querySelector('.lab-sessions-page-body')!.append(checkbox);
    try {
      checkbox.focus();
      await act(async () => { checkbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
      expect(page.hidden).toBe(true);
    } finally { checkbox.remove(); }
  } finally { await app.close(); }
});

it('focuses the sessions page heading when the page opens from inside the Window', async () => {
  const scope = 'http://localhost/window-page-choose/';
  const group = botGroup('A');
  group.window.views.push(createWindowView('A3', undefined, 'primary'));
  group.window.selectedPrimaryViewId = 'A3'; group.window.selectedViewId = 'A3';
  seedGroup(scope, group);
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(app.button('Choose session')).toBeDefined());
    const choose = app.button('Choose session');
    choose.focus();
    await act(async () => choose.click());
    const page = app.container.querySelector<HTMLElement>('#lab-sessions-page')!;
    expect(page.hidden).toBe(false);
    expect(page.getAttribute('aria-label')).toBe('All sessions');
    expect(document.activeElement).toBe(page.querySelector('.lab-sessions-page-toolbar h2'));

    // Opened from the sidebar, focus stays on the sidebar's entry.
    await act(async () => app.button('Back to Window').click());
    const favorites = app.button('All sessions');
    favorites.focus();
    await act(async () => favorites.click());
    expect(page.hidden).toBe(false);
    expect(document.activeElement).toBe(favorites);
  } finally { await app.close(); }
});

it('keeps View options on the sessions page while the sidebar is hidden', async () => {
  const scope = 'http://localhost/window-page-view-options/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  const apple = /Mac|iPhone|iPad/.test(navigator.platform);
  try {
    await until(() => expect(app.container.querySelector('#lab-context nav[aria-label="Shortcuts"]')).not.toBeNull());
    await act(async () => app.button('All sessions').click());
    const page = app.container.querySelector<HTMLElement>('#lab-sessions-page')!;
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', metaKey: apple, ctrlKey: !apple, bubbles: true, cancelable: true })); });
    expect(app.container.querySelector<HTMLElement>('#lab-context')!.hidden).toBe(true);
    expect(page.hidden).toBe(false);
    const trigger = page.querySelector<HTMLButtonElement>('.lab-sessions-page-toolbar .lab-global-view-slot button[aria-label="View options"]');
    expect(trigger).not.toBeNull();
    expect(app.button('View options')).toBe(trigger);
  } finally { await app.close(); }
});

it('keeps the Window\'s conversations attached while the sessions page covers them', async () => {
  // The page hides #lab-workbench; the families stay active, since an inactive one parks its conversation and detaches.
  const scope = 'http://localhost/window-page-covered/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    const families = () => [...app.container.querySelectorAll<HTMLElement>('#lab-workbench .lab-session-family')];
    await until(() => expect(families().length).toBe(2));
    await until(() => expect(families().every(family => family.querySelector('[data-testid="prompt-input"]'))).toBe(true));
    await act(async () => app.button('All sessions').click());
    expect(app.container.querySelector<HTMLElement>('#lab-workbench')!.hidden).toBe(true);
    expect(families().every(family => !family.hidden && family.querySelector('[data-testid="prompt-input"]'))).toBe(true);
    await act(async () => app.button('Back to Window').click());
    expect(families().every(family => !family.hidden && family.querySelector('[data-testid="prompt-input"]'))).toBe(true);
  } finally { await app.close(); }
});

it('names the Favorites page once, in its toolbar', async () => {
  const scope = 'http://localhost/window-page-favorites/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope, { hosted: true });
  try {
    await until(() => expect(app.container.querySelector('#lab-context nav[aria-label="Shortcuts"]')).not.toBeNull());
    await until(() => expect(app.button('Favorites')).toBeDefined());
    await act(async () => app.button('Favorites').click());
    const page = app.container.querySelector<HTMLElement>('#lab-sessions-page')!;
    expect(page.getAttribute('aria-label')).toBe('Favorites');
    expect([...page.querySelectorAll('h1, h2, h3')].filter(heading => heading.textContent === 'Favorites').map(heading => heading.className)).toEqual(['ui-toolbar-title']);
  } finally { await app.close(); }
});

it('closes the sessions page when the Trace view is chosen', async () => {
  const scope = 'http://localhost/window-page-trace/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(app.container.querySelector('#lab-context nav[aria-label="Shortcuts"]')).not.toBeNull());
    await act(async () => app.button('All sessions').click());
    const page = app.container.querySelector<HTMLElement>('#lab-sessions-page')!;
    expect(page.hidden).toBe(false);
    await act(async () => app.container.querySelector<HTMLButtonElement>('#lab-trace-tab')!.click());
    expect(page.hidden).toBe(true);
    expect(app.container.querySelector<HTMLElement>('#lab-trace')!.hidden).toBe(false);
  } finally { await app.close(); }
});

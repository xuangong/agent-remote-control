import { act } from 'react';
import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import { createWindowView } from '@orchardworks/agent-remote-protocol';
import { botGroup, botTarget, mountBotApp, seedGroup, until, visibleButton } from './test/bot-mode-fixtures.js';
import * as workspaceHooks from './features/windows/useWindowWorkspace.js';
import * as trackingHooks from './features/sessions/useSessionTracking.js';
import { promptText, setPromptText } from './test/setup.js';
import { nextPopstate } from './test/wait.js';
import { loadScreens } from './app/lazy-screens.js';

// Settings, the Trace and the Inspector are chunks the page warms when idle; a test opens them as a settled page would.
beforeAll(() => loadScreens());

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

it('keeps Window A/A2 and both display settings while Bot B1 shares its exact view draft', async () => {
  const scope = 'http://localhost/bot-place/';
  const a = botGroup('A'), b = botGroup('B', false);
  seedGroup(scope, a); seedGroup(scope, b); history.replaceState(null, '', '/?window=B');
  const app = await mountBotApp(scope);
  await until(() => expect(app.workspace().window?.id).toBe('B'));
  // Bot mode shows every group, so Window B's bots are there without a step to show them.
  await act(async () => app.workspace().open('A'));
  const before = structuredClone(app.workspace().window);
  const bDisplay = structuredClone(app.workspace().readGroup('B')!.window.views.map(view => view.display));
  await app.switchMode('bot');
  await act(async () => app.row('B', 'B1').click());
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
  expect(app.container.querySelector('[aria-label="Chats"] [aria-current="true"]')?.getAttribute('data-bot-place')).toBe(JSON.stringify(['B', 'B1']));
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
  await until(() => expect(app.container.querySelector('[aria-label="Chats"] [aria-current="true"]')?.getAttribute('aria-label')).toBe('A1'));
  expect(app.container.querySelector('.lab-rail [aria-current="page"]')?.getAttribute('aria-label')).toBe('Chats');
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

it('opens section-only routes in the directory at that group, without restoring stale session query parameters', async () => {
  const scope = 'http://localhost/bot-section/'; const group = botGroup('B'); group.presentation = { window: false };
  seedGroup(scope, group); history.replaceState(null, '', '/?mode=bot&section=B&session=stale&provider=recorded&host=local');
  const app = await mountBotApp(scope);
  await until(() => expect(app.container.querySelector('.lab-directory #directory-group-B')).not.toBeNull());
  expect(app.container.querySelector('.lab-rail [aria-current="page"]')?.getAttribute('aria-label')).toBe('Assistants');
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

it.each([['a stored picture', true], ['no bot details', false]] as const)("draws a bot with %s at the foot of its answers as the roster does, in Window and Bot mode alike", async (_name, details) => {
  const scope = `http://localhost/bot-picture-${details}/`, group = botGroup('B', details);
  if (details) group.bots!.members.B1 = { picture: { shape: 'triangle', color: '#2f6fed' } };
  seedGroup(scope, group); history.replaceState(null, '', '/?window=B');
  const app = await mountBotApp(scope, { hosted: true, timeline: [{ providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: 'now', turnId: 'B1-turn',
    resources: [], collapsed: [], sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], item: { type: 'assistant_message', text: 'Readable Bot content' } }] });
  const face = (avatar: HTMLElement | null | undefined) => avatar ? [avatar.dataset.shape, avatar.querySelector('.orchard-avatar-body')?.getAttribute('style')].join(' ') : undefined;
  const foot = (root: ParentNode | null) => face(root?.querySelector<HTMLElement>('.orchard-bubble-row[data-from="theirs"] .orchard-avatar'));
  try {
    await until(() => expect(foot(app.container.querySelector('[data-view-id="B1"]'))).toBeDefined());
    const windowFace = foot(app.container.querySelector('[data-view-id="B1"]'));
    if (details) expect(windowFace).toMatch(/^triangle /);
    await app.switchMode('bot'); await act(async () => app.row('B', 'B1').click());
    await until(() => expect(foot(app.container.querySelector('.lab-bot-conversation'))).toBe(windowFace));
    expect(face(app.row('B', 'B1').querySelector<HTMLElement>('.orchard-avatar'))).toBe(windowFace);
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
      // A group keeps details only for its bots, so a view that stops being one loses its details too.
      if ((change === 'deleted' || change === 'history' || change === 'ask') && group.bots) delete group.bots.members.B1;
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

it('puts the title and the New menu at the top of the Window sidebar, and the modes and Search in the rail, not in the app bar', async () => {
  const scope = 'http://localhost/sidebar-header/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(app.container.querySelector('#lab-context .lab-sidebar-header')).not.toBeNull());
    await until(() => expect(app.workspace().window?.id).toBe('A'));
    const header = app.container.querySelector('#lab-context .lab-sidebar-header')!;
    expect(header.querySelector('.lab-sidebar-title')?.textContent).toBe('Windows');
    expect(app.container.querySelector('nav[aria-label="Workbench mode"]')).toBeNull();
    expect(app.container.querySelector('.lab-rail [aria-current="page"]')?.getAttribute('aria-label')).toBe('Windows');
    const newSessionPanel = () => app.container.querySelector('#lab-sessions-page .lab-provider-controls')!;
    expect(newSessionPanel().closest('[hidden]')).not.toBeNull();
    const open = async () => act(async () => (header.querySelector('button[aria-label="New"]') as HTMLButtonElement).click());
    const item = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menu"][aria-label="New"] [role="menuitem"]')].find(entry => entry.textContent === label)!;
    await open();
    expect([...document.querySelectorAll('[role="menu"][aria-label="New"] [role="menuitem"]')].map(entry => entry.textContent)).toEqual(['New session', 'New group']);
    await act(async () => item('New session').click());
    expect(newSessionPanel().closest('[hidden]')).toBeNull();
    expect(app.container.querySelector<HTMLElement>('#lab-sessions-page[aria-label="New session"]')?.hidden).toBe(false);
    await open();
    await act(async () => item('New group').click());
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
      return [...document.querySelectorAll<HTMLElement>('[role="menu"][aria-label="New"] [role="menuitem"]')].find(entry => entry.textContent === 'New group')!;
    };
    const toast = () => [...document.querySelectorAll('.lab-toast')].find(node => node.textContent?.includes('Group not created'));
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

it('shows Windows, In this group and Shortcuts in the desktop sidebar, and sessions on their own page', async () => {
  const scope = 'http://localhost/window-sidebar/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    const rail = () => app.container.querySelector('#lab-context')!;
    await until(() => expect(rail().querySelector('nav[aria-label="Groups"]')).not.toBeNull());
    expect(rail().querySelector('nav[aria-label="Session views"]')).not.toBeNull();
    expect(rail().querySelector('nav[aria-label="Shortcuts"]')).not.toBeNull();
    expect(rail().querySelector('section[aria-label="Discover sessions"]')).toBeNull();
    // The Hosts summary and Settings have left the sidebar: Settings is in the rail and the summary in Settings > Computers.
    expect(rail().querySelector('footer')).toBeNull();
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

it('moves the entries into the sidebar while it is visible, and into the Window toolbar while it is hidden', async () => {
  const scope = 'http://localhost/window-shortcuts/'; seedGroup(scope, botGroup('A'));
  // Ask is turned on here so every entry the fixture can show is covered.
  localStorage.setItem('agent-remote:ask-view', 'true');
  history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(app.container.querySelector('#lab-context nav[aria-label="Shortcuts"]')).not.toBeNull());
    const shortcuts = () => app.container.querySelector('#lab-context nav[aria-label="Shortcuts"]')!;
    const triggers = ['Ask about this session'];
    await until(() => { for (const label of triggers) expect(shortcuts().querySelector(`button[aria-label="${label}"]`), label).not.toBeNull(); });
    // The Window capsule gives way to the sidebar's Windows section.
    expect(app.container.querySelector('.lab-window-floating:not([data-hidden])')).toBeNull();
    const apple = /Mac|iPhone|iPad/.test(navigator.platform);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', metaKey: apple, ctrlKey: !apple, bubbles: true, cancelable: true })); });
    // A row of the Window's toolbar holds them: tiles that fill the width leave no margin to float in.
    const toolbar = () => app.container.querySelector('.lab-window-toolbar .lab-toolbar-launchers')!;
    expect(toolbar().querySelector('.lab-launcher-window:not([data-hidden])')).not.toBeNull();
    expect(app.container.querySelector('.lab-tracking-floating')).toBeNull();
    for (const label of triggers) {
      const trigger = app.container.querySelector(`button[aria-label="${label}"]`);
      expect(trigger, label).not.toBeNull();
      expect(trigger!.closest('#lab-context'), label).toBeNull();
      expect(trigger!.closest('.lab-toolbar-launchers'), label).toBe(toolbar());
    }
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

it('keeps the desktop sidebar when a session opens from the sessions page beside the bots, and closes the page', async () => {
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

// Moving between the modes keeps your place (I3 plan, B5).
it('opens a tile in Bot mode, keeping the Window route, and pins it back with its tile presented, keeping the bot place and its draft', async () => {
  const scope = 'http://localhost/bot-mode-moves/'; seedGroup(scope, botGroup('A')); seedGroup(scope, botGroup('B', false));
  history.replaceState(null, '', '/?window=B');
  const app = await mountBotApp(scope, { hosted: true });
  try {
    await until(() => expect(app.workspace().window?.id).toBe('B'));
    await until(() => expect(app.container.querySelector('.lab-window-mode .lab-open-in-bot')).not.toBeNull());
    // B has no Bot section: opening its tile in Bot mode gives it one and selects that assistant.
    const tile = [...app.container.querySelectorAll<HTMLButtonElement>('.lab-window-mode .lab-open-in-bot')][0]!;
    const viewId = tile.closest<HTMLElement>('[data-view-id]')?.dataset.viewId ?? 'B2';
    await act(async () => tile.click());
    await until(() => expect(app.workspace().readGroup('B')?.bots).toBeDefined());
    await until(() => expect(app.container.querySelector('[data-workbench-mode="bot"]')?.hasAttribute('hidden')).toBe(false));
    await until(() => expect(app.container.querySelector('[aria-label="Chats"] [aria-current="true"]')?.getAttribute('data-bot-place')).toBe(JSON.stringify(['B', viewId])));
    expect(new URL(location.href).searchParams.get('section')).toBe('B');
    // A draft typed in Bot mode goes with the assistant.
    await until(() => expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).not.toBeNull());
    const editor = app.container.querySelector<HTMLElement>('.lab-bot-conversation [role="textbox"]')!;
    await act(async () => { setPromptText(editor, 'Kept across modes'); editor.dispatchEvent(new Event('input', { bubbles: true })); });
    // Switching back returns to the Window it came from.
    await app.switchMode('window');
    await until(() => expect(new URL(location.href).searchParams.get('window')).toBe('B'));
    await app.switchMode('bot');
    // Pin to a window shows its group with its tile presented, and the Bot place stays for the way back.
    const pin = [...app.container.querySelectorAll<HTMLButtonElement>('.lab-assistant-details .lab-assistant-card-actions button')].find(button => button.textContent === 'Pin to a window')!;
    expect(pin).toBeDefined();
    await act(async () => pin.click());
    await until(() => expect(app.container.querySelector('[data-workbench-mode="window"]')?.hasAttribute('hidden')).toBe(false));
    await until(() => expect(app.workspace().window?.id).toBe('B'));
    await until(() => expect(app.workspace().readGroup('B')?.window.selectedViewId).toBe(viewId));
    await until(() => expect([...app.container.querySelectorAll<HTMLElement>('.lab-window-mode [role="textbox"]')].some(input => promptText(input) === 'Kept across modes')).toBe(true));
    await app.switchMode('bot');
    expect(app.container.querySelector('[aria-label="Chats"] [aria-current="true"]')?.getAttribute('data-bot-place')).toBe(JSON.stringify(['B', viewId]));
  } finally { await app.close(); }
});

it('pins a bot whose group is hidden from Window mode by showing its group there first', async () => {
  const scope = 'http://localhost/bot-mode-pin-hidden/'; const group = botGroup('A'); group.presentation = { window: false };
  seedGroup(scope, group); history.replaceState(null, '', '/?mode=bot&section=A&bot=A1');
  const app = await mountBotApp(scope, { hosted: true });
  try {
    await until(() => expect([...app.container.querySelectorAll('.lab-assistant-details .lab-assistant-card-actions button')].some(button => button.textContent === 'Pin to a window')).toBe(true));
    await act(async () => [...app.container.querySelectorAll<HTMLButtonElement>('.lab-assistant-details .lab-assistant-card-actions button')].find(button => button.textContent === 'Pin to a window')!.click());
    await until(() => expect(app.workspace().readGroup('A')?.presentation).toBeUndefined());
    await until(() => expect(app.workspace().window?.id).toBe('A'));
    await until(() => expect(app.workspace().readGroup('A')?.window.selectedViewId).toBe('A1'));
  } finally { await app.close(); }
});


// Navigation (I4 plan, decisions 9 to 13): every address keeps its meaning, and Settings or the directory sit over a mode that keeps its place.
const rail = (app: Awaited<ReturnType<typeof mountBotApp>>) => app.container.querySelector('.lab-rail [aria-current="page"]')?.getAttribute('aria-label');
it.each([
  ['a Window link', '/?mode=window&window=A', 'Windows'],
  ['an assistant link', '/?mode=bot&section=A&bot=A1', 'Chats'],
  ['a session link', '/?mode=bot&host=local&provider=recorded&session=A1', 'Chats'],
  ['a bare window link', '/?window=A', 'Windows'],
] as const)('opens %s in the same place as before', async (_name, url, destination) => {
  const scope = `http://localhost/links-${destination}-${url.length}/`; seedGroup(scope, botGroup('A')); history.replaceState(null, '', url);
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(rail(app)).toBe(destination));
    if (destination === 'Chats') await until(() => expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).not.toBeNull());
    else await until(() => expect(app.workspace().window?.id).toBe('A'));
    expect(new URL(location.href).searchParams.get('page')).toBeNull();
  } finally { await app.close(); }
});

it('keeps the chat and its draft over Settings and the directory, and returns to the same chat', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  const scope = 'http://localhost/bot-over-settings/'; seedGroup(scope, botGroup('A')); history.replaceState(null, '', '/?mode=bot&section=A&bot=A1');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).not.toBeNull());
    const editor = app.container.querySelector<HTMLElement>('.lab-bot-conversation [role="textbox"]')!;
    await act(async () => { setPromptText(editor, 'half-written'); editor.dispatchEvent(new Event('input', { bubbles: true })); });
    await app.go('Settings');
    expect(rail(app)).toBe('Settings');
    expect(new URL(location.href).searchParams.get('page')).toBe('settings');
    expect(app.container.querySelector<HTMLElement>('[data-workbench-mode="bot"]')!.hidden).toBe(true);
    expect(app.container.querySelector('.lab-settings h1')?.textContent).toBe('General');
    await app.go('Assistants');
    expect(rail(app)).toBe('Assistants');
    expect(app.container.querySelector('.lab-directory')).not.toBeNull();
    await act(async () => app.button('A2').click());
    expect(rail(app)).toBe('Chats');
    expect(new URL(location.href).searchParams.get('bot')).toBe('A2');
    await app.go('Settings');
    await app.go('Chats');
    expect(new URL(location.href).searchParams.get('page')).toBeNull();
    expect(app.container.querySelector<HTMLElement>('[data-workbench-mode="bot"]')!.hidden).toBe(false);
    await act(async () => app.button('A1').click());
    await until(() => expect(promptText(app.container.querySelector<HTMLElement>('.lab-bot-conversation [role="textbox"]')!)).toBe('half-written'));
  } finally { await app.close(); }
});

it('on a phone, leaves a pushed conversation by the back gesture, then Settings, and keeps the tab bar off the conversation', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 1180px)' || query === '(max-width: 760px)', media: query, addEventListener() {}, removeEventListener() {} }));
  const scope = 'http://localhost/bot-phone-nav/'; seedGroup(scope, botGroup('A')); history.replaceState(null, '', '/?mode=bot');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(app.container.querySelector('.lab-tab-bar')).not.toBeNull());
    expect(app.container.querySelector('.lab-rail')).toBeNull();
    await act(async () => app.button('A1').click());
    expect(app.container.querySelector('.lab-bot-workspace')!.hasAttribute('data-chat')).toBe(true);
    await act(async () => { const popped = nextPopstate(); history.back(); await popped; });
    expect(app.container.querySelector('.lab-bot-workspace')!.hasAttribute('data-chat')).toBe(false);
    await app.go('Settings');
    expect(app.container.querySelector('.lab-settings-me')).not.toBeNull();
    await act(async () => [...app.container.querySelectorAll<HTMLButtonElement>('.lab-settings-group')].find(item => item.querySelector('strong')?.textContent === 'General')!.click());
    expect(app.container.querySelector('.lab-settings h1')?.textContent).toBe('General');
    await act(async () => { const popped = nextPopstate(); history.back(); await popped; });
    expect(app.container.querySelector('.lab-settings-me')).not.toBeNull();
    await act(async () => { const popped = nextPopstate(); history.back(); await popped; });
    expect(app.container.querySelector('.lab-page')!.hasAttribute('hidden')).toBe(true);
  } finally { await app.close(); }
});

it("changes a bot's model from its details", async () => {
  const scope = 'http://localhost/bot-details-settings/'; seedGroup(scope, botGroup('B')); history.replaceState(null, '', '/?mode=bot&section=B&bot=B1');
  const choices = (values: string[]) => values.map(value => ({ value, label: value }));
  const app = await mountBotApp(scope, { hosted: true, settings: [
    { id: 'model', category: 'model', label: 'Model', value: 'default', mutable: true, scope: 'session', options: choices(['default', 'sonnet']) },
    { id: 'permissions', category: 'permissions', label: 'Permissions', value: 'default', mutable: true, scope: 'session', options: choices(['default', 'plan']) }] });
  try {
    await until(() => expect(app.container.querySelector('[data-testid="session-model-button"]')).not.toBeNull());
    await act(async () => app.container.querySelector<HTMLButtonElement>('[data-testid="session-model-button"]')!.click());
    const model = () => app.container.querySelector<HTMLSelectElement>('[data-testid="session-setting-model"]')!;
    await until(() => expect(model().disabled).toBe(false));
    await act(async () => { model().value = 'sonnet'; model().dispatchEvent(new Event('change', { bubbles: true })); });
    await until(() => expect(app.settingChanges).toEqual([{ agentId: 'agent-B1', settingId: 'model', value: 'sonnet' }]));
  } finally { await app.close(); }
});

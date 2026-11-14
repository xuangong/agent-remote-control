import { act } from 'react';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WindowWorkspaceClient } from '@orchardworks/agent-remote-web';
import { createWindowView, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { botGroup, botTarget, mountBotApp, seedGroup, until, visibleButton } from '../test/bot-mode-fixtures.js';
import { SessionDirectoryClient } from '../directory-client.js';
import { promptText, setPromptText } from '../test/setup.js';

const dialogMethods = ['showModal', 'close'] as const;
const originalDialog = Object.fromEntries(dialogMethods.map(name => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)]));
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });
afterAll(() => {
  for (const name of dialogMethods) {
    const original = originalDialog[name];
    if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original);
    else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>)[name];
  }
});

it.each(['deleted', 'hidden', 'ineligible'] as const)('shows the compact roster and unavailable notice immediately after the selected Bot becomes %s', async change => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 1180px)', addEventListener() {}, removeEventListener() {} }));
  const scope = `http://localhost/bot-compact-${change}/`; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?mode=bot&section=A&bot=A1');
  const app = await mountBotApp(scope, { hosted: true });
  try {
    await until(() => expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).not.toBeNull());
    const beforeUrl = location.href, editor = app.container.querySelector('.lab-bot-conversation [role="textbox"]')!;
    const group = structuredClone(app.hostedGroups.get('A')!); group.window.revision++;
    if (change === 'deleted') group.window.views = group.window.views.filter(view => view.id !== 'A1');
    else if (change === 'hidden') group.bots!.members.A1 = { hidden: true };
    // A Side or a managed view stays a bot; a history view is no bot.
    else group.window.views[0]!.binding = { ...group.window.views[0]!.binding!, sessionIntent: 'history' };
    app.hostedGroups.set('A', group); await act(async () => app.workspace().refreshGroups());
    await until(() => expect(editor.isConnected).toBe(false));
    expect(app.container.querySelector<HTMLElement>('.lab-bot-roster')!.hidden).toBe(false);
    expect(app.container.querySelector('.lab-bot-roster [role="alert"]')?.textContent).toContain('unavailable');
    expect(app.button('New bot')).toBeDefined(); expect(app.button('Retry')).toBeDefined();
    expect(location.href).toBe(beforeUrl); expect(app.sendMessages).toEqual([]);
  } finally { await app.close(); }
});

it('keeps the compact retained editor when access pauses a valid Bot', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 1180px)', addEventListener() {}, removeEventListener() {} }));
  const scope = 'http://localhost/bot-compact-access/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?mode=bot&section=A&bot=A1');
  const app = await mountBotApp(scope, { hosted: true });
  try {
    await until(() => expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).not.toBeNull());
    const editor = app.container.querySelector<HTMLElement>('.lab-bot-conversation [role="textbox"]')!;
    await act(async () => app.setAccessReady(false));
    expect(editor.isConnected).toBe(true); expect(editor.closest('[hidden]')).toBeNull();
    expect(app.container.querySelector<HTMLElement>('.lab-bot-roster')!.hidden).toBe(true);
    await act(async () => app.setAccessReady(true));
    expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).toBe(editor);
  } finally { await app.close(); }
});

it('compact Back restores the roster row and preserves the same editor without focusing it', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 1180px)', addEventListener() {}, removeEventListener() {} }));
  const scope = 'http://localhost/bot-compact/'; seedGroup(scope, botGroup('A')); history.replaceState(null, '', '/?mode=bot&section=A');
  const app = await mountBotApp(scope);
  await act(async () => app.button('A1').click());
  await until(() => expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).not.toBeNull());
  const input = app.container.querySelector<HTMLElement>('.lab-bot-conversation [role="textbox"]')!;
  expect(document.activeElement).not.toBe(input);
  await act(async () => { setPromptText(input, 'retained'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => app.button('Back to bots').click());
  expect(document.activeElement).toBe(app.button('A1'));
  await act(async () => app.button('A1').click());
  expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).toBe(input);
  expect(promptText(input)).toBe('retained');
  await app.close();
});

it('goes back to the bot list from a chat on a phone with ‹ Bots, at the place it left', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 1180px)', addEventListener() {}, removeEventListener() {} }));
  const scope = 'http://localhost/bot-phone-back/'; seedGroup(scope, botGroup('A')); history.replaceState(null, '', '/?mode=bot&section=A');
  const app = await mountBotApp(scope);
  try {
    const roster = () => app.container.querySelector<HTMLElement>('.lab-bot-roster')!;
    roster().scrollTop = 120;
    await act(async () => app.button('A1').click());
    await until(() => expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).not.toBeNull());
    const back = app.button('Back to bots');
    // Like a phone's navigation bar: a chevron and the list's name, never a bare Back.
    expect(back.textContent).toBe('Bots');
    expect(back.querySelector('svg')).not.toBeNull();
    expect(app.container.querySelector('.lab-bot-workspace')!.getAttribute('data-navigation')).toBe('push');
    // A browser drops the scroll position of a list it stops displaying.
    roster().scrollTop = 0;
    await act(async () => back.click());
    expect(roster().hidden).toBe(false);
    expect(roster().scrollTop).toBe(120);
    expect(app.container.querySelector('.lab-bot-workspace')!.getAttribute('data-navigation')).toBe('pop');
  } finally { await app.close(); }
});

it('starts a new bot in its own group, named after its session, and opens its conversation', async () => {
  const scope = 'http://localhost/bot-new/'; seedGroup(scope, botGroup('A')); history.replaceState(null, '', '/?mode=bot');
  const create = vi.spyOn(SessionDirectoryClient.prototype, 'create').mockResolvedValue({ agentId: 'agent-N1', nativeSessionId: 'N1' });
  const app = await mountBotApp(scope);
  try {
    expect(app.container.querySelector('input[aria-label="Section title"]')).toBeNull();
    await act(async () => app.button('New bot').click());
    const sheet = () => app.container.querySelector<HTMLDialogElement>('dialog.ui-sheet[open]');
    expect(sheet()?.querySelector('h2')?.textContent).toBe('New bot');
    expect(sheet()?.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')?.selectedOptions[0]?.textContent).toBe('Recorded Provider');
    await act(async () => visibleButton(sheet()!, 'Start').click());
    await until(() => expect(create).toHaveBeenCalledTimes(1));
    const made = () => app.workspace().groups.find(group => group.window.views.some(view => view.binding?.nativeSessionId === 'N1'));
    await until(() => expect(made()).toBeDefined());
    expect(made()!.window.title).toBe('New session'); expect(made()!.presentation).toBeUndefined(); expect(made()!.bots?.members).toEqual({});
    await until(() => expect(new URL(location.href).searchParams.get('bot')).toBe('main'));
    expect(new URL(location.href).searchParams.get('section')).toBe(made()!.window.id);
    await until(() => expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).not.toBeNull());
    expect(sheet()).toBeNull();
  } finally { await app.close(); }
});

it('names a new bot and the group it started once its session is named, and leaves a renamed group alone', async () => {
  const scope = 'http://localhost/bot-titles/';
  const started = (id: string, title: string): WindowGroup => ({ window: { schemaVersion: 3, id, revision: 0, title, selectedPrimaryViewId: 'main', selectedViewId: 'main',
    views: [createWindowView('main', { ...botTarget(`${id}-session`), title: 'New session' }, 'primary')] }, bots: { rank: id.toLowerCase(), members: {} } });
  seedGroup(scope, started('G', 'New session')); seedGroup(scope, started('R', 'Release'));
  history.replaceState(null, '', '/?mode=bot&section=G&bot=main');
  const app = await mountBotApp(scope, { hosted: true });
  try {
    await until(() => expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).not.toBeNull());
    await act(async () => app.emitTitle({ hostId: 'local', providerId: 'recorded', nativeSessionId: 'G-session', title: 'Fix the build', revision: 1 }));
    await until(() => expect(app.workspace().readGroup('G')?.window.title).toBe('Fix the build'));
    expect(app.workspace().readGroup('G')?.window.views[0]?.binding?.title).toBe('Fix the build');
    await until(() => expect(app.container.querySelector(`[data-bot-place='${JSON.stringify(['G', 'main'])}'] .lab-bot-name`)?.textContent).toBe('Fix the build'));
    await act(async () => app.container.querySelector<HTMLButtonElement>(`[data-bot-place='${JSON.stringify(['R', 'main'])}']`)!.click());
    await act(async () => app.emitTitle({ hostId: 'local', providerId: 'recorded', nativeSessionId: 'R-session', title: 'Ship notes', revision: 1 }));
    await until(() => expect(app.workspace().readGroup('R')?.window.views[0]?.binding?.title).toBe('Ship notes'));
    expect(app.workspace().readGroup('R')?.window.title).toBe('Release');
  } finally { await app.close(); }
});

it('keeps an unconfirmed new group and recovers that same creation on Retry', async () => {
  const scope = 'http://localhost/bot-new-uncertain/'; seedGroup(scope, botGroup('A')); history.replaceState(null, '', '/?mode=bot');
  vi.spyOn(SessionDirectoryClient.prototype, 'create').mockResolvedValue({ agentId: 'agent-N2', nativeSessionId: 'N2' });
  const app = await mountBotApp(scope, { hosted: true, serverProviders: true });
  let original!: WindowGroup, identity!: { operationId: string; issuedAt: number };
  const creation = vi.spyOn(WindowWorkspaceClient.prototype, 'createGroup').mockImplementation(async (group, operation) => {
    original = group; identity = operation!; throw new Error('Creation receipt unavailable.');
  });
  const recovery = vi.spyOn(WindowWorkspaceClient.prototype, 'recoverCreate').mockImplementation(async (window, operation) => {
    expect(window.id).toBe(original.window.id); expect(operation).toEqual(identity); app.hostedGroups.set(original.window.id, original); return original;
  });
  try {
    await act(async () => app.button('New bot').click());
    await act(async () => visibleButton(app.container.querySelector('dialog.ui-sheet[open]')!, 'Start').click());
    await until(() => expect(app.container.textContent).toContain('The new group is not confirmed.'));
    expect(original.window.views[0]?.binding?.nativeSessionId).toBe('N2');
    await act(async () => app.button('Retry').click());
    expect(creation).toHaveBeenCalledOnce(); expect(recovery).toHaveBeenCalledOnce();
    await until(() => expect(new URL(location.href).searchParams.get('section')).toBe(original.window.id));
    expect(new URL(location.href).searchParams.get('bot')).toBe('main');
  } finally { await app.close(); }
});

it('shows the shared sidebar header, a toolbar above the conversation, and collapses the roster', async () => {
  const scope = 'http://localhost/bot-shell-frame/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?mode=bot&section=A&bot=A1');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).not.toBeNull());
    const roster = app.container.querySelector<HTMLElement>('.lab-bot-roster')!;
    expect(roster.querySelector('.lab-sidebar-header nav[aria-label="Workbench mode"] [aria-pressed="true"]')?.textContent).toBe('Bot mode');
    expect(roster.querySelector('.lab-sidebar-header-actions button[aria-label="New bot"]')).not.toBeNull();
    expect(app.container.querySelector('header.ui-toolbar.lab-bot-conversation-toolbar h2.ui-toolbar-title')).not.toBeNull();
    await act(async () => app.button('Hide sidebar').click());
    expect(roster.hidden).toBe(true);
    expect(app.container.querySelector('.lab-bot-workspace')?.hasAttribute('data-roster-collapsed')).toBe(true);
    await act(async () => app.button('Show sidebar').click());
    expect(roster.hidden).toBe(false);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', ctrlKey: !/Mac/.test(navigator.platform), metaKey: /Mac/.test(navigator.platform), bubbles: true, cancelable: true })); });
    expect(roster.hidden).toBe(true);
  } finally { await app.close(); }
});

it('moves focus from a collapsing roster to the sidebar button', async () => {
  const scope = 'http://localhost/bot-shell-focus/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?mode=bot&section=A&bot=A1');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).not.toBeNull());
    const roster = app.container.querySelector<HTMLElement>('.lab-bot-roster')!;
    roster.querySelector<HTMLButtonElement>('button[aria-label="New bot"]')!.focus();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', ctrlKey: !/Mac/.test(navigator.platform), metaKey: /Mac/.test(navigator.platform), bubbles: true, cancelable: true })); });
    expect(roster.hidden).toBe(true);
    const toggle = document.activeElement as HTMLElement;
    expect(toggle.getAttribute('aria-label')).toBe('Show sidebar');
    expect(toggle.getAttribute('aria-controls')).toBe(roster.id);
    expect(roster.id).not.toBe('');
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', ctrlKey: !/Mac/.test(navigator.platform), metaKey: /Mac/.test(navigator.platform), bubbles: true, cancelable: true })); });
    expect(roster.hidden).toBe(false);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-label')).toBe('Hide sidebar');
  } finally { await app.close(); }
});

it('keeps the Bots heading outside the collapsible roster: hidden on desktop, a large title above the compact roster only', async () => {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  let compact = false;
  vi.stubGlobal('matchMedia', (query: string) => ({ get matches() { return compact && query === '(max-width: 1180px)'; }, media: query,
    addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => { listeners.add(listener); }, removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => { listeners.delete(listener); } }));
  const scope = 'http://localhost/bot-shell-title/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?mode=bot&section=A&bot=A1');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).not.toBeNull());
    const main = app.container.querySelector<HTMLElement>('.lab-bot-workspace')!;
    const title = () => main.firstElementChild as HTMLElement;
    expect(title().tagName).toBe('H1'); expect(title().textContent).toBe('Bots');
    expect(title().classList.contains('agent-visually-hidden')).toBe(true);
    expect(main.querySelector('.lab-bot-roster h1')).toBeNull();
    app.button('Hide sidebar').focus();
    await act(async () => app.button('Hide sidebar').click());
    expect(title().tagName).toBe('H1');
    await act(async () => app.button('Show sidebar').click());
    await act(async () => { compact = true; listeners.forEach(listener => listener({ matches: true } as MediaQueryListEvent)); });
    const conversation = main.querySelector<HTMLElement>('.lab-bot-conversation')!;
    expect(conversation.hidden).toBe(false);
    expect(document.activeElement).toBe(app.button('Back to bots'));
    expect(title().classList.contains('agent-visually-hidden')).toBe(true);
    await act(async () => app.button('Back to bots').click());
    expect(conversation.hidden).toBe(true);
    expect(title().classList.contains('agent-visually-hidden')).toBe(false);
  } finally { await app.close(); }
});

it('hides a group in Bot mode or Window mode from its roster header', async () => {
  const scope = 'http://localhost/bot-group-actions/'; seedGroup(scope, botGroup('A')); seedGroup(scope, botGroup('B', false)); history.replaceState(null, '', '/?mode=bot');
  const app = await mountBotApp(scope);
  try {
    const roster = () => app.container.querySelector<HTMLElement>('nav[aria-label="Bots"]')!;
    const choose = async (group: string, label: string) => {
      await act(async () => roster().querySelector<HTMLButtonElement>(`button[aria-label="Group actions: ${group}"]`)!.click());
      await act(async () => [...document.querySelectorAll<HTMLElement>(`[role="menu"][aria-label="Group actions: ${group}"] [role="menuitem"]`)].find(item => item.textContent === label)!.click());
    };
    await until(() => expect(roster().querySelector('button[aria-label="Group actions: B"]')).not.toBeNull());
    await choose('A', 'Hide in Window mode');
    await until(() => expect(app.workspace().readGroup('A')?.presentation).toEqual({ window: false }));
    await choose('A', 'Show in Window mode');
    await until(() => expect(app.workspace().readGroup('A')?.presentation).toBeUndefined());
    await choose('B', 'Hide in Bot mode');
    await until(() => expect(app.workspace().readGroup('B')?.presentation).toEqual({ bots: false }));
    await until(() => expect(roster().querySelector('button[aria-label="Group actions: B"]')).toBeNull());
    expect(roster().textContent).not.toContain('B1');
  } finally { await app.close(); }
});

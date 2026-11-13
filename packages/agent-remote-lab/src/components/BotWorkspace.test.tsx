import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { WindowWorkspaceClient } from '@orchardworks/agent-remote-web';
import type { WindowGroup } from '@orchardworks/agent-remote-protocol';
import { botGroup, mountBotApp, seedGroup, until } from '../test/bot-mode-fixtures.js';
import { promptText, setPromptText } from '../test/setup.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

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
    expect(app.button('New section')).toBeDefined(); expect(app.button('Retry')).toBeDefined();
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

it('creates an empty section only after Save and keeps it out of Windows', async () => {
  const scope = 'http://localhost/bot-new-section/'; seedGroup(scope, botGroup('A')); history.replaceState(null, '', '/?mode=bot');
  const app = await mountBotApp(scope);
  await act(async () => app.button('New section').click());
  expect(app.button('Save').disabled).toBe(true);
  const input = app.container.querySelector<HTMLInputElement>('input[aria-label="Section title"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Review'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => app.button('Save').click());
  await until(() => expect(app.workspace().groups.find(group => group.window.title === 'Review')).toBeDefined());
  const created = app.workspace().groups.find(group => group.window.title === 'Review')!;
  expect(created.presentation).toEqual({ window: false });
  expect(app.container.textContent).toContain('No bots in this group yet.');
  expect(new URL(location.href).searchParams.get('section')).toBe(created.window.id);
  await app.close();
});

it('retains an uncertain section request after Cancel and recovers that same creation on Retry', async () => {
  const scope = 'http://localhost/bot-uncertain-section/'; seedGroup(scope, botGroup('A')); history.replaceState(null, '', '/?mode=bot');
  const app = await mountBotApp(scope, { hosted: true });
  let original!: WindowGroup, identity!: { operationId: string; issuedAt: number };
  const creation = vi.spyOn(WindowWorkspaceClient.prototype, 'createGroup').mockImplementation(async (group, operation) => {
    original = group; identity = operation!; throw new Error('Creation receipt unavailable.');
  });
  const recovery = vi.spyOn(WindowWorkspaceClient.prototype, 'recoverCreate').mockImplementation(async (window, operation) => {
    expect(window.id).toBe(original.window.id); expect(operation).toEqual(identity); return original;
  });
  await act(async () => app.button('New section').click());
  const input = app.container.querySelector<HTMLInputElement>('input[aria-label="Section title"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Retained'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => app.button('Save').click());
  expect(app.container.textContent).toContain('Section creation is not confirmed');
  await act(async () => app.button('Cancel').click());
  expect(app.container.querySelector('input[aria-label="Section title"]')).toBeNull();
  await act(async () => app.button('Retry').click());
  expect(creation).toHaveBeenCalledOnce(); expect(recovery).toHaveBeenCalledOnce();
  expect(new URL(location.href).searchParams.get('section')).toBe(original.window.id);
  expect(app.workspace().readGroup(original.window.id)?.window.title).toBe('Retained');
  await app.close();
});

it('shows the shared sidebar header, a toolbar above the conversation, and collapses the roster', async () => {
  const scope = 'http://localhost/bot-shell-frame/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?mode=bot&section=A&bot=A1');
  const app = await mountBotApp(scope);
  try {
    await until(() => expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).not.toBeNull());
    const roster = app.container.querySelector<HTMLElement>('.lab-bot-roster')!;
    expect(roster.querySelector('.lab-sidebar-header nav[aria-label="Workbench mode"] [aria-pressed="true"]')?.textContent).toBe('Bot mode');
    expect(roster.querySelector('.lab-sidebar-header-actions button[aria-label="New section"]')).not.toBeNull();
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
    roster.querySelector<HTMLButtonElement>('button[aria-label="New section"]')!.focus();
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

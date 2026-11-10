import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { botGroup, botTarget, mountBotApp, seedGroup, until } from './test/bot-mode-fixtures.js';
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

it.each(['deleted', 'rebound', 'attached', 'managed', 'scope'] as const)('does not retain an Access-suspended Bot presentation after %s replacement', async change => {
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
      else if (change === 'attached') { group.window.views[0]!.placement = 'attached'; group.window.views[0]!.attachedTo = 'B2'; group.window.views.reverse(); }
      else if (change === 'managed') group.window.views[0]!.bindingPolicy = 'managed';
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
  await until(() => expect(app.container.querySelector('#lab-context .lab-sidebar-header')).not.toBeNull());
  await until(() => expect(app.workspace().window?.id).toBe('A'));
  const header = app.container.querySelector('#lab-context .lab-sidebar-header')!;
  expect(header.querySelector('nav[aria-label="Workbench mode"] [aria-pressed="true"]')?.textContent).toBe('Window mode');
  expect(app.container.querySelector('.lab-app-bar nav[aria-label="Workbench mode"]')).toBeNull();
  const newSessionPanel = () => app.container.querySelector('#lab-context .lab-provider-controls')!;
  expect(newSessionPanel().closest('[hidden]')).not.toBeNull();
  const open = async () => act(async () => (header.querySelector('button[aria-label="New"]') as HTMLButtonElement).click());
  const item = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menu"][aria-label="New"] [role="menuitem"]')].find(entry => entry.textContent === label)!;
  await open();
  expect([...document.querySelectorAll('[role="menu"][aria-label="New"] [role="menuitem"]')].map(entry => entry.textContent)).toEqual(['New session', 'New Window']);
  await act(async () => item('New session').click());
  expect(newSessionPanel().closest('[hidden]')).toBeNull();
  expect(app.container.querySelector('.lab-sidebar-new')?.getAttribute('aria-pressed')).toBe('true');
  await open();
  await act(async () => item('New Window').click());
  await until(() => expect(app.workspace().window?.id).toMatch(/^(?!A$)/));
  expect(app.workspace().windows.map(window => window.id)).toContain('A');
  await app.close();
});

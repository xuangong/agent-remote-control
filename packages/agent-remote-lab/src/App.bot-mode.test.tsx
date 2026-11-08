import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { botGroup, mountBotApp, seedGroup, until } from './test/bot-mode-fixtures.js';
import { promptText, setPromptText } from './test/setup.js';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); });

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

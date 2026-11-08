import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { WindowWorkspaceClient } from '@orchardworks/agent-remote-web';
import type { WindowGroup } from '@orchardworks/agent-remote-protocol';
import { botGroup, mountBotApp, seedGroup, until } from '../test/bot-mode-fixtures.js';
import { promptText, setPromptText } from '../test/setup.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

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
  expect(app.container.textContent).toContain('No bots in this section yet.');
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

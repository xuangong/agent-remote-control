import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createWindowView } from '@orchardworks/agent-remote-protocol';
import { botGroup, botTarget, mountBotApp, seedGroup, until } from './test/bot-mode-fixtures.js';

// Stage 7: on a phone, Window panes do not fold, so a sleeping bot shows a quiet Asleep bar over its released
// conversation instead of the folded card, and stays out of the live budget until it wakes.
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/'); });
function phone() {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('max-width: 1180px'), media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
}
const wake = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Wake' && !button.closest('[hidden]'));

it('keeps a sleeping primary bot released on a phone and wakes it from its Asleep bar', async () => {
  phone();
  const scope = 'http://localhost/u/compact-sleep/';
  const group = botGroup('A'); group.bots!.members = { A2: { asleep: true } };
  seedGroup(scope, group); history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope, { hosted: true });
  const shell = () => app.container.querySelector('[data-workbench-mode="window"]')!;
  try {
    await until(() => expect(app.workspace().window?.id).toBe('A'));
    await until(() => expect(shell().textContent).toContain('Asleep. Its conversation catches up when it wakes.'));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(app.attachments).not.toContain('A2');
    await act(async () => wake(shell())!.click());
    await until(() => expect(app.hostedGroups.get('A')!.bots!.members.A2?.asleep).toBeUndefined());
    await until(() => expect(app.attachments).toContain('A2'));
    expect(wake(shell())).toBeUndefined();
  } finally { await app.close(); }
});

it('keeps a sleeping dock bot released on a phone and wakes it from its Asleep bar', async () => {
  phone();
  const scope = 'http://localhost/u/compact-sleep-dock/';
  const group = botGroup('A');
  group.window.views.push(createWindowView('A3', botTarget('A3'), 'dock'));
  group.window.selectedViewId = 'A3';
  group.bots!.members = { A3: { asleep: true } };
  seedGroup(scope, group); history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope, { hosted: true });
  const shell = () => app.container.querySelector('[data-workbench-mode="window"]')!;
  try {
    await until(() => expect(app.workspace().window?.id).toBe('A'));
    // A phone shows one view at a time: the dock's pane is rendered, hidden behind the primary, until it is shown.
    const dockWake = () => [...shell().querySelectorAll<HTMLButtonElement>('[data-view-id="A3"] button')].find(button => button.textContent === 'Wake');
    await until(() => expect(dockWake()).toBeDefined());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(app.attachments).not.toContain('A3');
    await act(async () => dockWake()!.click());
    await until(() => expect(app.hostedGroups.get('A')!.bots!.members.A3?.asleep).toBeUndefined());
    // Awake, it is an ordinary hidden view: it attaches when it is shown.
    await until(() => expect(dockWake()).toBeUndefined());
  } finally { await app.close(); }
});

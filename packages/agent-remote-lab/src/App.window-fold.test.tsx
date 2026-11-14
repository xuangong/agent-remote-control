import { act } from 'react';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createWindowView } from '@orchardworks/agent-remote-protocol';
import { botGroup, botTarget, mountBotApp, seedGroup, until, visibleButton } from './test/bot-mode-fixtures.js';

const dialogMethods = ['showModal', 'close'] as const;
const originalDialog = Object.fromEntries(dialogMethods.map(name => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)]));
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });
afterAll(() => {
  for (const name of dialogMethods) {
    const original = originalDialog[name];
    if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original);
    else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>)[name];
  }
});
const sheet = () => document.querySelector<HTMLDialogElement>('dialog.ui-sheet[open]');

it("folds a bot's primary group on close and removes it only after confirming", async () => {
  const scope = 'http://localhost/window-fold-primary/'; seedGroup(scope, botGroup('A')); history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope, { hosted: true });
  try {
    await until(() => expect(app.workspace().hasActiveWindow).toBe(true));
    await until(() => expect(app.container.querySelector('button[aria-label="Close primary group: A2"]')).not.toBeNull());
    await act(async () => app.container.querySelector<HTMLButtonElement>('button[aria-label="Close primary group: A2"]')!.click());
    await until(() => expect(app.workspace().readGroup('A')?.window.views.find(view => view.id === 'A2')?.collapsed).toBe(true));
    const card = () => app.container.querySelector<HTMLButtonElement>('[data-primary-group-id="A2"] button.lab-folded-bot');
    await until(() => expect(card()).not.toBeNull());
    // The folded card's × removes the bot, after a confirmation.
    await act(async () => app.container.querySelector<HTMLButtonElement>('button[aria-label="Remove A2 from this group"]')!.click());
    expect(sheet()?.querySelector('h2')?.textContent).toBe('Remove “A2” from this group?');
    await act(async () => visibleButton(sheet()!, 'Cancel').click());
    expect(app.workspace().readGroup('A')?.window.views.map(view => view.id)).toContain('A2');
    await act(async () => app.container.querySelector<HTMLButtonElement>('button[aria-label="Remove A2 from this group"]')!.click());
    await act(async () => visibleButton(sheet()!, 'Remove').click());
    await until(() => expect(app.workspace().readGroup('A')?.window.views.map(view => view.id)).toEqual(['A1']));
  } finally { await app.close(); }
});

it("folds a bot's dock into a slim card on close and restores it", async () => {
  const group = botGroup('A');
  group.window.views.push(createWindowView('A3', botTarget('A3'), 'dock'));
  const scope = 'http://localhost/window-fold-dock/'; seedGroup(scope, group); history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope, { hosted: true });
  try {
    await until(() => expect(app.container.querySelector('button[aria-label="Close A3"]')).not.toBeNull());
    await act(async () => app.container.querySelector<HTMLButtonElement>('button[aria-label="Close A3"]')!.click());
    await until(() => expect(app.workspace().readGroup('A')?.window.views.find(view => view.id === 'A3')?.collapsed).toBe(true));
    const card = () => app.container.querySelector<HTMLButtonElement>('[data-view-id="A3"] button.lab-folded-bot, [data-dock-id="A3"] button.lab-folded-bot');
    await until(() => expect(card()).not.toBeNull());
    expect(card()!.getAttribute('aria-label')).toBe('Restore A3');
    await act(async () => card()!.click());
    await until(() => expect(app.workspace().readGroup('A')?.window.views.find(view => view.id === 'A3')?.collapsed).toBeFalsy());
  } finally { await app.close(); }
});

it("folds a bot's Side on close, lists it in the sidebar, and asks before the sidebar removes a bot", async () => {
  const group = botGroup('A');
  group.window.views.push({ ...createWindowView('S', botTarget('S'), 'attached'), attachedTo: 'A2' });
  const scope = 'http://localhost/window-fold-side/'; seedGroup(scope, group); history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope, { hosted: true });
  const collapsed = () => app.workspace().readGroup('A')?.window.views.find(view => view.id === 'S')?.collapsed;
  try {
    const side = () => app.container.querySelector<HTMLElement>('.lab-side-conversation[data-view-id="S"]');
    await until(() => expect(side()?.querySelector('button[aria-label="Close subagent"]')).not.toBeNull());
    await act(async () => side()!.querySelector<HTMLButtonElement>('button[aria-label="Close subagent"]')!.click());
    await until(() => expect(collapsed()).toBe(true));
    expect(side()?.hidden).toBe(true);
    // The folded Side stays listed in the sidebar, where choosing it restores it.
    const row = () => app.container.querySelector<HTMLElement>('#lab-context [data-window-view-row="S"]');
    expect(row()?.hasAttribute('data-collapsed')).toBe(true);
    await act(async () => row()!.querySelector<HTMLButtonElement>('[data-window-view-id="S"]')!.click());
    await until(() => expect(collapsed()).toBe(false));
    // The sidebar's × removes a bot only after confirming.
    await act(async () => app.container.querySelector<HTMLButtonElement>('#lab-context [data-window-view-close="S"]')!.click());
    expect(sheet()?.querySelector('h2')?.textContent).toBe('Remove “S” from this group?');
    await act(async () => visibleButton(sheet()!, 'Remove').click());
    await until(() => expect(app.workspace().readGroup('A')?.window.views.map(view => view.id)).toEqual(['A1', 'A2']));
  } finally { await app.close(); }
});

it('closes history views, and every view of a group not shown in Bot mode, as before', async () => {
  const group = botGroup('A');
  group.window.views[0] = createWindowView('A1', { ...botTarget('A1'), sessionIntent: 'history' }, 'primary');
  const hidden = { ...botGroup('B'), presentation: { bots: false as const } };
  const scope = 'http://localhost/window-fold-close/'; seedGroup(scope, group); seedGroup(scope, hidden); history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope, { hosted: true });
  try {
    await until(() => expect(app.container.querySelector('button[aria-label="Close primary group: A1"]')).not.toBeNull());
    await act(async () => app.container.querySelector<HTMLButtonElement>('button[aria-label="Close primary group: A1"]')!.click());
    await until(() => expect(app.workspace().readGroup('A')?.window.views.map(view => view.id)).toEqual(['A2']));
    await act(async () => { await app.workspace().open('B'); });
    await until(() => expect(app.container.querySelector('button[aria-label="Close primary group: B2"]')).not.toBeNull());
    await act(async () => app.container.querySelector<HTMLButtonElement>('button[aria-label="Close primary group: B2"]')!.click());
    await until(() => expect(app.workspace().readGroup('B')?.window.views.map(view => view.id)).toEqual(['B1']));
  } finally { await app.close(); }
});

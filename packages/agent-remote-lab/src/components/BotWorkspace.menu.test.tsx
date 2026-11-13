import { act } from 'react';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WindowWorkspaceClient } from '@orchardworks/agent-remote-web';
import { botGroup, mountBotApp, seedGroup, until, visibleButton } from '../test/bot-mode-fixtures.js';

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

async function choose(menu: string, label: string) {
  await act(async () => document.querySelector<HTMLButtonElement>(`button[aria-label="${menu}"]`)!.click());
  const item = [...document.querySelectorAll<HTMLElement>(`[role="menu"][aria-label="${menu}"] [role="menuitem"]`)].find(entry => entry.textContent === label);
  if (!item) throw new Error(`No menu item ${label}`);
  await act(async () => item.click());
}
const sheet = () => document.querySelector<HTMLDialogElement>('dialog.ui-sheet[open]');
async function type(input: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function open(name: string, groups: Parameters<typeof seedGroup>[1][], place: string) {
  const scope = `http://localhost/${name}/`;
  for (const group of groups) seedGroup(scope, group);
  history.replaceState(null, '', place);
  const app = await mountBotApp(scope, { hosted: true });
  await until(() => expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).not.toBeNull());
  return app;
}
const row = (app: Awaited<ReturnType<typeof open>>, group: string, view: string) =>
  app.container.querySelector(`nav[aria-label="Bots"] [data-bot-place='${JSON.stringify([group, view])}']`);

it('labels a bot from its menu, shows the label beside its name, and clears it', async () => {
  const app = await open('bot-menu-label', [botGroup('A')], '/?mode=bot&section=A&bot=A1');
  try {
    await choose('Bot actions: A1', 'Label…');
    expect(sheet()?.querySelector('h2')?.textContent).toBe('Label');
    await type(sheet()!.querySelector<HTMLInputElement>('input[aria-label="Label"]')!, 'Reviewer');
    await act(async () => visibleButton(sheet()!, 'Save').click());
    await until(() => expect(app.workspace().readGroup('A')?.bots?.members.A1).toEqual({ label: 'Reviewer' }));
    expect(sheet()).toBeNull();
    expect(row(app, 'A', 'A1')?.querySelector('.lab-bot-label')?.textContent).toBe('Reviewer');
    await choose('Bot actions: A1', 'Label…');
    expect(sheet()!.querySelector<HTMLInputElement>('input[aria-label="Label"]')!.value).toBe('Reviewer');
    await act(async () => visibleButton(sheet()!, 'Remove label').click());
    await until(() => expect(app.workspace().readGroup('A')?.bots?.members.A1).toEqual({}));
  } finally { await app.close(); }
});

it('gives a group formed from sessions its bot details in the same change as the label, without moving it', async () => {
  const app = await open('bot-menu-details', [botGroup('A', false), botGroup('B', false)], '/?mode=bot&section=B&bot=B1');
  try {
    const mutate = vi.mocked(WindowWorkspaceClient.prototype.mutate);
    const before = mutate.mock.calls.length;
    await choose('Bot actions: B1', 'Label…');
    await type(sheet()!.querySelector<HTMLInputElement>('input[aria-label="Label"]')!, 'Lead');
    await act(async () => visibleButton(sheet()!, 'Save').click());
    await until(() => expect(app.workspace().readGroup('B')?.bots?.members.B1).toEqual({ label: 'Lead' }));
    const sent = mutate.mock.calls.slice(before).map(([, mutation]) => mutation.operation);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'batch', operations: [{ type: 'bots.add' }, { type: 'bot.update', viewId: 'B1', details: { label: 'Lead' } }] });
    const sections = [...app.container.querySelectorAll('nav[aria-label="Bots"] .lab-bot-section-head h2')].map(heading => heading.textContent);
    expect(sections.slice(0, 2)).toEqual(['A', 'B']);
  } finally { await app.close(); }
});

it('hides a bot in Bot mode while it stays a pane of its Window, with Undo, and the group shows it again', async () => {
  const app = await open('bot-menu-hide', [botGroup('A')], '/?mode=bot&section=A&bot=A1');
  try {
    await choose('Bot actions: A1', 'Hide in Bot mode');
    await until(() => expect(app.workspace().readGroup('A')?.bots?.members.A1).toEqual({ hidden: true }));
    await until(() => expect(row(app, 'A', 'A1')).toBeNull());
    expect(app.workspace().readGroup('A')?.window.views.some(view => view.id === 'A1')).toBe(true);
    expect(new URL(location.href).searchParams.get('bot')).toBeNull();
    expect(app.container.querySelector('.lab-bot-notice')?.textContent).toContain('Hidden in Bot mode');
    await act(async () => visibleButton(app.container, 'Undo').click());
    await until(() => expect(app.workspace().readGroup('A')?.bots?.members.A1).toEqual({}));
    await until(() => expect(row(app, 'A', 'A1')).not.toBeNull());
    expect(app.container.querySelector('.lab-bot-notice')).toBeNull();
    await choose('Bot actions: A1', 'Hide in Bot mode');
    await until(() => expect(row(app, 'A', 'A1')).toBeNull());
    await choose('Group actions: A', 'Show hidden bots');
    await until(() => expect(app.workspace().readGroup('A')?.bots?.members.A1).toEqual({}));
    await until(() => expect(row(app, 'A', 'A1')).not.toBeNull());
  } finally { await app.close(); }
});

it('removes a bot and what closes with it from its group only after confirming', async () => {
  const group = botGroup('A');
  group.window.views.push({ ...group.window.views[0]!, id: 'A1-ask', placement: 'dock', bindingPolicy: 'managed', closeWith: 'A1', feature: { kind: 'ask', id: 'ask-1' },
    binding: { hostId: 'local', providerId: 'recorded', nativeSessionId: 'A1-ask', title: 'Why the delay?' } });
  const app = await open('bot-menu-remove', [group], '/?mode=bot&section=A&bot=A1');
  try {
    await choose('Bot actions: A1', 'Remove from group…');
    expect(sheet()?.querySelector('h2')?.textContent).toBe('Remove “A1” from “A”?');
    expect(sheet()?.textContent).toContain('Its session keeps running.');
    expect(sheet()?.textContent).toContain('1 Ask closes with it.');
    await act(async () => visibleButton(sheet()!, 'Cancel').click());
    expect(sheet()).toBeNull();
    expect(app.workspace().readGroup('A')?.window.views.map(view => view.id)).toContain('A1');
    await choose('Bot actions: A1', 'Remove from group…');
    await act(async () => visibleButton(sheet()!, 'Remove').click());
    await until(() => expect(app.workspace().readGroup('A')?.window.views.map(view => view.id)).toEqual(['A2']));
    await until(() => expect(row(app, 'A', 'A1')).toBeNull());
    expect(sheet()).toBeNull();
  } finally { await app.close(); }
});

it('shows where a bot runs in Info', async () => {
  const app = await open('bot-menu-info', [botGroup('A')], '/?mode=bot&section=A&bot=A1');
  try {
    await choose('Bot actions: A1', 'Info');
    expect(sheet()?.querySelector('h2')?.textContent).toBe('A1');
    const rows = Object.fromEntries([...sheet()!.querySelectorAll('.lab-bot-info dt')].map(term => [term.textContent, term.nextElementSibling?.textContent]));
    expect(rows).toMatchObject({ Group: 'A', Host: 'Test Host', Provider: 'Recorded Provider' });
    expect(rows).not.toHaveProperty('Earlier');
    await act(async () => visibleButton(sheet()!, 'Close').click());
    expect(sheet()).toBeNull();
  } finally { await app.close(); }
});

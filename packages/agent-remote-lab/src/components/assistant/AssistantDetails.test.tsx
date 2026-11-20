import { act } from 'react';
import { translator } from '@orchardworks/agent-client';
import { LocaleContext } from '@orchardworks/agent-client-web/react';
import { render } from '../../test/setup.js';
import { AssistantDetails, type AssistantRef } from './AssistantDetails.js';
import { SessionsList } from './SessionsList.js';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WindowWorkspaceClient } from '@orchardworks/agent-client';
import { botGroup, mountBotApp, seedGroup, until, visibleButton } from '../../test/bot-mode-fixtures.js';

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

/** Presses an action of the assistant's name card, in its details beside the conversation (or of a group's header menu). */
async function choose(menu: string, label: string) {
  if (menu !== 'card') {
    await act(async () => document.querySelector<HTMLButtonElement>(`button[aria-label="${menu}"]`)!.click());
    const item = [...document.querySelectorAll<HTMLElement>(`[role="menu"][aria-label="${menu}"] [role="menuitem"]`)].find(entry => entry.textContent === label);
    if (!item) throw new Error(`No menu item ${label}`);
    await act(async () => item.click());
    return;
  }
  await until(() => expect(document.querySelector('.lab-assistant-details .lab-assistant-card-actions')).not.toBeNull());
  // One action stands on the card; the others are in its ⋯ menu.
  const shown = [...document.querySelectorAll<HTMLButtonElement>('.lab-assistant-details .lab-assistant-card-actions .lab-assistant-action')].find(button => button.textContent === label);
  if (shown) { await act(async () => shown.click()); return; }
  await act(async () => document.querySelector<HTMLButtonElement>('.lab-assistant-details .lab-assistant-card-actions button[aria-label^="More actions for"]')!.click());
  const item = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find(entry => entry.textContent === label);
  if (!item) throw new Error(`No card action ${label}`);
  await act(async () => item.click());
}
const sheet = () => document.querySelector<HTMLDialogElement>('dialog.orchard-sheet[open]');
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
  app.container.querySelector<HTMLButtonElement>(`nav[aria-label="Chats"] [data-bot-place='${JSON.stringify([group, view])}']`);

it('labels a bot from its card, shows the label beside its name, and clears it', async () => {
  const app = await open('bot-menu-label', [botGroup('A')], '/?mode=bot&section=A&bot=A1');
  try {
    await choose('card', 'Label…');
    expect(sheet()?.querySelector('h2')?.textContent).toBe('Label');
    await type(sheet()!.querySelector<HTMLInputElement>('input[aria-label="Label"]')!, 'Reviewer');
    await act(async () => visibleButton(sheet()!, 'Save').click());
    await until(() => expect(app.workspace().readGroup('A')?.bots?.members.A1).toEqual({ name: 'A1', label: 'Reviewer' }));
    expect(sheet()).toBeNull();
    expect(row(app, 'A', 'A1')?.querySelector('.lab-bot-label')?.textContent).toBe('Reviewer');
    await choose('card', 'Label…');
    expect(sheet()!.querySelector<HTMLInputElement>('input[aria-label="Label"]')!.value).toBe('Reviewer');
    await act(async () => visibleButton(sheet()!, 'Remove label').click());
    await until(() => expect(app.workspace().readGroup('A')?.bots?.members.A1).toEqual({ name: 'A1' }));
  } finally { await app.close(); }
});

it('gives a group formed from sessions its bot details in the same change as the label, without moving it', async () => {
  const app = await open('bot-menu-details', [botGroup('A', false), botGroup('B', false)], '/?mode=bot&section=B&bot=B1');
  try {
    const mutate = vi.mocked(WindowWorkspaceClient.prototype.mutate);
    const before = mutate.mock.calls.length;
    // The bot has no stored name: its first edit stores the one it is called by.
    const name = row(app, 'B', 'B1')?.getAttribute('aria-label');
    await choose('card', 'Label…');
    await type(sheet()!.querySelector<HTMLInputElement>('input[aria-label="Label"]')!, 'Lead');
    await act(async () => visibleButton(sheet()!, 'Save').click());
    await until(() => expect(app.workspace().readGroup('B')?.bots?.members.B1).toEqual({ label: 'Lead', name }));
    const sent = mutate.mock.calls.slice(before).map(([, mutation]) => mutation.operation);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'batch', operations: [{ type: 'bots.add' }, { type: 'bot.update', viewId: 'B1', details: { label: 'Lead', name } }] });
    // The group A and B keep their places: the directory lists them in catalog order.
    await app.go('Assistants');
    const sections = [...app.container.querySelectorAll('.lab-directory .lab-bot-section-head h2')].map(heading => heading.firstChild?.textContent);
    expect(sections.slice(0, 2)).toEqual(['A', 'B']);
  } finally { await app.close(); }
});

it('hides a bot in Bot mode while it stays a pane of its Window, with Undo, and the group shows it again', async () => {
  const app = await open('bot-menu-hide', [botGroup('A')], '/?mode=bot&section=A&bot=A1');
  try {
    await choose('card', 'Hide in Bot mode');
    await until(() => expect(app.workspace().readGroup('A')?.bots?.members.A1).toEqual({ name: 'A1', hidden: true }));
    await until(() => expect(row(app, 'A', 'A1')).toBeNull());
    expect(app.workspace().readGroup('A')?.window.views.some(view => view.id === 'A1')).toBe(true);
    expect(new URL(location.href).searchParams.get('bot')).toBeNull();
    expect(app.container.querySelector('.lab-bot-notice')?.textContent).toContain('Hidden in Bot mode');
    await act(async () => visibleButton(app.container, 'Undo').click());
    await until(() => expect(app.workspace().readGroup('A')?.bots?.members.A1).toEqual({ name: 'A1' }));
    await until(() => expect(row(app, 'A', 'A1')).not.toBeNull());
    expect(app.container.querySelector('.lab-bot-notice')).toBeNull();
    await choose('card', 'Hide in Bot mode');
    await until(() => expect(row(app, 'A', 'A1')).toBeNull());
    // The directory still lists it, marked, and shows it in Chats again.
    await app.go('Assistants');
    await act(async () => visibleButton(app.container.querySelector('.lab-directory')!, 'Show in Chats').click());
    await until(() => expect(app.workspace().readGroup('A')?.bots?.members.A1).toEqual({ name: 'A1' }));
    await app.go('Chats');
    await until(() => expect(row(app, 'A', 'A1')).not.toBeNull());
  } finally { await app.close(); }
});

it('removes a bot and what closes with it from its group only after confirming', async () => {
  const group = botGroup('A');
  group.window.views.push({ ...group.window.views[0]!, id: 'A1-ask', placement: 'dock', bindingPolicy: 'managed', closeWith: 'A1', feature: { kind: 'ask', id: 'ask-1' },
    binding: { hostId: 'local', providerId: 'recorded', nativeSessionId: 'A1-ask', title: 'Why the delay?' } });
  const app = await open('bot-menu-remove', [group], '/?mode=bot&section=A&bot=A1');
  try {
    await choose('card', 'Remove from group…');
    expect(sheet()?.querySelector('h2')?.textContent).toBe('Remove “A1” from “A”?');
    expect(sheet()?.textContent).toContain('Its session keeps running.');
    expect(sheet()?.textContent).toContain('1 Ask closes with it.');
    await act(async () => visibleButton(sheet()!, 'Cancel').click());
    expect(sheet()).toBeNull();
    expect(app.workspace().readGroup('A')?.window.views.map(view => view.id)).toContain('A1');
    await choose('card', 'Remove from group…');
    await act(async () => visibleButton(sheet()!, 'Remove').click());
    await until(() => expect(app.workspace().readGroup('A')?.window.views.map(view => view.id)).toEqual(['A2']));
    await until(() => expect(row(app, 'A', 'A1')).toBeNull());
    expect(sheet()).toBeNull();
  } finally { await app.close(); }
});

it('shows where a bot runs in its details, beside its card, and closes them', async () => {
  const app = await open('bot-menu-info', [botGroup('A')], '/?mode=bot&section=A&bot=A1');
  try {
    const details = () => app.container.querySelector<HTMLElement>('.lab-assistant-details')!;
    await until(() => expect(details().querySelector('.lab-assistant-card-name')?.textContent).toBe('A1'));
    const rows = Object.fromEntries([...details().querySelectorAll('.lab-assistant-row')].map(row => [row.firstElementChild?.textContent, row.lastElementChild?.textContent]));
    expect(rows).toMatchObject({ Agent: 'Recorded Provider', Machine: 'Test Host' });
    expect(details().textContent).not.toContain('before:');
    await act(async () => visibleButton(details(), 'Close details').click());
    expect(details().hidden).toBe(true);
    expect(app.container.querySelector('.lab-assistant-top-bar button.lab-assistant-title')?.getAttribute('aria-expanded')).toBe('false');
  } finally { await app.close(); }
});

it('puts a bot to sleep: quiet and dimmed in the roster, with Undo, and opening it wakes it everywhere', async () => {
  const app = await open('bot-menu-sleep', [botGroup('A')], '/?mode=bot&section=A&bot=A1');
  try {
    await choose('card', 'Sleep');
    await until(() => expect(app.workspace().readGroup('A')?.bots?.members.A1).toEqual({ name: 'A1', asleep: true }));
    const asleep = () => row(app, 'A', 'A1')!;
    expect(asleep().getAttribute('data-asleep')).toBe('true');
    expect(asleep().querySelector('.lab-bot-sentence')?.textContent).toBe('Resting. Wakes when you need it');
    expect(new URL(location.href).searchParams.get('bot')).toBeNull();
    expect(app.container.querySelector('.lab-bot-notice')?.textContent).toContain('asleep');
    await act(async () => visibleButton(app.container, 'Undo').click());
    await until(() => expect(app.workspace().readGroup('A')?.bots?.members.A1).toEqual({ name: 'A1' }));
    await choose('card', 'Sleep');
    await until(() => expect(asleep().getAttribute('data-asleep')).toBe('true'));
    // Opening a sleeping bot wakes it.
    await act(async () => asleep().click());
    await until(() => expect(app.workspace().readGroup('A')?.bots?.members.A1).toEqual({ name: 'A1' }));
    await until(() => expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).not.toBeNull());
  } finally { await app.close(); }
});

it('shows a bot that fell asleep while open as asleep, with Wake, and releases its conversation', async () => {
  const group = botGroup('A'); group.bots!.members.A1 = { name: 'A1', asleep: true };
  const scope = 'http://localhost/bot-asleep-open/'; seedGroup(scope, group);
  history.replaceState(null, '', '/?mode=bot&section=A&bot=A1');
  const app = await mountBotApp(scope, { hosted: true });
  try {
    await until(() => expect(app.container.querySelector('.lab-bot-asleep')).not.toBeNull());
    expect(app.workspace().readGroup('A')?.bots?.members.A1).toEqual({ name: 'A1', asleep: true });
    await act(async () => visibleButton(app.container.querySelector('.lab-bot-asleep')!, 'Wake').click());
    await until(() => expect(app.workspace().readGroup('A')?.bots?.members.A1).toEqual({ name: 'A1' }));
    await until(() => expect(app.container.querySelector('.lab-bot-asleep')).toBeNull());
  } finally { await app.close(); }
});

const reference = (overrides: Partial<AssistantRef> = {}): AssistantRef => ({
  id: 'chief', picture: { shape: 'triangle', color: '#ff8a3d', gaze: 1 }, name: 'Chief', label: 'Reviewer', role: 'Side',
  actions: [{ label: 'Label…', onSelect: () => {} }, { label: 'Sleep', onSelect: () => {} }],
  where: { host: 'Mac mini', online: false, provider: 'Claude Code', earlier: ['Codex'] },
  sessions: { session: { hostId: 'local', providerId: 'claude', nativeSessionId: 's7', title: 'Release notes' }, directory: '/Users/me/notes', sessionId: 'session-7' },
  process: { mode: 'process', device: 'concise', chooseForAssistant: () => {}, chooseForDevice: () => {} },
  settings: <p>Model: Opus</p>,
  files: [{ path: '/Users/me/notes/notes.md', change: 'modified', source: 'change', entryKey: 'e1', additions: 3, deletions: 1 }],
  ...overrides,
});

it("renders each section from the assistant's state, in order, in the reader's language", async () => {
  const container = await render(<AssistantDetails assistant={reference()} surface="panel" onClose={() => {}} />);
  expect([...container.querySelectorAll('.lab-assistant-section > h3')].map(heading => heading.textContent))
    .toEqual(['Process', 'Where it works', 'Sessions', 'Model and settings', 'Files']);
  expect(container.querySelector('.lab-assistant-card-name')?.textContent).toBe('Chief');
  // One line of its role; its actions are in the card's ⋯ menu when none stands visible.
  expect(container.querySelector('.lab-assistant-card-role')?.textContent).toBe('Side · Reviewer');
  expect(container.querySelector('.lab-assistant-card-actions button[aria-label="More actions for Chief"]')).not.toBeNull();
  expect(container.querySelector('.lab-assistant-card-actions .lab-assistant-action')).toBeNull();
  const rows = Object.fromEntries([...container.querySelectorAll('.lab-assistant-row')].map(row => [row.firstElementChild?.textContent, row.lastElementChild?.textContent]));
  expect(rows).toEqual({ Agent: 'Claude Codebefore: Codex', Machine: 'Mac minioffline' });
  // A session is one compact row; its chevron shows its working directory and ID.
  const session = container.querySelector('.lab-assistant-chain li')!;
  expect(session.querySelector('.lab-assistant-session-title')?.textContent).toBe('Release notes');
  expect(container.querySelector('.lab-assistant-identity')).toBeNull();
  await act(async () => session.querySelector<HTMLButtonElement>('button[aria-label="More about Release notes"]')!.click());
  expect(container.querySelector('.lab-assistant-identity')?.textContent).toContain('/Users/me/notes');
  expect(container.querySelector('.lab-assistant-identity')?.textContent).toContain('session-7');
  expect(container.querySelector('[aria-label="This assistant"] [aria-pressed="true"]')?.textContent).toBe('Process');
  // The device's default, notifications and letters are in Settings > Assistants, not on the assistant.
  expect(container.querySelector('[aria-label="All assistants on this device"], [role="switch"]')).toBeNull();
  expect(container.querySelector('.lab-assistant-files')?.textContent).toBe('notes.mdedited+3 −1');
  const chinese = await render(<LocaleContext.Provider value="zh"><AssistantDetails assistant={reference({ files: [] })} surface="panel" onClose={() => {}} /></LocaleContext.Provider>);
  expect([...chinese.querySelectorAll('.lab-assistant-section > h3')].map(heading => heading.textContent)).toEqual(['过程显示', '它在哪里工作', '会话', '模型', '文件']);
  expect(chinese.querySelector('.lab-assistant-empty')?.textContent).toBe(translator('zh')('details.noFiles'));
});

it('lists the chain newest first, marks the current session and offers Return to current from an earlier one', async () => {
  const entry = (id: string, title: string) => ({ hostId: 'local', providerId: 'claude', nativeSessionId: id, title });
  const opened: string[] = [];
  const container = await render(<SessionsList sessions={{ chain: { open: async session => { opened.push(session.nativeSessionId); return true; },
    navigation: { roleKey: 'role', history: true, session: entry('s2', 'Second'), current: entry('s3', 'Third'), predecessor: entry('s1', 'First'), ancestors: [] } } }} />);
  const items = [...container.querySelectorAll('.lab-assistant-chain li')];
  expect(items.map(item => item.querySelector('.lab-assistant-session-title')?.textContent)).toEqual(['Third', 'Second', 'First']);
  expect(items.map(item => item.querySelector('.lab-assistant-session small')?.textContent)).toEqual(['current', 'earlier', 'earlier']);
  expect(items[1]!.getAttribute('aria-current')).toBe('true');
  const back = [...container.querySelectorAll('a')].find(link => link.textContent === 'Return to current')!;
  await act(async () => back.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
  expect(opened).toEqual(['s3']);
});

it("chooses the process mode for this assistant, keeping its other details, and offers no device default or notifications", async () => {
  const group = botGroup('A'); group.bots!.members.A1 = { name: 'A1', label: 'Reviewer' };
  const app = await open('bot-details-process', [group], '/?mode=bot&section=A&bot=A1');
  try {
    const details = () => app.container.querySelector<HTMLElement>('.lab-assistant-details')!;
    await until(() => expect(details().querySelector('[aria-label="This assistant"]')).not.toBeNull());
    await act(async () => visibleButton(details().querySelector('[aria-label="This assistant"]')!, 'Full').click());
    await until(() => expect(app.workspace().readGroup('A')?.bots?.members.A1).toEqual({ name: 'A1', label: 'Reviewer', process: 'full' }));
    expect(details().querySelector('[aria-label="All assistants on this device"]')).toBeNull();
    expect(details().querySelector('.lab-assistant-section[aria-labelledby$="notifications"]')).toBeNull();
    expect(localStorage.getItem('agent-remote:process-mode')).toBeNull();
  } finally { await app.close(); }
});

it("changes an assistant's avatar from its card, for every device", async () => {
  const app = await open('bot-details-avatar', [botGroup('A')], '/?mode=bot&section=A&bot=A1');
  try {
    const details = () => app.container.querySelector<HTMLElement>('.lab-assistant-details')!;
    await until(() => expect(details().querySelector('button[aria-label="Change avatar"]')).not.toBeNull());
    await act(async () => details().querySelector<HTMLButtonElement>('button[aria-label="Change avatar"]')!.click());
    await act(async () => details().querySelector<HTMLButtonElement>('button[aria-label="Sideways triangle"]')!.click());
    await until(() => expect(app.workspace().readGroup('A')?.bots?.members.A1?.picture?.shape).toBe('sideways'));
    await act(async () => details().querySelector<HTMLButtonElement>('button[aria-label="Teal"]')!.click());
    await until(() => expect(app.workspace().readGroup('A')?.bots?.members.A1?.picture).toMatchObject({ shape: 'sideways', color: '#22b3c2' }));
  } finally { await app.close(); }
});

it("renames an assistant from its card: a click edits the name, Enter stores it for every device and Escape keeps it", async () => {
  const app = await open('bot-details-rename', [botGroup('A')], '/?mode=bot&section=A&bot=A1');
  try {
    const details = () => app.container.querySelector<HTMLElement>('.lab-assistant-details')!;
    await until(() => expect(details().querySelector('button[aria-label="Rename A1"]')).not.toBeNull());
    await act(async () => details().querySelector<HTMLButtonElement>('button[aria-label="Rename A1"]')!.click());
    const field = () => details().querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    expect(field().value).toBe('A1');
    await type(field(), 'Pebbles');
    await act(async () => field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await until(() => expect(app.workspace().readGroup('A')?.bots?.members.A1?.name).toBe('Pebbles'));
    await until(() => expect(row(app, 'A', 'A1')?.getAttribute('aria-label')).toBe('Pebbles'));
    await act(async () => details().querySelector<HTMLButtonElement>('button[aria-label="Rename Pebbles"]')!.click());
    await type(field(), 'Something else');
    await act(async () => field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(details().querySelector('input[aria-label="Name"]')).toBeNull();
    expect(app.workspace().readGroup('A')?.bots?.members.A1?.name).toBe('Pebbles');
  } finally { await app.close(); }
});

it('calls a bot without a name by its generated name, never its title, and stores that name with its first edit', async () => {
  const group = botGroup('A'); group.bots!.members = {};
  const app = await open('bot-details-generated', [group], '/?mode=bot&section=A&bot=A1');
  try {
    const shown = row(app, 'A', 'A1')?.getAttribute('aria-label');
    expect(shown).toBeTruthy();
    expect(shown).not.toBe('A1');
    expect(app.container.querySelector('.lab-assistant-details .lab-assistant-card-name')?.textContent).toBe(shown);
    await choose('card', 'Sleep');
    await until(() => expect(app.workspace().readGroup('A')?.bots?.members.A1).toEqual({ name: shown, asleep: true }));
  } finally { await app.close(); }
});

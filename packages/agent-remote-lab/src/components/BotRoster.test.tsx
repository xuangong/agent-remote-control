import { act } from 'react';
import { expect, it } from 'vitest';
import { BotRoster } from './BotRoster.js';
import { projectBotRoster } from '../bot-roster.js';
import { botGroup, botTarget, visibleButton } from '../test/bot-mode-fixtures.js';
import { render } from '../test/setup.js';
import type { BotPlace } from '../workbench-mode.js';

it('renders accessible metadata and fallback Host identity without hidden members or invented results', async () => {
  const group = botGroup('A'); group.bots!.members = { A1: { label: 'Reviewer', picture: { shape: 'squircle', color: '#123456' } }, A2: { hidden: true } };
  const model = projectBotRoster([group], [{ ...botTarget('Other'), hostId: 'host-a' }, { ...botTarget('Other'), hostId: 'host-b' }], { status: () => 'offline' });
  let selected: BotPlace | undefined;
  const container = await render(<BotRoster model={model} place={{ kind: 'bot', groupId: 'A', viewId: 'A1' }} onSelect={place => { selected = place; }} directoryControls={<button>Refresh</button>} />);
  expect(container.querySelector('nav[aria-label="Bots"]')).not.toBeNull();
  expect(container.textContent).toContain('Reviewer'); expect(container.textContent).not.toContain('A2');
  expect(container.textContent).not.toMatch(/Failed|New result/);
  expect(container.textContent).toContain('host-a'); expect(container.textContent).toContain('host-b');
  expect(visibleButton(container, 'A1').getAttribute('aria-current')).toBe('true');
  expect(container.querySelector<SVGPathElement>('[data-shape="squircle"] .orchard-avatar-body')?.style.fill).toBe('#123456');
  await act(async () => visibleButton(container, 'A1').click());
  expect(selected).toEqual({ kind: 'bot', groupId: 'A', viewId: 'A1' });
  expect([...container.querySelectorAll('h2,h3')].at(-1)?.textContent).toBe('Other sessions');
});

it('shows a bot like a teammate: name, role and label as tags, status, Asks under it, and Host details only in its tooltip', async () => {
  const group = botGroup('A');
  group.window.views[0] = { ...group.window.views[0]!, feature: { kind: 'tpm', id: 'work', metadata: { hostId: 'local' } }, bindingPolicy: 'managed' };
  group.window.views.push({ id: 'ask', binding: { ...botTarget('asked'), title: 'Why the delay?' }, closeWith: 'A1', feature: { kind: 'ask', id: 'ask-1' }, bindingPolicy: 'managed',
    placement: 'float', width: 440, collapsed: false, display: { mode: 'content', lettersVisible: true } });
  group.bots!.members = { A1: { label: 'Release' } };
  const model = projectBotRoster([group], [], { status: binding => binding.nativeSessionId === 'A1' ? 'waiting' : 'idle' });
  let selected: BotPlace | undefined;
  const container = await render(<BotRoster model={model} hostName={id => id === 'local' ? 'Lab server' : id} onSelect={place => { selected = place; }} directoryControls={null} />);
  const row = visibleButton(container, 'A1');
  expect(row.querySelector('.lab-bot-name')?.textContent).toBe('A1');
  expect(row.querySelector('.lab-bot-role')?.textContent).toBe('TPM');
  expect(row.querySelector('.lab-bot-label')?.textContent).toBe('Release');
  expect(row.querySelector('.lab-bot-status')?.textContent).toBe('Needs you');
  expect(row.querySelector('.lab-bot-status')?.getAttribute('data-attention')).toBe('true');
  expect(row.textContent).not.toContain('recorded');
  expect(row.title).toBe('Lab server · recorded');
  expect(row.getAttribute('aria-description')).toBe('TPM · Release · Needs you');
  const asks = container.querySelector('[data-bot-asks="A1"]')!;
  expect(asks.textContent).toBe('Why the delay?');
  await act(async () => asks.querySelector('button')!.click());
  expect(selected).toEqual({ kind: 'bot', groupId: 'A', viewId: 'A1' });
});

it('keeps Other sessions folded with their Refresh controls inside, and names an empty group plainly', async () => {
  const empty = botGroup('E'); empty.window.views = []; empty.window.selectedPrimaryViewId = null; empty.window.selectedViewId = null;
  const model = projectBotRoster([empty], [botTarget('loose')], { status: () => 'idle' });
  const container = await render(<BotRoster model={model} onSelect={() => {}} directoryControls={<button type="button">Refresh</button>} />);
  expect(container.textContent).toContain('No bots in this group yet.');
  const other = container.querySelector<HTMLDetailsElement>('details.lab-bot-other')!;
  expect(other.open).toBe(false);
  expect(other.querySelector('summary')?.textContent).toBe('Other sessions');
  expect(other.textContent).toContain('Refresh');
});

it("shows a bot's unsent draft where its latest reply would be, except for the bot on screen", async () => {
  const group = botGroup('A');
  const model = projectBotRoster([group], [], { status: binding => binding.nativeSessionId === 'A2' ? 'waiting' : 'idle',
    reply: () => ({ replyAt: Date.now(), preview: 'Release notes are ready.' }), draft: binding => `Draft of ${binding.nativeSessionId}\nsecond line` });
  const container = await render(<BotRoster model={model} place={{ kind: 'bot', groupId: 'A', viewId: 'A1' }} onSelect={() => {}} directoryControls={null} />);
  // The bot on screen shows its reply: its draft is right below, in its composer.
  const current = visibleButton(container, 'A1');
  expect(current.querySelector('.lab-bot-draft')).toBeNull();
  expect(current.querySelector('.lab-bot-preview')?.textContent).toBe('Release notes are ready.');
  // Another bot shows its draft in place of the reply, after a status that asks for something.
  const other = visibleButton(container, 'A2');
  expect(other.querySelector('.lab-bot-status')?.textContent).toBe('Needs you');
  expect(other.querySelector('.lab-bot-draft-label')?.textContent).toBe('Draft');
  expect(other.querySelector('.lab-bot-draft')?.textContent).toBe('DraftDraft of A2 second line');
  expect(other.querySelector('.lab-bot-preview:not(.lab-bot-draft)')).toBeNull();
  expect(other.getAttribute('aria-description')).toContain('Draft: Draft of A2 second line');
});

it('says a bot has messages waiting to send when nothing more urgent shows', async () => {
  const group = botGroup('A');
  const model = projectBotRoster([group], [], { status: binding => binding.nativeSessionId === 'A2' ? 'waiting' : 'idle', waiting: () => true });
  const container = await render(<BotRoster model={model} onSelect={() => {}} directoryControls={null} />);
  const quiet = visibleButton(container, 'A1'), urgent = visibleButton(container, 'A2');
  expect(quiet.querySelector('.lab-bot-status')?.textContent).toBe('Waiting to send');
  expect(quiet.querySelector('.lab-bot-status')?.getAttribute('data-outbox')).toBe('true');
  expect(quiet.getAttribute('aria-description')).toContain('Waiting to send');
  expect(urgent.querySelector('.lab-bot-status')?.textContent).toBe('Needs you');
});

it("offers a bot's own actions as a context menu on its row, at the pointer or from the keyboard, on desktop only", async () => {
  const model = projectBotRoster([botGroup('A')], [], { status: () => 'idle' });
  const chosen: string[] = [];
  const rowActions = (row: { viewId: string }) => [{ label: 'Info', onSelect: () => chosen.push(`info ${row.viewId}`) }, { label: 'Sleep', onSelect: () => chosen.push(`sleep ${row.viewId}`) }];
  const container = await render(<BotRoster model={model} place={{ kind: 'bot', groupId: 'A', viewId: 'A2' }} onSelect={() => {}} directoryControls={null} rowActions={rowActions} />);
  const row = visibleButton(container, 'A1');
  const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
  // A right click opens the menu of the row it was on (not the selected bot), where the pointer is.
  const opened = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 200 });
  await act(async () => row.dispatchEvent(opened));
  expect(opened.defaultPrevented).toBe(true);
  expect(menu()?.getAttribute('aria-label')).toBe('Bot actions: A1');
  expect(menu()!.style.left).toBe('120px');
  await act(async () => [...menu()!.querySelectorAll('button')].find(button => button.textContent === 'Sleep')!.click());
  expect(chosen).toEqual(['sleep A1']);
  expect(menu()).toBeNull();
  expect(document.activeElement).toBe(row);
  // Shift+F10 (or the context menu key) opens it at the row, on its first item; Escape returns focus to the row.
  row.focus();
  await act(async () => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })));
  expect(document.activeElement?.textContent).toBe('Info');
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(menu()).toBeNull();
  expect(document.activeElement).toBe(row);
});

it('leaves a long press to the phone: a compact roster has no context menu', async () => {
  const model = projectBotRoster([botGroup('A')], [], { status: () => 'idle' });
  const container = await render(<BotRoster model={model} onSelect={() => {}} directoryControls={null} compact rowActions={() => [{ label: 'Info', onSelect: () => {} }]} />);
  const pressed = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  await act(async () => visibleButton(container, 'A1').dispatchEvent(pressed));
  expect(pressed.defaultPrevented).toBe(false);
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it('draws each bot\'s avatar from its view id, lets a stored picture win and shows its mood', async () => {
  const group = botGroup('A');
  group.window.views.push({ ...group.window.views[0]!, id: 'A2', binding: botTarget('A2') }, { ...group.window.views[0]!, id: 'A3', binding: botTarget('A3') });
  group.bots!.members = { A1: { picture: { shape: 'triangle', color: '#22b3c2', gaze: 2 } }, A2: { picture: { shape: 'sideways', color: '#ff6fa8' } }, A3: { asleep: true } };
  const model = projectBotRoster([group], [], { status: binding => binding.nativeSessionId === 'A1' ? 'waiting' : binding.nativeSessionId === 'A2' ? 'running' : 'idle' });
  const container = await render(<BotRoster model={model} onSelect={() => {}} directoryControls={null} />);
  const avatar = (name: string) => visibleButton(container, name).querySelector<HTMLElement>('.orchard-avatar')!;
  const fill = (name: string) => avatar(name).querySelector<SVGPathElement>('.orchard-avatar-body')!.style.fill;
  for (const name of ['A1', 'A2', 'A3']) {
    expect(avatar(name).dataset.shape, name).toMatch(/^(circle|squircle|triangle|sideways)$/);
    expect(avatar(name).dataset.mood, name).toBeTruthy();
  }
  expect([avatar('A1').dataset.shape, fill('A1')]).toEqual(['triangle', '#22b3c2']);
  expect([avatar('A2').dataset.shape, fill('A2')]).toEqual(['sideways', '#ff6fa8']);
  expect([avatar('A1').dataset.mood, avatar('A2').dataset.mood]).toEqual(['needs_you', 'working']);
  expect(avatar('A3').dataset.mood).toBe('resting');
  expect(fill('A3')).toBe('var(--orchard-avatar-resting)');
});

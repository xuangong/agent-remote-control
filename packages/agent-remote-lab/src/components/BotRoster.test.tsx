import { act } from 'react';
import { expect, it } from 'vitest';
import { BotRoster } from './BotRoster.js';
import { projectBotRoster } from '../bot-roster.js';
import { botGroup, botTarget, visibleButton } from '../test/bot-mode-fixtures.js';
import { render } from '../test/setup.js';
import type { BotPlace } from '../workbench-mode.js';

it('renders accessible metadata and fallback Host identity without hidden members or invented results', async () => {
  const group = botGroup('A'); group.bots!.members = { A1: { label: 'Reviewer', picture: { shape: 'hexagon', color: '#123456' } }, A2: { hidden: true } };
  const model = projectBotRoster([group], [{ ...botTarget('Other'), hostId: 'host-a' }, { ...botTarget('Other'), hostId: 'host-b' }], { status: () => 'offline' });
  let selected: BotPlace | undefined;
  const container = await render(<BotRoster model={model} place={{ kind: 'bot', groupId: 'A', viewId: 'A1' }} onSelect={place => { selected = place; }} directoryControls={<button>Refresh</button>} />);
  expect(container.querySelector('nav[aria-label="Bots"]')).not.toBeNull();
  expect(container.textContent).toContain('Reviewer'); expect(container.textContent).not.toContain('A2');
  expect(container.textContent).not.toMatch(/Failed|New result/);
  expect(container.textContent).toContain('host-a'); expect(container.textContent).toContain('host-b');
  expect(visibleButton(container, 'A1').getAttribute('aria-current')).toBe('true');
  expect(container.querySelector('[data-shape="hexagon"]')?.getAttribute('style')).toContain('#123456');
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

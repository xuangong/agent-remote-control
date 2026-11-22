import { act } from 'react';
import { expect, it } from 'vitest';
import { BotRoster } from './BotRoster.js';
import { projectBotRoster } from '../../kernel/bot-roster.js';
import { botGroup, botTarget, visibleButton } from '../../test/bot-mode-fixtures.js';
import { createWindowView, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { render } from '../../test/setup.js';
import type { BotPlace } from '../../kernel/workbench-mode.js';

it('renders accessible metadata and fallback Host identity without hidden members or invented results', async () => {
  const group = botGroup('A'); group.bots!.members = { A1: { name: 'A1', label: 'Reviewer', picture: { shape: 'squircle', color: '#123456' } }, A2: { hidden: true } };
  const model = projectBotRoster([group], [{ ...botTarget('Other'), hostId: 'host-a' }, { ...botTarget('Other'), hostId: 'host-b' }], { status: () => 'offline' });
  let selected: BotPlace | undefined;
  const container = await render(<BotRoster model={model} groups={[group]} place={{ kind: 'bot', groupId: 'A', viewId: 'A1' }} onSelect={place => { selected = place; }} directoryControls={<button>Refresh</button>} />);
  expect(container.querySelector('nav[aria-label="Chats"]')).not.toBeNull();
  expect(container.textContent).toContain('Reviewer'); expect(container.textContent).not.toContain('A2');
  expect(container.textContent).not.toMatch(/Failed|New result/);
  expect(container.textContent).toContain('host-a'); expect(container.textContent).toContain('host-b');
  expect(visibleButton(container, 'A1').getAttribute('aria-current')).toBe('true');
  expect(container.querySelector<SVGPathElement>('[data-shape="squircle"] .orchard-avatar-body')?.style.fill).toBe('#123456');
  await act(async () => visibleButton(container, 'A1').click());
  expect(selected).toEqual({ kind: 'bot', groupId: 'A', viewId: 'A1' });
  expect([...container.querySelectorAll('h2,h3')].at(-1)?.textContent).toBe('Other sessions');
});

it('shows a bot like a teammate: name, role and label as tags, its sentence, Asks under it, and Host details only in its tooltip', async () => {
  const group = botGroup('A');
  group.window.views[0] = { ...group.window.views[0]!, feature: { kind: 'tpm', id: 'work', metadata: { hostId: 'local' } }, bindingPolicy: 'managed' };
  group.window.views.push({ id: 'ask', binding: { ...botTarget('asked'), title: 'Why the delay?' }, closeWith: 'A1', feature: { kind: 'ask', id: 'ask-1' }, bindingPolicy: 'managed',
    placement: 'float', width: 440, collapsed: false, display: { mode: 'content', lettersVisible: true } });
  group.bots!.members = { A1: { name: 'A1', label: 'Release' } };
  const model = projectBotRoster([group], [], { status: binding => binding.nativeSessionId === 'A1' ? 'waiting' : 'idle' });
  let selected: BotPlace | undefined;
  const container = await render(<BotRoster model={model} groups={[group]} hostName={id => id === 'local' ? 'Lab server' : id} onSelect={place => { selected = place; }} directoryControls={null} />);
  const row = visibleButton(container, 'A1');
  expect(row.querySelector('.lab-bot-name')?.textContent).toBe('A1');
  expect(row.querySelector('.lab-bot-role')?.textContent).toBe('TPM');
  expect(row.querySelector('.lab-bot-label')?.textContent).toBe('Release');
  expect(row.querySelector('.lab-bot-sentence')?.textContent).toBe('Wants to ask you something');
  expect(row.querySelector('.lab-bot-sentence')?.getAttribute('data-state')).toBe('needs_you');
  expect(row.textContent).not.toContain('recorded');
  expect(row.title).toBe('Lab server · recorded');
  expect(row.getAttribute('aria-description')).toBe('TPM · Release · Wants to ask you something');
  const asks = container.querySelector('[data-bot-asks="A1"]')!;
  expect(asks.textContent).toBe('Why the delay?');
  await act(async () => asks.querySelector('button')!.click());
  expect(selected).toEqual({ kind: 'bot', groupId: 'A', viewId: 'A1' });
});

it('calls a bot by its stored name or a generated one, never by its session\'s title', async () => {
  const group = botGroup('A');
  group.window.views = group.window.views.map(view => ({ ...view, binding: { ...view.binding!, title: 'Reply with the words LOCAL and OK' } }));
  group.bots!.members = { A1: { name: 'Pebbles' } };
  const model = projectBotRoster([group], [], { status: () => 'idle' });
  const container = await render(<BotRoster model={model} groups={[group]} onSelect={() => {}} directoryControls={null} />);
  const names = [...container.querySelectorAll('.lab-bot-row .lab-bot-name')].map(name => name.textContent);
  expect(names[0]).toBe('Pebbles');
  expect(names[1]).toBeTruthy();
  expect(names).not.toContain('Reply with the words LOCAL and OK');
  expect(names[1]).toBe(projectBotRoster([group], [], { status: () => 'idle' }).sections[0]!.rows[1]!.name);
});

it('keeps Other sessions folded with their Refresh controls inside, and says an empty list plainly', async () => {
  const empty = botGroup('E'); empty.window.views = []; empty.window.selectedPrimaryViewId = null; empty.window.selectedViewId = null;
  const model = projectBotRoster([empty], [botTarget('loose')], { status: () => 'idle' });
  const container = await render(<BotRoster model={model} groups={[empty]} onSelect={() => {}} directoryControls={<button type="button">Refresh</button>} />);
  expect(container.textContent).toContain('No chats yet. Start one from Assistants.');
  const other = container.querySelector<HTMLDetailsElement>('details.lab-bot-other')!;
  expect(other.open).toBe(false);
  expect(other.querySelector('summary')?.textContent).toBe('Other sessions');
  expect(other.textContent).toContain('Refresh');
});

it("shows a bot's unsent draft where its latest reply would be, except for the bot on screen, and after a sentence that asks for something", async () => {
  const group = botGroup('A');
  const model = projectBotRoster([group], [], { status: binding => binding.nativeSessionId === 'A2' ? 'waiting' : 'idle',
    reply: () => ({ replyAt: Date.now(), preview: 'Release notes are ready.' }), draft: binding => `Draft of ${binding.nativeSessionId}\nsecond line` });
  const container = await render(<BotRoster model={model} groups={[group]} place={{ kind: 'bot', groupId: 'A', viewId: 'A1' }} onSelect={() => {}} directoryControls={null} />);
  // The bot on screen shows its reply: its draft is right below, in its composer.
  const current = visibleButton(container, 'A1');
  expect(current.querySelector('.lab-bot-draft')).toBeNull();
  expect(current.querySelector('.lab-bot-sentence')?.textContent).toBe('Release notes are ready.');
  // Another bot shows its draft after a sentence that asks for something, and in place of a quiet one.
  const other = visibleButton(container, 'A2');
  expect(other.querySelector('.lab-bot-sentence')?.textContent).toBe('Wants to ask you something');
  expect(other.querySelector('.lab-bot-draft-label')?.textContent).toBe('Draft');
  expect(other.querySelector('.lab-bot-draft')?.textContent).toBe('DraftDraft of A2 second line');
  expect(other.getAttribute('aria-description')).toContain('Draft: Draft of A2 second line');
  const quiet = projectBotRoster([group], [], { status: () => 'idle', reply: () => ({ replyAt: Date.now(), preview: 'Release notes are ready.' }), draft: () => 'Ship it' });
  const quietRow = visibleButton(await render(<BotRoster model={quiet} groups={[group]} onSelect={() => {}} directoryControls={null} />), 'A2');
  expect(quietRow.querySelector('.lab-bot-sentence')).toBeNull();
  expect(quietRow.querySelector('.lab-bot-draft')?.textContent).toBe('DraftShip it');
});

it('says a bot has messages waiting to send when nothing more urgent shows', async () => {
  const group = botGroup('A');
  const model = projectBotRoster([group], [], { status: binding => binding.nativeSessionId === 'A2' ? 'waiting' : 'idle', waiting: () => true });
  const container = await render(<BotRoster model={model} groups={[group]} onSelect={() => {}} directoryControls={null} />);
  const quiet = visibleButton(container, 'A1'), urgent = visibleButton(container, 'A2');
  expect(quiet.querySelector('.lab-bot-sentence')?.textContent).toBe('Will send when it is ready');
  expect(quiet.querySelector('.lab-bot-sentence')?.getAttribute('data-state')).toBe('waiting_to_send');
  expect(quiet.getAttribute('aria-description')).toContain('Will send when it is ready');
  expect(urgent.querySelector('.lab-bot-sentence')?.textContent).toBe('Wants to ask you something');
});

it('draws each bot\'s avatar from its view id, lets a stored picture win and shows its mood', async () => {
  const group = botGroup('A');
  group.window.views.push({ ...group.window.views[0]!, id: 'A2', binding: botTarget('A2') }, { ...group.window.views[0]!, id: 'A3', binding: botTarget('A3') });
  group.bots!.members = { A1: { name: 'A1', picture: { shape: 'triangle', color: '#22b3c2', gaze: 2 } }, A2: { name: 'A2', picture: { shape: 'sideways', color: '#ff6fa8' } }, A3: { name: 'A3', asleep: true } };
  const model = projectBotRoster([group], [], { status: binding => binding.nativeSessionId === 'A1' ? 'waiting' : binding.nativeSessionId === 'A2' ? 'running' : 'idle' });
  const container = await render(<BotRoster model={model} groups={[group]} onSelect={() => {}} directoryControls={null} />);
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

it("says each assistant's state in one sentence with its avatar's mood, the unread dot and the reply time, in the reader's language", async () => {
  const group = botGroup('A');
  group.window.views.push({ ...group.window.views[0]!, id: 'A3', binding: botTarget('A3') });
  group.bots!.members = { A1: { name: 'A1' }, A2: { name: 'A2' }, A3: { name: 'A3', asleep: true } };
  const replyAt = Date.now() - 60_000;
  const model = (t?: Parameters<typeof projectBotRoster>[2]['t']) => projectBotRoster([group], [], {
    status: binding => binding.nativeSessionId === 'A1' ? 'running' : 'idle', host: () => ({ online: true, name: 'Mac mini' }),
    reply: binding => binding.nativeSessionId === 'A2' ? { replyAt, preview: 'Done reading, I have 3 thoughts' } : undefined, unread: () => true, ...(t ? { t } : {}) });
  const container = await render(<BotRoster model={model()} groups={[group]} onSelect={() => {}} directoryControls={null} />);
  const row = (name: string) => visibleButton(container, name);
  expect([row('A1'), row('A2'), row('A3')].map(item => [item.querySelector('.lab-bot-sentence')?.textContent, item.querySelector<HTMLElement>('.orchard-avatar')?.dataset.mood]))
    .toEqual([['Working on it', 'working'], ['Done reading, I have 3 thoughts', 'idle'], ['Resting. Wakes when you need it', 'resting']]);
  expect(row('A2').querySelector('.lab-bot-unread')).not.toBeNull();
  expect(row('A2').getAttribute('data-unread')).toBe('true');
  expect(row('A2').querySelector('.lab-bot-time')?.textContent).toBeTruthy();
  expect(row('A2').getAttribute('aria-description')).toMatch(/^Done reading, I have 3 thoughts · Unread · /);
  // The sentences of a Chinese reader are the design's voice.
  const { translator } = await import('@orchardworks/agent-client');
  const chinese = await render(<BotRoster model={model(translator('zh'))} groups={[group]} onSelect={() => {}} directoryControls={null} />);
  expect(visibleButton(chinese, 'A1').querySelector('.lab-bot-sentence')?.textContent).toBe('在忙，稍等～');
  expect(visibleButton(chinese, 'A3').querySelector('.lab-bot-sentence')?.textContent).toBe('在休息，需要时自动醒来');
});

it('sections the chats by group, each pinned first and then by latest reply, and keeps the default group to one plain list', async () => {
  const first = botGroup('A'), second = botGroup('B');
  second.bots!.members.B2 = { name: 'B2', pinned: true };
  const replies: Record<string, number> = { A1: 10, B1: 30 };
  const options = { status: () => 'idle' as const, reply: (session: { nativeSessionId: string }) => replies[session.nativeSessionId] ? { replyAt: replies[session.nativeSessionId]!, preview: 'ok' } : undefined };
  const container = await render(<BotRoster model={projectBotRoster([first, second], [], options)} groups={[first, second]} onSelect={() => {}} directoryControls={null} />);
  expect([...container.querySelectorAll('.lab-chat-group')].map(section => [section.querySelector('h2')?.textContent, [...section.querySelectorAll('.lab-bot-name')].map(name => name.textContent)]))
    .toEqual([['A', ['A1', 'A2']], ['B', ['B2', 'B1']]]);
  // Groups of one assistant, still named after its session, are the default group: alone it is one list without headings.
  const own = (id: string): WindowGroup => ({ window: { schemaVersion: 3, id, revision: 0, title: `${id}1`, selectedPrimaryViewId: `${id}1`, selectedViewId: `${id}1`, views: [createWindowView(`${id}1`, botTarget(`${id}1`), 'primary')] },
    bots: { rank: 'm', members: { [`${id}1`]: { name: `${id}1` } } } });
  const alone = [own('P'), own('Q')];
  replies.Q1 = 40;
  const plain = await render(<BotRoster model={projectBotRoster(alone, [], options)} groups={alone} onSelect={() => {}} directoryControls={null} />);
  expect([...plain.querySelectorAll('.lab-bot-chats .lab-bot-name')].map(name => name.textContent)).toEqual(['Q1', 'P1']);
  expect([...plain.querySelectorAll('h2')].map(heading => heading.textContent)).toEqual(['Other sessions']);
});

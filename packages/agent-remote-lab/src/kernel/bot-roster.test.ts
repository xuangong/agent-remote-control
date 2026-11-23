import { expect, it } from 'vitest';
import { createWindowView, type WindowGroup, type WindowSessionBinding, type WindowView } from '@orchardworks/agent-remote-protocol';
import { projectBotRoster } from './bot-roster.js';
import type { SessionActivityStatus } from './session-activity-status.js';

const binding = (id: string) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id, title: id });
const group = (id: string, views: WindowView[], rank = 'm'): WindowGroup => ({ window: { schemaVersion: 3, id, revision: 0, title: id, views, selectedPrimaryViewId: views.find(v => v.placement === 'primary')?.id ?? null, selectedViewId: views[0]?.id ?? null }, bots: { rank, members: {} } });
it('derives Other sessions against every binding in all groups', () => {
  const section = group('section', [createWindowView('one', binding('one'), 'primary'), createWindowView('hidden', binding('hidden'), 'dock')]);
  section.bots!.members.hidden = { hidden: true };
  const ordinary = group('ordinary', [createWindowView('history', { ...binding('past'), sessionIntent: 'history' }, 'primary')]); delete ordinary.bots;
  const result = projectBotRoster([section, ordinary], ['one', 'hidden', 'past', 'loose'].map(binding), { status: () => 'starting' });
  expect(result.sections[0]?.rows.map(row => row.viewId)).toEqual(['one']);
  expect(result.sections[0]?.hidden).toEqual(['hidden']);
  expect(result.sections[0]?.rows[0]?.assistant.state).toBe('working');
  expect(result.other.map(session => session.nativeSessionId)).toEqual(['loose']);
});
it('makes every session a bot with its role, except Asks, history, subagents and empty views', () => {
  const views = ['primary', 'dock', 'float'].map(placement => createWindowView(placement, binding(placement), placement as 'primary' | 'dock' | 'float'));
  views.push(createWindowView('empty'), createWindowView('history', { ...binding('history'), sessionIntent: 'history' }), createWindowView('child', { ...binding('child'), parentNativeSessionId: 'parent' }),
    { ...createWindowView('side', binding('side'), 'attached'), attachedTo: 'primary' },
    { ...createWindowView('lead', binding('lead')), bindingPolicy: 'managed', feature: { kind: 'team', id: 'release', metadata: { role: 'leader' } } },
    { ...createWindowView('member', binding('member')), bindingPolicy: 'managed', closeWith: 'lead', feature: { kind: 'team', id: 'release', metadata: { role: 'member', memberId: 'm1' } } },
    { ...createWindowView('coordinator', binding('coordinator')), bindingPolicy: 'managed', feature: { kind: 'team', id: 'support', metadata: { role: 'leader' } } },
    { ...createWindowView('tpm', binding('tpm')), bindingPolicy: 'managed', feature: { kind: 'tpm', id: 'work', metadata: { hostId: 'host' } } },
    { ...createWindowView('ask', binding('ask')), bindingPolicy: 'managed', closeWith: 'primary', feature: { kind: 'ask', id: 'ask-1' } });
  const rows = projectBotRoster([group('all', views)], [], { status: () => 'idle' }).sections[0]!.rows;
  expect(rows.map(row => [row.viewId, row.role])).toEqual([['primary', undefined], ['dock', undefined], ['float', undefined], ['side', 'Side'],
    ['lead', 'Team Leader'], ['member', 'Team member'], ['coordinator', 'Team Leader'], ['tpm', 'TPM']]);
  expect(rows[0]!.asks).toEqual([{ viewId: 'ask', title: 'ask' }]);
  expect(rows.slice(1).every(row => row.asks.length === 0)).toBe(true);
});

it('shows every group not hidden in Bot mode in catalog order, ranked or not, so a group never moves when it gains details', () => {
  const plain = (id: string) => { const result = group(id, [createWindowView(`${id}-main`, binding(id), 'primary')]); delete result.bots; return result; };
  const hidden = { ...plain('hidden'), presentation: { bots: false as const } };
  const formed = group('formed-empty', [createWindowView('none')]); delete formed.bots;
  const made = group('made-empty', [createWindowView('none')], 'c');
  const result = projectBotRoster([plain('second'), hidden, made, group('ranked', [createWindowView('r', binding('ranked'), 'primary')], 'b'), plain('first'), formed], [], { status: () => 'idle' });
  // A group formed from sessions appears once it has a bot; one made in Bot mode shows while still empty.
  expect(result.sections.map(section => section.groupId)).toEqual(['second', 'made-empty', 'ranked', 'first']);
});

it('shows a session once: in a group with bot details before a group formed from sessions, else in the first group', () => {
  const ranked = group('ranked', [createWindowView('a', binding('shared'), 'primary')], 'b');
  const later = group('later', [createWindowView('b', binding('shared'), 'primary'), createWindowView('c', binding('own'))]); delete later.bots;
  const onlyDuplicate = group('only-duplicate', [createWindowView('d', binding('shared'), 'primary')]); delete onlyDuplicate.bots;
  const result = projectBotRoster([later, onlyDuplicate, ranked], [], { status: () => 'idle' });
  expect(result.sections.map(section => [section.groupId, section.rows.map(row => row.viewId)])).toEqual([['later', ['c']], ['ranked', ['a']]]);
  // Between groups formed from sessions, the first in catalog order shows it.
  expect(projectBotRoster([onlyDuplicate, later], [], { status: () => 'idle' }).sections.map(section => [section.groupId, section.rows.map(row => row.viewId)]))
    .toEqual([['only-duplicate', ['d']], ['later', ['c']]]);
});
it('orders bots by pin, rank, then document order', () => {
  const section = group('b', ['default-two', 'z', 'pin', 'a', 'default-one'].map(id => createWindowView(id, binding(id))));
  section.bots!.members = { z: { rank: 'z' }, a: { rank: 'a' }, pin: { pinned: true, rank: 'z' } };
  const result = projectBotRoster([group('z', [createWindowView('z1', binding('z1'))], 'z'), section, group('a', [createWindowView('a1', binding('a1'))])], [], { status: () => 'unknown' });
  expect(result.sections.map(section => section.groupId)).toEqual(['z', 'b', 'a']);
  expect(result.sections[1]?.rows.map(row => row.viewId)).toEqual(['pin', 'a', 'z', 'default-two', 'default-one']);
});
it("says each visible bot's live state by the one rule, and lists no hidden bot", () => {
  const section = group('s', ['working', 'failed', 'waiting', 'hidden'].map(id => createWindowView(id, binding(id))));
  section.bots!.members.hidden = { hidden: true };
  const values: Record<string, SessionActivityStatus> = { working: 'running', failed: 'failed', waiting: 'waiting', hidden: 'starting' };
  const states = () => projectBotRoster([section], [], { status: b => values[b.nativeSessionId]! }).sections[0]!.rows.map(row => [row.viewId, row.assistant.state]);
  expect(states()).toEqual([['working', 'working'], ['failed', 'failed'], ['waiting', 'needs_you']]);
  values.waiting = 'idle'; values.failed = 'closed'; values.working = 'offline';
  expect(states()).toEqual([['working', 'host_offline'], ['failed', 'ended'], ['waiting', 'idle']]);
});
it('deduplicates fallback by full identity and sorts timestamps with missing ones last', () => {
  const loose = { ...binding('loose'), updatedAt: '2026-11-07', createdAt: '2026-01-01' };
  const entries = [binding('missing'), { ...binding('created'), createdAt: '2026-11-08' }, loose, { ...loose, title: 'duplicate' }, { ...binding('loose'), hostId: 'other', updatedAt: '2026-11-08' }];
  const result = projectBotRoster([], entries, { status: () => 'idle' });
  expect(result.other.map(s => [s.hostId, s.nativeSessionId])).toEqual([['other', 'loose'], ['host', 'loose'], ['host', 'created'], ['host', 'missing']]);
});

it("carries each bot's latest reply and whether it is unread, and marks a group with an unread bot", () => {
  const groups = [group('A', [createWindowView('a1', binding('a1'), 'primary'), createWindowView('a2', binding('a2'), 'primary')]), group('B', [createWindowView('b1', binding('b1'), 'primary')])];
  const replies: Record<string, { replyAt: number; preview: string }> = { a1: { replyAt: 5, preview: 'Done.' }, b1: { replyAt: 3, preview: 'Old.' } };
  const model = projectBotRoster(groups, [], { status: () => 'idle', reply: value => replies[value.nativeSessionId], unread: (_value, replyAt) => replyAt > 4 });
  const [a, b] = model.sections;
  expect(a!.rows.map(row => [row.viewId, row.reply?.preview, row.unread])).toEqual([['a1', 'Done.', true], ['a2', undefined, undefined]]);
  expect(a!.unread).toBe(true);
  expect(b!.rows[0]).toMatchObject({ reply: { replyAt: 3, preview: 'Old.' } });
  expect(b!.rows[0]!.unread).toBeUndefined();
  expect(b!.unread).toBeUndefined();
});

it("carries the unsent draft of a bot's current session", () => {
  const groups = [group('A', [createWindowView('a1', binding('a1'), 'primary'), createWindowView('a2', binding('a2'), 'primary')])];
  const drafts: Record<string, string> = { a1: 'Ship the notes', after: 'Continue from here' };
  const model = projectBotRoster(groups, [], { status: () => 'idle', draft: value => drafts[value.nativeSessionId] });
  expect(model.sections[0]!.rows.map(row => row.draft)).toEqual(['Ship the notes', undefined]);
  // After a handoff the draft belongs to the session that drives the bot now.
  const followed = projectBotRoster(groups, [], { status: () => 'idle', current: (_group, viewId) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: viewId === 'a2' ? 'after' : 'a1' }),
    draft: value => drafts[value.nativeSessionId] });
  expect(followed.sections[0]!.rows.map(row => row.draft)).toEqual(['Ship the notes', 'Continue from here']);
});

it("marks a bot whose current session has messages waiting for its Host", () => {
  const groups = [group('A', [createWindowView('a1', binding('a1'), 'primary'), createWindowView('a2', binding('a2'), 'primary')])];
  const model = projectBotRoster(groups, [], { status: () => 'idle', waiting: value => value.nativeSessionId === 'a2' });
  expect(model.sections[0]!.rows.map(row => row.waiting)).toEqual([undefined, true]);
});

it("follows a bot's current session after a handoff and keeps the latest reply of its chain", () => {
  const groups = [group('A', [createWindowView('a1', binding('before'), 'primary')])];
  const replies: Record<string, { replyAt: number; preview: string }> = { before: { replyAt: 7, preview: 'Handing off.' } };
  const statuses: Record<string, SessionActivityStatus> = { before: 'idle', after: 'running' };
  const model = projectBotRoster(groups, [], { status: session => statuses[session.nativeSessionId] ?? 'unknown',
    current: () => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'after' }),
    reply: session => replies[session.nativeSessionId], unread: (session, replyAt) => session.nativeSessionId === 'before' && replyAt > 5 });
  const row = model.sections[0]!.rows[0]!;
  expect(row.session.nativeSessionId).toBe('after');
  expect(row.assistant.state).toBe('working');
  // The successor has not replied yet: the latest reply is still the one before the handoff.
  expect(row.reply).toEqual({ replyAt: 7, preview: 'Handing off.' });
  expect(row.unread).toBe(true);
  replies.after = { replyAt: 9, preview: 'Picked it up.' };
  expect(projectBotRoster(groups, [], { status: () => 'idle', current: () => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'after' }), reply: session => replies[session.nativeSessionId] })
    .sections[0]!.rows[0]!.reply).toEqual({ replyAt: 9, preview: 'Picked it up.' });
});

it("keeps the latest reply of a handed-off bot on a device that did not hand it off, from the sessions its chain lists", () => {
  const groups = [group('A', [createWindowView('a1', binding('after'), 'primary')])];
  const replies: Record<string, { replyAt: number; preview: string }> = { before: { replyAt: 7, preview: 'Said on the first provider.' } };
  const earlier = (windowId: string, viewId: string) => windowId === 'A' && viewId === 'a1' ? [{ hostId: 'host', providerId: 'recorded', nativeSessionId: 'before' }] : [];
  const row = (options: { earlier?: typeof earlier }) => projectBotRoster(groups, [], { status: () => 'idle', reply: session => replies[session.nativeSessionId], ...options }).sections[0]!.rows[0]!;
  expect(row({}).reply).toBeUndefined();
  expect(row({ earlier }).reply).toEqual({ replyAt: 7, preview: 'Said on the first provider.' });
});

it('lists every assistant in the directory by group in catalog order, marking those Chats does not show', () => {
  const shown = group('shown', ['a', 'b'].map(id => createWindowView(id, binding(id))));
  shown.bots!.members.b = { hidden: true, asleep: true };
  const hiddenGroup = { ...group('hidden-group', [createWindowView('c', binding('c'))], 'b'), presentation: { bots: false as const } };
  const windowOnly = group('window-only', [createWindowView('d', binding('d'))], 'c'); delete windowOnly.bots;
  const everyone = projectBotRoster([shown, hiddenGroup, windowOnly], [], { status: () => 'idle', everyone: true });
  expect(everyone.sections.map(section => [section.groupId, section.hiddenInChats ?? false, section.rows.map(row => [row.viewId, row.hiddenInChats ?? false])])).toEqual([
    ['shown', false, [['a', false], ['b', true]]], ['hidden-group', true, [['c', true]]], ['window-only', false, [['d', false]]]]);
  expect(everyone.sections[0]!.rows[1]!.details.asleep).toBe(true);
  // The Chats projection of the same groups leaves the group hidden in Bot mode out.
  expect(projectBotRoster([shown, hiddenGroup, windowOnly], [], { status: () => 'idle' }).sections.map(section => section.groupId)).toEqual(['shown', 'window-only']);
});

it('names a bot\'s chief, by its record (bots design 10)', () => {
  const team = group('team', [createWindowView('chief', binding('chief'), 'primary'), createWindowView('scribe', binding('scribe'), 'primary')]);
  team.bots!.members.chief = { botId: 'b_' + '1'.repeat(32), name: 'Chief' };
  team.bots!.members.scribe = { botId: 'b_' + '2'.repeat(32), name: 'Scribe', chief: 'b_' + '1'.repeat(32) };
  const rows = projectBotRoster([team], [], { status: () => 'idle' }).sections[0]!.rows;
  expect(rows.map(row => [row.name, row.chief])).toEqual([['Chief', undefined], ['Scribe', 'Chief']]);
});

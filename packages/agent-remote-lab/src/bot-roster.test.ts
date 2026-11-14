import { expect, it } from 'vitest';
import { createWindowView, type WindowGroup, type WindowSessionBinding, type WindowView } from '@orchardworks/agent-remote-protocol';
import { botActivityLabel, projectBotRoster } from './bot-roster.js';
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
  expect(result.sections[0]?.status).toBe('Needs you');
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
  const rows = projectBotRoster([group('all', views)], [], { status: () => 'idle', supportTeam: id => id === 'support' }).sections[0]!.rows;
  expect(rows.map(row => [row.viewId, row.role])).toEqual([['primary', undefined], ['dock', undefined], ['float', undefined], ['side', 'Side'],
    ['lead', 'Team Leader'], ['member', 'Team member'], ['coordinator', 'Support'], ['tpm', 'TPM']]);
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
it('uses live urgency and excludes hidden statuses', () => {
  const section = group('s', ['working', 'failed', 'waiting', 'hidden'].map(id => createWindowView(id, binding(id))));
  section.bots!.members.hidden = { hidden: true };
  const values: Record<string, SessionActivityStatus> = { working: 'running', failed: 'failed', waiting: 'waiting', hidden: 'starting' };
  const status = () => projectBotRoster([section], [], { status: b => values[b.nativeSessionId]! }).sections[0]?.status;
  expect(status()).toBe('Needs you'); values.waiting = 'idle'; expect(status()).toBe('Failed'); values.failed = 'closed'; expect(status()).toBe('Working'); values.working = 'offline'; expect(status()).toBeUndefined();
  expect(['idle', 'offline', 'unknown', 'closed', undefined].map(value => botActivityLabel(value as SessionActivityStatus))).toEqual([undefined, undefined, undefined, undefined, undefined]);
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

it("follows a bot's current session after a handoff and keeps the latest reply of its chain", () => {
  const groups = [group('A', [createWindowView('a1', binding('before'), 'primary')])];
  const replies: Record<string, { replyAt: number; preview: string }> = { before: { replyAt: 7, preview: 'Handing off.' } };
  const statuses: Record<string, SessionActivityStatus> = { before: 'idle', after: 'running' };
  const model = projectBotRoster(groups, [], { status: session => statuses[session.nativeSessionId] ?? 'unknown',
    current: () => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'after' }),
    reply: session => replies[session.nativeSessionId], unread: (session, replyAt) => session.nativeSessionId === 'before' && replyAt > 5 });
  const row = model.sections[0]!.rows[0]!;
  expect(row.session.nativeSessionId).toBe('after');
  expect(row.status).toBe('Working');
  // The successor has not replied yet: the latest reply is still the one before the handoff.
  expect(row.reply).toEqual({ replyAt: 7, preview: 'Handing off.' });
  expect(row.unread).toBe(true);
  replies.after = { replyAt: 9, preview: 'Picked it up.' };
  expect(projectBotRoster(groups, [], { status: () => 'idle', current: () => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'after' }), reply: session => replies[session.nativeSessionId] })
    .sections[0]!.rows[0]!.reply).toEqual({ replyAt: 9, preview: 'Picked it up.' });
});

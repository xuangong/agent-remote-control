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

it('shows every group not hidden in Bot mode, ranked groups first, then the rest in catalog order', () => {
  const plain = (id: string) => { const result = group(id, [createWindowView(`${id}-main`, binding(id), 'primary')]); delete result.bots; return result; };
  const hidden = { ...plain('hidden'), presentation: { bots: false as const } };
  const formed = group('formed-empty', [createWindowView('none')]); delete formed.bots;
  const made = group('made-empty', [createWindowView('none')], 'c');
  const result = projectBotRoster([plain('second'), hidden, made, group('ranked', [createWindowView('r', binding('ranked'), 'primary')], 'b'), plain('first'), formed], [], { status: () => 'idle' });
  // A group formed from sessions appears once it has a bot; one made in Bot mode shows while still empty.
  expect(result.sections.map(section => section.groupId)).toEqual(['ranked', 'made-empty', 'second', 'first']);
});

it('shows a session once, in the first group that holds it', () => {
  const ranked = group('ranked', [createWindowView('a', binding('shared'), 'primary')], 'b');
  const later = group('later', [createWindowView('b', binding('shared'), 'primary'), createWindowView('c', binding('own'))]); delete later.bots;
  const onlyDuplicate = group('only-duplicate', [createWindowView('d', binding('shared'), 'primary')]); delete onlyDuplicate.bots;
  const result = projectBotRoster([later, onlyDuplicate, ranked], [], { status: () => 'idle' });
  expect(result.sections.map(section => [section.groupId, section.rows.map(row => row.viewId)])).toEqual([['ranked', ['a']], ['later', ['c']]]);
});
it('orders sections lexically with ID ties and bots by pin, rank, then document order', () => {
  const section = group('b', ['default-two', 'z', 'pin', 'a', 'default-one'].map(id => createWindowView(id, binding(id))));
  section.bots!.members = { z: { rank: 'z' }, a: { rank: 'a' }, pin: { pinned: true, rank: 'z' } };
  const result = projectBotRoster([group('z', [createWindowView('z1', binding('z1'))], 'z'), section, group('a', [createWindowView('a1', binding('a1'))])], [], { status: () => 'unknown' });
  expect(result.sections.map(section => section.groupId)).toEqual(['a', 'b', 'z']);
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

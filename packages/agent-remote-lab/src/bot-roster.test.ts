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
  const result = projectBotRoster([section, ordinary], ['one', 'hidden', 'past', 'loose'].map(binding), () => 'starting');
  expect(result.sections[0]?.rows.map(row => row.viewId)).toEqual(['one']);
  expect(result.sections[0]?.status).toBe('Needs you');
  expect(result.other.map(session => session.nativeSessionId)).toEqual(['loose']);
});
it('includes only ordinary eligible primary, dock and float views', () => {
  const views = ['primary', 'dock', 'float'].map(placement => createWindowView(placement, binding(placement), placement as 'primary' | 'dock' | 'float'));
  views.push(createWindowView('empty'), createWindowView('history', { ...binding('history'), sessionIntent: 'history' }), createWindowView('child', { ...binding('child'), parentNativeSessionId: 'parent' }), { ...createWindowView('attached', binding('attached'), 'attached'), attachedTo: 'primary' }, { ...createWindowView('managed', binding('managed')), bindingPolicy: 'managed' }, { ...createWindowView('feature', binding('feature')), feature: { kind: 'team', id: 'team' } });
  expect(projectBotRoster([group('all', views)], [], () => 'idle').sections[0]?.rows.map(row => row.viewId)).toEqual(['primary', 'dock', 'float']);
});
it('orders sections lexically with ID ties and bots by pin, rank, then document order', () => {
  const section = group('b', ['default-two', 'z', 'pin', 'a', 'default-one'].map(id => createWindowView(id, binding(id))));
  section.bots!.members = { z: { rank: 'z' }, a: { rank: 'a' }, pin: { pinned: true, rank: 'z' } };
  const result = projectBotRoster([group('z', [], 'z'), section, group('a', [])], [], () => 'unknown');
  expect(result.sections.map(section => section.groupId)).toEqual(['a', 'b', 'z']);
  expect(result.sections[1]?.rows.map(row => row.viewId)).toEqual(['pin', 'a', 'z', 'default-two', 'default-one']);
});
it('uses live urgency and excludes hidden statuses', () => {
  const section = group('s', ['working', 'failed', 'waiting', 'hidden'].map(id => createWindowView(id, binding(id))));
  section.bots!.members.hidden = { hidden: true };
  const values: Record<string, SessionActivityStatus> = { working: 'running', failed: 'failed', waiting: 'waiting', hidden: 'starting' };
  const status = () => projectBotRoster([section], [], b => values[b.nativeSessionId]!).sections[0]?.status;
  expect(status()).toBe('Needs you'); values.waiting = 'idle'; expect(status()).toBe('Failed'); values.failed = 'closed'; expect(status()).toBe('Working'); values.working = 'offline'; expect(status()).toBeUndefined();
  expect(['idle', 'offline', 'unknown', 'closed', undefined].map(value => botActivityLabel(value as SessionActivityStatus))).toEqual([undefined, undefined, undefined, undefined, undefined]);
});
it('deduplicates fallback by full identity and sorts timestamps with missing ones last', () => {
  const loose = { ...binding('loose'), updatedAt: '2026-11-07', createdAt: '2026-01-01' };
  const entries = [binding('missing'), { ...binding('created'), createdAt: '2026-11-08' }, loose, { ...loose, title: 'duplicate' }, { ...binding('loose'), hostId: 'other', updatedAt: '2026-11-08' }];
  const result = projectBotRoster([], entries, () => 'idle');
  expect(result.other.map(s => [s.hostId, s.nativeSessionId])).toEqual([['other', 'loose'], ['host', 'loose'], ['host', 'created'], ['host', 'missing']]);
});

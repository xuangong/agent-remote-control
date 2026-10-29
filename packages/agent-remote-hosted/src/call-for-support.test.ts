import { expect, it } from 'vitest';
import { isTeam, type Team } from '@orchardworks/agent-remote-protocol';
import { review, supportFixture } from './test-utils/call-for-support-fixture.js';

it('creates a group from a worker call: the worker seat binds first, then a read-only coordinator, then the call', async () => {
  const f = supportFixture(); const profile = f.profile(); f.enable('worker', [profile.id]);
  const result = await f.call({ operationId: 'op-1', profileId: profile.id });
  expect(result).toMatchObject({ status: 'accepted', callId: expect.any(String), roleId: expect.any(String) });
  const team = f.team(result.roleId);
  expect(isTeam(team)).toBe(true);
  expect(f.seats.map(seat => seat.member.role)).toEqual(['requester', 'leader']);
  expect(team.source).toEqual({ hostId: 'mac', providerId: 'codex', nativeSessionId: 'worker', title: 'Implement login' });
  expect(team.members[0]).toMatchObject({ role: 'leader', providerId: 'codex', model: 'gpt-5.5', reasoningEffort: 'high', access: 'read_only', workspace: { kind: 'shared' },
    cwd: '/repo', creation: 'ready' });
  expect(team.members[1]).toMatchObject({ role: 'requester', nativeSessionId: 'worker', cwd: '/repo', creation: 'ready' });
  expect(team.callForSupport).toMatchObject({ profileId: profile.id, profileRevision: 1, role: 'Cross review', status: 'active',
    calls: [{ id: result.callId, status: 'open', origin: 'worker', context: { commit: 'abcdef1' } }] });
  expect(team.messages).toEqual([expect.objectContaining({ from: team.members[1]!.id, to: team.members[0]!.id, status: 'queued', callForSupportCallId: result.callId })]);
  expect(team.messages[0]!.text).toContain(`[Support call ${result.callId} · Cross review · findings · from the worker]`);
  expect(team.messages[0]!.text).toContain('Code: commit abcdef1.');
  expect(team.messages[0]!.text).toContain('do not read it');
});

it('reuses the worker\'s group for the profile, queues later calls behind the open one and replays an operation', async () => {
  const f = supportFixture(); const profile = f.profile(); f.enable('worker', [profile.id]);
  const first = await f.call({ operationId: 'op-1', profileId: profile.id });
  const second = await f.call({ operationId: 'op-2', profileId: profile.id, task: 'Also check the tests.', followUpOf: first.callId });
  expect(second).toMatchObject({ status: 'accepted', roleId: first.roleId });
  expect(await f.call({ operationId: 'op-2', profileId: profile.id, task: 'Also check the tests.', followUpOf: first.callId })).toEqual(second);
  await expect(f.call({ operationId: 'op-2', profileId: profile.id, task: 'Something else.', followUpOf: first.callId })).rejects.toThrow('different');
  const team = f.team(first.roleId);
  expect(team.callForSupport!.calls.map(call => call.status)).toEqual(['open', 'queued']);
  expect(team.messages).toHaveLength(1);
  const third = await f.call({ operationId: 'op-3', roleId: first.roleId, task: 'Third.' });
  expect(third).toMatchObject({ status: 'accepted', roleId: first.roleId });
  await expect(f.call({ operationId: 'op-4', roleId: first.roleId, followUpOf: 'unknown' })).rejects.toThrow('unknown');
  expect(f.teams()).toHaveLength(1);
});

it('starts a fresh group on request and archives the previous one', async () => {
  const f = supportFixture(); const profile = f.profile(); f.enable('worker', [profile.id]);
  const first = await f.call({ operationId: 'op-1', profileId: profile.id });
  const fresh = await f.call({ operationId: 'op-2', profileId: profile.id, fresh: true });
  expect(fresh.roleId).not.toBe(first.roleId);
  expect(f.team(first.roleId).status).toBe('archiving');
  expect(f.team(first.roleId).messages.every(message => message.status === 'canceled')).toBe(true);
  expect(f.team(fresh.roleId).status).toBe('active');
});

it('answers without effects when the session is not enabled, the profile or role is unknown, or no profile is named', async () => {
  const f = supportFixture(); const profile = f.profile(); const other = f.profile({ ...review, name: 'Linux tests' });
  expect(await f.call({ operationId: 'op', profileId: profile.id })).toMatchObject({ status: 'unavailable', message: expect.stringContaining('not enabled') });
  f.enable('worker', [profile.id]);
  expect(await f.call({ operationId: 'op', profileId: other.id })).toMatchObject({ status: 'unavailable' });
  expect(await f.call({ operationId: 'op', roleId: 'unknown' })).toMatchObject({ status: 'unavailable' });
  expect(await f.call({ operationId: 'op' })).toMatchObject({ status: 'needs_approval' });
  expect(f.teams()).toEqual([]);
  await expect(f.call({ operationId: 'op', profileId: profile.id }, 'win')).rejects.toThrow('Update the Controller');
});

it('refuses a coordinator provider that cannot run read-only sessions', async () => {
  const f = supportFixture({ readOnly: false }); const profile = f.profile(); f.enable('worker', [profile.id]);
  await expect(f.call({ operationId: 'op', profileId: profile.id })).rejects.toThrow('read-only');
});

it('reports the worker\'s roles, calls and profiles', async () => {
  const f = supportFixture(); const profile = f.profile(); const tests = f.profile({ ...review, name: 'Linux tests' }); f.enable('worker', [profile.id, tests.id]);
  const first = await f.call({ operationId: 'op-1', profileId: profile.id });
  const second = await f.call({ operationId: 'op-2', profileId: tests.id });
  expect(f.seats.filter(seat => seat.member.role === 'requester')).toHaveLength(2);
  const status = await f.broker.hostCall('mac', { action: 'support_status', worker: { providerId: 'codex', nativeSessionId: 'worker' } }) as any;
  expect(status).toMatchObject({ enabled: true, profiles: [{ id: profile.id, name: 'Cross review' }, { id: tests.id, name: 'Linux tests' }] });
  expect(status.roles.map((role: any) => role.roleId).sort()).toEqual([first.roleId, second.roleId].sort());
  expect(status.roles[0]).toMatchObject({ status: 'active', requesterMemberId: expect.any(String), calls: [{ status: 'open', task: 'Review the change.' }] });
  expect(await f.broker.hostCall('mac', { action: 'support_status', worker: { providerId: 'codex', nativeSessionId: 'worker' }, callId: first.callId }))
    .toMatchObject({ roleId: first.roleId, call: { id: first.callId, status: 'open' } });
  expect(await f.broker.hostCall('mac', { action: 'support_status', worker: { providerId: 'codex', nativeSessionId: 'other' } })).toMatchObject({ enabled: false, roles: [] });
});

it('creates groups and calls from the website', async () => {
  const f = supportFixture(); const profile = f.profile();
  const team: Team = await f.broker.create({ operationId: 'website', source: { hostId: 'mac', providerId: 'codex', nativeSessionId: 'worker', title: 'Worker' },
    callForSupport: { profileId: profile.id, call: { task: 'Review.', deliverable: 'findings' } } });
  expect(team.callForSupport!.calls).toEqual([expect.objectContaining({ origin: 'user', status: 'open' })]);
  const updated = await f.broker.action({ teamId: team.id, action: 'call_for_support', operationId: 'again', task: 'Again.', deliverable: 'answer', followUpOf: team.callForSupport!.calls[0]!.id });
  expect(updated.callForSupport!.calls.map(call => [call.origin, call.status])).toEqual([['user', 'open'], ['user', 'queued']]);
  await expect(f.broker.action({ teamId: team.id, action: 'call_for_support', operationId: 'bad', task: 'X.', deliverable: 'answer', followUpOf: 'missing' })).rejects.toThrow('unknown');
});

it('keeps the worker and the coordinator to calls and reports', async () => {
  const f = supportFixture(); const profile = f.profile(); f.enable('worker', [profile.id]);
  const { roleId } = await f.call({ operationId: 'op', profileId: profile.id });
  const team = f.team(roleId), coordinator = team.members[0]!, worker = team.members[1]!;
  await expect(f.broker.hostCall('mac', { action: 'send', teamId: roleId, memberId: coordinator.id, to: worker.id, operationId: 'x', text: 'Done.' })).rejects.toThrow('report_support');
  await expect(f.broker.hostCall('mac', { action: 'send', teamId: roleId, memberId: worker.id, to: coordinator.id, operationId: 'x', text: 'Hi.' })).rejects.toThrow('call_for_support');
});

it('tells a Host which of its sessions may call for support', async () => {
  const f = supportFixture(); const profile = f.profile();
  expect(await f.broker.hostCall('mac', { action: 'support_enablement' })).toEqual({ defaultEnabled: false, sessions: [] });
  f.enable('worker', [profile.id]); f.enable('other', []); f.enable('remote', [profile.id], 'linux');
  f.profile({ ...review, name: 'Default', enableByDefault: true });
  expect(await f.broker.hostCall('mac', { action: 'support_enablement' })).toEqual({ defaultEnabled: true,
    sessions: [{ providerId: 'codex', nativeSessionId: 'worker', enabled: true }, { providerId: 'codex', nativeSessionId: 'other', enabled: false }] });
  await expect(f.broker.hostCall('win', { action: 'support_enablement' })).rejects.toThrow('Update the Controller');
});

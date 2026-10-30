import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { CALL_FOR_SUPPORT_IDLE_ARCHIVE_MS, CALL_FOR_SUPPORT_RECENT_MS, CALL_FOR_SUPPORT_TEAM_LIMIT } from './call-for-support.js';
import { supportFixture } from './test-utils/call-for-support-fixture.js';

/** Uploads and pins one resource as a group's worker seat, as a report attachment would be. */
async function pinnedResource(f: ReturnType<typeof supportFixture>, teamId: string) {
  const seat = { teamId, memberId: f.team(teamId).members[1]!.id, operationId: `upload-${teamId}` }, bytes = Buffer.from('patch');
  await f.broker.hostCall('mac', { ...seat, action: 'resource_begin', name: 'fix.patch', mediaType: 'text/x-diff', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } as TeamHostCall);
  await f.broker.hostCall('mac', { ...seat, action: 'resource_chunk', offset: 0, contentBase64: bytes.toString('base64') } as TeamHostCall);
  const { resource } = await f.broker.hostCall('mac', { ...seat, action: 'resource_finish' } as TeamHostCall) as { resource: { resourceId: string } };
  await f.ports.resources!.pin(`team:${teamId}`, resource.resourceId);
  return resource.resourceId;
}

it('makes room at capacity by removing the oldest archived support group with its resources, never an ordinary Team', async () => {
  const f = supportFixture(); const profile = f.profile();
  const group = async (worker: string) => { f.enable(worker, [profile.id]); return (await f.call({ operationId: `call-${worker}`, profileId: profile.id, worker: f.worker(worker) })).roleId as string; };
  const older = await group('w1'), newer = await group('w2');
  const resourceId = await pinnedResource(f, older);
  const plain = await f.broker.create({ operationId: 'plain', source: { hostId: 'mac', providerId: 'codex', nativeSessionId: 'lead', title: 'Plain' } });
  await f.ports.change(teams => {
    for (const [id, updatedAt] of [[older, 1], [newer, 2], [plain.id, 0]] as const) Object.assign(teams.find(team => team.id === id)!, { status: 'archived', updatedAt });
    const template = teams.find(team => team.id === plain.id)!;
    while (teams.length < CALL_FOR_SUPPORT_TEAM_LIMIT) teams.push({ ...structuredClone(template), id: `filler-${teams.length}`, operationId: `filler-${teams.length}`, status: 'active' });
  });
  f.advance(CALL_FOR_SUPPORT_RECENT_MS);

  const next = await group('w3');
  expect(f.teams()).toHaveLength(CALL_FOR_SUPPORT_TEAM_LIMIT);
  expect(f.teams().some(team => team.id === older)).toBe(false);
  expect(f.teams().map(team => team.id)).toEqual(expect.arrayContaining([newer, plain.id, next]));
  await expect(f.ports.resources!.getMetadata(`team:${older}`, resourceId)).rejects.toThrow();

  // An ordinary Team makes room the same way while archived groups remain; then capacity is reached.
  await f.broker.create({ operationId: 'plain-2', source: { hostId: 'mac', providerId: 'codex', nativeSessionId: 'lead-2', title: 'Plain' } });
  expect(f.teams().some(team => team.id === newer)).toBe(false);
  await expect(f.broker.create({ operationId: 'plain-3', source: { hostId: 'mac', providerId: 'codex', nativeSessionId: 'lead-3', title: 'Plain' } })).rejects.toThrow('Team capacity reached.');
  expect(f.teams().some(team => team.id === plain.id)).toBe(true);
});

it('deletes files of Teams that no longer exist on the next removal, including those an interrupted removal left', async () => {
  const f = supportFixture(); const profile = f.profile();
  const group = async (worker: string) => { f.enable(worker, [profile.id]); return (await f.call({ operationId: `call-${worker}`, profileId: profile.id, worker: f.worker(worker) })).roleId as string; };
  const kept = await group('w1'), archived = await group('w2');
  const keptResource = await pinnedResource(f, kept), archivedResource = await pinnedResource(f, archived);
  // A Team removed by a change whose sweep never ran left its pinned files behind.
  const orphan = await group('w3'), orphanResource = await pinnedResource(f, orphan);
  await f.ports.change(teams => { teams.splice(teams.findIndex(team => team.id === orphan), 1); Object.assign(teams.find(team => team.id === archived)!, { status: 'archived', updatedAt: 1 }); });
  await f.ports.change(teams => { while (teams.length < CALL_FOR_SUPPORT_TEAM_LIMIT) teams.push({ ...structuredClone(teams.find(team => team.id === kept)!), id: `filler-${teams.length}`, operationId: `filler-${teams.length}` }); });
  f.advance(CALL_FOR_SUPPORT_RECENT_MS);
  await group('w4');
  await expect(f.ports.resources!.getMetadata(`team:${archived}`, archivedResource)).rejects.toThrow();
  await expect(f.ports.resources!.getMetadata(`team:${orphan}`, orphanResource)).rejects.toThrow();
  expect(await f.ports.resources!.getMetadata(`team:${kept}`, keptResource)).toMatchObject({ resourceId: keptResource });
});

it('tells a Host the status of groups it holds seats in', async () => {
  const f = supportFixture(); const profile = f.profile(); f.enable('worker', [profile.id]);
  const { roleId } = await f.call({ operationId: 'op', profileId: profile.id });
  const plain = await f.broker.create({ operationId: 'plain', source: { hostId: 'mac', providerId: 'codex', nativeSessionId: 'lead', title: 'Plain' } });
  const states = (hostId: string, teamIds: string[]) => f.broker.hostCall(hostId, { action: 'support_group_states', teamIds });
  expect(await states('mac', [roleId, 'gone', plain.id])).toEqual({ states: [{ teamId: roleId, status: 'active' }, { teamId: 'gone', status: 'missing' }, { teamId: plain.id, status: 'missing' }] });
  // A Host without a seat in the group learns nothing about it.
  expect(await states('linux', [roleId])).toEqual({ states: [{ teamId: roleId, status: 'missing' }] });
  await f.ports.change(teams => { teams.find(team => team.id === roleId)!.status = 'archived'; });
  expect(await states('mac', [roleId])).toEqual({ states: [{ teamId: roleId, status: 'archived' }] });
});

it('tells the coordinator to collect again when an unattached upload expired before its report', async () => {
  let clock = 0;
  const f = supportFixture({ resourceClock: { now: () => clock, ttlMs: 1000 } }); const profile = f.profile(); f.enable('worker', [profile.id]);
  const { roleId, callId } = await f.call({ operationId: 'op', profileId: profile.id });
  const coordinator = f.team(roleId).members[0]!, seat = { teamId: roleId, memberId: coordinator.id, operationId: 'patch' }, bytes = Buffer.from('patch');
  await f.broker.hostCall('mac', { ...seat, action: 'resource_begin', name: 'fix.patch', mediaType: 'text/x-diff', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } as TeamHostCall);
  await f.broker.hostCall('mac', { ...seat, action: 'resource_chunk', offset: 0, contentBase64: bytes.toString('base64') } as TeamHostCall);
  const { resource } = await f.broker.hostCall('mac', { ...seat, action: 'resource_finish' } as TeamHostCall) as { resource: { resourceId: string } };
  clock = 2000;
  await expect(f.broker.hostCall('mac', { action: 'report_support', teamId: roleId, memberId: coordinator.id, callId, operationId: 'report',
    report: { status: 'reported', summary: 'A fix.', findings: [], resources: [resource.resourceId] } })).rejects.toThrow('no longer stored; collect or upload it again');
});

/** Reports a group's open call, as its coordinator would, so the group is idle. */
async function reportOpenCall(f: ReturnType<typeof supportFixture>, teamId: string) {
  const team = f.team(teamId), call = team.callForSupport!.calls.find(item => item.status === 'open')!;
  await f.broker.hostCall('mac', { action: 'report_support', teamId, memberId: team.members[0]!.id, callId: call.id, operationId: `report-${teamId}`,
    report: { status: 'reported', summary: 'Done.', findings: [] } });
}

it('archives a group a week after its last call, while a group with a waiting call stays active', async () => {
  const f = supportFixture(); const profile = f.profile();
  const group = async (worker: string) => { f.enable(worker, [profile.id]); return (await f.call({ operationId: `call-${worker}`, profileId: profile.id, worker: f.worker(worker) })).roleId as string; };
  const idle = await group('w1'), waiting = await group('w2');
  await reportOpenCall(f, idle);
  f.advance(CALL_FOR_SUPPORT_IDLE_ARCHIVE_MS);
  await group('w3');
  expect([f.team(idle).status, f.team(waiting).status]).toEqual(['archiving', 'active']);
  // The worker's next call for the profile starts a new group instead of failing on the archiving one.
  const again = await f.call({ operationId: 'call-w1-again', profileId: profile.id, worker: f.worker('w1') });
  expect(again).toMatchObject({ status: 'accepted' });
  expect(again.roleId).not.toBe(idle);
});

it('makes room by removing the least recently used idle group, never one used within the last hour', async () => {
  const f = supportFixture(); const profile = f.profile();
  const group = async (worker: string) => { f.enable(worker, [profile.id]); return (await f.call({ operationId: `call-${worker}`, profileId: profile.id, worker: f.worker(worker) })).roleId as string; };
  const older = await group('w1'), newer = await group('w2'), waiting = await group('w3');
  await reportOpenCall(f, older); await reportOpenCall(f, newer);
  await f.ports.change(teams => {
    const template = teams.find(team => !team.callForSupport) ?? teams.find(team => team.id === waiting)!;
    while (teams.length < CALL_FOR_SUPPORT_TEAM_LIMIT) teams.push({ ...structuredClone(template), id: `filler-${teams.length}`, operationId: `filler-${teams.length}` });
  });
  // Fillers copy the waiting group, whose call is open, so only the two idle groups can make room.
  await expect(group('w4')).rejects.toThrow('Team capacity reached.');
  f.advance(CALL_FOR_SUPPORT_RECENT_MS);
  const added = await group('w4');
  expect(f.teams().some(team => team.id === older)).toBe(false);
  expect(f.teams().map(team => team.id)).toEqual(expect.arrayContaining([newer, waiting, added]));
});

const archive = (f: ReturnType<typeof supportFixture>, teamId: string) => f.ports.change(teams => { teams.find(team => team.id === teamId)!.status = 'archived'; });

it('restores an archived group: its seats rebind, supporters stay released, a waiting roster is rejected and the open call is sent again', async () => {
  const f = supportFixture(); const profile = f.profile(); f.enable('worker', [profile.id]);
  const { roleId, callId } = await f.call({ operationId: 'op', profileId: profile.id });
  const coordinator = f.team(roleId).members[0]!;
  await f.broker.hostCall('mac', { action: 'propose_roster', teamId: roleId, memberId: coordinator.id, operationId: 'r1', rationale: 'Review.',
    members: [{ name: 'Reviewer', responsibility: 'Review.', providerId: 'claude', model: 'opus', workspace: 'shared' }] } as TeamHostCall);
  expect(f.team(roleId).callForSupport!.roster!.status).toBe('pending');
  await f.broker.action({ teamId: roleId, action: 'resolve_roster', rosterId: f.team(roleId).callForSupport!.roster!.id, decision: 'approve' });
  await f.broker.hostCall('mac', { action: 'propose_roster', teamId: roleId, memberId: coordinator.id, operationId: 'r2', rationale: 'Another.',
    members: [{ name: 'Second', responsibility: 'Review.', providerId: 'claude', model: 'opus', workspace: 'shared' }] } as TeamHostCall);
  // One supporter is working and a second roster waits for the user.
  expect(f.team(roleId).members.find(member => member.role === 'member')!.creation).toBe('ready');
  expect(f.team(roleId).callForSupport!.roster!.status).toBe('pending');
  await f.broker.action({ teamId: roleId, action: 'archive' });
  await archive(f, roleId);
  const seats = f.seats.length;

  const restored = await f.broker.action({ teamId: roleId, action: 'restore' });
  expect(restored.status).toBe('active');
  const team = f.team(roleId);
  expect(team.members.map(member => [member.role, member.creation])).toEqual([['leader', 'ready'], ['requester', 'ready'], ['member', 'released']]);
  expect(team.members[0]!.nativeSessionId).toBe(coordinator.nativeSessionId);
  // The worker's seat binds first, then the coordinator's, which names its own session to resume.
  expect(f.seats.slice(seats).map(seat => [seat.member.role, seat.member.nativeSessionId])).toEqual([['requester', 'worker'], ['leader', coordinator.nativeSessionId]]);
  expect(team.callForSupport!.roster).toMatchObject({ status: 'rejected', note: 'The group was archived.' });
  expect(team.callForSupport!.restoredAt).toEqual(expect.any(Number));
  expect(team.messages.filter(message => message.to === coordinator.id && message.callForSupportCallId === callId && message.status === 'queued')).toHaveLength(1);
});

it('refuses to restore a group while the worker has another active role for the profile', async () => {
  const f = supportFixture(); const profile = f.profile(); f.enable('worker', [profile.id]);
  const first = await f.call({ operationId: 'op-1', profileId: profile.id });
  await archive(f, first.roleId);
  const second = await f.call({ operationId: 'op-2', profileId: profile.id, fresh: true });
  expect(second.roleId).not.toBe(first.roleId);
  await expect(f.broker.action({ teamId: first.roleId, action: 'restore' })).rejects.toThrow('another active role for this profile');
  await archive(f, second.roleId);
  expect((await f.broker.action({ teamId: first.roleId, action: 'restore' })).status).toBe('active');
});

it('counts a restore as use, so a long idle group is not archived again at once', async () => {
  const f = supportFixture(); const profile = f.profile(); f.enable('worker', [profile.id]);
  const { roleId } = await f.call({ operationId: 'op', profileId: profile.id });
  await reportOpenCall(f, roleId);
  f.advance(2 * CALL_FOR_SUPPORT_IDLE_ARCHIVE_MS);
  await archive(f, roleId);
  await f.broker.action({ teamId: roleId, action: 'restore' });
  f.enable('other', [profile.id]);
  await f.call({ operationId: 'other', profileId: profile.id, worker: f.worker('other') });
  expect(f.team(roleId).status).toBe('active');
});

it('reopens the worker\'s most recently used archived group on its next call for the profile, unless the call is fresh', async () => {
  const f = supportFixture(); const profile = f.profile(); f.enable('worker', [profile.id]);
  const first = await f.call({ operationId: 'op-1', profileId: profile.id });
  await reportOpenCall(f, first.roleId);
  await archive(f, first.roleId);
  const coordinator = f.team(first.roleId).members[0]!, seats = f.seats.length;
  f.advance(1000);

  const again = await f.call({ operationId: 'op-2', profileId: profile.id, task: 'Look again.' });
  expect(again).toMatchObject({ status: 'accepted', roleId: first.roleId });
  const team = f.team(first.roleId);
  expect(team.status).toBe('active');
  expect(team.members.map(member => member.creation)).toEqual(['ready', 'ready']);
  expect(team.members[0]!.nativeSessionId).toBe(coordinator.nativeSessionId);
  expect(f.seats.slice(seats).map(seat => seat.member.role)).toEqual(['requester', 'leader']);
  expect(team.callForSupport!.calls.map(call => [call.task, call.status])).toEqual([['Review the change.', 'reported'], ['Look again.', 'open']]);

  // Fresh archives the active group and starts another instead of reopening an archived one.
  f.advance(1000);
  const fresh = await f.call({ operationId: 'op-3', profileId: profile.id, fresh: true });
  expect(fresh.roleId).not.toBe(first.roleId);
  await archive(f, first.roleId); await archive(f, fresh.roleId);
  f.advance(1000);
  expect(await f.call({ operationId: 'op-4', profileId: profile.id })).toMatchObject({ status: 'accepted', roleId: fresh.roleId });
  expect(f.team(first.roleId).status).toBe('archived');
  expect(f.teams()).toHaveLength(2);
});

it('starts a new group rather than reopen an archived group paused at its budget, which says so when called by its roleId', async () => {
  const f = supportFixture(); const profile = f.profile(); f.enable('worker', [profile.id]);
  const { roleId } = await f.call({ operationId: 'op-1', profileId: profile.id });
  await f.ports.change(teams => { const team = teams.find(item => item.id === roleId)!; team.status = 'archived'; Object.assign(team.callForSupport!, { status: 'paused_budget', pauseReason: 'The budget is reached.' }); });
  const next = await f.call({ operationId: 'op-2', profileId: profile.id });
  expect(next).toMatchObject({ status: 'accepted' });
  expect(next.roleId).not.toBe(roleId);
  expect(f.team(roleId).status).toBe('archived');
  await archive(f, next.roleId);
  expect(await f.call({ operationId: 'op-3', roleId })).toMatchObject({ status: 'unavailable', message: expect.stringContaining('paused: The budget is reached.') });
  expect(f.team(roleId).status).toBe('archived');
});

it('reopens an archived role called by its roleId, except while it is being archived or another role for its profile is active', async () => {
  const f = supportFixture(); const profile = f.profile(); f.enable('worker', [profile.id]);
  const first = await f.call({ operationId: 'op-1', profileId: profile.id });
  await f.ports.change(teams => { teams.find(team => team.id === first.roleId)!.status = 'archiving'; });
  expect(await f.call({ operationId: 'op-2', roleId: first.roleId })).toMatchObject({ status: 'unavailable', message: expect.stringContaining('being archived') });
  await archive(f, first.roleId);
  // The worker sees its archived roles, and can still read their calls.
  const status = await f.broker.hostCall('mac', { action: 'support_status', worker: { providerId: 'codex', nativeSessionId: 'worker' } }) as { roles: unknown[] };
  expect(status.roles).toEqual([expect.objectContaining({ roleId: first.roleId, status: 'archived' })]);
  expect(await f.broker.hostCall('mac', { action: 'support_status', worker: { providerId: 'codex', nativeSessionId: 'worker' }, callId: first.callId })).toMatchObject({ roleId: first.roleId });

  const second = await f.call({ operationId: 'op-3', profileId: profile.id, fresh: true });
  expect(await f.call({ operationId: 'op-4', roleId: first.roleId })).toMatchObject({ status: 'unavailable', message: expect.stringContaining(`roleId ${second.roleId}`) });
  await archive(f, second.roleId);
  expect(await f.call({ operationId: 'op-5', roleId: first.roleId, task: 'Follow up.' })).toMatchObject({ status: 'accepted', roleId: first.roleId });
  expect(f.team(first.roleId).status).toBe('active');
  expect(f.team(first.roleId).members.map(member => member.creation)).toEqual(['ready', 'ready']);
});

it('reopens an archived group for the user\'s call on it', async () => {
  const f = supportFixture(); const profile = f.profile(); f.enable('worker', [profile.id]);
  const { roleId, callId } = await f.call({ operationId: 'op', profileId: profile.id });
  await f.broker.action({ teamId: roleId, action: 'archive' });
  await archive(f, roleId);
  const team = await f.broker.action({ teamId: roleId, action: 'call_for_support', operationId: 'user', task: 'Check the tests.', deliverable: 'answer' });
  expect(team.status).toBe('active');
  expect(team.members.map(member => member.creation)).toEqual(['ready', 'ready']);
  // The call left open by the archive is sent again; the user's call waits behind it.
  expect(team.callForSupport!.calls.map(call => [call.origin, call.status])).toEqual([['worker', 'open'], ['user', 'queued']]);
  expect(team.messages.filter(message => message.callForSupportCallId === callId && message.status === 'queued')).toHaveLength(1);
});

it('deletes an archived support group for good, so the worker\'s next call starts a new group', async () => {
  const f = supportFixture(); const profile = f.profile(); f.enable('worker', [profile.id]);
  const { roleId } = await f.call({ operationId: 'op-1', profileId: profile.id });
  const resourceId = await pinnedResource(f, roleId);
  await expect(f.broker.delete(roleId)).rejects.toThrow('Archive the support group before deleting it.');
  const plain = await f.broker.create({ operationId: 'plain', source: { hostId: 'mac', providerId: 'codex', nativeSessionId: 'lead', title: 'Plain' } });
  await archive(f, plain.id);
  await expect(f.broker.delete(plain.id)).rejects.toThrow('Only support groups can be deleted.');

  await archive(f, roleId);
  await f.broker.delete(roleId);
  expect(f.teams().map(team => team.id)).toEqual([plain.id]);
  await expect(f.ports.resources!.getMetadata(`team:${roleId}`, resourceId)).rejects.toThrow();
  // Its Controllers find it missing and forget its seats.
  expect(await f.broker.hostCall('mac', { action: 'support_group_states', teamIds: [roleId] })).toEqual({ states: [{ teamId: roleId, status: 'missing' }] });
  const next = await f.call({ operationId: 'op-2', profileId: profile.id });
  expect(next).toMatchObject({ status: 'accepted' });
  expect(next.roleId).not.toBe(roleId);
});

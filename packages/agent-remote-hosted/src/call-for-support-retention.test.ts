import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { CALL_FOR_SUPPORT_TEAM_LIMIT } from './call-for-support.js';
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
  await group('w4');
  await expect(f.ports.resources!.getMetadata(`team:${archived}`, archivedResource)).rejects.toThrow();
  await expect(f.ports.resources!.getMetadata(`team:${orphan}`, orphanResource)).rejects.toThrow();
  expect(await f.ports.resources!.getMetadata(`team:${kept}`, keptResource)).toMatchObject({ resourceId: keptResource });
});

it('tells a Host the status of groups it holds seats in, and never restores an archived group', async () => {
  const f = supportFixture(); const profile = f.profile(); f.enable('worker', [profile.id]);
  const { roleId } = await f.call({ operationId: 'op', profileId: profile.id });
  const plain = await f.broker.create({ operationId: 'plain', source: { hostId: 'mac', providerId: 'codex', nativeSessionId: 'lead', title: 'Plain' } });
  const states = (hostId: string, teamIds: string[]) => f.broker.hostCall(hostId, { action: 'support_group_states', teamIds });
  expect(await states('mac', [roleId, 'gone', plain.id])).toEqual({ states: [{ teamId: roleId, status: 'active' }, { teamId: 'gone', status: 'missing' }, { teamId: plain.id, status: 'missing' }] });
  // A Host without a seat in the group learns nothing about it.
  expect(await states('linux', [roleId])).toEqual({ states: [{ teamId: roleId, status: 'missing' }] });
  await f.ports.change(teams => { teams.find(team => team.id === roleId)!.status = 'archived'; });
  expect(await states('mac', [roleId])).toEqual({ states: [{ teamId: roleId, status: 'archived' }] });
  await expect(f.broker.action({ teamId: roleId, action: 'restore' })).rejects.toThrow('cannot be restored');
});

import { expect, it } from 'vitest';
import type { CallForSupportMandate, CallForSupportRosterMember, TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { review, supportFixture } from './test-utils/call-for-support-fixture.js';

const opus: CallForSupportRosterMember = { name: 'Opus reviewer', responsibility: 'Review for correctness.', providerId: 'claude', model: 'opus', workspace: 'shared' };
async function group(mandate: Partial<CallForSupportMandate> = {}, options: Parameters<typeof supportFixture>[0] = {}, context: { commit?: string } = { commit: 'abcdef1' }) {
  const f = supportFixture(options);
  const profile = f.profile({ ...review, mandate: { ...review.mandate, ...mandate } }); f.enable('worker', [profile.id]);
  const { roleId } = await f.call({ operationId: 'op', profileId: profile.id, context });
  const coordinator = f.team(roleId).members[0]!;
  const propose = (operationId: string, members: CallForSupportRosterMember[], release?: string[]) => f.broker.hostCall('mac', { action: 'propose_roster', teamId: roleId, memberId: coordinator.id,
    operationId, members, ...(release ? { release } : {}), rationale: 'Independent review.' } as TeamHostCall) as Promise<any>;
  return { ...f, roleId, coordinator, propose, supporters: () => f.team(roleId).members.filter(member => member.role === 'member') };
}

it('waits for the user on every roster, then provisions read-only reviewers in the worker\'s directory', async () => {
  const g = await group();
  expect(await g.propose('r1', [opus])).toMatchObject({ status: 'pending', withinMandate: true });
  expect(g.supporters()).toEqual([]);
  const rosterId = g.team(g.roleId).callForSupport!.roster!.id;
  await g.broker.action({ teamId: g.roleId, action: 'resolve_roster', rosterId, decision: 'approve' });
  expect(g.supporters()).toEqual([expect.objectContaining({ providerId: 'claude', model: 'opus', access: 'read_only', workspace: { kind: 'shared' }, cwd: '/repo', hostId: 'mac', creation: 'ready' })]);
  expect(g.team(g.roleId).callForSupport!.roster).toMatchObject({ status: 'provisioned', decidedAt: expect.any(Number) });
  expect(g.team(g.roleId).messages.some(message => message.text.startsWith('Team member registered: Opus reviewer'))).toBe(true);
  expect(await g.propose('r1', [opus])).toMatchObject({ status: 'provisioned' });
});

it('provisions rosters within the mandate at once and leaves the others to the user', async () => {
  const g = await group({ approval: 'within_mandate', maxSupporters: 1 });
  expect(await g.propose('r1', [opus])).toMatchObject({ status: 'provisioned', withinMandate: true });
  expect(g.supporters()).toHaveLength(1);
  expect(await g.propose('r2', [{ ...opus, name: 'Second' }])).toMatchObject({ status: 'pending', withinMandate: false });
  expect(await g.propose('r3', [{ ...opus, model: 'sonnet' }], [g.supporters()[0]!.id])).toMatchObject({ status: 'pending', withinMandate: false });
  // Releasing first keeps the count within the mandate.
  expect(await g.propose('r4', [{ ...opus, name: 'Replacement' }], [g.supporters()[0]!.id])).toMatchObject({ status: 'provisioned', withinMandate: true });
  expect(g.supporters().map(member => [member.name, member.creation])).toEqual([['Opus reviewer', 'released'], ['Replacement', 'ready']]);
});

it('refuses rosters that no approval can make work', async () => {
  const g = await group({ workspaces: ['shared', 'worktree', 'remote'], remoteHosts: [{ hostId: 'linux', workspace: '/srv/repo' }] }, { readOnly: (_host, provider) => provider !== 'opencode' }, {});
  await expect(g.propose('a', [{ ...opus, providerId: 'opencode' }])).rejects.toThrow('read-only');
  await expect(g.propose('b', [{ ...opus, workspace: 'worktree' }])).rejects.toThrow('commit');
  await expect(g.propose('c', [{ ...opus, workspace: 'remote', hostId: 'mac' }])).rejects.toThrow('mandate');
  await expect(g.propose('d', [opus], ['nobody'])).rejects.toThrow('not an active supporter');
  await expect(g.propose('e', [{ ...opus, workspace: 'remote', hostId: 'win' }])).rejects.toThrow('Update the Controller');
  await expect(g.broker.hostCall('mac', { action: 'propose_roster', teamId: g.roleId, memberId: g.team(g.roleId).members[1]!.id, operationId: 'x', members: [opus], rationale: '' })).rejects.toThrow('coordinator');
});

it('creates worktree and remote supporters at the call\'s commit', async () => {
  const g = await group({ approval: 'within_mandate', maxSupporters: 2, workspaces: ['worktree', 'remote'], remoteHosts: [{ hostId: 'linux', workspace: '/srv/repo' }],
    supporters: [{ providerId: 'codex', model: 'gpt-5.5' }] });
  const codex = { ...opus, providerId: 'codex', model: 'gpt-5.5' };
  expect(await g.propose('r1', [{ ...codex, name: 'Fixer', workspace: 'worktree' }, { ...codex, name: 'Linux tester', workspace: 'remote', hostId: 'linux' }])).toMatchObject({ status: 'provisioned' });
  const [fixer, tester] = g.supporters();
  expect(fixer).toMatchObject({ hostId: 'mac', cwd: '/repo', workspace: { kind: 'worktree', commit: 'abcdef1' } });
  expect(fixer).not.toHaveProperty('access');
  expect(tester).toMatchObject({ hostId: 'linux', cwd: '/srv/repo', workspace: { kind: 'remote', commit: 'abcdef1', repository: '/srv/repo' } });
});

it('replaces a pending roster, tells the coordinator about a rejection and releases supporters', async () => {
  const g = await group();
  await g.propose('r1', [opus]);
  await g.propose('r2', [{ ...opus, name: 'Other' }]);
  const roster = g.team(g.roleId).callForSupport!.roster!;
  expect(roster.members[0]!.name).toBe('Other');
  await g.broker.action({ teamId: g.roleId, action: 'resolve_roster', rosterId: roster.id, decision: 'reject', note: 'Use one reviewer only.' });
  expect(g.team(g.roleId).callForSupport!.roster).toMatchObject({ status: 'rejected', note: 'Use one reviewer only.' });
  const note = g.team(g.roleId).messages.find(message => message.text.startsWith('[Call For Support] The user rejected'))!;
  expect(note).toMatchObject({ to: g.coordinator.id, status: 'queued' });
  expect(note.text).toContain('Use one reviewer only.');
  await expect(g.broker.action({ teamId: g.roleId, action: 'resolve_roster', rosterId: roster.id, decision: 'approve' })).rejects.toThrow('already decided');

  await g.propose('r3', [opus]);
  await g.broker.action({ teamId: g.roleId, action: 'resolve_roster', rosterId: g.team(g.roleId).callForSupport!.roster!.id, decision: 'approve' });
  const supporter = g.supporters()[0]!;
  await g.broker.hostCall('mac', { action: 'send', teamId: g.roleId, memberId: g.coordinator.id, to: supporter.id, operationId: 'brief', text: 'Review abcdef1.' });
  await g.broker.hostCall('mac', { action: 'release_supporter', teamId: g.roleId, memberId: g.coordinator.id, target: supporter.id });
  expect(g.team(g.roleId).members.find(member => member.id === supporter.id)!.creation).toBe('released');
  expect(g.team(g.roleId).messages.some(message => message.to === supporter.id && message.status === 'queued')).toBe(false);
  await expect(g.broker.action({ teamId: g.roleId, action: 'release_member', memberId: g.team(g.roleId).members[1]!.id })).rejects.toThrow('Only supporters');
});

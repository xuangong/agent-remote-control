import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { reviewProfile, supportHarness } from './test-utils/call-for-support-harness.js';

it('binds the worker without creating a session and creates a read-only coordinator with the profile\'s configuration', async () => {
  const h = await supportHarness();
  try {
    const profile = h.profile(); h.enable([profile.id]);
    const { roleId, status } = await h.call({ operationId: 'op-1', profileId: profile.id });
    expect(status).toBe('accepted');
    const team = h.team(roleId), coordinator = team.members[0]!, worker = team.members[1]!;
    expect(worker).toMatchObject({ role: 'requester', creation: 'ready', nativeSessionId: 'worker', cwd: h.directory });
    expect(h.created).toEqual([expect.objectContaining({ provider: 'codex', creation: { cwd: h.directory, model: 'gpt-5.5', reasoningEffort: 'high' }, extensions: expect.objectContaining({ access: 'read_only' }) })]);
    expect(coordinator).toMatchObject({ creation: 'ready', nativeSessionId: h.created[0]!.id });
    expect(await h.runtime.extensions(h.ref('codex', 'worker'))).toBeUndefined();
    expect(await h.runtime.genericSuccession(h.ref('codex', 'worker'), 'opencode')).toBeUndefined();
    expect(await h.runtime.extensions(h.ref('codex', coordinator.nativeSessionId!))).toMatchObject({ access: 'read_only' });
  } finally { await h.close(); }
});

it('delivers calls to the coordinator and reports to the worker as framed, waiting for the worker\'s next turn while it works', async () => {
  const h = await supportHarness();
  try {
    const profile = h.profile(); h.enable([profile.id]);
    const first = await h.call({ operationId: 'op-1', profileId: profile.id });
    const coordinator = h.team(first.roleId).members[0]!;
    await h.runtime.tick();
    const brief = h.sessions.get(coordinator.nativeSessionId!)!.deliveries;
    expect(brief).toHaveLength(1);
    expect(brief[0]!.text).toMatch(/^\[Team .*; from Worker\]\n\[Support call /);

    const second = await h.call({ operationId: 'op-2', roleId: first.roleId, task: 'Then the tests.' });
    h.busy('worker', true);
    await h.host({ action: 'report_support', teamId: first.roleId, memberId: coordinator.id, callId: first.callId, operationId: 'r1', report: { status: 'reported', summary: 'Looks right.', findings: [] } });
    await h.runtime.tick();
    const worker = h.sessions.get('worker')!.deliveries;
    expect(worker).toHaveLength(1);
    expect(worker[0]!.delivery).toBe('next_turn');
    expect(worker[0]!.text.startsWith(`[Support report · Cross review · call ${first.callId} · reported]`)).toBe(true);
    expect(worker[0]!.text).not.toContain('[Team');

    h.busy('worker', false);
    await h.host({ action: 'report_support', teamId: first.roleId, memberId: coordinator.id, callId: second.callId, operationId: 'r2', report: { status: 'reported', summary: 'Tests pass.', findings: [] } });
    await h.runtime.tick();
    expect(worker.at(-1)).toMatchObject({ delivery: 'immediate', text: expect.stringContaining('Tests pass.') });
  } finally { await h.close(); }
});

it('refuses group seats until the Relay acknowledged Call For Support', async () => {
  const h = await supportHarness({ callForSupport: false });
  try {
    const profile = h.profile(); h.enable([profile.id]);
    const { roleId } = await h.call({ operationId: 'op-1', profileId: profile.id });
    expect(h.team(roleId).members[1]).toMatchObject({ role: 'requester', creation: 'unknown', error: 'Update the Relay to use Call For Support.' });
    expect(h.created).toEqual([]);
  } finally { await h.close(); }
});

const run = async (extensions: { tools?: readonly { name: string; execute(args: unknown): Promise<string> }[] } | undefined, name: string, args: unknown = {}) =>
  JSON.parse(await extensions!.tools!.find(tool => tool.name === name)!.execute(args));

it('gives the coordinator coordination tools and the group state, and supporters only their brief', async () => {
  const h = await supportHarness();
  try {
    const profile = h.profile(); h.enable([profile.id]);
    const { roleId, callId } = await h.call({ operationId: 'op-1', profileId: profile.id });
    const coordinatorRef = h.ref('codex', h.team(roleId).members[0]!.nativeSessionId!);
    const coordinator = await h.runtime.extensions(coordinatorRef);
    expect(coordinator!.tools!.map(tool => tool.name).sort()).toEqual(['acknowledge_team_messages', 'download_team_resource', 'propose_roster', 'read_source_session', 'read_team',
      'release_supporter', 'report_support', 'report_team_progress', 'send_team_message', 'upload_team_resource', 'write_ledger']);
    expect(coordinator!.instructions).toContain('You coordinate Call For Support for the role "Cross review"');
    expect(coordinator!.instructions).toContain('Never edit the worker\'s workspace');
    expect((await run(coordinator, 'read_team')).callForSupport).toMatchObject({ role: 'Cross review', calls: [{ id: callId, status: 'open' }] });
    expect(await run(coordinator, 'write_ledger', { revision: 0, text: 'Reviewing abcdef1.' })).toEqual({ revision: 1 });

    expect(await run(coordinator, 'propose_roster', { operationId: 'roster', rationale: 'An independent model.',
      members: [{ name: 'Opus reviewer', responsibility: 'Review for correctness.', providerId: 'claude', model: 'opus', workspace: 'shared' }] })).toMatchObject({ status: 'provisioned' });
    const created = h.created.at(-1)!;
    expect(created).toMatchObject({ provider: 'claude', creation: { cwd: h.directory, model: 'opus' }, extensions: { access: 'read_only' } });
    expect(created.extensions.instructions).toContain('read-only for you');
    expect(created.extensions.tools!.map(tool => tool.name)).not.toContain('report_support');
    expect(await run(created.extensions, 'read_team')).not.toHaveProperty('callForSupport');

    expect(await run(coordinator, 'report_support', { callId, operationId: 'report', status: 'reported', summary: 'No blocking findings.', findings: [] })).toEqual({ callId, status: 'reported' });
    await h.runtime.tick();
    expect(h.sessions.get('worker')!.deliveries.at(-1)!.text).toContain('No blocking findings.');
  } finally { await h.close(); }
});

it('keeps read-only seats on providers that enforce read-only sessions', async () => {
  const h = await supportHarness();
  try {
    const profile = h.profile(); h.enable([profile.id]);
    const { roleId } = await h.call({ operationId: 'op-1', profileId: profile.id });
    const coordinator = h.ref('codex', h.team(roleId).members[0]!.nativeSessionId!);
    expect(await h.runtime.genericSuccession(coordinator, 'claude')).toEqual({ allowed: true });
    expect(await h.runtime.genericSuccession(coordinator, 'copilot')).toEqual({ allowed: false, reason: 'This provider cannot keep this session read-only.' });
  } finally { await h.close(); }
});

it('holds a member\'s runtime only while a delivery to it is pending or its Team is archiving', async () => {
  const h = await supportHarness();
  try {
    const profile = h.profile(); h.enable([profile.id]);
    const { roleId } = await h.call({ operationId: 'op-1', profileId: profile.id });
    const coordinator = h.team(roleId).members[0]!.nativeSessionId!;
    const leases = () => ({ acquired: h.acquired.filter(id => id === coordinator).length, released: h.released.filter(id => id === coordinator).length });
    const workerLeases = h.acquired.filter(id => id === 'worker').length;
    await h.runtime.tick();
    expect(h.sessions.get(coordinator)!.deliveries).toHaveLength(1);
    expect(leases()).toEqual({ acquired: 1, released: 0 });
    // Delivered; held until the coordinator reports idle, then released.
    await h.runtime.tick();
    expect(h.team(roleId).members[0]!.activity).toBe('idle');
    await h.runtime.tick();
    expect(leases()).toEqual({ acquired: 1, released: 1 });
    await h.runtime.tick();
    expect(leases()).toEqual({ acquired: 1, released: 1 });
    // The worker was leased once to learn its presence, and not again while nothing is addressed to it.
    expect(h.acquired.filter(id => id === 'worker')).toHaveLength(workerLeases + 1);

    await h.broker.action({ teamId: roleId, action: 'archive' });
    await h.runtime.tick();
    expect(h.team(roleId).status).toBe('archived');
  } finally { await h.close(); }
});

it('creates a worktree supporter at the call\'s commit and removes its worktree when it is released', async () => {
  const h = await supportHarness();
  try {
    const profile = h.profile({ ...reviewProfile, mandate: { ...reviewProfile.mandate, supporters: [{ providerId: 'codex', model: 'gpt-5.5' }], workspaces: ['worktree'] } }); h.enable([profile.id]);
    const { roleId } = await h.call({ operationId: 'op-1', profileId: profile.id });
    const coordinator = await h.runtime.extensions(h.ref('codex', h.team(roleId).members[0]!.nativeSessionId!));
    expect(await run(coordinator, 'propose_roster', { operationId: 'roster', rationale: 'A fix.',
      members: [{ name: 'Fixer', responsibility: 'Write the fix.', providerId: 'codex', model: 'gpt-5.5', workspace: 'worktree' }] })).toMatchObject({ status: 'provisioned' });
    const supporter = h.team(roleId).members[2]!, worktree = join(h.directory, '.agent-remote', 'worktrees', roleId, supporter.id);
    expect(supporter).toMatchObject({ creation: 'ready', cwd: worktree, workspace: { kind: 'worktree', commit: h.commit } });
    expect(h.created.at(-1)).toMatchObject({ creation: { cwd: worktree } });
    expect(h.created.at(-1)!.extensions).not.toHaveProperty('access');
    expect(h.git('-C', worktree, 'rev-parse', 'HEAD')).toBe(h.commit);
    expect(h.git('status', '--porcelain')).toBe('');
    await run(coordinator, 'release_supporter', { target: supporter.id });
    await h.runtime.tick();
    expect(existsSync(worktree)).toBe(false);
  } finally { await h.close(); }
});

it('starts a remote supporter in its repository from a bundle of the call\'s commit', async () => {
  const h = await supportHarness();
  const remote = await realpath(await mkdtemp(join(tmpdir(), 'cfs-remote-')));
  execFileSync('git', ['-C', remote, 'init', '-q']);
  try {
    const profile = h.profile({ ...reviewProfile, mandate: { ...reviewProfile.mandate, supporters: [{ providerId: 'codex', model: 'gpt-5.5' }], workspaces: ['remote'], remoteHosts: [{ hostId: 'host', workspace: remote }] } });
    h.enable([profile.id]);
    const { roleId } = await h.call({ operationId: 'op-1', profileId: profile.id });
    const coordinator = await h.runtime.extensions(h.ref('codex', h.team(roleId).members[0]!.nativeSessionId!));
    expect(await run(coordinator, 'propose_roster', { operationId: 'roster', rationale: 'Linux.',
      members: [{ name: 'Linux tester', responsibility: 'Run the tests.', providerId: 'codex', model: 'gpt-5.5', workspace: 'remote', hostId: 'host' }] })).toMatchObject({ status: 'provisioned' });
    const supporter = h.team(roleId).members[2]!, worktree = join(remote, '.agent-remote', 'worktrees', roleId, supporter.id);
    expect(supporter).toMatchObject({ creation: 'ready', cwd: worktree, workspace: { kind: 'remote', commit: h.commit, repository: remote } });
    expect(execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(h.commit);
    expect(h.git('for-each-ref', 'refs/agent-remote')).toBe('');
    await run(coordinator, 'release_supporter', { target: supporter.id });
    await h.runtime.tick();
    expect(existsSync(worktree)).toBe(false);
    expect(execFileSync('git', ['-C', remote, 'for-each-ref', 'refs/agent-remote'], { encoding: 'utf8' }).trim()).toBe('');
  } finally { await h.close(); await rm(remote, { recursive: true, force: true }); }
});

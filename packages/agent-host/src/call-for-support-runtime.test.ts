import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
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
    expect(coordinator!.tools!.map(tool => tool.name).sort()).toEqual(['acknowledge_team_messages', 'collect_supporter_patch', 'download_team_resource', 'propose_roster', 'read_source_session', 'read_team',
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

it('holds a support group member\'s runtime only while a delivery to it is pending or its Team is archiving', async () => {
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

it('lets the coordinator collect a worktree supporter\'s patch and give it to the worker', async () => {
  const h = await supportHarness();
  try {
    const profile = h.profile({ ...reviewProfile, mandate: { ...reviewProfile.mandate, supporters: [{ providerId: 'codex', model: 'gpt-5.5' }], workspaces: ['worktree'] } }); h.enable([profile.id]);
    const { roleId, callId } = await h.call({ operationId: 'op-1', profileId: profile.id, deliverable: 'patch' });
    const coordinator = await h.runtime.extensions(h.ref('codex', h.team(roleId).members[0]!.nativeSessionId!));
    await run(coordinator, 'propose_roster', { operationId: 'roster', rationale: 'A fix.', members: [{ name: 'Fixer', responsibility: 'Fix.', providerId: 'codex', model: 'gpt-5.5', workspace: 'worktree' }] });
    const supporter = h.team(roleId).members[2]!;
    expect(await run(coordinator, 'collect_supporter_patch', { target: supporter.id, operationId: 'empty' })).toMatchObject({ empty: true });
    await writeFile(join(supporter.cwd!, 'a.txt'), 'fixed\n');
    const collected = await run(coordinator, 'collect_supporter_patch', { target: supporter.id, operationId: 'patch' });
    expect(collected.resource).toMatchObject({ name: `${supporter.id}.patch` });
    const local = await run(coordinator, 'download_team_resource', { resourceId: collected.resource.resourceId });
    expect(await readFile(local.localPath, 'utf8')).toContain('+fixed');
    await run(coordinator, 'report_support', { callId, operationId: 'report', status: 'reported', summary: 'Patch attached.', findings: [], resources: [collected.resource.resourceId] });
    await expect(run(coordinator, 'collect_supporter_patch', { target: h.team(roleId).members[1]!.id, operationId: 'worker' })).rejects.toThrow('own worktree');
  } finally { await h.close(); }
});

it('accounts coordinator and supporter usage, pauses at the budget and continues after the user raises it', async () => {
  const h = await supportHarness();
  try {
    const profile = h.profile({ ...reviewProfile, mandate: { ...reviewProfile.mandate, budget: { tokensTotal: 1000 } } }); h.enable([profile.id]);
    const first = await h.call({ operationId: 'op-1', profileId: profile.id });
    const queued = await h.call({ operationId: 'op-2', roleId: first.roleId, task: 'Then the tests.' });
    const coordinator = h.team(first.roleId).members[0]!.nativeSessionId!;
    // The coordinator works on the call; its runtime stays held while it is busy.
    h.busy(coordinator, true);
    await h.runtime.tick();
    expect(h.sessions.get(coordinator)!.deliveries).toHaveLength(1);
    await h.runtime.tick();
    h.usage(coordinator, { tokenScope: 'session', totalTokens: 400 });
    await h.runtime.tick();
    expect(h.team(first.roleId).callForSupport!.usage).toEqual({ tokens: 400 });
    expect(h.team(first.roleId).members[0]!.usage).toMatchObject({ tokens: 400 });
    h.usage(coordinator, { tokenScope: 'session', totalTokens: 1100 }, true);
    await expect.poll(() => h.team(first.roleId).callForSupport!.status).toBe('paused_budget');
    await h.runtime.tick();
    expect(h.sessions.get('worker')!.deliveries.at(-1)!.text).toContain('Support paused');
    expect(h.team(first.roleId).callForSupport!.calls.find(call => call.id === queued.callId)!.status).toBe('queued');

    await h.broker.action({ teamId: first.roleId, action: 'update_mandate', mandate: { ...h.team(first.roleId).callForSupport!.mandate, budget: { tokensTotal: 5000 } } });
    await h.broker.action({ teamId: first.roleId, action: 'resume_group' });
    await h.runtime.tick();
    expect(h.sessions.get(coordinator)!.deliveries.at(-1)!.text).toContain(`[Support call ${queued.callId}`);
  } finally { await h.close(); }
});

it('keeps a member\'s runtime while its live session works, even when its reported presence lags', async () => {
  const h = await supportHarness();
  try {
    const profile = h.profile(); h.enable([profile.id]);
    const { roleId } = await h.call({ operationId: 'op-1', profileId: profile.id });
    const coordinator = h.team(roleId).members[0]!.nativeSessionId!;
    await h.runtime.tick();
    expect(h.team(roleId).members[0]!.activity).toBe('idle');
    // The delivered call started a turn after presence was reported.
    h.busy(coordinator, true);
    await h.runtime.tick();
    h.usage(coordinator, { tokenScope: 'runtime', totalTokens: 250, totalCostUsd: 0.25 }, true);
    await expect.poll(() => h.team(roleId).callForSupport!.usage).toEqual({ tokens: 250, costUsd: 0.25 });
    h.busy(coordinator, false);
    await h.runtime.tick(); await h.runtime.tick();
    expect(h.released.filter(id => id === coordinator)).toHaveLength(1);
  } finally { await h.close(); }
});

it('keeps an ordinary Team member held so the presence of a session the user drives stays current', async () => {
  const h = await supportHarness();
  try {
    const team = await h.broker.create({ operationId: 'plain', source: { hostId: 'host', providerId: 'codex', nativeSessionId: 'worker', title: 'Plain' } });
    const leader = team.members[0]!.nativeSessionId!;
    await h.runtime.tick(); await h.runtime.tick();
    expect(h.team(team.id).members[0]!.activity).toBe('idle');
    h.busy(leader, true);
    await h.runtime.tick();
    expect(h.team(team.id).members[0]!.activity).toBe('busy');
    expect(h.released.filter(id => id === leader)).toEqual([]);
  } finally { await h.close(); }
});

it('removes the worktree of a supporter whose creation failed, since that seat is never created again', async () => {
  const h = await supportHarness({ failCreate: creation => !!creation.cwd?.includes('.agent-remote') });
  try {
    const profile = h.profile({ ...reviewProfile, mandate: { ...reviewProfile.mandate, supporters: [{ providerId: 'codex', model: 'gpt-5.5' }], workspaces: ['worktree'] } }); h.enable([profile.id]);
    const { roleId } = await h.call({ operationId: 'op-1', profileId: profile.id });
    const coordinator = await h.runtime.extensions(h.ref('codex', h.team(roleId).members[0]!.nativeSessionId!));
    await run(coordinator, 'propose_roster', { operationId: 'roster', rationale: 'A fix.',
      members: [{ name: 'Fixer', responsibility: 'Write the fix.', providerId: 'codex', model: 'gpt-5.5', workspace: 'worktree' }] }).catch(() => undefined);
    const supporter = h.team(roleId).members[2]!;
    expect(supporter.creation).toBe('unknown');
    expect(existsSync(join(h.directory, '.agent-remote', 'worktrees', roleId, supporter.id))).toBe(false);
    expect(h.git('worktree', 'list')).not.toContain(supporter.id);
  } finally { await h.close(); }
});

it('forgets the seats of an archived support group, and keeps an archived ordinary Team\'s for a restore', async () => {
  const h = await supportHarness();
  try {
    const profile = h.profile(); h.enable([profile.id]);
    const { roleId } = await h.call({ operationId: 'op-1', profileId: profile.id });
    const coordinator = h.ref('codex', h.team(roleId).members[0]!.nativeSessionId!);
    const plain = await h.broker.create({ operationId: 'plain', source: { hostId: 'host', providerId: 'codex', nativeSessionId: 'worker', title: 'Plain' } });
    const leader = h.ref('codex', plain.members[0]!.nativeSessionId!);
    await h.runtime.tick();
    expect(await h.runtime.extensions(coordinator)).toBeDefined();
    for (const teamId of [roleId, plain.id]) await h.broker.action({ teamId, action: 'archive' });
    await h.runtime.tick(); await h.runtime.tick();
    expect([h.team(roleId).status, h.team(plain.id).status]).toEqual(['archived', 'archived']);
    expect(await h.runtime.extensions(coordinator)).toBeUndefined();
    expect(await h.runtime.extensions(leader)).toBeDefined();
  } finally { await h.close(); }
});

it('keeps an ended group\'s seat until its worktree is removed, and retries at the group\'s next check', async () => {
  const h = await supportHarness();
  const teamDirectory = () => join(h.directory, '.agent-remote', 'worktrees', roleId);
  let roleId = '';
  try {
    const profile = h.profile({ ...reviewProfile, mandate: { ...reviewProfile.mandate, supporters: [{ providerId: 'codex', model: 'gpt-5.5' }], workspaces: ['worktree'] } }); h.enable([profile.id]);
    roleId = (await h.call({ operationId: 'op-1', profileId: profile.id })).roleId;
    const coordinator = h.ref('codex', h.team(roleId).members[0]!.nativeSessionId!);
    await run(await h.runtime.extensions(coordinator), 'propose_roster', { operationId: 'roster', rationale: 'A fix.',
      members: [{ name: 'Fixer', responsibility: 'Write the fix.', providerId: 'codex', model: 'gpt-5.5', workspace: 'worktree' }] });
    const supporter = h.team(roleId).members[2]!, fixer = h.ref('codex', supporter.nativeSessionId!), worktree = join(teamDirectory(), supporter.id);
    await chmod(teamDirectory(), 0o500);
    await h.broker.action({ teamId: roleId, action: 'archive' });
    await h.runtime.tick(); await h.runtime.tick();
    expect(h.team(roleId).status).toBe('archived');
    expect(existsSync(worktree)).toBe(true);
    expect(await h.runtime.extensions(coordinator)).toBeUndefined();
    expect(await h.runtime.extensions(fixer)).toBeDefined();
    await chmod(teamDirectory(), 0o700);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 11 * 60_000);
    await h.runtime.tick();
    expect(existsSync(worktree)).toBe(false);
    expect(await h.runtime.extensions(fixer)).toBeUndefined();
  } finally { vi.useRealTimers(); if (roleId) await chmod(teamDirectory(), 0o700).catch(() => undefined); await h.close(); }
});

/** A group with a coordinator that received the open call, archived and forgotten by the Controller. */
async function archivedGroup(h: Awaited<ReturnType<typeof supportHarness>>) {
  const profile = h.profile(); h.enable([profile.id]);
  const { roleId, callId } = await h.call({ operationId: 'op-1', profileId: profile.id });
  const coordinatorId = h.team(roleId).members[0]!.nativeSessionId!;
  await h.runtime.tick();
  expect(h.sessions.get(coordinatorId)!.deliveries).toHaveLength(1);
  await h.broker.action({ teamId: roleId, action: 'archive' });
  return { roleId, callId, coordinatorId, coordinator: h.ref('codex', coordinatorId) };
}

it('restores an archived group: the coordinator resumes its own session and receives the open call again', async () => {
  const h = await supportHarness();
  try {
    const { roleId, callId, coordinatorId, coordinator } = await archivedGroup(h);
    await h.runtime.tick(); await h.runtime.tick();
    expect(await h.runtime.extensions(coordinator)).toBeUndefined();
    const created = h.created.length;
    await h.broker.action({ teamId: roleId, action: 'restore' });
    expect(h.created).toHaveLength(created);
    expect(h.team(roleId).members[0]).toMatchObject({ creation: 'ready', nativeSessionId: coordinatorId });
    expect(await h.runtime.extensions(coordinator)).toMatchObject({ access: 'read_only' });
    await h.runtime.tick();
    expect(h.sessions.get(coordinatorId)!.deliveries).toHaveLength(2);
    expect(h.sessions.get(coordinatorId)!.deliveries[1]!.text).toContain(`[Support call ${callId}`);
  } finally { await h.close(); }
});

it('reopens an archived group on the worker\'s next call: the coordinator resumes its own session, and the call waits behind the open one', async () => {
  const h = await supportHarness();
  try {
    const { roleId, callId, coordinatorId, coordinator } = await archivedGroup(h);
    await h.runtime.tick(); await h.runtime.tick();
    expect(await h.runtime.extensions(coordinator)).toBeUndefined();
    const created = h.created.length;
    expect(await h.call({ operationId: 'op-2', profileId: h.team(roleId).callForSupport!.profileId, task: 'Look again.' })).toMatchObject({ status: 'accepted', roleId });
    expect(h.created).toHaveLength(created);
    expect(h.team(roleId).members[0]).toMatchObject({ creation: 'ready', nativeSessionId: coordinatorId });
    expect(h.team(roleId).callForSupport!.calls.map(call => call.status)).toEqual(['open', 'queued']);
    await h.runtime.tick();
    expect(h.sessions.get(coordinatorId)!.deliveries.map(delivery => delivery.text.includes(`[Support call ${callId}`))).toEqual([true, true]);
  } finally { await h.close(); }
});

it('starts a new coordinator session when a restored group\'s own session can no longer be opened', async () => {
  const h = await supportHarness();
  try {
    const { roleId, coordinatorId } = await archivedGroup(h);
    await h.runtime.tick(); await h.runtime.tick();
    h.sessions.delete(coordinatorId);
    await h.broker.action({ teamId: roleId, action: 'restore' });
    const replacement = h.team(roleId).members[0]!;
    expect(replacement).toMatchObject({ creation: 'ready', nativeSessionId: h.created.at(-1)!.id });
    expect(replacement.nativeSessionId).not.toBe(coordinatorId);
    expect(h.created.at(-1)!.extensions).toMatchObject({ access: 'read_only' });
  } finally { await h.close(); }
});

it('keeps the seats of a group restored while the Controller was confirming its archive', async () => {
  let restore: (() => Promise<unknown>) | undefined;
  const h = await supportHarness({ async intercept(call, forward) {
    const answer = await forward(call);
    if (call.action === 'support_group_states' && restore) { const pending = restore; restore = undefined; await pending(); }
    return answer;
  } });
  try {
    const { roleId, coordinator } = await archivedGroup(h);
    // The Relay answers "archived", then the user restores the group before the Controller acts on that answer.
    restore = () => h.broker.action({ teamId: roleId, action: 'restore' });
    for (let tick = 0; tick < 3 && restore; tick++) await h.runtime.tick();
    expect(restore).toBeUndefined();
    expect(h.team(roleId).status).toBe('active');
    expect(await h.runtime.extensions(coordinator)).toMatchObject({ access: 'read_only' });
  } finally { await h.close(); }
});

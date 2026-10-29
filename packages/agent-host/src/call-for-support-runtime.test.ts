import { expect, it } from 'vitest';
import { supportHarness } from './test-utils/call-for-support-harness.js';

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

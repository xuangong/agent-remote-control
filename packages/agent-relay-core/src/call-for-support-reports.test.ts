import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { CALL_FOR_SUPPORT_GROUP_BYTES, type CallForSupportMandate, type TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { review, supportFixture } from './test-utils/call-for-support-fixture.js';

async function group(mandate: Partial<CallForSupportMandate> = {}) {
  const f = supportFixture();
  const profile = f.profile({ ...review, mandate: { ...review.mandate, approval: 'within_mandate', ...mandate } }); f.enable('worker', [profile.id]);
  const first = await f.call({ operationId: 'op-1', profileId: profile.id });
  const roleId = first.roleId, coordinator = f.team(roleId).members[0]!, worker = f.team(roleId).members[1]!;
  await f.broker.hostCall('mac', { action: 'propose_roster', teamId: roleId, memberId: coordinator.id, operationId: 'roster',
    members: [{ name: 'Reviewer', responsibility: 'Review.', providerId: 'claude', model: 'opus', workspace: 'shared' }], rationale: '' });
  const supporter = f.team(roleId).members[2]!;
  const host = (call: Record<string, unknown>) => f.broker.hostCall('mac', { teamId: roleId, memberId: coordinator.id, ...call } as TeamHostCall) as Promise<any>;
  const report = (callId: string, operationId: string, extra: Record<string, unknown> = {}) => host({ action: 'report_support', callId, operationId,
    report: { status: 'reported', summary: 'One blocking finding.', findings: [{ id: 'f1', severity: 'blocking', location: 'src/a.ts:12', problem: 'Unchecked input.',
      suggestion: 'Validate it.', agreement: '2 of 2 reviewers', evidence: 'Both traced the call.' }], ...extra } });
  const usage = (tokens: number, costUsd?: number, memberId = supporter.id) => f.broker.hostCall('mac', { action: 'report_usage', teamId: roleId, memberId, tokens, ...(costUsd !== undefined ? { costUsd } : {}) }) as Promise<any>;
  return { ...f, profile, roleId, coordinator, worker, supporter, first, host, report, usage, support: () => f.team(roleId).callForSupport! };
}
async function upload(g: Awaited<ReturnType<typeof group>>, name: string, text: string) {
  const bytes = Buffer.from(text), sha256 = createHash('sha256').update(bytes).digest('hex');
  await g.host({ action: 'resource_begin', operationId: name, name, mediaType: 'text/x-diff', byteLength: bytes.length, sha256 });
  await g.host({ action: 'resource_chunk', operationId: name, offset: 0, contentBase64: bytes.toString('base64') });
  return (await g.host({ action: 'resource_finish', operationId: name })).resource.resourceId as string;
}

it('delivers a report to the worker as advice with its resources, then opens the next call', async () => {
  const g = await group();
  const second = await g.call({ operationId: 'op-2', roleId: g.roleId, task: 'Then check the tests.' });
  const patch = await upload(g, 'fix.patch', 'diff --git a/x b/x\n');
  expect(await g.report(g.first.callId, 'report-1', { resources: [patch] })).toEqual({ callId: g.first.callId, status: 'reported' });
  const [reported, next] = g.support().calls;
  expect(reported).toMatchObject({ status: 'reported', reportedAt: expect.any(Number), report: { summary: 'One blocking finding.', resources: [{ resourceId: patch, name: 'fix.patch' }] } });
  expect(next).toMatchObject({ id: second.callId, status: 'open' });
  const delivered = g.team(g.roleId).messages.find(message => message.to === g.worker.id)!;
  expect(delivered).toMatchObject({ from: g.coordinator.id, callForSupportCallId: g.first.callId, resources: [{ resourceId: patch }] });
  expect(delivered.text.split('\n')).toEqual(expect.arrayContaining([`[Support report · Cross review · call ${g.first.callId} · reported]`, 'One blocking finding.', 'Findings:',
    '- [blocking] src/a.ts:12: Unchecked input. → Validate it. (2 of 2 reviewers)', `Resource ${patch}: fix.patch (text/x-diff, 19 bytes).`]));
  expect(delivered.text).toContain('This report is advice. You own the decision and your workspace');
  expect(delivered.text).not.toContain('Both traced the call.');
  expect(g.team(g.roleId).messages.some(message => message.callForSupportCallId === second.callId && message.to === g.coordinator.id)).toBe(true);
  // The worker can download what the report attached.
  expect(await g.broker.hostCall('mac', { action: 'resource_metadata', teamId: g.roleId, memberId: g.worker.id, resourceId: patch })).toMatchObject({ resourceId: patch });
  expect(await g.report(g.first.callId, 'retry', { resources: [patch] })).toEqual({ callId: g.first.callId, status: 'reported' });
  await expect(g.report(g.first.callId, 'other')).rejects.toThrow('already reported');
});

it('accepts reports only from the coordinator, for the open call, within the size bound', async () => {
  const g = await group();
  const queued = await g.call({ operationId: 'op-2', roleId: g.roleId, task: 'Later.' });
  await expect(g.report(queued.callId, 'early')).rejects.toThrow('open call');
  await expect(g.broker.hostCall('mac', { action: 'report_support', teamId: g.roleId, memberId: g.supporter.id, callId: g.first.callId, operationId: 'x',
    report: { status: 'reported', summary: 'Mine.', findings: [] } })).rejects.toThrow('coordinator');
  const findings = Array.from({ length: 64 }, (_, index) => ({ id: `f${index}`, severity: 'note', problem: 'x'.repeat(500), evidence: 'y'.repeat(500) }));
  await expect(g.host({ action: 'report_support', callId: g.first.callId, operationId: 'big', report: { status: 'reported', summary: 'Big.', findings } })).rejects.toThrow('too large');
});

it('keeps many findings readable in the delivered text', async () => {
  const g = await group();
  const findings = Array.from({ length: 40 }, (_, index) => ({ id: `f${index}`, severity: 'minor', problem: `Problem ${index} ${'z'.repeat(400)}` }));
  await g.host({ action: 'report_support', callId: g.first.callId, operationId: 'many', report: { status: 'reported', summary: 'Many.', findings } });
  const text = g.team(g.roleId).messages.find(message => message.to === g.worker.id)!.text;
  expect(text.length).toBeLessThanOrEqual(16000);
  expect(text).toMatch(/\d+ more findings\. Read the full report with read_support_report\./);
});

it('keeps a revision-checked ledger for the coordinator', async () => {
  const g = await group();
  expect(await g.host({ action: 'write_ledger', revision: 0, text: 'Reviewed abcdef1: f1 open.' })).toEqual({ revision: 1 });
  await expect(g.host({ action: 'write_ledger', revision: 0, text: 'Stale.' })).rejects.toThrow('ledger changed');
  expect(g.support().ledger).toEqual({ text: 'Reviewed abcdef1: f1 open.', revision: 1 });
  await expect(g.broker.hostCall('mac', { action: 'write_ledger', teamId: g.roleId, memberId: g.supporter.id, revision: 1, text: 'Mine.' })).rejects.toThrow('coordinator');
});

it('accounts cumulative usage per member, call and role', async () => {
  const g = await group();
  await g.usage(100, 0.1); await g.usage(250, 0.3); await g.usage(40, undefined, g.coordinator.id);
  expect(g.team(g.roleId).members[2]!.usage).toMatchObject({ tokens: 250, costUsd: 0.3 });
  expect(g.support().usage).toEqual({ tokens: 290, costUsd: 0.3 });
  expect(g.support().calls[0]!.usage).toEqual({ tokens: 290, costUsd: 0.3 });
  await expect(g.usage(200)).rejects.toThrow('cumulative');
  await expect(g.usage(10, undefined, g.worker.id)).rejects.toThrow('not support usage');
});

it('pauses at a budget bound, tells the worker, holds deliveries and resumes after the budget is raised', async () => {
  const g = await group({ budget: { tokensTotal: 1000 } });
  const queued = await g.call({ operationId: 'op-2', roleId: g.roleId, task: 'Later.' });
  expect(await g.usage(1200)).toEqual({ tokens: 1200, status: 'paused_budget' });
  expect(g.support()).toMatchObject({ status: 'paused_budget', pauseReason: expect.stringContaining('1000-token budget') });
  expect(g.support().calls.map(call => call.status)).toEqual(['needs_input', 'queued']);
  const notice = g.team(g.roleId).messages.find(message => message.to === g.worker.id)!;
  expect(notice.text).toContain('Support paused');
  const toCoordinator = g.team(g.roleId).messages.find(message => message.to === g.coordinator.id && message.status === 'queued')!;
  await expect(g.broker.hostCall('mac', { action: 'claim', teamId: g.roleId, memberId: g.coordinator.id, messageId: toCoordinator.id })).rejects.toThrow('paused');
  expect(await g.broker.hostCall('mac', { action: 'claim', teamId: g.roleId, memberId: g.worker.id, messageId: notice.id })).toMatchObject({ status: 'dispatching' });
  expect(await g.call({ operationId: 'op-3', roleId: g.roleId })).toMatchObject({ status: 'unavailable', message: expect.stringContaining('paused') });
  await expect(g.broker.action({ teamId: g.roleId, action: 'resume_group' })).rejects.toThrow('Raise the budget');
  await g.broker.action({ teamId: g.roleId, action: 'update_mandate', mandate: { ...g.support().mandate, budget: { tokensTotal: 5000 } }, profileRevision: 1 });
  await g.broker.action({ teamId: g.roleId, action: 'resume_group' });
  expect(g.support()).toMatchObject({ status: 'active' });
  expect(g.support()).not.toHaveProperty('pauseReason');
  expect(g.support().calls.find(call => call.id === queued.callId)!.status).toBe('open');
});

it('pauses a call that reaches its own token bound', async () => {
  const g = await group({ budget: { tokensPerCall: 500 } });
  expect(await g.usage(600)).toMatchObject({ status: 'paused_budget' });
  expect(g.support().pauseReason).toContain(`Call ${g.first.callId} used 600 tokens`);
  // The bound is per call: with no open call left, the role can resume as is.
  await g.broker.action({ teamId: g.roleId, action: 'resume_group' });
  expect(g.support().status).toBe('active');
});

it('compacts older reports to keep the group within its storage bound', async () => {
  const g = await group();
  let open = g.first.callId;
  for (let index = 0; index < 12; index++) {
    const findings = Array.from({ length: 6 }, (_, item) => ({ id: `f${item}`, severity: 'note', problem: 'p'.repeat(900), evidence: 'e'.repeat(900) }));
    await g.host({ action: 'report_support', callId: open, operationId: `report-${index}`, report: { status: 'reported', summary: `Report ${index}.`, findings } });
    for (const message of g.team(g.roleId).messages.filter(item => item.to === g.worker.id && item.status === 'queued')) {
      await g.broker.hostCall('mac', { action: 'claim', teamId: g.roleId, memberId: g.worker.id, messageId: message.id });
      await g.broker.hostCall('mac', { action: 'settle', teamId: g.roleId, memberId: g.worker.id, messageId: message.id, outcome: 'accepted', acceptance: 'started' });
    }
    open = (await g.call({ operationId: `follow-${index}`, roleId: g.roleId, task: `Follow-up ${index}.` })).callId;
  }
  const support = g.support();
  expect(Buffer.byteLength(JSON.stringify(support))).toBeLessThanOrEqual(CALL_FOR_SUPPORT_GROUP_BYTES);
  const reported = support.calls.filter(call => call.report);
  expect(reported.at(-1)!.report!.findings[0]!.evidence).toBe('e'.repeat(900));
  expect(reported[0]!.report!.compacted).toBe(true);
});

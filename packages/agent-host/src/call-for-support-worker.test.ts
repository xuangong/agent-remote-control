import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { WorkerSupport } from './call-for-support-worker.js';
import { supportHarness } from './test-utils/call-for-support-harness.js';

async function fixture(available = true) {
  const h = await supportHarness();
  const support = new WorkerSupport({ request: call => h.broker.hostCall('host', call), available: () => available, stateDirectory: h.directory, title: async () => 'Implement login' });
  const worker = h.ref('codex', 'worker');
  const namespace = support.namespace(() => worker, false);
  const run = async (name: string, args: unknown = {}) => JSON.parse(await namespace.tools.find(tool => tool.name === name)!.execute(args));
  return { h, support, worker, namespace, run };
}

it('follows the enablement the Relay reports and tells listeners when it changes', async () => {
  const { h, support, worker } = await fixture();
  try {
    let changes = 0; support.onChange(() => { changes++; });
    await support.refresh('controller');
    expect(support.enabled(worker)).toBe(false);
    const profile = h.profile(); h.enable([profile.id]);
    await support.refresh('controller');
    expect(support.enabled(worker)).toBe(true);
    expect(changes).toBe(1);
    await support.refresh('controller');
    expect(changes).toBe(1);
    h.enable([]); h.profile({ ...profile, name: 'Default', enableByDefault: true });
    await support.refresh('controller');
    expect(support.enabled(worker)).toBe(false);
    expect(support.enabled(h.ref('codex', 'another'))).toBe(true);
  } finally { await h.close(); }
});

it('calls, lists, reads and downloads through the worker\'s own tools', async () => {
  const { h, namespace, run } = await fixture();
  try {
    expect(namespace).toMatchObject({ name: 'agent_remote' });
    expect(namespace.tools.map(tool => tool.name)).toEqual(['call_for_support', 'support_status', 'read_support_report', 'download_support_resource']);
    const profile = h.profile();
    expect(await run('call_for_support', { profileId: profile.id, task: 'Review.', deliverable: 'findings' })).toMatchObject({ status: 'unavailable' });
    h.enable([profile.id]);
    const accepted = await run('call_for_support', { profileId: profile.id, task: 'Review the change.', deliverable: 'findings', context: { commit: 'abcdef1' }, operationId: 'op-1' });
    expect(accepted).toMatchObject({ status: 'accepted', callId: expect.any(String), roleId: expect.any(String) });
    expect(h.team(accepted.roleId).source.title).toBe('Implement login');
    expect(await run('support_status')).toMatchObject({ enabled: true, roles: [{ roleId: accepted.roleId, calls: [{ id: accepted.callId, status: 'open' }] }] });
    expect(await run('read_support_report', { callId: accepted.callId })).toMatchObject({ message: 'This call has no report yet.' });

    const coordinator = h.team(accepted.roleId).members[0]!;
    const bytes = Buffer.from('diff --git a/x b/x\n'), sha256 = createHash('sha256').update(bytes).digest('hex');
    const upload = (call: Record<string, unknown>) => h.host({ teamId: accepted.roleId, memberId: coordinator.id, ...call } as never);
    await upload({ action: 'resource_begin', operationId: 'patch', name: 'fix.patch', mediaType: 'text/x-diff', byteLength: bytes.length, sha256 });
    await upload({ action: 'resource_chunk', operationId: 'patch', offset: 0, contentBase64: bytes.toString('base64') });
    const { resource } = await upload({ action: 'resource_finish', operationId: 'patch' });
    await upload({ action: 'report_support', callId: accepted.callId, operationId: 'report', report: { status: 'reported', summary: 'One finding.', resources: [resource.resourceId],
      findings: [{ id: 'f1', severity: 'major', problem: 'Unchecked input.', evidence: 'Traced from the handler.' }] } });

    expect(await run('read_support_report', { callId: accepted.callId })).toMatchObject({ status: 'reported', report: { summary: 'One finding.', findings: [{ id: 'f1' }] } });
    expect(await run('read_support_report', { callId: accepted.callId, findingId: 'f1' })).toMatchObject({ finding: { evidence: 'Traced from the handler.' } });
    const downloaded = await run('download_support_resource', { callId: accepted.callId, resourceId: resource.resourceId });
    expect(downloaded).toMatchObject({ verified: true, sha256 });
    expect(await readFile(downloaded.localPath)).toEqual(bytes);
    await expect(namespace.tools.find(tool => tool.name === 'download_support_resource')!.execute({ callId: accepted.callId, resourceId: 'other' })).rejects.toThrow('not attached');
  } finally { await h.close(); }
});

it('offers nothing while the Relay has not acknowledged Call For Support', async () => {
  const { h, support, worker, namespace } = await fixture(false);
  try {
    await support.refresh('controller');
    expect(support.enabled(worker)).toBe(false);
    await expect(namespace.tools[1]!.execute({})).rejects.toThrow('Update the Relay');
  } finally { await h.close(); }
});

import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { AgentSession, AgentRuntimeInfo } from '@borgee/agent-provider-sdk';
import { createHostExecutionPolicy, protectHostDirectory, sanitizeNativeEnvironment } from './execution-policy.js';
import { createAgentHostRuntime, type AgentHostDirectory } from './host.js';

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'host-policy-')); paths.push(root);
  await mkdir(join(root, 'allowed')); await mkdir(join(root, 'outside')); await symlink(join(root, 'outside'), join(root, 'allowed', 'escape'));
  const allowed = await realpath(join(root, 'allowed')); const outside = await realpath(join(root, 'outside'));
  const calls: string[] = [];
  const info: AgentRuntimeInfo = { providerId: 'recorded', sessionId: 'session', cwd: allowed, status: 'idle', settings: [
    { id: 'native-policy', category: 'permissions', label: 'Permissions', value: 'ask', options: [{ value: 'full', label: 'Full' }], mutable: true, scope: 'session' },
    { id: 'model', category: 'model', label: 'Model', value: 'small', options: [{ value: 'large', label: 'Large' }], mutable: true, scope: 'session' },
  ] };
  const session: AgentSession = { capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, planApproval: false, toolApproval: false } },
    async *observe() { yield { type: 'observation', sourceKey: 'runtime', occurredAt: 0, delivery: 'live', event: { type: 'runtime_updated', provider: 'recorded', runtimeInfo: info } }; },
    async runtimeInfo() { return info; }, async sendMessage() { calls.push('send'); }, async respondToInteraction() {}, async setSessionSetting(id) { calls.push(id); }, async dispose() { calls.push('dispose'); } };
  const directory: AgentHostDirectory = { providerId: 'recorded', workspaces: () => [{ id: 'work', name: 'Work', path: allowed }],
    list: () => [{ nativeSessionId: 'session', providerId: 'recorded', title: 'Session', workspace: info.cwd, createdAt: '', updatedAt: '', state: 'idle' }],
    async create(input) { calls.push(input.cwd!); return 'session'; }, async open() { calls.push('open'); return session; }, close() {} };
  const policy = await createHostExecutionPolicy({ AGENT_HOST_WORKSPACE: allowed });
  return { allowed, outside, calls, info, source: directory, directory: protectHostDirectory(directory, policy!), policy };
}
it('rejects traversal and symlink workspace escapes before creating or opening native sessions', async () => {
  const f = await fixture();
  await expect(f.directory.create({ cwd: f.outside })).rejects.toThrow(/workspace/i);
  await expect(f.directory.create({ cwd: join(f.allowed, 'escape') })).rejects.toThrow(/workspace/i);
  expect(f.calls).toEqual([]);
  await f.directory.create({ workspaceId: 'work' }); expect(f.calls).toEqual([f.allowed]);
  f.info.cwd = f.outside;
  expect(await f.directory.list()).toEqual([]);
  await expect(f.directory.open('session')).rejects.toThrow(/workspace/i);
  expect(f.calls).toEqual([f.allowed]);
});
it('locks permission controls in runtime and events while allowing model changes and rechecks cwd before input', async () => {
  const f = await fixture(); const session = await f.directory.open('session');
  expect((await session.runtimeInfo()).settings![0]!.mutable).toBe(false);
  const item = (await session.observe()[Symbol.asyncIterator]().next()).value;
  expect(item.event.runtimeInfo.settings[0].mutable).toBe(false);
  await expect(session.setSessionSetting!('native-policy', 'full')).rejects.toThrow(/locked/i);
  await session.setSessionSetting!('model', 'large'); expect(f.calls).toEqual(['open', 'model']);
  f.info.cwd = f.outside; await expect(session.sendMessage('hello')).rejects.toThrow(/workspace/i);
});
it('requires explicit local full-control opt-out and masks management secrets across inherited environment merges', async () => {
  expect(await createHostExecutionPolicy({ AGENT_HOST_TRUSTED_FULL_CONTROL: '1' })).toBeUndefined();
  const env = sanitizeNativeEnvironment({ AGENT_HOST_REMOTE_KEY: 'remote', AGENT_HOST_MANAGEMENT_TOKEN: 'management', AGENT_REMOTE_GATEWAY_CLIENT_SECRET: 'gateway',
    OPENAI_API_KEY: 'provider', ANTHROPIC_API_KEY: 'claude', GH_TOKEN: 'github', PATH: '/bin' });
  expect(env.AGENT_HOST_REMOTE_KEY).toBeUndefined(); expect(env.AGENT_HOST_MANAGEMENT_TOKEN).toBeUndefined();
  expect(env.AGENT_REMOTE_GATEWAY_CLIENT_SECRET).toBeUndefined(); expect(env.OPENAI_API_KEY).toBe('provider'); expect(env.GH_TOKEN).toBe('github');
  expect({ AGENT_HOST_REMOTE_KEY: 'inherited', ...env }.AGENT_HOST_REMOTE_KEY).toBeUndefined();
});


it('enforces the trusted policy at the Host control boundary', async () => {
  const f = await fixture();
  const host = createAgentHostRuntime({ executionPolicy: f.policy, registrations: [{ directory: f.source, adapter: {
    descriptor: { providerId: 'recorded', displayName: 'Recorded' }, async createSession() { throw new Error('Unexpected create'); }, async resumeSession() { throw new Error('Unexpected resume'); },
  } }] });
  try {
    const response = await host.control({ method: 'POST', path: '/remote/create', sessionId: 'relay', body: JSON.stringify({ providerId: 'recorded', requestId: 'request', cwd: join(f.allowed, 'escape') }) });
    expect(response.status).toBe(403); expect(JSON.parse(response.body).code).toBe('local_execution_policy'); expect(f.calls).toEqual([]);
  } finally { await host.close(); }
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CodexAppServerProvider } from './provider.js';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function provider(initialize: unknown = {}, started: Record<string, unknown> = {}, codexHome?: string, options: { userSkills?: boolean } = {}) {
  const home = codexHome ?? await mkdtemp(path.join(os.tmpdir(), 'codex-access-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const sandbox = { type: 'readOnly', networkAccess: false };
  const server = createScriptedAppServer({
    initialize: () => initialize,
    'thread/start': () => ({ thread: { id: 'read-only' }, cwd: '/work', model: 'a', approvalPolicy: 'never', sandbox, ...started }),
    'thread/resume': () => ({ thread: { id: 'read-only' }, cwd: '/work', model: 'a', approvalPolicy: 'never', sandbox }),
    'thread/read': () => ({ thread: { id: 'read-only', turns: [] } }),
    'model/list': () => ({ data: [{ model: 'a', displayName: 'A', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }] }),
    'skills/list': () => ({ data: [] }),
    'configRequirements/read': () => ({ requirements: { allowedApprovalPolicies: ['on-request', 'never'], allowedSandboxModes: ['read-only', 'workspace-write'] } }),
  });
  const provider = new CodexAppServerProvider({ spawn: () => server.child, env: { CODEX_HOME: home }, requestTimeoutMs: 2000, ...options });
  return { server, provider };
}

it('declares read-only support and starts a read-only thread in the read-only sandbox without approvals', async () => {
  const { server, provider: codex } = await provider();
  expect(codex.descriptor.sessionAccess).toEqual({ readOnly: true });
  const session = await codex.createSession({ sessionId: 'local', cwd: '/work', access: 'read_only' });
  cleanup.push(() => session.dispose());
  expect(server.requests.find(request => request.method === 'thread/start')?.params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never' });
});

it('resumes a read-only thread in the read-only sandbox', async () => {
  const { server, provider: codex } = await provider();
  const session = await codex.resumeSession({ providerId: 'codex', sessionId: 'read-only', opaque: JSON.stringify({ cwd: '/work' }) }, { access: 'read_only' });
  cleanup.push(() => session.dispose());
  expect(server.requests.find(request => request.method === 'thread/resume')?.params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never' });
});

it('refuses to widen a read-only session', async () => {
  const { provider: codex } = await provider();
  const session = await codex.createSession({ sessionId: 'local', cwd: '/work', access: 'read_only' });
  cleanup.push(() => session.dispose());
  const permissions = (await session.runtimeInfo()).settings?.filter(setting => setting.category === 'permissions') ?? [];
  expect(permissions.length).toBeGreaterThan(0);
  for (const setting of permissions) {
    expect(setting.mutable).toBe(false);
    await expect(session.setSessionSetting!(setting.id, setting.options?.find(option => option.value !== setting.value)?.value ?? 'other')).rejects.toThrow(/read-only/i);
  }
  expect((await session.listCommands!()).map(command => command.name)).not.toContain('permissions');
  await expect(session.executeCommand!('permissions', '')).rejects.toThrow(/read-only/i);
});

const hostAccess = { environment: { AGENT_REMOTE_SESSION_TOKEN: 'token', AGENT_REMOTE_SESSION_SOCKET: '/private/tmp/sessions.sock' }, unixSockets: ['/private/tmp/sessions.sock'] };
const verified = { userAgent: 'codex_cli_rs/0.166.0 (Mac OS 26.1.0; arm64) unknown', platformOs: 'macos' };

it('gives a read-only thread its Host variables and socket through a read-only profile instead of the sandbox parameter', async () => {
  // Codex reports the profile's enabled network, which reaches only the Host socket through its proxy.
  const { server, provider: codex } = await provider(verified, { sandbox: { type: 'readOnly', networkAccess: true }, activePermissionProfile: { id: 'agent-remote', extends: ':read-only' } });
  expect(codex.descriptor.sessionHostAccess).toBe(true);
  const session = await codex.createSession({ sessionId: 'local', cwd: '/work', access: 'read_only', hostAccess });
  cleanup.push(() => session.dispose());
  const params = server.requests.find(request => request.method === 'thread/start')?.params as Record<string, unknown>;
  expect(params).not.toHaveProperty('sandbox');
  expect(params).toMatchObject({ approvalPolicy: 'never', config: {
    'shell_environment_policy.set.AGENT_REMOTE_SESSION_TOKEN': 'token', 'shell_environment_policy.set.AGENT_REMOTE_SESSION_SOCKET': '/private/tmp/sessions.sock',
    'features.network_proxy': true, default_permissions: 'agent-remote',
    'permissions.agent-remote': { extends: ':read-only', network: { enabled: true, unix_sockets: { '/private/tmp/sessions.sock': 'allow' } } } } });
  const sandbox = (await session.runtimeInfo()).settings?.find(setting => setting.id === 'sandbox');
  expect(sandbox?.description).toBe('Read-only filesystem. Network access blocked, except the Controller session socket.');
});

it('resumes a read-only thread with its Host access', async () => {
  const { server, provider: codex } = await provider(verified);
  const session = await codex.resumeSession({ providerId: 'codex', sessionId: 'read-only', opaque: JSON.stringify({ cwd: '/work' }) }, { access: 'read_only' }, { hostAccess });
  cleanup.push(() => session.dispose());
  const params = server.requests.find(request => request.method === 'thread/resume')?.params as Record<string, unknown>;
  expect(params).not.toHaveProperty('sandbox');
  expect(params).toMatchObject({ approvalPolicy: 'never', config: { default_permissions: 'agent-remote', 'shell_environment_policy.set.AGENT_REMOTE_SESSION_TOKEN': 'token' } });
});

it.each([
  ['an unverified version', { ...verified, userAgent: 'codex_cli_rs/0.165.9 (Mac OS 26.1.0; arm64) unknown' }],
  ['another platform', { ...verified, platformOs: 'linux' }],
  ['no initialization details', {}],
])('keeps the read-only sandbox and gives only the variables on %s', async (_name, initialize) => {
  const { server, provider: codex } = await provider(initialize);
  const session = await codex.createSession({ sessionId: 'local', cwd: '/work', access: 'read_only', hostAccess });
  cleanup.push(() => session.dispose());
  const params = server.requests.find(request => request.method === 'thread/start')?.params as { config: Record<string, unknown> };
  expect(params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never' });
  expect(params.config['shell_environment_policy.set.AGENT_REMOTE_SESSION_TOKEN']).toBe('token');
  expect(Object.keys(params.config).filter(key => key.startsWith('permissions.') || key === 'default_permissions' || key === 'features.network_proxy')).toEqual([]);
});

it('leaves the sandbox of the user\'s own configuration unchanged', async () => {
  const { server, provider: codex } = await provider(verified);
  const session = await codex.createSession({ sessionId: 'local', cwd: '/work', hostAccess });
  cleanup.push(() => session.dispose());
  const params = server.requests.find(request => request.method === 'thread/start')?.params as { config: Record<string, unknown> };
  expect(params).not.toHaveProperty('sandbox');
  expect(params).not.toHaveProperty('approvalPolicy');
  expect(params.config).toEqual({ 'features.default_mode_request_user_input': true,
    'shell_environment_policy.set.AGENT_REMOTE_SESSION_TOKEN': 'token', 'shell_environment_policy.set.AGENT_REMOTE_SESSION_SOCKET': '/private/tmp/sessions.sock' });
});

it('never persists Host access in the session handle', async () => {
  const { provider: codex } = await provider(verified);
  const session = await codex.createSession({ sessionId: 'local', cwd: '/work', access: 'read_only', hostAccess });
  cleanup.push(() => session.dispose());
  expect((await session.runtimeInfo()).persistence?.opaque).not.toContain('token');
});

it('installs the Host skills into the Codex home and makes Codex read its skills again once per workspace', async () => {
  const skills = await mkdtemp(path.join(os.tmpdir(), 'codex-skills-source-'));
  cleanup.push(() => rm(skills, { recursive: true, force: true }));
  await mkdir(path.join(skills, 'skills', 'agent-remote'), { recursive: true });
  await writeFile(path.join(skills, 'skills', 'agent-remote', 'SKILL.md'), '---\nname: agent-remote\n---\n');
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-access-'));
  // The skill this one replaced goes; a skill of the same name the user wrote stays.
  await mkdir(path.join(home, 'skills', 'agent-remote-sessions'), { recursive: true });
  await writeFile(path.join(home, 'skills', 'agent-remote-sessions', 'SKILL.md'), '---\nname: agent-remote-sessions\n---\nold');
  const { server, provider: codex } = await provider(verified, {}, home);
  for (const cwd of ['/work', '/work', '/other']) {
    const session = await codex.createSession({ sessionId: 'local', cwd, hostAccess: { ...hostAccess, skills } });
    cleanup.push(() => session.dispose());
  }
  expect(await readFile(path.join(home, 'skills', 'agent-remote', 'SKILL.md'), 'utf8')).toBe('---\nname: agent-remote\n---\n');
  await expect(readFile(path.join(home, 'skills', 'agent-remote-sessions', 'SKILL.md'))).rejects.toThrow();
  const methods = server.requests.map(request => request.method).filter(method => method === 'skills/list' || method === 'thread/start');
  expect(methods).toEqual(['skills/list', 'thread/start', 'thread/start', 'skills/list', 'thread/start']);
  expect(server.requests.filter(request => request.method === 'skills/list').map(request => request.params)).toEqual([
    { cwds: ['/work'], forceReload: true }, { cwds: ['/other'], forceReload: true }]);
});

it('leaves the Codex home skills alone when user skills are off', async () => {
  const skills = await mkdtemp(path.join(os.tmpdir(), 'codex-skills-source-'));
  cleanup.push(() => rm(skills, { recursive: true, force: true }));
  await mkdir(path.join(skills, 'skills', 'agent-remote'), { recursive: true });
  await writeFile(path.join(skills, 'skills', 'agent-remote', 'SKILL.md'), '---\nname: agent-remote\n---\ndevelopment');
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-access-'));
  await mkdir(path.join(home, 'skills', 'agent-remote'), { recursive: true });
  await writeFile(path.join(home, 'skills', 'agent-remote', 'SKILL.md'), '---\nname: agent-remote\n---\ninstalled');
  const { server, provider: codex } = await provider(verified, {}, home, { userSkills: false });
  const session = await codex.createSession({ sessionId: 'local', cwd: '/work', hostAccess: { ...hostAccess, skills } });
  cleanup.push(() => session.dispose());
  expect(await readFile(path.join(home, 'skills', 'agent-remote', 'SKILL.md'), 'utf8')).toBe('---\nname: agent-remote\n---\ninstalled');
  expect(server.requests.some(request => request.method === 'skills/list')).toBe(false);
  // The session's commands still reach the Host.
  const params = server.requests.find(request => request.method === 'thread/start')?.params as { config: Record<string, unknown> };
  expect(params.config['shell_environment_policy.set.AGENT_REMOTE_SESSION_TOKEN']).toBe('token');
});

it('leaves a missing Codex home alone', async () => {
  const skills = await mkdtemp(path.join(os.tmpdir(), 'codex-skills-source-'));
  cleanup.push(() => rm(skills, { recursive: true, force: true }));
  await mkdir(path.join(skills, 'skills', 'agent-remote'), { recursive: true });
  await writeFile(path.join(skills, 'skills', 'agent-remote', 'SKILL.md'), 'skill');
  const missing = path.join(skills, 'missing-home');
  const { provider: codex } = await provider(verified, {}, missing);
  const session = await codex.createSession({ sessionId: 'local', cwd: '/work', hostAccess: { ...hostAccess, skills } });
  cleanup.push(() => session.dispose());
  await expect(readFile(path.join(missing, 'skills', 'agent-remote', 'SKILL.md'))).rejects.toThrow();
});

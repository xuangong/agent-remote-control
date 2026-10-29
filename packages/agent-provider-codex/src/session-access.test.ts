import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CodexAppServerProvider } from './provider.js';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function provider() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-access-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const sandbox = { type: 'readOnly', networkAccess: false };
  const server = createScriptedAppServer({
    'thread/start': () => ({ thread: { id: 'read-only' }, cwd: '/work', model: 'a', approvalPolicy: 'never', sandbox }),
    'thread/resume': () => ({ thread: { id: 'read-only' }, cwd: '/work', model: 'a', approvalPolicy: 'never', sandbox }),
    'thread/read': () => ({ thread: { id: 'read-only', turns: [] } }),
    'model/list': () => ({ data: [{ model: 'a', displayName: 'A', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }] }),
    'skills/list': () => ({ data: [] }),
    'configRequirements/read': () => ({ requirements: { allowedApprovalPolicies: ['on-request', 'never'], allowedSandboxModes: ['read-only', 'workspace-write'] } }),
  });
  const provider = new CodexAppServerProvider({ spawn: () => server.child, env: { CODEX_HOME: home }, requestTimeoutMs: 2000 });
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

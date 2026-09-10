import { describe, expect, it } from 'vitest';
import { CodexAppServerProvider } from './provider.js';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';

function harness(reject = false) {
  const native: Record<string, unknown> = { model: 'model-a', effort: 'high', approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false, writableRoots: ['/work/extra'] } };
  const server = createScriptedAppServer({
    'collaborationMode/list': () => ({ data: [{ mode: 'plan', model: 'model-a' }, { mode: 'default', model: 'model-a' }] }),
    'thread/start': () => ({ thread: { id: 'thread-settings' }, cwd: '/work', model: native.model, reasoningEffort: native.effort, approvalPolicy: native.approvalPolicy, sandbox: native.sandboxPolicy }),
    'model/list': () => ({ data: [
      { model: 'model-a', displayName: 'Model A', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' },
      { model: 'model-b', displayName: 'Model B', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' },
    ], nextCursor: null }),
    'configRequirements/read': () => ({ requirements: { allowedApprovalPolicies: ['on-request', 'never'], allowedSandboxModes: ['read-only', 'workspace-write'] } }),
    'thread/settings/update': (params) => {
      if (reject) throw new Error('Native policy refused');
      native.collaborationMode ??= { mode: 'default' };
      Object.assign(native, params);
      server.child.stdout.write(`${JSON.stringify({ method: 'thread/settings/updated', params: { threadId: 'thread-settings', threadSettings: native } })}\n`);
      return {};
    },
    'turn/start': () => ({ turn: { id: 'turn' } }),
  });
  return { server, provider: new CodexAppServerProvider({ spawn: () => server.child }) };
}

describe('Codex session settings', () => {
  it('lists native choices, honors requirements and uses confirmed settings for the next turn', async () => {
    const { server, provider } = harness();
    const session = await provider.createSession({ sessionId: 'local', planning: true });
    try {
      expect(session.capabilities.sessionSettings).toBe(true);
      const settings = (await session.runtimeInfo()).settings!;
      expect(settings.find(({ id }) => id === 'model')).toMatchObject({ value: 'model-a', options: [{ value: 'model-a' }, { value: 'model-b' }] });
      expect(settings.find(({ id }) => id === 'sandbox')).toMatchObject({ value: 'workspaceWrite', mutable: true });
      expect(settings.find(({ id }) => id === 'sandbox')?.options.map(({ value }) => value)).toEqual(['readOnly', 'workspaceWrite']);
      await expect(session.setSessionSetting!('sandbox', 'dangerFullAccess')).rejects.toThrow('Unavailable');
      await session.setSessionSetting!('model', 'model-b');
      expect((await session.runtimeInfo()).model).toBe('model-b');
      expect((await session.runtimeInfo()).planning?.active).toBe(true);
      await session.setSessionSetting!('approval', 'never');
      expect((await session.runtimeInfo()).settings?.find(({ id }) => id === 'approval')?.value).toBe('never');
      await session.sendMessage('Hello');
      expect(server.requests.find(({ method }) => method === 'turn/start')?.params).toMatchObject({ model: 'model-b', effort: 'low' });
      await expect(session.setSessionSetting!('model', 'model-a')).rejects.toThrow('idle');
    } finally { await session.dispose(); }
  });
  it('waits past the RPC acknowledgement for the matching native session confirmation', async () => {
    const server = createScriptedAppServer({
      'thread/start': () => ({ thread: { id: 'thread-confirm' }, model: 'a' }),
      'model/list': () => ({ data: [{ model: 'a' }, { model: 'b' }] }),
      'thread/settings/update': () => ({}),
    });
    const provider = new CodexAppServerProvider({ spawn: () => server.child });
    const session = await provider.createSession({ sessionId: 'local' });
    const changed = session.setSessionSetting!('model', 'b');
    let confirmed = false;
    void changed.then(() => { confirmed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(confirmed).toBe(false);
    expect((await session.runtimeInfo()).model).toBe('a');
    server.child.stdout.write(`${JSON.stringify({ method: 'thread/settings/updated', params: { threadId: 'another-thread', threadSettings: { model: 'b' } } })}\n`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(confirmed).toBe(false);
    server.child.stdout.write(`${JSON.stringify({ method: 'thread/settings/updated', params: { threadId: 'thread-confirm', threadSettings: { model: 'b' } } })}\n`);
    await changed;
    expect((await session.runtimeInfo()).model).toBe('b');
    await session.dispose();
  });

  it('preserves confirmed values when the native runtime rejects a selection', async () => {
    const { provider } = harness(true);
    const session = await provider.createSession({ sessionId: 'local', planning: true });
    try {
      await expect(session.setSessionSetting!('approval', 'never')).rejects.toThrow('Native policy refused');
      expect((await session.runtimeInfo()).settings?.find(({ id }) => id === 'approval')?.value).toBe('on-request');
    } finally { await session.dispose(); }
  });
});

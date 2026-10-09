import { describe, expect, it } from 'vitest';
import { CodexAppServerProvider } from './provider.js';
import { CodexAppServerSession } from './session.js';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';

function harness(reject = false, confirm = true, live: () => unknown = () => ({ status: 'applied' })) {
  const native: Record<string, unknown> = { model: 'model-a', effort: 'high', approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false, writableRoots: ['/work/extra'] } };
  const server = createScriptedAppServer({
    'collaborationMode/list': () => ({ data: [{ mode: 'plan', model: 'model-a' }, { mode: 'default', model: 'model-a' }] }),
    'thread/start': () => ({ thread: { id: 'thread-settings' }, cwd: '/work', model: native.model, reasoningEffort: native.effort, approvalPolicy: native.approvalPolicy, sandbox: native.sandboxPolicy }),
    'model/list': () => ({ data: [
      { model: 'model-a', displayName: 'Model A', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'low' }], defaultReasoningEffort: 'high' },
      { model: 'model-b', displayName: 'Model B', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' },
      { model: 'model-c', displayName: 'Model C' },
    ], nextCursor: null }),
    'configRequirements/read': () => ({ requirements: { allowedApprovalPolicies: ['on-request', 'never'], allowedSandboxModes: ['read-only', 'workspace-write'] } }),
    'thread/settings/update': (params) => {
      if (reject) throw new Error('Native policy refused');
      native.collaborationMode ??= { mode: 'default' };
      Object.assign(native, params);
      if (confirm) server.child.stdout.write(`${JSON.stringify({ method: 'thread/settings/updated', params: { threadId: 'thread-settings', threadSettings: native } })}\n`);
      return {};
    },
    'turn/start': () => ({ turn: { id: 'turn' } }),
    'thread/read': () => ({ thread: { id: 'thread-settings', status: { type: 'idle' }, model: native.model, reasoningEffort: native.effort } }),
    'turn/settings/update': live,
  });
  return { server, native, provider: new CodexAppServerProvider({ spawn: () => server.child }) };
}

describe('Codex session settings', () => {
  it('lists native choices, honors requirements and uses confirmed settings for the next turn', async () => {
    const { server, provider } = harness();
    const session = await provider.createSession({ sessionId: 'local', planning: true });
    try {
      expect(session.capabilities.sessionSettings).toBe(true);
      const settings = (await session.runtimeInfo()).settings!;
      expect(settings.find(({ id }) => id === 'model')).toMatchObject({ value: 'model-a', options: [{ value: 'model-a' }, { value: 'model-b' }, { value: 'model-c' }] });
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
      await expect(session.setSessionSetting!('model', 'model-a')).resolves.toEqual({ status: 'pending' });
      expect((await session.runtimeInfo()).model).toBe('model-a');
    } finally { await session.dispose(); }
  });
  it('reports native acceptance as pending until the matching session confirms it', async () => {
    const server = createScriptedAppServer({
      'thread/start': () => ({ thread: { id: 'thread-confirm' }, model: 'a', reasoningEffort: 'high' }),
      'collaborationMode/list': () => ({ data: [{ mode: 'plan', model: 'a' }, { mode: 'default', model: 'a' }] }),
      'model/list': () => ({ data: [{ model: 'a' }, { model: 'b' }] }),
      'thread/settings/update': () => ({}),
    });
    const provider = new CodexAppServerProvider({ spawn: () => server.child });
    const session = await provider.createSession({ sessionId: 'local', planning: true });
    try {
      await expect(session.setSessionSetting!('model', 'b')).resolves.toEqual({ status: 'pending' });
      expect((session as CodexAppServerSession).hasIdleState()).toBe(false);
      await expect(session.setPlanning!(false)).rejects.toThrow('pending');
      await expect(session.executeCommand!('model', '')).rejects.toThrow('pending');
      expect((await session.runtimeInfo()).model).toBe('a');
      await session.sendMessage('Use the queued native settings');
      const starting = server.requests.find(({ method }) => method === 'turn/start')?.params;
      expect(starting).not.toHaveProperty('model');
      expect(starting).not.toHaveProperty('effort');
      expect(starting).not.toHaveProperty('collaborationMode');
      server.child.stdout.write(`${JSON.stringify({ method: 'thread/settings/updated', params: { threadId: 'another-thread', threadSettings: { model: 'b' } } })}\n`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect((await session.runtimeInfo()).model).toBe('a');
      server.child.stdout.write(`${JSON.stringify({ method: 'thread/settings/updated', params: { threadId: 'thread-confirm', threadSettings: { model: 'b' } } })}\n`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect((await session.runtimeInfo()).model).toBe('b');
      await session.sendMessage('Use the selected model');
      expect(server.requests.filter(({ method }) => method === 'turn/start').at(-1)?.params).toMatchObject({ model: 'b' });
      expect(server.requests.filter(({ method }) => method === 'thread/settings/update')).toHaveLength(1);
    } finally { await session.dispose(); }
  });

  it.each([
    ['model', 'model-b', { model: 'model-b', effort: 'low' }],
    ['effort', 'low', { effort: 'low' }],
    ['approval', 'never', { approvalPolicy: 'never' }],
    ['sandbox', 'readOnly', { sandboxPolicy: { type: 'readOnly', networkAccess: false } }],
  ] as const)('submits %s while running without changing confirmed state or interrupting', async (id, value, patch) => {
    const { server, provider } = harness(false, false);
    const session = await provider.createSession({ sessionId: 'local' });
    try {
      await session.sendMessage('Keep working');
      const before = (await session.runtimeInfo()).settings?.find(setting => setting.id === id)?.value;
      await expect(session.setSessionSetting!(id, value)).resolves.toEqual({ status: 'pending' });
      expect((await session.runtimeInfo()).settings?.find(setting => setting.id === id)?.value).toBe(before);
      expect(server.requests.find(({ method }) => method === 'thread/settings/update')?.params).toMatchObject(patch);
      if (id === 'model' || id === 'effort') {
        expect(server.requests.filter(({ method }) => method.endsWith('/settings/update')).map(({ method }) => method)).toEqual(['turn/settings/update', 'thread/settings/update']);
        expect(server.requests.find(({ method }) => method === 'turn/settings/update')?.params).toEqual({ threadId: 'thread-settings', turnId: 'turn', ...patch });
      } else expect(server.requests.some(({ method }) => method === 'turn/settings/update')).toBe(false);
      server.child.stdout.write(`${JSON.stringify({ method: 'thread/settings/updated', params: { threadId: 'thread-settings', threadSettings: patch } })}\n`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect((await session.runtimeInfo()).settings?.find(setting => setting.id === id)?.value).toBe(value);
      expect((await session.runtimeInfo()).status).toBe('running');
      expect(server.requests.filter(({ method }) => method === 'turn/interrupt')).toHaveLength(0);
      expect(server.requests.filter(({ method }) => method === 'thread/settings/update')).toHaveLength(1);
    } finally { await session.dispose(); }
  });

  it('defers a setting while message submission is in flight without submitting it', async () => {
    const { server, provider } = harness();
    const session = await provider.createSession({ sessionId: 'local' });
    try {
      const sending = session.sendMessage('Keep working');
      await expect(session.setSessionSetting!('model', 'model-b')).resolves.toEqual({ status: 'deferred' });
      expect(server.requests.filter(({ method }) => method === 'thread/settings/update')).toHaveLength(0);
      await sending;
      await expect(session.setSessionSetting!('model', 'model-b')).resolves.toEqual({ status: 'pending' });
      expect((await session.runtimeInfo()).model).toBe('model-b');
    } finally { await session.dispose(); }
  });

  it('updates the same running turn repeatedly before future defaults confirm', async () => {
    const { server, provider } = harness(false, false);
    const session = await provider.createSession({ sessionId: 'local', planning: true });
    const confirm = async (threadSettings: unknown) => {
      server.child.stdout.write(`${JSON.stringify({ method: 'thread/settings/updated', params: { threadId: 'thread-settings', threadSettings } })}\n`);
      await new Promise<void>(resolve => setImmediate(resolve));
    };
    try {
      await session.sendMessage('Keep working');
      await expect(session.setSessionSetting!('effort', 'low')).resolves.toEqual({ status: 'pending' });
      await expect(session.setSessionSetting!('effort', 'high')).resolves.toEqual({ status: 'pending' });
      await confirm({ effort: 'low' });
      await expect(session.setPlanning!(false)).rejects.toThrow('pending');
      await confirm({ effort: 'high' });
      await expect(session.setSessionSetting!('model', 'model-b')).resolves.toEqual({ status: 'pending' });
      await expect(session.setSessionSetting!('effort', 'low')).resolves.toEqual({ status: 'pending' });
      await expect(session.setSessionSetting!('effort', 'high')).rejects.toThrow('Unavailable');
      await expect(session.setSessionSetting!('approval', 'never')).resolves.toEqual({ status: 'pending' });
      const live = server.requests.filter(({ method }) => method === 'turn/settings/update');
      expect(live.map(({ params }) => params)).toEqual([
        { threadId: 'thread-settings', turnId: 'turn', effort: 'low' },
        { threadId: 'thread-settings', turnId: 'turn', effort: 'high' },
        { threadId: 'thread-settings', turnId: 'turn', model: 'model-b', effort: 'low' },
        { threadId: 'thread-settings', turnId: 'turn', effort: 'low' },
      ]);
      const future = server.requests.filter(({ method }) => method === 'thread/settings/update');
      expect(future[3]?.params).toMatchObject({ effort: 'low', collaborationMode: { settings: { model: 'model-b', reasoning_effort: 'low' } } });
      expect(future[4]?.params).toEqual({ threadId: 'thread-settings', approvalPolicy: 'never' });
      expect((await session.runtimeInfo()).model).toBe('model-a');
      await confirm({ model: 'model-b', effort: 'low' });
      expect((await session.runtimeInfo()).model).toBe('model-b');
      expect(server.requests.some(({ method }) => method === 'turn/interrupt')).toBe(false);
    } finally { await session.dispose(); }
  });

  it('keeps the latest target pending when an older different native snapshot arrives', async () => {
    const { server, provider } = harness(false, false);
    const session = await provider.createSession({ sessionId: 'queued-snapshots' });
    const confirm = async (threadSettings: unknown) => {
      server.child.stdout.write(`${JSON.stringify({ method: 'thread/settings/updated', params: { threadId: 'thread-settings', threadSettings } })}\n`);
      await new Promise<void>(resolve => setImmediate(resolve));
    };
    try {
      await session.sendMessage('Keep working');
      await session.setSessionSetting!('approval', 'never');
      await session.setSessionSetting!('model', 'model-b');
      await expect(session.setSessionSetting!('model', 'model-a')).resolves.toEqual({ status: 'pending' });
      await confirm({ approvalPolicy: 'never', model: 'model-b', effort: 'low' });
      await expect(session.setPlanning!(false)).rejects.toThrow('pending model settings');
      await confirm({ approvalPolicy: 'never', model: 'model-a', effort: 'low' });
      server.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-settings', turn: { id: 'turn', status: 'completed', items: [] } } })}\n`);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect((session as CodexAppServerSession).hasIdleState()).toBe(true);
    } finally { await session.dispose(); }
  });

  it('reconciles missing model notifications from fresh idle native state', async () => {
    const { server, provider } = harness(false, false);
    const session = await provider.createSession({ sessionId: 'lost-settings-notifications' });
    try {
      await session.sendMessage('Keep working');
      await session.setSessionSetting!('model', 'model-b');
      await session.setSessionSetting!('model', 'model-a');
      server.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-settings', turn: { id: 'turn', status: 'completed', items: [] } } })}\n`);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect((session as CodexAppServerSession).hasIdleState()).toBe(false);
      expect((await session.runtimeInfo({ refreshSettings: true })).model).toBe('model-a');
      expect((session as CodexAppServerSession).hasIdleState()).toBe(true);
      await expect(session.setPlanning!(false)).resolves.toBeUndefined();
    } finally { await session.dispose(); }
  });

  it('accepts an explicit live no-op confirmation without leaving a pending lock', async () => {
    const { server, provider } = harness();
    const session = await provider.createSession({ sessionId: 'live-no-op' });
    try {
      await session.sendMessage('Keep working');
      await expect(session.setSessionSetting!('model', 'model-a')).resolves.toEqual({ status: 'pending' });
      server.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-settings', turn: { id: 'turn', status: 'completed', items: [] } } })}\n`);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect((session as CodexAppServerSession).hasIdleState()).toBe(true);
      expect(server.requests.filter(({ method }) => method === 'turn/settings/update')).toHaveLength(1);
    } finally { await session.dispose(); }
  });

  it.each(['model-a', 'model-c'])('exposes effort controls for the live model while preserving confirmed values from %s', async initialModel => {
    const { native, provider } = harness(false, false);
    native.model = initialModel;
    native.effort = initialModel === 'model-a' ? 'high' : null;
    const session = await provider.createSession({ sessionId: 'live-effort-options' });
    try {
      await session.sendMessage('Keep working');
      const nextModel = initialModel === 'model-a' ? 'model-c' : 'model-a';
      await expect(session.setSessionSetting!('model', nextModel)).resolves.toEqual({ status: 'pending' });
      const info = await session.runtimeInfo();
      expect(info.model).toBe(initialModel);
      const effort = info.settings?.find(setting => setting.id === 'effort');
      if (nextModel === 'model-c') expect(effort).toBeUndefined();
      else expect(effort).toMatchObject({ mutable: true, value: null, options: [{ value: 'high' }, { value: 'low' }] });
    } finally { await session.dispose(); }
  });

  it('does not submit future defaults after an unconfirmed live response', async () => {
    const { server, provider } = harness(false, true, () => ({}));
    const session = await provider.createSession({ sessionId: 'unknown-live-response' });
    try {
      await session.sendMessage('Keep working');
      await expect(session.setSessionSetting!('effort', 'low')).rejects.toMatchObject({ code: 'native_live_settings_unconfirmed' });
      expect(server.requests.some(({ method }) => method === 'thread/settings/update')).toBe(false);
    } finally { await session.dispose(); }
  });

  it('keeps an accepted permission mutation from being released as an idle runtime', async () => {
    const { server, provider } = harness(false, false);
    const session = await provider.createSession({ sessionId: 'local' }) as CodexAppServerSession;
    try {
      expect(session.hasIdleState()).toBe(true);
      await expect(session.setSessionSetting('approval', 'never')).resolves.toEqual({ status: 'pending' });
      expect(session.hasIdleState()).toBe(false);
      server.child.stdout.write(`${JSON.stringify({ method: 'thread/settings/updated', params: { threadId: 'thread-settings', threadSettings: { approvalPolicy: 'never' } } })}\n`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(session.hasIdleState()).toBe(true);
    } finally { await session.dispose(); }
  });

  it.each(['fresh', 'superseded', 'unloaded'])('reads model and effort from loaded native metadata without overwriting newer notifications: %s', async mode => {
    const server = createScriptedAppServer({
      'thread/start': () => ({ thread: { id: 'readback' }, model: 'a', reasoningEffort: 'high', approvalPolicy: 'on-request' }),
      'model/list': () => ({ data: [
        { model: 'a', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'low' }] },
        { model: 'b', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'low' }] },
      ] }),
      'configRequirements/read': () => ({ requirements: null }),
      'thread/read': () => {
        if (mode === 'superseded') server.child.stdout.write(`${JSON.stringify({ method: 'thread/settings/updated', params: { threadId: 'readback', threadSettings: { model: 'b', effort: 'high' } } })}\n`);
        return { thread: { id: 'readback', status: { type: mode === 'unloaded' ? 'notLoaded' : 'idle' }, model: 'b', reasoningEffort: 'low', approvalPolicy: 'never' } };
      },
    });
    const provider = new CodexAppServerProvider({ spawn: () => server.child });
    const session = await provider.createSession({ sessionId: 'readback' });
    try {
      const refreshed = await session.runtimeInfo({ refreshSettings: true });
      expect(refreshed.model).toBe(mode === 'unloaded' ? 'a' : 'b');
      expect(refreshed.settings?.find(setting => setting.id === 'effort')?.value).toBe(mode === 'fresh' ? 'low' : 'high');
      expect(refreshed.settings?.find(setting => setting.id === 'approval')?.value).toBe('on-request');
      expect(server.requests.filter(request => request.method === 'thread/read')).toMatchObject([{ params: { threadId: 'readback', includeTurns: false } }]);
      expect(server.requests.some(request => request.method === 'thread/resume' || request.method === 'thread/settings/update')).toBe(false);
    } finally { await session.dispose(); }
  });

  it.each(['methodMissing', 'featureDisabled', 'targetUnavailable'])('defers %s without changing future defaults or repeating the live request', async failure => {
    const { server, provider } = harness(false, true, () => {
      if (failure === 'targetUnavailable') return { status: 'targetUnavailable' };
      throw Object.assign(new Error(failure === 'methodMissing' ? 'Method not found' : 'turn settings updates require the step_model_switching feature'), { code: failure === 'methodMissing' ? -32601 : -32600 });
    });
    const session = await provider.createSession({ sessionId: 'live-unavailable' });
    try {
      await session.sendMessage('Keep working');
      await expect(session.setSessionSetting!('model', 'model-b')).resolves.toEqual({ status: 'deferred' });
      await expect(session.setSessionSetting!('model', 'model-b')).resolves.toEqual({ status: 'deferred' });
      expect(server.requests.filter(({ method }) => method === 'turn/settings/update')).toHaveLength(1);
      expect(server.requests.some(({ method }) => method === 'thread/settings/update')).toBe(false);
      server.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-settings', turn: { id: 'turn', status: 'completed', items: [] } } })}\n`);
      await new Promise<void>(resolve => setImmediate(resolve));
      await expect(session.setSessionSetting!('model', 'model-b')).resolves.toBeUndefined();
      expect((await session.runtimeInfo()).model).toBe('model-b');
      expect(server.requests.filter(({ method }) => method === 'turn/settings/update')).toHaveLength(1);
    } finally { await session.dispose(); }
  });

  it('keeps future defaults unchanged when live native policy rejects the destination', async () => {
    const { server, provider } = harness(false, true, () => { throw Object.assign(new Error('the destination changes the admitted approval policy'), { code: -32600 }); });
    const session = await provider.createSession({ sessionId: 'live-policy' });
    try {
      await session.sendMessage('Keep working');
      await expect(session.setSessionSetting!('model', 'model-b')).rejects.toThrow('admitted approval policy');
      expect(server.requests.some(({ method }) => method === 'thread/settings/update')).toBe(false);
      expect((await session.runtimeInfo()).model).toBe('model-a');
    } finally { await session.dispose(); }
  });

  it('reports partial success when current-turn publication succeeds but future defaults fail', async () => {
    const { server, provider } = harness(true);
    const session = await provider.createSession({ sessionId: 'live-partial' });
    try {
      await session.sendMessage('Keep working');
      await expect(session.setSessionSetting!('model', 'model-b')).rejects.toMatchObject({ code: 'native_settings_partial_failure', message: expect.stringContaining('current turn') });
      expect(server.requests.filter(({ method }) => method.endsWith('/settings/update')).map(({ method }) => method)).toEqual(['turn/settings/update', 'thread/settings/update']);
      expect((await session.runtimeInfo()).model).toBe('model-a');
      expect(server.requests.some(({ method }) => method === 'turn/interrupt')).toBe(false);
    } finally { await session.dispose(); }
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

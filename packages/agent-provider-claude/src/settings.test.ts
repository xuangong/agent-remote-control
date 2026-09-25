import { expect, it } from 'vitest';
import { ClaudeAgentSession } from './session.js';
import { Channel } from './channel.js';

function fixture() {
  const events = new Channel<any>();
  const changes: string[] = [];
  let models = [{ value: 'sonnet', displayName: 'Sonnet', description: 'Native Sonnet' }];
  let update: () => Promise<void> = async () => {};
  const query = { [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
    initializationResult: async () => ({ models }), supportedModels: async () => models,
    setModel: async (value: string) => { await update(); changes.push(value); },
    setPermissionMode: async (value: string) => { await update(); changes.push(value); },
    interrupt: async () => {}, close: () => events.close() };
  return { changes, events, setModels(value: typeof models) { models = value; },
    setUpdate(value: typeof update) { update = value; }, factory: () => query as any };
}

it('publishes confirmed model choices and rejects stale choices and active-turn changes', async () => {
  const native = fixture();
  const session = await ClaudeAgentSession.open({ sessionId: 'native', model: 'old' }, { query: native.factory });
  try {
    expect(session.capabilities.sessionSettings).toBe(true);
    expect((await session.runtimeInfo()).settings).toContainEqual(expect.objectContaining({ category: 'model', options: [{ value: 'sonnet', label: 'Sonnet', description: 'Native Sonnet' }] }));
    let confirm!: () => void;
    native.setUpdate(() => new Promise<void>((resolve) => { confirm = resolve; }));
    const changing = session.setSessionSetting!('model', 'sonnet');
    await expect.poll(() => typeof confirm).toBe('function');
    expect((await session.runtimeInfo()).model).toBe('old');
    await expect(session.sendMessage('racing')).rejects.toThrow(/setting/);
    confirm(); await changing;
    expect((await session.runtimeInfo()).model).toBe('sonnet');
    native.setModels([]);
    await expect(session.setSessionSetting!('model', 'sonnet')).rejects.toThrow(/Unavailable/);
    await session.sendMessage('active');
    await expect(session.setSessionSetting!('permissions', 'acceptEdits')).rejects.toThrow(/idle/);
  } finally { await session.dispose(); }
});

it('restores selected permission mode after planning and preserves it for resume', async () => {
  const native = fixture();
  const session = await ClaudeAgentSession.open({ sessionId: 'native' }, { query: native.factory });
  try {
    await session.setSessionSetting!('permissions', 'acceptEdits');
    await session.setPlanning(true);
    await session.setPlanning(false);
    expect(native.changes).toEqual(['acceptEdits', 'plan', 'acceptEdits']);
    expect(JSON.parse((await session.runtimeInfo()).persistence!.opaque)).toMatchObject({ permissionMode: 'acceptEdits' });
    native.setUpdate(async () => { throw new Error('admin restriction'); });
    await expect(session.setSessionSetting!('permissions', 'dontAsk')).rejects.toThrow('admin restriction');
    expect((await session.runtimeInfo()).settings).toContainEqual(expect.objectContaining({ category: 'permissions', value: 'acceptEdits' }));
    await expect(session.setSessionSetting!('permissions', 'bypassPermissions')).rejects.toThrow(/Unavailable/);
  } finally { await session.dispose(); }
});

it('closes an ambiguous timed-out setting change instead of allowing work with stale settings', async () => {
  const native = fixture();
  const session = await ClaudeAgentSession.open({ sessionId: 'native', model: 'old' }, { query: native.factory, requestTimeoutMs: 20 });
  try {
    let confirm!: () => void;
    native.setUpdate(() => new Promise<void>((resolve) => { confirm = resolve; }));
    await expect(session.setSessionSetting!('model', 'sonnet')).rejects.toThrow(/timed out/);
    expect((await session.runtimeInfo()).status).toBe('failed');
    await expect(session.sendMessage('unsafe continuation')).rejects.toThrow(/timed out/);
    confirm(); await Promise.resolve();
    expect((await session.runtimeInfo()).model).toBe('old');
  } finally { await session.dispose(); }
});

it('requires the native sandbox without unsandboxed fallback and resets saved elevated permission mode', async () => {
  const native = fixture(); let launched: any;
  const session = await ClaudeAgentSession.open({ sessionId: 'native', permissionMode: 'dontAsk' }, {
    restrictedNative: true, query: input => { launched = input.options; return native.factory(); },
  });
  try { expect(launched).toMatchObject({ permissionMode: 'default', sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }); }
  finally { await session.dispose(); }
});


it('changes supported native permissions while retaining the restricted sandbox', async () => {
  const native = fixture(); let launched: any;
  const session = await ClaudeAgentSession.open({ sessionId: 'native' }, {
    restrictedNative: true, query: input => { launched = input.options; return native.factory(); },
  });
  try {
    const permissions = (await session.runtimeInfo()).settings!.find(setting => setting.id === 'permissions')!;
    expect(permissions.mutable).toBe(true);
    for (const mode of ['acceptEdits', 'dontAsk', 'plan', 'default']) {
      await session.setSessionSetting!('permissions', mode);
      expect((await session.runtimeInfo()).settings!.find(setting => setting.id === 'permissions')!.value).toBe(mode);
    }
    expect(native.changes).toEqual(['acceptEdits', 'dontAsk', 'plan', 'default']);
    await expect(session.setSessionSetting!('permissions', 'bypassPermissions')).rejects.toThrow(/Unavailable/);
    expect(launched.sandbox).toEqual({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    native.setUpdate(async () => { throw new Error('Native permission policy rejected the change'); });
    await expect(session.setSessionSetting!('permissions', 'acceptEdits')).rejects.toThrow(/rejected/);
    expect((await session.runtimeInfo()).settings!.find(setting => setting.id === 'permissions')!.value).toBe('default');
  } finally { await session.dispose(); }
});

it('selects the advertised native default before init without pinning a model', async () => {
  const native = fixture(); let launched: any;
  native.setModels([{ value: 'default', displayName: 'Default (recommended)', description: 'Native default' },
    { value: 'sonnet', displayName: 'Sonnet', description: 'Native Sonnet' }]);
  const session = await ClaudeAgentSession.open({ sessionId: 'native' }, {
    query: input => { launched = input.options; return native.factory(); },
  });
  try {
    expect((await session.runtimeInfo()).settings).toContainEqual(expect.objectContaining({ id: 'model', value: 'default' }));
    expect(launched.model).toBeUndefined();
    expect((await session.runtimeInfo()).model).toBeNull();
    expect(JSON.parse((await session.runtimeInfo()).persistence!.opaque).model).toBeUndefined();
    native.events.push({ type: 'system', subtype: 'init', model: 'native-resolved-model', permissionMode: 'default', uuid: 'init', session_id: 'native' });
    await expect.poll(async () => (await session.runtimeInfo()).model).toBe('native-resolved-model');
    expect((await session.runtimeInfo()).settings).toContainEqual(expect.objectContaining({ id: 'model', value: 'native-resolved-model' }));
    await session.setSessionSetting!('model', 'default');
    expect(native.changes).toEqual(['default']);
  } finally { await session.dispose(); }
});

it('does not invent a default option when the native model catalog omits it', async () => {
  const native = fixture();
  const session = await ClaudeAgentSession.open({ sessionId: 'native' }, { query: native.factory });
  try {
    expect((await session.runtimeInfo()).settings).toContainEqual(expect.objectContaining({ id: 'model', value: null }));
    await expect(session.setSessionSetting!('model', 'default')).rejects.toThrow(/Unavailable/);
  } finally { await session.dispose(); }
});

import { expect, it } from 'vitest';
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentSession } from './session.js';
import { Channel } from './channel.js';

function fixture() {
  const events = new Channel<any>();
  const changes: string[] = [];
  let models: ModelInfo[] = [{ value: 'sonnet', displayName: 'Sonnet', description: 'Native Sonnet' }];
  let update: () => Promise<void> = async () => {};
  const query = { [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
    initializationResult: async () => ({ models }), supportedModels: async () => models,
    setModel: async (value: string) => { await update(); changes.push(value); },
    setPermissionMode: async (value: string) => { await update(); changes.push(value); },
    interrupt: async () => {}, close: () => events.close() };
  return { changes, events, setModels(value: typeof models) { models = value; },
    setUpdate(value: typeof update) { update = value; }, factory: () => query as any };
}

it('publishes confirmed model choices, rejects stale choices, and changes permissions during a turn', async () => {
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
    await expect(session.setSessionSetting('permissions', 'dontAsk')).resolves.toEqual({ status: 'deferred' });
    expect(native.changes).toEqual([]);
    await expect(session.sendMessage('racing')).rejects.toThrow(/setting/);
    confirm(); await changing;
    expect((await session.runtimeInfo()).model).toBe('sonnet');
    native.setModels([]);
    await expect(session.setSessionSetting!('model', 'sonnet')).rejects.toThrow(/Unavailable/);
    await session.sendMessage('active');
    native.setUpdate(async () => {});
    await session.setSessionSetting!('permissions', 'acceptEdits');
    expect((await session.runtimeInfo()).status).toBe('running');
    expect((await session.runtimeInfo()).settings).toContainEqual(expect.objectContaining({ id: 'permissions', value: 'acceptEdits' }));
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

it('changes a model during a running turn only after native confirmation without interrupting it', async () => {
  const native = fixture(); let interrupts = 0;
  const session = await ClaudeAgentSession.open({ sessionId: 'native', model: 'old' }, {
    query: () => ({ ...native.factory(), interrupt: async () => { interrupts++; } }),
  });
  try {
    await session.sendMessage('Continue working');
    let confirm!: () => void;
    native.setUpdate(() => new Promise<void>(resolve => { confirm = resolve; }));
    const changing = session.setSessionSetting('model', 'sonnet');
    void changing.catch(() => {});
    await expect.poll(() => typeof confirm).toBe('function');
    expect((await session.runtimeInfo()).model).toBe('old');
    expect((await session.runtimeInfo()).status).toBe('running');
    confirm(); await changing;
    expect((await session.runtimeInfo()).model).toBe('sonnet');
    expect((await session.runtimeInfo()).status).toBe('running');
    expect(interrupts).toBe(0);
  } finally { await session.dispose(); }
});

function effortFixture() {
  const native = fixture();
  native.setModels([{ value: 'sonnet', resolvedModel: 'claude-sonnet-native', displayName: 'Sonnet', description: 'Native Sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'max'] }]);
  let applied: string | null = 'high';
  let apply: (value: string | null) => Promise<void> = async value => { applied = value ?? 'high'; };
  const flags: Array<string | null> = [];
  return { ...native, flags, setApply(value: typeof apply) { apply = value; }, setApplied(value: string | null) { applied = value; },
    factory: () => ({ ...native.factory(),
      applyFlagSettings: async ({ effortLevel }: { effortLevel: string | null }) => { flags.push(effortLevel); await apply(effortLevel); },
      getSettings: async () => ({ applied: { model: 'claude-sonnet-native', effort: applied } }),
    }),
  };
}

it('changes native effort during a turn and confirms actual application before publishing it', async () => {
  const native = effortFixture();
  const session = await ClaudeAgentSession.open({ sessionId: 'native', model: 'claude-sonnet-native' }, { query: native.factory });
  try {
    const effort = (await session.runtimeInfo()).settings!.find(setting => setting.id === 'reasoning_effort');
    expect(effort).toMatchObject({ value: 'default', options: [{ value: 'default', label: 'Native default' }, { value: 'low', label: 'low' }, { value: 'high', label: 'high' }, { value: 'max', label: 'max' }] });
    expect(effort!.description).toContain('Applied effort: high');
    await session.sendMessage('Keep working');
    let confirm!: () => void;
    native.setApply(value => new Promise<void>(resolve => { confirm = () => { native.setApplied(value); resolve(); }; }));
    const changing = session.setSessionSetting('reasoning_effort', 'max');
    void changing.catch(() => {});
    await expect.poll(() => typeof confirm).toBe('function');
    expect((await session.runtimeInfo()).settings!.find(setting => setting.id === 'reasoning_effort')!.value).toBe('default');
    confirm(); await changing;
    expect((await session.runtimeInfo()).settings!.find(setting => setting.id === 'reasoning_effort')!.value).toBe('max');
    expect((await session.runtimeInfo()).status).toBe('running');
    expect(JSON.parse((await session.runtimeInfo()).persistence!.opaque).reasoningEffort).toBe('max');
    native.setApply(async value => { native.setApplied(value ?? 'high'); });
    await session.setSessionSetting('reasoning_effort', 'default');
    expect(native.flags).toEqual(['max', null]);
    expect((await session.runtimeInfo()).settings!.find(setting => setting.id === 'reasoning_effort')!.value).toBe('default');
    expect(JSON.parse((await session.runtimeInfo()).persistence!.opaque).reasoningEffort).toBeUndefined();
  } finally { await session.dispose(); }
});

it('keeps native effort overrides truthful and does not invent unsupported effort choices', async () => {
  const native = effortFixture();
  const session = await ClaudeAgentSession.open({ sessionId: 'native', model: 'sonnet' }, { query: native.factory });
  try {
    native.setApply(async () => { native.setApplied('low'); });
    await expect(session.setSessionSetting('reasoning_effort', 'max')).rejects.toThrow(/applied low/);
    expect((await session.runtimeInfo()).settings!.find(setting => setting.id === 'reasoning_effort')!.value).toBe('low');
    await expect(session.setSessionSetting('reasoning_effort', 'medium')).rejects.toThrow(/Unavailable/);
    native.setModels([{ value: 'sonnet', displayName: 'Sonnet', description: 'No effort', supportsEffort: false }]);
    await expect(session.setSessionSetting('reasoning_effort', 'high')).rejects.toThrow(/Unknown/);
    expect((await session.runtimeInfo()).settings!.some(setting => setting.id === 'reasoning_effort')).toBe(false);
  } finally { await session.dispose(); }
});

it('does not advertise effort without native applied-state readback', async () => {
  const native = effortFixture();
  const session = await ClaudeAgentSession.open({ sessionId: 'native', model: 'sonnet' }, {
    query: () => ({ ...native.factory(), getSettings: undefined }),
  });
  try { expect((await session.runtimeInfo()).settings!.some(setting => setting.id === 'reasoning_effort')).toBe(false); }
  finally { await session.dispose(); }
});

it('withdraws effort state when native application succeeds but applied readback becomes unavailable', async () => {
  const native = effortFixture(); let unavailable = false;
  const session = await ClaudeAgentSession.open({ sessionId: 'native', model: 'sonnet' }, {
    query: () => { const query = native.factory(); return { ...query, getSettings: async () => {
      if (unavailable) throw new Error('Native settings readback unavailable');
      return query.getSettings();
    } }; },
  });
  try {
    unavailable = true;
    await expect(session.setSessionSetting('reasoning_effort', 'max')).rejects.toThrow(/readback unavailable/);
    expect(native.flags).toEqual(['max']);
    expect((await session.runtimeInfo()).settings!.some(setting => setting.id === 'reasoning_effort')).toBe(false);
  } finally { await session.dispose(); }
});

it('refreshes native settings only on request and retains confirmed model aliases and default selections', async () => {
  const native = effortFixture(); let reads = 0; let model = 'claude-sonnet-native'; let effort = 'high';
  const session = await ClaudeAgentSession.open({ sessionId: 'native', model: 'sonnet', reasoningEffort: 'high' }, {
    query: () => ({ ...native.factory(), getSettings: async () => { reads++; return { applied: { model, effort } }; } }),
  });
  try {
    const initialReads = reads;
    effort = 'low';
    await session.runtimeInfo();
    expect(reads).toBe(initialReads);
    const refreshed = await session.runtimeInfo({ refreshSettings: true });
    expect(reads).toBe(initialReads + 1);
    expect(refreshed.model).toBe('sonnet');
    expect(refreshed.settings).toContainEqual(expect.objectContaining({ id: 'reasoning_effort', value: 'low' }));
    model = 'externally-selected-model';
    expect((await session.runtimeInfo({ refreshSettings: true })).model).toBe(model);
    native.setModels([{ value: 'default', displayName: 'Default', description: 'Native default' }]);
    await session.setSessionSetting('model', 'default');
    model = 'native-default-resolved';
    expect((await session.runtimeInfo({ refreshSettings: true })).settings).toContainEqual(expect.objectContaining({ id: 'model', value: 'default' }));
  } finally { await session.dispose(); }
});

it.each(['stale result', 'stale failure'])('does not let a late settings read overwrite a newer native confirmation: %s', async outcome => {
  const native = effortFixture(); let block = false; let release!: () => void;
  const session = await ClaudeAgentSession.open({ sessionId: 'native', model: 'sonnet' }, {
    query: () => { const query = native.factory(); return { ...query, getSettings: async () => {
      if (!block) return query.getSettings();
      block = false;
      return new Promise((resolve, reject) => { release = () => outcome === 'stale failure' ? reject(new Error('Old read failed')) : resolve({ applied: { model: 'old-model', effort: 'low' } }); });
    } }; },
  });
  try {
    block = true;
    const reading = session.runtimeInfo({ refreshSettings: true });
    void reading.catch(() => {});
    await expect.poll(() => typeof release).toBe('function');
    await session.setSessionSetting('reasoning_effort', 'max');
    expect((await session.runtimeInfo()).settings).toContainEqual(expect.objectContaining({ id: 'reasoning_effort', value: 'max' }));
    release(); await reading.catch(() => {});
    expect((await session.runtimeInfo()).model).toBe('sonnet');
    expect((await session.runtimeInfo()).settings).toContainEqual(expect.objectContaining({ id: 'reasoning_effort', value: 'max' }));
  } finally { release?.(); await session.dispose(); }
});

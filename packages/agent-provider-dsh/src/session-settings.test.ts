import { describe, expect, it } from 'vitest';
import { createCordisDshRuntime } from './runtime.js';
import { LiveDshSession } from './live-session.js';
import { DshSessionSettings } from './session-settings.js';

function nativeHost() {
  let selected = { provider: 'native', model: 'a' };
  let preset = 'ask';
  const calls: unknown[] = [];
  const agent = { status: 'idle', options: {}, session: { id: 's', header: {}, snapshotEvents: () => [], requestHeader: () => undefined } };
  const services: Record<string, unknown> = {
    sessionController: {
      async modelCatalog() { return { groups: [{ id: 'native', name: 'Native', models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }], default: selected }; },
      async selectModel(request: { provider: string; model: string }) { calls.push(request); selected = { provider: request.provider, model: request.model }; return { selected }; },
    },
    agentDefaultModel: { currentSelection: () => selected },
    sessionProjections: { stateOf: () => ({ pending: selected, lastUsed: null }) },
    permissionPresets: { names: ['ask', 'auto'], current: () => preset, optionOf: (name: string) => ({ value: name, name }) },
    commands: { view: () => ({ get: () => ({}) }), async execute(_agent: unknown, line: string) { calls.push(line); preset = line.slice('/permission '.length); return { result: { kind: 'success' } }; } },
  };
  const context = { sessions: { flush: async () => {} }, get: (key: string) => services[key], on: () => () => {}, agents: { create: async () => ({ agent, dispose: async () => {} }) } };
  return { context, agent, calls, services };
}

describe('native DSH session settings', () => {
  it('uses the shared controller and registered permission command with their native scope', async () => {
    const host = nativeHost();
    const runtime = createCordisDshRuntime({ context: host.context as never });
    const owned = await runtime.create({ sessionId: 's' });
    const session = new LiveDshSession(owned, { providerId: 'dsh', sessionId: 's', opaque: '{}' }, { get: () => undefined } as never);
    try {
      const settings = (await session.runtimeInfo()).settings!;
      expect(settings.find(({ id }) => id === 'model')).toMatchObject({ mutable: true, scope: 'session_and_default' });
      const option = settings.find(({ id }) => id === 'model')!.options.find(({ label }) => label.includes('B'))!;
      await session.setSessionSetting!('model', option.value);
      expect(host.calls[0]).toEqual({ sessionId: 's', provider: 'native', model: 'b' });
      expect((await session.runtimeInfo()).settings?.find(({ id }) => id === 'model')?.value).toBe(option.value);
      await session.setSessionSetting!('permissions', 'auto');
      expect(host.calls[1]).toBe('/permission auto');
      expect((await session.runtimeInfo()).settings?.find(({ id }) => id === 'permissions')?.value).toBe('auto');
      host.agent.status = 'running';
      await expect(session.setSessionSetting!('permissions', 'ask')).rejects.toThrow('idle');
    } finally { await session.dispose(); await runtime.dispose?.(); }
  });
  it('does not mutate a preset through a private setter when the native command is absent', async () => {
    const host = nativeHost();
    delete host.services.commands;
    const runtime = createCordisDshRuntime({ context: host.context as never });
    const owned = await runtime.create({ sessionId: 's' });
    const session = new LiveDshSession(owned, { providerId: 'dsh', sessionId: 's', opaque: '{}' }, { get: () => undefined } as never);
    try {
      expect((await session.runtimeInfo()).settings?.find(({ id }) => id === 'permissions')).toMatchObject({ value: 'ask', mutable: false });
      await expect(session.setSessionSetting!('permissions', 'auto')).rejects.toThrow('read-only');
      expect(host.calls).toEqual([]);
    } finally { await session.dispose(); await runtime.dispose?.(); }
  });
});


describe('DSH model catalog refresh', () => {
  it('coalesces pending loads and revalidates removed models on the next selection', async () => {
    const host = nativeHost();
    const controller = host.services.sessionController as { modelCatalog(): Promise<unknown>; selectModel(value: unknown): Promise<unknown> };
    let release!: (catalog: unknown) => void;
    let reads = 0;
    controller.modelCatalog = () => {
      reads += 1;
      return new Promise((resolve) => { release = resolve; });
    };
    const settings = new DshSessionSettings(host.agent as never, (name) => host.services[name]);
    const first = settings.load();
    const concurrent = settings.load();
    expect(reads).toBe(1);
    release({ groups: [{ id: 'native', models: [{ id: 'a' }] }] });
    await Promise.all([first, concurrent]);
    expect(settings.describe().find(({ id }) => id === 'model')!.options.map(({ value }) => value)).toEqual(['["native","a"]']);

    controller.modelCatalog = async () => {
      reads += 1;
      return { groups: [{ id: 'native', models: [{ id: 'b' }] }] };
    };
    await expect(settings.select('model', '["native","a"]')).rejects.toThrow();
    expect(reads).toBe(2);
    expect(host.calls).toEqual([]);
    expect(settings.describe().find(({ id }) => id === 'model')!.options.map(({ value }) => value)).toEqual(['["native","b"]']);
    await settings.select('model', '["native","b"]');
    expect(host.calls).toEqual([{ sessionId: 's', provider: 'native', model: 'b' }]);
  });

  it('recovers from the first load failure and removes the stale error', async () => {
    const host = nativeHost();
    const controller = host.services.sessionController as { modelCatalog(): Promise<unknown> };
    let unavailable = true;
    controller.modelCatalog = async () => {
      if (unavailable) throw new Error('Catalog temporarily offline');
      return { groups: [{ id: 'native', models: [{ id: 'b' }] }] };
    };
    const settings = new DshSessionSettings(host.agent as never, (name) => host.services[name]);
    await settings.load();
    expect(settings.describe().find(({ id }) => id === 'model')).toMatchObject({ mutable: false, options: [], description: 'Catalog temporarily offline' });
    unavailable = false;
    await settings.load();
    const model = settings.describe().find(({ id }) => id === 'model')!;
    expect(model.mutable).toBe(true);
    expect(model.options.map(({ value }) => value)).toEqual(['["native","b"]']);
    expect(model.description).not.toContain('offline');
  });

  it('does not submit an old selection when refreshing the catalog fails', async () => {
    const host = nativeHost();
    const settings = new DshSessionSettings(host.agent as never, (name) => host.services[name]);
    await settings.load();
    const controller = host.services.sessionController as { modelCatalog(): Promise<unknown> };
    controller.modelCatalog = async () => { throw new Error('Catalog disconnected'); };
    await expect(settings.select('model', '["native","a"]')).rejects.toThrow('read-only');
    expect(settings.describe().find(({ id }) => id === 'model')).toMatchObject({ mutable: false, options: [], description: 'Catalog disconnected' });
    expect(host.calls).toEqual([]);
  });
});

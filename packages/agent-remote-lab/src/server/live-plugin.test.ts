import type { AgentProviderAdapter, AgentSessionConfig } from '@agent-remote-controller/agent-provider-sdk';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const composition = vi.hoisted(() => ({
  providers: [] as AgentProviderAdapter[],
  providerFactory: vi.fn(),
  codexFactory: vi.fn(),
  cleanup: undefined as (() => Promise<void>) | undefined,
  liveRequest: undefined as ((request: object, response: object) => void) | undefined,
  installModelSelection: vi.fn(),
  interactions: { dispose: vi.fn(async (): Promise<void> => undefined) },
  labOrigin: undefined as string | undefined,
  listen: vi.fn(async (_port: number, _host: string) => undefined),
  stopReader: vi.fn(),
}));

vi.mock('@deepseek-ai/dsh-agent', () => ({
  installModelSelection: composition.installModelSelection,
}));

vi.mock('@agent-remote-controller/agent-provider-dsh', async (importOriginal) => ({
  ...await importOriginal<typeof import('@agent-remote-controller/agent-provider-dsh')>(),
  createDshWebInteractionAdapter: () => composition.interactions,
}));

vi.mock('@agent-remote-controller/dsh', async (importOriginal) => ({
  ...await importOriginal<typeof import('@agent-remote-controller/dsh')>(),
  createDshAgentRemoteProvider: composition.providerFactory,
}));

vi.mock('./codex.js', () => ({
  createCodexProviderFixture: composition.codexFactory,
}));

vi.mock('../server.js', () => ({
  createProtocolValidationServer(options: { providers: readonly AgentProviderAdapter[]; labOrigin: string }) {
    composition.providers = [...options.providers];
    composition.labOrigin = options.labOrigin;
    const relayRequest = vi.fn();
    return {
      http: {
        server: {
          listeners: () => [relayRequest],
          removeListener: vi.fn(),
          on: (_event: string, listener: (request: object, response: object) => void) => {
            composition.liveRequest = listener;
          },
        },
        listen: composition.listen,
      },
      close: async () => undefined,
    };
  },
}));

import { apply } from './live-plugin.js';

const roots: string[] = [];

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'borgee-live-manifest-'));
  roots.push(root);
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'compatibility.json'), 'utf8'));
  manifest.borgee.implementation = {
    algorithm: 'sha256', root: '.', scope: ['implementation.txt'],
    digest: 'sha256:d8fdc7cc1b3b4a412e46aaacede0afa478eee509c99e48f2d684e2ede8ee5a15',
  };
  writeFileSync(join(root, 'implementation.txt'), 'implementation\n');
  process.env.BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST = join(root, 'compatibility.json');
  writeFileSync(process.env.BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST, JSON.stringify(manifest));
});

afterEach(async () => {
  await composition.cleanup?.();
  composition.providers = [];
  composition.cleanup = undefined;
  composition.providerFactory.mockReset();
  composition.codexFactory.mockReset();
  composition.installModelSelection.mockReset();
  composition.interactions.dispose.mockReset();
  composition.labOrigin = undefined;
  composition.listen.mockReset();
  composition.stopReader.mockReset();
  composition.liveRequest = undefined;
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  delete process.env.BORGEE_LIVE_DSH_WORKSPACE;
  delete process.env.BORGEE_LIVE_DSH_PLAN_MODE;
  delete process.env.BORGEE_LIVE_DSH_RELAY_PORT;
  delete process.env.BORGEE_LIVE_DSH_WEB_PORT;
  delete process.env.BORGEE_CODEX_TEST_EXECUTABLE;
  delete process.env.BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST;
});

describe('live DSH Lab composition', () => {
  it('validates the complete compatibility authority before constructing either Provider', async () => {
    const root = mkdtempSync(join(tmpdir(), 'borgee-live-compatibility-'));
    roots.push(root);
    const manifest = join(root, 'compatibility.json');
    writeFileSync(manifest, JSON.stringify({ schemaVersion: 2 }));
    process.env.BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST = manifest;
    process.env.BORGEE_LIVE_DSH_WORKSPACE = '/tmp/borgee-live-composition';
    process.env.BORGEE_CODEX_TEST_EXECUTABLE = '/tmp/codex';

    await expect(apply({} as never)).rejects.toThrow('schemaVersion 1');
    expect(composition.providerFactory).not.toHaveBeenCalled();
    expect(composition.codexFactory).not.toHaveBeenCalled();
  });

  it.each([
    ['ordinary conversations', undefined, undefined, undefined],
    ['explicit plan approval fixture', '1', undefined, undefined],
    ['isolated conversations', undefined, '4914', '5176'],
    ['default HTTP origin', undefined, '4914', '80'],
  ])('preserves model defaults and applies only requested planning for %s', async (_scenario, planModeFixture, relayPort, webPort) => {
    if (relayPort !== undefined) process.env.BORGEE_LIVE_DSH_RELAY_PORT = relayPort;
    if (webPort !== undefined) process.env.BORGEE_LIVE_DSH_WEB_PORT = webPort;
    if (planModeFixture !== undefined) process.env.BORGEE_LIVE_DSH_PLAN_MODE = planModeFixture;
    const received: AgentSessionConfig[] = [];
    const provider = fakeProvider(received);
    composition.providerFactory.mockReturnValue(provider);
    composition.codexFactory.mockResolvedValue({
      provider: fakeCodexProvider(),
      close: async () => undefined,
    });
    process.env.BORGEE_LIVE_DSH_WORKSPACE = '/tmp/borgee-live-composition';
    process.env.BORGEE_CODEX_TEST_EXECUTABLE = '/tmp/codex';
    const setPlanMode = vi.fn();
    const context = {
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'mock', model: 'fixture-model', reasoningEffort: 'high' }),
      },
      planMode: { set: setPlanMode },
      effect(cleanup: () => () => Promise<void>) { composition.cleanup = cleanup(); },
    };

    await apply(context as never);
    expect(composition.providerFactory).toHaveBeenCalledWith(context, expect.objectContaining({ setup: expect.any(Function) }));
    expect(composition.codexFactory).toHaveBeenCalledWith(expect.objectContaining({
      executable: '/tmp/codex',
      compatibility: expect.objectContaining({
        borgee: expect.objectContaining({ sourceState: 'working_tree' }),
      }),
    }));
    expect(composition.liveRequest).toBeTypeOf('function');
    const labOrigin = webPort === '80' ? 'http://127.0.0.1' : `http://127.0.0.1:${webPort ?? '6175'}`;
    expect(composition.labOrigin).toBe(labOrigin);
    expect(composition.listen).toHaveBeenCalledExactlyOnceWith(Number(relayPort ?? '5910'), '127.0.0.1');
    const setup = composition.providerFactory.mock.calls[0]?.[1]?.setup as ((context: object, request: object) => void) | undefined;
    const agent = { sessionId: 'live-session' };
    setup?.({ agent }, { kind: 'create', config: { sessionId: 'live-session' } });
    if (planModeFixture === '1') expect(setPlanMode).toHaveBeenCalledExactlyOnceWith(agent, true);
    else expect(setPlanMode).not.toHaveBeenCalled();
    setPlanMode.mockClear();
    setup?.({ agent }, { kind: 'resume', handle: { providerId: 'dsh', sessionId: 'live-session', opaque: 'saved-session' } });
    expect(setPlanMode).not.toHaveBeenCalled();
    expect(composition.providers.map(({ descriptor }) => descriptor)).toEqual([
      { providerId: 'dsh', displayName: 'Live DSH' },
      { providerId: 'codex', displayName: 'Codex (fixture)' },
    ]);
    const selected = composition.providers[0];
    if (!selected) throw new Error('Live DSH Provider was not registered.');
    await selected.createSession({ sessionId: 'live-session' });
    expect(received).toEqual([{
      sessionId: 'live-session', cwd: '/tmp/borgee-live-composition',
      model: 'fixture-model', reasoningEffort: 'high',
    }]);
    const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
    composition.liveRequest?.({ url: '/v1/lab/live/live-session/stop-reader', method: 'POST', headers: { origin: labOrigin } }, response);
    expect(response.writeHead).toHaveBeenLastCalledWith(204);
    expect(composition.stopReader).toHaveBeenCalledTimes(1);
    composition.liveRequest?.({ url: '/v1/lab/live/live-session/stop-reader', method: 'POST', headers: { origin: 'http://localhost:5175' } }, response);
    expect(response.writeHead).toHaveBeenLastCalledWith(403);
    expect(composition.stopReader).toHaveBeenCalledTimes(1);
  });

  it.each(['BORGEE_LIVE_DSH_RELAY_PORT', 'BORGEE_LIVE_DSH_WEB_PORT'])('rejects invalid ports before constructing Providers for %s', async (environment) => {
    process.env.BORGEE_LIVE_DSH_WORKSPACE = '/tmp/borgee-live-composition';
    process.env.BORGEE_CODEX_TEST_EXECUTABLE = '/tmp/codex';
    for (const value of ['0', '65536', '4914.5', '1e3', ' 4914', '']) {
      process.env[environment] = value;
      await expect(apply({} as never)).rejects.toThrow(`${environment} must be an integer from 1 to 65535.`);
      expect(composition.providerFactory).not.toHaveBeenCalled();
      expect(composition.codexFactory).not.toHaveBeenCalled();
    }
  });

  it('installs the current model selection while composing a shared Web Agent', async () => {
    const shared = sharedComposition();
    await apply(shared.context as never, { runtimeMode: 'shared-web' });
    const provider = composition.providers[0]!;
    await provider.createSession({ sessionId: 'shared-session' });
    expect(shared.received).toEqual([{ sessionId: 'shared-session', cwd: '/tmp/borgee-live-composition' }]);
    expect(shared.presetRequests).toEqual([undefined]);
    expect(shared.events).toEqual([{ type: 'agent-preset/selected', data: { agentPreset: 'standard' } }]);
    expect(composition.installModelSelection).toHaveBeenCalledOnce();
    expect(composition.installModelSelection).toHaveBeenCalledWith(expect.any(Object), {
      current: { provider: 'gateway', model: 'default-model' }, assembled: undefined,
    });
    expect(composition.providerFactory.mock.calls[0]?.[1]?.interactions).toBe(composition.interactions);
  });

  it('runs shared Web without a Codex executable when the fixture is disabled', async () => {
    const shared = sharedComposition();
    delete process.env.BORGEE_CODEX_TEST_EXECUTABLE;
    const compatibilityManifest = process.env.BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST;
    process.env.BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST = '/missing/ambient-manifest.json';
    await apply(shared.context as never, { runtimeMode: 'shared-web', codexFixture: false, compatibilityManifest });
    expect(composition.codexFactory).not.toHaveBeenCalled();
    expect(composition.providers.map(({ descriptor }) => descriptor.providerId)).toEqual(['dsh']);
    await composition.providers[0]!.createSession({ sessionId: 'shared-session' });
    expect(shared.received).toEqual([{ sessionId: 'shared-session', cwd: '/tmp/borgee-live-composition' }]);
  });

  it.each([{ model: 'custom-model' }, { reasoningEffort: 'high' }])('rejects an explicit shared model selection without changing native defaults: %j', async (override) => {
    const shared = sharedComposition();
    await apply(shared.context as never, { runtimeMode: 'shared-web' });
    await expect(composition.providers[0]!.createSession({ sessionId: 'shared-session', ...override })).rejects.toThrow('DSH Web');
    expect(shared.received).toEqual([]);
  });

  it('restores the recorded preset without appending another preset selection', async () => {
    const shared = sharedComposition();
    shared.events.push({ type: 'agent-preset/selected', data: { agentPreset: 'reviewer' } });
    await apply(shared.context as never, { runtimeMode: 'shared-web' });
    await composition.providers[0]!.resumeSession({ providerId: 'dsh', sessionId: 'shared-session', opaque: 'dsh:shared-session' });
    expect(shared.presetRequests).toEqual(['reviewer']);
    expect(shared.events).toEqual([{ type: 'agent-preset/selected', data: { agentPreset: 'reviewer' } }]);
  });

  it('keeps an already composed Agent on its mounted preset', async () => {
    const shared = sharedComposition();
    shared.composedPreset = 'reviewer';
    await apply(shared.context as never, { runtimeMode: 'shared-web' });
    await composition.providers[0]!.resumeSession({ providerId: 'dsh', sessionId: 'shared-session', opaque: 'dsh:shared-session' });
    expect(shared.presetRequests).toEqual([]);
  });

  it('rejects shared mode before native creation when the Web services are absent', async () => {
    const shared = sharedComposition();
    await expect(apply({ ...shared.context, sessionController: undefined } as never, { runtimeMode: 'shared-web' })).rejects.toThrow('sessionController');
    expect(shared.received).toEqual([]);
  });

  it('propagates preset setup failure before Web model initialization', async () => {
    const shared = sharedComposition();
    shared.context.agentPresets.mount = async () => { throw new Error('Preset composition failed'); };
    await apply(shared.context as never, { runtimeMode: 'shared-web' });
    await expect(composition.providers[0]!.createSession({ sessionId: 'shared-session' })).rejects.toThrow('Preset composition failed');
    expect(shared.liveSessions.size).toBe(0);
    expect(shared.events).toEqual([]);
  });



});

function fakeProvider(received: AgentSessionConfig[]): AgentProviderAdapter {
  return {
    descriptor: { providerId: 'dsh', displayName: 'Live DSH' },
    async createSession(config) {
      received.push(config);
      return {
        capabilities: {
          history: true, sendMessage: true, steer: true, cancel: true, readResource: true,
          interactions: { question: true, planApproval: true, toolApproval: true },
        },
        async *observe() { yield { type: 'history_boundary' as const }; },
        async sendMessage() {}, async respondToInteraction() {}, async steer() {}, async cancel() {},
        async readResource() { return { status: 'unavailable' as const, reason: 'fixture' }; },
        async runtimeInfo() { return { providerId: 'dsh', sessionId: config.sessionId, status: 'idle' as const }; },
        async dispose() {},
        stopGeneratedResourceReader: composition.stopReader,
      };
    },
    async resumeSession() { throw new Error('not used'); },
  };
}

function fakeCodexProvider(): AgentProviderAdapter {
  return {
    descriptor: { providerId: 'codex', displayName: 'Codex (fixture)' },
    async createSession() { throw new Error('not used'); },
    async resumeSession() { throw new Error('not used'); },
  };
}

function sharedComposition() {
  process.env.BORGEE_LIVE_DSH_WORKSPACE = '/tmp/borgee-live-composition';
  process.env.BORGEE_CODEX_TEST_EXECUTABLE = '/tmp/codex';
  const shared = {
    received: [] as AgentSessionConfig[],
    disposed: [] as string[],
    liveSessions: new Set<string>(),
    events: [] as Array<{ type: string; data: { agentPreset: string } }>,
    presetRequests: [] as Array<string | undefined>,
    composedPreset: undefined as string | undefined,
  };
  const context = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'gateway', model: 'default-model' }) },
    agentPresets: {
      composedPreset: () => shared.composedPreset,
      async mount(_context: unknown, preset?: string) {
        shared.presetRequests.push(preset);
        return { id: preset ?? 'standard' };
      },
    },
    sessionController: {
      async modelCatalog() { return { default: { provider: 'gateway', model: 'default-model' }, routableProviders: [], groups: [], failures: [] }; },
    },
    effect(cleanup: () => () => Promise<void>) { composition.cleanup = cleanup(); },
  };
  composition.providerFactory.mockImplementation((_context, options) => {
    const provider = fakeProvider(shared.received);
    const open = async (config: AgentSessionConfig, kind: 'create' | 'resume') => {
      const session = await provider.createSession(config);
      await options.setup({
        agent: { session: {
          header: {}, events: shared.events,
          snapshotEvents() { return this.events; },
          append(type: string, data: { agentPreset: string }) { shared.events.push({ type, data }); },
        } },
      }, kind === 'create' ? { kind, config } : { kind, handle: { providerId: 'dsh', sessionId: config.sessionId, opaque: `dsh:${config.sessionId}` } });
      shared.liveSessions.add(config.sessionId);
      return { ...session, async dispose() { shared.liveSessions.delete(config.sessionId); shared.disposed.push(config.sessionId); } };
    };
    return {
      descriptor: provider.descriptor,
      createSession: (config: AgentSessionConfig) => open(config, 'create'),
      resumeSession: (handle: { sessionId: string }) => open({ sessionId: handle.sessionId }, 'resume'),
    };
  });
  composition.codexFactory.mockResolvedValue({ provider: fakeCodexProvider(), close: async () => undefined });
  return Object.assign(shared, { context });
}

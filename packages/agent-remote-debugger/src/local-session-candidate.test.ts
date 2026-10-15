import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { AgentRuntimeError, type AgentPersistenceHandle, type AgentSession, type AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
import { createAgentRemoteRelay } from '@orchardworks/agent-remote-relay';
import { LocalSessionSuccession } from './local-session-succession.js';
// @ts-expect-error Test-only native fixture shared with installed-package smoke.
import { createPrefixAdapter } from './fixtures/prefix-adapter.mjs';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); }, 5000);
async function fixture(mode: 'unavailable' | 'settings' | 'identity' | 'oversized') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-local-candidate-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const adapter = createPrefixAdapter(root), directory = join(root, 'state');
  cleanups.push(() => adapter.dispose());
  const originalFork = adapter.forkForPromptEdit.bind(adapter), resume = adapter.resumeSession.bind(adapter);
  let offered: AgentPersistenceHandle | undefined, checkpoint: any;
  const resumed: AgentPersistenceHandle[] = [];
  adapter.resumeSession = async (handle: AgentPersistenceHandle, extensions?: AgentSessionExtensions) => { resumed.push(structuredClone(handle)); return resume(handle, extensions); };
  adapter.forkForPromptEdit = async (target: unknown, extensions: AgentSessionExtensions, candidateKnown?: (handle: AgentPersistenceHandle) => Promise<void>) => {
    const session: AgentSession = await originalFork(target, extensions);
    offered = (await session.runtimeInfo()).persistence!;
    try {
      await candidateKnown?.(mode === 'oversized' ? { ...offered, opaque: 'x'.repeat(16384) } : offered);
      checkpoint = JSON.parse(await readFile(join(directory, 'roles', 'state.json'), 'utf8'));
      if (mode === 'unavailable') throw new AgentRuntimeError('native_runtime_unavailable', 'Post-fork bootstrap read unavailable');
      if (mode === 'settings' || mode === 'identity') return new Proxy(session, { get(target, property) {
        if (property === 'runtimeInfo') return async () => {
          const info = await target.runtimeInfo();
          return mode === 'settings' ? { ...info, persistence: { ...info.persistence!, opaque: JSON.stringify({ cwd: root, changedSettings: true }) } }
            : { ...info, sessionId: 'different', persistence: { ...info.persistence!, sessionId: 'different' } };
        };
        const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
      return session;
    } catch (error) { await session.dispose(); throw error; }
  };
  const make = () => {
    const local = new LocalSessionSuccession(directory, 'local-test', [adapter]);
    const relay = createAgentRemoteRelay({ providers: local.providers, operationCache: local.operationCache, operationLifecycle: local.operationLifecycle });
    local.bindRelay(relay);
    const close = async () => { await relay.close(); await local.close(); };
    cleanups.push(close);
    return { local, relay, close };
  };
  let runtime = make();
  const ref = (id: string) => runtime.local.ref(adapter.descriptor.providerId, id);
  await runtime.local.providers[0]!.createSession({ sessionId: 'source', cwd: root });
  const sourceSession = await runtime.local.providers[0]!.createSession({ sessionId: 'A', cwd: root, sourceNativeSessionId: 'source' } as never);
  const sourceHandle = (await sourceSession.runtimeInfo()).persistence!;
  const attach = async (id: string) => {
    const agentId = await runtime.local.attach(ref(id)), agent = runtime.relay.requireAgent(agentId);
    const deadline = Date.now() + 3000;
    while (!agent.handoffAdmissionState().synchronized) { if (Date.now() >= deadline) throw new Error('Local source synchronization deadline exceeded'); await new Promise(resolve => setTimeout(resolve, 5)); }
    return agent;
  };
  await attach('A');
  const role = await runtime.local.ensureRole(ref('A'));
  const request = { operationId: 'edit', roleId: role.id, expectedRevision: 1, from: ref('A'), preparation: { kind: 'native_prefix', turnId: 'turn', messageId: 'message-1' } };
  const action = (name: string) => runtime.local.action(name, name === 'prepare' ? request : { operationId: 'edit', expectedRevision: 1 }, role);
  return { adapter, action, attach, ref, root, role, sourceHandle, offered: () => offered!, checkpoint: () => checkpoint, resumed, local: () => runtime.local,
    restart: async () => { await runtime.close(); runtime = make(); await runtime.local.service.ready; await attach('A'); },
    disk: async () => JSON.parse(await readFile(join(directory, 'roles', 'state.json'), 'utf8')) };
}

test.each([false, true])('local runtime retains a failed-bootstrap candidate and its original capture (restart=%s)', async restart => {
  const f = await fixture('unavailable'), original = structuredClone((await f.adapter.state()).sessions.A);
  expect(await f.action('prepare')).toMatchObject({ record: { phase: 'unknown', to: f.ref('candidate-1') } });
  expect(f.checkpoint().roles[0].localPreparations[0]).toMatchObject({ stage: 'candidate-known', nativePrefix: { handle: f.offered() } });
  const capture = f.local().service.store.progress('edit')!.capture;
  if (restart) await f.restart();
  for (const id of ['A', 'candidate-1']) {
    await f.attach(id);
    expect(() => f.local().service.coordinator.assertAdmission(f.ref(id))).toThrow(/reserved/);
  }
  const candidate = await f.local().providers[0]!.resumeSession(f.offered());
  const source = await f.local().providers[0]!.resumeSession(f.sourceHandle);
  await expect(source.sendMessage('blocked')).rejects.toThrow(/reserved/);
  await expect(candidate.sendMessage('blocked')).rejects.toThrow(/reserved/);
  await expect(f.adapter.readSource('candidate-1', {})).rejects.toThrow(/reserved|current/);
  await expect(f.action('commit')).rejects.toThrow(/not ready/);
  expect(await f.action('reconcile')).toMatchObject({ record: { phase: restart ? 'rejected' : 'ready', ...(restart ? { failureCode: 'succession_boundary_changed' } : {}), to: f.ref('candidate-1') } });
  expect(f.local().service.store.nativePrefixHandle('edit')).toEqual(f.offered());
  expect(f.local().service.store.progress('edit')!.capture).toEqual(capture);
  expect(f.resumed.filter(handle => handle.sessionId === 'candidate-1')).toEqual([f.offered()]);
  expect((await f.adapter.state()).forks).toBe(1); expect((await f.adapter.state()).sessions.A).toEqual(original);
  expect((await f.adapter.state()).sessions['candidate-1'].inputs).toEqual([]);
  if (!restart) {
    await f.action('commit');
    expect(JSON.parse(await f.adapter.readSource('candidate-1', {}))).toMatchObject({ sourceSessionId: 'source' });
  }
}, 15000);

test('local runtime keeps the exact checkpoint when final runtime settings change', async () => {
  const f = await fixture('settings');
  expect(await f.action('prepare')).toMatchObject({ record: { phase: 'ready', to: f.ref('candidate-1') } });
  expect(f.local().service.store.nativePrefixHandle('edit')).toEqual(f.offered());
  await f.action('commit');
  expect(JSON.parse(await f.adapter.readSource('candidate-1', {}))).toMatchObject({ sourceSessionId: 'source' });
  await f.restart(); await f.attach('candidate-1');
  expect(JSON.parse(await f.adapter.readSource('candidate-1', {}))).toMatchObject({ sourceSessionId: 'source' });
  expect(f.resumed.filter(handle => handle.sessionId === 'candidate-1')).toEqual([f.offered()]);
  expect((await f.adapter.state()).forks).toBe(1);
}, 15000);

test('local runtime rejects a different final native identity and preserves the original candidate', async () => {
  const f = await fixture('identity');
  expect(await f.action('prepare')).toMatchObject({ record: { phase: 'rejected', to: f.ref('candidate-1') } });
  expect(f.local().service.store.nativePrefixHandle('edit')).toEqual(f.offered());
  expect((await f.adapter.state()).forks).toBe(1);
}, 10000);

test('local runtime rejects an oversized checkpoint without guessing or repeating native creation', async () => {
  const f = await fixture('oversized');
  expect(await f.action('prepare')).toMatchObject({ record: { phase: 'unknown' } });
  expect((await f.disk()).roles[0].localPreparations[0]).toMatchObject({ stage: 'create-started' });
  expect(f.local().service.store.nativePrefixHandle('edit')).toBeUndefined();
  await expect(f.action('reconcile')).rejects.toThrow(/creation is unknown/);
  expect((await f.adapter.state()).forks).toBe(1);
}, 10000);

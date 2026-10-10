import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import type { AgentSession, AgentCapabilities, AgentRuntimeInfo, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { PROTOCOL_VERSION, type ServerMessage } from '@orchardworks/agent-remote-protocol';
import { createAgentRemoteHttpServer, type OperationCacheOptions } from '@orchardworks/agent-remote-relay';
import { createAgentHostRuntime } from './host.js';
import { SessionSuccessionStore } from './session-succession-store.js';
import { SessionSuccessionBoundary } from './session-succession-boundary.js';

const ref = (nativeSessionId: string) => ({ controllerId: 'controller', providerId: 'fixture', nativeSessionId });
const operationId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

class Native implements AgentSession {
  capabilities: AgentCapabilities = { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
    sessionSettings: true, interactions: { question: false, toolApproval: false, planApproval: false } };
  value = 'first';
  calls: string[] = [];
  apply: NonNullable<AgentSession['setSessionSetting']> = async () => ({ status: 'pending' });
  read: () => Promise<void> = async () => {};
  private readonly stopped = gate();
  constructor(readonly id: string, readonly cwd: string) {}
  async runtimeInfo(): Promise<AgentRuntimeInfo> {
    await this.read();
    return { providerId: 'fixture', sessionId: this.id, status: 'idle', cwd: this.cwd, settings: [
      { id: 'model', category: 'model', label: 'Model', value: this.value, mutable: true, scope: 'session',
        options: ['first', 'second', 'third'].map(value => ({ value, label: value })) },
    ] };
  }
  async *observe(): AsyncIterable<ProviderStreamItem> { yield { type: 'history_boundary' }; await this.stopped.promise; }
  async setSessionSetting(id: string, value: string) { this.calls.push(value); return this.apply(id, value); }
  async sendMessage() {}
  async respondToInteraction() {}
  async dispose() { this.stopped.resolve(); }
}

async function fixture(operationCache?: OperationCacheOptions) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-setting-mutation-')));
  const store = new SessionSuccessionStore(join(root, 'roles')); await store.ready;
  await store.createRole({ id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace: { controllerId: 'controller', canonicalCwd: root } });
  const sessions = new Map(['A', 'C'].map(id => [id, new Native(id, root)]));
  let creates = 0;
  const host = createAgentHostRuntime({ operationCache, succession: { controllerId: 'controller', stateDirectory: root, native: {
    supports: async () => true,
    inspect: async () => ({ cwd: root, idle: true, managed: true, pendingInputs: 0, pendingInteractions: 0, activeChildren: 0 }),
    createIdle: async () => { creates++; sessions.set('B', new Native('B', root)); return ref('B'); },
    reconcileDelivery: async () => undefined,
  } }, registrations: [{ adapter: { descriptor: { providerId: 'fixture', displayName: 'Fixture' },
    createSession: async () => { throw new Error('unexpected create'); }, resumeSession: async () => { throw new Error('unexpected resume'); },
    readSessionHistory: async () => ({ entries: [] }) }, directory: { providerId: 'fixture', list: () => [], workspaces: () => [],
    create: async () => { throw new Error('unexpected directory create'); }, open: async id => sessions.get(id)!,
    sessionWorkspace: async () => root, sourceReferences: async () => [], setSourceBindingReader: () => {},
    close: async () => { await Promise.all([...sessions.values()].map(session => session.dispose())); },
  } }] });
  const server = createAgentRemoteHttpServer(host.relay, { websocketAuthorizer: { authenticate: () => ({ subject: 'owner' }), authorize: () => true } });
  const { url } = await server.listen(0);
  async function attach(id: string) {
    const result = await host.control({ method: 'POST', path: '/remote/attach', sessionId: id, body: JSON.stringify({ providerId: 'fixture', nativeSessionId: id }) });
    expect(result.status).toBe(200); const { agentId } = JSON.parse(result.body);
    return host.relay.requireAgent(agentId);
  }
  async function control(action: string, body: unknown) {
    const result = await host.control({ method: 'POST', path: `/remote/succession/${action}`, sessionId: 'owner', body: JSON.stringify(body) });
    return { status: result.status, payload: JSON.parse(result.body) };
  }
  return { host, sessions, url, attach, control, creates: () => creates,
    prepare: (id = 'handoff') => control('prepare', { operationId: id, roleId: 'role', expectedRevision: 1, from: ref('A') }),
    async close() { await server.close(); await host.close(); await rm(root, { recursive: true, force: true }); },
  };
}

async function setting(url: string, agentId: string, value: string, id: string) {
  const socket = new WebSocket(`${url.replace('http', 'ws')}/v1/sessions/${agentId}/events`);
  const messages: ServerMessage[] = [];
  const listeners = new Set<() => void>();
  socket.on('message', data => { messages.push(JSON.parse(data.toString())); for (const listener of listeners) listener(); });
  const next = (matches: (message: ServerMessage) => boolean): Promise<ServerMessage> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error('WebSocket response deadline exceeded')); }, 3000);
    function check() { const index = messages.findIndex(matches); if (index < 0) return;
      clearTimeout(timer); listeners.delete(check); resolve(messages.splice(index, 1)[0]!); }
    listeners.add(check); check();
  });
  try {
    await once(socket, 'open', { signal: AbortSignal.timeout(3000) });
    socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' }));
    await next(message => message.type === 'agent_snapshot');
    const state = await next(message => message.type === 'session_control');
    if (state.type !== 'session_control') throw new Error('Missing control');
    socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'session_control_request',
      payload: { agentId, requestId: 'control', action: 'take_over', revision: state.payload.revision } }));
    const granted = await next(message => message.type === 'session_control' && message.payload.requestId === 'control');
    if (granted.type !== 'session_control') throw new Error('Missing grant');
    socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'set_session_setting', controlToken: granted.payload.token,
      payload: { agentId, operationId: id, requestId: id, settingId: 'model', value } }));
    return await next(message => (message.type === 'protocol_error' || message.type === 'command_acknowledged') && message.payload.requestId === id);
  } finally {
    const closed = once(socket, 'close', { signal: AbortSignal.timeout(3000) }); socket.terminate(); await closed;
  }
}

// Advancing only timers keeps loopback sockets and file I/O on the real event loop.
async function expireSettings() { await vi.advanceTimersByTimeAsync(30_001); }

test.each(['wire', 'internal'] as const)('pending setting evidence survives the UI deadline and blocks Host handoff: %s', async mode => {
  const f = await fixture(); const agent = await f.attach('A');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    if (mode === 'wire') expect(await setting(f.url, agent.agentId, 'second', operationId(8))).toMatchObject({ type: 'command_acknowledged' });
    else await agent.setSessionSetting('model', 'second');
    await expireSettings();
    expect(agent.snapshot().payload.settingChanges).toMatchObject([{ status: 'timed_out', confirmedValue: 'first' }]);
    vi.useRealTimers();
    expect((await f.prepare()).payload.phase).toBe('rejected');
    expect(f.creates()).toBe(0); expect(f.sessions.get('A')!.calls).toEqual(['second']);
  } finally { vi.useRealTimers(); await f.close(); }
}, 10000);

test('authenticated setting retries retain one receipt and handoff reservation rejects fresh settings', async () => {
  const f = await fixture();
  try {
    const agent = await f.attach('A');
    expect((await f.prepare()).payload.phase).toBe('ready');
    expect(await setting(f.url, agent.agentId, 'second', operationId(1))).toMatchObject({ type: 'protocol_error' });
    expect(f.sessions.get('A')!.calls).toEqual([]);
    await f.control('cancel', { operationId: 'handoff' });
    expect(await setting(f.url, agent.agentId, 'second', operationId(2))).toMatchObject({ type: 'command_acknowledged' });
    const receipt = agent.snapshot().payload.settingChanges?.[0]?.requestId;
    expect(await setting(f.url, agent.agentId, 'second', operationId(2))).toMatchObject({ type: 'command_acknowledged' });
    expect(agent.snapshot().payload.settingChanges?.[0]?.requestId).toBe(receipt);
    expect(f.sessions.get('A')!.calls).toEqual(['second']);
    expect((await f.prepare('after-setting')).payload.phase).toBe('rejected');
    const unrelated = await f.attach('C');
    expect(await setting(f.url, unrelated.agentId, 'second', operationId(9))).toMatchObject({ type: 'command_acknowledged' });
    expect(agent.snapshot().payload.runtimeInfo.sessionId).toBe('A');
  } finally { await f.close(); }
}, 10000);

test('accepted queued WebSocket settings survive disconnected leases and restore their original operation entries', async () => {
  const f = await fixture(); const first = gate(), second = gate();
  const entries = new Map<string, string>(); const calls: Array<{ value: string; entry?: string }> = [];
  let boundary!: SessionSuccessionBoundary;
  const original = SessionSuccessionBoundary.prototype.run;
  const spy = vi.spyOn(SessionSuccessionBoundary.prototype, 'run').mockImplementation(function (operation, scope, work, entry) {
    boundary = this; if (entry) entries.set(operation.operationId, entry.key);
    return original.call(this, operation, scope, work, entry);
  });
  try {
    const agent = await f.attach('A'); const native = f.sessions.get('A')!;
    native.apply = async (_id, value) => { calls.push({ value, entry: boundary.currentEntry()?.key });
      await (value === 'second' ? first.promise : second.promise); native.value = value; };
    expect(await setting(f.url, agent.agentId, 'second', operationId(3))).toMatchObject({ type: 'command_acknowledged' });
    expect(await setting(f.url, agent.agentId, 'third', operationId(4))).toMatchObject({ type: 'command_acknowledged' });
    expect(native.calls).toEqual(['second']);
    expect((await f.prepare()).payload.phase).toBe('rejected'); expect(f.creates()).toBe(0);
    first.resolve(); await expect.poll(() => native.calls).toEqual(['second', 'third']);
    expect(calls).toEqual([{ value: 'second', entry: entries.get(operationId(3)) }, { value: 'third', entry: entries.get(operationId(4)) }]);
    expect(agent.snapshot().payload.settingChanges).toMatchObject([{ targetValue: 'third', status: 'pending' }]);
    second.resolve(); await expect.poll(() => agent.snapshot().payload.settingChanges).toEqual([]);
    expect((await f.prepare('after-native-completion')).payload.phase).toBe('ready');
  } finally { first.resolve(); second.resolve(); spy.mockRestore(); await f.close(); }
}, 10000);

test('the fresh Host gate still rejects an accepted queued intent after its wire disconnects', async () => {
  const f = await fixture(); const first = gate();
  let boundary!: SessionSuccessionBoundary;
  const original = SessionSuccessionBoundary.prototype.run;
  const spy = vi.spyOn(SessionSuccessionBoundary.prototype, 'run').mockImplementation(function (operation, scope, work, entry) {
    boundary = this; return original.call(this, operation, scope, work, entry);
  });
  try {
    const agent = await f.attach('A'); const native = f.sessions.get('A')!;
    native.apply = async (_id, value) => { if (value === 'second') await first.promise; native.value = value; };
    await setting(f.url, agent.agentId, 'second', operationId(5));
    await setting(f.url, agent.agentId, 'third', operationId(6));
    // Candidate registration can race accepted work while another source is being prepared.
    await f.attach('C');
    boundary.reserve('candidate-handoff', ref('C'));
    expect(boundary.registerCandidate('candidate-handoff', ref('A'))).toEqual({ conflict: true });
    expect(() => boundary.assertCommit('candidate-handoff')).toThrow();
    first.resolve();
    await expect.poll(() => agent.snapshot().payload.settingChanges?.[0]?.status).toBe('failed');
    expect(native.calls).toEqual(['second']);
    boundary.releaseReservation('candidate-handoff');
  } finally { first.resolve(); spy.mockRestore(); await f.close(); }
}, 10000);

test('native completion remains settled when local acceptance receipt publication fails', async () => {
  const f = await fixture(); const publication = gate(), entered = gate();
  try {
    const agent = await f.attach('A'); const native = f.sessions.get('A')!;
    native.apply = async (_id, value) => { native.value = value; };
    const original = agent.setSessionSetting.bind(agent);
    agent.setSessionSetting = async (...args) => { await original(...args); entered.resolve(); await publication.promise; throw new Error('Local receipt publication failed'); };
    const settingReceipt = setting(f.url, agent.agentId, 'second', operationId(7)); await entered.promise;
    await expect.poll(() => agent.snapshot().payload.settingChanges).toEqual([]);
    expect((await f.prepare()).payload.phase).toBe('rejected');
    publication.resolve();
    expect(await settingReceipt).toMatchObject({ type: 'protocol_error', payload: { code: 'operation_outcome_unknown' } });
    expect((await f.prepare('known-native-completed')).payload.phase).toBe('ready');
    expect(native.calls).toEqual(['second']);
  } finally { publication.resolve(); await f.close(); }
}, 10000);

test('ordinary receipt expiry preserves Host setting admission and a later candidate fence', async () => {
  let now = 1000;
  const f = await fixture({ ttlMs: 100, now: () => now });
  let boundary!: SessionSuccessionBoundary;
  const original = SessionSuccessionBoundary.prototype.run;
  const spy = vi.spyOn(SessionSuccessionBoundary.prototype, 'run').mockImplementation(function (operation, scope, work, entry) {
    boundary = this; return original.call(this, operation, scope, work, entry);
  });
  try {
    const agent = await f.attach('A'); await f.attach('C'); const native = f.sessions.get('A')!;
    native.apply = async () => ({ status: 'deferred' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    expect(await setting(f.url, agent.agentId, 'second', operationId(10))).toMatchObject({ type: 'command_acknowledged' });
    const accepted = agent.snapshot().payload.settingChanges?.[0]?.requestId;
    now += 101;
    expect((await f.prepare('after-receipt-expiry')).payload.phase).toBe('rejected');
    expect(f.creates()).toBe(0);
    expect(agent.snapshot().payload.settingChanges).toMatchObject([{ requestId: accepted, status: 'pending' }]);
    boundary.reserve('later-candidate', ref('C')); boundary.registerCandidate('later-candidate', ref('A'));
    expect(() => boundary.assertCommit('later-candidate')).toThrow();
    native.value = 'third'; await vi.advanceTimersByTimeAsync(1001);
    expect(agent.snapshot().payload.settingChanges).toMatchObject([{ requestId: accepted, status: 'failed', code: 'succession_admission_closed' }]);
    expect(native.calls).toEqual(['second']);
    boundary.releaseReservation('later-candidate');
  } finally { vi.useRealTimers(); spy.mockRestore(); await f.close(); }
}, 10000);

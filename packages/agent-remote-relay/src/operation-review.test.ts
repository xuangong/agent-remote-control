import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { AgentOperationRejectedError, type AgentProviderAdapter, type AgentSession } from '@orchardworks/agent-provider-sdk';
import { createAgentRemoteRelay } from './relay.js';
import { createAgentRemoteHttpServer } from './transport/http-server.js';
import { createOperationCache } from './operation-cache.js';
import { AgentBusyError, UnsupportedAgentCapabilityError } from './agent-manager.js';

function provider(commands = false) {
  let creates = 0, resumes = 0, disposed = 0;
  let uncertain = false;
  const sessions: AgentSession[] = [];
  const make = (id: string): AgentSession => {
    let finish!: () => void; const closed = new Promise<void>(resolve => { finish = resolve; });
    const session: AgentSession = {
      capabilities: { commands, history: false, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, toolApproval: false, planApproval: false } },
      async *observe() { yield { type: 'history_boundary' }; await closed; },
      async sendMessage() { await closed; }, async respondToInteraction() {},
      async runtimeInfo() { return { providerId: 'test', sessionId: id, status: 'idle', persistence: { providerId: 'test', sessionId: id, opaque: '{}' } }; },
      async dispose() { disposed++; finish(); },
    }; sessions.push(session); return session;
  };
  const adapter: AgentProviderAdapter = { descriptor: { providerId: 'test', displayName: 'Test' },
    async createSession(config) { creates++; if (uncertain) throw new Error('Reply lost after native creation'); return make(config.sessionId); },
    async resumeSession(handle) { resumes++; if (uncertain) throw new Error('Reply lost after native restore'); return make(handle.sessionId); },
  };
  return { adapter, sessions, creates: () => creates, resumes: () => resumes, disposed: () => disposed, fail: () => { uncertain = true; } };
}

it('closes native sessions while settlement drains and shares shutdown completion', async () => {
  const native = provider(), relay = createAgentRemoteRelay({ providers: [native.adapter] });
  await relay.createAgent({ protocolVersion: '1.5.0', type: 'create_agent', payload: { requestId: 'create', operationId: randomUUID(), agentId: 'agent', providerId: 'test', config: { sessionId: 'native' } } });
  let started!: () => void; const dispatching = new Promise<void>(resolve => { started = resolve; });
  const pending = relay.executeOperation('owner')(relay.requireAgent('agent'), { operationId: randomUUID(), kind: 'send_message', parameters: {}, maximumResultBytes: 1024 }, { dispatch: async () => { started(); await native.sessions[0]!.sendMessage('hello'); } });
  await dispatching;
  const first = relay.close(), second = relay.close();
  expect(first).toBe(second);
  await Promise.all([first, second, pending]); expect(native.disposed()).toBe(1);
}, 2000);

it.each(['create_agent', 'resume_agent'] as const)('settles HTTP %s across correlation changes, conflicts, scopes and uncertain native errors', async type => {
  const native = provider(), relay = createAgentRemoteRelay({ providers: [native.adapter] });
  const server = createAgentRemoteHttpServer(relay, { websocketAuthorizer: { authenticate: request => ({ subject: String(request.headers['x-owner'] ?? 'owner') }), authorize: () => true } });
  const { url } = await server.listen(); const operationId = randomUUID();
  const payload = type === 'create_agent' ? { providerId: 'test', config: { sessionId: 'native' } } : { persistence: { providerId: 'test', sessionId: 'native', opaque: '{}' } };
  const post = async (requestId: string, agentId = 'agent', scope = 'owner', id = operationId, override = {}) => {
    const response = await fetch(url + (type === 'create_agent' ? '/v1/sessions' : '/v1/sessions/resume'), { method: 'POST', headers: { 'x-owner': scope }, body: JSON.stringify({ protocolVersion: '1.5.0', type, payload: { ...payload, agentId, requestId, operationId: id, ...override } }) });
    return { status: response.status, body: await response.json() };
  };
  const count = type === 'create_agent' ? native.creates : native.resumes;
  try {
    if (type === 'resume_agent') { const legacy = await post('legacy', 'legacy', 'legacy', operationId, { operationId: undefined }); expect(legacy.status).toBe(200); await relay.closeAgent('legacy'); }
    const baseline = count();
    const [first, retry] = await Promise.all([post('lost'), post('retry')]);
    expect(first.status).toBe(type === 'create_agent' ? 201 : 200); expect(retry.body.payload.requestId).toBe('retry'); expect(count()).toBe(baseline + 1);
    expect((await post('changed', 'different')).body.payload.code).toBe('operation_conflict');
    expect((await post('changed-input', 'agent', 'owner', operationId, type === 'create_agent' ? { config: { sessionId: 'other' } } : { persistence: { providerId: 'test', sessionId: 'other', opaque: '{}' } })).body.payload.code).toBe('operation_conflict');
    const foreign = await post('foreign', 'foreign', 'another'); expect(foreign.body.payload.requestId).toBe('foreign');
    native.fail(); const unknownId = randomUUID();
    const override = type === 'create_agent' ? { config: { sessionId: 'uncertain' } } : { persistence: { providerId: 'test', sessionId: 'uncertain', opaque: '{}' } };
    expect((await post('uncertain', 'uncertain', 'owner', unknownId, override)).body.payload.code).toBe('operation_outcome_unknown'); const before = count();
    expect((await post('uncertain-retry', 'uncertain', 'owner', unknownId, override)).body.payload.code).toBe('operation_outcome_unknown'); expect(count()).toBe(before);
  } finally { await server.close(); await relay.close(); }
}, 10000);

it.each([new UnsupportedAgentCapabilityError('queue_message'), new AgentBusyError()])('retains stable legacy validation error code', async error => {
  const cache = createOperationCache(); const descriptor = { operationId: randomUUID(), scope: 'scope', kind: 'send_message', target: 'native', parameters: {} };
  try {
    const work = { validate: () => { throw error; }, dispatch: async () => {} };
    await expect(cache.execute(descriptor, work)).rejects.toMatchObject({ code: error instanceof AgentBusyError ? 'agent_busy' : 'unsupported_command' });
    await expect(cache.execute(descriptor, work)).rejects.toMatchObject({ code: error instanceof AgentBusyError ? 'agent_busy' : 'unsupported_command' });
  } finally { await cache.close(); }
}, 1000);

it('rebuilds correlation for retained plugin creation receipts', async () => {
  const { createAgentRemotePluginHost } = await import('./transport/plugin-host.js');
  const native = provider(), relay = createAgentRemoteRelay({ providers: [native.adapter] });
  const output: any[] = [];
  const host = createAgentRemotePluginHost(relay, { agentId: 'agent', send: json => output.push(JSON.parse(json)), onFailure: error => { throw error; } });
  const operationId = randomUUID();
  const request = (id: string, sessionId = 'native') => host.receive(JSON.stringify({ uplinkVersion: 1, type: 'rpc_request', requestId: id, method: 'POST', path: '/v1/sessions', body: JSON.stringify({ protocolVersion: '1.5.0', type: 'create_agent', payload: { requestId: id, operationId, agentId: 'agent', providerId: 'test', config: { sessionId } } }) }));
  try {
    request('first'); request('retry');
    await expect.poll(() => output.length).toBe(2);
    expect(output.map(frame => JSON.parse(frame.body).payload.requestId).sort()).toEqual(['first', 'retry']);
    expect(native.creates()).toBe(1);
    request('changed', 'other'); await expect.poll(() => output.length).toBe(3);
    expect(JSON.parse(output.at(-1).body).payload.code).toBe('operation_conflict');
  } finally { host.close(); await relay.close(); }
}, 5000);

it.each([new UnsupportedAgentCapabilityError('queue_message'), new AgentBusyError()])('keeps both public validation receipts classified consistently', async error => {
  const { createSessionWire } = await import('./session-wire.js');
  const native = provider(), relay = createAgentRemoteRelay({ providers: [native.adapter] });
  await relay.createAgent({ protocolVersion: '1.5.0', type: 'create_agent', payload: { requestId: 'create', operationId: randomUUID(), agentId: 'agent', providerId: 'test', config: { sessionId: 'native' } } });
  const manager = relay.requireAgent('agent');
  manager.validateMessageContent = async () => { throw error; };
  const output: any[] = []; const operationId = randomUUID();
  const wire = createSessionWire(manager, json => output.push(JSON.parse(json)), { executeOperation: relay.executeOperation('owner') });
  try {
    await wire.receive(JSON.stringify({ protocolVersion: '1.5.0', type: 'negotiate' }));
    for (const requestId of ['first', 'retry']) await wire.receive(JSON.stringify({ protocolVersion: '1.5.0', type: 'send_message', payload: { agentId: 'agent', requestId, operationId, delivery: 'next_turn', content: [{ type: 'text', text: 'hello' }] } }));
    expect(output.filter(frame => frame.type === 'protocol_error').map(frame => ({ code: frame.payload.code, recoverable: frame.payload.recoverable }))).toEqual([{ code: error.code, recoverable: true }, { code: error.code, recoverable: true }]);
  } finally { wire.close(); await relay.close(); }
}, 5000);

it.each(['create_agent', 'resume_agent'] as const)('owns %s sessions before their first history boundary and disposes late returns', async type => {
  for (const stage of ['boundary', 'late', 'runtime']) {
    const late = stage === 'late';
    let returned!: () => void, release!: () => void, finish!: () => void;
    const nativeReturned = new Promise<void>(resolve => { returned = resolve; });
    const allowed = new Promise<void>(resolve => { release = resolve; });
    const disposed = new Promise<void>(resolve => { finish = resolve; }); let disposeCount = 0;
    const session: AgentSession = {
      capabilities: { history: false, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, toolApproval: false, planApproval: false } },
      async *observe() { await disposed; }, async sendMessage() {}, async respondToInteraction() {},
      async runtimeInfo() { if (stage === 'runtime') await disposed; return { providerId: 'test', sessionId: 'native', status: 'idle' }; },
      async dispose() { disposeCount++; finish(); },
    };
    const open = async () => { returned(); if (late) await allowed; return session; };
    const relay = createAgentRemoteRelay({ providers: [{ descriptor: { providerId: 'test', displayName: 'Test' }, createSession: open, resumeSession: open }] });
    const request = { protocolVersion: '1.5.0' as const, type, payload: { requestId: 'open', operationId: randomUUID(), agentId: 'agent', providerId: 'test', config: { sessionId: 'native' }, persistence: { providerId: 'test', sessionId: 'native', opaque: '{}' } } };
    const opening = relay.executeSessionOperation(request, 'owner').catch(error => error);
    await nativeReturned; await new Promise<void>(resolve => setImmediate(resolve));
    const closing = relay.close(); release();
    await closing; expect((await opening).code).toBe('operation_outcome_unknown'); expect(disposeCount).toBe(1);
  }
}, 2000);

it('retains definite HTTP missing-provider and reserved-binding rejection without native replay', async () => {
  const native = provider(), relay = createAgentRemoteRelay({ providers: [native.adapter] });
  const server = createAgentRemoteHttpServer(relay); const { url } = await server.listen();
  const post = async (providerId: string, operationId: string, requestId: string) => {
    const response = await fetch(url + '/v1/sessions', { method: 'POST', body: JSON.stringify({ protocolVersion: '1.5.0', type: 'create_agent', payload: { requestId, operationId, agentId: 'agent', providerId, config: { sessionId: 'native' } } }) });
    return { status: response.status, code: (await response.json()).payload.code };
  };
  try {
    const missingId = randomUUID();
    expect(await post('missing', missingId, 'first')).toEqual({ status: 404, code: 'provider_not_found' });
    expect(await post('missing', missingId, 'retry')).toEqual({ status: 404, code: 'provider_not_found' });
    await post('test', randomUUID(), 'create'); expect(native.creates()).toBe(1);
    const conflictId = randomUUID();
    expect(await post('test', conflictId, 'conflict')).toEqual({ status: 409, code: 'agent_already_exists' });
    expect(await post('test', conflictId, 'conflict-retry')).toEqual({ status: 409, code: 'agent_already_exists' });
    expect(native.creates()).toBe(1);
  } finally { await server.close(); await relay.close(); }
}, 5000);

it('classifies atomic creation reservation conflicts before any second native dispatch', async () => {
  const native = provider(); let release!: () => void, started!: () => void;
  const opening = new Promise<void>(resolve => { started = resolve; });
  const allowed = new Promise<void>(resolve => { release = resolve; });
  const create = native.adapter.createSession.bind(native.adapter);
  native.adapter.createSession = async config => { started(); await allowed; return create(config); };
  const relay = createAgentRemoteRelay({ providers: [native.adapter] });
  const request = (operationId: string) => ({ protocolVersion: '1.5.0' as const, type: 'create_agent' as const, payload: { requestId: 'create', operationId, agentId: 'agent', providerId: 'test', config: { sessionId: 'native' } } });
  const first = relay.executeSessionOperation(request(randomUUID()), 'owner');
  await opening;
  try {
    const second = request(randomUUID());
    await expect(relay.executeSessionOperation(second, 'owner')).rejects.toMatchObject({ code: 'agent_already_exists' });
    await expect(relay.executeSessionOperation(second, 'owner')).rejects.toMatchObject({ code: 'agent_already_exists' });
    expect(native.creates()).toBe(0); release(); await first; expect(native.creates()).toBe(1);
  } finally { release(); await first; await relay.close(); }
}, 2000);

it('retains unknown creation when post-create planning validation fails', async () => {
  const native = provider(), relay = createAgentRemoteRelay({ providers: [native.adapter] });
  const operationId = randomUUID();
  try {
    for (const requestId of ['first', 'retry']) {
      await expect(relay.executeSessionOperation({ protocolVersion: '1.5.0', type: 'create_agent', payload: {
        requestId, operationId, agentId: 'agent', providerId: 'test', config: { sessionId: 'native', planning: true },
      } }, 'owner')).rejects.toMatchObject({ code: 'operation_outcome_unknown' });
    }
    expect(native.creates()).toBe(1);
    expect(native.disposed()).toBe(1);
  } finally { await relay.close(); }
}, 2000);


it('settles preparation failures as rejected and rechecks authority after the Manager queue', async () => {
  const native = provider(), relay = createAgentRemoteRelay({ providers: [native.adapter] });
  await relay.createAgent({ protocolVersion: '1.5.0', type: 'create_agent', payload: { requestId: 'create', operationId: randomUUID(), agentId: 'agent', providerId: 'test', config: { sessionId: 'native' } } });
  const manager = relay.requireAgent('agent'), session = native.sessions[0]!;
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const sent: string[] = [];
  session.sendMessage = async text => { sent.push(text); if (text === 'first') { started(); await gate; } };
  const execute = relay.executeOperation('owner');
  const operation = { operationId: randomUUID(), kind: 'send_message' as const, parameters: {}, maximumResultBytes: 1024 };
  let allowed = true;
  const work = { beforeDispatch: () => { if (!allowed) throw Object.assign(new Error('Control transferred'), { code: 'session_read_only' }); }, dispatch: () => manager.sendMessage('queued') };
  try {
    const first = manager.sendMessage('first'); await entered;
    const queued = execute(manager, operation, work).catch(error => error);
    await new Promise<void>(resolve => setImmediate(resolve));
    allowed = false; release(); await first;
    expect(await queued).toMatchObject({ code: 'session_read_only' });
    expect(sent).toEqual(['first']);
    allowed = true;
    await expect(execute(manager, operation, work)).rejects.toMatchObject({ code: 'session_read_only' });
    expect(sent).toEqual(['first']);
  } finally { release(); await relay.close(); }
}, 2000);

it('distinguishes missing commands from failures after native command dispatch', async () => {
  const native = provider(true), relay = createAgentRemoteRelay({ providers: [native.adapter] });
  await relay.createAgent({ protocolVersion: '1.5.0', type: 'create_agent', payload: { requestId: 'create', operationId: randomUUID(), agentId: 'agent', providerId: 'test', config: { sessionId: 'native' } } });
  const manager = relay.requireAgent('agent'), session = native.sessions[0]!;
  Object.assign(session.capabilities, { commands: true });
  session.listCommands = async () => [];
  let called = 0;
  session.executeCommand = async () => { called++; throw new Error('Lost native reply'); };
  const execute = relay.executeOperation('owner');
  const operation = { operationId: randomUUID(), kind: 'execute_command' as const, parameters: {}, maximumResultBytes: 1024 };
  try {
    for (let attempt = 0; attempt < 2; attempt++) await expect(execute(manager, operation, { dispatch: () => manager.executeCommand('removed', '') })).rejects.toMatchObject({ code: 'unsupported_command' });
    expect(called).toBe(0);
    session.listCommands = async () => [{ id: 'available', name: 'available', kind: 'skill', description: 'Test' }];
    const uncertain = { ...operation, operationId: randomUUID() };
    for (let attempt = 0; attempt < 2; attempt++) await expect(execute(manager, uncertain, { dispatch: () => manager.executeCommand('available', '') })).rejects.toMatchObject({ code: 'operation_outcome_unknown' });
    expect(called).toBe(1);
  } finally { await relay.close(); }
}, 2000);


it.each(['exclusive', 'shared'] as const)('checks queued %s operations at native dispatch over real WebSockets', async mode => {
  const native = provider();
  const create = native.adapter.createSession.bind(native.adapter);
  native.adapter.createSession = async config => { const session = await create(config); Object.assign(session.capabilities, { sessionControl: mode }); return session; };
  const relay = createAgentRemoteRelay({ providers: [native.adapter] });
  await relay.createAgent({ protocolVersion: '1.5.0', type: 'create_agent', payload: { requestId: 'create', operationId: randomUUID(), agentId: 'agent', providerId: 'test', config: { sessionId: 'native' } } });
  const server = createAgentRemoteHttpServer(relay, { websocketAuthorizer: { authenticate: () => ({ subject: 'owner' }), authorize: () => true } });
  const { url } = await server.listen();
  const clients: WebSocket[] = [];
  const connect = async () => {
    const socket = new WebSocket(url.replace('http:', 'ws:') + '/v1/sessions/agent/events'); clients.push(socket);
    const messages: any[] = [];
    socket.on('message', data => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const send = (type: string, payload?: unknown, controlToken?: string) => socket.send(JSON.stringify({ protocolVersion: '1.5.0', type, payload, controlToken }));
    const next = async (type: string, requestId?: string) => {
      await expect.poll(() => messages.find(message => message.type === type && (!requestId || message.payload?.requestId === requestId)), { timeout: 1500 }).toBeDefined();
      return messages.findLast(message => message.type === type && (!requestId || message.payload?.requestId === requestId));
    };
    send('negotiate'); await next('session_control');
    const take = async (requestId: string) => {
      const revision = messages.findLast(message => message.type === 'session_control').payload.revision;
      send('session_control_request', { agentId: 'agent', requestId, action: 'take_over', revision });
      return (await next('session_control', requestId)).payload.token;
    };
    return { send, next, take };
  };
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const sent: string[] = [];
  native.sessions[0]!.sendMessage = async text => { sent.push(text); if (text === 'first') { started(); await gate; } };
  const manager = relay.requireAgent('agent');
  let queueEntered!: () => void;
  const queued = new Promise<void>(resolve => { queueEntered = resolve; });
  const sendMessage = manager.sendMessage.bind(manager);
  manager.sendMessage = (text, options) => { const pending = sendMessage(text, options); if (text === 'queued') queueEntered(); return pending; };
  try {
    const a = await connect(), token = await a.take('a-control');
    const b = await connect();
    const first = manager.sendMessage('first'); await entered;
    const operationId = randomUUID();
    a.send('send_message', { agentId: 'agent', requestId: 'queued', operationId, text: 'queued' }, token);
    await queued;
    await b.take('b-control');
    release(); await first;
    if (mode === 'exclusive') {
      expect((await a.next('protocol_error', 'queued')).payload.code).toBe('session_read_only');
      expect(sent).toEqual(['first']);
      const renewed = await a.take('a-again');
      a.send('send_message', { agentId: 'agent', requestId: 'retry', operationId, text: 'queued' }, renewed);
      expect((await a.next('protocol_error', 'retry')).payload.code).toBe('session_read_only');
      expect(sent).toEqual(['first']);
    } else {
      await a.next('command_acknowledged', 'queued');
      expect(sent).toEqual(['first', 'queued']);
    }
  } finally { release(); for (const socket of clients) socket.terminate(); await server.close(); await relay.close(); }
}, 7000);


it.each(['text-content', 'post-command-refresh'] as const)('keeps %s failures after native dispatch uncertain', async scenario => {
  const native = provider(true), relay = createAgentRemoteRelay({ providers: [native.adapter] });
  await relay.createAgent({ protocolVersion: '1.5.0', type: 'create_agent', payload: { requestId: 'create', operationId: randomUUID(), agentId: 'agent', providerId: 'test', config: { sessionId: 'native' } } });
  const manager = relay.requireAgent('agent'), session = native.sessions[0]!;
  let calls = 0;
  session.sendMessage = async () => { calls++; throw new Error('Lost native reply'); };
  session.listCommands = async () => [{ id: 'available', name: 'available', kind: 'skill', description: 'Test' }];
  session.executeCommand = async () => { calls++; return { text: 'Done' }; };
  session.runtimeInfo = async () => { throw new AgentOperationRejectedError('runtime_unavailable', 'Metadata read failed after command'); };
  const operation = { operationId: randomUUID(), kind: scenario === 'text-content' ? 'send_message' as const : 'execute_command' as const, parameters: {}, maximumResultBytes: 1024 };
  const work = { dispatch: async () => { if (scenario === 'text-content') await manager.sendMessageContent([{ type: 'text', text: 'hello' }]); else await manager.executeCommand('available', ''); } };
  try {
    for (let attempt = 0; attempt < 2; attempt++) await expect(relay.executeOperation('owner')(manager, operation, work)).rejects.toMatchObject({ code: 'operation_outcome_unknown' });
    expect(calls).toBe(1);
  } finally { await relay.close(); }
}, 2000);

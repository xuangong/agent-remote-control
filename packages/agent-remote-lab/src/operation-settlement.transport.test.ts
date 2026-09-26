// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { AgentSession, AgentProviderAdapter } from '@orchardworks/agent-provider-sdk';
import { createAgentRemoteRelay } from '../../agent-remote-relay/src/relay.js';
import { attachAgentRemoteWebSocketStream } from '../../agent-remote-relay/src/transport/websocket-stream.js';
import { createAgentHost } from '../../agent-host/src/host.js';
import { startDshAgentRemote } from '../../agent-remote-dsh/src/agent-remote.js';

const version = '1.5.0';
type Frame = { type: string; payload?: any; [key: string]: any };
interface Connection { send(frame: Frame): void; next(type: string, requestId?: string): Promise<Frame>; disconnect(): void }
interface Fixture { connect(agentId?: string, subject?: string): Promise<Connection>; count(): number; reconnect(): Promise<void>; close(): Promise<void> }
function inbox() {
  const frames: Frame[] = [];
  return {
    push: (frame: Frame) => { if (frame.type === 'command_acknowledged' && frame.payload?.requestId === 'lost') return; frames.push(frame); },
    async next(type: string, requestId?: string): Promise<Frame> {
      await expect.poll(() => frames.find(frame => frame.type === type && (!requestId || frame.payload?.requestId === requestId)), { timeout: 4000 }).toBeDefined();
      return frames.splice(frames.findIndex(frame => frame.type === type && (!requestId || frame.payload?.requestId === requestId)), 1)[0]!;
    },
  };
}
function session(counter: () => void, nativeId = 'native'): AgentSession {
  let finish!: () => void;
  const closed = new Promise<void>(resolve => { finish = resolve; });
  return {
    capabilities: { sessionControl: 'shared', history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, planApproval: false, toolApproval: false } },
    async *observe() { yield { type: 'history_boundary' }; await closed; },
    async sendMessage() { counter(); }, async respondToInteraction() {},
    async runtimeInfo() { return { providerId: 'fixture', sessionId: nativeId, status: 'idle' }; },
    async dispose() { finish(); },
  };
}
async function standalone(): Promise<Fixture & { revoke(subject: string): void; bind(agentId: string, nativeId: string): Promise<void> }> {
  let dispatches = 0;
  const revoked = new Set<string>();
  const adapter: AgentProviderAdapter = { descriptor: { providerId: 'fixture', displayName: 'Fixture' }, createSession: async config => session(() => dispatches++, config.sessionId), resumeSession: async handle => session(() => dispatches++, handle.sessionId) };
  const relay = createAgentRemoteRelay({ providers: [adapter] });
  await relay.createAgent({ protocolVersion: version, type: 'create_agent', payload: { requestId: 'create', operationId: randomUUID(), agentId: 'agent', providerId: 'fixture', config: { sessionId: 'native' } } });
  const server = createServer();
  const transport = attachAgentRemoteWebSocketStream(server, relay, { authorizer: { authenticate: request => ({ subject: String(request.headers['x-subject'] ?? 'owner') }), authorize: ({ principal }) => !revoked.has(principal.subject) } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const sockets = new Set<WebSocket>();
  return {
    count: () => dispatches, async reconnect() {},
    revoke: subject => { revoked.add(subject); },
    async bind(agentId, nativeId) { await relay.closeAgent('agent'); await relay.resumeAgent({ protocolVersion: version, type: 'resume_agent', payload: { requestId: 'bind', operationId: randomUUID(), agentId, persistence: { providerId: 'fixture', sessionId: nativeId, opaque: '{}' } } }); },
    async connect(agentId = 'agent', subject = 'owner') {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/sessions/${agentId}/events`, { headers: { 'x-subject': subject } });
      sockets.add(socket); const output = inbox();
      socket.on('message', data => output.push(JSON.parse(data.toString())));
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      return { send: frame => socket.send(JSON.stringify({ protocolVersion: version, ...frame })), next: output.next, disconnect: () => socket.terminate() };
    },
    async close() { for (const socket of sockets) socket.terminate(); await transport.close(); await relay.close(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

async function remote(kind: 'host' | 'dsh'): Promise<Fixture> {
  let dispatches = 0, sequence = 0, registrations = 0;
  let socket!: WebSocket;
  const streams = new Map<string, ReturnType<typeof inbox>>();
  const responses = new Map<string, any>();
  const broker = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => broker.once('listening', resolve));
  broker.on('connection', current => {
    socket = current;
    current.on('message', data => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'register') { registrations++; current.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'owner-host', heartbeat: { intervalMs: 30000, timeoutMs: 10000 } })); }
      if (frame.type === 'rpc_response') responses.set(frame.requestId, frame);
      if (frame.streamId) streams.get(frame.streamId)?.push(frame.type === 'stream_message' ? JSON.parse(frame.message) : frame);
    });
  });
  const url = `http://127.0.0.1:${(broker.address() as { port: number }).port}`;
  let host: { ready: Promise<unknown>; close(): Promise<void> };
  const priorHome = process.env.DSH_HOME;
  const home = await mkdtemp(join(tmpdir(), 'settlement-dsh-'));
  if (kind === 'host') {
    const native = session(() => dispatches++);
    host = createAgentHost({ installationId: 'settlement', name: 'Fixture', uplink: { url: url.replace('http:', 'ws:') + '/ws/remote-host', remoteKey: 'test-key' }, registrations: [{
      adapter: { descriptor: { providerId: 'fixture', displayName: 'Fixture' }, createSession: async () => native, resumeSession: async () => native },
      directory: { providerId: 'fixture', list: async () => [], workspaces: async () => [], create: async () => 'native', open: async () => native, close: async () => { await native.dispose(); } },
    }] });
  } else {
    process.env.DSH_HOME = home;
    host = await startDshAgentRemote(dshContext(() => dispatches++) as never, { serverUrl: url, remoteKey: 'test-key' });
  }
  await host.ready;
  const requestId = randomUUID();
  socket.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_request', requestId, method: 'POST', path: '/remote/attach', sessionId: 'agent', body: JSON.stringify({ providerId: kind === 'host' ? 'fixture' : 'dsh', nativeSessionId: 'native' }) }));
  await expect.poll(() => responses.get(requestId)).toBeDefined();
  expect(responses.get(requestId).status).toBe(200);
  return {
    count: () => dispatches,
    async reconnect() { const before = registrations; socket.terminate(); await expect.poll(() => registrations, { timeout: 5000 }).toBeGreaterThan(before); },
    async connect(agentId = 'agent') {
      const streamId = `stream-${++sequence}`; const output = inbox(); streams.set(streamId, output);
      socket.send(JSON.stringify({ uplinkVersion: 2, type: 'stream_open', streamId, sessionId: agentId }));
      await output.next('stream_opened');
      return {
        send: frame => socket.send(JSON.stringify({ uplinkVersion: 2, type: 'stream_message', streamId, message: JSON.stringify({ protocolVersion: version, ...frame }) })),
        next: output.next,
        disconnect: () => socket.send(JSON.stringify({ uplinkVersion: 2, type: 'stream_close', streamId, code: 1000, reason: 'Dropped receipt' })),
      };
    },
    async close() {
      await host.close(); for (const current of broker.clients) current.terminate(); await new Promise<void>(resolve => broker.close(() => resolve()));
      if (priorHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = priorHome;
      await rm(home, { recursive: true, force: true });
    },
  };
}

function dshContext(dispatch: () => void) {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const native = {
    id: 'native', status: 'idle', options: {},
    session: { id: 'native', header: { id: 'native', createdAt: 0 }, events: [], snapshotEvents: () => [], requestHeader: () => undefined },
    followup: dispatch, steer() {}, cancel() {},
  };
  return {
    get: (name: string) => name === 'tools' ? { get: () => ({}), schemas: () => [{}] } : undefined,
    on(name: string, listener: (...args: any[]) => void) { const all = listeners.get(name) ?? new Set(); all.add(listener); listeners.set(name, all); return () => all.delete(listener); },
    agents: { roots: () => [native], get: (id: string) => id === 'native' ? native : undefined },
    subagents: { listChildren: async () => [] }, sessions: { flush: async () => {} },
    sessionQuery: { listSessions: async () => [], observeSession: async () => ({ header: native.session.header, events: [], source: 'live', inheritedEventCount: 0, projections: { values: {} }, [Symbol.dispose]() {} }) },
    sessionController: { resolveAgent: async () => ({ agent: native }), create: async () => ({ sessionId: 'native' }), modelCatalog: async () => ({ default: { model: 'fixture' }, routableProviders: [], groups: [], failures: [] }) },
    workspaceRegistry: { list: () => [] },
  };
}

it.each(['standalone', 'host', 'dsh'] as const)('%s settles once across lost receipts, fresh connections and uplink reconnect', async kind => {
  const fixture = kind === 'standalone' ? await standalone() : await remote(kind);
  let resumeToken: string | undefined;
  const connect = async () => {
    const connection = await fixture.connect(); connection.send({ type: 'negotiate' });
    await connection.next('agent_snapshot');
    const initial = await connection.next('session_control');
    connection.send({ type: 'session_control_request', payload: { agentId: 'agent', requestId: 'acquire', action: 'acquire', revision: initial.payload.revision, resumeToken } });
    const acquired = await connection.next('session_control', 'acquire');
    const token = acquired.payload.token;
    expect(token).toBeTypeOf('string'); resumeToken = token;
    return { ...connection, send: (frame: Frame) => connection.send({ ...frame, controlToken: token }) };
  };
  const operationId = randomUUID();
  const send = (connection: Connection, requestId: string, text = 'Exactly once') => connection.send({ type: 'send_message', payload: { agentId: 'agent', requestId, operationId, text } });
  try {
    const first = await connect(); send(first, 'lost');
    await expect.poll(fixture.count).toBe(1);
    first.disconnect();
    await fixture.reconnect();
    const second = await connect(), third = await connect();
    send(second, 'retry'); send(third, 'concurrent');
    expect(await second.next('command_acknowledged', 'retry')).toMatchObject({ payload: { command: 'send_message' } });
    expect(await third.next('command_acknowledged', 'concurrent')).toMatchObject({ payload: { command: 'send_message' } });
    expect(fixture.count()).toBe(1);
    send(second, 'changed', 'A different intent');
    expect(await second.next('protocol_error', 'changed')).toMatchObject({ payload: { code: 'operation_conflict' } });
    expect(fixture.count()).toBe(1);
    second.disconnect(); third.disconnect();
  } finally { await fixture.close(); }
}, 20000);

it('checks authority before cached receipts and binds intent to native identity across public bindings', async () => {
  const fixture = await standalone();
  const operationId = randomUUID();
  async function connect(agentId: string, subject: string) {
    const connection = await fixture.connect(agentId, subject);
    connection.send({ type: 'negotiate' }); await connection.next('agent_snapshot');
    const control = await connection.next('session_control');
    connection.send({ type: 'session_control_request', payload: { agentId, requestId: 'claim', action: 'acquire', revision: control.payload.revision } });
    const acquired = await connection.next('session_control', 'claim');
    return { ...connection, send: (frame: Frame) => connection.send({ ...frame, controlToken: acquired.payload.token }) };
  }
  const send = (connection: Connection, agentId: string, requestId: string) => connection.send({ type: 'send_message', payload: { agentId, requestId, operationId, text: 'Same native intent' } });
  try {
    const owner = await connect('agent', 'owner'); send(owner, 'agent', 'first');
    await owner.next('command_acknowledged', 'first'); expect(fixture.count()).toBe(1);
    const foreign = await connect('agent', 'foreign'); send(foreign, 'agent', 'foreign');
    await foreign.next('command_acknowledged', 'foreign'); expect(fixture.count()).toBe(2);
    fixture.revoke('foreign'); send(foreign, 'agent', 'revoked');
    expect(await foreign.next('protocol_error', 'revoked')).toMatchObject({ payload: { code: 'forbidden' } });
    expect(fixture.count()).toBe(2); owner.disconnect(); foreign.disconnect();
    await fixture.bind('rebound', 'native');
    const rebound = await connect('rebound', 'owner'); send(rebound, 'rebound', 'rebound');
    await rebound.next('command_acknowledged', 'rebound'); expect(fixture.count()).toBe(2);
    rebound.send({ type: 'cancel', payload: { agentId: 'rebound', requestId: 'kind-conflict', operationId } });
    expect(await rebound.next('protocol_error', 'kind-conflict')).toMatchObject({ payload: { code: 'operation_conflict' } });
    await fixture.bind('other', 'different-native');
    const other = await connect('other', 'owner'); send(other, 'other', 'target-conflict');
    expect(await other.next('protocol_error', 'target-conflict')).toMatchObject({ payload: { code: 'operation_conflict' } });
    expect(fixture.count()).toBe(2); rebound.disconnect(); other.disconnect();
  } finally { await fixture.close(); }
}, 20000);

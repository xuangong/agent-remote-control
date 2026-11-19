import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { expect } from 'vitest';
import { memoryHttp } from '@orchardworks/agent-session-runtime/testing';
import type { AgentSession, AgentProviderAdapter } from '@orchardworks/agent-provider-sdk';
import { attachAgentRemoteWebSocketStream, createAgentRemoteRelay } from '@orchardworks/agent-session-runtime';

/**
 * Operation settlement over a session wire: one native dispatch per operation id across lost receipts, fresh connections and a
 * reconnect. A fixture is one way to reach a session (`standalone` here, without a listener; the Controller's uplink in the
 * transport test) and the scenarios are the same for each.
 */
export const version = '1.8.0';
export type Frame = { type: string; payload?: any; [key: string]: any };
export interface Connection { send(frame: Frame): void; next(type: string, requestId?: string): Promise<Frame>; disconnect(): void }
export interface Fixture { /** The session wire leases control itself (a transport that is its own Relay); behind a Relay the Relay does. */ leased: boolean; connect(agentId?: string, subject?: string): Promise<Connection>; count(): number; reconnect(): Promise<void>; close(): Promise<void> }
export function inbox() {
  const frames: Frame[] = [];
  return {
    push: (frame: Frame) => { if (frame.type === 'command_acknowledged' && frame.payload?.requestId === 'lost') return; frames.push(frame); },
    async next(type: string, requestId?: string): Promise<Frame> {
      await expect.poll(() => frames.find(frame => frame.type === type && (!requestId || frame.payload?.requestId === requestId)), { timeout: 4000, interval: 2 }).toBeDefined();
      return frames.splice(frames.findIndex(frame => frame.type === type && (!requestId || frame.payload?.requestId === requestId)), 1)[0]!;
    },
  };
}
export function session(counter: () => void, nativeId = 'native', inputAcceptance?: { disposition: 'handled' }): AgentSession {
  let finish!: () => void;
  const closed = new Promise<void>(resolve => { finish = resolve; });
  return {
    capabilities: { sessionControl: 'shared', history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, planApproval: false, toolApproval: false } },
    async *observe() { yield { type: 'history_boundary' }; await closed; },
    async sendMessage() { counter(); return inputAcceptance; }, async respondToInteraction() {},
    async runtimeInfo() { return { providerId: 'fixture', sessionId: nativeId, status: 'idle' }; },
    async dispose() { finish(); },
  };
}
export async function standalone(inputAcceptance?: { disposition: 'handled' }): Promise<Fixture & { revoke(subject: string): void; bind(agentId: string, nativeId: string): Promise<void> }> {
  let dispatches = 0;
  const revoked = new Set<string>();
  const adapter: AgentProviderAdapter = { descriptor: { providerId: 'fixture', displayName: 'Fixture' }, createSession: async config => session(() => dispatches++, config.sessionId, inputAcceptance), resumeSession: async handle => session(() => dispatches++, handle.sessionId, inputAcceptance) };
  const relay = createAgentRemoteRelay({ providers: [adapter] });
  await relay.createAgent({ protocolVersion: version, type: 'create_agent', payload: { requestId: 'create', operationId: randomUUID(), agentId: 'agent', providerId: 'fixture', config: { sessionId: 'native' } } });
  const server = createServer();
  const transport = attachAgentRemoteWebSocketStream(server, relay, { authorizer: { authenticate: request => ({ subject: String(request.headers['x-subject'] ?? 'owner') }), authorize: ({ principal }) => !revoked.has(principal.subject) } });
  const net = memoryHttp(server);
  return {
    leased: true, count: () => dispatches, async reconnect() {},
    revoke: subject => { revoked.add(subject); },
    async bind(agentId, nativeId) { await relay.closeAgent('agent'); await relay.resumeAgent({ protocolVersion: version, type: 'resume_agent', payload: { requestId: 'bind', operationId: randomUUID(), agentId, persistence: { providerId: 'fixture', sessionId: nativeId, opaque: '{}' } } }); },
    async connect(agentId = 'agent', subject = 'owner') {
      const socket = net.webSocket(`ws://memory.test/v1/sessions/${agentId}/events`, { headers: { 'x-subject': subject } });
      const output = inbox();
      socket.on('message', data => output.push(JSON.parse(data.toString())));
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      return { send: frame => socket.send(JSON.stringify({ protocolVersion: version, ...frame })), next: output.next, disconnect: () => socket.terminate() };
    },
    async close() { net.close(); await transport.close(); await relay.close(); },
  };
}


/** Lost receipts, fresh connections and a reconnect settle the operation once. */
export async function settlesOnce(fixture: Fixture) {
  let resumeToken: string | undefined;
  const connect = async () => {
    const connection = await fixture.connect(); connection.send({ type: 'negotiate' });
    await connection.next('agent_snapshot');
    if (!fixture.leased) return connection;
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
    await expect.poll(fixture.count, { interval: 2 }).toBe(1);
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
}

/** Authority is checked before a cached receipt, and an intent is bound to the native identity across public bindings. */
export async function checksAuthority(fixture: Awaited<ReturnType<typeof standalone>>) {
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
}

/** A handled acceptance survives a lost receipt and a reconnect. */
export async function retainsHandled(fixture: Fixture) {
  const operationId = randomUUID();
  const connect = async () => {
    const connection = await fixture.connect();
    connection.send({ type: 'negotiate' });
    const snapshot = await connection.next('agent_snapshot');
    if (!fixture.leased) return { ...connection, snapshot };
    const initial = await connection.next('session_control');
    connection.send({ type: 'session_control_request', payload: { agentId: 'agent', requestId: 'acquire', action: 'acquire', revision: initial.payload.revision } });
    const acquired = await connection.next('session_control', 'acquire');
    return { ...connection, snapshot, send: (frame: Frame) => connection.send({ ...frame, controlToken: acquired.payload.token }) };
  };
  try {
    const first = await connect();
    const send = (connection: Connection, requestId: string) => connection.send({ type: 'send_message', payload: { agentId: 'agent', requestId, operationId, text: '/local' } });
    send(first, 'lost');
    await expect.poll(fixture.count, { interval: 2 }).toBe(1);
    first.disconnect();
    await fixture.reconnect();
    const second = await connect();
    expect(second.snapshot).toMatchObject({ payload: { status: 'idle', activeTurn: null } });
    send(second, 'retry');
    expect(await second.next('command_acknowledged', 'retry')).toMatchObject({ payload: { inputAcceptance: { disposition: 'handled' } } });
    expect(fixture.count()).toBe(1);
  } finally { await fixture.close(); }
}

// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { createRemoteHostUplinkClient } from '@orchardworks/agent-session-runtime';
import { memoryHttp } from '@orchardworks/agent-session-runtime/testing';
import { WebSocketServer, type WebSocket } from 'ws';
import { createAgentHost } from '../../agent-controller/src/host.js';
import { startDshAgentRemote } from '@orchardworks/dsh/host';
import { inbox, retainsHandled, session, settlesOnce, version, type Connection, type Fixture, type Frame } from './test/operation-settlement.js';

/** The Controller's uplink to a broker, in memory (`memoryHttp`): a Host and the dsh plugin settle an operation once across a lost receipt and an uplink reconnect. The standalone wire is `operation-settlement.test.ts`. */
async function remoteFixture(kind: 'host' | 'dsh', inputAcceptance?: { disposition: 'handled' }): Promise<Fixture> {
  let dispatches = 0, sequence = 0, registrations = 0;
  let socket!: WebSocket;
  const streams = new Map<string, ReturnType<typeof inbox>>();
  const responses = new Map<string, any>();
  const server = createServer();
  const broker = new WebSocketServer({ server });
  const net = memoryHttp(server);
  broker.on('connection', current => {
    socket = current;
    current.on('message', data => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'register') { registrations++; current.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', control: 1, hostId: 'owner-host', heartbeat: { intervalMs: 30000, timeoutMs: 10000 } })); }
      if (frame.type === 'rpc_response') responses.set(frame.requestId, frame);
      if (frame.streamId) streams.get(frame.streamId)?.push(frame.type === 'stream_message' ? JSON.parse(frame.message) : frame);
    });
  });
  const url = net.url;
  // A reconnect after a lost socket does not wait out the production backoff.
  const memoryUplink = { connect: net.uplinkConnect, reconnectBaseDelayMs: 1, reconnectMaxDelayMs: 5 };
  let host: { ready: Promise<unknown>; close(): Promise<void> };
  const priorHome = process.env.DSH_HOME;
  const home = await mkdtemp(join(tmpdir(), 'settlement-dsh-'));
  if (kind === 'host') {
    const native = session(() => dispatches++, undefined, inputAcceptance);
    host = createAgentHost({ installationId: 'settlement', name: 'Fixture', uplink: { url: url.replace('http:', 'ws:') + '/ws/remote-host', remoteKey: 'test-key' }, uplinkClient: options => createRemoteHostUplinkClient({ ...options, ...memoryUplink }), registrations: [{
      adapter: { descriptor: { providerId: 'fixture', displayName: 'Fixture' }, createSession: async () => native, resumeSession: async () => native },
      directory: { providerId: 'fixture', list: async () => [], workspaces: async () => [], create: async () => 'native', open: async () => native, close: async () => { await native.dispose(); } },
    }] });
  } else {
    process.env.DSH_HOME = home;
    host = await startDshAgentRemote(dshContext(() => dispatches++) as never, { serverUrl: url, remoteKey: 'test-key' }, undefined, memoryUplink);
  }
  await host.ready;
  const requestId = randomUUID();
  socket.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_request', requestId, method: 'POST', path: '/remote/attach', sessionId: 'agent', body: JSON.stringify({ providerId: kind === 'host' ? 'fixture' : 'dsh', nativeSessionId: 'native' }) }));
  await expect.poll(() => responses.get(requestId)).toBeDefined();
  expect(responses.get(requestId).status).toBe(200);
  return {
    leased: false, count: () => dispatches,
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
      await host.close(); net.close();
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

it.each(['host', 'dsh'] as const)('%s settles once across lost receipts, fresh connections and uplink reconnect', async kind => settlesOnce(await remoteFixture(kind)), 20000);
it('host retains handled acceptance across a lost receipt and reconnect', async () => retainsHandled(await remoteFixture('host', { disposition: 'handled' })));

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createAgentRemoteRelay, createRemoteHostUplinkClient } from '@orchardworks/agent-session-runtime';
import { isTeam, type TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { createHostBroker, type RemoteHostBrokerState } from './broker.js';
import { memoryHostClient, relaySocket } from './test-utils/ws-relay-socket.js';
import { type SavedTeam } from './team-delivery.js';

const close: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); }, 5000);
const ref = (nativeSessionId: string) => ({ controllerId: 'controller', providerId: 'codex', nativeSessionId });
const heartbeat = { intervalMs: 30000, timeoutMs: 10000 };

async function relayWithoutSuccession() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening', { signal: AbortSignal.timeout(3000) });
  close.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(done => server.close(() => done())); });
  const packets: any[] = [], sockets: WebSocket[] = [];
  server.on('connection', socket => {
    sockets.push(socket);
    socket.on('message', data => {
      const packet = JSON.parse(data.toString());
      packets.push(packet);
      if (packet.type === 'register') {
        socket.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'host', teamManagement: true, heartbeat }));
      }
      if (packet.type === 'team_request') socket.send(JSON.stringify({ uplinkVersion: 2, type: 'team_response', requestId: packet.requestId, status: 200, body: JSON.stringify(packet.call.action === 'poll' ? [] : { resolvedTarget: ref('A') }) }));
    });
  });
  return { server, packets, sockets, url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/remote-host` };
}

async function client(url: string) {
  const relay = createAgentRemoteRelay({ providers: [] }); close.push(() => relay.close());
  const result = createRemoteHostUplinkClient({ relay, url, installationId: 'controller', name: 'Host', remoteKey: 'key', teamManagement: true, providers: [],
    resolveSession: () => undefined, control: () => ({ status: 200, body: '{"update":"reachable"}' }), reconnectBaseDelayMs: 5, reconnectMaxDelayMs: 10 });
  close.push(() => result.close()); await result.ready; return result;
}

function savedTeam(): SavedTeam {
  return { id: 'team', operationId: 'create', revision: 1, source: { hostId: 'host', providerId: 'codex', nativeSessionId: 'source', title: 'Source' }, title: 'Team', status: 'active',
    members: ['leader', 'worker'].map((id, index) => ({ id, hostId: 'host', providerId: 'codex', nativeSessionId: index ? 'A' : 'L', role: 'requester', name: id, responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 })),
    messages: [{ id: 'message', from: 'leader', to: 'worker', text: 'Fixture', status: 'queued', createdAt: 1 }], createdAt: 1, updatedAt: 1,
    link: { assistants: ['leader', 'worker'], recent: [] } };
}

async function currentRelay(team: SavedTeam | SavedTeam[] = savedTeam(), successor = false) {
  let broker: ReturnType<typeof createHostBroker>, saved: RemoteHostBrokerState = {
    keys: [[createHash('sha256').update('key').digest('hex'), { kind: 'device', installationId: 'controller', expires: Number.MAX_SAFE_INTEGER }]],
    hosts: [{ id: 'host', installationId: 'controller', name: 'Host', legacyDsh: false, teamManagement: true, providers: [{ providerId: 'codex', displayName: 'Codex' }] }], bindings: [], creations: [], teams: Array.isArray(team) ? team : [team],
  };
  const origin = 'https://relay.example';
  if (successor) {
    const request = { roleId: 'role', operationId: 'prefix', expectedRevision: 1, from: ref('A'), preparation: { kind: 'native_prefix' as const, turnId: 'turn', messageId: 'prompt' } };
    const workspace = { controllerId: 'controller', canonicalCwd: '/fixture' };
    saved.associations = { version: 6, revision: 1, admissions: [], relationChanges: [], relationResets: [], freezes: [{ hostId: 'host', released: 'committed',
      receipt: { version: 3, maxProjectionBytes: 10000, token: 'token', authority: { version: 1, origin, issuer: 'issuer', namespace: 'tenant', ownerSubject: 'owner' }, controllerId: 'controller', request, associationRevision: 0, lineage: [ref('A')], relations: [] },
      projection: { version: 1, role: { id: 'role', revision: 2, origin: ref('A'), current: ref('B'), workspace }, receipt: { ...request, to: ref('B'), phase: 'committed', committedRevision: 2, startedAt: 'now', updatedAt: 'now', prepared: { ...request, to: ref('B'), workspace, participants: [], associationRevision: 0, capture: { epoch: 'e', seq: 1, capturedAt: 'now' } } } } }] };
  }
  const make = () => createHostBroker({ origin, assistantGroups: () => [], initialState: saved, heartbeatIntervalMs: 200, heartbeatTimeoutMs: 100, onStateChange(state) { saved = structuredClone(state); } }); broker = make();
  const prepare = (url: string, headers: Record<string, string>) => broker.prepareUpgrade(new Request(url, { headers }));
  /** A real loopback listener in front of the Relay, for the one test whose subject is a Controller's own uplink client. */
  async function listen() {
    const http = createServer((incoming, response) => { void (async () => {
      let body = ''; for await (const chunk of incoming) body += chunk;
      const result = await broker.handleRequest(new Request(origin + incoming.url, { method: incoming.method, headers: incoming.headers as Record<string, string>, ...(body ? { body } : {}) }));
      response.writeHead(result!.status, Object.fromEntries(result!.headers)); response.end(await result!.text());
    })().catch(error => { response.writeHead(500); response.end(String(error)); }); });
    http.listen(0, '127.0.0.1'); await once(http, 'listening', { signal: AbortSignal.timeout(3000) });
    const ws = new WebSocketServer({ server: http });
    ws.on('connection', async (socket, incoming) => {
      const upgrade = await prepare(origin + incoming.url, { authorization: 'Bearer key' });
      if (!upgrade || upgrade instanceof Response) { socket.close(); return; }
      upgrade.accept(relaySocket(socket));
    });
    close.push(async () => { for (const socket of ws.clients) socket.terminate(); await new Promise<void>(done => ws.close(() => done())); http.closeAllConnections(); await new Promise<void>(done => http.close(() => done())); });
    return `ws://127.0.0.1:${(http.address() as { port: number }).port}/ws/remote-host`;
  }
  close.push(() => { broker.close(); });
  const request = async (path = '', input?: unknown) => (await broker.handleRequest(new Request(`${origin}/v1/remote/teams${path}`, { headers: { 'content-type': 'application/json' }, ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}) })))!;
  async function connect(succession = false) {
    const socket = memoryHostClient({ prepareUpgrade: request => broker.prepareUpgrade(request) }, `${origin}/ws/remote-host?team=1&tasks=1&coordinatorProvider=codex${succession ? '&teamSuccession=1' : ''}`);
    close.push(() => { socket.terminate(); });
    const packets: any[] = []; socket.on('message', data => { const packet = JSON.parse(data.toString()); packets.push(packet); if (packet.type === 'heartbeat') socket.send(JSON.stringify({ uplinkVersion: 2, type: 'heartbeat_ack', nonce: packet.nonce })); });
    await once(socket, 'open', { signal: AbortSignal.timeout(3000) });
    socket.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'controller', name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
    await expect.poll(() => packets.find(p => p.type === 'registered'), { interval: 1 }).toBeTruthy();
    let requestId = 0;
    const call = async (call: TeamHostCall) => {
      const id = String(++requestId); socket.send(JSON.stringify({ uplinkVersion: 2, type: 'team_request', requestId: id, call }));
      await expect.poll(() => packets.find(p => p.type === 'team_response' && p.requestId === id), { interval: 1 }).toBeTruthy();
      const packet = packets.find(p => p.type === 'team_response' && p.requestId === id); return { status: packet.status, value: JSON.parse(packet.body) };
    };
    return { socket, packets, call };
  }
  return { listen, request, connect, snapshot: () => saved, restart() { broker.close(); broker = make(); } };
}

test('current Relay acknowledges Team succession only when offered', async () => {
  const f = await currentRelay();
  expect((await f.connect()).packets[0].teamSuccession).toBeUndefined();
  expect((await f.connect(true)).packets[0].teamSuccession).toBe(1);
}, 10000);

test('the Controller offers Team succession and learns from each registration whether the Relay supports it', async () => {
  const f = await relayWithoutSuccession();
  const host = await client(f.url);
  expect(host.teamSuccession).toBe(false);
  const current = await currentRelay(), modern = createRemoteHostUplinkClient({ relay: createAgentRemoteRelay({ providers: [] }), url: await current.listen(), installationId: 'controller', name: 'Host', remoteKey: 'key',
    teamManagement: true, providers: [], resolveSession: () => undefined, control: () => ({ status: 200, body: '{}' }) });
  close.push(() => modern.close()); await modern.ready;
  expect(modern.teamSuccession).toBe(true);
}, 10000);

test('the Relay acknowledges bots when offered, and the Controller learns it from registration', async () => {
  const current = await currentRelay(), url = await current.listen();
  const connect = async (offer: { tasks?: true }) => {
    const host = createRemoteHostUplinkClient({ relay: createAgentRemoteRelay({ providers: [] }), url, installationId: 'controller', name: 'Host', remoteKey: 'key',
      teamManagement: true, ...offer, providers: [], resolveSession: () => undefined, control: () => ({ status: 200, body: '{}' }) });
    close.push(() => host.close()); await host.ready; return host;
  };
  const offered = await connect({ tasks: true });
  expect(offered.tasks).toBe(true);
  await offered.close();
  const unoffered = await connect({});
  expect(unoffered.tasks).toBe(false);
  await expect(unoffered.teamRequest({ action: 'task_status', owner: { providerId: 'codex', nativeSessionId: 'main' } })).rejects.toThrow('Update the Relay to use tasks.');
}, 10000);

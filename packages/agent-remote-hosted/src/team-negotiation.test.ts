import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createAgentRemoteRelay, createRemoteHostUplinkClient } from '@orchardworks/agent-remote-relay';
import { isTeam, type TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { RemoteTeamClient } from '../../agent-remote-web/src/client/remote-team-client.js';
import { isTeam as isLegacyTeam } from '../../agent-remote-protocol/test/fixtures/legacy-team/team.js';
import { decodeRemoteHostUplinkMessage as decodeLegacy } from '../../agent-remote-protocol/test/fixtures/legacy-team/remote-host-uplink.js';
import { createHostBroker, type RemoteHostBrokerState } from './broker.js';
import { relaySocket } from '../../agent-remote-lab/src/server/remote-host-broker.js';
import { deliveryFingerprint, type SavedTeam } from './team-delivery.js';

const close: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); }, 5000);
const ref = (nativeSessionId: string) => ({ controllerId: 'controller', providerId: 'codex', nativeSessionId });
const heartbeat = { intervalMs: 30000, timeoutMs: 10000 };
const claim: TeamHostCall = { action: 'claim', teamId: 'team', memberId: 'worker', messageId: 'message', expectedNativeSessionId: 'A' };
const inboxAcknowledgement: TeamHostCall = { action: 'acknowledge', teamId: 'team', memberId: 'worker', messageIds: ['message'], expectedNativeSessionId: 'A' };

async function legacyRelay() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening', { signal: AbortSignal.timeout(3000) });
  close.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(done => server.close(() => done())); });
  const packets: any[] = [], sockets: WebSocket[] = [], invalid: unknown[] = [], offers: Array<string | null> = [];
  let acknowledge = false, inbox = false;
  server.on('connection', (socket, request) => {
    sockets.push(socket);
    socket.on('message', data => {
      const packet = JSON.parse(data.toString());
      if (decodeLegacy(data.toString()).status !== 'ok' && !acknowledge) { invalid.push(packet); socket.close(1008, 'Invalid uplink envelope'); return; }
      packets.push(packet);
      if (packet.type === 'register') {
        offers.push(new URL(request.url!, 'http://localhost').searchParams.get('teamRecipients'));
        socket.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'host', teamManagement: true, ...(acknowledge ? { teamRecipients: 1 } : {}), ...(inbox ? { teamInbox: 1 } : {}), heartbeat }));
      }
      if (packet.type === 'team_request') socket.send(JSON.stringify({ uplinkVersion: 2, type: 'team_response', requestId: packet.requestId, status: 200, body: JSON.stringify(packet.call.action === 'poll' ? [] : { resolvedTarget: ref('A') }) }));
    });
  });
  return { server, packets, sockets, invalid, offers, acknowledge(value: boolean) { acknowledge = value; }, inbox(value: boolean) { inbox = value; }, url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/remote-host` };
}

async function client(url: string) {
  const relay = createAgentRemoteRelay({ providers: [] }); close.push(() => relay.close());
  const result = createRemoteHostUplinkClient({ relay, url, installationId: 'controller', name: 'Host', remoteKey: 'key', teamManagement: true, providers: [],
    resolveSession: () => undefined, control: () => ({ status: 200, body: '{"update":"reachable"}' }), reconnectBaseDelayMs: 5, reconnectMaxDelayMs: 10 });
  close.push(() => result.close()); await result.ready; return result;
}

test('new Controller rejects unacknowledged recipient calls locally while legacy management, polling and heartbeat remain reachable', async () => {
  const f = await legacyRelay(), host = await client(f.url);
  await expect(host.teamRequest(claim)).rejects.toThrow(/Update the Relay/);
  await expect(host.teamRequest(inboxAcknowledgement)).rejects.toThrow(/Update the Relay/);
  await expect(host.teamRequest({ action: 'settle', teamId: 'team', memberId: 'worker', messageId: 'message', outcome: 'unknown', resolvedTarget: ref('A') })).rejects.toThrow(/Update the Relay/);
  expect(await host.teamRequest({ action: 'poll' })).toEqual([]);
  f.sockets[0]!.send(JSON.stringify({ uplinkVersion: 2, type: 'heartbeat', nonce: 'still-alive' }));
  f.sockets[0]!.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_request', requestId: 'update', method: 'GET', path: '/remote/controller-update' }));
  await expect.poll(() => f.packets.some(p => p.type === 'heartbeat_ack' && p.nonce === 'still-alive')).toBe(true);
  await expect.poll(() => f.packets.find(p => p.type === 'rpc_response' && p.requestId === 'update')?.body).toBe('{"update":"reachable"}');
  expect(f.offers).toEqual(['1']); expect(f.invalid).toEqual([]); expect(f.sockets[0]!.readyState).toBe(WebSocket.OPEN);
}, 10000);

test('inbox acknowledgement is negotiated separately and reset after Relay downgrade', async () => {
  const f = await legacyRelay(); f.acknowledge(true); const host = await client(f.url);
  await expect(host.teamRequest(inboxAcknowledgement)).rejects.toThrow(/Update the Relay/);
  expect(f.packets.some(packet => packet.call?.action === 'acknowledge')).toBe(false);
  f.inbox(true); f.sockets[0]!.close();
  await expect.poll(() => f.packets.filter(p => p.type === 'register').length).toBe(2);
  await expect.poll(async () => { try { return await host.teamRequest(inboxAcknowledgement); } catch { return undefined; } }).toMatchObject({ resolvedTarget: ref('A') });
  f.inbox(false); f.sockets.at(-1)!.close();
  await expect.poll(() => f.packets.filter(p => p.type === 'register').length).toBe(3);
  await expect.poll(async () => { try { return await host.teamRequest({ action: 'poll' }); } catch { return undefined; } }).toEqual([]);
  const count = f.packets.filter(packet => packet.call?.action === 'acknowledge').length;
  await expect(host.teamRequest(inboxAcknowledgement)).rejects.toThrow(/Update the Relay/);
  expect(f.packets.filter(packet => packet.call?.action === 'acknowledge')).toHaveLength(count);
}, 10000);

test('recipient acknowledgement is reset after reconnecting to a downgraded Relay', async () => {
  const f = await legacyRelay(); f.acknowledge(true); const host = await client(f.url);
  expect(await host.teamRequest(claim)).toMatchObject({ resolvedTarget: ref('A') });
  f.acknowledge(false); f.sockets[0]!.close();
  await expect.poll(() => f.packets.filter(p => p.type === 'register').length).toBe(2);
  await expect.poll(async () => { try { return await host.teamRequest({ action: 'poll' }); } catch { return undefined; } }).toEqual([]);
  await expect(host.teamRequest(claim)).rejects.toThrow(/Update the Relay/);
  expect(f.invalid).toEqual([]);
}, 10000);

function savedTeam(): SavedTeam {
  return { id: 'team', operationId: 'create', revision: 1, source: { hostId: 'host', providerId: 'codex', nativeSessionId: 'source', title: 'Source' }, title: 'Team', status: 'active',
    members: ['leader', 'worker'].map((id, index) => ({ id, hostId: 'host', providerId: 'codex', nativeSessionId: index ? 'A' : 'L', role: index ? 'member' : 'leader', name: id, responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 })),
    messages: [{ id: 'message', from: 'leader', to: 'worker', text: 'Fixture', status: 'queued', createdAt: 1 }], createdAt: 1, updatedAt: 1 };
}

async function currentRelay(team: SavedTeam | SavedTeam[] = savedTeam(), successor = false) {
  let broker: ReturnType<typeof createHostBroker>, saved: RemoteHostBrokerState = {
    keys: [[createHash('sha256').update('key').digest('hex'), { kind: 'device', installationId: 'controller', expires: Number.MAX_SAFE_INTEGER }]],
    hosts: [{ id: 'host', installationId: 'controller', name: 'Host', legacyDsh: false, teamManagement: true, providers: [{ providerId: 'codex', displayName: 'Codex' }] }], bindings: [], creations: [], teams: Array.isArray(team) ? team : [team],
  };
  const http = createServer((incoming, response) => { void (async () => {
    let body = ''; for await (const chunk of incoming) body += chunk;
    const result = await broker.handleRequest(new Request(origin + incoming.url, { method: incoming.method, headers: incoming.headers as Record<string, string>, ...(body ? { body } : {}) }));
    response.writeHead(result!.status, Object.fromEntries(result!.headers)); response.end(await result!.text());
  })().catch(error => { response.writeHead(500); response.end(String(error)); }); });
  http.listen(0, '127.0.0.1'); await once(http, 'listening', { signal: AbortSignal.timeout(3000) });
  const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  if (successor) {
    const request = { roleId: 'role', operationId: 'prefix', expectedRevision: 1, from: ref('A'), preparation: { kind: 'native_prefix' as const, turnId: 'turn', messageId: 'prompt' } };
    const workspace = { controllerId: 'controller', canonicalCwd: '/fixture' };
    saved.associations = { version: 6, revision: 1, admissions: [], relationChanges: [], relationResets: [], freezes: [{ hostId: 'host', released: 'committed',
      receipt: { version: 3, maxProjectionBytes: 10000, token: 'token', authority: { version: 1, origin, issuer: 'issuer', namespace: 'tenant', ownerSubject: 'owner' }, controllerId: 'controller', request, associationRevision: 0, lineage: [ref('A')], relations: [] },
      projection: { version: 1, role: { id: 'role', revision: 2, origin: ref('A'), current: ref('B'), workspace }, receipt: { ...request, to: ref('B'), phase: 'committed', committedRevision: 2, startedAt: 'now', updatedAt: 'now', prepared: { ...request, to: ref('B'), workspace, participants: [], associationRevision: 0, capture: { epoch: 'e', seq: 1, capturedAt: 'now' } } } } }] };
  }
  const make = () => createHostBroker({ origin, initialState: saved, heartbeatIntervalMs: 200, heartbeatTimeoutMs: 100, onStateChange(state) { saved = structuredClone(state); } }); broker = make();
  const ws = new WebSocketServer({ server: http });
  ws.on('connection', async (socket, incoming) => {
    const upgrade = await broker.prepareUpgrade(new Request(origin + incoming.url, { headers: { authorization: 'Bearer key' } }));
    if (!upgrade || upgrade instanceof Response) { socket.close(); return; }
    upgrade.accept(relaySocket(socket));
  });
  close.push(async () => { broker.close(); for (const socket of ws.clients) socket.terminate(); await new Promise<void>(done => ws.close(() => done())); http.closeAllConnections(); await new Promise<void>(done => http.close(() => done())); });
  const request = async (path = '', input?: unknown, recipientAware = false) => fetch(`${origin}/v1/remote/teams${path}`, { signal: AbortSignal.timeout(3000), headers: { ...(recipientAware ? { 'x-arc-team-recipients': '1' } : {}), 'content-type': 'application/json' }, ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}) });
  async function connect(recipientAware = false, inbox = false, succession = false) {
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/ws/remote-host?team=1${recipientAware ? '&teamRecipients=1' : ''}${inbox ? '&teamInbox=1' : ''}${succession ? '&teamSuccession=1' : ''}`);
    close.push(() => { socket.terminate(); });
    const packets: any[] = []; socket.on('message', data => { const packet = JSON.parse(data.toString()); packets.push(packet); if (packet.type === 'heartbeat') socket.send(JSON.stringify({ uplinkVersion: 2, type: 'heartbeat_ack', nonce: packet.nonce })); });
    await once(socket, 'open', { signal: AbortSignal.timeout(3000) });
    socket.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'controller', name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
    await expect.poll(() => packets.find(p => p.type === 'registered')).toBeTruthy();
    let requestId = 0;
    const call = async (call: TeamHostCall) => {
      const id = String(++requestId); socket.send(JSON.stringify({ uplinkVersion: 2, type: 'team_request', requestId: id, call }));
      await expect.poll(() => packets.find(p => p.type === 'team_response' && p.requestId === id)).toBeTruthy();
      const packet = packets.find(p => p.type === 'team_response' && p.requestId === id); return { status: packet.status, value: JSON.parse(packet.body) };
    };
    return { socket, packets, call };
  }
  return { origin, request, connect, snapshot: () => saved, restart() { broker.close(); broker = make(); } };
}

test('current Relay acknowledges inbox support only when offered and persists the exact receipt', async () => {
  const f = await currentRelay(), old = await f.connect(true);
  expect(old.packets[0].teamInbox).toBeUndefined();
  const modern = await f.connect(true, true);
  expect(modern.packets[0].teamInbox).toBe(1);
  expect(await modern.call(inboxAcknowledgement)).toMatchObject({ status: 200, value: { acknowledged: [{ id: 'message', acceptance: 'handled', resolvedTarget: ref('A') }] } });
  expect(f.snapshot().teams![0]!.messages).toEqual([]);
  f.restart(); const resumed = await f.connect(true, true);
  expect((await resumed.call(inboxAcknowledgement)).status).toBe(200);
}, 10000);

test('current Relay acknowledges Team succession only with exact recipients and when offered', async () => {
  const f = await currentRelay();
  expect((await f.connect(true, true)).packets[0].teamSuccession).toBeUndefined();
  expect((await f.connect(false, false, true)).packets[0].teamSuccession).toBeUndefined();
  expect((await f.connect(true, true, true)).packets[0].teamSuccession).toBe(1);
}, 10000);

test('the Controller offers Team succession and learns from each registration whether the Relay supports it', async () => {
  const f = await legacyRelay(); f.acknowledge(true);
  const host = await client(f.url);
  expect(host.teamSuccession).toBe(false);
  const current = await currentRelay(), modern = createRemoteHostUplinkClient({ relay: createAgentRemoteRelay({ providers: [] }), url: `${current.origin.replace('http:', 'ws:')}/ws/remote-host`, installationId: 'controller', name: 'Host', remoteKey: 'key',
    teamManagement: true, providers: [], resolveSession: () => undefined, control: () => ({ status: 200, body: '{}' }) });
  close.push(() => modern.close()); await modern.ready;
  expect(modern.teamSuccession).toBe(true);
}, 10000);

test('legacy Controller ordinary claims, polls and cached browser responses stay valid while exact recipients persist across restart', async () => {
  const f = await currentRelay(), legacy = await f.connect();
  expect(decodeLegacy(JSON.stringify(legacy.packets[0])).status).toBe('ok');
  const accepted = await legacy.call({ action: 'claim', teamId: 'team', memberId: 'worker', messageId: 'message' });
  expect(accepted.status).toBe(200); expect(accepted.value.resolvedTarget).toBeUndefined();
  const poll = await legacy.call({ action: 'poll' }); expect(poll.status).toBe(200); expect(poll.value.every(isLegacyTeam)).toBe(true);
  expect(f.snapshot().teams![0]!.messages[0]!.resolvedTarget).toEqual(ref('A'));
  for (const response of [await f.request(), await f.request('/action', { action: 'rename', teamId: 'team', title: 'Renamed' }), await f.request('/create', { operationId: 'create', source: savedTeam().source })]) {
    expect(response.status).toBe(200); const body = await response.json(); expect((body.teams ?? [body]).every(isLegacyTeam)).toBe(true);
  }
  const current = await new RemoteTeamClient(f.origin).list(); expect(current.every(isTeam)).toBe(true); expect(current[0]!.messages[0]!.resolvedTarget).toEqual(ref('A'));
  await expect.poll(() => legacy.packets.some(p => p.type === 'heartbeat')).toBe(true);
  f.restart(); const modern = await f.connect(true); expect(modern.packets[0].teamRecipients).toBe(1);
  expect((await modern.call({ action: 'poll' })).value[0].messages[0].resolvedTarget).toEqual(ref('A'));
  expect((await modern.call({ action: 'settle', teamId: 'team', memberId: 'worker', messageId: 'message', resolvedTarget: ref('A'), outcome: 'accepted', acceptance: 'started' })).status).toBe(200);
  expect(f.snapshot().teams![0]!.deliveryReceipts![0]!.resolvedTarget).toEqual(ref('A'));
}, 10000);

test('legacy unresolved receipts survive old peers and browser projections and still require explicit resolution', async () => {
  const team = savedTeam(); team.messages = [];
  team.deliveryReceipts = [{ id: 'legacy-receipt', from: 'leader', to: 'worker', status: 'accepted', createdAt: 1, settledAt: 1, fingerprint: deliveryFingerprint({ to: 'worker', text: 'Compacted' }) }];
  const f = await currentRelay(team), legacy = await f.connect();
  const poll = await legacy.call({ action: 'poll' }); expect(poll.status).toBe(409); expect(poll.value.error).toMatch(/Update the Controller/);
  const oldBrowser = await f.request(); expect(oldBrowser.status).toBe(409); expect((await oldBrowser.json()).error).toMatch(/Reload/);
  const current = await (await f.request('', undefined, true)).json(); expect(current.teams[0].unresolvedReceipts).toHaveLength(1);
  await f.request('/action', { action: 'archive', teamId: 'team' }, true);
  for (const memberId of ['leader', 'worker']) await legacy.call({ action: 'presence', teamId: 'team', memberId, activity: 'idle' });
  expect(f.snapshot().teams![0]!.status).toBe('archiving');
  f.restart(); expect(f.snapshot().teams![0]!.deliveryReceipts).toHaveLength(1);
  const resolved = await f.request('/action', { action: 'resolve_message', teamId: 'team', messageId: 'legacy-receipt', outcome: 'accepted' }, true);
  expect(resolved.status).toBe(200); expect((await resolved.json()).status).toBe('archived');
}, 10000);

test('legacy browser lists filter unavailable source Hosts before rejecting recipient-incompatible Teams', async () => {
  const hidden = savedTeam();
  hidden.id = 'hidden'; hidden.operationId = 'hidden-create'; hidden.source.hostId = 'unavailable';
  hidden.members.forEach(member => { member.hostId = 'unavailable'; });
  hidden.messages = [];
  hidden.deliveryReceipts = [{ id: 'hidden-receipt', from: 'leader', to: 'worker', status: 'accepted', createdAt: 1, settledAt: 1, fingerprint: deliveryFingerprint({ to: 'worker', text: 'Compacted private input' }) }];
  const f = await currentRelay([savedTeam(), hidden]);
  const response = await f.request();
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.teams.map((team: { id: string }) => team.id)).toEqual(['team']);
  expect(body.teams.every(isLegacyTeam)).toBe(true);
  expect(f.snapshot().teams!.find(team => team.id === hidden.id)!.deliveryReceipts).toEqual(hidden.deliveryReceipts);
}, 10000);


test('a downgraded Controller cannot claim or settle a persisted successor and current peers keep exact recipients', async () => {
  const team = savedTeam(); team.messages.push({ id: 'pending-B', from: 'leader', to: 'worker', text: 'Pending', status: 'unknown', resolvedTarget: ref('B'), createdAt: 1 });
  const f = await currentRelay(team, true), legacy = await f.connect();
  const polled = await legacy.call({ action: 'poll' }); expect(polled.status).toBe(409); expect(polled.value.error).toMatch(/Update the Controller/);
  expect((await legacy.call({ action: 'claim', teamId: 'team', memberId: 'worker', messageId: 'message' })).status).toBe(409);
  expect((await legacy.call({ action: 'settle', teamId: 'team', memberId: 'worker', messageId: 'pending-B', outcome: 'accepted', acceptance: 'started' })).status).toBe(409);
  expect(f.snapshot().teams![0]!.messages.find(m => m.id === 'pending-B')).toMatchObject({ status: 'unknown', resolvedTarget: ref('B') });
  expect((await f.request()).status).toBe(409);
  const modern = await f.connect(true);
  const poll = await modern.call({ action: 'poll' }); expect(poll.status).toBe(200); expect(poll.value[0].members[1].nativeSessionId).toBe('B');
  const claimed = await modern.call({ ...claim, expectedNativeSessionId: 'B' }); expect(claimed.status).toBe(200); expect(claimed.value.resolvedTarget).toEqual(ref('B'));
  expect(f.snapshot().teams![0]!.members[1]!.nativeSessionId).toBe('A');
  f.restart(); const downgraded = await f.connect(); expect(downgraded.packets[0].teamRecipients).toBeUndefined();
  expect((await downgraded.call({ action: 'poll' })).status).toBe(409); expect(downgraded.socket.readyState).toBe(WebSocket.OPEN);
}, 10000);

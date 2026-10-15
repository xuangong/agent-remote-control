import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { NativeSessionRef } from '@orchardworks/agent-remote-protocol';
import { createHostBroker, type RemoteHostBrokerState } from './broker.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); }, 5000);
const ref = (id: string): NativeSessionRef => ({ controllerId: 'controller', providerId: 'codex', nativeSessionId: id });
async function fixture(generic = false, operation = false, ambiguous = false) {
  let broker: ReturnType<typeof createHostBroker>;
  const http = createServer((incoming, response) => { void (async () => {
    let text = ''; for await (const chunk of incoming) text += chunk;
    const input = text ? JSON.parse(text) : {};
    if (incoming.method === 'GET') { response.end(JSON.stringify(broker.sessionRelations('owner'))); return; }
    if (incoming.url === '/status') { response.end(JSON.stringify(broker.sessionRelationChangeStatus('owner', input))); return; }
    if (incoming.url === '/reconcile') { response.end(JSON.stringify(await broker.reconcileSessionRelationChange('owner', input))); return; }
    if (incoming.url === '/import') await broker.importSessionRelation('owner', input);
    else if (incoming.url === '/reset') await broker.resetSessionRelationChange('owner', input);
    else await broker.updateSessionRelation('owner', input);
    response.end('{}');
  })().catch(error => { response.statusCode = error.status ?? 409; response.end(String(error)); }); });
  http.listen(0, '127.0.0.1'); await once(http, 'listening', { signal: AbortSignal.timeout(3000) });
  const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const authority = { version: 1 as const, origin, issuer: 'issuer', namespace: 'tenant', ownerSubject: 'owner' };
  const relation = { id: 'relation', kind: 'side' as const, sourceNativeSessionId: 'source', createdAt: '2026-10-10T00:00:00.000Z' };
  const initial: RemoteHostBrokerState = { keys: [], hosts: [{ id: 'host', installationId: 'controller', name: 'Host', legacyDsh: false, providers: [{ providerId: 'codex', displayName: 'Codex' }] }], bindings: ['source', 'A', 'B', 'C'].map(id => ({ hostId: 'host', providerId: 'codex', nativeSessionId: id, agentId: id, ...(id === 'A' ? { sourceRelation: relation } : {}) })), creations: [['created', { agentId: 'A', fingerprint: JSON.stringify({ sourceNativeSessionId: 'source' }) }]], associations: { version: 6, revision: 2, admissions: [], relationChanges: [], relationResets: [], freezes: [] } };
  for (const [revision, from, to] of [[1, 'A', 'B'], [2, 'B', 'C']] as const) {
    const request = { roleId: 'reader-role', operationId: `prefix-${revision}`, expectedRevision: revision, from: ref(from), ...(!generic ? { preparation: { kind: 'native_prefix' as const, turnId: 'turn', messageId: 'message' } } : {}) };
    const workspace = { controllerId: 'controller', canonicalCwd: '/work' };
    initial.associations!.freezes.push({ hostId: 'host', released: 'committed', receipt: { version: generic ? 2 : 3, maxProjectionBytes: 10000, token: `token-${revision}`, authority, controllerId: 'controller', request, associationRevision: 0, lineage: revision === 1 ? [ref('A')] : [ref('A'), ref('B')], relations: [{ relationId: relation.id, kind: relation.kind, sourceRef: ref('source'), readerRef: ref('A'), linked: true, revision: 0 }] }, projection: { version: 1, role: { id: 'reader-role', revision: revision + 1, origin: ref('A'), current: ref(to), workspace }, receipt: { ...request, to: ref(to), phase: 'committed', committedRevision: revision + 1, startedAt: 'now', updatedAt: 'now', prepared: { ...request, to: ref(to), workspace, participants: [], associationRevision: 0, capture: { epoch: 'e', seq: 1, capturedAt: 'now' } } } } });
  }
  if (ambiguous) initial.bindings.find(row => row.nativeSessionId === 'B')!.sourceRelation = { ...relation, id: 'other-relation' };
  if (operation) {
    initial.bindings.find(row => row.nativeSessionId === 'A')!.sourceRelation = { ...relation, revision: 1, linked: true };
    const reservation = { version: 1 as const, operationId: 'retained', token: 'retained-token', authority, hostId: 'host', controllerId: 'controller', roleId: 'source-role', expectedRoleRevision: 1, origin: ref('source'), current: ref('source'), lineage: [ref('source')], associationRevision: 0, catalogRevision: 0, relationId: relation.id, kind: relation.kind, readerRef: ref('A'), sourceRef: ref('source'), expectedRelationRevision: 0, previousLinked: true, linked: true, previousMember: true, relations: [{ relationId: relation.id, kind: relation.kind, readerRef: ref('A'), sourceRef: ref('source'), linked: true, revision: 0 }] };
    initial.associations!.relationChanges.push({ reservation, phase: 'committed', hostReceipt: { reservation, phase: 'released', associationRevision: 0 } });
  }
  let saved = initial;
  const make = () => createHostBroker({ origin, ownerSubject: 'owner', accountBacked: true, successionEnrollment: authority, initialState: saved, onStateChange: state => { saved = structuredClone(state); } });
  broker = make();
  const server = new WebSocketServer({ server: http });
  server.on('connection', async (socket, incoming) => {
    const upgrade = await broker.prepareUpgrade(new Request(origin + incoming.url, { headers: { authorization: incoming.headers.authorization! } }));
    if (!upgrade || upgrade instanceof Response) { socket.close(); return; }
    upgrade.accept({ get readyState() { return socket.readyState; }, send: text => socket.send(text), close: (code, reason) => socket.close(code, reason), onMessage: listener => { const receive = (data: WebSocket.RawData, binary: boolean) => { void listener(data.toString(), binary); }; socket.on('message', receive); return () => socket.off('message', receive); }, onClose: listener => { socket.on('close', listener); return () => socket.off('close', listener); }, onError: listener => { socket.on('error', listener); return () => socket.off('error', listener); } });
  });
  const pairing = await broker.handleRequest(new Request(origin + '/v1/remote/pairings', { method: 'POST', body: '{}' }), { principalSubject: () => 'owner' });
  const credential = await pairing!.json();
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws/remote-host?successionEnrollment=3', { headers: { authorization: `Bearer ${credential.key}` } });
  await once(socket, 'open', { signal: AbortSignal.timeout(3000) });
  const registered = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Registration deadline exceeded')), 3000);
    socket.on('message', data => { const message = JSON.parse(data.toString()); if (message.type === 'credential_issued') socket.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_saved' })); if (message.type === 'registered') { clearTimeout(timer); resolve(); } });
  });
  socket.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'controller', name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], credentialRotation: true }));
  await registered;
  close.push(async () => { socket.terminate(); broker.close(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); http.closeIdleConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const request = async (path: string, input?: unknown) => {
    const response = await fetch(origin + path, { ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(3000) });
    return { status: response.status, body: await response.text() };
  };
  return { request, saved: () => saved, broker: () => broker, restart: () => { broker.close(); broker = make(); }, relation };
}

test('HTTP descendant relation projection, update, import and reset retain exact original binding and creation receipt', async () => {
  const f = await fixture();
  expect(JSON.parse((await f.request('/')).body)[0].target).toMatchObject({ nativeSessionId: 'C', agentId: 'C' });
  const input = { hostId: 'host', providerId: 'codex', nativeSessionId: 'C', sourceNativeSessionId: 'source', id: 'relation', linked: false, expectedRevision: 0 };
  expect(await f.request('/update', input)).toMatchObject({ status: 200 });
  expect(await f.request('/import', { ...f.relation, ...input })).toMatchObject({ status: 200 });
  expect(await f.request('/reset', { ...input, nativeSessionId: 'B', expectedRevision: 1, linked: true, operationId: 'reset', expectedRoleRevision: 1 })).toMatchObject({ status: 200 });
  expect(f.saved().associations!.relationResets[0]!.intent.readerRef).toEqual(ref('A'));
  expect(f.saved().bindings.filter(row => row.sourceRelation)).toHaveLength(1);
  expect(f.saved().bindings.find(row => row.nativeSessionId === 'A')!.sourceRelation).toMatchObject({ linked: false, revision: 1 });
  expect(f.saved().creations).toHaveLength(1);
  f.restart();
  expect(f.broker().sessionRelations('owner')[0]!.target.nativeSessionId).toBe('C');
}, 10000);

test('generic lineage does not transfer a source relationship', async () => {
  const f = await fixture(true);
  expect((await f.request('/update', { hostId: 'host', providerId: 'codex', nativeSessionId: 'C', sourceNativeSessionId: 'source', id: 'relation', linked: false, expectedRevision: 0 })).status).toBeGreaterThanOrEqual(400);
  expect(f.saved().bindings.find(row => row.nativeSessionId === 'A')!.sourceRelation!.linked).toBeUndefined();
}, 10000);


test('HTTP status/reconcile retain the saved original operation identity after reader prefix succession', async () => {
  const f = await fixture(false, true);
  const selection = { hostId: 'host', operationId: 'retained' };
  for (const path of ['/status', '/reconcile']) {
    const response = await f.request(path, selection);
    expect(response.status, response.body).toBe(200);
    expect(JSON.parse(response.body).operation).toMatchObject({ phase: 'committed', reservation: { operationId: 'retained', readerRef: ref('A') } });
  }
  expect(f.broker().sessionRelations('owner')[0]!.target.nativeSessionId).toBe('C');
}, 10000);

test('ambiguous or unknown descendant ancestry cannot display or mutate a source grant', async () => {
  const f = await fixture(false, false, true);
  expect(JSON.parse((await f.request('/')).body)).toEqual([]);
  for (const nativeSessionId of ['C', 'unknown']) expect((await f.request('/update', { hostId: 'host', providerId: 'codex', nativeSessionId, sourceNativeSessionId: 'source', id: 'relation', linked: false, expectedRevision: 0 })).status).toBeGreaterThanOrEqual(400);
  expect(f.saved().bindings.filter(row => row.sourceRelation).every(row => row.sourceRelation!.linked === undefined)).toBe(true);
}, 10000);

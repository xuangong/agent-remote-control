import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { CommittedSuccessionProjection, NativeSessionRef, SuccessionAssociationFreeze } from '@orchardworks/agent-remote-protocol';
import { createHostBroker, type RemoteHostBrokerState } from './broker.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); }, 5000);
const ref = (id: string): NativeSessionRef => ({ controllerId: 'controller', providerId: 'codex', nativeSessionId: id });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(generic = false, operation = false, ambiguous = false, targetAccess?: 'unbound' | 'inaccessible' | 'authorized') {
  let broker: ReturnType<typeof createHostBroker>;
  const publicationEntered = deferred(), publicationReleased = deferred(), mutationQueued = deferred();
  let prefixProjection: CommittedSuccessionProjection | undefined;
  let prefixFreeze: SuccessionAssociationFreeze | undefined;
  let writes = 0;
  const http = createServer((incoming, response) => { void (async () => {
    let text = ''; for await (const chunk of incoming) text += chunk;
    const input = text ? JSON.parse(text) : {};
    const subject = String(incoming.headers['x-subject'] ?? 'owner');
    if (incoming.url === '/publish-prefix') {
      const result = await broker.handleRequest(new Request(origin + '/v1/remote/hosts/host/succession/commit', { method: 'POST', body: JSON.stringify(input) }), { principalSubject: () => subject });
      response.statusCode = result!.status; response.end(await result!.text()); return;
    }
    if (incoming.method === 'GET') { response.end(JSON.stringify(broker.sessionRelations(subject))); return; }
    if (incoming.url === '/status') { response.end(JSON.stringify(broker.sessionRelationChangeStatus('owner', input))); return; }
    if (incoming.url === '/reconcile') { response.end(JSON.stringify(await broker.reconcileSessionRelationChange('owner', input))); return; }
    if (incoming.url === '/import' || incoming.url === '/update') {
      const pending = incoming.url === '/import' ? broker.importSessionRelation(subject, input) : broker.updateSessionRelation(subject, input);
      // Both async entry points complete their synchronous preflight before returning the queued promise.
      mutationQueued.resolve(); await pending;
    }
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
  if (targetAccess) {
    initial.sharing = { grants: [{ hostId: 'host', subject: 'viewer', label: 'Viewer', sessionLimit: 10, revoked: false }], reservations: [] };
    for (const binding of initial.bindings) binding.creatorSubject = 'viewer';
    if (targetAccess !== 'unbound') initial.bindings.push({ hostId: 'host', providerId: 'codex', nativeSessionId: 'D', agentId: 'D', creatorSubject: targetAccess === 'authorized' ? 'viewer' : 'another-user' });
    const request = { roleId: 'reader-role', operationId: 'prefix-3', expectedRevision: 3, from: ref('C'), preparation: { kind: 'native_prefix' as const, turnId: 'turn', messageId: 'message' } };
    const previous = initial.associations!.freezes[1]!;
    prefixFreeze = { ...previous.receipt, token: 'token-3', request, lineage: [ref('A'), ref('B'), ref('C')] };
    prefixProjection = { version: 1, role: { ...previous.projection!.role, revision: 4, current: ref('D') }, receipt: { ...request, to: ref('D'), phase: 'committed', committedRevision: 4, startedAt: 'now', updatedAt: 'now', prepared: { ...previous.projection!.receipt.prepared!, ...request, to: ref('D') } } };
    initial.associations!.freezes.push({ hostId: 'host', receipt: prefixFreeze });
  }
  if (ambiguous) initial.bindings.find(row => row.nativeSessionId === 'B')!.sourceRelation = { ...relation, id: 'other-relation' };
  if (operation) {
    initial.bindings.find(row => row.nativeSessionId === 'A')!.sourceRelation = { ...relation, revision: 1, linked: true };
    const reservation = { version: 1 as const, operationId: 'retained', token: 'retained-token', authority, hostId: 'host', controllerId: 'controller', roleId: 'source-role', expectedRoleRevision: 1, origin: ref('source'), current: ref('source'), lineage: [ref('source')], associationRevision: 0, catalogRevision: 0, relationId: relation.id, kind: relation.kind, readerRef: ref('A'), sourceRef: ref('source'), expectedRelationRevision: 0, previousLinked: true, linked: true, previousMember: true, relations: [{ relationId: relation.id, kind: relation.kind, readerRef: ref('A'), sourceRef: ref('source'), linked: true, revision: 0 }] };
    initial.associations!.relationChanges.push({ reservation, phase: 'committed', hostReceipt: { reservation, phase: 'released', associationRevision: 0 } });
  }
  let saved = initial;
  let held = false;
  const make = () => createHostBroker({ origin, ownerSubject: 'owner', accountBacked: true, successionEnrollment: authority, initialState: saved, async onStateChange(state) {
    if (targetAccess && !held && state.associations!.freezes.at(-1)!.projection) {
      held = true; publicationEntered.resolve(); await publicationReleased.promise;
    }
    writes++; saved = structuredClone(state);
  } });
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
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'rpc_request') return;
    const input = JSON.parse(message.body);
    const body = input.action === 'release' ? {} : { role: prefixProjection!.role, record: prefixProjection!.receipt, freeze: prefixFreeze };
    socket.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: 200, body: JSON.stringify(body) }));
  });
  await once(socket, 'open', { signal: AbortSignal.timeout(3000) });
  const registered = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Registration deadline exceeded')), 3000);
    socket.on('message', data => { const message = JSON.parse(data.toString()); if (message.type === 'credential_issued') socket.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_saved' })); if (message.type === 'registered') { clearTimeout(timer); resolve(); } });
  });
  socket.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'controller', name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], credentialRotation: true }));
  await registered;
  close.push(async () => { publicationReleased.resolve(); socket.terminate(); broker.close(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); http.closeIdleConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const request = async (path: string, input?: unknown, subject = 'owner') => {
    const response = await fetch(origin + path, { headers: { 'x-subject': subject }, ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(3000) });
    return { status: response.status, body: await response.text() };
  };
  return { request, saved: () => saved, writes: () => writes, publicationEntered: publicationEntered.promise, publish: publicationReleased.resolve, mutationQueued: mutationQueued.promise, broker: () => broker, restart: () => { broker.close(); broker = make(); }, relation };
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

for (const path of ['/import', '/update']) test.each(['unbound', 'inaccessible', 'authorized'] as const)(`queued HTTP ${path} rechecks the published current reader (%s) before writing the original relation`, async access => {
  const f = await fixture(false, false, false, access);
  const before = structuredClone(f.saved()), writes = f.writes();
  expect(JSON.parse((await f.request('/', undefined, 'viewer')).body)[0].target.nativeSessionId).toBe('C');
  const publishing = f.request('/publish-prefix', { operationId: 'prefix-3' });
  await f.publicationEntered;
  const input = { ...f.relation, hostId: 'host', providerId: 'codex', nativeSessionId: 'C', linked: false, expectedRevision: 0 };
  const changing = f.request(path, input, 'viewer');
  await f.mutationQueued;
  // The owner commit has entered persistence, but preflight still observes the accessible C projection.
  expect(JSON.parse((await f.request('/', undefined, 'viewer')).body)[0].target.nativeSessionId).toBe('C');
  expect(f.writes()).toBe(writes);
  f.publish();
  expect(await publishing).toMatchObject({ status: 200 });
  const result = await changing;
  expect(result.status, result.body).toBe(access === 'authorized' ? 200 : 403);
  const saved = f.saved();
  expect(saved.associations!.freezes.at(-1)!.projection!.role.current).toEqual(ref('D'));
  expect(saved.creations).toEqual([['created', { agentId: 'A', fingerprint: JSON.stringify({ sourceNativeSessionId: 'source' }) }]]);
  expect(saved.bindings.filter(row => row.sourceRelation)).toHaveLength(1);
  if (access === 'authorized') {
    expect(f.writes()).toBe(writes + 2);
    expect(saved.associations!.revision).toBe(4);
    expect(saved.bindings.find(row => row.nativeSessionId === 'A')!.sourceRelation).toEqual(path === '/update' ? { ...f.relation, linked: false, revision: 1 } : f.relation);
    expect(JSON.parse((await f.request('/', undefined, 'viewer')).body)[0].target.nativeSessionId).toBe('D');
  } else {
    expect(f.writes()).toBe(writes + 1);
    expect(saved.associations!.revision).toBe(3);
    expect(saved.bindings).toEqual(before.bindings);
    expect(saved.creations).toEqual(before.creations);
    expect(JSON.parse((await f.request('/', undefined, 'viewer')).body)).toEqual([]);
  }
}, 10000);

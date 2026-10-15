// @vitest-environment node
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, expect, test } from 'vitest';
import { createRelayState, emptyRelayState, validateRelayState, stageRelayState, type HostedRelayState } from '../../../agent-remote-hosted/src/state.js';
import type { RemoteHostBrokerState } from '../../../agent-remote-hosted/src/broker.js';
import { MAX_RETAINED_HOST_IDENTITIES } from '../../../agent-remote-hosted/src/host-recovery.js';
import { createRemoteHostBroker } from './remote-host-broker.js';

const origin = 'http://127.0.0.1:6175';
const auth = { origin, issuer: 'https://gateway.example', secret: 'test-recovery-secret'.repeat(3) };
const namespace = createHash('sha256').update(JSON.stringify([auth.issuer, 'owner'])).digest('hex');
const authority = { version: 1 as const, origin, issuer: auth.issuer, namespace, ownerSubject: 'owner' };
const ref = (nativeSessionId: string) => ({ controllerId: 'installation', providerId: 'fixture', nativeSessionId });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function legacyInitial(kind: 'committed' | 'pending' | 'admission' | 'ordinary' = 'committed') {
  const state = emptyRelayState(auth);
  const workspace = { controllerId: 'installation', canonicalCwd: '/workspace' };
  const request = { operationId: 'succession', roleId: 'role', expectedRevision: 1, from: ref('A') };
  const receipt = { version: 1 as const, token: 'freeze', authority, controllerId: 'installation', request,
    associationRevision: 0, lineage: [ref('A')], relations: [] };
  const projection = { version: 1 as const, role: { id: 'role', revision: 2, origin: ref('A'), current: ref('B'), workspace },
    receipt: { ...request, to: ref('B'), phase: 'committed' as const, committedRevision: 2, startedAt: 'now', updatedAt: 'now',
      prepared: { ...request, to: ref('B'), workspace, associationRevision: 1, participants: [], capture: { epoch: 'e', seq: 1, capturedAt: 'now' } } } };
  const broker: RemoteHostBrokerState = {
    keys: [[createHash('sha256').update('arc_fixture').digest('hex'), { expires: Number.MAX_SAFE_INTEGER, installationId: 'installation', kind: 'device' }]],
    hosts: [{ id: 'host', installationId: 'installation', name: 'Host', legacyDsh: false, credentialRotation: true, providers: [{ providerId: 'fixture', displayName: 'Fixture' }] }],
    bindings: [{ hostId: 'host', providerId: 'fixture', nativeSessionId: 'A', agentId: 'agent' }], creations: [],
    sharing: { grants: [{ hostId: 'host', subject: 'guest', label: 'Guest', sessionLimit: 2, revoked: false }],
      reservations: [{ key: 'quota', hostId: 'host', subject: 'guest', fingerprint: 'fingerprint', nativeRequestId: 'native-request', agentId: 'agent' }] },
    ...(kind === 'ordinary' ? {} : { associations: { version: 6 as const, revision: 1, relationChanges: [], relationResets: [],
      admissions: kind === 'admission' ? [{ id: 'source-admission', fingerprint: 'source-fingerprint', source: ref('A') }] : [],
      freezes: kind === 'admission' ? [] : [{ hostId: 'host', receipt, ...(kind === 'committed' ? { released: 'committed' as const, projection } : {}) }] } }),
  };
  // Keep historical raw input separate from the current typed broker state.
  return { ...state, version: kind === 'ordinary' ? 2 : 9, tenants: [{ subject: 'owner', namespace,
    broker: { ...broker, ...(broker.associations ? { associations: { ...broker.associations, version: 5 } } : {}) } }] };
}
function initial(kind: Parameters<typeof legacyInitial>[0] = 'committed'): HostedRelayState {
  const state = validateRelayState(legacyInitial(kind), auth);
  stageRelayState(state, state.version, false);
  return state;
}
async function fixture(saved: unknown = legacyInitial()) {
  const initialState = validateRelayState(saved, auth);
  const directory = await mkdtemp(join(tmpdir(), 'succession-revoke-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  let hold: ((value: HostedRelayState) => Promise<void>) | undefined;
  const state = createRelayState(auth, { initial: initialState, async commit(value) {
    await hold?.(value); validateRelayState(value, auth);
    await writeFile(path + '.tmp', JSON.stringify(value)); await rename(path + '.tmp', path);
  } }, () => {}, () => {});
  const broker = createRemoteHostBroker({ origin, ownerSubject: 'owner', durable: true,
    ...(initialState.tenants[0]!.broker.associations ? { successionEnrollment: authority, successionProjectionAllowance: () => 2 * 1024 * 1024 } : {}),
    initialState: initialState.tenants[0]!.broker, principalSubject: request => String(request.headers['x-subject'] ?? 'owner'),
    onStateChange: value => state.mutate(draft => { draft.tenants[0]!.broker = value; }), rpcTimeoutMs: 2000,
  });
  const server = createServer((_, response) => { response.writeHead(404); response.end(); });
  broker.install(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await broker.close(); await new Promise<void>(resolve => server.close(() => resolve())); await state.close(); };
  cleanup.push(close);
  const post = (path: string, value = {}, subject = 'owner') => fetch(url + path, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-subject': subject }, body: JSON.stringify(value), signal: AbortSignal.timeout(4000) });
  return { broker, url, post, close, hold: (value?: typeof hold) => { hold = value; },
    read: async () => validateRelayState(JSON.parse(await readFile(path, 'utf8')), auth) };
}
async function connect(url: string, credential = 'arc_fixture', installationId = 'installation', register = true, enrollmentVersion: 1 | 2 = 1) {
  const socket = new WebSocket(url.replace('http:', 'ws:') + `/ws/remote-host?successionEnrollment=${enrollmentVersion}`, { headers: { authorization: `Bearer ${credential}` } });
  const frames: any[] = [];
  const listeners = new Set<() => void>();
  socket.on('error', () => {});
  socket.on('message', data => { const frame = JSON.parse(data.toString()); frames.push(frame); for (const listener of listeners) listener(); });
  function next(predicate: (frame: any) => boolean) {
    return new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => { listeners.delete(check); reject(new Error('Uplink frame deadline exceeded')); }, 3000);
      function check() { const index = frames.findIndex(predicate); if (index < 0) return; clearTimeout(timeout); listeners.delete(check); resolve(frames.splice(index, 1)[0]); }
      listeners.add(check); check();
    });
  }
  await once(socket, 'open', { signal: AbortSignal.timeout(3000) });
  cleanup.push(async () => { if (socket.readyState === WebSocket.CLOSED) return; const closed = once(socket, 'close', { signal: AbortSignal.timeout(3000) }); socket.terminate(); await closed; });
  const registration = () => socket.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId, name: 'Recovered Host', credentialRotation: true,
    providers: [{ providerId: 'fixture', displayName: 'Fixture' }] }));
  if (register) registration();
  const reply = (request: any, payload: unknown, status = 200) => socket.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: request.requestId, status, body: JSON.stringify(payload) }));
  return { socket, next, reply, registration };
}

test.each(['committed', 'pending', 'admission'] as const)('revokes %s succession access without deleting evidence across restart', async kind => {
  const raw = legacyInitial(kind); expect(validateRelayState(raw, auth)).toEqual(raw);
  const original = initial(kind), f = await fixture(raw), native = await connect(f.url);
  await native.next(frame => frame.type === 'registered');
  const closed = once(native.socket, 'close', { signal: AbortSignal.timeout(3000) });
  expect((await f.post('/v1/remote/hosts/host/revoke')).status).toBe(200);
  expect((await closed)[0]).toBe(1008);
  const saved = await f.read(), snapshot = saved.tenants[0]!.broker;
  expect(snapshot.associations).toEqual(original.tenants[0]!.broker.associations);
  expect(snapshot.hosts).toEqual([]); expect(snapshot.bindings).toEqual([]); expect(snapshot.keys).toEqual([]);
  expect(snapshot.sharing!.grants[0]!.revoked).toBe(true);
  expect(snapshot.sharing!.reservations).toEqual(original.tenants[0]!.broker.sharing!.reservations);
  expect(saved.version).toBe(11);
  await f.close();
  const restored = await fixture(saved);
  expect(restored.broker.snapshot().associations).toEqual(snapshot.associations);
  expect(restored.broker.canAccessHost('host', 'guest')).toBe(false);
  expect((await restored.post('/v1/remote/hosts/host/succession/status', { operationId: 'succession' })).status).toBe(404);
});

test('explicit owner recovery reuses history identity with new credentials and no old sharing', async () => {
  const f = await fixture();
  expect((await f.post('/v1/remote/hosts/host/revoke')).status).toBe(200);
  expect((await f.post('/v1/remote/pairings', { purpose: 'host-only', recoverHostId: 'host' }, 'guest')).status).toBe(403);
  const paired = await f.post('/v1/remote/pairings', { purpose: 'host-only', recoverHostId: 'host' });
  expect(paired.status).toBe(201);
  const invitation = await paired.json();
  expect(invitation.recovery).toMatchObject({ hostId: 'host', installationId: 'installation' });
  const native = await connect(f.url, invitation.key);
  const issued = await native.next(frame => frame.type === 'credential_issued');
  native.socket.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_saved' }));
  expect(await native.next(frame => frame.type === 'registered')).toMatchObject({ hostId: 'host' });
  expect(issued.credential).not.toBe(invitation.key);
  expect(f.broker.snapshot().bindings).toEqual([]);
  expect(f.broker.canAccessHost('host', 'guest')).toBe(false);
  expect(f.broker.snapshot().associations).toEqual(initial().tenants[0]!.broker.associations);
  const saved = await f.read(); await f.close();
  const restored = await fixture(saved), reconnected = await connect(restored.url, issued.credential);
  expect(await reconnected.next(frame => frame.type === 'registered')).toMatchObject({ hostId: 'host' });
  expect(restored.broker.canAccessHost('host', 'guest')).toBe(false);
});

test('ordinary Host revoke and fresh pairing keep the version 2 persistence path', async () => {
  const f = await fixture(initial('ordinary'));
  expect((await f.post('/v1/remote/hosts/host/revoke')).status).toBe(200);
  expect((await f.read()).version).toBe(2);
  const invitation = await (await f.post('/v1/remote/pairings')).json();
  const native = await connect(f.url, invitation.key);
  await native.next(frame => frame.type === 'credential_issued');
  native.socket.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_saved' }));
  expect((await native.next(frame => frame.type === 'registered')).hostId).not.toBe('host');
  expect((await f.read()).version).toBe(2);
});

test('rejects old credentials and an already upgraded socket after revocation', async () => {
  const f = await fixture(), prepared = await connect(f.url, 'arc_fixture', 'installation', false);
  expect((await f.post('/v1/remote/hosts/host/revoke')).status).toBe(200);
  const closed = once(prepared.socket, 'close', { signal: AbortSignal.timeout(3000) });
  prepared.registration();
  expect((await closed)[0]).toBe(1008);
  await expect(connect(f.url)).rejects.toThrow(/401/);
  expect(f.broker.snapshot().hosts).toEqual([]);
  expect((await f.post('/v1/remote/pairings', { recoverHostId: 'host' })).status).toBe(201);
});

test('rejects untargeted and mismatched recovery registration without consuming the correct invitation', async () => {
  const f = await fixture();
  await f.post('/v1/remote/hosts/host/revoke');
  for (const installationId of ['installation', 'different-installation']) {
    const invitation = await (await f.post('/v1/remote/pairings', installationId === 'installation' ? {} : { recoverHostId: 'host' })).json();
    const native = await connect(f.url, invitation.key, installationId, false);
    const closed = once(native.socket, 'close', { signal: AbortSignal.timeout(3000) }); native.registration();
    expect((await closed)[0]).toBe(1008);
    expect(f.broker.snapshot().hosts).toEqual([]);
    if (installationId !== 'installation') {
      const authorized = await connect(f.url, invitation.key);
      await authorized.next(frame => frame.type === 'credential_issued');
      authorized.socket.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_saved' }));
      expect(await authorized.next(frame => frame.type === 'registered')).toMatchObject({ hostId: 'host' });
    }
  }
});

test('only one recovery invitation succeeds and the next revocation invalidates its device credential', async () => {
  const f = await fixture(); await f.post('/v1/remote/hosts/host/revoke');
  const first = await (await f.post('/v1/remote/pairings', { recoverHostId: 'host' })).json();
  const second = await (await f.post('/v1/remote/pairings', { recoverHostId: 'host' })).json();
  const stale = await connect(f.url, second.key, 'installation', false);
  const native = await connect(f.url, first.key);
  const issued = await native.next(frame => frame.type === 'credential_issued');
  native.socket.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_saved' })); await native.next(frame => frame.type === 'registered');
  const staleClosed = once(stale.socket, 'close', { signal: AbortSignal.timeout(3000) }); stale.registration();
  expect((await staleClosed)[0]).toBe(1008);
  expect((await f.post('/v1/remote/pairings', { recoverHostId: 'host' })).status).toBe(409);
  await f.post('/v1/remote/hosts/host/revoke');
  await expect(connect(f.url, issued.credential)).rejects.toThrow(/401/);
  const fresh = await (await f.post('/v1/remote/pairings', { recoverHostId: 'host' })).json();
  expect(fresh.recovery.revocationId).not.toBe(first.recovery.revocationId);
  expect(f.broker.snapshot().hosts).toEqual([]);
});

async function revokeDuringResponse(f: Awaited<ReturnType<typeof fixture>>, native: Awaited<ReturnType<typeof connect>>, response: () => void) {
  const probe = fetch(f.url + '/v1/remote/hosts/host/catalog?providerId=fixture', { signal: AbortSignal.timeout(4000) });
  const request = await native.next(frame => frame.type === 'rpc_request' && frame.path.includes('/catalog'));
  const entered = deferred(), held = deferred();
  f.hold(async value => { if (!value.tenants[0]!.broker.hosts.length) { entered.resolve(); await held.promise; } });
  const revoking = f.post('/v1/remote/hosts/host/revoke'); await entered.promise;
  // Ordered WS frames and the independent HTTP response witness the old RPC being
  // resolved while the revoke commit still holds the broker's publication queue.
  response(); native.reply(request, { items: [], revision: 'probe' });
  try { expect((await probe).status).toBe(200); } finally { f.hold(); held.resolve(); }
  expect((await revoking).status).toBe(200);
}

test('does not publish a described freeze queued behind revocation', async () => {
  const saved = initial('admission'); saved.tenants[0]!.broker.associations!.admissions = [];
  const f = await fixture(saved), native = await connect(f.url, 'arc_fixture', 'installation', true, 2);
  expect(await native.next(frame => frame.type === 'registered')).toMatchObject({ successionEnrollmentVersion: 2 });
  const preparing = f.post('/v1/remote/hosts/host/succession/prepare', { operationId: 'late-freeze', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1 });
  const request = await native.next(frame => frame.type === 'rpc_request');
  expect(request.path).toBe('/remote/succession/enrollment'); expect(JSON.parse(request.body).action).toBe('describe');
  await revokeDuringResponse(f, native, () => native.reply(request, { role: { id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace: { controllerId: 'installation', canonicalCwd: '/workspace' } }, lineage: [ref('A')] }));
  expect((await preparing).status).toBe(401);
  expect((await f.read()).tenants[0]!.broker.associations!.freezes).toEqual([]);
});

test('retains a pending freeze when terminal readback resolves behind revocation', async () => {
  const f = await fixture(initial('pending')), native = await connect(f.url); await native.next(frame => frame.type === 'registered');
  const committing = f.post('/v1/remote/hosts/host/succession/commit', { operationId: 'succession' });
  const frozen = initial().tenants[0]!.broker.associations!.freezes[0]!;
  const payload = { freeze: frozen.receipt, record: frozen.projection!.receipt, role: frozen.projection!.role };
  native.reply(await native.next(frame => frame.type === 'rpc_request'), payload);
  const readback = await native.next(frame => frame.type === 'rpc_request');
  expect(JSON.parse(readback.body).action).toBe('status');
  await revokeDuringResponse(f, native, () => native.reply(readback, payload));
  expect((await committing).status).toBe(401);
  expect((await f.read()).tenants[0]!.broker.associations).toEqual(initial('pending').tenants[0]!.broker.associations);
});

test.each([200, 400])('retains source admission when a native %s result resolves behind revocation', async status => {
  const saved = initial('admission'); saved.tenants[0]!.broker.associations!.admissions = [];
  const f = await fixture(saved), native = await connect(f.url); await native.next(frame => frame.type === 'registered');
  const creating = f.post('/v1/remote/hosts/host/create', { providerId: 'fixture', operationId: '00000000-0000-4000-8000-000000000010', sourceNativeSessionId: 'A' });
  const request = await native.next(frame => frame.type === 'rpc_request');
  const admission = f.broker.snapshot().associations!.admissions;
  expect(admission).toHaveLength(1);
  await revokeDuringResponse(f, native, () => native.reply(request, status === 200 ? { agentId: 'late-agent', nativeSessionId: 'late-session' } : { code: 'operation_rejected', error: 'Rejected' }, status));
  expect((await creating).status).not.toBe(200);
  const snapshot = (await f.read()).tenants[0]!.broker;
  expect(snapshot.associations!.admissions).toEqual(admission);
  expect(snapshot.bindings).toEqual([]); expect(snapshot.creations).toEqual([]);
});

test('preserves a pending relationship reservation when its readback completes behind revocation', async () => {
  const saved = initial('admission'), broker = saved.tenants[0]!.broker;
  broker.associations!.admissions = [];
  const reservation = { version: 1 as const, operationId: 'relation-edit', token: 'relation-token', authority, hostId: 'host', controllerId: 'installation',
    roleId: 'role', expectedRoleRevision: 1, origin: ref('A'), current: ref('A'), lineage: [ref('A')], associationRevision: 0, catalogRevision: 1,
    relationId: 'side', kind: 'side' as const, readerRef: ref('S'), sourceRef: ref('A'), expectedRelationRevision: 0, previousLinked: true, linked: false,
    previousMember: true, relations: [{ relationId: 'side', kind: 'side' as const, readerRef: ref('S'), sourceRef: ref('A'), linked: true, revision: 0 }] };
  broker.associations!.relationChanges = [{ reservation, phase: 'reserved' }];
  broker.bindings.push({ hostId: 'host', providerId: 'fixture', nativeSessionId: 'S', agentId: 'side-agent', sourceRelation: { id: 'side', kind: 'side', sourceNativeSessionId: 'A', createdAt: '2026-10-10T00:00:00.000Z' } });
  const f = await fixture(saved), native = await connect(f.url); await native.next(frame => frame.type === 'registered');
  const reconciling = f.broker.reconcileSessionRelationChange('owner', { hostId: 'host', operationId: 'relation-edit' }).catch(error => error);
  const request = await native.next(frame => frame.type === 'rpc_request');
  expect(JSON.parse(request.body).action).toBe('relation_status');
  await revokeDuringResponse(f, native, () => native.reply(request, { receipt: { reservation, phase: 'reserved', associationRevision: 0 } }));
  expect(await reconciling).toBeInstanceOf(Error);
  expect((await f.read()).tenants[0]!.broker.associations).toEqual(broker.associations);
});

test('does not save a pending rotated credential behind revocation', async () => {
  const f = await fixture(), native = await connect(f.url); await native.next(frame => frame.type === 'registered');
  expect((await f.post('/v1/remote/hosts/host/rotate')).status).toBe(200);
  const pending = await native.next(frame => frame.type === 'credential_issued');
  await revokeDuringResponse(f, native, () => native.socket.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_saved' })));
  await expect(connect(f.url, pending.credential)).rejects.toThrow(/401/);
  expect((await f.read()).tenants[0]!.broker.keys).toEqual([]);
});

test('closes the active browser stream while another Host remains connected and usable', async () => {
  const saved = initial(), broker = saved.tenants[0]!.broker;
  broker.hosts.push({ ...broker.hosts[0]!, id: 'other', installationId: 'other-installation' });
  broker.keys.push([createHash('sha256').update('arc_other').digest('hex'), { expires: Number.MAX_SAFE_INTEGER, installationId: 'other-installation', kind: 'device' }]);
  const f = await fixture(saved), native = await connect(f.url), other = await connect(f.url, 'arc_other', 'other-installation');
  await native.next(frame => frame.type === 'registered'); await other.next(frame => frame.type === 'registered');
  const browser = new WebSocket(f.url.replace('http:', 'ws:') + '/v1/sessions/agent/events', { headers: { origin } });
  browser.on('error', () => {}); cleanup.push(async () => { browser.terminate(); });
  const opened = once(browser, 'open', { signal: AbortSignal.timeout(3000) });
  const recovering = await native.next(frame => frame.type === 'rpc_request'); native.reply(recovering, { agentId: 'agent', nativeSessionId: 'A' });
  await opened;
  const stream = await native.next(frame => frame.type === 'stream_open');
  native.socket.send(JSON.stringify({ uplinkVersion: 2, type: 'stream_opened', streamId: stream.streamId }));
  const browserClosed = once(browser, 'close', { signal: AbortSignal.timeout(3000) });
  expect((await f.post('/v1/remote/hosts/host/revoke')).status).toBe(200);
  expect((await browserClosed)[0]).toBe(1008);
  expect(other.socket.readyState).toBe(WebSocket.OPEN);
  const catalog = fetch(f.url + '/v1/remote/hosts/other/catalog?providerId=fixture', { signal: AbortSignal.timeout(4000) });
  other.reply(await other.next(frame => frame.type === 'rpc_request'), { items: [], revision: 'still-connected' });
  expect((await catalog).status).toBe(200);
  expect((await f.read()).tenants[0]!.broker.hosts.map(host => host.id)).toEqual(['other']);
});

test('reserves identity capacity before source creation but still revokes an existing identity at capacity', async () => {
  const saved = initial('admission');
  const broker = saved.tenants[0]!.broker; broker.associations!.admissions = [];
  broker.revokedHosts = Array.from({ length: MAX_RETAINED_HOST_IDENTITIES }, (_, index) => ({ hostId: `history-${index}`, installationId: `history-installation-${index}`, revocationId: randomUUID() }));
  const f = await fixture(saved), native = await connect(f.url); await native.next(frame => frame.type === 'registered');
  let rpcCount = 0; native.socket.on('message', raw => { if (JSON.parse(raw.toString()).type === 'rpc_request') rpcCount++; });
  const refused = await f.post('/v1/remote/hosts/host/create', { providerId: 'fixture', operationId: '00000000-0000-4000-8000-000000000011', sourceNativeSessionId: 'A' });
  expect(refused.status).toBe(409); expect((await refused.json()).code).toBe('host_recovery_capacity');
  expect(rpcCount).toBe(0); expect(f.broker.snapshot().associations!.admissions).toEqual([]);
  expect((await f.post('/v1/remote/hosts/host/revoke')).status).toBe(200);
  expect((await f.read()).tenants[0]!.broker.revokedHosts).toHaveLength(MAX_RETAINED_HOST_IDENTITIES);
  await f.close();
  const retained = initial('admission');
  retained.tenants[0]!.broker.revokedHosts = [...broker.revokedHosts.slice(0, -1), { hostId: 'host', installationId: 'installation', revocationId: randomUUID() }];
  const full = await fixture(retained);
  expect((await full.post('/v1/remote/hosts/host/revoke')).status).toBe(200);
  const after = (await full.read()).tenants[0]!.broker;
  expect(after.revokedHosts).toHaveLength(MAX_RETAINED_HOST_IDENTITIES);
  expect(after.associations).toEqual(retained.tenants[0]!.broker.associations);
});

test('rejects an old request after recovery reuses the Host ID and initial connection generation', async () => {
  const f = await fixture(), original = await connect(f.url); await original.next(frame => frame.type === 'registered');
  const reading = deferred(), release = deferred();
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    reading.resolve(); await release.promise;
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ providerId: 'fixture', operationId: '00000000-0000-4000-8000-000000000012' }))); controller.close();
  } }, { highWaterMark: 0 });
  const request = new Request(f.url + '/v1/remote/hosts/host/create', { method: 'POST', body, duplex: 'half' } as RequestInit & { duplex: 'half' });
  const stale = f.broker.handleRequest(request, { principalSubject: () => 'owner' }); await reading.promise;
  await f.post('/v1/remote/hosts/host/revoke');
  const invitation = await (await f.post('/v1/remote/pairings', { recoverHostId: 'host' })).json();
  const recovered = await connect(f.url, invitation.key); await recovered.next(frame => frame.type === 'credential_issued');
  recovered.socket.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_saved' }));
  expect(await recovered.next(frame => frame.type === 'registered')).toMatchObject({ hostId: 'host' });
  release.resolve();
  expect((await stale)?.status).toBe(401);
  expect(f.broker.snapshot().bindings).toEqual([]);
  expect(recovered.socket.readyState).toBe(WebSocket.OPEN);
});

test('rejects registration and preview snapshots queued behind revocation without poisoning recovery', async () => {
  const f = await fixture(), native = await connect(f.url); await native.next(frame => frame.type === 'registered');
  const pending = await connect(f.url, 'arc_fixture', 'installation', false);
  const pendingClosed = once(pending.socket, 'close', { signal: AbortSignal.timeout(3000) });
  await revokeDuringResponse(f, native, () => {
    pending.registration();
    native.socket.send(JSON.stringify({ uplinkVersion: 2, type: 'preview_snapshot', snapshot: { epoch: 'late', revision: 1, registrations: [] } }));
    native.socket.send(JSON.stringify({ uplinkVersion: 2, type: 'preview_snapshot', snapshot: { epoch: 'late', revision: 2, registrations: [] } }));
  });
  expect((await pendingClosed)[0]).toBe(1008);
  expect(f.broker.snapshot().previews).toEqual([]);
  expect((await f.post('/v1/remote/pairings', { recoverHostId: 'host' })).status).toBe(201);
});

test('recovers a legacy historical mapping without inheriting its previous credentials or shares', async () => {
  const saved = initial(); saved.tenants[0]!.broker.hosts = []; saved.tenants[0]!.broker.bindings = [];
  const f = await fixture(saved);
  const invitation = await (await f.post('/v1/remote/pairings', { recoverHostId: 'host' })).json();
  expect(f.broker.snapshot().revokedHosts![0]!.revokedAt).toBeUndefined();
  await expect(connect(f.url)).rejects.toThrow(/401/);
  const native = await connect(f.url, invitation.key); await native.next(frame => frame.type === 'credential_issued');
  native.socket.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_saved' })); await native.next(frame => frame.type === 'registered');
  expect(f.broker.canAccessHost('host', 'guest')).toBe(false);
  expect(f.broker.snapshot().sharing!.reservations).toEqual(saved.tenants[0]!.broker.sharing!.reservations);
});

test('migrates legacy history to Relay11 and keeps a pre-effect reset through ordinary re-pair and restart without restoring old access', async () => {
  const ordinary = initial('ordinary'), tenant = ordinary.tenants[0]!;
  const broker = { ...tenant.broker, associations: { version: 4, revision: 1, relationChanges: [], relationResets: [], freezes: [],
    admissions: [{ id: 'retained-admission', fingerprint: 'retained', source: { ...ref('other'), controllerId: 'retained-installation' } }] } };
  const saved = { ...ordinary, version: 6, tenants: [{ ...tenant, broker }] };
  broker.hosts.push({ ...broker.hosts[0]!, id: 'retained-host', installationId: 'retained-installation' });
  broker.bindings.push({ hostId: 'host', providerId: 'fixture', nativeSessionId: 'S', agentId: 'side-agent', sourceRelation: { id: 'side', kind: 'side', sourceNativeSessionId: 'A', createdAt: '2026-10-10T00:00:00.000Z' } });
  expect(validateRelayState(saved, auth)).toEqual(saved);
  const f = await fixture(saved), original = await connect(f.url); await original.next(frame => frame.type === 'registered');
  const migrated = await f.read(); expect(migrated.version).toBe(11);
  expect(migrated.tenants[0]!.broker.associations).toEqual({ ...broker.associations, version: 6 });
  const reset = await f.broker.resetSessionRelationChange('owner', { hostId: 'host', providerId: 'fixture', nativeSessionId: 'S', sourceNativeSessionId: 'A', id: 'side',
    linked: false, expectedRevision: 0, expectedRoleRevision: 1, operationId: 'reset-before-revoke' });
  expect(reset).toMatchObject({ reset: { phase: 'pre_effect', intent: { hostId: 'host' } } });
  const history = f.broker.snapshot().associations;
  expect((await f.post('/v1/remote/hosts/host/revoke')).status).toBe(200);
  expect((await f.read()).version).toBe(11);
  expect(f.broker.snapshot().revokedHosts).toBeUndefined();
  const invitation = await (await f.post('/v1/remote/pairings')).json(), repaired = await connect(f.url, invitation.key);
  const issued = await repaired.next(frame => frame.type === 'credential_issued');
  repaired.socket.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_saved' }));
  const { hostId } = await repaired.next(frame => frame.type === 'registered'); expect(hostId).not.toBe('host');
  const paired = await f.read(); expect(paired.version).toBe(11); expect(paired.tenants[0]!.broker.associations).toEqual(history);
  expect(paired.tenants[0]!.broker.bindings).toEqual([]); expect(f.broker.canAccessHost('host', 'guest')).toBe(false);
  await f.close();
  const upgraded = await fixture(paired), active = await connect(upgraded.url, issued.credential); await active.next(frame => frame.type === 'registered');
  expect((await upgraded.post('/v1/remote/hosts/retained-host/revoke')).status).toBe(200);
  const durable = await upgraded.read(); expect(durable.version).toBe(11);
  expect(durable.tenants[0]!.broker.hosts.map(host => host.id)).toEqual([hostId]);
  expect(durable.tenants[0]!.broker.associations).toEqual(history);
  expect(durable.tenants[0]!.broker.revokedHosts!.map(marker => marker.hostId)).toEqual(['retained-host']);
  expect(active.socket.readyState).toBe(WebSocket.OPEN);
  expect((await upgraded.post('/v1/remote/pairings', { recoverHostId: 'host' })).status).toBe(409);
  await upgraded.close();
  const restarted = await fixture(durable), current = await connect(restarted.url, issued.credential);
  expect(await current.next(frame => frame.type === 'registered')).toMatchObject({ hostId });
  await expect(connect(restarted.url)).rejects.toThrow(/401/);
  expect((await restarted.post('/v1/remote/pairings', { recoverHostId: 'host' })).status).toBe(409);
  expect(restarted.broker.snapshot().associations).toEqual(history);
  expect(restarted.broker.canAccessHost(hostId, 'guest')).toBe(false);
  expect(restarted.broker.snapshot().bindings).toEqual([]);
});

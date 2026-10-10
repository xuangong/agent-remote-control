import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, expect, test } from 'vitest';
import { createHostedRelay } from './gateway.js';
import { createHostBroker, type HostBrokerOptions } from './broker.js';
import { assertSuccessionCapacity, deriveSuccessionCapacity } from './succession-capacity.js';
import { projectSuccessionFavorites } from './favorites-succession.js';
import { codecState } from '../../agent-remote-cloudflare/test/storage-codec-fixture.js';
import { encodeSqlSnapshot, quoteSqlRecord, SQL_SNAPSHOT_FORMAT, SQL_RECORD_FORMAT, SQL_CHUNK_BYTES } from '../../agent-remote-cloudflare/src/storage-codec.js';
import { createRelayState, emptyRelayState, validateRelayState, type HostedRelayState } from './state.js';
import { decodeSessionChannelServerMessage, type CommittedSuccessionProjection, type SuccessionAssociationFreeze } from '@orchardworks/agent-remote-protocol';
import type { RelaySocket } from './transport.js';
const { WebSocket, WebSocketServer } = createRequire(new URL('../../agent-remote-relay/package.json', import.meta.url))('ws');
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); }, 10000);
const ref = (nativeSessionId: string) => ({ controllerId: 'installation', providerId: 'fixture', nativeSessionId });
const workspace = { controllerId: 'installation', canonicalCwd: '/workspace' };
const sequenceRef = (index: number) => ref(index < 3 ? ['A', 'B', 'C'][index]! : 'N' + index);
async function fixture(configure?: (state: HostedRelayState) => void, recentAuthentication = false, accounting = false, directBroker = false) {
  const credential = 'arc_' + 'k'.repeat(43);
  let denied = false, unavailable = false;
  const authority = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const input = JSON.parse(text); const subject = input.subject ?? input.continuation;
    response.writeHead(unavailable ? 503 : denied ? 403 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ active: true, subject, validUntil: Date.now() + 60000, expiresAt: Date.now() + 600000, ...(recentAuthentication ? { authenticatedAt: Date.now() } : {}) }));
  });
  authority.listen(0, '127.0.0.1'); await once(authority, 'listening');
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const auth = { origin, issuer: `http://127.0.0.1:${(authority.address() as { port: number }).port}`, secret: 's'.repeat(32) };
  const namespace = (subject: string) => createHash('sha256').update(JSON.stringify([auth.issuer, subject])).digest('hex');
  const root = await mkdtemp(join(tmpdir(), 'arc-hosted-replay-')); const path = join(root, 'relay.json');
  const row = (revision = 2) => {
    const request = { operationId: `op-${revision}`, roleId: 'role', expectedRevision: revision - 1, from: ref(revision === 2 ? 'A' : 'B') };
    const projection: CommittedSuccessionProjection = { version: 1, role: { id: 'role', revision, origin: ref('A'), current: ref(revision === 2 ? 'B' : 'C'), workspace },
      receipt: { ...request, to: ref(revision === 2 ? 'B' : 'C'), phase: 'committed', committedRevision: revision, startedAt: 'now', updatedAt: 'now',
        prepared: { ...request, to: ref(revision === 2 ? 'B' : 'C'), workspace, associationRevision: 1, participants: [], capture: { epoch: 'e', seq: 1, capturedAt: 'now' } } } };
    const receipt: SuccessionAssociationFreeze = { version: 1, token: `freeze-${revision}`, authority: { version: 1, origin, issuer: auth.issuer, namespace: namespace('owner'), ownerSubject: 'owner' },
      controllerId: 'installation', request, associationRevision: 0, lineage: revision === 2 ? [ref('A')] : [ref('A'), ref('B')], relations: [] };
    return { hostId: 'mapped-host', receipt, released: 'committed' as const, projection };
  };
  const initial = emptyRelayState(auth); initial.version = 5;
  for (const subject of ['owner', 'viewer']) initial.sessions.push({ hash: createHash('sha256').update(subject).digest('hex'), sessionExpiresAt: Date.now() + 600000,
    grant: { authenticatedAt: Date.now(), subject, namespace: namespace(subject), expiresAt: Date.now() + 60000, ticket: '', nonce: 'nonce', continuation: subject, sessionExpiresAt: Date.now() + 600000 } });
  initial.tenants.push({ subject: 'owner', namespace: namespace('owner'), broker: { keys: [], hosts: [{ id: 'mapped-host', installationId: 'installation', name: 'Host', legacyDsh: false,
    providers: [{ providerId: 'fixture', displayName: 'Fixture' }] }], bindings: [], creations: [], associations: { version: 3, revision: 2, admissions: [], relationChanges: [], relationResets: [], freezes: [row(), row(3)] } } });
  initial.tenants[0]!.broker.keys = [[createHash('sha256').update(credential).digest('hex'), { expires: Date.now() + 600000, installationId: 'installation', kind: 'device' }]];
  configure?.(initial);
  let relay: Pick<ReturnType<typeof createHostedRelay>, 'fetch' | 'prepareUpgrade' | 'close'>;
  let failSave = false, failAfterSave = false, writes = 0;
  let select: HostBrokerOptions['successionProjectionAllowance'];
  let beforeCommit = async (_value: HostedRelayState) => {};
  let queuedControls = 0;
  const encodingCosts = accounting ? {
    measureSnapshot(state: Readonly<HostedRelayState>) { return { snapshotFormat: SQL_SNAPSHOT_FORMAT, recordFormat: SQL_RECORD_FORMAT, chunkBytes: SQL_CHUNK_BYTES, costs: encodeSqlSnapshot(state as HostedRelayState, auth).costs }; }, quoteRecord: quoteSqlRecord,
  } : undefined;
  const start = (initial: unknown) => {
    const storage = { initial, async commit(value: HostedRelayState) { await beforeCommit(value); writes++; if (failSave) throw new Error('disk unavailable'); await writeFile(path, JSON.stringify(value)); if (failAfterSave) throw new Error('Lost persistence acknowledgement'); } };
    if (!directBroker) return createHostedRelay({ ...auth, successionEncodingCosts: encodingCosts, successionEnrollment: true, successionProjectionAllowance: context => select?.(context) ?? 2 * 1024 * 1024, scheduler: { schedule() {}, cancel() {} }, storage });
    // Isolated Broker consumer: explicit fixture principals, without Gateway proof-queue ordering.
    const state = createRelayState(auth, storage, () => {}, () => {}, encodingCosts);
    const broker = createHostBroker({ origin, ownerSubject: 'owner', durable: true, initialState: state.read().tenants[0]!.broker,
      successionEnrollment: { version: 1, origin, issuer: auth.issuer, namespace: namespace('owner'), ownerSubject: 'owner' },
      onStateChange: value => state.mutate(draft => { draft.tenants[0]!.broker = value; }) });
    return { prepareUpgrade: broker.prepareUpgrade, async close() { broker.close(); await broker.settled(); await state.close(); }, async fetch(request: Request) {
      const url = new URL(request.url); url.pathname = url.pathname.replace(/^\/u\/[^/]+/, '');
      const subject = /=(owner|viewer)$/.exec(request.headers.get('cookie') ?? '')?.[1];
      if (!subject) return new Response(null, { status: 401 });
      if (url.pathname === '/fixture/revoke-share') {
        const input = await request.json(); const revoking = broker.manageShares(subject, 'mapped-host', 'revoke-share', input.targetSubject); queuedControls++;
        try { return Response.json(await revoking); } catch (error) { return new Response(String(error), { status: 403 }); }
      }
      return broker.handleRequest(new Request(url, request), { principalSubject: () => subject });
    } };
  };
  relay = start(initial); await writeFile(path, JSON.stringify(initial));
  const websockets = new WebSocketServer({ noServer: true });
  server.on('request', (incoming, outgoing) => { void (async () => {
    let body = ''; for await (const chunk of incoming) body += chunk;
    const request = new Request(origin + incoming.url, { method: incoming.method, headers: incoming.headers as HeadersInit, ...(body ? { body } : {}) });
    const result = await relay.fetch(request) ?? new Response(null, { status: 404 });
    outgoing.writeHead(result.status, Object.fromEntries(result.headers)); outgoing.end(await result.text());
  })().catch(() => { outgoing.writeHead(500); outgoing.end(); }); });
  server.on('upgrade', (incoming, socket, head) => { void (async () => {
    const result = await relay.prepareUpgrade(new Request(origin + incoming.url, { headers: incoming.headers as HeadersInit }));
    if (!result || result instanceof Response) { socket.end(`HTTP/1.1 ${result?.status ?? 404} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
    websockets.handleUpgrade(incoming, socket, head, (ws: any) => result.accept(adapt(ws)));
  })(); });
  const cookie = async (subject = 'owner') => (await import('./auth.js')).gatewayCookieName(origin, 'session') + '=' + subject;
  const request = async (route: string, subject = 'owner', body?: unknown, method = 'POST') => fetch(`${origin}/u/${namespace(subject)}/${route}`, { ...(body === undefined ? {} : { method, body: JSON.stringify(body) }), headers: { cookie: await cookie(subject), origin, 'content-type': 'application/json' } });
  const channel = async (optIn = true) => {
    const socket = new WebSocket(`${origin.replace('http', 'ws')}/u/${namespace('owner')}/v1/session-channel?observation=session${optIn ? '&successions=1' : ''}`, { headers: { origin, cookie: await cookie() } });
    const frames: any[] = []; socket.on('message', (data: { toString(): string }) => frames.push(JSON.parse(data.toString())));
    await once(socket, 'open', { signal: AbortSignal.timeout(3000) });
    return { socket, frames };
  };
  closers.push(async () => { for (const ws of websockets.clients) ws.terminate(); await relay.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => authority.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  return { auth, namespace, row, request, channel, cookie, origin, credential,
    queuedControls: () => queuedControls,
    select: (selector: NonNullable<HostBrokerOptions['successionProjectionAllowance']>) => { select = selector; },
    writes: () => writes,
    policyFailure: () => { beforeCommit = async value => { const oversized = structuredClone(value); (oversized.tenants[0]!.broker.associations as any).padding = 'x'.repeat(8388608); assertSuccessionCapacity(oversized, encodingCosts!); }; },
    hold: (matches: (value: HostedRelayState) => boolean) => {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
      beforeCommit = async value => { if (matches(value)) { beforeCommit = async () => {}; enter(); await waiting; } };
      closers.push(async () => { release(); });
      return { entered, release };
    }, recover: () => { failSave = false; failAfterSave = false; }, failAfterWrite: () => { failAfterSave = true; }, fail: () => { failSave = true; }, deny: () => { denied = true; }, outage: () => { unavailable = true; },
    saved: async () => JSON.parse(await readFile(path, 'utf8')) as HostedRelayState,
    replaceSaved: async (change: (state: HostedRelayState) => void) => { const value = JSON.parse(await readFile(path, 'utf8')); change(value); await writeFile(path, JSON.stringify(value)); },
    restart: async () => { const value = JSON.parse(await readFile(path, 'utf8')); await relay.close(); relay = start(value); } };
}
function adapt(socket: any): RelaySocket {
  return { get readyState() { return socket.readyState; }, get bufferedAmount() { return socket.bufferedAmount; }, send: value => socket.send(value), close: (code, reason) => socket.close(code, reason),
    onMessage(listener) { const receive = (data: { toString(): string }, binary: boolean) => { void listener(data.toString(), binary); }; socket.on('message', receive); return () => socket.off('message', receive); },
    onClose(listener) { socket.on('close', listener); return () => socket.off('close', listener); }, onError(listener) { socket.on('error', listener); return () => socket.off('error', listener); } };
}
async function until(predicate: () => boolean) { const deadline = Date.now() + 3000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Replay deadline'); await new Promise(resolve => setTimeout(resolve, 5)); } }

test('replays exact A to B independently of current C over authenticated HTTP with a cold successor', async () => {
  const f = await fixture();
  const response = await f.request('v1/session-successions?limit=1'); expect(response.status).toBe(200);
  const first = await response.json(); expect(first.successions).toHaveLength(1); expect(first.successions[0].to).toEqual({ hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'B' });
  expect(first.successions[0].to).not.toHaveProperty('agentId'); expect(first.nextCursor).toBeTypeOf('string');
  const next = await (await f.request('v1/session-successions?limit=1&cursor=' + encodeURIComponent(first.nextCursor))).json();
  expect(next.successions[0].to.nativeSessionId).toBe('C');
  const old = await (await f.request('v1/session-successions/operation?roleId=role&operationId=op-2')).json(); expect(old.projection.role.revision).toBe(2);
  const current = await (await f.request('v1/session-successions/current?roleId=role')).json(); expect(current.locator.nativeSessionId).toBe('C');
  await f.restart(); expect((await (await f.request('v1/session-successions')).json()).successions).toHaveLength(2);
  expect((await f.saved()).tenants[0]!.broker.bindings).toEqual([]);
}, 10000);
test('does not expose owner successors to another authenticated namespace', async () => {
  const f = await fixture(); const response = await f.request('v1/session-successions', 'viewer'); expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ version: 1, successions: [], nextCursor: null });
  expect((await f.request('v1/session-successions/operation?roleId=role&operationId=op-2', 'viewer')).status).toBe(403);
}, 10000);
test('authorizes historical recovery only in the owning namespace and retains favorite progress through Relay9 migration', async () => {
  const f = await fixture(undefined, true);
  expect((await f.request('v1/remote/hosts/mapped-host/revoke', 'owner', {})).status).toBe(200);
  const revoked = await f.saved();
  expect(revoked.version).toBe(9);
  expect(revoked.tenants[0]!.broker.associations!.freezes).toHaveLength(2);
  expect(revoked.tenants[0]!.broker.hosts).toEqual([]);
  expect(revoked.tenants[0]!.favoritesSuccession!.receipts.every(receipt => receipt.status === 'pending')).toBe(true);
  expect((await f.request('v1/remote/pairings', 'viewer', { recoverHostId: 'mapped-host' })).status).toBe(409);
  const foreign = await fetch(`${f.origin}/u/${f.namespace('owner')}/v1/remote/pairings`, { method: 'POST', body: JSON.stringify({ recoverHostId: 'mapped-host' }),
    headers: { cookie: await f.cookie('viewer'), origin: f.origin, 'content-type': 'application/json' }, signal: AbortSignal.timeout(3000) });
  expect(foreign.status).toBe(403);
  const pairing = await f.request('v1/remote/pairings', 'owner', { recoverHostId: 'mapped-host' });
  expect(pairing.status).toBe(201); expect((await pairing.json()).recovery.hostId).toBe('mapped-host');
  const saved = await f.saved(); expect(saved.version).toBe(9); expect(validateRelayState(saved, f.auth)).toEqual(saved);
  await f.restart();
  expect((await f.request('v1/remote/pairings')).status).toBe(200);
  expect((await f.saved()).tenants[0]!.broker.associations).toEqual(revoked.tenants[0]!.broker.associations);
}, 10000);
test('negotiates succession frames only for opted in channels and replays after reconnect', async () => {
  const f = await fixture(); const legacy = await f.channel(false); const modern = await f.channel();
  await until(() => modern.frames.filter(frame => frame.type === 'session_succession_committed').length === 2);
  expect(legacy.frames).toEqual([{ protocolVersion: '1.7.0', type: 'ready' }]);
  expect(modern.frames[0]).toEqual({ protocolVersion: '1.7.0', type: 'ready', successions: 1 });
  for (const frame of modern.frames) expect(decodeSessionChannelServerMessage(JSON.stringify(frame)).status).toBe('ok');
  modern.socket.close(); await once(modern.socket, 'close', { signal: AbortSignal.timeout(3000) });
  const reconnected = await f.channel(); await until(() => reconnected.frames.length === 3);
  expect(reconnected.frames[1].succession.to.nativeSessionId).toBe('B');
}, 10000);

test('suppresses replay for unavailable providers and removed mappings without losing durable evidence', async () => {
  for (const remove of [(state: HostedRelayState) => { state.tenants[0]!.broker.hosts[0]!.providers = []; }, (state: HostedRelayState) => { state.tenants[0]!.broker.hosts = []; }]) {
    const f = await fixture(remove); expect((await (await f.request('v1/session-successions')).json()).successions).toEqual([]);
    expect((await f.request('v1/session-successions/operation?roleId=role&operationId=op-2')).status).toBe(403);
    await f.restart(); expect((await f.saved()).tenants[0]!.broker.associations!.freezes).toHaveLength(2);
  }
}, 10000);
test('does not expose successors to shared-only readers or through foreign cursors and rejects browser receipts', async () => {
  const f = await fixture(state => { state.tenants[0]!.broker.sharing = { grants: [{ hostId: 'mapped-host', subject: 'viewer', label: 'Viewer', sessionLimit: 1, revoked: false }], reservations: [] }; });
  expect((await (await f.request('v1/remote/hosts', 'viewer')).json()).hosts).toHaveLength(1);
  expect((await (await f.request('v1/session-successions', 'viewer')).json()).successions).toEqual([]);
  const page = await (await f.request('v1/session-successions?limit=1')).json();
  expect((await f.request('v1/session-successions?cursor=' + page.nextCursor, 'viewer')).status).toBe(400);
  expect((await f.request('v1/session-successions', 'owner', f.row().projection)).status).toBe(405);
  for (const selection of ['limit=65', 'limit=1&limit=2', 'afterRevision=1', 'roleId=role&afterRevision=-1', 'cursor=invalid']) expect((await f.request('v1/session-successions?' + selection)).status).toBe(400);
}, 10000);
test('does not extend expired history access during an authority outage', async () => {
  const f = await fixture(); await f.request('v1/session-successions'); f.outage(); await f.restart();
  const response = await f.request('v1/session-successions'); expect(response.status).toBeGreaterThanOrEqual(500);
  expect(await response.text()).not.toMatch(/nativeSessionId|operationId|mapped-host|installation/);
  expect((await f.saved()).tenants[0]!.broker.associations!.freezes).toHaveLength(2);
}, 10000);
test('requires renewed owner authority after restart and rejects contradictory Controller installation state', async () => {
  const f = await fixture(); await f.request('v1/session-successions'); f.deny(); await f.restart();
  const denied = await f.request('v1/session-successions'); expect(denied.status).toBe(401);
  expect(await denied.text()).not.toMatch(/nativeSessionId|operationId|mapped-host|installation/);
  expect((await f.saved()).tenants[0]!.broker.associations!.freezes).toHaveLength(2);
  const contradictory = await f.saved(); contradictory.tenants[0]!.broker.hosts[0]!.installationId = 'foreign';
  expect(() => validateRelayState(contradictory, f.auth)).toThrow(/state/);
}, 10000);

async function controller(f: Awaited<ReturnType<typeof fixture>>, failAtCommit = false, malformed = false, enrollmentVersion = 2) {
  const effects = { prepare: 0, commit: 0, input: 0, release: 0, rpc: [] as string[], receivedFreezes: [] as unknown[] };
  const saved = (await f.saved()).tenants[0]!.broker.associations!.freezes;
  const operations = new Map<string, any>(saved.filter(row => row.projection).map(row => [row.receipt.request.operationId, structuredClone(row.projection!.receipt)]));
  let revision = saved.filter(row => row.projection).length + 1;
  const sockets: any[] = [];
  let decline = false;
  let describeHold: { entered(): void; waiting: Promise<void> } | undefined;
  async function connect() {
    const socket = new WebSocket(f.origin.replace('http', 'ws') + `/ws/remote-host?successionEnrollment=${enrollmentVersion}`, { headers: { authorization: 'Bearer ' + f.credential } }); sockets.push(socket);
    socket.on('message', async (data: { toString(): string }) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'heartbeat') { socket.send(JSON.stringify({ uplinkVersion: 2, type: 'heartbeat_ack', nonce: message.nonce })); return; }
      if (message.type !== 'rpc_request') return;
      effects.rpc.push(message.path);
      const input = JSON.parse(message.body ?? '{}'); let result: any = {};
      if (message.path === '/remote/succession/enrollment') {
        if (input.action === 'describe') {
          const hold = describeHold; describeHold = undefined; if (hold) { hold.entered(); await hold.waiting; }
          result = { role: { id: 'role', revision, origin: ref('A'), current: sequenceRef(revision - 1), workspace }, lineage: Array.from({ length: revision }, (_, index) => sequenceRef(index)) };
        } else {
          const freeze = input.freeze; effects.receivedFreezes.push(structuredClone(freeze)); const request = freeze.request; let record = operations.get(request.operationId);
          if (input.action === 'prepare' && !record && decline) {
            socket.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: 409, body: JSON.stringify({ code: 'succession_projection_capacity_exceeded', error: 'Complete participant projection exceeds the admitted ceiling.' }) })); return;
          }
          if (input.action === 'prepare' && !record) {
            effects.prepare++; record = { ...request, phase: 'ready', to: ref(request.expectedRevision === 1 ? 'B' : 'C'), startedAt: 'now', updatedAt: 'now',
              prepared: { ...request, to: ref(request.expectedRevision === 1 ? 'B' : 'C'), workspace, associationRevision: 1, participants: [], capture: { epoch: 'e', seq: 1, capturedAt: 'now' } } };
            operations.set(request.operationId, record);
          }
          if (input.action === 'commit' && record.phase !== 'committed') { effects.commit++; effects.input++; record.phase = 'committed'; record.committedRevision = ++revision; if (failAtCommit) f.fail(); }
          if (input.action === 'release') effects.release++;
          result = { record: structuredClone(record), role: { id: 'role', revision, origin: ref('A'), current: sequenceRef(revision - 1), workspace }, freeze };
          if (malformed && record.phase === 'committed') result.record.prepared.from = ref('forged');
        }
      }
      socket.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: 200, body: JSON.stringify(result) }));
    });
    const registered = new Promise<any>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Controller registration deadline')), 3000);
      socket.on('message', (data: { toString(): string }) => { const value = JSON.parse(data.toString()); if (value.type === 'registered') { clearTimeout(timer); resolve(value); } }); });
    await once(socket, 'open', { signal: AbortSignal.timeout(3000) });
    socket.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'installation', name: 'Host', providers: [{ providerId: 'fixture', displayName: 'Fixture' }] }));
    expect((await registered).successionEnrollment.ownerSubject).toBe('owner');
  }
  await connect();
  return { effects, connect, decline: () => { decline = true; }, holdDescribe: () => {
    let entered!: () => void, release!: () => void;
    const start = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
    describeHold = { entered, waiting }; closers.push(async () => { release(); }); return { entered: start, release };
  }, seed: (record: any) => { operations.set(record.operationId, structuredClone(record)); } };
}
test('publishes authenticated Controller terminal readback from durable state before response and keeps exact replay after later commits', async () => {
  const f = await fixture(state => { state.tenants[0]!.broker.associations!.freezes = []; }, false, true);
  const native = await controller(f); const channel = await f.channel();
  for (const revision of [2, 3]) {
    expect((await f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', { operationId: 'op-' + revision, providerId: 'fixture', nativeSessionId: revision === 2 ? 'A' : 'B', expectedRevision: revision - 1 })).status).toBe(200);
    if (revision === 2) {
      const lost = fetch(`${f.origin}/u/${f.namespace('owner')}/v1/remote/hosts/mapped-host/succession/commit`, { method: 'POST', body: JSON.stringify({ operationId: 'op-2' }), headers: { cookie: await f.cookie(), origin: f.origin, 'content-type': 'application/json' } });
      await until(() => channel.frames.some(frame => frame.type === 'session_succession_committed'));
      await (await lost).body?.cancel();
      expect((await f.request('v1/session-successions/operation?roleId=role&operationId=op-2')).status).toBe(200);
    } else expect((await f.request('v1/remote/hosts/mapped-host/succession/commit', 'owner', { operationId: 'op-' + revision })).status).toBe(200);
  }
  await until(() => channel.frames.filter(frame => frame.type === 'session_succession_committed').length === 2);
  expect(native.effects).toMatchObject({ prepare: 2, commit: 2, input: 2 }); expect(native.effects.rpc.every(path => path === '/remote/succession/enrollment')).toBe(true);
  await f.restart(); await native.connect();
  const old = await f.request('v1/remote/hosts/mapped-host/succession/status', 'owner', { operationId: 'op-2' }); expect((await old.json()).role.current.nativeSessionId).toBe('B');
  expect((await (await f.request('v1/session-successions/current?roleId=role')).json()).locator.nativeSessionId).toBe('C');
  expect(native.effects).toMatchObject({ prepare: 2, commit: 2, input: 2 }); expect((await f.saved()).tenants[0]!.broker.bindings).toEqual([]);
}, 10000);
test('recovers native committed evidence after projection persistence failure without a new prepare or input', async () => {
  const f = await fixture(state => { state.tenants[0]!.broker.associations!.freezes = []; }, false, true); const native = await controller(f, true);
  expect((await f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', { operationId: 'op-2', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1 })).status).toBe(200);
  const failed = await f.request('v1/remote/hosts/mapped-host/succession/commit', 'owner', { operationId: 'op-2' }); expect(failed.status).toBeGreaterThanOrEqual(500);
  expect((await f.saved()).tenants[0]!.broker.associations!.freezes[0]).not.toHaveProperty('projection'); expect(native.effects).toMatchObject({ prepare: 1, commit: 1, input: 1, release: 0 });
  f.recover(); await f.restart(); await native.connect();
  expect((await f.request('v1/remote/hosts/mapped-host/succession/reconcile', 'owner', { operationId: 'op-2' })).status).toBe(200);
  expect((await (await f.request('v1/session-successions')).json()).successions[0].to.nativeSessionId).toBe('B');
  expect(native.effects).toMatchObject({ prepare: 1, commit: 1, input: 1, release: 1 });
}, 10000);
test('rejects malformed authenticated readback and browser forged commit fields before they can publish', async () => {
  const f = await fixture(state => { state.tenants[0]!.broker.associations!.freezes = []; }, false, true); const native = await controller(f, false, true);
  expect((await f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', { operationId: 'op-2', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1 })).status).toBe(200);
  expect((await f.request('v1/remote/hosts/mapped-host/succession/commit', 'owner', { operationId: 'op-2', receipt: f.row().projection.receipt })).status).toBe(400);
  expect(native.effects.commit).toBe(0);
  expect((await f.request('v1/remote/hosts/mapped-host/succession/commit', 'owner', { operationId: 'op-2' })).status).toBeGreaterThanOrEqual(400);
  expect((await (await f.request('v1/session-successions')).json()).successions).toEqual([]);
  expect((await f.saved()).tenants[0]!.broker.associations!.freezes[0]).not.toHaveProperty('projection');
}, 10000);

test('retains oversized legacy exact recovery while fresh preparation has no accounting runtime', async () => {
  const f = await fixture(state => {
    const template = state.tenants[0]!.broker.associations!.freezes[0]!;
    state.tenants[0]!.broker.associations!.freezes = Array.from({ length: 512 }, (_, index) => {
      const row = structuredClone(template), revision = index + 2;
      const request = { operationId: 'op-' + revision, roleId: 'role', expectedRevision: revision - 1, from: sequenceRef(index) };
      row.receipt.token = 'freeze-' + revision; row.receipt.request = request;
      row.receipt.lineage = Array.from({ length: index + 1 }, (_, native) => sequenceRef(native));
      row.projection!.role.revision = revision; row.projection!.role.current = sequenceRef(index + 1);
      row.projection!.receipt = { ...row.projection!.receipt, ...request, to: sequenceRef(index + 1), committedRevision: revision,
        prepared: { ...row.projection!.receipt.prepared!, ...request, to: sequenceRef(index + 1) } };
      return row;
    });
  });
  const native = await controller(f);
  const response = await f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', { operationId: 'over-capacity', providerId: 'fixture', nativeSessionId: 'N512', expectedRevision: 513 });
  expect(response.status).toBe(409); expect((await response.json()).code).toBe('succession_preparation_unavailable');
  expect((await f.saved()).tenants[0]!.broker.associations!.freezes).toHaveLength(512);
  expect(native.effects).toMatchObject({ prepare: 0, commit: 0, input: 0 });
  const old = await f.request('v1/remote/hosts/mapped-host/succession/status', 'owner', { operationId: 'op-2' }); expect((await old.json()).role.current.nativeSessionId).toBe('B');
  expect((await f.request('v1/remote/hosts/mapped-host/succession/reconcile', 'owner', { operationId: 'op-2' })).status).toBe(200);
  expect(native.effects).toMatchObject({ prepare: 0, commit: 0, input: 0, release: 1 });
}, 10000);

const favorite = (nativeSessionId = 'A', subject = 'owner') => ({ hostId: 'mapped-host', providerId: 'fixture', nativeSessionId,
  title: nativeSessionId + ' title', workspace: '/workspace', subject, starredAt: 100, favoriteId: 'favorite-' + nativeSessionId,
  folderId: null, order: 0 });
test('atomically projects legacy A through C and preserves the stable slot without repeated revision bumps', async () => {
  const f = await fixture(state => { state.sessionStars = [favorite()]; state.favoritesTrees = [{ subject: 'owner', revision: 4, folders: [] }]; });
  const result = await f.request('v1/favorites'); expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ revision: 5, stars: [{ nativeSessionId: 'C', favoriteId: 'favorite-A', starredAt: 100, folderId: null, order: 0 }] });
  expect(await f.saved()).toMatchObject({ version: 9, tenants: [{ favoritesSuccession: { version: 1, receipts: [{ status: 'applied' }, { status: 'applied' }] } }] });
  await f.request('v1/favorites'); await f.restart(); await f.request('v1/favorites');
  expect((await f.saved()).favoritesTrees![0]!.revision).toBe(5);
  expect((await (await f.request('v1/session-successions/operation?roleId=role&operationId=op-2')).json()).to.nativeSessionId).toBe('B');
}, 10000);

test('rejects owner ordinary predecessor save and delete even at fresh revision and unavailable successor', async () => {
  const f = await fixture(state => { state.sessionStars = [favorite()]; state.favoritesTrees = [{ subject: 'owner', revision: 0, folders: [] }]; state.tenants[0]!.broker.hosts[0]!.providers = []; });
  const first = await (await f.request('v1/favorites')).json();
  for (const type of ['save-session', 'remove-session']) {
    const session = { hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'A', ...(type === 'save-session' ? { title: 'stale' } : {}) };
    const result = await f.request('v1/favorites', 'owner', { type, revision: first.revision, session, ...(type === 'save-session' ? { folderId: null } : {}) });
    expect(result.status).toBe(409); expect(await result.text()).not.toMatch(/nativeSessionId|installation|role/);
  }
  expect((await f.saved()).sessionStars![0]!.nativeSessionId).toBe('A');
  expect(await f.saved()).toMatchObject({ tenants: [{ favoritesSuccession: { receipts: [{ status: 'pending' }, { status: 'pending' }] } }] });
}, 10000);

test('keeps A placement and B target metadata before duplicate removal across different folders', async () => {
  const f = await fixture(state => {
    state.tenants[0]!.broker.associations!.freezes.pop();
    state.favoritesTrees = [{ subject: 'owner', revision: 8, folders: [{ id: 'a-folder', parentId: null, order: 0, title: 'A folder' }, { id: 'b-folder', parentId: null, order: 1, title: 'B folder' }] }];
    state.sessionStars = [{ ...favorite(), folderId: 'a-folder', parentNativeSessionId: 'old-parent' },
      { ...favorite('B'), folderId: 'b-folder', parentNativeSessionId: 'target-parent', workspace: '/target-workspace', starredAt: 200 },
      { ...favorite('unrelated'), order: 2 }, { ...favorite('other', 'viewer') }];
    state.favoritesTrees.push({ subject: 'viewer', revision: 10, folders: [] });
    state.sessionTitleRevision = 5; state.sessionTitles = [{ hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'B', title: 'Confirmed native B', revision: 5 }];
  });
  const value = await (await f.request('v1/favorites')).json();
  expect(value).toMatchObject({ revision: 9, stars: [{ nativeSessionId: 'B', favoriteId: 'favorite-A', folderId: 'a-folder', starredAt: 100,
    title: 'Confirmed native B', workspace: '/target-workspace', parentNativeSessionId: 'target-parent' }, { nativeSessionId: 'unrelated' }] });
  expect(value.folders.map((folder: any) => folder.id)).toEqual(['a-folder', 'b-folder']);
  expect((await f.saved()).sessionStars!.find(star => star.subject === 'viewer')).toEqual(favorite('other', 'viewer'));
  const stale = await f.request('v1/favorites', 'owner', { type: 'remove-session', revision: 8, session: { hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'A' } });
  expect(stale.status).toBe(409);
  for (const method of ['POST', 'DELETE']) expect((await f.request('v1/stars', 'owner', { hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'A', ...(method === 'POST' ? { title: 'old A' } : {}) }, method)).status).toBe(409);
}, 10000);

test('does not create favorites for absent source and does not disturb an already favorite target', async () => {
  for (const target of [false, true]) {
    const f = await fixture(state => { state.tenants[0]!.broker.associations!.freezes.pop();
      if (target) { state.sessionStars = [favorite('B')]; state.favoritesTrees = [{ subject: 'owner', revision: 8, folders: [] }]; } });
    await f.request('v1/favorites'); const saved = await f.saved();
    expect(saved.sessionStars).toEqual(target ? [favorite('B')] : undefined);
    expect(saved.favoritesTrees).toEqual(target ? [{ subject: 'owner', revision: 8, folders: [] }] : undefined);
    expect(saved.tenants[0]!.favoritesSuccession!.receipts[0]!.status).toBe('applied');
  }
}, 10000);

test('shared-only A stays concrete and never acquires the owner successor identity', async () => {
  const f = await fixture(state => {
    state.sessionStars = [favorite(), favorite('A', 'viewer')];
    state.favoritesTrees = ['owner', 'viewer'].map(subject => ({ subject, revision: 0, folders: [] }));
    const broker = state.tenants[0]!.broker;
    broker.sharing = { grants: [{ hostId: 'mapped-host', subject: 'viewer', label: 'Viewer', sessionLimit: 1, revoked: false }], reservations: [] };
    broker.bindings.push({ hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'A', agentId: 'shared-A', creatorSubject: 'viewer' });
  });
  await f.request('v1/favorites');
  const result = await f.request('v1/favorites', 'viewer'); expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ revision: 0, stars: [{ nativeSessionId: 'A', available: true }] });
  const sharedSave = await f.request('v1/favorites', 'viewer', { type: 'save-session', revision: 0, folderId: null,
    session: { hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'A', title: 'Shared A' } });
  expect(sharedSave.status).toBe(200); expect(await sharedSave.text()).not.toMatch(/nativeSessionId":"[BC]"|roleRevision|receiptHash/);
}, 10000);

test('keeps absent Host or provider pending and recovers legacy identity only when metadata returns', async () => {
  for (const removeHost of [false, true]) {
    const f = await fixture(state => {
      state.sessionStars = [{ hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'A', title: 'Legacy A', subject: 'owner', starredAt: 100 }];
      if (removeHost) state.tenants[0]!.broker.hosts = []; else state.tenants[0]!.broker.hosts[0]!.providers = [];
    });
    await f.request('v1/favorites'); const pending = await f.saved();
    expect(pending.sessionStars![0]!.nativeSessionId).toBe('A'); expect(pending.sessionStars![0]!.favoriteId).toBeUndefined();
    expect(pending.tenants[0]!.favoritesSuccession!.receipts.every(entry => entry.status === 'pending')).toBe(true);
    await f.replaceSaved(state => { state.tenants[0]!.broker.hosts = [{ id: 'mapped-host', installationId: 'installation', name: 'Host', legacyDsh: false, providers: [{ providerId: 'fixture', displayName: 'Fixture' }] }]; });
    await f.restart(); const result = await (await f.request('v1/favorites')).json();
    expect(result).toMatchObject({ revision: 1, stars: [{ nativeSessionId: 'C', starredAt: 100, folderId: null, order: 0 }] });
    expect(result.stars[0].favoriteId).toMatch(/^star_/); expect(result.stars[0]).not.toHaveProperty('parentNativeSessionId');
  }
}, 10000);

test('persists native committed freeze while favorite revision or tree capacity stays pending', async () => {
  for (const exhausted of [false, true]) {
    const f = await fixture(state => {
      state.tenants[0]!.broker.associations!.freezes = []; state.sessionStars = [{ hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'A', title: 'A', subject: 'owner', starredAt: 100 }];
      state.favoritesTrees = exhausted ? [{ subject: 'owner', revision: Number.MAX_SAFE_INTEGER, folders: [] }] : Array.from({ length: 1024 }, (_, index) => ({ subject: 'other-' + index, revision: 0, folders: [] }));
    }, false, true);
    const native = await controller(f);
    expect((await f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', { operationId: 'op-2', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1 })).status).toBe(200);
    expect((await f.request('v1/remote/hosts/mapped-host/succession/commit', 'owner', { operationId: 'op-2' })).status).toBe(200);
    const saved = await f.saved(); expect(saved.tenants[0]!.broker.associations!.freezes[0]!.projection).toBeDefined();
    expect(saved.tenants[0]!.favoritesSuccession!.receipts[0]!.status).toBe('pending');
    expect(saved.sessionStars![0]!.nativeSessionId).toBe('A'); expect(saved.sessionStars![0]!.favoriteId).toBeUndefined();
    expect(native.effects).toMatchObject({ prepare: 1, commit: 1, input: 1 });
    await f.replaceSaved(state => { state.favoritesTrees = [{ subject: 'owner', revision: 10, folders: [] }]; });
    await f.restart(); await f.request('v1/favorites');
    expect((await f.saved()).sessionStars![0]!.nativeSessionId).toBe('B'); expect(native.effects).toMatchObject({ prepare: 1, commit: 1, input: 1 });
  }
}, 10000);

test('publishes favorite and ack atomically with original native decision recovery after failed outer write', async () => {
  const f = await fixture(state => { state.tenants[0]!.broker.associations!.freezes = []; state.sessionStars = [favorite()]; state.favoritesTrees = [{ subject: 'owner', revision: 3, folders: [] }]; }, false, true);
  const native = await controller(f, true); const channel = await f.channel();
  expect((await f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', { operationId: 'op-2', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1 })).status).toBe(200);
  expect((await f.request('v1/remote/hosts/mapped-host/succession/commit', 'owner', { operationId: 'op-2' })).status).toBeGreaterThanOrEqual(500);
  const failed = await f.saved(); expect(failed.sessionStars![0]!.nativeSessionId).toBe('A'); expect(failed.favoritesTrees![0]!.revision).toBe(3);
  expect(failed.tenants[0]!.favoritesSuccession).toBeUndefined(); expect(failed.tenants[0]!.broker.associations!.freezes[0]!.projection).toBeUndefined();
  expect(channel.frames.filter(frame => frame.type === 'session_succession_committed')).toEqual([]);
  f.recover(); await f.restart(); await native.connect();
  expect((await f.request('v1/remote/hosts/mapped-host/succession/reconcile', 'owner', { operationId: 'op-2' })).status).toBe(200);
  expect(await f.saved()).toMatchObject({ sessionStars: [{ nativeSessionId: 'B', favoriteId: 'favorite-A' }], favoritesTrees: [{ revision: 4 }], tenants: [{ favoritesSuccession: { receipts: [{ status: 'applied' }] } }] });
  await f.request('v1/favorites'); await f.restart(); await native.connect();
  expect((await f.saved()).favoritesTrees![0]!.revision).toBe(4); expect(native.effects).toMatchObject({ prepare: 1, commit: 1, input: 1 });
}, 10000);

test('validates exact bounded acknowledgements and rejects gaps, tampering and unsupported versions', async () => {
  const f = await fixture(state => { state.sessionStars = [favorite()]; state.favoritesTrees = [{ subject: 'owner', revision: 0, folders: [] }]; });
  await f.request('v1/favorites'); const saved = await f.saved();
  expect(() => validateRelayState(saved, f.auth)).not.toThrow();
  for (const change of [
    (state: any) => { state.version = 6; },
    (state: any) => { state.tenants[0].favoritesSuccession.version = 2; },
    (state: any) => { state.tenants[0].favoritesSuccession.receipts[0].operationId = 'forged'; },
    (state: any) => { state.tenants[0].favoritesSuccession.receipts[0].receiptHash = 'f'.repeat(64); },
    (state: any) => { state.tenants[0].favoritesSuccession.receipts[0].roleRevision = 100; },
    (state: any) => { state.tenants[0].favoritesSuccession.receipts[0].status = 'pending'; },
    (state: any) => { state.tenants[0].favoritesSuccession.receipts.shift(); },
    (state: any) => { state.tenants[0].favoritesSuccession.receipts.push(state.tenants[0].favoritesSuccession.receipts[0]); },
    (state: any) => { state.tenants[0].broker.associations.freezes[0].projection.role.workspace.canonicalCwd = '/forged'; },
  ]) {
    const modified = structuredClone(saved); change(modified);
    expect(() => validateRelayState(modified, f.auth)).toThrow();
  }
  await f.replaceSaved(state => { state.tenants[0]!.broker.hosts = []; state.sessionTitles = []; });
  await f.restart(); const value = await (await f.request('v1/favorites')).json();
  expect(value).toMatchObject({ revision: 1, stars: [{ nativeSessionId: 'C', available: false }] });
  expect((await f.saved()).tenants[0]!.favoritesSuccession).toEqual(saved.tenants[0]!.favoritesSuccession);
}, 10000);

test('repeated provider publication and unrelated edits do not replay acknowledgements or title inheritance', async () => {
  const f = await fixture(state => { state.sessionStars = [favorite()]; state.favoritesTrees = [{ subject: 'owner', revision: 0, folders: [] }]; });
  const native = await controller(f); await f.request('v1/favorites');
  expect((await f.saved()).favoritesTrees![0]!.revision).toBe(1);
  await f.request('v1/favorites', 'owner', { type: 'create-folder', revision: 1, id: 'unrelated-folder', parentId: null, title: 'Unrelated' });
  await f.restart(); await native.connect(); await f.request('v1/favorites');
  const saved = await f.saved(); expect(saved.favoritesTrees![0]!.revision).toBe(2);
  const { createRelayState } = await import('./state.js'); const { createSessionTitles } = await import('./session-titles.js'); const { createFavorites } = await import('./favorites.js');
  const state = createRelayState(f.auth, { initial: saved, async commit() {} }, () => {}, () => {});
  await createSessionTitles(state, () => true).record({ hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'C' }, 'Real native C');
  expect(createFavorites(state, () => ({ online: true, hostName: 'Host' })).list('owner')).toMatchObject({ revision: 3, stars: [{ nativeSessionId: 'C', title: 'Real native C', favoriteId: 'favorite-A' }] });
  expect(native.effects).toMatchObject({ prepare: 0, commit: 0, input: 0 });
}, 10000);

test('failed legacy projection persistence retains original favorite and no applied progress until retry', async () => {
  const f = await fixture(state => { state.sessionStars = [favorite()]; state.favoritesTrees = [{ subject: 'owner', revision: 4, folders: [] }]; });
  await f.request('v1/session-successions'); f.fail();
  expect((await f.request('v1/favorites')).status).toBeGreaterThanOrEqual(500);
  expect(await f.saved()).toMatchObject({ sessionStars: [{ nativeSessionId: 'A' }], favoritesTrees: [{ revision: 4 }] });
  expect((await f.saved()).tenants[0]!.favoritesSuccession).toBeUndefined();
  f.recover(); await f.restart(); await f.request('v1/favorites');
  expect(await f.saved()).toMatchObject({ sessionStars: [{ nativeSessionId: 'C' }], favoritesTrees: [{ revision: 5 }] });
}, 10000);

test('lost outer persistence acknowledgement recovers the durable projection without replaying favorite or native effects', async () => {
  const f = await fixture(state => { state.tenants[0]!.broker.associations!.freezes = []; state.sessionStars = [favorite()]; state.favoritesTrees = [{ subject: 'owner', revision: 3, folders: [] }]; }, false, true);
  const native = await controller(f); const channel = await f.channel();
  expect((await f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', { operationId: 'op-2', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1 })).status).toBe(200);
  f.failAfterWrite(); expect((await f.request('v1/remote/hosts/mapped-host/succession/commit', 'owner', { operationId: 'op-2' })).status).toBeGreaterThanOrEqual(500);
  expect(channel.frames.filter(frame => frame.type === 'session_succession_committed')).toEqual([]);
  expect(await f.saved()).toMatchObject({ sessionStars: [{ nativeSessionId: 'B' }], favoritesTrees: [{ revision: 4 }], tenants: [{ favoritesSuccession: { receipts: [{ status: 'applied' }] } }] });
  f.recover(); await f.restart(); await native.connect();
  expect((await f.request('v1/remote/hosts/mapped-host/succession/reconcile', 'owner', { operationId: 'op-2' })).status).toBe(200);
  await f.request('v1/favorites'); expect((await f.saved()).favoritesTrees![0]!.revision).toBe(4);
  expect(native.effects).toMatchObject({ prepare: 1, commit: 1, input: 1, release: 1 });
}, 10000);

test('concurrent stale browser edits conflict after pending legacy projection and preserve the current slot', async () => {
  const f = await fixture(state => { state.sessionStars = [favorite()]; state.favoritesTrees = [{ subject: 'owner', revision: 0, folders: [] }]; });
  const results = await Promise.all(['one', 'two'].map(id => f.request('v1/favorites', 'owner', { type: 'create-folder', revision: 0, id, parentId: null, title: id })));
  expect(results.map(result => result.status)).toEqual([409, 409]);
  const snapshot = await (await f.request('v1/favorites')).json(); expect(snapshot).toMatchObject({ revision: 1, folders: [], stars: [{ nativeSessionId: 'C', favoriteId: 'favorite-A' }] });
  const fresh = await Promise.all(['one', 'two'].map(id => f.request('v1/favorites', 'owner', { type: 'create-folder', revision: 1, id, parentId: null, title: id })));
  expect(fresh.map(result => result.status).sort()).toEqual([200, 409]);
  expect((await f.saved()).favoritesTrees![0]!.revision).toBe(2);
}, 10000);

test.each([1,2])('feature %s recovers an exact saved v1 ready candidate without preparing another native candidate', async enrollmentVersion => {
  let candidate: any;
  const f = await fixture(state => {
    const row=state.tenants[0]!.broker.associations!.freezes[0]!;candidate=structuredClone(row.projection!.receipt);
    candidate.phase='ready';delete candidate.committedRevision;
    delete row.released;delete row.projection;state.tenants[0]!.broker.associations!.freezes=[row];
  });
  const native=await controller(f,false,false,enrollmentVersion);native.seed(candidate);
  const before=(await f.saved()).tenants[0]!.broker.associations!.freezes[0]!.receipt;
  expect((await f.request('v1/remote/hosts/mapped-host/succession/prepare','owner',{operationId:'op-2',providerId:'fixture',nativeSessionId:'A',expectedRevision:1})).status).toBe(200);
  expect(native.effects.prepare).toBe(0);
  expect((await f.request('v1/remote/hosts/mapped-host/succession/commit','owner',{operationId:'op-2'})).status).toBe(200);
  expect((await f.saved()).tenants[0]!.broker.associations!.freezes[0]!.receipt).toEqual(before);
  expect(before.version).toBe(1);expect(before).not.toHaveProperty('maxProjectionBytes');
  expect(native.effects.prepare).toBe(0);expect(native.effects.commit).toBe(1);expect(native.effects.release).toBe(1);
  if(enrollmentVersion===1)expect((await f.request('v1/remote/hosts/mapped-host/succession/prepare','owner',{operationId:'new-operation',providerId:'fixture',nativeSessionId:'B',expectedRevision:2})).status).toBe(409);
},10000);


test('refuses the 513th same-role freeze through real transport before preparing or spending a revision', async () => {
  const f = await fixture(state => {
    const template = state.tenants[0]!.broker.associations!.freezes[0]!;
    state.tenants[0]!.broker.associations!.freezes = Array.from({ length: 512 }, (_, index) => ({ hostId: template.hostId, released: 'cancelled' as const,
      receipt: { ...template.receipt, token: 'cancelled-' + index, request: { ...template.receipt.request, operationId: 'cancelled-operation-' + index }, lineage: [ref('A')] } }));
  }, false, true);
  const native = await controller(f); const before = await f.saved();
  const response = await f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', { operationId: 'over-capacity', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1 });
  expect(response.status).toBe(409); expect((await response.json()).code).toBe('succession_role_capacity');
  expect((await f.saved()).tenants[0]!.broker.associations).toEqual(before.tenants[0]!.broker.associations);
  expect(native.effects).toMatchObject({ prepare: 0, commit: 0, input: 0 });
  expect((await f.request('v1/remote/hosts')).status).toBe(200);
}, 10000);


test('freezes one exact quote with the real Host and post-staging Broker revision across queued duplicates and reopen', async () => {
  const f = await fixture(state => { state.tenants[0]!.broker.associations!.freezes = []; }, false, true);
  const native = await controller(f); const before = await f.saved();
  const quotes: Parameters<NonNullable<HostBrokerOptions['successionProjectionAllowance']>>[0][] = [];
  f.select(context => { quotes.push(structuredClone(context)); return 777777; });
  const hold = f.hold(value => value.tenants[0]!.broker.associations!.freezes.length === 1);
  const input = { operationId: 'op-2', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1 };
  let completed = 0;
  const first = f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', input).then(response => { completed++; return response; });
  await hold.entered; const writesBeforeFreeze = f.writes();
  const second = f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', input).then(response => { completed++; return response; });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(completed).toBe(0); expect(native.effects.prepare).toBe(0);
  expect((await f.saved()).tenants[0]!.broker.associations).toEqual(before.tenants[0]!.broker.associations);
  hold.release(); expect((await first).status).toBe(200); expect((await second).status).toBe(200);
  expect(f.writes() - writesBeforeFreeze).toBe(1);
  expect(quotes).toHaveLength(1); expect(quotes[0]!.hostId).toBe('mapped-host');
  expect(quotes[0]!.broker.hosts[0]!.installationId).toBe('installation');
  expect(quotes[0]!.broker.associations!.revision).toBe(before.tenants[0]!.broker.associations!.revision + 1);
  expect(quotes[0]!.freeze.associationRevision).toBe(before.tenants[0]!.broker.associations!.revision);
  const saved = await f.saved(), exact = saved.tenants[0]!.broker.associations!.freezes[0]!.receipt;
  expect(exact).toMatchObject({ version: 2, maxProjectionBytes: 777777 });
  expect(saved.tenants[0]!.broker.associations!.revision).toBe(quotes[0]!.broker.associations!.revision);
  expect(native.effects.prepare).toBe(1);
  f.select(() => { throw new Error('Saved retries must never requote'); });
  await f.restart(); await native.connect();
  const resumed = await f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', input);
  expect(resumed.status).toBe(200);
  expect((await f.saved()).tenants[0]!.broker.associations!.freezes[0]!.receipt).toEqual(exact);
  expect(native.effects.receivedFreezes.length).toBeGreaterThan(1);
  expect(native.effects.receivedFreezes.every(receipt => JSON.stringify(receipt) === JSON.stringify(exact))).toBe(true);
  expect((await f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', { ...input, targetProviderId: 'different' })).status).toBe(409);
}, 10000);

test('refuses a stale immutable quote after an ordinary star overtakes it and keeps both queues usable', async () => {
  const ceiling = 1000000;
  const f = await fixture(state => {
    const broker = state.tenants[0]!.broker;
    broker.associations!.freezes = [];
    broker.bindings.push({ agentId: 'agent-A', hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'A' });
    (broker.associations as any).retainedExtra = 'x'.repeat(8388608 - ceiling - 10000);
  }, false, true);
  const native = await controller(f); let quotes = 0;
  f.select(() => { quotes++; return ceiling; });
  const hold = f.hold(value => !!value.sessionStars?.length && !value.tenants[0]!.broker.associations!.freezes.length);
  const star = f.request('v1/stars', 'owner', { hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'A', title: 'A' });
  await hold.entered;
  const prepare = f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', { operationId: 'op-2', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1 });
  await until(() => quotes === 1); const before = await f.saved();
  hold.release(); expect((await star).status).toBe(200);
  const result = await prepare; expect(result.status).toBe(409); expect((await result.json()).code).toBe('succession_projection_capacity_exceeded');
  expect(quotes).toBe(1); expect(native.effects.prepare).toBe(0);
  const saved = await f.saved(); expect(saved.tenants[0]!.broker.associations).toEqual(before.tenants[0]!.broker.associations);
  expect(saved.sessionStars).toHaveLength(1);
  expect((await f.request('v1/remote/hosts')).status).toBe(200);
  expect((await f.request('v1/stars', 'owner', { hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'A' }, 'DELETE')).status).toBe(200);
  expect((await f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', { operationId: 'op-2', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1 })).status).toBe(200);
  expect(native.effects.prepare).toBe(1);
}, 10000);

test('keeps an admitted exact freeze when the Controller declines its participant projection ceiling', async () => {
  const f = await fixture(state => { state.tenants[0]!.broker.associations!.freezes = []; }, false, true);
  const native = await controller(f); native.decline(); let quoted = 0;
  f.select(() => { quoted++; return 1; });
  const input = { operationId: 'op-2', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1 };
  expect((await f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', input)).status).toBe(409);
  const exact = (await f.saved()).tenants[0]!.broker.associations!.freezes;
  expect(exact).toHaveLength(1); expect(exact[0]!.receipt).toMatchObject({ version: 2, maxProjectionBytes: 1 });
  expect(exact[0]!.released).toBeUndefined(); expect(native.effects.prepare).toBe(0);
  await f.restart(); await native.connect();
  expect((await f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', input)).status).toBe(409);
  expect((await f.saved()).tenants[0]!.broker.associations!.freezes).toEqual(exact); expect(quoted).toBe(1); expect(native.effects.prepare).toBe(0);
}, 10000);

test('does not exempt a generic quote callback failure from Broker fail closed behavior', async () => {
  const f = await fixture(state => { state.tenants[0]!.broker.associations!.freezes = []; }, false, true);
  const native = await controller(f); const before = (await f.saved()).tenants[0]!.broker.associations;
  f.select(() => { throw new Error('Unexpected codec failure'); });
  expect((await f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', { operationId: 'op-2', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1 })).status).toBeGreaterThanOrEqual(500);
  expect((await f.saved()).tenants[0]!.broker.associations).toEqual(before); expect(native.effects.prepare).toBe(0);
  expect((await f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', { operationId: 'retry', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1 })).status).toBe(503);
}, 10000);

test('rejects delayed describe after Host generation changes without freezing or redirecting preparation', async () => {
  const f = await fixture(state => { state.tenants[0]!.broker.associations!.freezes = []; }, false, true);
  const native = await controller(f); const hold = native.holdDescribe(); let quoted = 0;
  f.select(() => { quoted++; return 65536; });
  const request = f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', { operationId: 'op-2', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1 });
  await hold.entered; await native.connect(); hold.release();
  expect((await request).status).toBeGreaterThanOrEqual(400);
  expect((await f.saved()).tenants[0]!.broker.associations!.freezes).toEqual([]);
  expect(quoted).toBe(0); expect(native.effects.prepare).toBe(0);
  expect((await f.request('v1/remote/hosts')).status).toBe(200);
}, 10000);

test('maps ordinary star capacity refusal without losing the admitted freeze or closing either queue', async () => {
  const ceiling = 1000000;
  const f = await fixture(state => {
    const broker = state.tenants[0]!.broker; broker.associations!.freezes = [];
    broker.bindings.push({ agentId: 'agent-A', hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'A' });
    (broker.associations as any).retainedExtra = 'x'.repeat(8388608 - ceiling - 10000);
  }, false, true);
  const native = await controller(f); f.select(() => ceiling);
  expect((await f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', { operationId: 'op-2', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1 })).status).toBe(200);
  const before = await f.saved();
  const refused = await f.request('v1/stars', 'owner', { hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'A', title: 'Saved' });
  expect(refused.status).toBe(409); expect((await refused.json()).code).toBe('succession_projection_capacity_exceeded');
  expect((await f.saved()).tenants[0]!.broker.associations).toEqual(before.tenants[0]!.broker.associations);
  expect((await f.saved()).sessionStars ?? []).toEqual([]); expect(native.effects.prepare).toBe(1);
  expect((await f.request('v1/remote/hosts')).status).toBe(200);
  expect((await f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', { operationId: 'op-2', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1 })).status).toBe(200);
  expect(native.effects.prepare).toBe(1);
}, 10000);

function sourceState(state: HostedRelayState, shared = false) {
  state.version = 9;
  const broker = state.tenants[0]!.broker;
  broker.associations = { version: 5, revision: 0, admissions: [], freezes: [], relationChanges: [], relationResets: [] };
  broker.bindings = [{ hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'A', agentId: 'source-agent', ...(shared ? { creatorSubject: 'viewer' } : {}) }];
  if (shared) broker.sharing = { grants: [{ hostId: 'mapped-host', subject: 'viewer', label: 'Viewer', sessionLimit: 10, revoked: false }], reservations: [] };
}
const sourceRequest = { providerId: 'fixture', operationId: 'source-operation', sourceNativeSessionId: 'A', conversationKind: 'side', cwd: '/escaped/"\\\n' };
async function sourceController(f: Awaited<ReturnType<typeof fixture>>, respond?: (message: any, input: any) => Promise<{ status?: number; body?: any }> | { status?: number; body?: any }) {
  const effects = { create: 0, attach: 0, readback: 0 };
  const witness = new Map<string, string>();
  const nativeId = 'reader-"\\', agentId = 'agent-"\\\n';
  async function connect() {
    const socket = new WebSocket(f.origin.replace('http', 'ws') + '/ws/remote-host?successionEnrollment=2', { headers: { authorization: 'Bearer ' + f.credential } });
    const registered = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Source Controller registration deadline')), 3000);
      socket.on('message', async (data: { toString(): string }) => {
        const message = JSON.parse(data.toString());
        if (message.type === 'registered') { clearTimeout(timer); resolve(); return; }
        if (message.type === 'heartbeat') { socket.send(JSON.stringify({ uplinkVersion: 2, type: 'heartbeat_ack', nonce: message.nonce })); return; }
        if (message.type !== 'rpc_request') return;
        const input = JSON.parse(message.body ?? '{}');
        let body: any = {}, status = 200;
        if (message.path === '/remote/create') { effects.create++; witness.set(input.operationId, nativeId); body = { agentId, nativeSessionId: nativeId }; }
        if (message.path === '/remote/attach') { effects.attach++; body = { agentId: input.nativeSessionId === 'A' ? 'source-agent' : agentId, nativeSessionId: input.nativeSessionId }; }
        if (message.path === '/remote/succession/enrollment' && input.action === 'source-result') {
          effects.readback++; body = { operationId: input.operationId, source: ref(input.sourceNativeSessionId), reader: ref(witness.get(input.operationId) ?? nativeId) };
        }
        const overridden = await respond?.(message, input); status = overridden?.status ?? status; body = overridden?.body ?? body;
        if (socket.readyState === 1) socket.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status, body: JSON.stringify(body) }));
      });
    });
    await once(socket, 'open', { signal: AbortSignal.timeout(3000) });
    socket.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'installation', name: 'Host', providers: [{ providerId: 'fixture', displayName: 'Fixture' }] }));
    await registered;
  }
  await connect(); return { effects, connect, nativeId, agentId };
}
for (const shared of [false, true]) test(`source completion publishes one complete durable tuple for ${shared ? 'shared Ask' : 'owner Side'}`, async () => {
  const f = await fixture(state => sourceState(state, shared), false, true);
  const host = await sourceController(f);
  const subject = shared ? 'viewer' : 'owner';
  const route = 'v1/remote/hosts/mapped-host/create';
  const request = { ...sourceRequest, conversationKind: shared ? 'ask' : 'side' };
  let terminal: HostedRelayState | undefined;
  const held = f.hold(state => { const broker = state.tenants[0]!.broker; if (broker.bindings.length !== 2) return false; terminal = structuredClone(state); return true; });
  let replied = false;
  const pending = f.request(route, subject, request).then(response => { replied = true; return response; });
  await held.entered;
  const before = await f.saved(), broker = before.tenants[0]!.broker;
  expect(broker.bindings).toHaveLength(1); expect(broker.creations).toHaveLength(0); expect(broker.associations!.admissions).toHaveLength(1);
  expect(broker.associations!.revision).toBe(1); expect(replied).toBe(false);
  const done = terminal!.tenants[0]!.broker;
  expect(done.creations).toEqual([[JSON.stringify(['mapped-host', 'fixture', shared ? done.sharing!.reservations[0]!.nativeRequestId : request.operationId]), { fingerprint: JSON.stringify({ providerId: 'fixture', cwd: request.cwd, workspaceId: null, model: null, reasoningEffort: null, planning: null, conversationKind: request.conversationKind, sourceNativeSessionId: 'A' }), agentId: host.agentId }]]); expect(done.associations!.admissions).toHaveLength(0); expect(done.associations!.revision).toBe(2);
  expect(done.bindings[1]).toMatchObject({ nativeSessionId: host.nativeId, agentId: host.agentId, sourceRelation: { kind: request.conversationKind, nativeSourceRef: ref('A') } });
  if (shared) { expect(broker.sharing!.reservations[0]!.agentId).toBeUndefined(); expect(done.sharing!.reservations[0]!.agentId).toBe(host.agentId); }
  const costs = { measureSnapshot(state: Readonly<HostedRelayState>) { return { snapshotFormat: SQL_SNAPSHOT_FORMAT, recordFormat: SQL_RECORD_FORMAT, chunkBytes: SQL_CHUNK_BYTES, costs: encodeSqlSnapshot(state as HostedRelayState, f.auth).costs }; }, quoteRecord: quoteSqlRecord };
  expect(deriveSuccessionCapacity(before, costs).tenants[0]!.bindingSlots).toBe(1);
  expect(deriveSuccessionCapacity(terminal!, costs).tenants[0]!.bindingSlots).toBe(0);
  expect(deriveSuccessionCapacity(terminal!, costs).remainingBytes).toBeLessThan(deriveSuccessionCapacity(before, costs).remainingBytes);
  held.release(); expect((await pending).status).toBe(200);
  const saved = await f.saved(), writes = f.writes();
  expect((await f.request(route, subject, request)).status).toBe(200); expect(f.writes()).toBe(writes); expect(await f.saved()).toEqual(saved);
  await f.restart(); await host.connect();
  const reopened = await f.saved(); expect((await f.request(route, subject, request)).status).toBe(200);
  expect((await f.saved()).tenants[0]!.broker).toEqual(reopened.tenants[0]!.broker); expect(host.effects.create).toBe(1);
}, 10000);

for (const initialRevision of [10, Number.MAX_SAFE_INTEGER - 4]) test(`relation recovery consumes only the remaining terminal revision after a lost release reply from ${initialRevision}`, async () => {
  const f = await fixture(state => {
    state.version = 9;
    const broker = state.tenants[0]!.broker; broker.associations!.freezes.splice(1); broker.associations!.revision = initialRevision;
    broker.bindings = ['A', 'B', 'S'].map(nativeSessionId => ({ hostId: 'mapped-host', providerId: 'fixture', nativeSessionId, agentId: nativeSessionId,
      ...(nativeSessionId === 'S' ? { sourceRelation: { id: 'side', kind: 'side' as const, sourceNativeSessionId: 'A', nativeSourceRef: ref('A'), createdAt: '2026-10-10T00:00:00.000Z' } } : {}) }));
  }, false, true);
  let receipt: any, lost = false;
  await sourceController(f, (_message, input) => {
    if (input.action === 'describe') return { body: { role: f.row().projection.role, lineage: [ref('A'), ref('B')], associationRevision: 7, relationUpdates: 1, sourceParticipants: [{ readerRef: ref('S') }] } };
    if (input.action === 'relation_reserve') receipt = { reservation: input.reservation, phase: 'reserved', associationRevision: 7 };
    if (input.action === 'relation_apply') receipt = { ...receipt, phase: 'applied', associationRevision: 8 };
    if (input.action === 'relation_release') { receipt = { ...receipt, phase: 'released' }; if (!lost) { lost = true; return { status: 503, body: { error: 'Lost release response' } }; } }
    return { body: { receipt: receipt ?? null } };
  });
  const request = { hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'S', id: 'side', sourceNativeSessionId: 'A', linked: false, expectedRevision: 0, expectedRoleRevision: 2, operationId: 'relation-edit' };
  expect((await f.request('v1/session-relations', 'owner', request, 'PATCH')).status).not.toBe(200);
  const pending = (await f.saved()).tenants[0]!.broker.associations!;
  expect(pending.relationChanges[0]!.phase).toBe('overlay_applied'); expect(pending.revision).toBe(initialRevision + 3);
  expect((await f.request('v1/session-relations/reconcile', 'owner', { hostId: 'mapped-host', operationId: 'relation-edit' })).status).toBe(200);
  const terminal = (await f.saved()).tenants[0]!.broker.associations!;
  expect(terminal.revision).toBe(initialRevision + 4); expect(terminal.relationChanges[0]!.phase).toBe('committed'); expect(terminal.relationChanges[0]!.hostReceipt).toEqual(receipt);
  const writes = f.writes(); expect((await f.request('v1/session-relations', 'owner', request, 'PATCH')).status).toBe(200);
  expect(f.writes()).toBe(writes); expect((await f.saved()).tenants[0]!.broker.associations).toEqual(terminal);
}, 10000);

function seedSourceAdmission(state: HostedRelayState, request = sourceRequest) {
  const body = { ...request, conversationId: request.operationId, creationSource: { providerId: request.providerId, nativeSessionId: request.sourceNativeSessionId } };
  state.tenants[0]!.broker.associations!.admissions.push({
    id: createHash('sha256').update(JSON.stringify(['mapped-host', request.providerId, request.operationId])).digest('hex'),
    fingerprint: createHash('sha256').update(JSON.stringify([request.providerId, Object.entries(body).filter(([name]) => name !== 'creationSource').sort(([a], [b]) => a.localeCompare(b))])).digest('hex'), source: ref(request.sourceNativeSessionId),
  });
}
for (const collection of ['bindings', 'creations'] as const) test(`durable source claims protect ${collection} from ordinary dispatch and exclude their own exact retry once`, async () => {
  const f = await fixture(state => {
    sourceState(state); const broker = state.tenants[0]!.broker;
    seedSourceAdmission(state); seedSourceAdmission(state, { ...sourceRequest, operationId: 'other-pending' });
    if (collection === 'bindings') for (let index = 1; index < 4094; index++) broker.bindings.push({ hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'saved-' + index, agentId: 'saved-' + index });
    else for (let index = 0; index < 4094; index++) broker.creations.push(['saved-' + index, { fingerprint: 'saved', agentId: 'source-agent' }]);
  }, false, true);
  const host = await sourceController(f);
  const ordinary = await f.request('v1/remote/hosts/mapped-host/create', 'owner', { providerId: 'fixture', operationId: 'ordinary' });
  expect(ordinary.status).toBe(429); expect(host.effects.create).toBe(0);
  if (collection === 'bindings') {
    expect((await f.request('v1/remote/hosts/mapped-host/attach', 'owner', { providerId: 'fixture', nativeSessionId: 'unrelated' })).status).toBe(429); expect(host.effects.attach).toBe(0);
    const before = (await f.saved()).tenants[0]!.broker.bindings;
    expect((await f.request('v1/remote/hosts/mapped-host/attach', 'owner', { providerId: 'fixture', nativeSessionId: 'A' })).status).toBe(200);
    expect((await f.saved()).tenants[0]!.broker.bindings).toEqual(before);
  }
  expect((await f.request('v1/remote/hosts/mapped-host/create', 'owner', sourceRequest)).status).toBe(200);
  expect(host.effects.create).toBe(0); expect(host.effects.readback).toBe(1);
  expect((await f.saved()).tenants[0]!.broker.associations!.admissions).toHaveLength(1);
}, 15000);

test('unknown source result retains its admission and exact retry reads back without another create', async () => {
  const f = await fixture(state => sourceState(state, true), false, true);
  const host = await sourceController(f, message => message.path === '/remote/create' ? { body: { agentId: 'x'.repeat(513), nativeSessionId: 'reader-"\\' } } : {});
  const request = () => f.request('v1/remote/hosts/mapped-host/create', 'viewer', sourceRequest);
  expect((await request()).status).not.toBe(200);
  const pending = (await f.saved()).tenants[0]!.broker;
  expect(pending.associations!.admissions).toHaveLength(1); expect(pending.associations!.revision).toBe(1); expect(pending.sharing!.reservations[0]!.agentId).toBeUndefined();
  await f.restart(); await host.connect();
  const retried = await request(); expect({ status: retried.status, body: await retried.json() }).toEqual({ status: 200, body: { agentId: host.agentId, nativeSessionId: host.nativeId } }); expect(host.effects).toEqual({ create: 1, attach: 1, readback: 1 });
  expect((await f.saved()).tenants[0]!.broker.associations!.revision).toBe(2);
}, 10000);

for (const rejected of [false, true]) test(`concurrent exact source retries share one ${rejected ? 'safe rejection' : 'native effect'} and one terminal mutation`, async () => {
  const f = await fixture(state => sourceState(state, true), false, true);
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; }); closers.push(async () => release());
  const host = await sourceController(f, async message => {
    if (message.path !== '/remote/create') return {};
    await waiting; return rejected ? { status: 409, body: { code: 'succession_admission_closed', error: 'Authoritative pre-effect rejection' } } : {};
  });
  const request = () => f.request('v1/remote/hosts/mapped-host/create', 'viewer', sourceRequest);
  const first = request(); await until(() => host.effects.create === 1);
  const writes = f.writes(); const second = request();
  const conflict = await f.request('v1/remote/hosts/mapped-host/create', 'viewer', { ...sourceRequest, cwd: '/changed' }); expect(conflict.status).toBe(409);
  expect(host.effects.create).toBe(1); expect(f.writes()).toBe(writes);
  release(); const replies = await Promise.all([first, second]); expect(replies.map(row => row.status)).toEqual(rejected ? [409, 409] : [200, 200]);
  const saved = (await f.saved()).tenants[0]!.broker;
  expect(saved.associations!.revision).toBe(2); expect(saved.associations!.admissions).toHaveLength(0); expect(f.writes()).toBe(writes + 1);
  expect(saved.creations).toHaveLength(rejected ? 0 : 1); expect(saved.sharing!.reservations).toHaveLength(rejected ? 0 : 1);
}, 10000);

test('in-flight source and ordinary claims cannot both spend the last binding slot', async () => {
  const f = await fixture(state => {
    sourceState(state); const broker = state.tenants[0]!.broker;
    for (let index = 1; index < 4095; index++) broker.bindings.push({ hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'saved-' + index, agentId: 'saved-' + index });
  }, false, true);
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; }); closers.push(async () => release());
  const host = await sourceController(f, async message => { if (message.path === '/remote/create') await waiting; return {}; });
  const first = f.request('v1/remote/hosts/mapped-host/create', 'owner', sourceRequest); await until(() => host.effects.create === 1);
  const second = f.request('v1/remote/hosts/mapped-host/create', 'owner', sourceRequest);
  const ordinary = await f.request('v1/remote/hosts/mapped-host/create', 'owner', { providerId: 'fixture', operationId: 'ordinary' }); expect(ordinary.status).toBe(429);
  expect(host.effects.create).toBe(1); release(); expect((await first).status).toBe(200); expect((await second).status).toBe(200);
  expect((await f.saved()).tenants[0]!.broker.bindings).toHaveLength(4096);
}, 15000);

test('fresh source policy refusal writes no admission or quota and leaves ordinary requests available', async () => {
  const f = await fixture(state => {
    sourceState(state, true); const broker = state.tenants[0]!.broker;
    const authority = { version: 1 as const, origin: state.config.origin, issuer: state.config.issuer, namespace: state.tenants[0]!.namespace, ownerSubject: 'owner' };
    broker.associations!.freezes.push({ hostId: 'mapped-host', receipt: { version: 2, token: 'unrelated-freeze', maxProjectionBytes: 7_800_000, authority,
      controllerId: 'installation', request: { operationId: 'unrelated-freeze', roleId: 'other-role', expectedRevision: 1, from: ref('unrelated') }, associationRevision: 0, lineage: [ref('unrelated')], relations: [] } });
  }, false, true);
  const host = await sourceController(f); await f.request('v1/remote/hosts', 'viewer'); const before = await f.saved(), writes = f.writes();
  const refused = await f.request('v1/remote/hosts/mapped-host/create', 'viewer', sourceRequest);
  expect(refused.status).toBe(409); expect((await refused.json()).code).toBe('succession_projection_capacity_exceeded'); expect(host.effects.create).toBe(0);
  expect(f.writes()).toBe(writes); expect(await f.saved()).toEqual(before);
  expect((await f.request('v1/remote/hosts/mapped-host/create', 'owner', { providerId: 'fixture', operationId: 'ordinary' })).status).toBe(200);
}, 10000);

test('source projection cannot complete into a binding with contradictory Side metadata', async () => {
  const f = await fixture(state => {
    sourceState(state); state.tenants[0]!.broker.bindings.push({ hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'reader-"\\', agentId: 'agent-"\\\n',
      sourceRelation: { id: 'different-operation', kind: 'side', sourceNativeSessionId: 'A', createdAt: '2026-10-10T00:00:00.000Z' } });
  }, false, true);
  const host = await sourceController(f); const response = await f.request('v1/remote/hosts/mapped-host/create', 'owner', sourceRequest);
  expect(response.status).toBe(409); expect(host.effects.create).toBe(1);
  const saved = (await f.saved()).tenants[0]!.broker; expect(saved.associations!.admissions).toHaveLength(1); expect(saved.creations).toHaveLength(0); expect(saved.bindings[1]!.sourceRelation!.id).toBe('different-operation');
}, 10000);

test('an existing admission blocked by a freeze is not a safe no-effect source rejection', async () => {
  const f = await fixture(state => {
    sourceState(state); seedSourceAdmission(state); const broker = state.tenants[0]!.broker;
    broker.associations!.freezes.push({ hostId: 'mapped-host', receipt: { version: 2, token: 'freeze', maxProjectionBytes: 65536,
      authority: { version: 1, ...state.config, namespace: state.tenants[0]!.namespace, ownerSubject: 'owner' }, controllerId: 'installation',
      request: { operationId: 'freeze', roleId: 'role', expectedRevision: 1, from: ref('A') }, associationRevision: 0, lineage: [ref('A')], relations: [] } });
  }, false, true);
  const host = await sourceController(f); const before = (await f.saved()).tenants[0]!.broker.associations;
  expect((await f.request('v1/remote/hosts/mapped-host/create', 'owner', sourceRequest)).status).toBe(409);
  expect((await f.saved()).tenants[0]!.broker.associations).toEqual(before); expect(host.effects.create).toBe(0);
}, 10000);

test('a conflicting attach cannot release the first operation claim while its Host response is held', async () => {
  const f = await fixture(state => {
    sourceState(state); const broker = state.tenants[0]!.broker;
    for (let index = 1; index < 4095; index++) broker.bindings.push({ hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'saved-' + index, agentId: 'saved-' + index });
  }, false, true);
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; }); closers.push(async () => release());
  const host = await sourceController(f, async (message, input) => { if (message.path === '/remote/attach' && input.nativeSessionId === 'first') await waiting; return {}; });
  const route = 'v1/remote/hosts/mapped-host/attach';
  const first = f.request(route, 'owner', { providerId: 'fixture', nativeSessionId: 'first' }); await until(() => host.effects.attach === 1);
  expect((await f.request(route, 'owner', { providerId: 'fixture', nativeSessionId: 'first', takeOver: 'changed' })).status).toBe(409);
  expect((await f.request(route, 'owner', { providerId: 'fixture', nativeSessionId: 'unrelated' })).status).toBe(429); expect(host.effects.attach).toBe(1);
  release(); expect((await first).status).toBe(200);
}, 15000);

test('source recovery does not recreate a missing shared quota receipt', async () => {
  const f = await fixture(state => sourceState(state, true), false, true);
  const host = await sourceController(f, message => message.path === '/remote/create' ? { status: 503, body: { error: 'Unknown native outcome' } } : {});
  const request = () => f.request('v1/remote/hosts/mapped-host/create', 'viewer', sourceRequest);
  expect((await request()).status).toBe(503);
  await f.replaceSaved(state => { state.tenants[0]!.broker.sharing!.reservations = []; });
  await f.restart(); await host.connect(); const before = (await f.saved()).tenants[0]!.broker;
  expect((await request()).status).toBe(409); expect((await f.saved()).tenants[0]!.broker).toEqual(before); expect(host.effects.create).toBe(1); expect(host.effects.readback).toBe(0);
}, 10000);

test('changed shared request conflicts while its first admission is still unpublished', async () => {
  const f = await fixture(state => sourceState(state, true), false, true); const host = await sourceController(f);
  const hold = f.hold(state => state.tenants[0]!.broker.associations!.admissions.length === 1);
  const first = f.request('v1/remote/hosts/mapped-host/create', 'viewer', sourceRequest); await hold.entered;
  const changed = f.request('v1/remote/hosts/mapped-host/create', 'viewer', { ...sourceRequest, cwd: '/changed' });
  // Both requests have their own real HTTP connection while persistence holds the first response.
  const response = await changed;
  expect(response?.status).toBe(409); expect(host.effects.create).toBe(0);
  hold.release(); expect((await first).status).toBe(200);
}, 10000);

test('a changed reserved Host receipt cannot authorize relation overlay effects', async () => {
  const f = await fixture(state => {
    state.version = 9; const broker = state.tenants[0]!.broker; broker.associations!.freezes.splice(1);
    broker.bindings = ['A', 'S'].map(nativeSessionId => ({ hostId: 'mapped-host', providerId: 'fixture', nativeSessionId, agentId: nativeSessionId,
      ...(nativeSessionId === 'S' ? { sourceRelation: { id: 'side', kind: 'side' as const, sourceNativeSessionId: 'A', nativeSourceRef: ref('A'), createdAt: '2026-10-10T00:00:00.000Z' } } : {}) }));
  }, false, true);
  let receipt: any, loseApply = true, invalid = false, applyCalls = 0;
  await sourceController(f, (_message, input) => {
    if (input.action === 'describe') return { body: { role: f.row().projection.role, lineage: [ref('A'), ref('B')], associationRevision: 7, relationUpdates: 1, sourceParticipants: [{ readerRef: ref('S') }] } };
    if (input.action === 'relation_reserve') receipt = { reservation: input.reservation, phase: 'reserved', associationRevision: 7 };
    if (input.action === 'relation_apply') { applyCalls++; if (loseApply) { loseApply = false; return { status: 503, body: { error: 'Unknown apply' } }; } }
    return { body: { receipt: receipt ? { ...receipt, associationRevision: invalid ? 8 : 7 } : null } };
  });
  const request = { hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'S', id: 'side', sourceNativeSessionId: 'A', linked: false, expectedRevision: 0, expectedRoleRevision: 2, operationId: 'relation-edit' };
  expect((await f.request('v1/session-relations', 'owner', request, 'PATCH')).status).not.toBe(200); expect(applyCalls).toBe(1);
  const before = (await f.saved()).tenants[0]!.broker.associations; invalid = true;
  expect((await f.request('v1/session-relations/reconcile', 'owner', { hostId: 'mapped-host', operationId: 'relation-edit' })).status).not.toBe(200);
  expect(applyCalls).toBe(1); expect((await f.saved()).tenants[0]!.broker.associations).toEqual(before);
}, 10000);

for (const excess of [0, 1]) test(`fresh source consumer observes the actual-codec exact limit plus ${excess} byte`, async () => {
  const f = await fixture(state => {
    sourceState(state); state.tenants[0]!.broker.associations!.freezes.push({ hostId: 'mapped-host', receipt: { version: 2, token: 'other', maxProjectionBytes: 65536,
      authority: { version: 1, ...state.config, namespace: state.tenants[0]!.namespace, ownerSubject: 'owner' }, controllerId: 'installation',
      request: { operationId: 'other', roleId: 'other', expectedRevision: 1, from: ref('other') }, associationRevision: 0, lineage: [ref('other')], relations: [] } });
  }, false, true);
  const host = await sourceController(f); await f.request('v1/remote/hosts');
  const costs = { measureSnapshot(state: Readonly<HostedRelayState>) { return { snapshotFormat: SQL_SNAPSHOT_FORMAT, recordFormat: SQL_RECORD_FORMAT, chunkBytes: SQL_CHUNK_BYTES, costs: encodeSqlSnapshot(state as HostedRelayState, f.auth).costs }; }, quoteRecord: quoteSqlRecord };
  const proposed = await f.saved(); seedSourceAdmission(proposed); proposed.tenants[0]!.broker.associations!.revision++;
  const receipt = proposed.tenants[0]!.broker.associations!.freezes[0]!.receipt;
  if (receipt.version !== 2) throw new Error('Expected bounded fixture');
  for (let iteration = 0; iteration < 4; iteration++) receipt.maxProjectionBytes += 8_388_608 + excess - deriveSuccessionCapacity(proposed, costs).featureCharge;
  expect(deriveSuccessionCapacity(proposed, costs).featureCharge).toBe(8_388_608 + excess);
  await f.replaceSaved(state => { state.tenants[0]!.broker.associations!.freezes[0]!.receipt = receipt; });
  await f.restart(); await host.connect(); await f.request('v1/remote/hosts'); const writes = f.writes();
  const response = await f.request('v1/remote/hosts/mapped-host/create', 'owner', sourceRequest);
  expect(response.status).toBe(excess ? 409 : 200); expect(host.effects.create).toBe(excess ? 0 : 1);
  if (excess) expect(f.writes()).toBe(writes);
}, 10000);

test('a saved creation with an unresolved admission explicitly defers partial-record reconciliation', async () => {
  const f = await fixture(state => sourceState(state), false, true), host = await sourceController(f);
  expect((await f.request('v1/remote/hosts/mapped-host/create', 'owner', sourceRequest)).status).toBe(200);
  await f.replaceSaved(state => seedSourceAdmission(state)); await f.restart(); await host.connect();
  const before = (await f.saved()).tenants[0]!.broker;
  expect((await f.request('v1/remote/hosts/mapped-host/create', 'owner', sourceRequest)).status).toBe(409);
  expect((await f.saved()).tenants[0]!.broker).toEqual(before); expect(host.effects.create).toBe(1);
}, 10000);

test('a replaced Host connection retains source evidence and exact recovery never repeats create', async () => {
  const f = await fixture(state => sourceState(state, true), false, true);
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; }); closers.push(async () => release());
  const host = await sourceController(f, async message => { if (message.path === '/remote/create') await waiting; return {}; });
  const request = () => f.request('v1/remote/hosts/mapped-host/create', 'viewer', sourceRequest);
  const first = request(); await until(() => host.effects.create === 1);
  const before = (await f.saved()).tenants[0]!.broker;
  await host.connect(); expect((await first).status).toBe(503); release();
  const unresolved = (await f.saved()).tenants[0]!.broker;
  expect(unresolved.associations).toEqual(before.associations); expect(unresolved.sharing).toEqual(before.sharing);
  expect(unresolved.bindings).toEqual(before.bindings); expect(unresolved.creations).toEqual(before.creations);
  expect((await request()).status).toBe(200); expect(host.effects).toEqual({ create: 1, attach: 1, readback: 1 });
}, 10000);

test('a missing source result is not safe rejection and preserves the exact reopened quota claim', async () => {
  const f = await fixture(state => sourceState(state, true), false, true);
  let missing = true;
  const host = await sourceController(f, (message, input) => {
    if (message.path === '/remote/create') return { status: 503, body: { error: 'Unknown native outcome' } };
    if (input.action === 'source-result' && missing) return { status: 404, body: { code: 'source_result_not_found', error: 'No result witness is available' } };
    return {};
  });
  const request = () => f.request('v1/remote/hosts/mapped-host/create', 'viewer', sourceRequest);
  expect((await request()).status).toBe(503); await f.restart(); await host.connect();
  const before = (await f.saved()).tenants[0]!.broker;
  expect((await request()).status).not.toBe(200);
  expect((await f.saved()).tenants[0]!.broker).toEqual(before); expect(host.effects).toEqual({ create: 1, attach: 0, readback: 1 });
  missing = false; expect((await request()).status).toBe(200); expect(host.effects).toEqual({ create: 1, attach: 1, readback: 2 });
}, 10000);

for (const concurrent of [false, true]) test(`exact owner attach confirms ${concurrent ? 'reconnected concurrent' : 'restored'} runtime state without a second dispatch`, async () => {
  const f = await fixture(state => {
    sourceState(state); const broker = state.tenants[0]!.broker;
    Object.assign(broker.bindings[0]!, { creatorSubject: 'owner', sourceRelation: { id: 'retained-side', kind: 'side', sourceNativeSessionId: 'previous', nativeSourceRef: ref('previous'), createdAt: '2026-10-10T00:00:00.000Z' } });
    broker.bindings.unshift({ hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'before', agentId: 'before-agent' });
    broker.bindings.push({ hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'after', agentId: 'after-agent' });
  }, false, true);
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; }); closers.push(async () => release());
  let checking = !concurrent; const inputs: any[] = [];
  const host = await sourceController(f, async (message, input) => {
    if (message.path !== '/remote/attach' || !checking) return {};
    inputs.push(input);
    if (inputs.length > 1) return { status: 503, body: { error: 'Unexpected second attach' } };
    await waiting; return {};
  });
  const request = () => f.request('v1/remote/hosts/mapped-host/attach', 'owner', { providerId: 'fixture', nativeSessionId: 'A', takeOver: 'fixture-owner' });
  if (concurrent) { expect((await request()).status).toBe(200); await host.connect(); checking = true; }
  await f.request('v1/remote/hosts'); const before = (await f.saved()).tenants[0]!.broker, writes = f.writes();
  const first = request(); await until(() => inputs.length === 1);
  const second = concurrent ? request() : undefined;
  if (second) await new Promise(resolve => setTimeout(resolve, 20));
  release(); expect((await first).status).toBe(200); if (second) expect((await second).status).toBe(200);
  expect(inputs).toEqual([{ providerId: 'fixture', nativeSessionId: 'A', takeOver: 'fixture-owner' }]);
  expect(f.writes()).toBe(writes); expect((await f.saved()).tenants[0]!.broker).toEqual(before);
}, 10000);

for (const source of [true, false]) test(`queued shared ${source ? 'source admission' : 'ordinary reservation'} revocation refuses native dispatch and retains consistent evidence`, async () => {
  const f = await fixture(state => sourceState(state, true), false, true, true), host = await sourceController(f);
  let admitted: HostedRelayState['tenants'][number]['broker'] | undefined;
  const held = f.hold(state => {
    const broker = state.tenants[0]!.broker;
    if (!broker.sharing!.reservations.length) return false;
    admitted = structuredClone(broker); return true;
  });
  const request = source ? sourceRequest : { providerId: 'fixture', operationId: 'ordinary-shared' };
  const pending = f.request('v1/remote/hosts/mapped-host/create', 'viewer', request); await held.entered;
  const revoking = f.request('fixture/revoke-share', 'owner', { targetSubject: 'viewer' }); await until(() => f.queuedControls() === 1);
  held.release(); expect((await revoking).status).toBe(200); expect((await pending).status).toBe(403);
  expect(host.effects).toEqual({ create: 0, attach: 0, readback: 0 });
  const saved = (await f.saved()).tenants[0]!.broker;
  expect(saved.bindings).toEqual(admitted!.bindings); expect(saved.creations).toEqual([]);
  expect(saved.associations).toEqual(admitted!.associations); expect(saved.associations!.admissions).toHaveLength(source ? 1 : 0); expect(saved.associations!.revision).toBe(source ? 1 : 0);
  expect(saved.sharing!.reservations).toEqual(admitted!.sharing!.reservations); expect(saved.sharing!.reservations[0]!.agentId).toBeUndefined(); expect(saved.sharing!.grants[0]!.revoked).toBe(true);
  const writes = f.writes(); expect((await f.request('v1/remote/hosts/mapped-host/create', 'viewer', request)).status).toBe(403);
  expect(f.writes()).toBe(writes); expect((await f.saved()).tenants[0]!.broker).toEqual(saved);
}, 10000);

test('shared source recovery rechecks access after readback before native attach', async () => {
  const f = await fixture(state => sourceState(state, true), false, true, true);
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; }); closers.push(async () => release());
  const host = await sourceController(f, async (message, input) => {
    if (message.path === '/remote/create') return { status: 503, body: { error: 'Unknown native outcome' } };
    if (input.action === 'source-result') await waiting;
    return {};
  });
  const request = () => f.request('v1/remote/hosts/mapped-host/create', 'viewer', sourceRequest);
  expect((await request()).status).toBe(503); const retry = request(); await until(() => host.effects.readback === 1);
  expect((await f.request('fixture/revoke-share', 'owner', { targetSubject: 'viewer' })).status).toBe(200);
  const revoked = (await f.saved()).tenants[0]!.broker; release(); expect((await retry).status).toBe(403);
  expect(host.effects).toEqual({ create: 1, attach: 0, readback: 1 }); expect((await f.saved()).tenants[0]!.broker).toEqual(revoked);
}, 10000);

function recoveredIdentity(state: HostedRelayState) {
  const broker = state.tenants[0]!.broker;
  broker.associations = { version: 5, revision: 0, admissions: [], freezes: [], relationChanges: [], relationResets: [] };
  const recovery = { hostId: 'mapped-host', installationId: 'installation', revocationId: '00000000-0000-4000-8000-000000000001' };
  broker.revokedHosts = [{ ...recovery, revokedAt: 1 }];
  broker.pairings = [{ id: 'recovered', purpose: 'host-only', createdAt: 1, expiresAt: 100, usedAt: 2, hostId: recovery.hostId, hostName: 'Host', recovery }];
  state.version = 9;
}
function fillFeatureBudget(state: HostedRelayState) {
  const costs = { measureSnapshot: (value: Readonly<HostedRelayState>) => ({ snapshotFormat: 3, recordFormat: 1, chunkBytes: SQL_CHUNK_BYTES,
    costs: encodeSqlSnapshot(value as HostedRelayState, { ...state.config, secret: 's'.repeat(32) }).costs }), quoteRecord: quoteSqlRecord };
  const associations = state.tenants[0]!.broker.associations as any; associations.padding = '';
  associations.padding = 'x'.repeat(8388608 - deriveSuccessionCapacity(state, costs).featureCharge);
  for (let index = 0; index < 3; index++) associations.padding = associations.padding.slice(0, associations.padding.length - Math.max(0, deriveSuccessionCapacity(state, costs).featureCharge - 8388608));
  expect(deriveSuccessionCapacity(state, costs).featureCharge).toBe(8388608);
}
async function recoveryPeer(f: Awaited<ReturnType<typeof fixture>>, key = f.credential) {
  const socket = new WebSocket(f.origin.replace('http', 'ws') + '/ws/remote-host?successionEnrollment=2', { headers: { authorization: 'Bearer ' + key } });
  const messages: any[] = [];
  socket.on('message', (data: { toString(): string }) => {
    const value = JSON.parse(data.toString()); messages.push(value);
    if (value.type === 'heartbeat') socket.send(JSON.stringify({ uplinkVersion: 2, type: 'heartbeat_ack', nonce: value.nonce }));
  });
  await once(socket, 'open', { signal: AbortSignal.timeout(3000) });
  socket.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'installation', name: 'Host', credentialRotation: true, providers: [{ providerId: 'fixture', displayName: 'Fixture' }] }));
  await until(() => messages.some(row => row.type === 'registered') || socket.readyState !== 1);
  return { socket, messages, ack: () => socket.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_saved' })) };
}

test('recovery rotation unknown sync keeps complete overlap through old-key reconnect without issuing again', async () => {
  const f = await fixture(recoveredIdentity, true, true, true), peer = await recoveryPeer(f);
  f.failAfterWrite();
  expect((await f.request('v1/remote/hosts/mapped-host/rotate', 'owner', {})).status).toBe(503);
  const unknown = (await f.saved()).tenants[0]!.broker.keys;
  expect(unknown).toHaveLength(2); expect(peer.messages.filter(row => row.type === 'credential_issued')).toHaveLength(0);
  f.recover(); await f.restart(); const old = await recoveryPeer(f);
  expect((await f.saved()).tenants[0]!.broker.keys).toEqual(unknown);
  expect((await f.request('v1/remote/hosts/mapped-host/rotate', 'owner', {})).status).toBe(409);
  expect(old.messages.filter(row => row.type === 'credential_issued')).toHaveLength(0);
  expect((await f.saved()).tenants[0]!.broker.keys).toEqual(unknown);
  expect((await f.request('v1/remote/hosts/mapped-host/revoke', 'owner', {})).status).toBe(200);
  expect((await f.saved()).tenants[0]!.broker.keys).toEqual([]);
}, 10000);

test('full-budget fresh recovery invitation refuses before key publication without poisoning unrelated requests', async () => {
  const f = await fixture(state => { recoveredIdentity(state); const broker = state.tenants[0]!.broker; broker.hosts = []; broker.keys = [];
    broker.revokedHosts![0]!.revocationId = '00000000-0000-4000-8000-000000000002'; fillFeatureBudget(state); }, true, true, true);
  const before = await f.saved(), writes = f.writes();
  const response = await f.request('v1/remote/pairings', 'owner', { recoverHostId: 'mapped-host' });
  expect(response.status).toBe(409); expect(await response.text()).not.toContain('arc_');
  expect(f.writes()).toBe(writes); expect(await f.saved()).toEqual(before);
  expect((await f.request('v1/remote/hosts')).status).toBe(200);
}, 10000);

test('original recovery connection acknowledges only its exact durable overlap and a stale connection cannot clear it', async () => {
  const f = await fixture(recoveredIdentity, true, true, true), peer = await recoveryPeer(f);
  expect((await f.request('v1/remote/hosts/mapped-host/rotate', 'owner', {})).status).toBe(200);
  await until(() => peer.messages.some(row => row.type === 'credential_issued'));
  const key = peer.messages.find(row => row.type === 'credential_issued').credential;
  const overlap = (await f.saved()).tenants[0]!.broker.keys; expect(overlap).toHaveLength(2);
  const held = f.hold(state => state.tenants[0]!.broker.keys.length === 1);
  peer.ack(); await held.entered;
  expect((await f.saved()).tenants[0]!.broker.keys).toEqual(overlap);
  held.release(); await until(() => peer.messages.filter(row => row.type === 'registered').length === 2);
  const completed = (await f.saved()).tenants[0]!.broker.keys;
  expect(completed.map(([hash]) => hash)).toEqual([createHash('sha256').update(key).digest('hex')]);
  const current = await recoveryPeer(f, key);
  expect((await f.request('v1/remote/hosts/mapped-host/rotate', 'owner', {})).status).toBe(200);
  await until(() => current.messages.some(row => row.type === 'credential_issued'));
  const pending = (await f.saved()).tenants[0]!.broker.keys; expect(pending).toHaveLength(2);
  await f.restart(); const reconnected = await recoveryPeer(f, key);
  reconnected.ack(); await until(() => reconnected.socket.readyState !== 1);
  expect((await f.saved()).tenants[0]!.broker.keys).toEqual(pending);
  await f.replaceSaved(state => state.tenants[0]!.broker.keys.reverse()); await f.restart(); await recoveryPeer(f, key);
  expect((await f.request('v1/remote/hosts/mapped-host/rotate', 'owner', {})).status).toBe(409);
  expect((await f.saved()).tenants[0]!.broker.keys).toEqual([...pending].reverse());
}, 10000);

test('full feature budget revoke retains complete history and quota without ordinary-row funding', async () => {
  const f = await fixture(state => {
    const broker = state.tenants[0]!.broker, recovery = { hostId: 'mapped-host', installationId: 'installation', revocationId: '00000000-0000-4000-8000-000000000001' };
    const retained = codecState({ ...state.config, secret: 's'.repeat(32) }).tenants[0]!.broker.associations!;
    broker.associations!.relationChanges = retained.relationChanges.filter(row => row.phase === 'committed');
    broker.associations!.relationResets = retained.relationResets;
    broker.revokedHosts = [{ ...recovery, revokedAt: 1 }];
    broker.pairings = [{ id: 'unused-retained', purpose: 'host-only', createdAt: 1, expiresAt: 8640000000000000, recovery }];
    broker.sharing = { grants: [{ hostId: 'mapped-host', subject: 'viewer', label: 'Viewer', sessionLimit: 2, revoked: false }],
      reservations: [{ key: 'retained-quota', hostId: 'mapped-host', subject: 'viewer', fingerprint: 'full receipt', nativeRequestId: 'request', agentId: 'prior-agent' }] };
    broker.bindings = [{ hostId: 'mapped-host', providerId: 'fixture', agentId: 'ordinary-agent', nativeSessionId: 'C' }];
    broker.creations = [['ordinary-create', { fingerprint: 'complete ordinary creation', agentId: 'ordinary-agent' }]];
    state.sessionStars = [favorite()]; state.favoritesTrees = [{ subject: 'owner', revision: 0, folders: [] }]; state.version = 9; broker.associations!.version = 5; projectSuccessionFavorites(state, 'owner', false); fillFeatureBudget(state);
  }, true, true, true);
  const before = await f.saved();
  expect((await f.request('v1/remote/hosts/mapped-host/revoke', 'owner', {})).status).toBe(200);
  const saved = await f.saved(), broker = saved.tenants[0]!.broker;
  expect(broker.hosts).toEqual([]); expect(broker.keys).toEqual([]); expect(broker.bindings).toEqual([]); expect(broker.creations).toEqual([]);
  expect(broker.associations).toEqual(before.tenants[0]!.broker.associations);
  expect(saved.tenants[0]!.favoritesSuccession).toEqual(before.tenants[0]!.favoritesSuccession);
  expect(broker.sharing!.reservations).toEqual(before.tenants[0]!.broker.sharing!.reservations); expect(broker.sharing!.grants[0]!.revoked).toBe(true);
  expect(broker.pairings![0]!.revokedAt).toBeTypeOf('number'); expect(broker.revokedHosts).toHaveLength(1);
  expect((await f.request('v1/remote/hosts/mapped-host/revoke', 'owner', {})).status).toBe(404);
  expect(await f.saved()).toEqual(saved);
  expect((await f.request('v1/remote/pairings', 'owner', { recoverHostId: 'mapped-host' })).status).toBe(409);
  expect((await f.request('v1/remote/hosts')).status).toBe(200);
  expect((await f.saved()).tenants[0]!.broker).toEqual(broker);
}, 10000);

for (const failure of ['brand', 'producer-bound'] as const) test(`terminal ${failure} remains fail-closed with exact native evidence and no release`, async () => {
  const f = await fixture(state => { state.tenants[0]!.broker.associations!.freezes = []; }, false, true);
  if (failure === 'producer-bound') f.select(() => 1);
  const native = await controller(f);
  expect((await f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', { operationId: 'op-2', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1 })).status).toBe(200);
  const before = (await f.saved()).tenants[0]!.broker.associations;
  if (failure === 'brand') f.policyFailure();
  expect((await f.request('v1/remote/hosts/mapped-host/succession/commit', 'owner', { operationId: 'op-2' })).status).toBeGreaterThanOrEqual(500);
  expect((await f.saved()).tenants[0]!.broker.associations).toEqual(before);
  expect(native.effects).toMatchObject({ commit: 1, input: 1, release: 0 });
  expect((await f.request('v1/remote/hosts/mapped-host/succession/reconcile', 'owner', { operationId: 'op-2' })).status).toBeGreaterThanOrEqual(500);
  expect(native.effects).toMatchObject({ commit: 1, input: 1, release: 0 });
}, 10000);

test('new recovery rotation at the feature ceiling refuses before issuing a usable overlap key', async () => {
  const f = await fixture(state => {
    recoveredIdentity(state); state.tenants[0]!.broker.keys[0]![1].expires = Number.MAX_SAFE_INTEGER;
    Object.assign(state.tenants[0]!.broker.hosts[0]!, { pairingPurpose: 'host-only', credentialRotation: true });
    fillFeatureBudget(state);
  }, true, true, true);
  const peer = await recoveryPeer(f), before = await f.saved(), writes = f.writes();
  expect((await f.request('v1/remote/hosts/mapped-host/rotate', 'owner', {})).status).toBe(409);
  expect(peer.messages.filter(row => row.type === 'credential_issued')).toEqual([]); expect(peer.socket.readyState).toBe(1);
  expect(f.writes()).toBe(writes); expect(await f.saved()).toEqual(before);
  expect((await f.request('v1/remote/hosts')).status).toBe(200);
}, 10000);

for (const phase of ['rejected', 'cancelled'] as const) test(`durable ${phase} decision consumes its transition once after retention completes`, async () => {
  const f = await fixture(state => { state.tenants[0]!.broker.associations!.freezes = []; }, false, true), native = await controller(f);
  const prepared = await (await f.request('v1/remote/hosts/mapped-host/succession/prepare', 'owner', { operationId: 'op-2', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1 })).json();
  native.seed({ ...prepared.record, phase });
  const before = (await f.saved()).tenants[0]!.broker.associations!, held = f.hold(state => state.tenants[0]!.broker.associations!.freezes[0]?.released === phase);
  let replied = false;
  const pending = f.request('v1/remote/hosts/mapped-host/succession/status', 'owner', { operationId: 'op-2' }).then(response => { replied = true; return response; });
  await held.entered; expect(replied).toBe(false); expect(native.effects.release).toBe(0);
  expect((await f.saved()).tenants[0]!.broker.associations).toEqual(before);
  held.release(); expect((await pending).status).toBe(200);
  const settled = (await f.saved()).tenants[0]!.broker.associations!;
  expect(settled.revision).toBe(before.revision + 1); expect(settled.freezes[0]!.released).toBe(phase);
  expect(settled.freezes[0]!.projection).toBeUndefined(); expect((await f.saved()).tenants[0]!.favoritesSuccession).toBeUndefined();
  expect((await f.request('v1/remote/hosts/mapped-host/succession/status', 'owner', { operationId: 'op-2' })).status).toBe(200);
  expect((await f.saved()).tenants[0]!.broker.associations).toEqual(settled); expect(native.effects.commit).toBe(0);
}, 10000);

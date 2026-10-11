import { expect, test } from 'vitest';
import type { WebSocket } from 'miniflare';
import { event, fixture, origin, send } from './fixture.js';

const ref = (nativeSessionId: string) => ({ controllerId: 'installation', providerId: 'fixture', nativeSessionId });
const workspace = { controllerId: 'installation', canonicalCwd: '/workspace' };
const sequence = ['A', 'B', 'C'];
const role = (revision: number) => ({ id: 'role', revision, origin: ref('A'), current: ref(sequence[revision - 1]!), workspace });

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Succession frame deadline exceeded');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** Deterministic Host evidence over the production Worker uplink, with no seeded Relay state. */
async function connectHost(f: Awaited<ReturnType<typeof fixture>>, key: string) {
  const socket = await f.upgrade('/ws/remote-host?successionEnrollment=2', { authorization: `Bearer ${key}` });
  const registered = event(socket, 'message');
  send(socket, { type: 'register', credentialRotation: true, installationId: 'installation', name: 'Host',
    providers: [{ providerId: 'fixture', displayName: 'Fixture' }] });
  let registration = await registered;
  expect(registration.type).toBe('credential_issued');
  const saved = event(socket, 'message');
  send(socket, { type: 'credential_saved' });
  registration = await saved;
  expect(registration).toMatchObject({ type: 'registered', successionEnrollment: { ownerSubject: 'owner' }, successionEnrollmentVersion: 2 });

  const effects = { prepare: 0, commit: 0, release: 0, attach: 0, rpc: [] as string[], freezes: [] as any[] };
  const operations = new Map<string, any>();
  const releases = new Set<string>();
  let revision = 1;
  socket.addEventListener('message', message => {
    const frame = JSON.parse(String(message.data));
    if (frame.type === 'heartbeat') { send(socket, { type: 'heartbeat_ack', nonce: frame.nonce }); return; }
    if (frame.type !== 'rpc_request') return;
    effects.rpc.push(frame.path);
    const input = JSON.parse(frame.body ?? '{}');
    let result: any = {};
    if (frame.path === '/remote/succession/enrollment') {
      if (input.action === 'describe') {
        result = { role: role(revision), lineage: sequence.slice(0, revision).map(ref) };
      } else {
        const freeze = input.freeze;
        effects.freezes.push(structuredClone(freeze));
        const request = freeze.request;
        let record = operations.get(request.operationId);
        if (input.action === 'prepare' && !record) {
          effects.prepare++;
          const to = ref(sequence[request.expectedRevision]!);
          record = { ...request, phase: 'ready', to, startedAt: 'now', updatedAt: 'now',
            prepared: { ...request, to, workspace, associationRevision: 1, participants: [],
              capture: { epoch: 'e', seq: 1, capturedAt: 'now' } } };
          operations.set(request.operationId, record);
        }
        if (input.action === 'commit' && record.phase !== 'committed') {
          effects.commit++;
          record.phase = 'committed';
          record.committedRevision = ++revision;
        }
        if (input.action === 'release' && !releases.has(request.operationId)) {
          releases.add(request.operationId); effects.release++;
        }
        result = { record: structuredClone(record), role: role(record.committedRevision ?? revision), freeze };
      }
    } else if (frame.path.endsWith('/attach')) {
      effects.attach++;
      result = { agentId: frame.sessionId, nativeSessionId: input.nativeSessionId };
    }
    send(socket, { type: 'rpc_response', requestId: frame.requestId, status: 200, body: JSON.stringify(result) });
  });
  return { socket, hostId: registration.hostId as string, authority: registration.successionEnrollment, effects };
}

function observe(socket: WebSocket) {
  const frames: any[] = [];
  socket.addEventListener('message', message => frames.push(JSON.parse(String(message.data))));
  return frames;
}

test('actual RelayObject admits public succession and cold-replays the exact committed projections and Favorites', async () => {
  const f = await fixture({ actualEntry: true });
  const owner = await f.login('owner');
  const viewer = await f.login('viewer');
  const pairingResponse = await f.json(owner.basePath + 'v1/remote/pairings', owner.cookie, {});
  expect(pairingResponse.status).toBe(201);
  const pairing = await pairingResponse.json() as { key: string };
  const host = await connectHost(f, pairing.key);
  const hostPath = owner.basePath + `v1/remote/hosts/${host.hostId}`;
  const favoritesPath = owner.basePath + 'v1/favorites';
  expect((await f.json(favoritesPath, owner.cookie, { type: 'create-folder', id: 'folder', parentId: null, title: 'Work', revision: 0 })).status).toBe(200);
  expect((await f.json(hostPath + '/attach', owner.cookie, { providerId: 'fixture', nativeSessionId: 'A' })).status).toBe(200);
  const favoriteResponse = await f.json(favoritesPath, owner.cookie, { type: 'save-session',
    session: { hostId: host.hostId, providerId: 'fixture', nativeSessionId: 'A', title: 'Saved work' }, folderId: 'folder', revision: 1 });
  expect(favoriteResponse.status).toBe(200);
  const favoriteId = (await favoriteResponse.json() as any).stars[0].favoriteId;
  const channel = await f.upgrade(owner.basePath + 'v1/session-channel?observation=session&successions=1', { cookie: owner.cookie, origin });
  const liveFrames = observe(channel);

  for (const nextRevision of [2, 3]) {
    const prepared = await f.json(hostPath + '/succession/prepare', owner.cookie, { operationId: 'op-' + nextRevision,
      providerId: 'fixture', nativeSessionId: sequence[nextRevision - 2], expectedRevision: nextRevision - 1 });
    expect(prepared.status, await prepared.clone().text()).toBe(200);
    const committed = await f.json(hostPath + '/succession/commit', owner.cookie, { operationId: 'op-' + nextRevision });
    expect(committed.status, await committed.clone().text()).toBe(200);
  }
  await until(() => liveFrames.filter(frame => frame.type === 'session_succession_committed').length === 2);
  expect(host.effects).toMatchObject({ prepare: 2, commit: 2, release: 2, attach: 1 });
  expect(host.effects.rpc.every(path => path === '/remote/succession/enrollment' || path === '/remote/attach')).toBe(true);
  for (const freeze of host.effects.freezes) {
    expect(freeze).toMatchObject({ version: 2, authority: host.authority, controllerId: 'installation' });
    expect(freeze.maxProjectionBytes).toBeGreaterThan(0);
    expect(Number.isSafeInteger(freeze.maxProjectionBytes)).toBe(true);
  }

  const replayPath = owner.basePath + 'v1/session-successions';
  const beforeResponse = await f.json(replayPath, owner.cookie);
  expect(beforeResponse.status).toBe(200);
  const before = await beforeResponse.json() as any;
  expect(before.successions.map((row: any) => row.to.nativeSessionId)).toEqual(['B', 'C']);
  const projections = before.successions.map((row: any) => row.projection);
  expect(liveFrames.filter(frame => frame.type === 'session_succession_committed').map(frame => frame.succession)).toEqual(before.successions);
  const favoriteBefore = await (await f.json(favoritesPath, owner.cookie)).json() as any;
  expect(favoriteBefore.stars[0]).toMatchObject({ nativeSessionId: 'C', favoriteId, folderId: 'folder' });
  expect(favoriteBefore.successionProgress).toMatchObject({ version: 1, roles: [{ roleId: 'role', roleRevision: 3, status: 'applied' }] });

  host.socket.close(); channel.close();
  const effectsBeforeRestart = structuredClone(host.effects);
  const authorityBeforeRestart = f.authorityCalls;
  await f.restart();
  expect((await f.request(replayPath)).status).toBe(401);
  expect((await f.json(replayPath, viewer.cookie)).status).toBe(403);
  expect((await f.json(viewer.basePath + 'v1/session-successions', viewer.cookie)).status).toBe(200);
  expect((await (await f.json(viewer.basePath + 'v1/session-successions', viewer.cookie)).json() as any).successions).toEqual([]);
  expect((await f.json(viewer.basePath + 'v1/session-successions/operation?roleId=role&operationId=op-2', viewer.cookie)).status).toBe(403);
  const afterResponse = await f.json(replayPath, owner.cookie);
  expect(afterResponse.status).toBe(200);
  const after = await afterResponse.json() as any;
  expect(after.successions.map((row: any) => row.to.nativeSessionId)).toEqual(['B', 'C']);
  expect(JSON.stringify(after.successions.map((row: any) => row.projection))).toBe(JSON.stringify(projections));
  const operation = await f.json(replayPath + '/operation?roleId=role&operationId=op-2', owner.cookie);
  expect(operation.status).toBe(200);
  expect((await operation.json() as any).projection).toEqual(projections[0]);
  const current = await f.json(replayPath + '/current?roleId=role', owner.cookie);
  expect(current.status).toBe(200);
  expect(await current.json()).toMatchObject({ role: role(3), locator: { nativeSessionId: 'C' } });
  const favoritesAfter = await f.json(favoritesPath, owner.cookie);
  expect(favoritesAfter.status).toBe(200);
  const favorites = await favoritesAfter.json() as any;
  expect(favorites.stars[0]).toMatchObject({ nativeSessionId: 'C', favoriteId, folderId: 'folder' });
  expect(favorites.successionProgress).toEqual(favoriteBefore.successionProgress);

  const restoredChannel = await f.upgrade(owner.basePath + 'v1/session-channel?observation=session&successions=1', { cookie: owner.cookie, origin });
  const coldFrames = observe(restoredChannel);
  await until(() => coldFrames.filter(frame => frame.type === 'session_succession_committed').length === 2);
  expect(JSON.stringify(coldFrames.filter(frame => frame.type === 'session_succession_committed').map(frame => frame.succession.projection))).toBe(JSON.stringify(projections));
  expect(host.effects).toEqual(effectsBeforeRestart);
  expect(f.authorityCalls).toBeGreaterThan(authorityBeforeRestart);
  expect((await (await f.json(owner.basePath + 'v1/remote/hosts', owner.cookie)).json() as any).hosts[0]).toMatchObject({ id: host.hostId, online: false });
}, 30000);

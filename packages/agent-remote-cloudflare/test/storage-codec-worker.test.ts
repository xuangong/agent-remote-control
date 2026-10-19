import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { codecState } from './storage-codec-fixture.js';
import { fixture, origin, issuer, secret } from './fixture.js';
import { SQL_CHUNK_BYTES } from '../src/storage-codec.js';

test('real Worker SQLite stores bounded BLOB records and ordered headers, survives a late abort and persisted restart', async () => {
  const f = await fixture({ completeCodec: true }); const state = codecState({ origin, issuer, secret });
  const broker = state.tenants[0]!.broker;
  (broker.associations!.freezes[0] as any).extraEvidence = '😀\ud800'.repeat(80000);
  broker.bindings = Array.from({ length: 80 }, (_, index) => ({ agentId: 'a'.repeat(4090) + index, hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'native-' + index }));
  broker.creations = [];
  expect((await f.inspect('codec/seed', { method: 'POST', body: JSON.stringify(state) })).status).toBe(200);
  const physical = await (await f.inspect('codec/physical')).json() as any;
  expect(physical.metadata[0].version).toBe(3);
  expect(physical.manifests.find((row: any) => row.kind === 'freeze' && row.chunk_count > 1)).toBeTruthy();
  expect(physical.manifests.find((row: any) => row.kind === 'brokerHeader' && row.chunk_count > 1)).toBeTruthy();
  expect(physical.chunks.every((row: any) => row.type === 'blob' && row.size <= SQL_CHUNK_BYTES)).toBe(true);
  expect(physical.chunkDigests).toHaveLength(physical.chunks.length);
  expect(physical.chunkDigests.every((row: any) => /^[a-f0-9]{64}$/.test(row.digest))).toBe(true);
  expect(physical.blob[0]).toMatchObject({ arrayBuffer: true });
  expect(await (await f.inspect('codec/snapshot')).json()).toEqual(state);
  await f.inspect('fail-commit?kind=progress'); const next = structuredClone(state);
  (next.tenants[0]!.broker.associations!.freezes[0] as any).extraEvidence += 'changed';
  next.sessionStars![0]!.title = 'must roll back'; next.favoritesTrees![0]!.folders[0]!.title = 'must roll back';
  next.tenants[0]!.favoritesSuccession!.receipts[1]!.status = 'applied';
  expect((await f.inspect('codec/seed', { method: 'POST', body: JSON.stringify(next) })).status).toBe(500);
  expect(await (await f.inspect('codec/physical')).json()).toEqual(physical);
  await f.inspect('restore-commit'); await f.restart();
  expect(await (await f.inspect('codec/snapshot')).json()).toEqual(state);
}, 30000);

test('authenticated Worker HTTP and WS reopen complete saved C evidence, Favorites and recovery history without native replay', async () => {
  const f = await fixture({ completeCodec: true }); const owner = await f.login('owner'); const viewer = await f.login('viewer');
  const state = codecState({ origin, issuer, secret }); const authenticated = await (await f.inspect('codec/snapshot')).json() as any;
  state.sessions = authenticated.sessions; state.loginChallenges = authenticated.loginChallenges; state.consumedProofs = authenticated.consumedProofs;
  expect((await f.inspect('codec/seed', { method: 'POST', body: JSON.stringify(state) })).status).toBe(200);
  const replay = owner.basePath + 'v1/session-successions';
  expect((await f.request(replay)).status).toBe(401);
  const before = await (await f.json(replay, owner.cookie)).json() as any;
  expect(before.successions.map((row: any) => row.to.nativeSessionId)).toEqual(['B', 'C']);
  expect((await (await f.json(replay + '/current?roleId=role', owner.cookie)).json() as any).locator.nativeSessionId).toBe('C');
  expect((await (await f.json(viewer.basePath + 'v1/session-successions', viewer.cookie)).json() as any).successions).toEqual([]);
  expect((await (await f.json(owner.basePath + 'v1/favorites', owner.cookie)).json() as any).stars[0]).toMatchObject({ nativeSessionId: 'C', favoriteId: 'favorite', folderId: 'folder' });
  const pairing = await (await f.json(owner.basePath + 'v1/remote/pairings', owner.cookie)).json() as any;
  expect(JSON.stringify(pairing)).toContain('historic-host');
  const socket = await f.upgrade(owner.basePath + 'v1/session-channel?observation=session&successions=1', { origin, cookie: owner.cookie });
  const frames: any[] = []; socket.addEventListener('message', message => frames.push(JSON.parse(String(message.data))));
  const deadline = Date.now() + 5000;
  while (frames.filter(frame => frame.type === 'session_succession_committed').length < 2) { if (Date.now() > deadline) throw new Error('Replay frame deadline'); await new Promise(resolve => setTimeout(resolve, 5)); }
  expect(JSON.stringify(frames)).toContain('"nativeSessionId":"C"'); socket.close();
  await f.restart();
  const after = await (await f.json(replay, owner.cookie)).json() as any;
  expect(JSON.stringify(after.successions.map((row: any) => row.projection))).toBe(JSON.stringify(before.successions.map((row: any) => row.projection)));
  const restored = await (await f.inspect('codec/snapshot')).json() as any;
  expect(restored.tenants[0].broker.revokedHosts).toEqual(state.tenants[0]!.broker.revokedHosts);
  expect(restored.tenants[0].broker.keys[0][1].recovery).toEqual(state.tenants[0]!.broker.keys[0]![1].recovery);
  expect(restored.tenants[0].broker.pairings).toEqual(state.tenants[0]!.broker.pairings);
  expect(createHash('sha256').update(JSON.stringify(restored.tenants[0].broker.associations.freezes)).digest('hex')).toBe(createHash('sha256').update(JSON.stringify(state.tenants[0]!.broker.associations!.freezes)).digest('hex'));
  // There is no registered native Host in this fixture; every effect would require one.
}, 30000);

test('Window documents, hashed management grants, operation receipts and deletion survive Worker SQLite restart atomically', async () => {
  const f = await fixture({ completeCodec: true }); const state = codecState({ origin, issuer, secret });
  const now = Date.now();
  state.workspaceWindows = [{ subject: 'owner', id: 'window', generation: 1,
    window: { schemaVersion: 3, id: 'window', title: 'Shared', revision: 1, selectedPrimaryViewId: 'primary', selectedViewId: 'primary',
      views: [{ id: 'primary', placement: 'primary', width: 480, collapsed: false, display: { mode: 'content', lettersVisible: true } }] },
    manager: { generation: 1, hash: createHash('sha256').update('private-window-grant').digest('hex'), session: { hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'A', title: 'Manager' } },
    receipts: [{ fingerprint: 'a'.repeat(64), result: { operationId: 'rename', status: 'committed', revision: 1, committedAt: now, expiresAt: now + 86400000 } }] }];
  expect((await f.inspect('codec/seed', { method: 'POST', body: JSON.stringify(state) })).status).toBe(200);
  const physical = await (await f.inspect('codec/physical')).json() as any;
  expect(physical.manifests.some((row: any) => row.kind === 'workspaceWindow')).toBe(true);
  await f.restart();
  expect((await (await f.inspect('codec/snapshot')).json() as any).workspaceWindows).toEqual(state.workspaceWindows);
  const deleted = structuredClone(state); const row = deleted.workspaceWindows![0]!;
  delete row.window; row.deleted = true; row.receipts.push({ fingerprint: 'b'.repeat(64), result: { operationId: 'delete', status: 'committed', revision: 2, committedAt: now, expiresAt: now + 86400000 } });
  await f.inspect('fail-commit');
  expect((await f.inspect('codec/seed', { method: 'POST', body: JSON.stringify(deleted) })).status).toBe(500);
  await f.inspect('restore-commit'); await f.restart();
  expect((await (await f.inspect('codec/snapshot')).json() as any).workspaceWindows).toEqual(state.workspaceWindows);
  expect((await f.inspect('codec/seed', { method: 'POST', body: JSON.stringify(deleted) })).status).toBe(200);
  await f.restart();
  expect((await (await f.inspect('codec/snapshot')).json() as any).workspaceWindows).toEqual(deleted.workspaceWindows);
}, 30000);

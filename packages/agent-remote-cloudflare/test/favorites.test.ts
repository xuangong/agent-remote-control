import { expect, it } from 'vitest';
import { fixture, send } from './fixture.js';

it('persists the account favorites tree through Durable Object restart and enforces revision and isolation over HTTP', async () => {
  const f = await fixture(); const alice = await f.login('alice'); const bob = await f.login('bob');
  const path = alice.basePath + 'v1/favorites';
  expect((await f.request(path)).status).toBe(401);
  expect(await (await f.json(path, alice.cookie)).json()).toEqual({ revision: 0, folders: [], stars: [] });
  const create = await f.json(path, alice.cookie, { type: 'create-folder', id: 'folder', parentId: null, title: 'Work', revision: 0 });
  expect(create.status).toBe(200);
  expect(await create.json()).toMatchObject({ revision: 1, folders: [{ id: 'folder', title: 'Work', parentId: null, order: 0 }] });
  expect((await f.json(path, alice.cookie, { type: 'delete-folder', id: 'folder', revision: 0 })).status).toBe(409);
  expect((await f.json(path, bob.cookie)).status).toBe(403);
  expect((await f.json(bob.basePath + 'v1/favorites', bob.cookie, { type: 'rename-folder', id: 'folder', title: 'Stolen', revision: 0 })).status).toBe(404);
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const { socket: host, hostId } = await f.host(pairing.key);
  host.addEventListener('message', message => {
    const frame = JSON.parse(String(message.data)); if (frame.type !== 'rpc_request') return;
    send(host, { type: 'rpc_response', requestId: frame.requestId, status: 200, body: JSON.stringify({ agentId: frame.sessionId, nativeSessionId: 'native' }) });
  });
  expect((await f.json(alice.basePath + `v1/remote/hosts/${hostId}/attach`, alice.cookie, { providerId: 'codex', nativeSessionId: 'native' })).status).toBe(200);
  const session = { hostId, providerId: 'codex', nativeSessionId: 'native', title: 'Saved work' };
  const save = await f.json(path, alice.cookie, { type: 'save-session', session, folderId: 'folder', revision: 1 });
  expect(save.status).toBe(200); const saved = await save.json() as any;
  await f.restart();
  const restored = await (await f.json(path, alice.cookie)).json() as any;
  expect(restored).toMatchObject({ revision: 2, folders: saved.folders, stars: [{ favoriteId: saved.stars[0].favoriteId, folderId: 'folder', order: 0 }] });
  expect(await (await f.json(bob.basePath + 'v1/favorites', bob.cookie)).json()).toEqual({ revision: 0, folders: [], stars: [] });
  const { title: _, ...identity } = session;
  expect((await f.json(alice.basePath + 'v1/stars', alice.cookie, identity, 'DELETE')).status).toBe(200);
  expect(await (await f.json(path, alice.cookie)).json()).toMatchObject({ revision: 3, stars: [] });
  await f.restart();
  expect(await (await f.json(path, alice.cookie)).json()).toMatchObject({ revision: 3, stars: [], folders: [{ id: 'folder' }] });
}, 15000);

it('does not commit or return a successful tree edit when SQLite rejects persistence', async () => {
  const f = await fixture(); const alice = await f.login('alice'); const path = alice.basePath + 'v1/favorites';
  expect((await f.json(path, alice.cookie, { type: 'create-folder', id: 'folder', title: 'Original', parentId: null, revision: 0 })).status).toBe(200);
  expect((await f.inspect('fail-commit?kind=favorites')).status).toBe(200);
  expect((await f.json(path, alice.cookie, { type: 'rename-folder', id: 'folder', title: 'Not committed', revision: 1 })).status).toBe(503);
  expect((await f.inspect('restore-commit')).status).toBe(200);
  await f.restart();
  expect(await (await f.json(path, alice.cookie)).json()).toMatchObject({ revision: 1, folders: [{ title: 'Original' }] });
}, 15000);

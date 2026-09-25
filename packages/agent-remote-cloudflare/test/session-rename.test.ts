import { expect, it } from 'vitest';
import { fixture, origin, send } from './fixture.js';

it.each(['codex', 'copilot', 'claude'])('confirms %s rename before updating favorites and broadcasts the same identity to other devices', async providerId => {
  const f = await fixture(); const alice = await f.login('alice'); const second = await f.login('alice'); const bob = await f.login('bob');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const { socket: host, hostId } = await f.host(pairing.key, false, undefined, true, false, providerId);
  let writes = 0; let reject = false;
  host.addEventListener('message', message => {
    const frame = JSON.parse(String(message.data)); if (frame.type !== 'rpc_request') return;
    if (frame.path === '/remote/session/rename') {
      writes++; const input = JSON.parse(frame.body);
      send(host, { type: 'rpc_response', requestId: frame.requestId, status: reject ? 503 : 200,
        body: JSON.stringify(reject ? { error: 'Native rename failed.' } : { title: input.title }) });
    }
  });
  const identity = { hostId, providerId, nativeSessionId: 'native' };
  const path = alice.basePath + 'v1/favorites';
  await f.json(path, alice.cookie, { type: 'create-folder', id: 'folder', parentId: null, title: 'Work', revision: 0 });
  const saved = await (await f.json(path, alice.cookie, { type: 'save-session', session: { ...identity, title: 'Original' }, folderId: 'folder', revision: 1 })).json() as any;
  await f.json(path, alice.cookie, { type: 'save-session', session: { ...identity, nativeSessionId: 'other', title: 'Original' }, folderId: null, revision: saved.revision });
  const messages: any[][] = [[], []];
  for (const [i, account] of [second, bob].entries()) {
    const ws = await f.upgrade(account.basePath + 'v1/session-channel?observation=session&titles=1', { cookie: account.cookie, origin });
    ws.addEventListener('message', e => messages[i]!.push(JSON.parse(String(e.data))));
  }
  const route = alice.basePath + `v1/remote/hosts/${hostId}/session/rename`;
  const payload = { providerId, nativeSessionId: 'native', title: 'Renamed', operationId: 'c1403532-9dd9-4b0e-9938-d57241cbb96d' };
  expect((await f.json(route, bob.cookie, payload)).status).toBe(403);
  const result = await f.json(route, alice.cookie, payload);
  expect(result.status).toBe(200); expect(await result.json()).toEqual({ title: 'Renamed' }); expect(writes).toBe(1);
  const updated = await (await f.json(path, second.cookie)).json() as any;
  expect(updated.stars.find((s: any) => s.nativeSessionId === 'other').title).toBe('Original');
  expect(updated.stars.find((s: any) => s.nativeSessionId === 'native')).toMatchObject({ ...identity, title: 'Renamed', favoriteId: saved.stars[0].favoriteId, folderId: 'folder', order: 0, canRename: true });
  await expect.poll(() => messages[0]!.some(m => m.type === 'session_title_updated' && m.session.title === 'Renamed')).toBe(true);
  expect(messages[1]!.some(m => m.type === 'session_title_updated')).toBe(false);
  const revision = updated.revision;
  expect((await f.json(route, alice.cookie, payload)).status).toBe(200);
  expect(((await (await f.json(path, alice.cookie)).json()) as any).revision).toBe(revision);
  expect(messages[0]!.filter(m => m.type === 'session_title_updated' && m.session.title === 'Renamed')).toHaveLength(1);
  reject = true;
  expect((await f.json(route, alice.cookie, { ...payload, title: 'Rejected', operationId: 'b1403532-9dd9-4b0e-9938-d57241cbb96d' })).status).toBe(503);
  expect((await (await f.json(path, alice.cookie)).json() as any).stars.find((s: any) => s.nativeSessionId === 'native').title).toBe('Renamed');
}, 15000);

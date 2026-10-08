import { expect, it } from 'vitest';
import { fixture, origin, send } from './fixture.js';

it.each(['codex', 'copilot', 'claude', 'opencode'])('confirms %s rename before updating favorites and broadcasts the same identity to other devices', async providerId => {
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

it('renames unstarred sessions, restores title broadcasts after reconnect and restart, and removes revoked Host titles', async () => {
  const f = await fixture(); const alice = await f.login('alice'); const second = await f.login('alice'); const bob = await f.login('bob');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const { socket: host, hostId } = await f.host(pairing.key, false, undefined, true);
  let reject = false;
  host.addEventListener('message', message => {
    const frame = JSON.parse(String(message.data)); if (frame.type !== 'rpc_request' || frame.path !== '/remote/session/rename') return;
    const input = JSON.parse(frame.body);
    send(host, { type: 'rpc_response', requestId: frame.requestId, status: reject ? 503 : 200,
      body: JSON.stringify(reject ? { error: 'Native rename failed.' } : { title: input.title }) });
  });
  const listen = async (account = second) => {
    const messages: any[] = [];
    const socket = await f.upgrade(account.basePath + 'v1/session-channel?observation=session&titles=1', { cookie: account.cookie, origin });
    socket.addEventListener('message', event => messages.push(JSON.parse(String(event.data))));
    return { socket, messages };
  };
  const other = await listen(); const stranger = await listen(bob);
  const identity = { hostId, providerId: 'codex', nativeSessionId: 'unstarred' };
  const route = alice.basePath + `v1/remote/hosts/${hostId}/session/rename`;
  const input = { providerId: 'codex', nativeSessionId: identity.nativeSessionId, title: 'Main session', operationId: 'new-title' };
  expect((await f.json(route, alice.cookie, input)).status).toBe(200);
  await expect.poll(() => other.messages.find(message => message.type === 'session_title_updated')?.session).toMatchObject({ ...identity, title: 'Main session' });
  const revision = other.messages.find(message => message.type === 'session_title_updated').session.revision;
  expect((await (await f.json(alice.basePath + 'v1/favorites', alice.cookie)).json() as any).stars).toEqual([]);
  expect(stranger.messages.some(message => message.type === 'session_title_updated')).toBe(false);
  expect((await f.json(route, alice.cookie, input)).status).toBe(200);
  expect(other.messages.filter(message => message.type === 'session_title_updated')).toHaveLength(1);
  reject = true;
  expect((await f.json(route, alice.cookie, { ...input, title: 'Rejected', operationId: 'reject-title' })).status).toBe(503);
  other.socket.close();
  const reconnected = await listen();
  await expect.poll(() => reconnected.messages.find(message => message.type === 'session_title_updated')?.session).toEqual({ ...identity, title: 'Main session', revision });
  await f.restart();
  const restored = await listen();
  await expect.poll(() => restored.messages.find(message => message.type === 'session_title_updated')?.session).toEqual({ ...identity, title: 'Main session', revision });
  expect((await f.json(alice.basePath + `v1/remote/hosts/${hostId}/revoke`, alice.cookie, {})).status).toBe(200);
  await f.restart();
  const revoked = await listen();
  await expect.poll(() => revoked.messages.some(message => message.type === 'ready')).toBe(true);
  expect(revoked.messages.some(message => message.type === 'session_title_updated')).toBe(false);
}, 30000);

it('authorizes an unstarred shared session by its native binding and hides titles after sharing is revoked', async () => {
  const f = await fixture(); const alice = await f.login('alice'); const bob = await f.login('bob');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const { socket: host, hostId } = await f.host(pairing.key, false, undefined, true);
  let renames = 0;
  host.addEventListener('message', message => {
    const frame = JSON.parse(String(message.data)); if (frame.type !== 'rpc_request') return;
    const input = JSON.parse(frame.body ?? '{}');
    if (frame.path === '/remote/session/rename') renames++;
    send(host, { type: 'rpc_response', requestId: frame.requestId, status: 200, body: JSON.stringify(frame.path === '/remote/create'
      ? { agentId: frame.sessionId, nativeSessionId: 'bob-native' } : { title: input.title }) });
  });
  expect((await f.control({ subject: 'alice', operation: 'share', hostId, targetSubject: 'bob', targetLabel: 'Bob', sessionLimit: 1 })()).status).toBe(200);
  const route = bob.basePath + `v1/remote/hosts/${hostId}/`;
  const payload = { providerId: 'codex', nativeSessionId: 'alice-private', title: 'Forbidden', operationId: 'forbidden-title' };
  expect((await f.json(route + 'session/rename', bob.cookie, payload)).status).toBe(403);
  expect(renames).toBe(0);
  expect((await f.json(route + 'create', bob.cookie, { providerId: 'codex', operationId: 'create-bob-session' })).status).toBe(200);
  const messages: any[] = [];
  const socket = await f.upgrade(bob.basePath + 'v1/session-channel?observation=session&titles=1', { cookie: bob.cookie, origin });
  socket.addEventListener('message', event => messages.push(JSON.parse(String(event.data))));
  expect((await f.json(route + 'session/rename', bob.cookie, { ...payload, nativeSessionId: 'bob-native', title: 'Bob session', operationId: 'bob-title' })).status).toBe(200);
  await expect.poll(() => messages.find(message => message.type === 'session_title_updated')?.session.title).toBe('Bob session');
  expect((await (await f.json(bob.basePath + 'v1/favorites', bob.cookie)).json() as any).stars).toEqual([]);
  expect((await f.json(bob.basePath + 'v1/stars', bob.cookie, { hostId, providerId: 'codex', nativeSessionId: 'bob-native', title: 'Bob session' })).status).toBe(200);
  expect((await f.control({ subject: 'alice', operation: 'revoke-share', hostId, targetSubject: 'bob' })()).status).toBe(200);
  expect((await f.json(route + 'session/rename', bob.cookie, { ...payload, nativeSessionId: 'bob-native' })).status).toBe(404);
  expect((await f.json(alice.basePath + `v1/remote/hosts/${hostId}/session/rename`, alice.cookie,
    { ...payload, nativeSessionId: 'bob-native', title: 'Private new name', operationId: 'private-title' })).status).toBe(200);
  expect((await (await f.json(bob.basePath + 'v1/favorites', bob.cookie)).json() as any).stars[0]).toMatchObject({ title: 'Bob session', available: false });
  expect(messages.filter(message => message.type === 'session_title_updated' && message.session.title === 'Private new name')).toEqual([]);
  const after: any[] = [];
  const reconnected = await f.upgrade(bob.basePath + 'v1/session-channel?observation=session&titles=1', { cookie: bob.cookie, origin });
  reconnected.addEventListener('message', event => after.push(JSON.parse(String(event.data))));
  await expect.poll(() => after.some(message => message.type === 'ready')).toBe(true);
  expect(after.some(message => message.type === 'session_title_updated')).toBe(false);
}, 30000);

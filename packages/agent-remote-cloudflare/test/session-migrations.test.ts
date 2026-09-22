import { expect, it } from 'vitest';
import { event, fixture, origin, send } from './fixture.js';

it('commits a prompt fork with favorites, broadcasts to both devices and replays after Worker restart', async () => {
  const f = await fixture();
  const alice = await f.login('alice'); const second = await f.login('alice'); const bob = await f.login('bob');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const { socket: host, hostId } = await f.host(pairing.key, true);
  let creations = 0;
  host.addEventListener('message', message => {
    const frame = JSON.parse(String(message.data));
    if (frame.type !== 'rpc_request') return;
    const input = JSON.parse(frame.body ?? '{}');
    if (frame.path === '/remote/create') { creations++; expect(input).toMatchObject({ editNativeSessionId: 'old', editTurnId: 'turn', editMessageId: 'message' }); }
    send(host, { type: 'rpc_response', requestId: frame.requestId, status: 200,
      body: JSON.stringify({ agentId: frame.sessionId, nativeSessionId: frame.path === '/remote/create' ? 'new' : input.nativeSessionId }) });
  });
  const path = alice.basePath + `v1/remote/hosts/${hostId}/`;
  const attached = await (await f.json(path + 'attach', alice.cookie, { providerId: 'codex', nativeSessionId: 'old' })).json() as { agentId: string };
  const original = { hostId, providerId: 'codex', nativeSessionId: 'old' };
  expect((await f.json(alice.basePath + 'v1/stars', alice.cookie, { ...original, title: 'Keep this name' })).status).toBe(200);
  const channels = [];
  const received: any[][] = [[], [], []];
  for (const [index, account] of [alice, second, bob].entries()) {
    const socket = await f.upgrade(account.basePath + 'v1/session-channel?observation=session&migrations=1', { cookie: account.cookie, origin });
    expect(await event(socket, 'message')).toMatchObject({ type: 'ready' });
    socket.addEventListener('message', message => received[index]!.push(JSON.parse(String(message.data)))); channels.push(socket);
  }
  const input = { providerId: 'codex', operationId: 'edit-1', editNativeSessionId: 'old', editTurnId: 'turn', editMessageId: 'message' };
  const response = await f.json(path + 'create', alice.cookie, input); expect(response.status).toBe(200);
  const target = await response.json() as { agentId: string };
  for (const index of [0, 1]) await expect.poll(() => received[index]!.filter(item => item.type === 'session_migrated').length).toBe(1);
  expect(received[0]![0]).toMatchObject({ migration: { id: 'edit-1', from: { ...original, agentId: attached.agentId }, to: { nativeSessionId: 'new', agentId: target.agentId } } });
  expect(received[2]).toEqual([]);
  expect(await (await f.json(alice.basePath + 'v1/stars', second.cookie)).json()).toMatchObject({ stars: [{ title: 'Keep this name', nativeSessionId: 'new' }] });
  expect(await (await f.json(bob.basePath + 'v1/session-migrations', bob.cookie)).json()).toEqual({ migrations: [] });
  expect((await f.json(path + 'create', second.cookie, input)).status).toBe(200); expect(creations).toBe(1);
  expect((await f.json(path + 'create', second.cookie, { ...input, operationId: 'competing-edit' })).status).toBe(409);
  expect(creations).toBe(1);
  await f.restart();
  expect(await (await f.json(alice.basePath + 'v1/session-migrations', second.cookie)).json()).toMatchObject({ migrations: [{ id: 'edit-1' }] });
  expect(await (await f.json(alice.basePath + 'v1/stars', second.cookie)).json()).toMatchObject({ stars: [{ nativeSessionId: 'new' }] });
  const replay = await f.upgrade(alice.basePath + 'v1/session-channel?observation=session&migrations=1', { cookie: second.cookie, origin });
  const replayed: any[] = [];
  replay.addEventListener('message', message => replayed.push(JSON.parse(String(message.data))));
  await expect.poll(() => replayed.some(item => item.type === 'session_migrated' && item.migration.id === 'edit-1')).toBe(true);
}, 30000);

it('rejects prompt editing on an older Host before sending a native create request', async () => {
  const f = await fixture(); const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const { socket: host, hostId } = await f.host(pairing.key);
  let creations = 0;
  host.addEventListener('message', message => {
    const frame = JSON.parse(String(message.data)); if (frame.type !== 'rpc_request') return;
    if (frame.path === '/remote/create') creations++;
    send(host, { type: 'rpc_response', requestId: frame.requestId, status: 200, body: JSON.stringify({ agentId: frame.sessionId, nativeSessionId: 'old' }) });
  });
  const path = alice.basePath + `v1/remote/hosts/${hostId}/`;
  expect((await f.json(path + 'attach', alice.cookie, { providerId: 'codex', nativeSessionId: 'old' })).status).toBe(200);
  const result = await f.json(path + 'create', alice.cookie, { providerId: 'codex', operationId: 'edit', editNativeSessionId: 'old', editTurnId: 'turn', editMessageId: 'message' });
  expect(result.status).toBe(400); expect(await result.json()).toMatchObject({ code: 'unsupported_configuration' }); expect(creations).toBe(0);
}, 30000);

import { expect, it } from 'vitest';
import { PROTOCOL_VERSION, decodeServerMessage } from '../../agent-remote-protocol/src/index.js';
import { event, fixture, origin, send } from './fixture.js';

it('rejects stale permission changes without closing the session and permits retry after sign-in', async () => {
  const f = await fixture(); const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as any;
  const host = await f.host(pairing.key);
  const forwarded: any[] = [];
  host.socket.addEventListener('message', message => {
    const frame = JSON.parse(String(message.data));
    if (frame.type === 'rpc_request') send(host.socket, { type: 'rpc_response', requestId: frame.requestId, status: 200, body: JSON.stringify({ agentId: 'permission-agent', nativeSessionId: 'permission-native' }) });
    if (frame.type === 'stream_open') {
      send(host.socket, { type: 'stream_opened', streamId: frame.streamId });
      send(host.socket, { type: 'stream_message', streamId: frame.streamId, message: '{"ready":true}' });
    }
    if (frame.type === 'stream_message') {
      const request = JSON.parse(frame.message); forwarded.push(request);
      send(host.socket, { type: 'stream_message', streamId: frame.streamId, message: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'command_acknowledged', payload: { requestId: request.payload.requestId, agentId: 'permission-agent', command: 'set_session_setting', accepted: true } }) });
    }
  });
  expect((await f.json(alice.basePath + `v1/remote/hosts/${host.hostId}/attach`, alice.cookie, { providerId: 'codex', nativeSessionId: 'permission-native' })).status).toBe(200);
  f.setAuthenticatedAt(Date.now() - 601_000);
  expect((await f.json('/auth/refresh', alice.cookie, {})).status).toBe(200);
  const path = alice.basePath + 'v1/sessions/permission-agent/events';
  const stream = await f.upgrade(path, { cookie: alice.cookie, origin }); await event(stream, 'message');
  const request = (settingId: string, requestId: string) => ({ protocolVersion: PROTOCOL_VERSION, type: 'set_session_setting', payload: { requestId, operationId: '00000000-0000-4000-8000-000000000001', agentId: 'permission-agent', settingId, value: 'next' } });
  for (const setting of ['sandbox', 'approval', 'permissions']) {
    const response = event(stream, 'message'); stream.send(JSON.stringify(request(setting, setting)));
    const denied = await response;
    expect(decodeServerMessage(JSON.stringify(denied)).status).toBe('ok');
    expect(denied).toMatchObject({ type: 'protocol_error', payload: { requestId: setting, code: 'reauthentication_required', recoverable: true } });
    expect(stream.readyState).toBe(1);
  }
  expect(forwarded).toEqual([]);
  const model = event(stream, 'message'); stream.send(JSON.stringify(request('model', 'model')));
  expect((await model).type).toBe('command_acknowledged');
  expect(forwarded).toHaveLength(1);
  f.setAuthenticatedAt(Date.now());
  const renewed = await f.login('alice');
  const fresh = await f.upgrade(path, { cookie: renewed.cookie, origin }); await event(fresh, 'message');
  expect(forwarded).toHaveLength(1);
  const changed = event(fresh, 'message'); fresh.send(JSON.stringify(request('sandbox', 'retry')));
  expect((await changed).payload.requestId).toBe('retry');
  expect(forwarded).toHaveLength(2);
  expect(host.socket.readyState).toBe(1);
}, 30000);

it('isolates browser management, closes revoked live streams, and persists redacted audit after replacement', async () => {
  const f = await fixture(); const alice = await f.login('alice'); const another = await f.login('alice'); const bob = await f.login('bob');
  const list = async (cookie: string) => (await (await f.json('/auth/sessions', cookie)).json() as any).sessions;
  const sessions = await list(alice.cookie); expect(sessions).toHaveLength(2);
  expect(sessions.filter((session: any) => session.current)).toHaveLength(1);
  const otherId = sessions.find((session: any) => !session.current).id;
  expect((await f.json('/auth/sessions/revoke', bob.cookie, { id: otherId })).status).toBe(404);
  expect((await f.request('/auth/sessions/revoke', { method: 'POST', headers: { cookie: alice.cookie, origin: 'https://foreign.example', 'content-type': 'application/json' }, body: JSON.stringify({ id: otherId }) })).status).toBe(403);
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as any;
  const host = await f.host(pairing.key);
  host.socket.addEventListener('message', message => {
    const data = JSON.parse(String(message.data));
    if (data.type === 'rpc_request') send(host.socket, { type: 'rpc_response', requestId: data.requestId, status: 200, body: JSON.stringify({ agentId: 'managed-agent', nativeSessionId: 'managed-native' }) });
    if (data.type === 'stream_open') { send(host.socket, { type: 'stream_opened', streamId: data.streamId }); send(host.socket, { type: 'stream_message', streamId: data.streamId, message: '{"ready":true}' }); }
  });
  expect((await f.json(alice.basePath + `v1/remote/hosts/${host.hostId}/attach`, alice.cookie, { providerId: 'codex', nativeSessionId: 'managed-native' })).status).toBe(200);
  const stream = await f.upgrade(alice.basePath + 'v1/sessions/managed-agent/events', { cookie: another.cookie, origin }); await event(stream, 'message');
  const closed = event(stream, 'close');
  expect(await (await f.json('/auth/sessions/revoke', alice.cookie, { id: otherId })).json()).toEqual({ ok: true, current: false });
  expect((await closed).code).toBe(1008); expect(host.socket.readyState).toBe(1);
  expect((await f.json('/auth/status', another.cookie)).status).toBe(401);
  expect((await f.json(alice.basePath + 'v1/remote/hosts/' + 'x'.repeat(513) + '/stop', alice.cookie, {})).status).toBe(404);
  const audit = await (await f.json('/auth/audit', alice.cookie)).json() as any;
  expect(audit.events.some((item: any) => item.action === 'session_revoked')).toBe(true);
  for (const text of [JSON.stringify(sessions), JSON.stringify(audit)]) {
    expect(text).not.toContain(alice.cookie.split('=')[1]); expect(text).not.toContain(pairing.key); expect(text).not.toContain(host.key); expect(text).not.toContain('"subject"');
  }
  await f.restart();
  expect((await list(alice.cookie))).toHaveLength(1);
  expect(await (await f.json('/auth/audit', alice.cookie)).json()).toEqual(audit);
  expect((await (await f.json('/auth/audit', bob.cookie)).json() as any).events.every((item: any) => item.action === 'signed_in')).toBe(true);
  expect((await f.json('/auth/sessions/revoke-all', alice.cookie, {})).status).toBe(200);
  expect((await f.json('/auth/status', alice.cookie)).status).toBe(401);
  expect((await f.json('/auth/status', bob.cookie)).status).toBe(200);
}, 30000);

it('requires actual fresh authentication for pairing and rotation while permitting emergency revocation', async () => {
  const f = await fixture(); const alice = await f.login('alice');
  const pair = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as any;
  const host = await f.host(pair.key);
  const offer = event(host.socket, 'message');
  expect((await f.json(alice.basePath + `v1/remote/hosts/${host.hostId}/rotate`, alice.cookie, {})).status).toBe(200);
  const issued = await offer; expect(issued.type).toBe('credential_issued');
  // A saved offer remains valid even if the process stops before sending its acknowledgement.
  await f.restart(); const recovered = await f.host(issued.credential); expect(recovered.hostId).toBe(host.hostId);
  expect((await f.request('/ws/remote-host', { headers: { upgrade: 'websocket', authorization: `Bearer ${host.key}` } })).status).toBe(401);
  f.setAuthenticatedAt(Date.now() - 601_000);
  expect((await f.json('/auth/refresh', alice.cookie, {})).status).toBe(200);
  const status = await (await f.json('/auth/sessions', alice.cookie)).json() as any; expect(status.recentAuthentication).toBe(false);
  for (const path of ['v1/remote/pairings', `v1/remote/hosts/${host.hostId}/rotate`]) {
    const response = await f.json(alice.basePath + path, alice.cookie, {});
    expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ code: 'reauthentication_required' });
  }
  const target = '?reauthenticate=1&host=desk&provider=claude&session=topic';
  const login = await f.request('/auth/login' + target);
  expect(new URL(login.headers.get('location')!).searchParams.get('reauthenticate')).toBe('1');
  const closed = event(recovered.socket, 'close');
  expect((await f.json(alice.basePath + `v1/remote/hosts/${host.hostId}/revoke`, alice.cookie, {})).status).toBe(200);
  expect((await closed).code).toBe(1008);
  expect((await f.json('/auth/sessions/revoke-all', alice.cookie, {})).status).toBe(200);
}, 30000);

it('bounds renewal before authority calls and pairing invitations per user', async () => {
  const f = await fixture(); const alice = await f.login('alice');
  expect((await f.request('/auth/refresh', { method: 'POST', headers: { origin, cookie: alice.cookie }, body: '{}' })).status).toBe(415);
  for (let i = 0; i < 30; i++) expect((await f.json('/auth/refresh', alice.cookie, {})).status).toBe(200);
  const before = f.authorityCalls;
  expect((await f.json('/auth/refresh', alice.cookie, {})).status).toBe(429); expect(f.authorityCalls).toBe(before);
  for (let i = 0; i < 5; i++) expect((await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).status).toBe(201);
  expect((await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).status).toBe(429);
  expect((await f.json('/auth/logout', alice.cookie, {})).status).toBe(200);
}, 30000);

it('shares one per-user stream allowance across different Host owners and releases closed streams', async () => {
  const f = await fixture(); const alice = await f.login('alice'); const charlie = await f.login('charlie'); const bob = await f.login('bob');
  const paths: string[] = [];
  for (const [index, owner] of [alice, charlie].entries()) {
    const pair = await (await f.json(owner.basePath + 'v1/remote/pairings', owner.cookie, {})).json() as any;
    const host = await f.host(pair.key);
    host.socket.addEventListener('message', message => {
      const data = JSON.parse(String(message.data));
      if (data.type === 'rpc_request') send(host.socket, { type: 'rpc_response', requestId: data.requestId, status: 200, body: JSON.stringify({ agentId: `quota-agent-${index}`, nativeSessionId: `quota-native-${index}` }) });
      if (data.type === 'stream_open') { send(host.socket, { type: 'stream_opened', streamId: data.streamId }); send(host.socket, { type: 'stream_message', streamId: data.streamId, message: '{"ready":true}' }); }
    });
    expect((await f.control({ subject: index === 0 ? 'alice' : 'charlie', operation: 'share', hostId: host.hostId, targetSubject: 'bob', targetLabel: 'Bob', sessionLimit: 1 })()).status).toBe(200);
    const operationId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    expect((await f.json(bob.basePath + `v1/remote/hosts/${host.hostId}/create`, bob.cookie, { providerId: 'codex', operationId })).status).toBe(200);
    paths.push(bob.basePath + `v1/sessions/quota-agent-${index}/events`);
  }
  const sockets = [];
  for (let i = 0; i < 32; i++) { const socket = await f.upgrade(paths[i % 2]!, { origin, cookie: bob.cookie }); await event(socket, 'message'); sockets.push(socket); }
  expect((await f.request(paths[1]!, { headers: { upgrade: 'websocket', origin, cookie: bob.cookie } })).status).toBe(429);
  const released = event(sockets[0]!, 'close'); sockets[0]!.close(); await released;
  const next = await f.upgrade(paths[1]!, { origin, cookie: bob.cookie }); await event(next, 'message');
}, 30000);

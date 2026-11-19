import { expect, it } from 'vitest';
import { PROTOCOL_VERSION, decodeServerMessage } from '@orchardworks/agent-remote-protocol';
import { event, fixture, origin, send } from './fixture.js';

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


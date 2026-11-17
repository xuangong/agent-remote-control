import { expect, it } from 'vitest';
import { decodeRemoteHostUplinkMessage } from '../../agent-remote-protocol/src/index.js';
import { fixture, send } from './fixture.js';

it('forwards validated daemon control only for the owner and an advertising Host', async () => {
  const f = await fixture(); const alice = await f.login('alice'), bob = await f.login('bob');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const host = await f.host(pairing.key, false, undefined, false, true);
  const rpc: any[] = [];
  const revision = '00000000-0000-4000-8000-000000000001', operationId = '00000000-0000-4000-8000-000000000002';
  host.socket.addEventListener('message', event => {
    const request = JSON.parse(String(event.data)); if (request.type !== 'rpc_request' || request.path !== '/remote/codex-daemon') return;
    expect(decodeRemoteHostUplinkMessage(String(event.data)).status).toBe('ok'); rpc.push(request);
    send(host.socket, { type: 'rpc_response', requestId: request.requestId, status: request.method === 'POST' ? 202 : 200,
      body: JSON.stringify({ revision, phase: request.method === 'POST' ? 'restarting' : 'idle', updatedAt: 0 }) });
  });
  const path = alice.basePath + `v1/remote/hosts/${host.hostId}/codex-daemon`;
  expect((await f.json(path, alice.cookie)).status).toBe(200);
  expect((await f.json(path, alice.cookie, { operationId, revision })).status).toBe(202);
  expect(rpc).toHaveLength(2);
  expect(rpc[1]).toMatchObject({ method: 'POST', path: '/remote/codex-daemon', body: JSON.stringify({ operationId, revision }) });
  expect(rpc[1].sessionId).toBeUndefined();
  expect((await f.json(path, alice.cookie, { operationId, revision, command: 'stop' })).status).toBe(400);
  expect((await f.request(path, { method: 'POST', headers: { cookie: alice.cookie, origin: 'https://foreign.example', 'content-type': 'application/json' }, body: JSON.stringify({ operationId, revision }) })).status).toBe(403);
  expect((await f.control({ subject: 'alice', operation: 'share', hostId: host.hostId, targetSubject: 'bob', targetLabel: 'Bob', sessionLimit: 1 })()).status).toBe(200);
  const shared = bob.basePath + `v1/remote/hosts/${host.hostId}/codex-daemon`;
  expect((await f.json(shared, bob.cookie, { operationId, revision })).status).toBe(403);
  expect((await f.json(shared, bob.cookie)).status).toBe(403);
  expect(rpc).toHaveLength(2);
  // Reconnect without the capability, as an older Controller would.
  host.socket.close();
  const old = await f.host(host.key);
  expect(old.hostId).toBe(host.hostId);
  expect((await f.json(path, alice.cookie, { operationId, revision })).status).toBe(400);
  expect(rpc).toHaveLength(2);
}, 30000);

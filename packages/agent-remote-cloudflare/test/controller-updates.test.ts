import { expect, it } from 'vitest';
import { fixture, send } from './fixture.js';
it.each(['linux', 'win32'])('persists %s Host versions and restricts upgrade RPC to the owner over real Worker HTTP and WebSocket', async platform => {
  const release = { protocolVersion: '1.5.0', version: '0.2.0', revision: 'a'.repeat(40), sha256: 'b'.repeat(64), asset: 'orchardworks-agent-remote-controller-0.2.0.tgz', nodeMajor: 22, platforms: [`${platform}-x64`] };
  const f = await fixture({ controllerRelease: release });
  const alice = await f.login('alice'), bob = await f.login('bob');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const identity = { version: '0.1.0', revision: 'c'.repeat(40), platform, arch: 'x64', nodeMajor: 22, remoteUpdate: true };
  const host = await f.host(pairing.key, false, identity);
  const rpc: any[] = [];
  host.socket.addEventListener('message', event => { const request = JSON.parse(String(event.data)); if (request.type !== 'rpc_request') return;
    rpc.push(request); send(host.socket, { type: 'rpc_response', requestId: request.requestId, status: request.method === 'POST' ? 202 : 200,
      body: JSON.stringify({ phase: 'waiting', version: '0.2.0', operationId: 'update-one', updatedAt: Date.now() }) }); });
  const path = alice.basePath + `v1/remote/hosts/${host.hostId}/controller-update`;
  expect(await (await f.json(alice.basePath + 'v1/remote/controller-release', alice.cookie)).json()).toEqual({ release });
  expect((await f.json(path, alice.cookie, { version: '0.2.0', operationId: 'update-one' })).status).toBe(202);
  expect(rpc[0]).toMatchObject({ method: 'POST', path: '/remote/controller-update', body: JSON.stringify({ version: '0.2.0', operationId: 'update-one' }) });
  expect((await f.json(path, alice.cookie, { version: '99.0.0', operationId: 'update-two' })).status).toBe(409);
  expect((await f.control({ subject: 'alice', operation: 'share', hostId: host.hostId, targetSubject: 'bob', targetLabel: 'Bob', sessionLimit: 1 })()).status).toBe(200);
  const sharedDenied = await f.json(bob.basePath + `v1/remote/hosts/${host.hostId}/controller-update`, bob.cookie, { version: '0.2.0', operationId: 'shared-update' });
  expect(sharedDenied.status).toBe(403);
  const denied = await f.json(path, bob.cookie, { version: '0.2.0', operationId: 'update-two' });
  expect(denied.status).toBeGreaterThanOrEqual(400); expect(rpc).toHaveLength(1);
  const hosts = await (await f.json(alice.basePath + 'v1/remote/hosts', alice.cookie)).json() as any;
  expect(hosts.hosts[0].controller).toEqual(identity);
  await f.restart();
  expect(await (await f.json(alice.basePath + 'v1/remote/hosts', alice.cookie)).json()).toMatchObject({ hosts: [{ controller: identity, online: false }] });
}, 30000);

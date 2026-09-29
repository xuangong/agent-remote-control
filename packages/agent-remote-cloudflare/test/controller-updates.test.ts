import { expect, it } from 'vitest';
import { fixture, send } from './fixture.js';
it.each(['linux', 'win32'])('persists %s Host versions and restricts upgrade RPC to the owner over real Worker HTTP and WebSocket', async platform => {
  const release = { protocolVersion: '1.6.0', version: '0.2.0', revision: 'a'.repeat(40), sha256: 'b'.repeat(64), asset: 'orchardworks-agent-remote-controller-0.2.0.tgz', nodeMajor: 22, platforms: [`${platform}-x64`] };
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
  const next = { ...release, version: '0.3.0', asset: 'orchardworks-agent-remote-controller-0.3.0.tgz' };
  Object.assign(release, next);
  expect(await (await f.json(alice.basePath + 'v1/remote/controller-release', alice.cookie)).json()).toMatchObject({ release: { version: '0.2.0' } });
  expect(await (await f.json(alice.basePath + 'v1/remote/controller-release?refresh=1', alice.cookie)).json()).toEqual({ release: next });
  await f.restart();
  expect(await (await f.json(alice.basePath + 'v1/remote/hosts', alice.cookie)).json()).toMatchObject({ hosts: [{ controller: identity, online: false }] });
}, 30000);

it('routes only the verified bridge to a legacy Host and continues after its identity changes', async () => {
  const release = { protocolVersion: '1.6.0', version: '0.2.33', revision: 'a'.repeat(40), sha256: 'b'.repeat(64), asset: 'orchardworks-agent-remote-controller-0.2.33.tgz', nodeMajor: 22, platforms: ['win32-x64'] };
  const bridge = { ...release, protocolVersion: '1.5.0', version: '0.2.32', asset: 'orchardworks-agent-remote-controller-0.2.32.tgz' };
  const f = await fixture({ controllerRelease: release, controllerBridge: bridge });
  const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const identity = { version: '0.2.30', revision: 'c'.repeat(40), platform: 'win32', arch: 'x64', nodeMajor: 22, remoteUpdate: true };
  const host = await f.host(pairing.key, false, identity);
  const rpc: any[] = [];
  host.socket.addEventListener('message', event => { const request = JSON.parse(String(event.data)); if (request.type !== 'rpc_request') return;
    rpc.push(request); send(host.socket, { type: 'rpc_response', requestId: request.requestId, status: 202,
      body: JSON.stringify({ phase: 'downloading', ...JSON.parse(request.body), updatedAt: Date.now() }) }); });
  const path = alice.basePath + `v1/remote/hosts/${host.hostId}/controller-update`;
  expect(await (await f.json(alice.basePath + 'v1/remote/controller-release', alice.cookie)).json()).toEqual({ release, bridgeRelease: bridge });
  expect((await f.json(path, alice.cookie, { version: release.version, operationId: 'skip-bridge' })).status).toBe(409);
  expect((await f.json(path, alice.cookie, { version: bridge.version, operationId: 'install-bridge' })).status).toBe(202);
  expect(JSON.parse(rpc[0].body).version).toBe(bridge.version);
  // The running Host, not a browser claim, is authoritative for the next step.
  host.socket.close();
  const updated = await f.host(host.key, false, { ...identity, version: bridge.version });
  expect(updated.hostId).toBe(host.hostId);
  updated.socket.addEventListener('message', event => { const request = JSON.parse(String(event.data)); if (request.type !== 'rpc_request') return;
    rpc.push(request); send(updated.socket, { type: 'rpc_response', requestId: request.requestId, status: 202,
      body: JSON.stringify({ phase: 'downloading', ...JSON.parse(request.body), updatedAt: Date.now() }) }); });
  await expect.poll(async () => (await (await f.json(alice.basePath + 'v1/remote/hosts', alice.cookie)).json() as any).hosts[0].controller.version).toBe(bridge.version);
  expect((await f.json(path, alice.cookie, { version: release.version, operationId: 'install-final' })).status).toBe(202);
  expect(JSON.parse(rpc[1].body).version).toBe(release.version);
}, 30000);

it('reports an unavailable bridge without hiding the final release or forwarding an unsafe update', async () => {
  const release = { protocolVersion: '1.6.0', version: '0.2.33', revision: 'a'.repeat(40), sha256: 'b'.repeat(64), asset: 'orchardworks-agent-remote-controller-0.2.33.tgz', nodeMajor: 22, platforms: ['linux-x64'] };
  const f = await fixture({ controllerRelease: release });
  const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const host = await f.host(pairing.key, false, { version: '0.2.30', revision: 'c'.repeat(40), platform: 'linux', arch: 'x64', nodeMajor: 22, remoteUpdate: true });
  const rpc: unknown[] = [];
  host.socket.addEventListener('message', event => { const request = JSON.parse(String(event.data)); if (request.type === 'rpc_request') rpc.push(request); });
  expect(await (await f.json(alice.basePath + 'v1/remote/controller-release', alice.cookie)).json()).toEqual({ release, bridgeError: expect.stringContaining('upgrade component') });
  const result = await f.json(alice.basePath + `v1/remote/hosts/${host.hostId}/controller-update`, alice.cookie, { version: release.version, operationId: 'unsafe-update' });
  expect(result.status).toBeGreaterThanOrEqual(400);
  expect(rpc).toHaveLength(0);
}, 30000);

it.each(['0.2.29', '0.2.30'])('allows %s to install a staged bridge while the final release is disabled', async version => {
  const release = { protocolVersion: '1.5.0', version: '0.2.32', revision: 'a'.repeat(40), sha256: 'b'.repeat(64), asset: 'orchardworks-agent-remote-controller-0.2.32.tgz', nodeMajor: 22, platforms: ['win32-x64'] };
  const f = await fixture({ controllerRelease: release });
  const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const host = await f.host(pairing.key, false, { version, revision: 'c'.repeat(40), platform: 'win32', arch: 'x64', nodeMajor: 22, remoteUpdate: true });
  const rpc: any[] = [];
  host.socket.addEventListener('message', event => { const request = JSON.parse(String(event.data)); if (request.type !== 'rpc_request') return;
    rpc.push(request); send(host.socket, { type: 'rpc_response', requestId: request.requestId, status: 202,
      body: JSON.stringify({ phase: 'downloading', ...JSON.parse(request.body), updatedAt: Date.now() }) }); });
  const path = alice.basePath + `v1/remote/hosts/${host.hostId}/controller-update`;
  expect(await (await f.json(alice.basePath + 'v1/remote/controller-release', alice.cookie)).json()).toEqual({ release });
  expect((await f.json(path, alice.cookie, { version: '0.2.33', operationId: 'disabled-final' })).status).toBe(409);
  expect((await f.json(path, alice.cookie, { version: release.version, operationId: 'install-staged' })).status).toBe(202);
  expect(rpc).toHaveLength(1);
  expect(JSON.parse(rpc[0].body).version).toBe('0.2.32');
}, 30000);

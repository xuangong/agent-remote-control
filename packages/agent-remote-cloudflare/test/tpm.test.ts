import { expect, it } from 'vitest';
import { fixture, send } from './fixture.js';

it('limits TPM Host management to its owner across account namespaces and shared access', async () => {
  const f = await fixture(); const alice = await f.login('alice'), bob = await f.login('bob');
  const { key } = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const host = await f.host(key, false, undefined, false, false, 'codex', 'workers-host', true); const calls: any[] = [];
  host.socket.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data)); if (frame.type !== 'rpc_request' || !frame.path.startsWith('/remote/tpm')) return;
    calls.push(frame);
    send(host.socket, { type: 'rpc_response', requestId: frame.requestId, status: 200,
      body: JSON.stringify({ supported: true, works: [] }) });
  });
  const path = `v1/remote/hosts/${host.hostId}/tpm`;
  expect((await f.json(alice.basePath + path, alice.cookie)).status).toBe(200);
  expect([403, 404]).toContain((await f.json(bob.basePath + path, bob.cookie)).status);
  expect((await f.json(alice.basePath + path, bob.cookie)).status).toBe(403);
  expect((await f.control({ subject: 'alice', operation: 'share', hostId: host.hostId, targetSubject: 'bob', targetLabel: 'Bob', sessionLimit: 1 })()).status).toBe(200);
  expect((await f.json(bob.basePath + path, bob.cookie)).status).toBe(403);
  const create = { providerId: 'codex', mainNativeSessionId: 'main', title: 'Delivery', requirement: 'Ship', operationId: crypto.randomUUID() };
  expect((await f.json(bob.basePath + path + '/create', bob.cookie, create)).status).toBe(403);
  expect(calls).toHaveLength(1);
}, 30000);

it('keeps an older Controller uplink connected without probing unsupported TPM routes', async () => {
  const f = await fixture(); const owner = await f.login('alice');
  const { key } = await (await f.json(owner.basePath + 'v1/remote/pairings', owner.cookie, {})).json() as { key: string };
  const host = await f.host(key); const calls: any[] = [];
  host.socket.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data));
    if (frame.type === 'rpc_request') { calls.push(frame); host.socket.close(1008, 'Unsupported old Controller path'); }
  });
  const path = `v1/remote/hosts/${host.hostId}/tpm`;
  const list = await f.json(owner.basePath + path, owner.cookie);
  expect(list.status).toBe(200); expect(await list.json()).toEqual({ supported: false, supportedProviders: [], works: [] });
  const create = { providerId: 'codex', mainNativeSessionId: 'main', title: 'Delivery', requirement: 'Ship', operationId: crypto.randomUUID() };
  const mutation = await f.json(owner.basePath + path + '/create', owner.cookie, create);
  expect(mutation.status).toBe(409); expect(await mutation.json()).toEqual({ error: 'Update the Controller to use TPM.' });
  const hosts = await f.json(owner.basePath + 'v1/remote/hosts', owner.cookie);
  expect(hosts.status).toBe(200);
  expect((await hosts.json() as { hosts: Array<{ id: string; online: boolean }> }).hosts).toContainEqual(expect.objectContaining({ id: host.hostId, online: true }));
  expect(calls).toEqual([]); expect(host.socket.readyState).toBe(1);
}, 30000);

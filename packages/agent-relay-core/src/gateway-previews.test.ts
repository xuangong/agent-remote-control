import { expect, it } from 'vitest';
import type { PreviewRegistration } from '@orchardworks/agent-remote-tunnel';
import { send } from './test-utils/relay-harness.js';
import { world } from './test-utils/relay-world.js';

/** A Controller that has attached a session and published one active preview of `target`, with its tunnel connected. */
async function previewFixture(target = 'http://127.0.0.1:4173', ttlMs = 60_000, previewDomain?: string) {
  const f = await world({ relay: previewDomain ? { previewDomain } : {} });
  const alice = await f.signIn('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const host = await f.host(pairing.key);
  let revision = 0;
  let registration: PreviewRegistration | undefined;
  const publish = () => send(host.socket, {
    type: 'preview_snapshot',
    snapshot: { epoch: 'workers-controller', revision, registrations: registration ? [registration] : [] },
  });
  host.socket.addEventListener('message', message => {
    const request = JSON.parse(String(message.data));
    if (request.type !== 'rpc_request') return;
    if (request.path === '/remote/attach') {
      send(host.socket, { type: 'rpc_response', requestId: request.requestId, status: 200,
        body: JSON.stringify({ agentId: 'preview-agent', nativeSessionId: 'preview-native' }) });
      return;
    }
    if (request.path === '/remote/previews') {
      const body = JSON.parse(request.body);
      registration = { id: 'workers-preview', target: body.target, status: 'active', createdAt: Date.now(),
        expiresAt: Date.now() + ttlMs, revision: ++revision, pathMode: body.pathMode, sources: [body.source] };
    } else if (request.path === '/remote/previews/renew' && registration) {
      registration = { ...registration, expiresAt: Date.now() + ttlMs, revision: ++revision };
    } else if (request.path === '/remote/previews/unregister' && registration) {
      registration = { ...registration, status: 'unregistered', revision: ++revision };
    } else return;
    send(host.socket, { type: 'rpc_response', requestId: request.requestId, status: 200,
      body: JSON.stringify({ registration }) });
    publish();
  });
  const attached = await f.json(alice.basePath + `v1/remote/hosts/${host.hostId}/attach`, alice.cookie,
    { providerId: 'codex', nativeSessionId: 'preview-native' });
  expect(attached.status, await attached.clone().text()).toBe(200);
  const created = await f.json(alice.basePath + 'v1/sessions/preview-agent/previews', alice.cookie,
    { target, itemId: 'preview-item' });
  expect(created.status, await created.clone().text()).toBe(200);
  registration = (await created.json() as { registration: PreviewRegistration }).registration;
  return { f, alice, host, get registration() { return registration!; } };
}

it('persists preview snapshots and pending unregister intent across Durable Object replacement', async () => {
  const setup = await previewFixture();
  const saved = structuredClone(setup.registration);
  await setup.f.settled(async () => {
    const response = await setup.f.json(setup.alice.basePath + `v1/remote/hosts/${setup.host.hostId}/previews`, setup.alice.cookie);
    expect((await response.json() as any).registrations[0]?.id).toBe(saved.id);
  });
  await setup.f.restart();
  let previews = await setup.f.json(setup.alice.basePath + `v1/remote/hosts/${setup.host.hostId}/previews`, setup.alice.cookie);
  expect(previews.status).toBe(200);
  expect((await previews.json() as any).registrations[0]).toMatchObject({ id: saved.id, availability: 'controller_offline' });

  const pending = await setup.f.json(setup.alice.basePath + `v1/remote/hosts/${setup.host.hostId}/previews/${saved.id}/unregister`, setup.alice.cookie, {});
  expect(pending.status).toBe(200);
  await setup.f.restart();
  previews = await setup.f.json(setup.alice.basePath + `v1/remote/hosts/${setup.host.hostId}/previews`, setup.alice.cookie);
  expect((await previews.json() as any).registrations[0]).toMatchObject({ id: saved.id, pendingUnregister: true });

  const reconnected = await setup.f.host(setup.host.key);
  const removal = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Pending preview unregister was not reconciled')), 5000);
    reconnected.socket.addEventListener('message', message => {
      const request = JSON.parse(String(message.data));
      if (request.type !== 'rpc_request' || request.path !== '/remote/previews/unregister') return;
      clearTimeout(timer);
      send(reconnected.socket, { type: 'rpc_response', requestId: request.requestId, status: 200,
        body: JSON.stringify({ registration: { ...saved, status: 'unregistered', revision: saved.revision + 2 } }) });
      resolve();
    });
  });
  send(reconnected.socket, { type: 'preview_snapshot', snapshot: {
    epoch: 'workers-controller', revision: saved.revision + 1, registrations: [{ ...saved, revision: saved.revision + 1 }],
  } });
  await removal;
  const reopened = await setup.f.json(setup.alice.basePath + `v1/remote/hosts/${setup.host.hostId}/previews/${saved.id}/open`, setup.alice.cookie,
    { url: saved.target + '/bytes' });
  expect(reopened.status).toBe(503);
});

it('keeps a pinned name after history pruning and durable restart with a new Controller registration', async () => {
  const setup = await previewFixture('http://127.0.0.1:4173/docs', 60_000, 'preview.example.test');
  const path = setup.alice.basePath + `v1/remote/hosts/${setup.host.hostId}/previews`;
  const snapshot = async () => (await (await setup.f.json(path, setup.alice.cookie)).json() as any);
  const original = (await snapshot()).registrations[0];
  expect(original.tunnelOrigin).toMatch(/^https:\/\//);
  expect((await setup.f.json(`${path}/${original.id}/pin`, setup.alice.cookie, { pinned: true })).status).toBe(200);
  send(setup.host.socket, { type: 'preview_snapshot', snapshot: {
    epoch: 'workers-controller', revision: setup.registration.revision + 1, registrations: [],
  } });
  await setup.f.settled(async () => expect((await snapshot()).registrations).toEqual([]));
  await setup.f.restart();
  const reconnected = await setup.f.host(setup.host.key);
  send(reconnected.socket, { type: 'preview_snapshot', snapshot: {
    epoch: 'restarted-controller', revision: 1, registrations: [{ ...setup.registration,
      id: 'new-controller-preview', target: 'http://localhost:4173/another-path', revision: 1 }],
  } });
  await setup.f.settled(async () => expect((await snapshot()).registrations).toEqual([
    expect.objectContaining({ id: 'new-controller-preview', tunnelOrigin: original.tunnelOrigin, tunnelNamePinned: true }),
  ]));
});

it('persists owner unpin of an inactive name while the Controller stays disconnected', async () => {
  const setup = await previewFixture('http://127.0.0.1:4173', 60_000, 'preview.example.test');
  const path = setup.alice.basePath + `v1/remote/hosts/${setup.host.hostId}/previews`;
  const snapshot = async () => await (await setup.f.json(path, setup.alice.cookie)).json() as any;
  const original = (await snapshot()).registrations[0];
  expect((await setup.f.json(`${path}/${original.id}/pin`, setup.alice.cookie, { pinned: true })).status).toBe(200);
  send(setup.host.socket, { type: 'preview_snapshot', snapshot: {
    epoch: 'workers-controller', revision: setup.registration.revision + 1, registrations: [],
  } });
  await setup.f.settled(async () => expect((await snapshot()).registrations).toEqual([]));
  await setup.f.restart();
  expect((await snapshot()).pinnedNames).toEqual([{ nameId: original.id, target: original.target, tunnelOrigin: original.tunnelOrigin }]);
  expect((await setup.f.json(`${path}/pins/${original.id}/unpin`, setup.alice.cookie, {})).status).toBe(200);
  expect((await snapshot()).pinnedNames).toEqual([]);
  await setup.f.restart();
  expect((await snapshot()).pinnedNames).toEqual([]);
  const reconnected = await setup.f.host(setup.host.key);
  send(reconnected.socket, { type: 'preview_snapshot', snapshot: {
    epoch: 'restarted-controller', revision: 1, registrations: [{ ...setup.registration, id: 'fresh-preview', revision: 1 }],
  } });
  await setup.f.settled(async () => {
    const next = (await snapshot()).registrations[0];
    expect(next?.id).toBe('fresh-preview');
    expect(next?.tunnelNamePinned).toBe(false);
    expect(next?.tunnelOrigin).toBeTruthy();
    expect(next?.tunnelOrigin).not.toBe(original.tunnelOrigin);
  });
});

it('returns only active previews from mixed Controller history, including after durable recovery', async () => {
  const setup = await previewFixture();
  const active = setup.registration;
  send(setup.host.socket, { type: 'preview_snapshot', snapshot: {
    epoch: 'workers-controller', revision: active.revision + 1,
    registrations: [active, { ...active, id: 'expired-preview', status: 'expired' },
      { ...active, id: 'removed-preview', status: 'unregistered' }],
  } });
  const path = setup.alice.basePath + `v1/remote/hosts/${setup.host.hostId}/previews`;
  await setup.f.settled(async () => {
    const response = await setup.f.json(path, setup.alice.cookie);
    expect(response.status).toBe(200);
    const snapshot = await response.json() as any;
    expect(snapshot.revision).toBe(active.revision + 1);
    expect(snapshot.registrations).toEqual([expect.objectContaining({ id: active.id, status: 'active' })]);
  });
  await setup.f.restart();
  const restored = await setup.f.json(path, setup.alice.cookie);
  expect((await restored.json() as any).registrations).toEqual([
    expect.objectContaining({ id: active.id, status: 'active', availability: 'controller_offline' }),
  ]);
  expect((await setup.f.json(path + '/removed-preview/renew', setup.alice.cookie, {})).status).toBe(409);
});

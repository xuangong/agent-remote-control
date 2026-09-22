// @vitest-environment node
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { expect, it, vi } from 'vitest';
import { onPreviewCleanup, previewFixture } from './preview-tunnel-fixture.js';

it('serves root HTTP and WebSocket traffic with browser-bound entry and revokes it on unregister', async () => {
  const f = await previewFixture({ previewDomain: 'arc.test' });
  const entry = new URL(await f.entryUrl('/docs?q=1#part'));
  expect(entry.hostname).toMatch(/^[a-z]+-[a-z]+-[a-f0-9]{12}\.arc\.test$/);
  const target = entry.origin;
  const post = (url: string, body: unknown, cookie = '', origin = target) => f.fetch(url, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const challenge = await post(target + '/_arc/challenge', { path: '/docs?q=1#part' }, '', f.url);
  expect(challenge.status, await challenge.clone().text()).toBe(200);
  const browserCookie = challenge.headers.getSetCookie()[0]!.split(';')[0]!;
  const { challenge: id } = await challenge.json();
  expect((await post(f.url + '/_arc/preview-authorize', { challenge: id }, f.bob.cookie, f.url)).status).toBe(403);
  const approval = await post(f.url + '/_arc/preview-authorize', { challenge: id }, f.alice.cookie, f.url);
  expect(approval.status).toBe(200);
  const { code } = await approval.json();
  expect((await post(target + '/_arc/enter', { code })).status).toBe(401);
  const entered = await post(target + '/_arc/enter', { code }, browserCookie);
  expect(entered.status).toBe(200); expect(await entered.json()).toEqual({ url: '/docs?q=1#part' });
  const cookie = entered.headers.getSetCookie()[0]!.split(';')[0]!;
  const headers = { cookie: cookie + '; app=one' };
  expect((await f.fetch(target + '/bytes')).status).toBe(401);
  const binary = await f.fetch(target + '/bytes', { headers });
  expect([...new Uint8Array(await binary.arrayBuffer())]).toEqual([0, 128, 255, 65]);
  expect(f.observed.cookies.at(-1)).toBe('app=one');
  const html = await f.fetch(target + '/static', { headers });
  expect(await html.text()).toContain('src="/bytes"');
  const redirect = await f.fetch(target + '/redirect', { headers, redirect: 'manual' });
  expect(redirect.headers.get('location')).toBe('/next?q=1');
  expect(redirect.headers.getSetCookie()).toEqual(['one=a; Path=/', 'two=b; HttpOnly; Path=/']);
  const sse = await f.fetch(target + '/events', { headers }); const reader = sse.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n'); await reader.cancel();
  expect((await post(target + '/_arc/renew', {}, cookie, f.url)).status).toBe(200);
  const socket = new WebSocket(f.transportUrl.replace('http:', 'ws:') + '/socket', ['echo-v1'],
    { headers: { host: entry.host, cookie, origin: target }, handshakeTimeout: 5000 });
  onPreviewCleanup(async () => { socket.terminate(); });
  await once(socket, 'open'); expect(socket.protocol).toBe('echo-v1');
  const incoming = once(socket, 'message'); socket.send('root websocket'); expect((await incoming)[0].toString()).toBe('root websocket');
  const closing = once(socket, 'close');
  await f.alice.request(`v1/remote/hosts/${f.hostId}/previews/${f.registration.id}/unregister`, {});
  await closing;
  expect((await f.fetch(target + '/bytes', { headers })).status).toBe(401);
}, 20000);

it('pins a domain without extending its lease and reuses it with a fresh registration and authorization', async () => {
  const f = await previewFixture({ previewDomain: 'arc.test' });
  const base = `v1/remote/hosts/${f.hostId}/previews`;
  const first = await (await f.alice.request(base)).json();
  const origin = first.registrations[0].tunnelOrigin;
  expect(origin).toBe(new URL(await f.entryUrl('/')).origin);
  expect((await f.bob.request(`${base}/${f.registration.id}/pin`, { pinned: true })).status).toBe(403);
  expect((await f.alice.request(`${base}/${f.registration.id}/pin`, { pinned: 'yes' })).status).toBe(400);
  expect((await f.alice.request(`${base}/${f.registration.id}/pin`, { pinned: true })).status).toBe(200);
  const pinned = await (await f.alice.request(base)).json();
  expect(pinned.registrations[0]).toMatchObject({ tunnelNamePinned: true, tunnelOrigin: origin, expiresAt: first.registrations[0].expiresAt });
  expect((await f.alice.request(`${base}/${f.registration.id}/unregister`, {})).status).toBe(200);
  const created = await f.alice.request(`v1/sessions/${f.agentId}/previews`, { target: f.target.replace('127.0.0.1', 'localhost') + '/another/path', itemId: 'again' });
  expect(created.status).toBe(200);
  const { registration } = await created.json();
  expect(registration.id).not.toBe(f.registration.id);
  await vi.waitFor(async () => {
    const list = await (await f.alice.request(base)).json();
    expect(list.registrations.find((value: { id: string }) => value.id === registration.id)).toMatchObject({ tunnelOrigin: origin, tunnelNamePinned: true, availability: 'online' });
  });
  expect((await f.fetch(origin + '/bytes')).status).toBe(401);
  expect((await f.alice.request(`${base}/${registration.id}/pin`, { pinned: false })).status).toBe(200);
  expect((await f.alice.request(`${base}/${registration.id}/unregister`, {})).status).toBe(200);
  const random = await (await f.alice.request(`v1/sessions/${f.agentId}/previews`, { target: f.target, itemId: 'random' })).json();
  await vi.waitFor(async () => {
    const list = await (await f.alice.request(base)).json();
    const entry = list.registrations.find((value: { id: string }) => value.id === random.registration.id);
    expect(entry?.tunnelOrigin).toBeTruthy(); expect(entry.tunnelOrigin).not.toBe(origin);
  });
}, 20000);


it('lists inactive reserved names and unpins them with owner authorization and no active registration', async () => {
  const f = await previewFixture({ previewDomain: 'arc.test' });
  const base = `v1/remote/hosts/${f.hostId}/previews`;
  const initial = await (await f.alice.request(base)).json();
  expect((await f.alice.request(`${base}/${f.registration.id}/pin`, { pinned: true })).status).toBe(200);
  expect((await f.alice.request(`${base}/${f.registration.id}/unregister`, {})).status).toBe(200);
  await vi.waitFor(async () => {
    const snapshot = await (await f.alice.request(base)).json();
    expect(snapshot.registrations).toEqual([]);
    expect(snapshot.pinnedNames).toEqual([{ nameId: f.registration.id, target: f.target, tunnelOrigin: initial.registrations[0].tunnelOrigin }]);
  });
  const unpin = `${base}/pins/${f.registration.id}/unpin`;
  expect((await f.bob.request(unpin, {})).status).toBe(403);
  expect((await (await f.alice.request(base)).json()).pinnedNames).toHaveLength(1);
  expect((await f.alice.request(unpin, {})).status).toBe(200);
  expect((await f.alice.request(unpin, {})).status).toBe(200);
  expect((await (await f.alice.request(base)).json()).pinnedNames).toEqual([]);
  expect((await f.fetch(initial.registrations[0].tunnelOrigin + '/bytes')).status).toBe(401);
}, 20000);

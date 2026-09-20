// @vitest-environment node
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { expect, it, vi } from 'vitest';
import { previewFixture, onPreviewCleanup } from './preview-tunnel-fixture.js';

it.each([false, true])('serves authenticated binary HTTP, streaming uploads and early SSE through the real outbound Controller tunnel (separate origin: %s)', async (separateOrigin) => {
  const f = await previewFixture({ separateOrigin }); const cookie = await f.enter('/bytes');
  const path = `${f.previewOrigin}/p/${f.registration.id}`;
  expect((await fetch(path + '/bytes')).status).toBe(401);
  expect((await f.bob.request(`v1/remote/hosts/${f.hostId}/previews/${f.registration.id}/open`, { url: f.target + '/bytes' })).status).toBe(403);
  expect((await fetch(path + '/bytes', { headers: { cookie: f.alice.cookie } })).status).toBe(401);
  const binary = await fetch(path + '/bytes', { headers: { cookie: `${cookie}; app=value` } }); expect(binary.status).toBe(200);
  expect(f.observed.cookies.at(-1)).toBe('app=value');
  expect([...new Uint8Array(await binary.arrayBuffer())]).toEqual([0, 128, 255, 65]);
  const echo = await fetch(path + '/echo', { method: 'POST', headers: { cookie, origin: f.previewOrigin }, body: Buffer.from([255, 0, 128]) });
  expect([...new Uint8Array(await echo.arrayBuffer())]).toEqual([255, 0, 128]);
  const start = Date.now(); const sse = await fetch(path + '/events', { headers: { cookie } });
  const reader = sse.body!.getReader(); const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n'); expect(Date.now() - start).toBeLessThan(350);
  await reader.cancel();
  await vi.waitFor(() => expect(f.observed.cancelledEvents).toBe(1), { timeout: 2000 });
  const removed = await f.alice.request(`v1/remote/hosts/${f.hostId}/previews/${f.registration.id}/unregister`, {});
  expect(removed.status).toBe(200);
  expect((await fetch(path + '/bytes', { headers: { cookie } })).status).toBe(401);
}, 20000);

it.each([false, true])('negotiates a real local WebSocket protocol, preserves text/binary, and closes on unregister (separate origin: %s)', async (separateOrigin) => {
  const f = await previewFixture({ separateOrigin }); const cookie = await f.enter('/socket');
  const socket = new WebSocket(`${f.previewOrigin.replace('http:', 'ws:')}/p/${f.registration.id}/socket`, ['echo-v1'], { headers: { cookie, origin: f.previewOrigin }, handshakeTimeout: 5000 });
  onPreviewCleanup(async () => { socket.terminate(); });
  await once(socket, 'open'); expect(socket.protocol).toBe('echo-v1');
  let incoming = once(socket, 'message'); socket.send('hello');
  let [data, binary] = await incoming; expect(data.toString()).toBe('hello'); expect(binary).toBe(false);
  incoming = once(socket, 'message'); socket.send(Buffer.from([0, 255, 128]));
  [data, binary] = await incoming; expect([...data]).toEqual([0, 255, 128]); expect(binary).toBe(true);
  const closing = once(socket, 'close');
  await f.alice.request(`v1/remote/hosts/${f.hostId}/previews/${f.registration.id}/unregister`, {});
  await closing;
}, 20000);

it.each([false, true])('preserves HTTP ranges, conditional responses, separate cookies and multipart uploads while adapting static references (separate origin: %s)', async (separateOrigin) => {
  const f = await previewFixture({ separateOrigin }); const cookie = await f.enter('/static');
  const base = `${f.previewOrigin}/p/${f.registration.id}`;
  const headers = { cookie };
  const html = await fetch(base + '/static', { headers });
  expect(html.headers.get('cache-control')).toContain('no-store');
  expect(await html.text()).toContain(`src="/p/${f.registration.id}/bytes"`);
  expect(await (await fetch(base + '/style.css', { headers })).text()).toContain(`url(/p/${f.registration.id}/bytes)`);
  const redirect = await fetch(base + '/redirect', { headers, redirect: 'manual' });
  expect(redirect.status).toBe(302); expect(redirect.headers.get('location')).toBe(`/p/${f.registration.id}/next?q=1`);
  expect(redirect.headers.getSetCookie()).toEqual([`one=a; Path=/p/${f.registration.id}/`, `two=b; HttpOnly; Path=/p/${f.registration.id}/`]);
  const range = await fetch(base + '/range', { headers: { ...headers, range: 'bytes=1-2' } });
  expect(range.status).toBe(206); expect(range.headers.get('content-range')).toBe('bytes 1-2/4');
  expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([128, 255]);
  const unchanged = await fetch(base + '/range', { headers: { ...headers, 'if-none-match': '"image-one"' } });
  expect(unchanged.status).toBe(304); expect(await unchanged.text()).toBe('');
  const head = await fetch(base + '/range', { method: 'HEAD', headers }); expect(head.status).toBe(200); expect(await head.text()).toBe('');
  const multipart = '--arc-test\r\nContent-Disposition: form-data; name="value"\r\n\r\n你好\r\n--arc-test--\r\n';
  const uploaded = await fetch(base + '/echo', { method: 'POST', headers: { ...headers, origin: f.previewOrigin, 'content-type': 'multipart/form-data; boundary=arc-test' }, body: multipart });
  expect(await uploaded.text()).toBe(multipart);
}, 20000);


it('renews through owner authentication and preserves the mapped URL and tunnel while refusing removal revival', async () => {
  const f = await previewFixture({ ttlMs: 1000 });
  const list = async () => (await (await f.alice.request(`v1/remote/hosts/${f.hostId}/previews`)).json()).registrations;
  expect(await list()).toEqual([expect.objectContaining({ id: f.registration.id, status: 'active' })]);
  const cookie = await f.enter('/bytes');
  const route = `v1/remote/hosts/${f.hostId}/previews/${f.registration.id}/renew`;
  expect((await f.bob.request(route, {})).status).toBe(404);
  const response = await f.alice.request(route, {});
  expect(response.status).toBe(200);
  const { registration } = await response.json() as { registration: { id: string; expiresAt: number } };
  expect(registration.id).toBe(f.registration.id);
  expect(registration.expiresAt).toBeGreaterThan(f.registration.expiresAt);
  const url = `${f.previewOrigin}/p/${f.registration.id}`;
  const renewed = await fetch(url + '/_arc/renew', { method: 'POST', headers: { cookie, origin: f.previewOrigin, 'content-type': 'application/json' }, body: '{}' });
  expect(renewed.status).toBe(200);
  expect(renewed.headers.getSetCookie()[0]).toContain(cookie.split(';')[0]!);
  expect((await fetch(url + '/bytes', { headers: { cookie } })).status).toBe(200);
  await vi.waitFor(async () => {
    const snapshot = await (await f.alice.request(`v1/remote/hosts/${f.hostId}/previews`)).json();
    expect(snapshot.registrations).toEqual([]);
  }, { timeout: 3000 });
  const recovered = await f.alice.request(route, {});
  expect(recovered.status).toBe(200);
  expect((await recovered.json()).registration).toMatchObject({ id: f.registration.id, status: 'active' });
  await vi.waitFor(async () => expect((await fetch(url + '/bytes', { headers: { cookie } })).status).toBe(200), { timeout: 1000 });
  await f.alice.request(`v1/remote/hosts/${f.hostId}/previews/${f.registration.id}/unregister`, {});
  await vi.waitFor(async () => expect(await list()).toEqual([]), { timeout: 1000 });
  expect((await f.alice.request(route, {})).status).toBe(409);
  expect((await fetch(url + '/bytes', { headers: { cookie } })).status).toBe(401);
}, 20000);

it.each(['http', 'sse', 'websocket', 'upload'] as const)('renews on %s traffic without an iframe and expires after traffic stops', async mode => {
  const f = await previewFixture({ ttlMs: 1000 });
  const cookie = await f.enter('/bytes');
  const base = f.previewOrigin + '/p/' + f.registration.id;
  const until = f.registration.expiresAt + 600;
  if (mode === 'http') {
    while (Date.now() < until) {
      const response = await fetch(base + '/bytes', { headers: { cookie } });
      expect(response.status).toBe(200); await response.arrayBuffer();
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  } else if (mode === 'sse') {
    const response = await fetch(base + '/streaming-events', { headers: { cookie } });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try { while (Date.now() < until) { const part = await reader.read(); expect(part.done).toBe(false); } }
    finally { await reader.cancel(); }
  } else if (mode === 'websocket') {
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/socket', ['echo-v1'], { headers: { cookie, origin: f.previewOrigin }, handshakeTimeout: 5000 });
    onPreviewCleanup(async () => { socket.terminate(); });
    await once(socket, 'open');
    while (Date.now() < until) {
      const received = once(socket, 'message'); socket.send('activity');
      expect((await received)[0].toString()).toBe('activity');
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    socket.close(); await once(socket, 'close');
  } else {
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (Date.now() >= until) { controller.close(); return; }
        await new Promise(resolve => setTimeout(resolve, 100)); controller.enqueue(new Uint8Array([1, 2, 3]));
      },
    });
    const response = await fetch(base + '/echo', { method: 'POST', headers: { cookie, origin: f.previewOrigin }, body, duplex: 'half' } as RequestInit);
    expect(response.status).toBe(200); expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(3);
  }
  const list = async () => (await (await f.alice.request('v1/remote/hosts/' + f.hostId + '/previews')).json()).registrations;
  await vi.waitFor(async () => expect(await list()).toEqual([expect.objectContaining({ id: f.registration.id, expiresAt: expect.any(Number) })]), { timeout: 1000 });
  expect((await list())[0].expiresAt).toBeGreaterThan(until);
  await vi.waitFor(async () => expect(await list()).toEqual([]), { timeout: 4000 });
  expect((await fetch(base + '/bytes', { headers: { cookie } })).status).toBe(401);
}, 20000);

it('does not renew for unauthorized traffic, list polling, or an idle WebSocket', async () => {
  const f = await previewFixture({ ttlMs: 1000 });
  const cookie = await f.enter('/socket');
  const base = f.previewOrigin + '/p/' + f.registration.id;
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/socket', { headers: { cookie, origin: f.previewOrigin }, handshakeTimeout: 5000 });
  onPreviewCleanup(async () => { socket.terminate(); });
  await once(socket, 'open');
  const closed = once(socket, 'close');
  while (Date.now() < f.registration.expiresAt + 1500) {
    expect((await fetch(base + '/bytes')).status).toBe(401);
    await f.alice.request('v1/remote/hosts/' + f.hostId + '/previews');
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  await closed;
  expect((await fetch(base + '/bytes', { headers: { cookie } })).status).toBe(401);
}, 20000);


it('copies a credential-free link and requires the current browser owner for navigation and data', async () => {
  const f = await previewFixture();
  const copied = await f.alice.request('v1/remote/hosts/' + f.hostId + '/previews/' + f.registration.id + '/open', { url: f.target + '/docs?q=1#section', mode: 'link' });
  expect(copied.status).toBe(200);
  const { tunnelUrl } = await copied.json();
  const link = new URL(tunnelUrl);
  expect(link.origin).toBe(f.url);
  expect(link.pathname).toBe('/'); expect(link.hash).toBe('');
  expect([...link.searchParams.keys()].sort()).toEqual(['host', 'path', 'preview']);
  expect(link.searchParams.get('path')).toBe('/docs?q=1#section');
  const navigate = (cookie = '', method = 'GET') => fetch(tunnelUrl, { method, headers: { cookie }, redirect: 'manual' });
  const signedOut = await navigate();
  expect(signedOut.status).toBe(303);
  expect(signedOut.headers.get('location')).toBe('/auth/login' + link.search);
  const login = await fetch(f.url + signedOut.headers.get('location'), { redirect: 'manual' });
  expect(login.status).toBe(303);
  expect(new URL(login.headers.get('location')!).origin).toBe('https://gateway.example');
  expect((await navigate(f.bob.cookie)).status).toBe(403);
  expect((await navigate(f.alice.cookie, 'POST')).status).toBe(405);
  const allowed = await navigate(f.alice.cookie);
  expect(allowed.status).toBe(303);
  const code = new URL(allowed.headers.get('location')!).hash.slice(1);
  const redeem = (cookie = '') => fetch(f.previewOrigin + '/_arc/enter', { method: 'POST', headers: { cookie, origin: f.previewOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  expect((await redeem()).status).toBe(401);
  expect((await redeem(f.bob.cookie)).status).toBe(401);
  const entered = await redeem(f.alice.cookie);
  expect(entered.status).toBe(200);
  expect(await entered.json()).toEqual({ url: '/p/' + f.registration.id + '/docs?q=1#section' });
  const previewCookie = entered.headers.getSetCookie()[0]!.split(';')[0]!;
  const path = f.previewOrigin + '/p/' + f.registration.id + '/bytes';
  expect((await fetch(path, { headers: { cookie: previewCookie } })).status).toBe(401);
  expect((await fetch(path, { headers: { cookie: previewCookie + '; ' + f.bob.cookie } })).status).toBe(401);
  expect((await fetch(path, { headers: { cookie: previewCookie + '; ' + f.alice.cookie } })).status).toBe(200);
  const document = await fetch(path, { headers: { 'sec-fetch-dest': 'document' }, redirect: 'manual' });
  expect(document.status).toBe(303);
  expect(new URL(document.headers.get('location')!).searchParams.get('preview')).toBe(f.registration.id);
}, 20000);

it('does not accept a transferable entry proof on a separate preview origin without a browser login', async () => {
  const f = await previewFixture({ separateOrigin: true });
  const entry = await f.entryUrl('/bytes');
  const response = await fetch(f.previewOrigin + '/_arc/enter', { method: 'POST', headers: { origin: f.previewOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ code: new URL(entry).hash.slice(1) }) });
  expect(response.status).toBe(401);
}, 20000);

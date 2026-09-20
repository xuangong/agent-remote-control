// @vitest-environment node
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
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

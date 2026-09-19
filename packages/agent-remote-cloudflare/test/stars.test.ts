import { expect, it } from 'vitest';
import { fixture, origin } from './fixture.js';

it('persists deliberate stars across browsers and restart without opening native sessions', async () => {
  const f = await fixture(); const alice = await f.login('alice'); const other = await f.login('alice'); const bob = await f.login('bob');
  const pair = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const host = await f.host(pair.key);
  let nativeRequests = 0;
  host.socket.addEventListener('message', e => { if (JSON.parse(String(e.data)).type === 'rpc_request') nativeRequests++; });
  const star = { hostId: host.hostId, providerId: 'codex', nativeSessionId: 'native-one', title: 'First conversation' };
  const path = alice.basePath + 'v1/stars';
  expect((await f.json(path, alice.cookie, star)).status).toBe(200);
  expect((await f.json(path, alice.cookie, star)).status).toBe(200);
  const value = await (await f.json(path, other.cookie)).json() as { stars: unknown[] };
  expect(value.stars).toHaveLength(1); expect(value.stars[0]).toMatchObject({ ...star, available: true, online: true });
  expect(await (await f.json(bob.basePath + 'v1/stars', bob.cookie)).json()).toEqual({ stars: [] });
  expect((await f.json(path, bob.cookie)).status).toBe(403);
  expect((await f.json(bob.basePath + 'v1/stars', bob.cookie, star)).status).toBe(404);
  expect((await f.request(path, { method: 'POST', headers: { cookie: alice.cookie, origin: 'https://other.example', 'content-type': 'application/json' }, body: JSON.stringify(star) })).status).toBe(403);
  expect((await f.json(path, alice.cookie, { ...star, subject: 'bob' })).status).toBe(400);
  expect(nativeRequests).toBe(0);
  await f.restart();
  const restored = await (await f.json(path, other.cookie)).json() as { stars: unknown[] };
  expect(restored.stars).toHaveLength(1); expect(restored.stars[0]).toMatchObject({ ...star, available: true, online: false });
  const headers = { cookie: other.cookie, origin, 'content-type': 'application/json' };
  expect((await f.request(path, { method: 'DELETE', headers, body: JSON.stringify({ hostId: host.hostId, providerId: 'codex', nativeSessionId: star.nativeSessionId }) })).status).toBe(200);
  expect(await (await f.json(path, alice.cookie)).json()).toEqual({ stars: [] });
}, 30000);

import { expect, it } from 'vitest';

import { origin } from './test-utils/relay-harness.js';
import { world } from './test-utils/relay-world.js';

/** The Relay's own checks of who may reach it and how, observed on an in-memory hosted Relay: no socket, a fake clock. */

it('refuses every request that did not arrive under the Relay\'s own origin', async () => {
  const f = await world();
  for (const url of ['https://relay.example.attacker.test/auth/login', 'http://relay.example/auth/login', 'https://relay.example:8443/auth/login', 'https://other.example/auth/login']) {
    const refused = await f.requestAt(url);
    expect([url, refused.status, refused.headers.get('set-cookie')]).toEqual([url, 403, null]);
  }
  expect((await f.request('/auth/login')).status).toBe(303);
});

it('changes sign-in sessions only for a same-origin POST, and answers anything else with 403 and no change', async () => {
  const f = await world(); const alice = await f.signIn('alice'); await f.signIn('alice');
  const list = async () => (await (await f.json('/auth/sessions', alice.cookie)).json() as any).sessions as Array<{ id: string; current: boolean }>;
  const other = (await list()).find(session => !session.current)!;
  const attempt = (method: string, headers: Record<string, string>) => f.request('/auth/sessions/revoke', { method, headers: { cookie: alice.cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ id: other.id }) });
  // No Origin header at all, a foreign one, or a method that is not POST.
  expect((await attempt('POST', {})).status).toBe(403);
  expect((await attempt('POST', { origin: 'https://foreign.example' })).status).toBe(403);
  expect((await attempt('PUT', { origin })).status).toBe(403);
  expect(await list()).toHaveLength(2);
  expect((await attempt('POST', { origin })).status).toBe(200);
  expect(await list()).toHaveLength(1);
});

it('shows a person who is not signed in no command line approval, and lets them neither approve nor deny it', async () => {
  const f = await world(); const alice = await f.signIn('alice');
  const started = await f.request('/auth/cli/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'laptop-label' }) });
  const { userCode, deviceCode } = await started.json() as { userCode: string; deviceCode: string };
  const page = await (await f.request(`/auth/cli?code=${userCode}`)).text();
  expect(page).toContain('Sign in first');
  expect(page).not.toContain('laptop-label');
  expect(page).not.toContain(userCode);
  for (const decision of ['approve', 'deny']) {
    expect((await f.request('/auth/cli', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: userCode, decision }) })).status).toBe(401);
  }
  const signedInPage = await (await f.request(`/auth/cli?code=${userCode}`, { headers: { cookie: alice.cookie } })).text();
  expect(signedInPage).toContain('laptop-label');
  expect((await f.request('/auth/cli/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceCode }) })).status).toBe(202);
});

it('trusts an owner the account authority confirmed until the lease ends, without asking again for each Host connection', async () => {
  const f = await world(); const alice = await f.signIn('alice');
  const pair = async () => ((await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json()) as any).key as string;
  const [first, second, third] = [await pair(), await pair(), await pair()];
  await f.host(first);
  const asked = f.authority.calls;
  await f.host(second, false, undefined, false, false, 'codex', 'second-host');
  expect(f.authority.calls).toBe(asked);
  // Past the lease the next connection asks, and an authority that no longer confirms the account turns it away.
  f.authority.answer(403);
  await f.advance(130_000);
  expect((await f.refusedUpgrade('/ws/remote-host', { authorization: `Bearer ${third}` })).status).toBe(401);
  expect(f.authority.calls).toBeGreaterThan(asked);
});

it('answers a malformed session rename with 400, which is not a sign-out', async () => {
  const f = await world(); const alice = await f.signIn('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as any;
  const host = await f.host(pairing.key);
  const response = await f.json(alice.basePath + `v1/remote/hosts/${host.hostId}/session/rename`, alice.cookie, { title: 'x' });
  expect(response.status).toBe(400);
});

import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { createHostedRelay } from './gateway.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

it.each([
  { origin: 'https://relay.example', cookiePrefix: undefined, cookieStem: '__Host-arc' },
  { origin: 'https://relay.example', cookiePrefix: 'devbox', cookieStem: '__Host-devbox' },
  { origin: 'http://127.0.0.1:5910', cookiePrefix: 'devbox', cookieStem: 'devbox' },
])('keeps login, renewal, browser grouping, revocation and logout in $cookieStem cookies', async ({ origin, cookiePrefix, cookieStem }) => {
  const secret = 'cookie-prefix-test-secret-at-least-32-bytes';
  const sessionExpiresAt = Date.now() + 3_600_000;
  let renewals = 0;
  const authority = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    if (request.method !== 'POST' || request.url !== '/api/agent-remote/renew' || body !== JSON.stringify({ continuation: 'cookie-test-continuation' })) {
      response.writeHead(400); response.end(); return;
    }
    renewals++;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ active: true, subject: 'alice', expiresAt: sessionExpiresAt, validUntil: Date.now() + 120_000, authenticatedAt: Date.now() }));
  });
  await new Promise<void>(resolve => authority.listen(0, '127.0.0.1', resolve));
  closers.push(async () => { authority.closeAllConnections(); await new Promise<void>(resolve => authority.close(() => resolve())); });
  const issuer = `http://127.0.0.1:${(authority.address() as AddressInfo).port}`;
  const relay = createHostedRelay({ origin, issuer, secret, cookiePrefix, storage: { async commit() {} }, scheduler: { schedule() {}, cancel() {} } });
  closers.push(() => relay.close());
  const request = (path: string, cookie?: string, body?: unknown) => new Request(origin + path, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }) },
  });
  const fetchRelay = async (path: string, cookie?: string, body?: unknown) => (await relay.fetch(request(path, cookie, body)))!;
  async function signIn(browser?: string) {
    const login = await fetchRelay('/auth/login', browser);
    expect(login.status).toBe(303);
    const loginCookie = login.headers.getSetCookie()[0]!;
    expect(loginCookie.startsWith(cookieStem + '_login=')).toBe(true);
    const nonce = new URL(login.headers.get('location')!).searchParams.get('challenge');
    const iat = Math.floor(Date.now() / 1000);
    const input = [{ alg: 'HS256', typ: 'arc-relay+jwt' }, { iss: issuer, aud: origin, sub: 'alice', iat, exp: iat + 900,
      jti: randomUUID(), nonce, continuation: 'cookie-test-continuation', sessionExpiresAt }]
      .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    const ticket = input + '.' + createHmac('sha256', secret).update(input).digest('base64url');
    const response = await fetchRelay('/auth/session', [loginCookie.split(';')[0], browser].filter(Boolean).join('; '), { ticket });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().map(value => value.split('=')[0])).toEqual([
      cookieStem + '_session', cookieStem + '_browser', cookieStem + '_login',
    ]);
    expect(response.headers.getSetCookie()[2]).toContain('Max-Age=0');
    return response.headers.getSetCookie().slice(0, 2).map(value => value.split(';')[0]).join('; ');
  }

  const first = await signIn();
  expect(renewals).toBe(1);
  const status = await fetchRelay('/auth/status', first);
  expect(status.status).toBe(200);
  expect((await status.json()).user.id).toBe('alice');
  expect(status.headers.getSetCookie()[0]!.startsWith(cookieStem + '_browser=')).toBe(true);
  const refresh = await fetchRelay('/auth/refresh', first, {});
  expect(refresh.status).toBe(200);
  expect(refresh.headers.getSetCookie()[0]!.startsWith(cookieStem + '_browser=')).toBe(true);
  expect(renewals).toBe(2);

  const browser = first.split('; ').find(value => value.startsWith(cookieStem + '_browser='))!;
  const second = await signIn(browser);
  const listing = await fetchRelay('/auth/sessions', second);
  expect(listing.headers.getSetCookie()[0]!.startsWith(cookieStem + '_browser=')).toBe(true);
  const rows = (await listing.json()).sessions;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ current: true, sessionCount: 2 });
  const revoked = await fetchRelay('/auth/sessions/revoke', second, { id: rows[0].id });
  expect(revoked.status).toBe(200);
  expect(revoked.headers.getSetCookie()[0]).toContain(cookieStem + '_session=;');
  expect((await fetchRelay('/auth/status', first)).status).toBe(401);
  expect((await fetchRelay('/auth/status', second)).status).toBe(401);

  const third = await signIn(browser);
  const logout = await fetchRelay('/auth/logout', third, {});
  expect(logout.status).toBe(200);
  expect(logout.headers.getSetCookie()[0]).toContain(cookieStem + '_session=;');
  expect(logout.headers.getSetCookie()[0]).toContain('Max-Age=0');
  expect((await fetchRelay('/auth/status', third)).status).toBe(401);
}, 10000);

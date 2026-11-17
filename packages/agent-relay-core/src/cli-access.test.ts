import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { createCliAuthorizations } from './cli-access.js';
import { createHostedRelay } from './gateway.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

async function signedInRelay(authenticatedAt: () => number = Date.now) {
  const origin = 'https://relay.example', secret = 'cli-access-test-secret-at-least-32-bytes';
  const sessionExpiresAt = Date.now() + 3_600_000;
  const authority = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain. */ }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ active: true, subject: 'alice', expiresAt: sessionExpiresAt, validUntil: Date.now() + 120_000, authenticatedAt: authenticatedAt() }));
  });
  await new Promise<void>(resolve => authority.listen(0, '127.0.0.1', resolve));
  closers.push(async () => { authority.closeAllConnections(); await new Promise<void>(resolve => authority.close(() => resolve())); });
  const issuer = `http://127.0.0.1:${(authority.address() as AddressInfo).port}`;
  const relay = createHostedRelay({ origin, issuer, secret, storage: { async commit() {} }, scheduler: { schedule() {}, cancel() {} } });
  closers.push(() => relay.close());
  const send = async (path: string, options: { cookie?: string; body?: unknown; origin?: string | null } = {}) => (await relay.fetch(new Request(origin + path, {
    ...(options.body === undefined ? {} : { method: 'POST', body: JSON.stringify(options.body) }),
    headers: { ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.body !== undefined && options.origin !== null ? { origin: options.origin ?? origin } : {}) },
  })))!;
  const login = await send('/auth/login');
  const loginCookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
  const nonce = new URL(login.headers.get('location')!).searchParams.get('challenge');
  const iat = Math.floor(Date.now() / 1000);
  const input = [{ alg: 'HS256', typ: 'arc-relay+jwt' }, { iss: issuer, aud: origin, sub: 'alice', iat, exp: iat + 900,
    jti: randomUUID(), nonce, continuation: 'cli-test-continuation', sessionExpiresAt }]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  const ticket = input + '.' + createHmac('sha256', secret).update(input).digest('base64url');
  const session = await send('/auth/session', { cookie: loginCookie, body: { ticket } });
  expect(session.status).toBe(200);
  const browser = session.headers.getSetCookie().slice(0, 2).map(value => value.split(';')[0]).join('; ');
  return { send, browser, sessionExpiresAt };
}

it('gives a command line its own session once the signed-in user allows its code', async () => {
  const { send, browser, sessionExpiresAt } = await signedInRelay();
  const started = await send('/auth/cli/start', { body: { label: 'laptop' }, origin: null });
  expect(started.status).toBe(200);
  const { deviceCode, userCode, verificationUrl, intervalMs } = await started.json();
  expect(userCode).toMatch(/^[A-Z]{8}$/);
  expect(verificationUrl).toBe(`https://relay.example/auth/cli?code=${userCode}`);
  expect(intervalMs).toBeGreaterThan(0);
  expect((await send('/auth/cli/token', { body: { deviceCode }, origin: null })).status).toBe(202);

  expect(await (await send(`/auth/cli?code=${userCode}`)).text()).toContain('Sign in first');
  const page = await send(`/auth/cli?code=${userCode}`, { cookie: browser });
  expect(page.headers.get('content-security-policy')).toContain("script-src 'sha256-");
  const html = await page.text();
  expect(html).toContain('Command line · laptop');
  expect(html).toContain(userCode);

  // Only the website itself, as the signed-in user, answers.
  expect((await send('/auth/cli', { cookie: browser, body: { code: userCode, decision: 'approve' }, origin: 'https://evil.example' })).status).toBe(403);
  expect((await send('/auth/cli', { body: { code: userCode, decision: 'approve' } })).status).toBe(401);
  const approved = await send('/auth/cli', { cookie: browser, body: { code: userCode, decision: 'approve' } });
  expect(await approved.json()).toEqual({ status: 'approved' });
  expect((await send('/auth/cli', { cookie: browser, body: { code: userCode, decision: 'approve' } })).status).toBe(410);

  const token = await send('/auth/cli/token', { body: { deviceCode }, origin: null });
  expect(token.status).toBe(200);
  const credentials = await token.json();
  expect(credentials).toMatchObject({ status: 'approved', basePath: expect.stringMatching(/^\/u\/[^/]+\/$/), cookieName: '__Host-arc_session', expiresAt: sessionExpiresAt });
  expect((await send('/auth/cli/token', { body: { deviceCode }, origin: null })).status).toBe(410);

  const commandLine = `${credentials.cookieName}=${credentials.token}`;
  const status = await send('/auth/status', { cookie: commandLine });
  expect(status.status).toBe(200);
  expect((await status.json()).user.id).toBe('alice');
  // It acts as the user but never counts as recently signed in: sensitive changes stay with a browser.
  const pairing = await send(`${credentials.basePath}v1/remote/pairings`, { cookie: commandLine, body: {} });
  expect(pairing.status).toBe(403);
  expect(await pairing.json()).toMatchObject({ code: 'reauthentication_required' });
  expect((await (await send('/auth/sessions', { cookie: commandLine })).json()).recentAuthentication).toBe(false);
  const another = await (await send('/auth/cli/start', { body: {}, origin: null })).json();
  expect((await send('/auth/cli', { cookie: commandLine, body: { code: another.userCode, decision: 'approve' } })).status).toBe(403);
  // The command line's session is its own: listed beside the browser's, revocable alone.
  const listed = (await (await send('/auth/sessions', { cookie: browser })).json()).sessions as Array<{ id: string; label: string; current: boolean }>;
  expect(listed.map(row => row.label)).toContain('Command line · laptop');
  const line = listed.find(row => row.label === 'Command line · laptop')!;
  expect(line.current).toBe(false);
  const revoked = await send('/auth/sessions/revoke', { cookie: browser, body: { id: line.id } });
  expect(revoked.status).toBe(200);
  expect((await send('/auth/status', { cookie: commandLine })).status).toBe(401);
  expect((await send('/auth/status', { cookie: browser })).status).toBe(200);
});

it('refuses a command line the user refuses, and asks for a recent sign-in before allowing one', async () => {
  let authenticatedAt = Date.now();
  const { send, browser } = await signedInRelay(() => authenticatedAt);
  const refused = await (await send('/auth/cli/start', { body: {}, origin: null })).json();
  expect(await (await send('/auth/cli', { cookie: browser, body: { code: refused.userCode, decision: 'deny' } })).json()).toEqual({ status: 'denied' });
  expect((await send('/auth/cli/token', { body: { deviceCode: refused.deviceCode }, origin: null })).status).toBe(403);

  authenticatedAt = Date.now() - 24 * 3_600_000;
  expect((await send('/auth/refresh', { cookie: browser, body: {} })).status).toBe(200);
  const stale = await (await send('/auth/cli/start', { body: {}, origin: null })).json();
  expect(await (await send(`/auth/cli?code=${stale.userCode}`, { cookie: browser })).text()).toContain('Sign in again');
  const answer = await send('/auth/cli', { cookie: browser, body: { code: stale.userCode, decision: 'approve' } });
  expect(answer.status).toBe(403);
  expect(await answer.json()).toMatchObject({ code: 'reauthentication_required' });
  expect((await send('/auth/cli/token', { body: { deviceCode: stale.deviceCode }, origin: null })).status).toBe(202);
});

it('lets a pending sign-in expire and hands an approval over once', async () => {
  let now = 1_000_000;
  const authorizations = createCliAuthorizations(() => now);
  const started = authorizations.start('Command line')!;
  expect(authorizations.claim('unknown')).toEqual({ status: 'expired' });
  expect(await authorizations.decide(started.userCode, 'approve', async () => undefined)).toBe('failed');
  expect(authorizations.claim(started.deviceCode)).toEqual({ status: 'pending' });
  now += 10 * 60_000;
  expect(authorizations.describe(started.userCode)).toBeUndefined();
  expect(await authorizations.decide(started.userCode, 'approve', async () => ({ token: 't', basePath: '/u/a/', cookieName: 'c', expiresAt: now }))).toBe('unavailable');
  expect(authorizations.claim(started.deviceCode)).toEqual({ status: 'expired' });
});

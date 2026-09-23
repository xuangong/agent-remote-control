import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chromium, webkit, type BrowserContext, type Page } from '@playwright/test';
import { expect, it } from 'vitest';
import { createGatewayRelay } from '../src/server/gateway-relay.js';

for (const engine of [chromium, webkit]) it(`shares browser identity across tabs and repeat sign-ins in ${engine.name()}`, async () => {
  const secret = 'browser-inventory-local-test-secret-0123456789';
  const authority = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the renewal request. */ }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ active: true, subject: 'alice', expiresAt: Date.now() + 3600000, validUntil: Date.now() + 120000 }));
  });
  authority.listen(0, '127.0.0.1'); await once(authority, 'listening');
  const address = authority.address(); if (!address || typeof address === 'string') throw Error('Authority did not start');
  const issuer = `http://127.0.0.1:${address.port}`;
  const relay = createGatewayRelay({ origin: 'http://127.0.0.1:0', issuer, secret, servePage: async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Browser identity test</title>'); return true;
  } });
  let browser: Awaited<ReturnType<typeof engine.launch>> | undefined;
  try {
    const { url } = await relay.listen(0);
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage(); await page.goto(url);
    async function signIn(context: BrowserContext, page: Page) {
      const begin = await context.request.get(url + '/auth/login', { maxRedirects: 0 });
      const iat = Math.floor(Date.now() / 1000);
      const claims = { iss: issuer, aud: url, sub: 'alice', nonce: new URL(begin.headers().location!).searchParams.get('challenge'), iat, exp: iat + 900, jti: randomUUID(), continuation: 'alice', sessionExpiresAt: Date.now() + 3600000 };
      const input = [{ alg: 'HS256', typ: 'arc-relay+jwt' }, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
      const ticket = input + '.' + createHmac('sha256', secret).update(input).digest('base64url');
      expect(await page.evaluate(async ticket => (await fetch('/auth/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) })).status, ticket)).toBe(200);
    }
    const list = (page: Page) => page.evaluate(async () => (await (await fetch('/auth/sessions')).json()).sessions);
    await signIn(context, page);
    const first = await list(page); expect(first).toHaveLength(1);
    const tab = await context.newPage(); await tab.goto(url);
    for (const target of [page, tab]) await target.evaluate(async () => { await fetch('/auth/status'); await fetch('/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); });
    expect(await list(tab)).toMatchObject([{ id: first[0].id, sessionCount: 1 }]);
    await signIn(context, tab);
    expect(await list(page)).toMatchObject([{ id: first[0].id, sessionCount: 2 }]);
    expect(await list(tab)).toHaveLength(1);
    const unrelated = await browser.newContext(); const other = await unrelated.newPage(); await other.goto(url); await signIn(unrelated, other);
    expect(await list(other)).toHaveLength(2);
    expect((await list(other)).find((row: { current: boolean }) => row.current).id).not.toBe(first[0].id);
  } finally {
    await browser?.close(); await relay.close(); authority.closeAllConnections(); await new Promise<void>(resolve => authority.close(() => resolve()));
  }
}, 30000);

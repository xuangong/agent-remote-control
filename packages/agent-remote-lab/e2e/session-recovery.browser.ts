import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from '@playwright/test';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { onPreviewCleanup, previewFixture } from '../src/server/preview-tunnel-fixture.js';

for (const engine of [chromium, webkit]) it(`restores sessions and failed input across mobile page lifecycles in ${engine.name()}`, async () => {
  let script = '';
  const css = await readFile(new URL('../src/app.css', import.meta.url), 'utf8') + await readFile(new URL('../../agent-remote-web/src/styles.css', import.meta.url), 'utf8');
  const fixture = await previewFixture({ servePage: async (request, response) => {
    const path = new URL(request.url!, 'http://fixture').pathname;
    if (path === '/recovery.js') { response.setHeader('content-type', 'application/javascript; charset=utf-8'); response.end(script); return true; }
    if (path === '/') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/recovery.js"></script>`); return true; }
    return false;
  } });
  const baseUrl = fixture.url + fixture.alice.basePath;
  const source = `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { App } from './App.tsx';
    import { HttpWebSocketTransport } from '@agent-remote-controller/agent-remote-web';
    import { SessionDirectoryClient } from './directory-client.ts';
    import { saveLastSession } from './conversation-recovery.tsx';
    const base = ${JSON.stringify(baseUrl)};
    if (!localStorage.getItem('fixture-seeded')) {
      saveLastSession(base, ${JSON.stringify({ hostId: fixture.hostId, providerId: 'fixture', nativeSessionId: 'native', agentId: fixture.agentId })});
      localStorage.setItem('fixture-seeded', '1');
    }
    window.attempts = []; window.dropNext = false;
    const transport = new HttpWebSocketTransport(base, { webSocketFactory: url => {
      const socket = new WebSocket(url); const send = socket.send.bind(socket);
      socket.send = text => {
        const value = JSON.parse(text);
        if (value.type === 'send_message') {
          window.attempts.push(value.payload);
          if (window.dropNext) { window.dropNext = false; window.disconnectDropped = () => socket.close(); return; }
        }
        send(text);
      };
      return socket;
    }});
    createRoot(document.getElementById('root')).render(<App baseUrl={base} transport={transport} directory={new SessionDirectoryClient(base)} />);
  `;
  script = (await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) }, bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })).outputFiles[0]!.text;
  const browser = await engine.launch({ headless: true }); onPreviewCleanup(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(10000);
  const separator = fixture.alice.cookie.indexOf('=');
  await page.context().addCookies([{ name: fixture.alice.cookie.slice(0, separator), value: fixture.alice.cookie.slice(separator + 1), url: fixture.url, httpOnly: true, sameSite: 'Strict' }]);
  const errors: string[] = []; let sockets = 0;
  page.on('pageerror', error => errors.push(error.message)); page.on('websocket', () => sockets++);
  await page.goto(fixture.url + '/');
  const input = page.getByTestId('prompt-input');
  await expect.poll(() => input.isEnabled()).toBe(true);
  expect(await page.locator('#lab-context').count()).toBe(0);
  await input.fill('Keep draft across background');
  const before = sockets;
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect.poll(() => sockets).toBe(before + 1);
  await expect.poll(() => input.isEnabled()).toBe(true);
  expect(await input.inputValue()).toBe('Keep draft across background');
  expect(await page.evaluate(() => (window as any).attempts.length)).toBe(0);
  await page.clock.install();
  await page.evaluate(() => { (window as any).dropNext = true; });
  await input.fill('Do not lose this failed message');
  await page.getByTestId('prompt-submit').click();
  await page.clock.fastForward(11000);
  expect(await page.locator('[data-delivery-state="unconfirmed"]').count()).toBe(0);
  expect(await page.locator('[data-delivery-state="pending"]').count()).toBe(1);
  await page.evaluate(() => { (window as any).disconnectDropped(); });
  await expect.poll(() => page.locator('[data-delivery-state="unconfirmed"]').count()).toBe(1);
  await page.clock.fastForward(60000);
  expect(await page.locator('[data-delivery-state="unconfirmed"]').textContent()).toContain('Do not lose this failed message');
  expect(await page.evaluate(() => (window as any).attempts.length)).toBe(1);
  await page.goto(fixture.url + '/');
  await expect.poll(() => input.isEnabled()).toBe(true);
  expect(await page.locator('[data-delivery-state="unconfirmed"]').textContent()).toContain('Do not lose this failed message');
  const savedOperation = await page.evaluate(base => {
    const key = Object.keys(localStorage).find(key => key.startsWith(`agent-remote:recovery:${base}:outbox:`))!;
    return JSON.parse(localStorage.getItem(key)!)[0].operationId;
  }, baseUrl);
  await page.getByRole('button', { name: 'Retry message', exact: true }).click();
  await expect.poll(() => page.locator('.agent-message-delivery').textContent()).toContain('Sent');
  expect(await page.evaluate(() => (window as any).attempts[0].operationId)).toBe(savedOperation);
  expect(await page.locator('.agent-outgoing-message').count()).toBe(1);
  await page.clock.fastForward(31000);
  expect(await page.locator('.agent-message-delivery').textContent()).toContain('Sent');
  await page.goto(fixture.url + '/');
  await expect.poll(() => input.isEnabled()).toBe(true);
  await expect.poll(() => page.getByRole('button', { name: 'Delete message', exact: true }).isEnabled()).toBe(true);
  await page.screenshot({ path: `/tmp/arc-mobile-recovery-${engine.name()}.png` });
  await page.getByRole('button', { name: 'Delete message', exact: true }).click();
  expect(await page.locator('.agent-outgoing-message').count()).toBe(0);
  await page.goto(fixture.url + '/');
  await expect.poll(() => input.isEnabled()).toBe(true);
  expect(await page.locator('.agent-outgoing-message').count()).toBe(0);
  expect(errors).toEqual([]);
}, 60000);

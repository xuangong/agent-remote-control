// E14, the installed app's shell (I5a): its service worker keeps the page and the bundles it starts with, and starts the app from them
// whatever the network does: gone, or answering never. A build deployed meanwhile is stored in the background and applies at the next
// launch; the page the person has is never swapped, and the worker drops all but the previous build's cache. The API and the session
// traffic are never kept.
// `E2E_BROWSER=webkit` runs it in WebKit.
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage } from './browser.js';
import { showsText, waitForKeptConversation } from './page.js';

let stack: Stack; let browser: Browser; let web: string;
beforeAll(async () => {
  // A copy of the built Workbench, so the flow can deploy a new build into it.
  web = await mkdtemp(join(tmpdir(), 'arc-e2e-web-'));
  await cp(resolve(import.meta.dirname, '../../agent-remote-lab/dist'), web, { recursive: true });
  stack = await startStack({ providerId: 'codex', displayName: 'Codex CLI', webDist: web,
    sessions: { notes: { title: 'Notes', history: [{ role: 'user', text: 'Start' }, { role: 'assistant', text: 'Notes is ready' }] } } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); if (web) await rm(web, { recursive: true, force: true }); });

/** The caches the page's origin holds, once its worker is active. */
const shellCaches = (page: Page) => page.evaluate(async () => { await navigator.serviceWorker.ready; return (await caches.keys()).filter(name => name.startsWith('orchard-shell-')); });
/**
 * The worker of a deployed build has stored its whole shell (`count` files) and taken over: nothing installing or waiting. A cache exists
 * from the moment an install starts, so its existence says nothing about the install being done; a launch before this still starts from the
 * previous build.
 */
const tookOver = (page: Page, cache: string, count: number) => page.evaluate(async ({ name, files }) => {
  const registration = await navigator.serviceWorker.ready;
  const stored = (await (await caches.open(name)).keys()).length;
  return stored >= files && !registration.installing && !registration.waiting && registration.active?.state === 'activated';
}, { name: cache, files: count });
/** The URLs a shell cache holds, as paths. */
const kept = (page: Page, name: string) => page.evaluate(async cache => (await (await caches.open(cache)).keys()).map(request => new URL(request.url).pathname).sort(), name);

it('E14: the installed app starts offline from its shell with its conversation, and takes a new build at the next reload', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('notes'));
  await showsText(page, 'Notes is ready');
  await waitForKeptConversation(page, 'Notes is ready');
  // The worker installs from the first visit and keeps the page and its start bundles, and nothing of the API.
  await expect.poll(() => shellCaches(page), { timeout: 15_000 }).toHaveLength(1);
  const [first] = await shellCaches(page);
  const files = await kept(page, first!);
  expect(files).toContain('/');
  expect(files.some(path => /^\/assets\/App-[\w-]+\.js$/.test(path))).toBe(true);
  expect(files.filter(path => !path.startsWith('/assets/') && path !== '/')).toEqual([]);

  // The network goes: the next start comes from the shell, with the conversation the device kept.
  await stack.stopRelay();
  await page.reload({ waitUntil: 'domcontentloaded' });
  expect(await page.title()).toMatch(/Orchard$/);
  await page.locator('.lab-frame').waitFor();
  await showsText(page, 'Notes is ready');
  // Everything it started with is still kept; code the page loaded on demand since (an assistant's details) joins it.
  expect(await kept(page, first!)).toEqual(expect.arrayContaining(files));

  // A network that accepts connections and never answers (a phone on a bad link): the app still starts at once from the shell.
  const hung = await hangNetwork(Number(new URL(stack.origin).port));
  const launched = Date.now();
  await page.reload({ waitUntil: 'commit' });
  await page.locator('.lab-frame').waitFor({ timeout: 3_000 });
  expect(Date.now() - launched).toBeLessThan(3_000);
  await hung.close();

  // A new build is deployed while the app is away: its page and its worker change.
  const index = await readFile(join(web, 'index.html'), 'utf8');
  await writeFile(join(web, 'index.html'), index.replace('<title>Orchard</title>', '<title>Orchard</title><meta name="orchard-build" content="next">'));
  const worker = await readFile(join(web, 'sw.js'), 'utf8');
  expect(worker).toMatch(/version:"[0-9a-f]{16}"/);
  await writeFile(join(web, 'sw.js'), worker.replace(/version:"[0-9a-f]{16}"/, 'version:"0000000000000002"'));
  await stack.startRelay();
  // The launch that finds the new build still starts from the stored one: the new build is stored in the background, and the open page
  // is not swapped for it. The older build's cache stays for the page that is open on it.
  await page.reload({ waitUntil: 'domcontentloaded' });
  expect(await page.locator('meta[name="orchard-build"]').count()).toBe(0);
  await expect.poll(() => tookOver(page, 'orchard-shell-0000000000000002', files.length), { timeout: 20_000 }).toBe(true);
  expect(await shellCaches(page)).toEqual([first, 'orchard-shell-0000000000000002']);
  expect(await page.locator('meta[name="orchard-build"]').count()).toBe(0);
  await showsText(page, 'Notes is ready');
  // The next launch takes the new build, from the device, and the API never wakes the worker.
  await page.reload({ waitUntil: 'domcontentloaded' });
  expect(await page.locator('meta[name="orchard-build"]').count()).toBe(1);
  await showsText(page, 'Notes is ready');
  // Where the browser has static routes (Chromium), the API never wakes the worker: the network answers it directly.
  const sources = await page.evaluate(() => performance.getEntriesByType('resource')
    .map(entry => ({ path: new URL(entry.name).pathname, source: (entry as PerformanceResourceTiming & { workerMatchedSourceType?: string }).workerMatchedSourceType })));
  const api = sources.filter(entry => /\/(v1|auth)\//.test(entry.path));
  expect(api.length).toBeGreaterThan(0);
  if (sources.some(entry => entry.source !== undefined)) expect(api.filter(entry => entry.source !== 'network')).toEqual([]);
  await context.close();
});

/** Takes the port of a stopped Relay and holds every connection open without answering. */
async function hangNetwork(port: number): Promise<{ close(): Promise<void> }> {
  const sockets = new Set<import('node:net').Socket>();
  const server: Server = createServer(socket => { sockets.add(socket); socket.on('error', () => undefined); });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  return { close: () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }) };
}

// E14, the installed app's shell (I5a): its service worker keeps the page and the bundles it starts with. A page that opened once starts
// again with no network from that shell, with its stored conversation, and a build deployed meanwhile applies at the next reload: the new
// page from the network, and a new worker that drops the older build's caches. The API and the session traffic are never kept.
// `E2E_BROWSER=webkit` runs it in WebKit.
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  // A new build is deployed while the app is away: its page and its worker change.
  const index = await readFile(join(web, 'index.html'), 'utf8');
  await writeFile(join(web, 'index.html'), index.replace('<title>Orchard</title>', '<title>Orchard</title><meta name="orchard-build" content="next">'));
  const worker = await readFile(join(web, 'sw.js'), 'utf8');
  expect(worker).toMatch(/version:"[0-9a-f]{16}"/);
  await writeFile(join(web, 'sw.js'), worker.replace(/version:"[0-9a-f]{16}"/, 'version:"0000000000000002"'));
  await stack.startRelay();
  // The reload takes the new page from the network, and the new worker takes over and drops the older build's cache.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.locator('meta[name="orchard-build"]').count(), { timeout: 15_000 }).toBe(1);
  await expect.poll(() => shellCaches(page), { timeout: 15_000 }).toEqual(['orchard-shell-0000000000000002']);
  await showsText(page, 'Notes is ready');
  // Where the browser has static routes (Chromium), the API never wakes the worker: the network answers it directly.
  const sources = await page.evaluate(() => performance.getEntriesByType('resource')
    .map(entry => ({ path: new URL(entry.name).pathname, source: (entry as PerformanceResourceTiming & { workerMatchedSourceType?: string }).workerMatchedSourceType })));
  const api = sources.filter(entry => /\/(v1|auth)\//.test(entry.path));
  expect(api.length).toBeGreaterThan(0);
  if (sources.some(entry => entry.source !== undefined)) expect(api.filter(entry => entry.source !== 'network')).toEqual([]);
  await context.close();
});

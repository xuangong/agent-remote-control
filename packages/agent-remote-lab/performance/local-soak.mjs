// Stage 7: a read-only soak on the `pnpm local` instance (see README.md), with its real sessions: it switches between
// bots and modes and sends nothing. Run from the repository root while the instance runs:
// MINUTES=20 node packages/agent-remote-lab/performance/local-soak.mjs
// One browser context (one sign-in). Every minute, after a forced collection, it records heap, DOM nodes, listeners,
// open sockets, requests and console errors, and writes them to ARC_PERFORMANCE_OUTPUT (.tmp/local-soak.json).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
const root = process.cwd();
const minutes = Number(process.env.MINUTES ?? 20);
const output = resolve(process.env.ARC_PERFORMANCE_OUTPUT ?? '.tmp/local-soak.json');
const { origin } = JSON.parse(execFileSync('pnpm', ['--silent', 'local', 'status', '--json'], { cwd: root, encoding: 'utf8' }));
const { chromium } = createRequire(join(root, 'packages/agent-remote-lab/package.json'))('@playwright/test');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
const errors = [], failures = [], samples = [];
let requests = 0, sockets = 0;
try {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0, 300)); });
  page.on('pageerror', error => errors.push(`pageerror: ${error.message.slice(0, 300)}`));
  page.on('request', () => { requests++; });
  page.on('websocket', socket => { sockets++; socket.on('close', () => { sockets--; }); });
  page.on('response', response => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    failures.push(`${response.request().method()} ${url.pathname.replace(/[0-9a-f-]{20,}/g, ':id')} ${response.status()}`);
  });
  await page.goto(origin + '/?mode=bot', { waitUntil: 'domcontentloaded' });
  const rows = page.locator('nav[aria-label="Bots"] .lab-bot-section .lab-bot-row');
  await rows.first().waitFor();
  const names = (await rows.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).filter(Boolean).slice(0, 12);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const sample = async minute => {
    await cdp.send('HeapProfiler.collectGarbage');
    const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
    samples.push({ minute, heapMB: Math.round(metrics.JSHeapUsedSize / 1e4) / 100, nodes: metrics.Nodes, listeners: metrics.JSEventListeners, sockets, requests, errors: errors.length });
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify({ origin, bots: names.length, minutes, samples, errors: errors.slice(0, 50), failures: failures.slice(0, 100) }, null, 2));
  };
  const mode = async value => {
    const region = page.locator(`[data-workbench-mode="${value === 'bot' ? 'window' : 'bot'}"]`);
    if (value === 'bot') {
      const trigger = region.getByRole('button', { name: 'View options', exact: true });
      if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
      await region.getByRole('region', { name: 'View options', exact: true }).getByRole('button', { name: 'Bot mode', exact: true }).click();
    } else await region.getByRole('button', { name: 'Window mode', exact: true }).locator('visible=true').click();
    await page.locator(`[data-workbench-mode="${value}"]`).waitFor();
  };
  const started = Date.now(), elapsed = () => (Date.now() - started) / 60_000;
  let step = 0, nextSample = 0;
  while (elapsed() < minutes) {
    if (elapsed() >= nextSample) { await sample(Math.round(elapsed())); nextSample++; }
    await page.locator('nav[aria-label="Bots"] .lab-bot-section .lab-bot-row', { hasText: names[step % names.length] }).first().click();
    if (step % 12 === 11) { await mode('window'); await page.waitForTimeout(2_000); await mode('bot'); }
    step++;
    await page.waitForTimeout(10_000);
  }
  await sample(minutes);
  const settled = samples.find(item => item.minute >= Math.min(5, minutes)) ?? samples[0], last = samples.at(-1);
  console.log(JSON.stringify({ bots: names.length, minutes, settled, last, heapGrowth: +(last.heapMB / settled.heapMB).toFixed(2), nodeGrowth: +(last.nodes / settled.nodes).toFixed(2),
    maxSockets: Math.max(...samples.map(item => item.sockets)), errors: errors.length, failures: failures.length }));
} finally {
  for (const page of context.pages()) await page.close().catch(() => {});
  await context.request.post(origin + '/auth/logout', { headers: { origin, 'content-type': 'application/json' }, data: '{}', timeout: 10_000 }).catch(() => {});
  await browser.close();
}

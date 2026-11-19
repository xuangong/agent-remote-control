// Stage 6: switching bots on the `pnpm local` instance, measured in a headless browser (see README.md). Run from the
// repository root while the instance runs: node packages/agent-remote-lab/performance/local-switch.mjs [label]
// THROTTLE=4 adds a 4x CPU slowdown. ARC_ORIGIN opens the page at another origin (a latency proxy); SWITCH_LIMIT is the number of
// bots switched to (default 6). Prints one JSON line: roster load, idle main-thread time, and medians for switching to a bot for the
// first time (cold) and again (warm), with the HTTP API requests, the states that showed a T5 connection word and the states without
// rows between the click and the moment the conversation is shown.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { SESSION_CONNECTION_WORDS } from '@orchardworks/agent-e2e/faults/connection-words.mjs';
const root = process.cwd();
const origin = process.env.ARC_ORIGIN ?? JSON.parse(execFileSync('pnpm', ['--silent', 'local', 'status', '--json'], { cwd: root, encoding: 'utf8' })).origin;
const { chromium } = createRequire(join(root, 'packages/agent-remote-lab/package.json'))('@playwright/test');
const label = process.argv[2] ?? 'run';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
const results = [];
try {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const requests = [];
  page.on('request', request => { if (['xhr', 'fetch'].includes(request.resourceType())) requests.push(Date.now()); });
  await page.addInitScript(`(() => {
    const log = [];
    const OPENING = ${JSON.stringify(SESSION_CONNECTION_WORDS)};
    let last = '';
    const sample = () => {
      const conversation = document.querySelector('.lab-bot-conversation');
      const state = { opening: !!conversation && OPENING.some(text => conversation.textContent.includes(text)), rows: conversation ? conversation.querySelectorAll('.agent-timeline-entry').length : 0 };
      const key = JSON.stringify(state);
      if (key !== last) { last = key; log.push({ t: Date.now(), ...state }); }
    };
    const start = () => { new MutationObserver(() => setTimeout(sample, 0)).observe(document.documentElement, { subtree: true, childList: true, characterData: true }); sample(); };
    if (document.documentElement) start(); else document.addEventListener('readystatechange', start, { once: true });
    window.__switchLog = log;
  })();`);
  const started = Date.now();
  await page.goto(origin + '/?mode=bot', { waitUntil: 'domcontentloaded' });
  await page.locator('nav[aria-label="Bots"] .lab-bot-row').first().waitFor();
  const rosterMs = Date.now() - started;
  // Sessions without a bot binding sit in the collapsed "Other sessions" section.
  await page.evaluate(() => document.querySelectorAll('details.lab-bot-other').forEach(section => { section.open = true; }));
  await page.waitForTimeout(1000);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (process.env.THROTTLE) await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.THROTTLE) });
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
  const rows = page.locator('nav[aria-label="Bots"] .lab-bot-section .lab-bot-row');
  const names = (await rows.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).filter(Boolean).slice(0, Number(process.env.SWITCH_LIMIT ?? 6));
  // Settle: let the first conversations attach and the channels deliver their snapshots.
  await page.waitForTimeout(3000);
  const idleBefore = await metrics(); await page.waitForTimeout(10_000); const idleAfter = await metrics();
  const idle = { taskMs: Math.round((idleAfter.TaskDuration - idleBefore.TaskDuration) * 1000), scriptMs: Math.round((idleAfter.ScriptDuration - idleBefore.ScriptDuration) * 1000) };
  const order = [...names, ...names]; // the second pass switches to conversations opened before (warm)
  for (const [index, name] of order.entries()) {
    const before = await metrics(), clickAt = Date.now();
    await page.locator('nav[aria-label="Bots"] .lab-bot-row[aria-label=' + JSON.stringify(name) + ']').first().click();
    // Shown: the selected row is current and the conversation shows entries or its empty state.
    await page.waitForFunction(expected => {
      const current = document.querySelector('nav[aria-label="Bots"] .lab-bot-row[aria-current="true"]');
      if (current?.getAttribute('aria-label') !== expected) return false;
      const conversation = document.querySelector('.lab-bot-conversation');
      return !!conversation && (!!conversation.querySelector('.agent-timeline-entry') || !!conversation.querySelector('.lab-empty-state'));
    }, name);
    const shownMs = Date.now() - clickAt;
    await page.waitForTimeout(1500);
    const after = await metrics();
    const log = await page.evaluate(() => window.__switchLog.slice());
    const window_ = log.filter(entry => entry.t >= clickAt && entry.t <= clickAt + shownMs);
    results.push({ index, name, warm: index >= names.length, shownMs, httpApi: requests.filter(at => at >= clickAt && at <= clickAt + shownMs + 1500).length,
      openingStates: window_.filter(entry => entry.opening).length, rowlessStates: window_.filter(entry => entry.rows === 0).length, taskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000), scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000) });
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = kind => { const items = results.filter(item => item.warm === kind); return { shownMs: median(items.map(item => item.shownMs)), httpApi: median(items.map(item => item.httpApi)), openingStates: median(items.map(item => item.openingStates)), rowlessStates: median(items.map(item => item.rowlessStates)), taskMs: median(items.map(item => item.taskMs)), scriptMs: median(items.map(item => item.scriptMs)) }; };
  console.log(JSON.stringify({ label, bots: names.length, rosterMs, idle10s: idle, cold: summary(false), warm: summary(true), results }));
} finally {
  for (const page of context.pages()) await page.close().catch(() => {});
  await context.request.post(origin + '/auth/logout', { headers: { origin, 'content-type': 'application/json' }, data: '{}', timeout: 10_000 }).catch(() => {});
  await browser.close();
}

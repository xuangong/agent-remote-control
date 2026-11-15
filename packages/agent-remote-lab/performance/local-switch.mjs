// Stage 6: switching bots on the `pnpm local` instance, measured in a headless browser (see README.md). Run from the
// repository root while the instance runs: node packages/agent-remote-lab/performance/local-switch.mjs [label]
// THROTTLE=4 adds a 4x CPU slowdown. Prints one JSON line: roster load, idle main-thread time, and medians for
// switching to a bot for the first time (cold) and again (warm).
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const root = process.cwd();
const { origin } = JSON.parse(execFileSync('pnpm', ['--silent', 'local', 'status', '--json'], { cwd: root, encoding: 'utf8' }));
const { chromium } = createRequire(join(root, 'packages/agent-remote-lab/package.json'))('@playwright/test');
const label = process.argv[2] ?? 'run';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
const results = [];
try {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
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
  const names = (await rows.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).filter(Boolean).slice(0, 6);
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
    results.push({ index, warm: index >= names.length, shownMs, taskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000), scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000) });
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = kind => { const items = results.filter(item => item.warm === kind); return { shownMs: median(items.map(item => item.shownMs)), taskMs: median(items.map(item => item.taskMs)), scriptMs: median(items.map(item => item.scriptMs)) }; };
  console.log(JSON.stringify({ label, bots: names.length, rosterMs, idle10s: idle, cold: summary(false), warm: summary(true), results }));
} finally {
  for (const page of context.pages()) await page.close().catch(() => {});
  await context.request.post(origin + '/auth/logout', { headers: { origin, 'content-type': 'application/json' }, data: '{}', timeout: 10_000 }).catch(() => {});
  await browser.close();
}

import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const directory = resolve(process.argv[2] ?? '.tmp/performance-build');
const entry = process.argv[3] ?? 'performance/index.html';
const runs = Number(process.env.ARC_PERFORMANCE_RUNS ?? 5);
const instrumented = process.env.ARC_PERFORMANCE_COUNTERS === '1';
const rich = process.env.ARC_PERFORMANCE_RICH === '1';
const server = createServer(async (request, response) => {
  const path = resolve(directory, `.${new URL(request.url, 'http://localhost').pathname}`);
  if (!path.startsWith(`${directory}${sep}`)) { response.writeHead(403).end(); return; }
  try {
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' })[extname(path)] ?? 'application/octet-stream');
    response.end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
const deadline = setTimeout(() => { process.stderr.write('Performance benchmark deadline exceeded.\n'); process.exit(124); }, 240000);
try {
  for (const count of [100, 500, 1000]) for (let run = 0; run < runs; run++) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Performance.enable');
    if (instrumented) await page.addInitScript(() => {
      window.probe = { rects: 0, opens: 0, puts: 0 };
      const rect = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function (...args) { if (this.hasAttribute('data-entry-key')) window.probe.rects++; return rect.apply(this, args); };
      const open = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (...args) { window.probe.opens++; return open.apply(this, args); };
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) { window.probe.puts++; return put.apply(this, args); };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/${entry}?count=${count}${rich ? '&rich' : ''}`);
    const input = page.getByTestId('prompt-input');
    await input.waitFor();
    await page.waitForTimeout(400);
    await input.click();
    await page.waitForTimeout(100);
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
    const before = await metrics();
    if (instrumented) await page.evaluate(() => { window.probe = { rects: 0, opens: 0, puts: 0 }; });
    await page.keyboard.type('abcdefghijklmnopqrst', { delay: 70 });
    await page.waitForTimeout(300);
    const after = await metrics();
    const result = { count, run, taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
      scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000, nodes: await page.locator('*').count(),
      ...(instrumented ? await page.evaluate(() => window.probe) : {}) };
    results.push(result);
    process.stderr.write(`${JSON.stringify(result)}\n`);
    await context.close();
  }
  const medians = [100, 500, 1000].map(count => {
    const values = results.filter(result => result.count === count).map(result => result.taskMs).sort((a, b) => a - b);
    return { count, taskMs: values[Math.floor(values.length / 2)] };
  });
  process.stdout.write(`${JSON.stringify({ browser: browser.version(), runs, instrumented, rich, results, medians }, null, 2)}\n`);
} finally { clearTimeout(deadline); await browser.close(); server.close(); }

import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const directory = resolve(process.argv[2] ?? '.tmp/performance-build');
const runs = Number(process.env.ARC_PERFORMANCE_RUNS ?? 3);
const counts = (process.env.ARC_SCROLL_COUNTS ?? '100,1000,3000').split(',').map(Number);
const server = createServer(async (request, response) => {
  const path = resolve(directory, `.${new URL(request.url, 'http://localhost').pathname}`);
  if (!path.startsWith(directory + sep)) { response.writeHead(403).end(); return; }
  try {
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' })[extname(path)] ?? 'application/octet-stream');
    response.end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
const deadline = setTimeout(() => { process.stderr.write('Streaming benchmark deadline exceeded.\n'); process.exit(124); }, 300_000);
const results = [];
try {
  for (const count of counts) for (let run = 0; run < runs; run++) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(45_000);
      await page.goto(`http://127.0.0.1:${server.address().port}/performance/streaming.html?count=${count}`);
      await page.locator('.agent-timeline-entry').nth(count - 1).waitFor();
      const timeline = page.getByTestId('timeline');
      await timeline.dispatchEvent('wheel', { deltaY: -10 });
      await timeline.evaluate(element => { element.scrollTop = -(element.scrollHeight - element.clientHeight) / 2; element.dispatchEvent(new Event('scroll')); });
      await page.waitForTimeout(700);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await cdp.send('Performance.enable');
      const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
      await page.evaluate(() => {
        window.framesDuringStream = [];
        let previous;
        function tick(at) {
          if (previous) window.framesDuringStream.push(at - previous);
          previous = at;
          window.frameRequest = requestAnimationFrame(tick);
        }
        window.frameRequest = requestAnimationFrame(tick);
      });
      const before = await metrics(), started = Date.now();
      const stream = page.evaluate(() => window.startStream());
      const movements = [];
      for (const distance of [1800, -1800]) {
        const initial = await timeline.evaluate(element => element.scrollTop);
        await cdp.send('Input.synthesizeScrollGesture', { x: 190, y: 350, yDistance: distance, speed: 1400, gestureSourceType: 'touch', preventFling: true });
        const movement = await timeline.evaluate(element => element.scrollTop) - initial;
        if (Math.abs(movement) < 1000) throw new Error('The gesture did not scroll');
        movements.push(movement);
      }
      await stream;
      await page.waitForFunction(seq => document.querySelector('[data-next-seq]')?.getAttribute('data-next-seq') === String(seq), count + 41);
      const after = await metrics();
      const frames = await page.evaluate(() => { cancelAnimationFrame(window.frameRequest); return window.framesDuringStream; });
      frames.sort((a, b) => a - b);
      const result = { count, run, updates: 40, elapsedMs: Date.now() - started, movements,
        taskMs: (after.TaskDuration - before.TaskDuration) * 1000, scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
        layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000, styleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000,
        frameP95Ms: frames[Math.floor(frames.length * .95)], maxFrameMs: frames.at(-1) };
      results.push(result); process.stderr.write(JSON.stringify(result) + '\n');
    } finally { await context.close(); }
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const medians = counts.map(count => {
    const values = results.filter(result => result.count === count);
    return { count, ...Object.fromEntries(['taskMs', 'scriptMs', 'frameP95Ms', 'elapsedMs'].map(key => [key, median(values.map(result => result[key]))])) };
  });
  process.stdout.write(JSON.stringify({ browser: browser.version(), runs, cpuSlowdown: 4, viewport: { width: 390, height: 844 }, results, medians }, null, 2) + '\n');
} finally { clearTimeout(deadline); await browser.close(); server.close(); }

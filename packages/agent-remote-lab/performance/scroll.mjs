import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const directory = resolve(process.argv[2] ?? '.tmp/performance-build');
const runs = Number(process.env.ARC_PERFORMANCE_RUNS ?? 3);
const counts = (process.env.ARC_SCROLL_COUNTS ?? '100,1000,3000').split(',').map(Number);
const cpuSlowdown = 4;
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
const deadline = setTimeout(() => { process.stderr.write('Scroll benchmark deadline exceeded.\n'); process.exit(124); }, 300_000);
const results = [];
try {
  for (const count of counts) for (let run = 0; run < runs; run++) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(45_000);
      const cdp = await context.newCDPSession(page);
      await page.goto(`http://127.0.0.1:${server.address().port}/performance/index.html?count=${count}`);
      await page.locator('.agent-timeline-entry').nth(count - 1).waitFor();
      const timeline = page.getByTestId('timeline');
      await timeline.dispatchEvent('wheel', { deltaY: -10 });
      await timeline.evaluate(element => {
        element.scrollTop = -(element.scrollHeight - element.clientHeight) / 2;
        element.dispatchEvent(new Event('scroll'));
      });
      await page.waitForTimeout(700);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuSlowdown });
      await cdp.send('Performance.enable');
      const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
      for (const [direction, distance] of [['up', 1800], ['down', -1800]]) {
        const scrollBefore = await timeline.evaluate(element => element.scrollTop);
        await page.evaluate(() => {
          window.scrollFrames = [];
          cancelAnimationFrame(window.scrollFrameRequest);
          let previous;
          function tick(at) {
            if (previous) window.scrollFrames.push(at - previous);
            previous = at;
            window.scrollFrameRequest = requestAnimationFrame(tick);
          }
          window.scrollFrameRequest = requestAnimationFrame(tick);
        });
        const before = await metrics();
        await cdp.send('Input.synthesizeScrollGesture', { x: 190, y: 350, yDistance: distance, speed: 1400, gestureSourceType: 'touch', preventFling: true });
        const after = await metrics();
        const frames = await page.evaluate(() => { cancelAnimationFrame(window.scrollFrameRequest); return window.scrollFrames; });
        const scrollAfter = await timeline.evaluate(element => element.scrollTop);
        if (Math.abs(scrollAfter - scrollBefore) < 1000) throw new Error(`The ${direction} gesture did not scroll the timeline`);
        frames.sort((a, b) => a - b);
        const result = { count, run, direction, scrollBefore, scrollAfter,
          taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
          scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
          layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
          styleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000,
          frames: frames.length, frameP95Ms: frames[Math.floor(frames.length * .95)], maxFrameMs: frames.at(-1) };
        results.push(result);
        process.stderr.write(JSON.stringify(result) + '\n');
      }
    } finally { await context.close(); }
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const medians = counts.flatMap(count => ['up', 'down'].map(direction => {
    const values = results.filter(result => result.count === count && result.direction === direction);
    return { count, direction, taskMs: median(values.map(result => result.taskMs)), scriptMs: median(values.map(result => result.scriptMs)), frameP95Ms: median(values.map(result => result.frameP95Ms)) };
  }));
  process.stdout.write(JSON.stringify({ browser: browser.version(), runs, cpuSlowdown, viewport: { width: 390, height: 844 }, results, medians }, null, 2) + '\n');
} finally { clearTimeout(deadline); await browser.close(); server.close(); }

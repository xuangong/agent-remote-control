import { chromium, webkit } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

// Experimental only: no containment styles are enabled by the application.
const directory = resolve('.tmp/performance-build');
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const path = resolve(directory, `.${url.pathname}`);
  if (!path.startsWith(directory + sep)) { response.writeHead(403).end(); return; }
  try {
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' })[extname(path)] ?? 'application/octet-stream');
    let content = await readFile(path);
    if (path.endsWith('.html') && url.searchParams.has('containment')) {
      content = Buffer.from(content.toString().replace('</head>', '<style>.agent-timeline-entry { content-visibility: auto; contain-intrinsic-size: auto 360px; }</style></head>'));
    }
    response.end(content);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const deadline = setTimeout(() => { process.stderr.write('Containment probe deadline exceeded.\n'); process.exit(124); }, 180_000);
const results = [];
try {
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch();
    try {
      for (const containment of [false, true]) {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        page.setDefaultTimeout(30_000);
        await page.goto(`http://127.0.0.1:${server.address().port}/performance/streaming.html?count=1000${containment ? '&containment=1' : ''}`);
        await page.locator('.agent-timeline-entry').nth(999).waitFor({ state: 'attached' });
        const timeline = page.getByTestId('timeline');
        await timeline.dispatchEvent('wheel', { deltaY: -10 });
        await timeline.evaluate(element => { element.scrollTop = -(element.scrollHeight - element.clientHeight) / 2; element.dispatchEvent(new Event('scroll')); });
        await page.waitForTimeout(800);
        const before = await timeline.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          for (let y = bounds.top + 40; y < bounds.bottom - 40; y += 20) {
            const node = document.elementFromPoint(bounds.left + 100, y)?.closest('.agent-markdown p, .agent-markdown li');
            if (!node) continue;
            window.containmentAnchor = node;
            return { top: node.getBoundingClientRect().top, text: node.textContent, height: element.scrollHeight };
          }
          throw new Error('No readable anchor in the viewport');
        });
        await page.setViewportSize({ width: 844, height: 390 });
        await page.waitForTimeout(800);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(800);
        const after = await timeline.evaluate(element => ({ top: window.containmentAnchor.getBoundingClientRect().top, height: element.scrollHeight }));
        const result = { engine, browser: browser.version(), containment, count: 1000, before, after, anchorDriftPx: after.top - before.top };
        results.push(result);
        process.stderr.write(JSON.stringify({ ...result, before: { ...before, text: undefined } }) + '\n');
        await page.close();
      }
    } finally { await browser.close(); }
  }
  process.stdout.write(JSON.stringify({ results }, null, 2) + '\n');
} finally { clearTimeout(deadline); server.close(); }

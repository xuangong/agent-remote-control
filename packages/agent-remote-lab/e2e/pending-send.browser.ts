import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit, expect as browserExpect } from '@playwright/test';
import { expect, it } from 'vitest';

for (const engine of [chromium, webkit]) for (const width of [402, 1280]) {
  it(`keeps pending messages above an editable composer in ${engine.name()} at ${width}px`, async () => {
    const source = `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { createReplicaState } from '@orchardworks/agent-remote-web';
      import { LabWorkbench } from './components/LabWorkbench.tsx';
      const state = { ...createReplicaState(), agent: {
        id: 'one', providerId: 'test', status: 'idle', activeTurn: null, createdAt: '', updatedAt: '',
        capabilities: { sendMessage: true, history: true, steer: false, cancel: false, readResource: false },
        pendingInteractions: [], runtimeInfo: { providerId: 'test', status: 'idle' },
      } };
      window.sent = [];
      function View() {
        const [status, setStatus] = useState('disconnected');
        window.recover = () => setStatus('ready');
        return <LabWorkbench state={state} sessionStatus={status} actions={{ sendMessage: async text => { window.sent.push(text); } }} />;
      }
      createRoot(document.getElementById('root')).render(<View />);
    `;
    const bundled = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) },
      bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
    const css = (await Promise.all(['../../agent-remote-web/src/styles.css', '../src/app.css'].map(path => readFile(new URL(path, import.meta.url), 'utf8')))).join('\n').replace(/^@import.*$/gm, '');
    const server = createServer((request, response) => {
      response.setHeader('content-type', request.url === '/fixture.js' ? 'application/javascript' : 'text/html');
      response.end(request.url === '/fixture.js' ? bundled.outputFiles[0]!.text : `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n#root { height: 100dvh; }</style><div id="root"></div><script src="/fixture.js"></script>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width, height: 812 }, hasTouch: width < 500 });
      page.setDefaultTimeout(5000);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
      await page.waitForLoadState('networkidle');
      expect(errors).toEqual([]);
      const input = page.getByRole('textbox', { name: 'Message', exact: true });
      for (const text of ['Please check the reconnect logs and summarize the findings.', 'OK', 'Finally explain the result.']) {
        await input.fill(text);
        await input.press('Enter');
        await browserExpect(input).toHaveValue('');
      }
      await input.fill('Keep editing while the network recovers');
      await browserExpect(page.locator('[data-testid="pending-send"]')).toHaveCount(3);
      await browserExpect(page.locator('.agent-pending-state')).toHaveCount(0);
      const geometry = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const queue = box('.agent-pending-queue'), composer = box('.agent-composer'), toggle = box('.lab-composer-toggle');
        const messages = document.querySelectorAll('.agent-pending-message');
        const shortText = messages[1]!.querySelector('.agent-pending-text')!.getBoundingClientRect();
        const dismiss = messages[1]!.querySelector('.agent-pending-dismiss span')!.getBoundingClientRect();
        return { overflow: document.documentElement.scrollWidth > innerWidth, above: queue.bottom <= composer.top, beside: queue.right < toggle.left,
          longWidth: messages[0]!.getBoundingClientRect().width, shortWidth: messages[1]!.getBoundingClientRect().width,
          dismissGap: dismiss.left - shortText.right, inputGap: composer.top - shortText.bottom };

      });
      expect(geometry).toMatchObject({ overflow: false, above: true, beside: true });
      expect(geometry.longWidth).toBeLessThanOrEqual(240);
      expect(geometry.shortWidth).toBeLessThan(70);
      expect(geometry.dismissGap).toBeGreaterThanOrEqual(0);
      expect(geometry.dismissGap).toBeLessThanOrEqual(6);
      expect(geometry.inputGap).toBeGreaterThanOrEqual(0);
      expect(geometry.inputGap).toBeLessThanOrEqual(6);
      await page.getByRole('button', { name: 'Cancel pending send', exact: true }).first().click();
      await browserExpect(input).toHaveValue('Keep editing while the network recovers');
      const output = fileURLToPath(new URL('../test-results/pending-send/', import.meta.url));
      await mkdir(output, { recursive: true });
      await page.screenshot({ path: `${output}${engine.name()}-${width}.png`, fullPage: true });
      await page.evaluate(() => (window as unknown as { recover(): void }).recover());
      await browserExpect(page.locator('[data-testid="pending-send"]')).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as { sent: string[] }).sent)).toEqual(['OK', 'Finally explain the result.']);
      await browserExpect(input).toHaveValue('Keep editing while the network recovers');
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 15000);
}

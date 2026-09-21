import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from '@playwright/test';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { onPreviewCleanup, previewFixture } from '../src/server/preview-tunnel-fixture.js';

for (const engine of [chromium, webkit]) for (const width of [390, 1280]) {
  it(`preserves Markdown image space through delayed bytes and decode failure in ${engine.name()} at ${width}px`, async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'arc-image-layout-')));
    onPreviewCleanup(() => rm(workspace, { recursive: true, force: true }));
    const png = await readFile(new URL('./fixtures/markdown-wide.png', import.meta.url));
    await writeFile(join(workspace, 'wide.png'), png);
    await writeFile(join(workspace, 'broken.png'), png.subarray(0, 33));
    const css = await readFile(new URL('../../agent-remote-web/src/styles.css', import.meta.url), 'utf8');
    let browserScript = '';
    const fixture = await previewFixture({ workspace, servePage: async (request, response) => {
      if (request.url === '/image-test.js') { response.setHeader('content-type', 'application/javascript'); response.end(browserScript); return true; }
      if (request.url === '/image-test') {
        response.setHeader('content-type', 'text/html');
        response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/image-test.js"></script>`);
        return true;
      }
      return false;
    } });
    const source = `
      import React, { useMemo, useState, useSyncExternalStore } from 'react';
      import { createRoot } from 'react-dom/client';
      import { AgentReplica, HttpWebSocketTransport, RemoteSessionClient } from '@orchardworks/agent-remote-web/headless';
      import { MarkdownContent } from '../../agent-remote-web/src/react/MarkdownContent.tsx';
      const replica = new AgentReplica();
      const client = new RemoteSessionClient(${JSON.stringify(fixture.agentId)}, new HttpWebSocketTransport(${JSON.stringify(fixture.url + fixture.alice.basePath)}), replica);
      const resolveResource = (locator, source) => client.resolveResource(locator, source);
      const requestResource = binding => client.requestResource(binding.resourceId);
      function View() {
        const state = useSyncExternalStore(callback => replica.subscribe(callback), () => replica.getState());
        const [file, setFile] = useState('wide.png');
        window.showBroken = () => setFile('broken.png');
        const context = useMemo(() => ({ scopeKey: state.agent.id, bindings: [], resources: state.resources, resolveResource, requestResource }), [state.resources]);
        return <><MarkdownContent markdown={'![Layout fixture](./' + file + ')'} resourceContext={context} /><p id="after">Text below the image must stay in place.</p></>;
      }
      const root = createRoot(document.getElementById('root'));
      client.subscribeStatus(status => { if (status === 'ready') root.render(<View />); });
      client.start();
    `;
    const bundled = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) },
      bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
    browserScript = bundled.outputFiles[0]!.text;
    const browser = await engine.launch({ headless: true });
    onPreviewCleanup(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    page.setDefaultTimeout(10_000);
    const separator = fixture.alice.cookie.indexOf('=');
    await page.context().addCookies([{ name: fixture.alice.cookie.slice(0, separator), value: fixture.alice.cookie.slice(separator + 1), url: fixture.url, httpOnly: true, sameSite: 'Strict' }]);
    const deliveries: Array<() => void> = [];
    const metadata: unknown[] = [];
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket(/.*/, route => {
      const server = route.connectToServer();
      server.onMessage(message => {
        const value = JSON.parse(message.toString());
        if (value.type === 'resource_resolve_response') metadata.push(value.payload.state);
        if (value.type === 'resource_response') deliveries.push(() => route.send(message));
        else route.send(message);
      });
    });
    await page.goto(fixture.url + '/image-test');
    await page.waitForLoadState('networkidle');
    await expect.poll(() => deliveries.length).toBe(1);
    expect(metadata[0]).toMatchObject({ imageDimensions: { width: 1200, height: 600 } });
    expect(metadata[0]).not.toHaveProperty('contentBase64');
    const frame = page.locator('.agent-markdown-image');
    expect(await frame.getAttribute('data-image-state')).toBe('loading');
    const before = await frame.boundingBox();
    const afterText = await page.locator('#after').boundingBox();
    expect(before!.height).toBeGreaterThan(100);
    expect(before!.height).toBeLessThanOrEqual(560);
    expect(before!.width / before!.height).toBeCloseTo(2);
    expect(await frame.locator('img').count()).toBe(0);
    await page.screenshot({ path: join(tmpdir(), `arc-image-loading-${engine.name()}-${width}.png`) });
    deliveries.shift()!();
    await page.waitForFunction(() => document.querySelector('[data-image-state="loaded"]'));
    expect(await frame.boundingBox()).toEqual(before);
    expect(await page.locator('#after').boundingBox()).toEqual(afterText);
    expect(await frame.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1200);
    await page.evaluate(() => (window as any).showBroken());
    await expect.poll(() => deliveries.length).toBe(1);
    const failureBefore = await frame.boundingBox();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await frame.evaluate(node => getComputedStyle(node, '::before').animationName)).toBe('none');
    deliveries.shift()!();
    await page.waitForFunction(() => document.querySelector('[data-image-state="failed"]'));
    expect(await frame.boundingBox()).toEqual(failureBefore);
    expect(await page.locator('#after').boundingBox()).toEqual(afterText);
    expect(await frame.innerText()).toContain('Image unavailable');
    expect(await frame.evaluate(node => getComputedStyle(node, '::before').animationName)).toBe('none');
    await page.screenshot({ path: join(tmpdir(), `arc-image-failed-${engine.name()}-${width}.png`) });
    expect(errors).toEqual([]);
  });
}

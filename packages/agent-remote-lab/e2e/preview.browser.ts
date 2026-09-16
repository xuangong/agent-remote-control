import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { expect, it } from 'vitest';
import { onPreviewCleanup, previewFixture } from '../src/server/preview-tunnel-fixture.js';

it('loads a prefixed Vite page through the authenticated tunnel and receives a real hot update', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-preview-vite-')));
  onPreviewCleanup(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<!doctype html><html><body><h1 id="status">Loading</h1><script type="module" src="./main.js"></script></body></html>');
  await writeFile(join(root, 'payload.js'), 'export default "Preview ready";');
  await writeFile(join(root, 'main.js'), 'import text from "./payload.js";document.querySelector("#status").textContent=text;if(import.meta.hot)import.meta.hot.accept("./payload.js",module=>{document.querySelector("#status").textContent=module.default;});');
  let vite = await createServer({ configFile: false, root, server: { host: '127.0.0.1', port: 0 } });
  onPreviewCleanup(() => vite.close());
  await vite.listen();
  const vitePort = (vite.httpServer!.address() as import('node:net').AddressInfo).port;
  const f = await previewFixture({ target: `http://127.0.0.1:${vitePort}`, pathMode: 'preserve' });
  await vite.close();
  vite = await createServer({ configFile: false, root, base: `/p/${f.registration.id}/`, server: { host: '127.0.0.1', port: vitePort, strictPort: true,
    hmr: { protocol: 'ws', host: 'localhost', clientPort: f.port }, cors: { origin: f.previewOrigin } } });
  await vite.listen();
  const browser = await chromium.launch({ headless: true }); onPreviewCleanup(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(10_000);
  const errors: string[] = []; const sockets: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => sockets.push(socket.url()));
  await page.goto(await f.entryUrl('/'));
  await page.waitForLoadState('networkidle');
  expect(await page.locator('#status').innerText()).toBe('Preview ready');
  await writeFile(join(root, 'payload.js'), 'export default "Hot reload confirmed";');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Hot reload confirmed');
  expect(errors).toEqual([]);
  expect(sockets.some(url => url.startsWith(f.previewOrigin.replace('http:', 'ws:') + '/p/' + f.registration.id))).toBe(true);
});

it('renders a local Markdown image from actual authorized session resource frames without filesystem HTTP requests', async () => {
  const { build } = await import('esbuild');
  const { fileURLToPath } = await import('node:url');
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'arc-markdown-browser-')));
  onPreviewCleanup(() => rm(workspace, { recursive: true, force: true }));
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=';
  await writeFile(join(workspace, 'result.png'), Buffer.from(png, 'base64'));
  let browserScript = '';
  const f = await previewFixture({ workspace, servePage: async (request, response) => {
    if(request.url === '/markdown-fixture.js') { response.setHeader('content-type', 'application/javascript'); response.end(browserScript); return true; }
    if(request.url === '/markdown-fixture') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><div id="root">Loading</div><script src="/markdown-fixture.js"></script>'); return true; }
    return false;
  } });
  const source = `
    import React, { useMemo, useSyncExternalStore } from 'react';
    import { createRoot } from 'react-dom/client';
    import { AgentReplica, HttpWebSocketTransport, RemoteSessionClient } from '@agent-remote-controller/agent-remote-web/headless';
    import { MarkdownContent } from '../../agent-remote-web/src/react/MarkdownContent.tsx';
    const replica = new AgentReplica();
    const client = new RemoteSessionClient(${JSON.stringify(f.agentId)}, new HttpWebSocketTransport(${JSON.stringify(f.url + f.alice.basePath)}), replica);
    const resolveResource = (locator,source) => client.resolveResource(locator,source);
    const requestResource = binding => client.requestResource(binding.resourceId);
    function View() {
      const state = useSyncExternalStore(callback => replica.subscribe(callback), () => replica.getState());
      const context = useMemo(() => ({ scopeKey: state.agent.id, bindings: [], resources: state.resources, resolveResource, requestResource }), [state.resources]);
      return <MarkdownContent markdown={'![Local result](./result.png)'} resourceContext={context} />;
    }
    const root = createRoot(document.getElementById('root'));
    client.subscribeStatus(status => { window.fixtureStatus = status; if(status === 'ready') root.render(<View />); });
    client.start();
  `;
  const bundled = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) }, bundle: true, write: false,
    format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
  browserScript = bundled.outputFiles[0]!.text;
  const browser = await chromium.launch({ headless: true }); onPreviewCleanup(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(10_000);
  const separator = f.alice.cookie.indexOf('=');
  await page.context().addCookies([{ name: f.alice.cookie.slice(0, separator), value: f.alice.cookie.slice(separator + 1), url: f.url, httpOnly: true, sameSite: 'Strict' }]);
  const urls: string[] = []; const frames: string[] = []; const errors: string[] = [];
  page.on('request', request => urls.push(request.url()));
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => socket.on('framesent', frame => { if(typeof frame.payload === 'string') frames.push(JSON.parse(frame.payload).type); }));
  await page.goto(f.url + '/markdown-fixture');
  try { await page.waitForFunction(() => { const image = document.querySelector('img'); return image?.complete && image.naturalWidth === 1; }); } catch (error) { console.error({ errors, frames, urls, status: await page.evaluate(() => (window as any).fixtureStatus), body: await page.locator('body').innerText() }); throw error; }
  expect(await page.locator('img').getAttribute('src')).toBe('data:image/png;base64,' + png);
  expect(frames).toContain('resource_resolve_request'); expect(frames).toContain('resource_request');
  expect(urls.some(url => url.includes('/result.png') || url.includes(workspace))).toBe(false);
  expect(errors).toEqual([]);
});

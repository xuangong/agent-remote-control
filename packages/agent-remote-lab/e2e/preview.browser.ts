import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from '@playwright/test';
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
    hmr: { protocol: 'ws', host: new URL(f.previewOrigin).hostname, clientPort: f.port }, cors: { origin: f.previewOrigin } } });
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

for (const engine of [chromium, webkit]) it(`keeps authenticated preview navigation inside the workbench in ${engine.name()}`, async () => {
  const { build } = await import('esbuild');
  const { fileURLToPath } = await import('node:url');
  const { readFile } = await import('node:fs/promises');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-embedded-preview-')));
  onPreviewCleanup(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), `<!doctype html><h1>Local application</h1><input aria-label="Application draft"><a href="./next.html" target="_blank">Next page</a><a href="#one">One</a><a href="#two">Two</a><a href="https://external.test/">External</a><button onclick="history.pushState({},'', '?view=details');document.querySelector('h1').textContent='Details'">Details</button>`);
  await writeFile(join(root, 'next.html'), '<!doctype html><h1>Next page</h1>');
  const vite = await createServer({ configFile: false, root, server: { host: '127.0.0.1', port: 0, hmr: false } });
  onPreviewCleanup(() => vite.close()); await vite.listen();
  const port = (vite.httpServer!.address() as import('node:net').AddressInfo).port;
  let browserScript = '';
  const css = await readFile(new URL('../../agent-remote-web/src/styles.css', import.meta.url), 'utf8');
  const f = await previewFixture({ target: `http://127.0.0.1:${port}`, servePage: async (request, response) => {
    if (request.url === '/workbench.js') { response.setHeader('content-type', 'application/javascript'); response.end(browserScript); return true; }
    if (request.url === '/workbench') { response.setHeader('content-type', 'text/html'); response.setHeader('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'self' https://external.test"); response.end(`<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${css}</style><div id="root"></div><script src="/workbench.js"></script>`); return true; }
    return false;
  } });
  const source = `
    import React, {useState} from 'react';import {createRoot} from 'react-dom/client';
    import {PreviewProvider,usePreviewController,PreviewDock} from '../../agent-remote-web/src/react/PreviewContext.tsx';
    import {PreviewActions} from '../../agent-remote-web/src/react/PreviewActions.tsx';
    import {HttpPreviewClient} from '../../agent-remote-web/src/client/preview-client.ts';
    function View(){const controller=usePreviewController();const [other,setOther]=useState(false);const sessionId=other?'another-session':${JSON.stringify(f.agentId)};return <><button onClick={()=>setOther(!other)}>Switch session</button><PreviewDock sessionId={sessionId}/><textarea aria-label="Chat draft" defaultValue="Unsent message"/><PreviewActions controller={controller} agentId={sessionId} itemId="message-1" text=${JSON.stringify(f.target + '/')} /></>;}
    createRoot(document.getElementById('root')).render(<PreviewProvider client={new HttpPreviewClient(${JSON.stringify(f.url + f.alice.basePath)})} hostId=${JSON.stringify(f.hostId)} canManage><View/></PreviewProvider>);
  `;
  browserScript = (await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) }, bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })).outputFiles[0]!.text;
  const browser = await engine.launch({ headless: true }); onPreviewCleanup(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...(engine === webkit ? { isMobile: true, hasTouch: true } : {}) });
  const separator = f.alice.cookie.indexOf('=');
  await context.addCookies([{ name: f.alice.cookie.slice(0, separator), value: f.alice.cookie.slice(separator + 1), url: f.url, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(f.url + '/workbench');
  await page.locator('.agent-preview-open').click();
  const frame = page.frameLocator('dialog[open] iframe[title="Local preview"]');
  await frame.getByRole('heading', { name: 'Local application' }).waitFor();
  await frame.getByRole('textbox', { name: 'Application draft' }).fill('Keep this preview state');
  const previewWindow = page.frames().find(item => item.url().includes('/p/'))!;
  await previewWindow.evaluate(() => { (window as any).previewIdentity = 'retained-document'; document.body.style.minHeight = '1800px'; window.scrollTo(0, 300); });
  const shrinking = await page.evaluate(async () => {
    (document.querySelector('[aria-label="Minimize preview"]') as HTMLButtonElement).click();
    await new Promise(requestAnimationFrame);
    const dialog = document.querySelector('dialog')!;
    const animation = dialog.getAnimations()[0];
    if (!animation) return undefined;
    animation.pause(); animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
    return dialog.getBoundingClientRect().width;
  });
  expect(shrinking).toBeGreaterThan(0); expect(shrinking).toBeLessThan(390);
  await page.evaluate(() => document.querySelector('dialog')!.getAnimations().forEach(animation => animation.play()));
  await page.getByRole('dialog', { name: 'Local preview browser' }).waitFor({ state: 'hidden' });
  expect(await page.locator('iframe').count()).toBe(1);
  await page.screenshot({ path: fileURLToPath(new URL('../../../.tmp/preview-docked-' + engine.name() + '.png', import.meta.url)) });
  await page.getByRole('textbox', { name: 'Chat draft' }).fill('Continue adjusting');
  await page.getByRole('button', { name: /^Resume preview:/ }).click();
  await frame.getByRole('heading', { name: 'Local application' }).waitFor();
  expect(await frame.getByRole('textbox', { name: 'Application draft' }).inputValue()).toBe('Keep this preview state');
  expect(await previewWindow.evaluate(() => (window as any).previewIdentity)).toBe('retained-document');
  expect(await previewWindow.evaluate(() => window.scrollY)).toBe(300);
  await page.getByRole('button', { name: 'Minimize preview', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('textbox', { name: 'Chat draft' }).fill('Unsent message');
  await page.getByRole('button', { name: 'Switch session', exact: true }).click();
  expect(await page.getByRole('button', { name: /^Resume preview:/ }).count()).toBe(0);
  await page.locator('.agent-preview-open').click();
  await frame.getByRole('textbox', { name: 'Application draft' }).fill('Another session');
  expect(await page.locator('iframe').count()).toBe(2);
  await page.getByRole('button', { name: 'Minimize preview', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Switch session', exact: true }).click();
  await page.getByRole('button', { name: /^Resume preview:/ }).click();
  expect(await frame.getByRole('textbox', { name: 'Application draft' }).inputValue()).toBe('Keep this preview state');
  expect(await previewWindow.evaluate(() => (window as any).previewIdentity)).toBe('retained-document');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Minimize preview', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  expect(await page.evaluate(() => document.getAnimations().filter(item => item.playState === 'running').length)).toBe(0);
  await page.getByRole('button', { name: 'Switch session', exact: true }).click();
  await page.getByRole('button', { name: /^Close preview:/ }).click();
  expect(await page.locator('iframe').count()).toBe(1);
  await page.getByRole('button', { name: 'Switch session', exact: true }).click();
  await page.getByRole('button', { name: /^Resume preview:/ }).click();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await page.getByRole('button', { name: 'Back', exact: true }).isDisabled()).toBe(true);
  await frame.getByRole('link', { name: 'Next page' }).click();
  await frame.getByRole('heading', { name: 'Next page' }).waitFor();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await frame.getByRole('heading', { name: 'Local application' }).waitFor();
  await page.getByRole('button', { name: 'Forward', exact: true }).click();
  await frame.getByRole('heading', { name: 'Next page' }).waitFor();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await frame.getByRole('button', { name: 'Details', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Preview address"]')?.textContent?.includes('?view=details'));
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await frame.getByRole('heading', { name: 'Local application' }).waitFor();
  await page.getByRole('button', { name: 'Reload preview', exact: true }).click();
  await frame.getByRole('heading', { name: 'Local application' }).waitFor();
  await frame.getByRole('link', { name: 'One', exact: true }).click();
  await frame.getByRole('link', { name: 'Two', exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Preview address"]')?.textContent?.endsWith('#one') && !document.querySelector('[aria-label="Forward"]')?.hasAttribute('disabled'));
  await page.getByRole('button', { name: 'Forward', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Preview address"]')?.textContent?.endsWith('#two') && !document.querySelector('[aria-label="Back"]')?.hasAttribute('disabled'));
  expect(context.pages()).toHaveLength(1); expect(page.url()).toBe(f.url + '/workbench');
  const bounds = await page.getByRole('dialog', { name: 'Local preview browser' }).boundingBox();
  expect(bounds?.width).toBeCloseTo(390, 0); expect(bounds?.height).toBeCloseTo(844, 0);
  await page.screenshot({ path: fileURLToPath(new URL('../../../.tmp/preview-' + engine.name() + '.png', import.meta.url)) });
  if (engine === chromium) {
    await page.setViewportSize({ width: 1440, height: 900 });
    expect((await page.getByRole('dialog').boundingBox())?.width).toBe(960);
    await page.getByRole('button', { name: 'Expand preview', exact: true }).click();
    expect((await page.getByRole('dialog').boundingBox())?.width).toBe(1440);
    await page.getByRole('button', { name: 'Restore preview size', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  expect(await page.locator('iframe').count()).toBe(0);
  expect(await page.getByRole('textbox', { name: 'Chat draft' }).inputValue()).toBe('Unsent message');
  expect(await page.locator('.agent-preview-open').evaluate(element => element === document.activeElement)).toBe(true);
  await page.route('https://external.test/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>External page</h1>' }));
  await page.locator('.agent-preview-open').click();
  await frame.getByRole('link', { name: 'External', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'left the preview origin' }).waitFor();
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  expect(await page.getByRole('textbox', { name: 'Chat draft' }).inputValue()).toBe('Unsent message');
  await page.route('**/_arc/enter', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
  await page.locator('.agent-preview-open').click();
  await page.getByRole('alert').filter({ hasText: 'expired or is unavailable' }).waitFor();
  expect(await page.locator('iframe').count()).toBe(0);
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await page.unroute('**/_arc/enter');
  await page.locator('.agent-preview-open').click();
  await frame.getByRole('heading', { name: 'Local application' }).waitFor();
  await f.alice.request(`v1/remote/hosts/${f.hostId}/previews/${f.registration.id}/unregister`, {});
  await page.getByRole('alert').filter({ hasText: 'unregistered' }).waitFor();
  expect(await page.locator('iframe').count()).toBe(0);
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await page.getByRole('button', { name: 'Open preview', exact: true }).click();
  await frame.getByRole('heading', { name: 'Local application' }).waitFor();
  expect(context.pages()).toHaveLength(1);
  expect(errors).toEqual([]);
});

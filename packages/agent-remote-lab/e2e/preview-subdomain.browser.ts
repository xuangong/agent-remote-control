import { createServer as createTlsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, rm, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { controllerContentSecurityPolicy } from '@agent-remote-controller/agent-remote-hosted';
import { onPreviewCleanup, previewFixture } from '../src/server/preview-tunnel-fixture.js';

it('opens a root-mounted React Vite app with isolated login, manifest, API, navigation and HMR', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-root-vite-')));
  onPreviewCleanup(() => rm(root, { recursive: true, force: true }));
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'));
  await writeFile(join(root, 'index.html'), '<!doctype html><html><head><link rel="manifest" href="/manifest.json"></head><body><div id="root"></div><script type="module" src="/main.jsx"></script></body></html>');
  await writeFile(join(root, 'payload.js'), 'export default "Root preview ready";');
  await writeFile(join(root, 'main.jsx'), `import React from 'react'; import {createRoot} from 'react-dom/client'; import text from '/payload.js';
    createRoot(document.getElementById('root')).render(<><h1>{text}</h1><button onClick={()=>history.pushState(null,'','/docs?q=1')}>Docs</button></>);
    fetch('/api').then(r=>r.json()).then(r=>document.body.dataset.api=r.ok);
    if(import.meta.hot)import.meta.hot.accept('/payload.js',m=>document.querySelector('h1').textContent=m.default);`);
  const cookies: string[] = [];
  const vite = await createServer({ configFile: false, root, plugins: [react(), { name: 'fixture-api', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url === '/api') { cookies.push(request.headers.cookie ?? ''); response.setHeader('content-type', 'application/json'); response.setHeader('set-cookie', 'app=ready; Path=/; SameSite=Strict'); response.end('{"ok":true}'); }
      else if (request.url === '/manifest.json') { response.setHeader('content-type', 'application/manifest+json'); response.end('{"name":"Preview","start_url":"/"}'); }
      else next();
    });
  } }], server: { host: '127.0.0.1', port: 0 } });
  onPreviewCleanup(() => vite.close()); await vite.listen();
  const vitePort = (vite.httpServer!.address() as import('node:net').AddressInfo).port;
  // Terminate test TLS locally while preserving the real browser origins and Strict cookies.
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem'), '-subj', '/CN=arc.test', '-days', '1']);
  let backendPort = 0;
  const tls = createTlsServer({ key: await readFile(join(root, 'key.pem')), cert: await readFile(join(root, 'cert.pem')) }, (request, response) => {
    const upstream = httpRequest({ hostname: '127.0.0.1', port: backendPort, path: request.url, method: request.method, headers: request.headers }, incoming => {
      response.writeHead(incoming.statusCode!, incoming.headers); incoming.pipe(response);
    }); upstream.on('error', () => response.destroy()); request.pipe(upstream);
  });
  tls.on('upgrade', (request, socket, head) => {
    const upstream = httpRequest({ hostname: '127.0.0.1', port: backendPort, path: request.url, headers: request.headers });
    upstream.on('upgrade', (response, peer, remainder) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(response.headers).map(([name, value]) => name + ': ' + value).join('\r\n') + '\r\n\r\n');
      if (head.length) peer.write(head); if (remainder.length) socket.write(remainder);
      socket.pipe(peer); peer.pipe(socket); socket.on('error', () => peer.destroy()); peer.on('error', () => socket.destroy());
    }); upstream.on('error', () => socket.destroy()); upstream.end();
  });
  await new Promise<void>(resolve => tls.listen(0, '127.0.0.1', resolve));
  onPreviewCleanup(async () => { tls.closeAllConnections(); await new Promise<void>(resolve => tls.close(() => resolve())); });
  const tlsPort = (tls.address() as import('node:net').AddressInfo).port;
  let script = ''; let policy = '';
  const f = await previewFixture({ controlOrigin: `https://agents.arc.test:${tlsPort}`, previewDomain: 'arc.test', target: `http://127.0.0.1:${vitePort}`,
    servePage: async (request, response) => {
      if (request.url === '/fixture.js') { response.setHeader('content-type', 'text/javascript'); response.end(script); return true; }
      if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.setHeader('content-security-policy', policy); response.end('<!doctype html><div id="root"></div><script src="/fixture.js"></script>'); return true; }
      return false;
    } });
  backendPort = f.port;
  policy = controllerContentSecurityPolicy(f.url, 'arc.test');
  const bundle = await build({ stdin: { contents: `import React,{useState} from 'react';import{createRoot}from'react-dom/client';
    import{HttpPreviewClient}from'../../agent-remote-web/src/client/preview-client.ts';
    import{PreviewBrowser}from'../../agent-remote-web/src/react/PreviewBrowser.tsx';
    const client=new HttpPreviewClient(${JSON.stringify(f.url + f.alice.basePath)});
    function App(){const[url,setUrl]=useState();return <><button onClick={async()=>{try{setUrl(await client.enter(await client.open(${JSON.stringify(f.hostId)},${JSON.stringify(f.registration.id)},${JSON.stringify(f.target + '/')}),${JSON.stringify(f.registration.id)}))}catch(e){document.body.dataset.error=e.message}}}>Open tunnel</button>{url&&<PreviewBrowser url={url} target="Local app" visible browserKey="fixture" onClose={()=>setUrl(undefined)} onMinimize={()=>{}}/>}</>};createRoot(document.getElementById('root')).render(<App/>);`,
    loader: 'tsx', resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) }, bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
  script = bundle.outputFiles[0]!.text;
  const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP *.arc.test 127.0.0.1', '--no-proxy-server'] });
  onPreviewCleanup(() => browser.close()); const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const separator = f.alice.cookie.indexOf('=');
  await context.addCookies([{ name: f.alice.cookie.slice(0, separator), value: f.alice.cookie.slice(separator + 1), url: f.url, httpOnly: true, sameSite: 'Strict', secure: true }]);
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const failures: string[] = []; const errors: string[] = [];
  page.on('response', r => { if (r.status() >= 400) failures.push(r.url() + ': ' + r.status()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(f.url); await page.getByText('Open tunnel', { exact: true }).click();
  const frame = page.frameLocator('iframe');
  try { await frame.locator('h1').waitFor(); } catch (error) { console.error({ errors, failures, body: await page.locator('body').innerText(), message: await page.locator('body').getAttribute('data-error') }); throw error; }
  expect(await frame.locator('h1').innerText()).toBe('Root preview ready');
  await page.waitForFunction(() => document.querySelector('.agent-preview-browser-content')?.getAttribute('aria-busy') === 'false');
  const target = new URL(page.frames()[1]!.url()).origin;
  expect(target).toMatch(/https:\/\/t-[a-f0-9]{48}\.arc\.test:/);
  await page.frames()[1]!.waitForFunction(() => document.body.dataset.api === 'true');
  expect(cookies.every(cookie => !cookie.includes('arc_'))).toBe(true);
  await frame.getByText('Docs', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.agent-preview-mapped-address')?.textContent?.endsWith('/docs?q=1'));
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.agent-preview-mapped-address')?.textContent?.includes('/docs'));
  await frame.locator('h1').waitFor();
  await writeFile(join(root, 'payload.js'), 'export default "HMR confirmed";');
  await page.frames()[1]!.waitForFunction(() => document.querySelector('h1')?.textContent === 'HMR confirmed');
  const manifest = await page.frames()[1]!.evaluate(async () => (await fetch('/manifest.json', { credentials: 'include' })).status);
  expect(manifest).toBe(200); expect(failures).toEqual([]); expect(errors).toEqual([]);
  const direct = await browser.newContext({ ignoreHTTPSErrors: true });
  await direct.addCookies([{ name: f.alice.cookie.slice(0, separator), value: f.alice.cookie.slice(separator + 1), url: f.url, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  const directPage = await direct.newPage(); await directPage.goto(target + '/docs');
  await directPage.locator('h1').waitFor(); expect(directPage.url()).toBe(target + '/docs');
  await direct.close();
  expect((await f.fetch(target + '/api')).status).toBe(401);
  const navigation = await f.fetch(target + '/', { headers: { 'sec-fetch-dest': 'document' }, redirect: 'manual' });
  expect(navigation.status).toBe(303);
  const control = await f.fetch(navigation.headers.get('location')!, { redirect: 'manual' });
  expect(control.status).toBe(303); expect(control.headers.get('location')).toContain('/auth/login?');
}, 30000);

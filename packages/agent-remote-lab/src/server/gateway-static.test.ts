// @vitest-environment node
import { mkdtemp, cp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, URL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createGatewayStaticPages } from './gateway-static.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of close.splice(0)) await action(); });

it('serves public install assets through the Docker static handler without exposing source files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-static-'));
  close.push(() => rm(root, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('../..', import.meta.url));
  await cp(join(source, 'public'), root, { recursive: true });
  await copyFile(join(source, 'index.html'), join(root, 'index.html'));
  const serve = await createGatewayStaticPages(root);
  const server = createServer((request, response) => {
    void serve(request, response).then((handled) => { if (!handled) { response.writeHead(404); response.end(); } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  close.push(() => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  const base = `http://127.0.0.1:${address.port}`;
  expect((await fetch(base + '/src/App.tsx')).status).toBe(404);
  const manifest = await fetch(base + '/app/manifest.webmanifest');
  expect(manifest.headers.get('content-type')).toBe('application/manifest+json');
  const value = await manifest.json();
  expect(value.display).toBe('standalone');
  for (const icon of value.icons) {
    const response = await fetch(base + icon.src);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(100);
  }
  const index = await fetch(base);
  expect(await index.text()).toContain('/app/manifest.webmanifest');
});

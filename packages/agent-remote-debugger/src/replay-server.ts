import { serveRecordingFiles } from './recording-files.js';
import { access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localRequestAllowed, serveAssets } from './local-web.js';
import type { SessionRecording } from './recording.js';

/** A read-only file viewer. No provider, Relay, or control transport is instantiated. */
export async function createReplayServer(options: { recording: SessionRecording; name: string; port?: number; assetsDirectory?: string; directory?: string }) {
  const assets = resolve(options.assetsDirectory ?? fileURLToPath(new URL('./web', import.meta.url)));
  await access(join(assets, 'index.html'));
  const body = JSON.stringify(options.recording);
  let url = '';
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      if (!localRequestAllowed(request, url)) { response.writeHead(403).end(); return; }
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
      if (await serveRecordingFiles(request, response, url, options.directory ?? process.cwd())) return;
      const path = new URL(request.url ?? '/', url).pathname;
      const data = path === '/__ardb/session' ? JSON.stringify({ mode: 'replay', name: options.name })
        : path === '/__ardb/recording' ? body : undefined;
      if (data !== undefined) {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(request.method === 'HEAD' ? undefined : data); return;
      }
      await serveAssets(request, response, assets, path);
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => { server.removeListener('error', reject); done(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Replay server did not bind a TCP port.');
  url = `http://127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  return { url, close: () => closing ??= new Promise<void>((done, reject) => {
    server.close(error => error ? reject(error) : done()); server.closeAllConnections();
  }) };
}

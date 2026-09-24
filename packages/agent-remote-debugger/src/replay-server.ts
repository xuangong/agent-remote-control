import { serveRecordingFiles } from './recording-files.js';
import { access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localRequestAllowed, serveAssets } from './local-web.js';
import type { SessionRecording } from './recording.js';
import { createDebuggerServer, type DebuggerAdapter } from './server.js';
import { loadAdapter } from './load-adapter.js';
import { readLocalJson } from './live-recording.js';

/** Replay and live share one local entry point; the native runtime is created only on request. */
export async function createReplayServer(options: {
  recording?: SessionRecording; name?: string; port?: number; assetsDirectory?: string; directory?: string;
  executable?: string; startupTimeout?: number;
  loadProvider?(provider: string, executable?: string): Promise<DebuggerAdapter>;
  onLiveReady?(live: Awaited<ReturnType<typeof createDebuggerServer>>): Promise<void>;
  onBrowserEvent?(record: Record<string, unknown>): void;
}) {
  const assets = resolve(options.assetsDirectory ?? fileURLToPath(new URL('./web', import.meta.url)));
  await access(join(assets, 'index.html'));
  const body = JSON.stringify(options.recording);
  const directory = resolve(options.directory ?? process.cwd());
  let url = '';
  let live: Awaited<ReturnType<typeof createDebuggerServer>> | undefined;
  let pending: Promise<void> | undefined;
  let startup: AbortController | undefined;
  let closing: Promise<void> | undefined;
  let selection: string | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      if (!localRequestAllowed(request, url)) { response.writeHead(403).end(); return; }
      const path = new URL(request.url ?? '/', url).pathname;
      const json = (value: unknown) => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
      if (path === '/__ardb/live/start' && request.method === 'POST') {
        const config = await readLocalJson(request, url);
        if (Object.keys(config).some(key => !['provider', 'cwd', 'executable'].includes(key))
          || typeof config.provider !== 'string' || !['codex', 'claude', 'copilot'].includes(config.provider)
          || typeof config.cwd !== 'string' || !config.cwd.trim()
          || (config.executable !== undefined && typeof config.executable !== 'string')) {
          throw Object.assign(new Error('Choose a supported provider and a server working directory.'), { status: 400 });
        }
        const provider = config.provider;
        const cwd = resolve(config.cwd);
        const executable = typeof config.executable === 'string' && config.executable.trim() ? config.executable.trim() : options.executable;
        const key = JSON.stringify({ provider, cwd, executable });
        if (closing) throw new Error('ARDB is closing.');
        if ((pending || live) && selection !== key) throw new Error('A live session is already opening or running. Return to it instead.');
        if (!pending && !live) {
          selection = key;
          const abort = startup = new AbortController();
          pending = (async () => {
            const timer = setTimeout(() => abort.abort(new Error('Provider startup timed out.')), options.startupTimeout ?? 30000);
            try {
              const adapter = await (options.loadProvider ?? ((id, binary) => loadAdapter(id, undefined, binary)))(provider, executable);
              live = await createDebuggerServer({ adapter, origin: url, config: { cwd }, signal: abort.signal, assetsDirectory: assets, onBrowserEvent: options.onBrowserEvent });
              try { await options.onLiveReady?.(live); }
              catch (error) { await live.close(); live = undefined; throw error; }
            } finally { clearTimeout(timer); }
          })();
        }
        try { await pending; } finally { pending = undefined; }
        json(live!.session); return;
      }
      if (path === '/__ardb/session' && request.method === 'GET') {
        json({ mode: options.recording ? 'replay' : 'workspace', name: options.name, directory, executable: options.executable, live: live?.session }); return;
      }
      if (path === '/__ardb/initial-recording' && request.method === 'GET') {
        response.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' }).end(body); return;
      }
      if (live) { live.httpServer.emit('request', request, response); return; }
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
      if (await serveRecordingFiles(request, response, url, directory)) return;
      if (path === '/__ardb/recording' && body) {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(request.method === 'HEAD' ? undefined : body); return;
      }
      await serveAssets(request, response, assets, path);
    })().catch(error => {
      if (!response.headersSent) response.writeHead(error.status ?? 409, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unable to start live session.' }));
    });
  });
  server.on('upgrade', (request, socket, head) => {
    if (live && localRequestAllowed(request, url)) live.httpServer.emit('upgrade', request, socket, head);
    else socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => { server.removeListener('error', reject); done(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('ARDB server did not bind a TCP port.');
  url = `http://127.0.0.1:${address.port}`;
  return { url, close: () => closing ??= (async () => {
    startup?.abort(new Error('ARDB server is closing.'));
    try { await pending; } catch { /* Startup owns cleanup of a failed provider. */ }
    try { await live?.close(); } finally {
      await new Promise<void>((done, reject) => {
        server.close(error => error ? reject(error) : done()); server.closeAllConnections();
      });
    }
  })() };
}

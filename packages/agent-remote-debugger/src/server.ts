import { serveRecordingFiles } from './recording-files.js';
import { LiveRecording, serveCapture } from './live-recording.js';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentPersistenceHandle, AgentProviderAdapter, AgentSessionConfig } from '@orchardworks/agent-provider-sdk';
import { PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import { createAgentRemoteHttpServer, createAgentRemoteRelay, InputImageStore } from '@orchardworks/agent-remote-relay';

import { localRequestAllowed, serveAssets } from './local-web.js';
import { ownAdapter } from './owned-adapter.js';

export type DebuggerAdapter = AgentProviderAdapter & { dispose?(): Promise<void> };
export interface DebuggerServerOptions {
  adapter: DebuggerAdapter;
  config?: Partial<AgentSessionConfig>;
  persistence?: AgentPersistenceHandle;
  port?: number;
  signal?: AbortSignal;
  assetsDirectory?: string;
  onBrowserEvent?(record: Record<string, unknown>): void;
}

/** Owns one session; browser reloads and headless clients only attach to it. */
export async function createDebuggerServer(options: DebuggerServerOptions) {
  const owned = ownAdapter(options.adapter);
  const assets = resolve(options.assetsDirectory ?? fileURLToPath(new URL('./web', import.meta.url)));
  let directory: string;
  try {
    options.signal?.throwIfAborted();
    await access(join(assets, 'index.html'));
    directory = await mkdtemp(join(tmpdir(), 'ardb-images-'));
  } catch (error) { await owned.close(); throw error; }
  const relay = createAgentRemoteRelay({ providers: [owned.adapter], inputImageStore: new InputImageStore({ directory }) });
  const agentId = randomUUID();
  let url = '';
  const capture = new LiveRecording(agentId, () => url);
  let closed: Promise<void> | undefined;
  const allowed = (request: IncomingMessage) => localRequestAllowed(request, url);
  const http = createAgentRemoteHttpServer(relay, {
    accessPolicy: { authorize: allowed },
    websocketAuthorizer: {
      authenticate: request => allowed(request) && request.headers.origin === url ? { subject: 'ardb-local' } : undefined,
      authorize: ({ principal, agentId: requestedId }) => principal.subject === 'ardb-local' && requestedId === agentId,
    },
    mutationPolicy: { validate: () => ({ status: 'rejected', httpStatus: 403, code: 'ardb_session_owned', message: 'ARDB owns this session. Start another server to create or resume another session.' }) },
  });
  const publicListeners = http.server.listeners('request');
  http.server.removeAllListeners('request');
  let session: { agentId: string; providerId: string; nativeSessionId: string; title: string } | undefined;
  http.server.on('request', (request, response) => {
    void route(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  async function route(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (!allowed(request)) { response.writeHead(403).end(); return; }
    const path = new URL(request.url ?? '/', url).pathname;
    if (path === '/__ardb/session' && request.method === 'GET') {
      response.writeHead(session ? 200 : 503, { 'Content-Type': 'application/json' }).end(JSON.stringify(session ?? { error: 'starting' })); return;
    }
    if (await serveRecordingFiles(request, response, url, resolve(options.config?.cwd ?? process.cwd()))) return;
    if (await serveCapture(request, response, url, capture)) return;
    if (path === '/__ardb/events' && request.method === 'POST') {
      if (request.headers.origin !== url || request.headers['content-type'] !== 'application/json') { response.writeHead(403).end(); return; }
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 64 * 1024) { response.writeHead(413).end(); return; }
      }
      let records: unknown;
      try { records = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
      if (!Array.isArray(records) || records.length > 64) { response.writeHead(400).end(); return; }
      for (const value of records) {
        // Whitelisted metadata only; browser-provided payloads never become trusted protocol records.
        if (!value || typeof value !== 'object') continue;
        const record: Record<string, unknown> = { kind: 'browser_trace', source: 'browser', agentId, receivedAt: new Date().toISOString() };
        for (const key of ['clientId', 'timestamp', 'event', 'direction', 'channel', 'messageType', 'requestId', 'status', 'code']) {
          if (typeof value[key] === 'string') record[key] = value[key].slice(0, 256);
        }
        if (Number.isSafeInteger(value.dropped) && value.dropped >= 0) record.dropped = value.dropped;
        capture.append(record);
        try { options.onBrowserEvent?.(record); } catch { /* Diagnostics cannot change a public operation. */ }
      }
      response.writeHead(204).end(); return;
    }
    if (path.startsWith('/v1/')) {
      for (const listener of publicListeners) listener.call(http.server, request, response);
      return;
    }
    await serveAssets(request, response, assets, path);
  }
  function close(): Promise<void> {
    return closed ??= (async () => {
      options.signal?.removeEventListener('abort', onAbort);
      capture.close();
      try { await http.close(); }
      finally {
        try { await relay.close(); }
        finally { try { await owned.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
      }
    })();
  }
  let rejectAborted: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
  void aborted.catch(() => undefined);
  const onAbort = () => rejectAborted(options.signal?.reason ?? new Error('ARDB startup interrupted.'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    url = (await http.listen(options.port ?? 0)).url;
    const opening = options.persistence
      ? relay.resumeAgent({ protocolVersion: PROTOCOL_VERSION, type: 'resume_agent', payload: { requestId: randomUUID(), agentId, persistence: options.persistence } })
      : relay.createAgent({ protocolVersion: PROTOCOL_VERSION, type: 'create_agent', payload: { requestId: randomUUID(), operationId: randomUUID(), agentId, providerId: options.adapter.descriptor.providerId, config: { ...options.config, sessionId: options.config?.sessionId ?? randomUUID() } } });
    const result = await Promise.race([opening, aborted]);
    // Once ready, the command owns shutdown; startup cancellation no longer applies.
    options.signal?.removeEventListener('abort', onAbort);
    session = { agentId, providerId: result.payload.providerId, nativeSessionId: result.payload.sessionId, title: 'ARDB Session View' };
    return { url, agentId, session, close };
  } catch (error) { await close(); throw error; }
}

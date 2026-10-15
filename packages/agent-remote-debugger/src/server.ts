import { serveRecordingFiles } from './recording-files.js';
import { LiveRecording, serveCapture, readLocalJson } from './live-recording.js';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, rm, readFile, realpath } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentPersistenceHandle, AgentSessionConfig } from '@orchardworks/agent-provider-sdk';
import { PROTOCOL_VERSION, nativeSessionRefKey } from '@orchardworks/agent-remote-protocol';
import { createAgentRemoteHttpServer, createAgentRemoteRelay, InputImageStore, InputResourceStore } from '@orchardworks/agent-remote-relay';

import { localRequestAllowed, serveAssets } from './local-web.js';
import { ownAdapter } from './owned-adapter.js';
import { LocalSessionSuccession, publishSuccessionState, type LocalSuccessionProvider } from './local-session-succession.js';
import type { NativeSessionRef } from '@orchardworks/agent-remote-protocol';

export type DebuggerAdapter = LocalSuccessionProvider & { dispose?(): Promise<void> };
export interface DebuggerSession { agentId: string; providerId: string; nativeSessionId: string; title: string }
export interface DebuggerServerOptions {
  adapter: DebuggerAdapter;
  config?: Partial<AgentSessionConfig>;
  persistence?: AgentPersistenceHandle;
  port?: number;
  /** Serve through an existing local listener, keeping the public protocol unchanged. */
  origin?: string;
  signal?: AbortSignal;
  assetsDirectory?: string;
  resourceDirectory?: string;
  /** One durable owned-session scope. Reuse this directory to restore the exact current session. */
  successionStateDirectory?: string;
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
  const stateDirectory = resolve(options.successionStateDirectory ?? join(homedir(), '.agent-remote-control', 'ardb-successions', options.persistence?.sessionId ? createHash('sha256').update(JSON.stringify(options.persistence)).digest('hex') : options.config?.sessionId ? createHash('sha256').update(JSON.stringify([options.adapter.descriptor.providerId, options.config.sessionId])).digest('hex') : randomUUID()));
  const local = new LocalSessionSuccession(stateDirectory, `ardb-${createHash('sha256').update(stateDirectory).digest('hex')}`, [owned.adapter]);
  const relay = createAgentRemoteRelay({ providers: local.providers, operationCache: local.operationCache, operationLifecycle: local.operationLifecycle, inputResourceStore: new InputResourceStore({directory:options.resourceDirectory ?? join(homedir(), '.agent-remote-control', 'ardb-input-resources')}), inputImageStore: new InputImageStore({ directory }) });
  local.bindRelay(relay);
  let agentId: string = randomUUID();
  const historicalAgents = new Set<string>();
  let ownedOrigin: NativeSessionRef | undefined;
  let url = '';
  let capture = new LiveRecording(agentId, () => url);
  const recordings = new Map<string, LiveRecording>();
  let closed: Promise<void> | undefined;
  const allowed = (request: IncomingMessage) => localRequestAllowed(request, url);
  const http = createAgentRemoteHttpServer(relay, {
    accessPolicy: { authorize: allowed },
    websocketAuthorizer: {
      authenticate: request => allowed(request) && request.headers.origin === url ? { subject: 'ardb-local' } : undefined,
      authorize: ({ principal, agentId: requestedId }) => principal.subject === 'ardb-local' && (requestedId === agentId || historicalAgents.has(requestedId)),
    },
    mutationPolicy: { validate: () => ({ status: 'rejected', httpStatus: 403, code: 'ardb_session_owned', message: 'ARDB owns this session. Start another server to create or resume another session.' }) },
  });
  const publicListeners = http.server.listeners('request');
  http.server.removeAllListeners('request');
  let session: DebuggerSession | undefined;
  const sessionListeners = new Set<(session: DebuggerSession) => Promise<void>>();
  http.server.on('request', (request, response) => {
    void route(request, response).catch(error => { if (!response.headersSent) response.writeHead(error.status ?? 409, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Local operation failed.' })); });
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
    if (path === '/v1/session-successions' || path.startsWith('/v1/session-successions/')) {
      if (request.method !== 'GET') { response.writeHead(405).end(); return; }
      if (!ownedOrigin) throw Object.assign(new Error('Owned session is starting.'), { status: 503 });
      await local.service.ready;
      const result = local.replay.read(path, new URL(request.url ?? '/', url).searchParams, ownedOrigin);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result)); return;
    }
    if (path === '/__ardb/history' && request.method === 'GET') {
      if (!ownedOrigin) throw new Error('Owned session is starting.');
      const role = local.service.store.all().find(state => nativeSessionRefKey(state.role.origin) === nativeSessionRefKey(ownedOrigin!))?.role;
      if (!role) throw Object.assign(new Error('Owned history is unavailable.'), { status: 403 });
      const requested = new URL(request.url ?? '/', url).searchParams.get('nativeSessionId');
      const source = local.replay.historical(role.id, local.ref(role.origin.providerId, requested ?? ''), ownedOrigin);
      const historicalId = await local.attach(source); historicalAgents.add(historicalId);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ agentId: historicalId, providerId: source.providerId, nativeSessionId: source.nativeSessionId })); return;
    }
    if (path.startsWith('/__ardb/succession/')) {
      if (request.method !== 'POST') { response.writeHead(405).end(); return; }
      const body = await readLocalJson(request, url), action = path.slice('/__ardb/succession/'.length);
      if (!ownedOrigin || action === 'describe' && body.agentId !== agentId) throw Object.assign(new Error('Session is outside the owned current role.'), { status: 403 });
      const role = await local.ensureRole(ownedOrigin);
      const result = await local.action(action, body, role);
      // Committed durable state is authoritative even when an earlier response was lost.
      const current = local.service.store.read(role.id).role.current;
      await selectCurrent(current);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result)); return;
    }
    if (await serveRecordingFiles(request, response, url, resolve(options.config?.cwd ?? process.cwd()))) return;
    const recordingId = new URL(request.url ?? '/', url).searchParams.get('id');
    if (await serveCapture(request, response, url, recordingId && recordings.has(recordingId) ? recordings.get(recordingId)! : capture)) return;
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
  async function selectCurrent(ref: NativeSessionRef) {
    if (session?.providerId === ref.providerId && session.nativeSessionId === ref.nativeSessionId) return;
    const next = await local.attach(ref);
    if (session?.providerId === ref.providerId && session.nativeSessionId === ref.nativeSessionId) return;
    if (session) historicalAgents.add(agentId);
    capture.close();
    const previousId = capture.status().id; if (previousId) recordings.set(previousId, capture);
    agentId = next;
    capture = new LiveRecording(agentId, () => url);
    session = { agentId, providerId: ref.providerId, nativeSessionId: ref.nativeSessionId, title: 'ARDB Session View' };
    for (const listener of sessionListeners) {
      try { await listener(session); } catch { /* A diagnostic observer cannot undo a committed native selection. */ }
    }
  }
  function close(): Promise<void> {
    return closed ??= (async () => {
      options.signal?.removeEventListener('abort', onAbort);
      capture.close();
      sessionListeners.clear();
      for (const recording of recordings.values()) recording.close();
      try { await http.close(); }
      finally {
        try { try { await local.close(); } finally { await relay.close(); } }
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
    url = options.origin ?? (await http.listen(options.port ?? 0)).url;
    await local.service.ready;
    let saved: { version: number; origin: NativeSessionRef } | undefined;
    try { saved = JSON.parse(await readFile(join(stateDirectory, 'owned-session.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (saved) {
      if (saved.version !== 1 || saved.origin.controllerId !== local.controllerId || saved.origin.providerId !== options.adapter.descriptor.providerId
        || options.persistence && options.persistence.sessionId !== saved.origin.nativeSessionId) throw new Error('Succession state belongs to another owned session.');
      ownedOrigin = saved.origin;
      const role = await local.ensureRole(ownedOrigin);
      if (options.config?.cwd && await realpath(options.config.cwd) !== role.workspace.canonicalCwd) throw new Error('Succession workspace changed.');
      await Promise.race([selectCurrent(role.current), aborted]);
    } else {
      const opening = options.persistence
        ? relay.resumeAgent({ protocolVersion: PROTOCOL_VERSION, type: 'resume_agent', payload: { requestId: randomUUID(), agentId, persistence: options.persistence } })
        : relay.createAgent({ protocolVersion: PROTOCOL_VERSION, type: 'create_agent', payload: { requestId: randomUUID(), operationId: randomUUID(), agentId, providerId: options.adapter.descriptor.providerId, config: { cwd: process.cwd(), ...options.config, sessionId: options.config?.sessionId ?? randomUUID() } } });
      const result = await Promise.race([opening, aborted]);
      ownedOrigin = local.agentRef(agentId);
      session = { agentId, providerId: result.payload.providerId, nativeSessionId: result.payload.sessionId, title: 'ARDB Session View' };
      const info = relay.requireAgent(agentId).snapshot().payload.runtimeInfo;
      if (info.persistence && info.cwd) await publishSuccessionState(stateDirectory, 'owned-session.json', { version: 1, origin: ownedOrigin });
    }
    // Once ready, the command owns shutdown; startup cancellation no longer applies.
    options.signal?.removeEventListener('abort', onAbort);
    return { url, successionStateDirectory: stateDirectory, get agentId() { return agentId; }, get session() { return session!; },
      onSessionChanged(listener: (session: DebuggerSession) => Promise<void>) { sessionListeners.add(listener); return () => { sessionListeners.delete(listener); }; },
      close, httpServer: http.server };
  } catch (error) { await close(); throw error; }
}

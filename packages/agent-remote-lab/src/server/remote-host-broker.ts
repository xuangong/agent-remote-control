import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { decodeRemoteHostUplinkMessage, type RemoteHostUplinkMessage } from '@borgee/agent-remote-protocol';
import { createLocalLabMutationPolicy } from './local-authorizer.js';

type RpcResponse = { status: number; body: string };
type Host = {
  id: string; installationId: string; name: string; generation: number; socket?: WebSocket;
  pending: Map<string, { resolve(value: RpcResponse): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>;
  streams: Map<string, { socket: WebSocket; ready: boolean; buffered: string[]; timer?: ReturnType<typeof setTimeout> }>;
};
type Binding = { hostId: string; nativeSessionId: string; agentId: string; generation: number; recovery?: Promise<void> };
class BrokerError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function createRemoteHostBroker(options: { origin: string; rpcTimeoutMs?: number; keyLifetimeMs?: number }) {
  const origin = new URL(options.origin).origin;
  const keys = new Map<string, { expires: number; installationId?: string }>();
  const hosts = new Map<string, Host>();
  const bindings = new Map<string, Binding>();
  const attached = new Map<string, Promise<Binding>>();
  const creations = new Map<string, { fingerprint: string; result: Promise<Binding> }>();
  const websockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  const keyHash = (key: string) => createHash('sha256').update(key).digest('hex');
  const requireHost = (id: string) => {
    const host = hosts.get(id);
    if (!host) throw new BrokerError(404, 'host_not_found', 'The Remote Host is unknown.');
    if (host.socket?.readyState !== WebSocket.OPEN) throw new BrokerError(503, 'host_offline', 'The Remote Host is offline.');
    return host;
  };
  function send(host: Host, message: RemoteHostUplinkMessage) {
    if (host.socket?.readyState !== WebSocket.OPEN) throw new BrokerError(503, 'host_offline', 'The Remote Host is offline.');
    if (host.socket.bufferedAmount > 8 * 1024 * 1024) throw new BrokerError(503, 'host_backpressure', 'The Remote Host connection is busy.');
    host.socket.send(JSON.stringify(message));
  }
  function rpc(host: Host, method: 'GET' | 'POST', path: string, sessionId?: string, body?: string): Promise<RpcResponse> {
    if (host.pending.size >= 128) return Promise.reject(new BrokerError(429, 'host_busy', 'Too many pending Remote Host requests.'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        host.pending.delete(requestId);
        try { send(host, { uplinkVersion: 2, type: 'rpc_cancel', requestId }); } catch { /* An offline host has no request to cancel. */ }
        reject(new BrokerError(504, 'host_timeout', 'The Remote Host did not answer; the operation outcome may be unknown.'));
      }, options.rpcTimeoutMs ?? 30_000);
      host.pending.set(requestId, { resolve, reject, timer });
      try { send(host, { uplinkVersion: 2, type: 'rpc_request', requestId, method, path, ...(sessionId ? { sessionId } : {}), ...(body === undefined ? {} : { body }) }); }
      catch (error) { clearTimeout(timer); host.pending.delete(requestId); reject(error); }
    });
  }
  function disconnected(host: Host, socket: WebSocket) {
    if (host.socket !== socket) return;
    host.socket = undefined;
    for (const pending of host.pending.values()) { clearTimeout(pending.timer); pending.reject(new BrokerError(503, 'host_offline', 'The Remote Host disconnected; the operation outcome may be unknown.')); }
    host.pending.clear();
    for (const stream of host.streams.values()) stream.socket.close(1012, 'Remote Host disconnected');
    host.streams.clear();
  }
  function register(socket: WebSocket, credential: { expires: number; installationId?: string }) {
    let host: Host | undefined;
    const timer = setTimeout(() => socket.close(1008, 'Registration deadline exceeded'), 10_000);
    socket.on('error', () => undefined);
    socket.on('close', () => { clearTimeout(timer); if (host) disconnected(host, socket); });
    socket.on('message', (raw, binary) => {
      const decoded = binary ? undefined : decodeRemoteHostUplinkMessage(raw.toString());
      if (!decoded || decoded.status !== 'ok') return socket.close(1008, 'Invalid uplink envelope');
      const message = decoded.value;
      if (!host) {
        if (message.type !== 'register' || credential.expires <= Date.now() || (credential.installationId && credential.installationId !== message.installationId)) return socket.close(1008, 'Registration is not authorized');
        credential.installationId = message.installationId;
        host = [...hosts.values()].find((value) => value.installationId === message.installationId);
        if (!host) {
          if (hosts.size >= 128) return socket.close(1013, 'Host capacity reached');
          host = { id: randomUUID(), installationId: message.installationId, name: message.name, generation: 0, pending: new Map(), streams: new Map() };
          hosts.set(host.id, host);
        }
        if (host.socket) { const previous = host.socket; disconnected(host, previous); previous.close(1012, 'Host connection replaced'); }
        host.socket = socket; host.name = message.name; host.generation += 1; clearTimeout(timer);
        send(host, { uplinkVersion: 2, type: 'registered', hostId: host.id }); return;
      }
      if (host.socket !== socket) return;
      if (message.type === 'rpc_response') {
        const pending = host.pending.get(message.requestId);
        if (pending) { clearTimeout(pending.timer); host.pending.delete(message.requestId); pending.resolve(message); }
      } else if (message.type === 'stream_opened') {
        const stream = host.streams.get(message.streamId);
        if (stream) { clearTimeout(stream.timer); stream.ready = true; for (const buffered of stream.buffered) send(host, { uplinkVersion: 2, type: 'stream_message', streamId: message.streamId, message: buffered }); stream.buffered = []; }
      } else if (message.type === 'stream_message') {
        const stream = host.streams.get(message.streamId);
        if (stream?.socket.readyState === WebSocket.OPEN) {
          if (stream.socket.bufferedAmount > 8 * 1024 * 1024) stream.socket.close(1013, 'Slow browser connection');
          else stream.socket.send(message.message);
        }
      } else if (message.type === 'stream_close') {
        const stream = host.streams.get(message.streamId); host.streams.delete(message.streamId); stream?.socket.close(message.code, message.reason);
      } else socket.close(1008, 'Unexpected uplink message');
    });
  }
  async function recoverBinding(host: Host, binding: Binding): Promise<void> {
    if (binding.generation === host.generation) return;
    if (!binding.recovery) {
      const generation = host.generation;
      binding.recovery = (async () => {
        const result = await rpc(host, 'POST', '/remote/attach', binding.agentId, JSON.stringify({ nativeSessionId: binding.nativeSessionId }));
        if (result.status >= 300) throw new BrokerError(result.status, 'session_unavailable', 'The native session could not be reattached after the host reconnected.');
        if (host.generation !== generation) throw new BrokerError(503, 'host_reconnected', 'The Remote Host changed while the session was reattaching.');
        binding.generation = generation;
      })();
      void binding.recovery.finally(() => { binding.recovery = undefined; }).catch(() => undefined);
    }
    await binding.recovery;
  }
  async function mutate(host: Host, action: string, body: Record<string, unknown>): Promise<Binding> {
    if (action === 'create' && ['cwd', 'model', 'reasoningEffort', 'planning'].some((key) => body[key] !== undefined)) {
      throw new BrokerError(400, 'unsupported_configuration', 'This Host uses native model settings and a registered workspace.');
    }
    if (bindings.size >= 4096) throw new BrokerError(429, 'capacity_exceeded', 'The local session binding registry is full.');
    const nativeSessionId = action === 'attach' ? required(body.nativeSessionId, 'nativeSessionId') : randomUUID();
    const key = JSON.stringify([host.id, action === 'create' ? required(body.requestId, 'requestId') : nativeSessionId]);
    const operation = async () => {
      const agentId = randomUUID();
      const request = { nativeSessionId, ...(body.workspaceId === undefined ? {} : { workspaceId: required(body.workspaceId, 'workspaceId') }) };
      const result = await rpc(host, 'POST', `/remote/${action}`, agentId, JSON.stringify(request));
      if (result.status >= 300) {
        let detail: Record<string, unknown> = {};
        try { detail = JSON.parse(result.body); } catch { /* Preserve the status if the host did not return JSON. */ }
        throw new BrokerError(result.status, typeof detail.code === 'string' ? detail.code : 'host_rejected', typeof detail.error === 'string' ? detail.error : 'The Remote Host rejected the operation.');
      }
      const binding = { hostId: host.id, nativeSessionId, agentId, generation: host.generation };
      bindings.set(agentId, binding);
      attached.set(JSON.stringify([host.id, nativeSessionId]), Promise.resolve(binding));
      return binding;
    };
    if (action === 'attach') {
      let result = attached.get(key);
      if (!result) { result = operation(); attached.set(key, result); void result.catch(() => attached.delete(key)); }
      const binding = await result; await recoverBinding(host, binding); return binding;
    }
    const fingerprint = JSON.stringify({ workspaceId: body.workspaceId ?? null });
    let existing = creations.get(key);
    if (existing && existing.fingerprint !== fingerprint) throw new BrokerError(409, 'request_conflict', 'This request identity was already used with different settings.');
    if (!existing) {
      if (creations.size >= 4096) throw new BrokerError(429, 'capacity_exceeded', 'The local creation ledger is full.');
      existing = { fingerprint, result: operation() }; creations.set(key, existing);
    }
    return existing.result;
  }
  async function handle(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (!local(request, origin)) throw new BrokerError(403, 'forbidden', 'This endpoint is available only to the local application.');
    response.setHeader('cache-control', 'no-store');
    if (request.method === 'POST') {
      const access = createLocalLabMutationPolicy(origin).validate(request);
      if (access.status === 'rejected') throw new BrokerError(access.httpStatus, access.code, access.message);
    }
    if (url.pathname === '/v1/remote/hosts' && request.method === 'GET') return json(response, 200, { hosts: [...hosts.values()].map(({ id, name, socket }) => ({ id, name, providerId: 'dsh', online: socket?.readyState === WebSocket.OPEN })) });
    if (url.pathname === '/v1/remote/pairings' && request.method === 'POST') {
      await readBody(request);
      for (const [hash, value] of keys) if (value.expires <= Date.now()) keys.delete(hash);
      if (keys.size >= 128) throw new BrokerError(429, 'capacity_exceeded', 'Too many active temporary keys.');
      const key = `arc_${randomBytes(32).toString('base64url')}`; const expires = Date.now() + (options.keyLifetimeMs ?? 24 * 60 * 60 * 1000);
      keys.set(keyHash(key), { expires });
      const address = request.socket.localAddress?.includes(':') ? `[${request.socket.localAddress}]` : request.socket.localAddress;
      return json(response, 201, { key, expiresAt: new Date(expires).toISOString(), serverUrl: `http://${address}:${request.socket.localPort}` });
    }
    const directory = /^\/v1\/remote\/hosts\/([^/]+)\/(catalog(?:\/revision)?|workspaces|models|attach|create)$/.exec(url.pathname);
    if (directory) {
      const host = requireHost(directory[1]!); const action = directory[2]!;
      if (['catalog', 'catalog/revision', 'workspaces'].includes(action) && request.method === 'GET') {
        const query = new URLSearchParams(url.search); query.delete('providerId');
        const result = await rpc(host, 'GET', `/remote/${action}${query.size ? '?' + query : ''}`);
        return rawJson(response, result);
      }
      if (action === 'models' && request.method === 'GET') return json(response, 200, { models: [] });
      if (['attach', 'create'].includes(action) && request.method === 'POST') { const binding = await mutate(host, action, await readBody(request)); return json(response, 200, { agentId: binding.agentId, nativeSessionId: binding.nativeSessionId }); }
    }
    const session = /^\/v1\/sessions\/([^/]+)\/(snapshot|timeline)$/.exec(url.pathname);
    const binding = session && bindings.get(session[1]!);
    if (binding && request.method === 'GET') { const host = requireHost(binding.hostId); await recoverBinding(host, binding); return rawJson(response, await rpc(host, 'GET', url.pathname + url.search, binding.agentId)); }
    throw new BrokerError(404, 'route_not_found', 'Unknown Remote Host route.');
  }
  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL) {
    if (url.pathname === '/ws/remote-host') {
      const header = request.headers.authorization;
      const key = header?.startsWith('Bearer ') ? keys.get(keyHash(header.slice(7))) : undefined;
      if (!key || key.expires <= Date.now()) return rejectUpgrade(socket, 401);
      return websockets.handleUpgrade(request, socket, head, (client) => register(client, key));
    }
    const match = /^\/v1\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    const binding = match && bindings.get(match[1]!);
    if (!binding || !local(request, origin) || request.headers.origin !== origin) return rejectUpgrade(socket, 403);
    let host: Host;
    try { host = requireHost(binding.hostId); await recoverBinding(host, binding); } catch { return rejectUpgrade(socket, 503); }
    if (host.streams.size >= 128) return rejectUpgrade(socket, 429);
    websockets.handleUpgrade(request, socket, head, (client) => {
      const streamId = randomUUID(); const stream: Host['streams'] extends Map<string, infer Value> ? Value : never = { socket: client, ready: false, buffered: [] };
      host.streams.set(streamId, stream);
      const opening = setTimeout(() => client.close(1013, 'Remote stream opening timed out'), options.rpcTimeoutMs ?? 30_000);
      stream.timer = opening;
      client.on('error', () => undefined);
      client.on('message', (raw, binary) => {
        if (binary) return client.close(1003, 'Text protocol required');
        if (!stream.ready) {
          if (stream.buffered.length >= 32 || stream.buffered.reduce((sum, value) => sum + Buffer.byteLength(value), 0) + Buffer.byteLength(raw.toString()) > 1024 * 1024) return client.close(1013, 'Remote stream is not ready');
          stream.buffered.push(raw.toString()); return;
        }
        clearTimeout(opening);
        try { send(host, { uplinkVersion: 2, type: 'stream_message', streamId, message: raw.toString() }); } catch { client.close(1012, 'Remote Host disconnected'); }
      });
      client.on('close', () => {
        clearTimeout(opening);
        if (!host.streams.delete(streamId)) return;
        try { send(host, { uplinkVersion: 2, type: 'stream_close', streamId, code: 1000, reason: 'Browser disconnected' }); } catch { /* The host may already be offline. */ }
      });
      try { send(host, { uplinkVersion: 2, type: 'stream_open', streamId, sessionId: binding.agentId }); }
      catch { client.close(1012, 'Remote Host disconnected'); }
    });
  }
  return {
    install(server: Server) {
      const requests = server.listeners('request'); const upgrades = server.listeners('upgrade');
      server.removeAllListeners('request'); server.removeAllListeners('upgrade');
      server.on('request', (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const session = /^\/v1\/sessions\/([^/]+)\//.exec(url.pathname);
        if (!/^\/v1\/remote\/(hosts|pairings)(\/|$)/.test(url.pathname) && !(session && bindings.has(session[1]!))) {
          for (const handler of requests) handler.call(server, request, response); return;
        }
        void handle(request, response, url).catch((error) => {
          if (error instanceof BrokerError) json(response, error.status, { code: error.code, error: error.message });
          else json(response, 503, { code: 'host_operation_failed', error: error instanceof Error ? error.message : 'Remote Host operation failed.' });
        });
      });
      server.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const session = /^\/v1\/sessions\/([^/]+)\//.exec(url.pathname);
        if (url.pathname !== '/ws/remote-host' && !(session && bindings.has(session[1]!))) {
          for (const handler of upgrades) handler.call(server, request, socket, head); return;
        }
        void upgrade(request, socket, head, url).catch(() => rejectUpgrade(socket, 503));
      });
    },
    async close() {
      for (const host of hosts.values()) if (host.socket) disconnected(host, host.socket);
      for (const client of websockets.clients) client.terminate();
      await new Promise<void>((resolve) => websockets.close(() => resolve()));
      keys.clear(); hosts.clear(); bindings.clear(); attached.clear(); creations.clear();
    },
  };
}
function local(request: IncomingMessage, origin: string): boolean {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '') && (!request.headers.origin || request.headers.origin === origin);
}
function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new BrokerError(400, 'invalid_request', `${name} must be a nonempty string.`);
  return value;
}
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = []; let size = 0;
  for await (const part of request) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part); size += bytes.length;
    if (size > 64 * 1024) throw new BrokerError(413, 'request_too_large', 'The request body is too large.');
    parts.push(bytes);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(parts).toString() || '{}'); } catch { throw new BrokerError(400, 'invalid_json', 'The request body must be JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrokerError(400, 'invalid_request', 'The request body must be an object.');
  return value as Record<string, unknown>;
}
function json(response: ServerResponse, status: number, value: unknown) { rawJson(response, { status, body: JSON.stringify(value) }); }
function rawJson(response: ServerResponse, result: RpcResponse) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' }); response.end(result.body);
}
function rejectUpgrade(socket: Duplex, status: number) { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }

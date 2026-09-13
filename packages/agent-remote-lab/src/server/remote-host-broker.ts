import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { decodeRemoteHostUplinkMessage, type RemoteHostUplinkMessage } from '@borgee/agent-remote-protocol';
import type { AgentRemoteRequestAccessPolicy, AgentRemoteHttpMutationPolicy } from '@borgee/agent-remote-relay';
import { createLocalLabMutationPolicy } from './local-authorizer.js';

type RpcResponse = { status: number; body: string };
type ProviderDescriptor = { providerId: string; displayName: string };
type Host = {
  id: string; installationId: string; name: string; providers: ProviderDescriptor[]; legacyDsh: boolean; generation: number; socket?: WebSocket;
  pending: Map<string, { resolve(value: RpcResponse): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>;
  streams: Map<string, { socket: WebSocket; ready: boolean; buffered: string[]; timer?: ReturnType<typeof setTimeout> }>;
};
type Binding = { hostId: string; providerId: string; nativeSessionId: string; agentId: string; generation: number;
  parentNativeSessionId?: string; recovery?: Promise<void> };
class BrokerError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export interface RemoteHostBrokerState {
  keys: Array<[string, { expires: number; installationId?: string }]>;
  hosts: Array<Pick<Host, 'id' | 'installationId' | 'name' | 'providers' | 'legacyDsh'>>;
  bindings: Array<Omit<Binding, 'generation' | 'recovery'>>;
  creations: Array<[string, { fingerprint: string; agentId: string }]>;
}
export interface RemoteHostBrokerOptions {
  origin: string; rpcTimeoutMs?: number; keyLifetimeMs?: number;
  accessPolicy?: AgentRemoteRequestAccessPolicy;
  mutationPolicy?: AgentRemoteHttpMutationPolicy;
  publicUrl?: string;
  onPairing?(key: string, expiresAt: number): void;
  connectionExpiresAt?(request: IncomingMessage): number | undefined;
  connectionExpiryCode?(request: IncomingMessage): number;
  durable?: boolean;
  initialState?: RemoteHostBrokerState;
  onStateChange?(state: RemoteHostBrokerState): void;
}
export function createRemoteHostBroker(options: RemoteHostBrokerOptions) {
  const origin = new URL(options.origin).origin;
  const keys = new Map<string, { expires: number; installationId?: string }>();
  const hosts = new Map<string, Host>();
  const bindings = new Map<string, Binding>();
  const nativeBindings = new Map<string, Binding>();
  const attached = new Map<string, Promise<Binding>>();
  const creations = new Map<string, { fingerprint: string; result: Promise<Binding> }>();
  const completedCreations = new Map<string, { fingerprint: string; agentId: string }>();
  for (const [hash, key] of options.initialState?.keys ?? []) if (key.expires > Date.now()) keys.set(hash, { ...key });
  for (const item of options.initialState?.hosts ?? []) hosts.set(item.id, { ...item, generation: 0, pending: new Map(), streams: new Map() });
  for (const item of options.initialState?.bindings ?? []) {
    const binding = { ...item, generation: -1 };
    bindings.set(binding.agentId, binding);
    nativeBindings.set(JSON.stringify([binding.hostId, binding.providerId, binding.nativeSessionId]), binding);
    attached.set(JSON.stringify([binding.hostId, binding.providerId, binding.nativeSessionId]), Promise.resolve(binding));
  }
  for (const [key, value] of options.initialState?.creations ?? []) {
    const binding = bindings.get(value.agentId);
    if (binding) { completedCreations.set(key, value); creations.set(key, { fingerprint: value.fingerprint, result: Promise.resolve(binding) }); }
  }
  function snapshot(): RemoteHostBrokerState {
    return { keys: [...keys].map(([key, value]) => [key, { ...value }]),
      hosts: [...hosts.values()].map(({ id, installationId, name, providers, legacyDsh }) => ({ id, installationId, name, providers, legacyDsh })),
      bindings: [...bindings.values()].map(({ generation: _generation, recovery: _recovery, ...binding }) => binding),
      creations: [...completedCreations] };
  }
  const persist = () => options.onStateChange?.(snapshot());
  const websockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  const permitted = async (request: IncomingMessage) => options.accessPolicy
    ? await options.accessPolicy.authorize(request) === true : local(request, origin);
  const expiryChecks = new Set<() => void>();
  function expire(client: WebSocket, expiry: () => number | undefined, code: () => number = () => 1008) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(timer);
      const expiresAt = expiry();
      if (expiresAt === undefined) return;
      if (expiresAt <= Date.now()) { client.close(code(), 'Credential expired'); return; }
      timer = setTimeout(check, Math.min(60_000, expiresAt - Date.now())); timer.unref();
    };
    expiryChecks.add(check); check(); client.once('close', () => { clearTimeout(timer); expiryChecks.delete(check); });
  }
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
  function register(socket: WebSocket, credential: { expires: number; installationId?: string }, request: IncomingMessage, credentialHash: string) {
    let host: Host | undefined;
    const timer = setTimeout(() => socket.close(1008, 'Registration deadline exceeded'), 10_000);
    socket.on('error', () => undefined);
    socket.on('close', () => { clearTimeout(timer); if (host) disconnected(host, socket); });
    socket.on('message', (raw, binary) => {
      try {
      if (socket.readyState !== WebSocket.OPEN || keys.get(credentialHash) !== credential) return socket.close(1008, 'Device credential revoked');
      if (options.connectionExpiresAt && Math.min(credential.expires, options.connectionExpiresAt(request) ?? credential.expires) <= Date.now()) return socket.close(credential.expires <= Date.now() ? 1008 : (options.connectionExpiryCode?.(request) ?? 1008), 'Credential expired');
      const decoded = binary ? undefined : decodeRemoteHostUplinkMessage(raw.toString());
      if (!decoded || decoded.status !== 'ok') return socket.close(1008, 'Invalid uplink envelope');
      const message = decoded.value;
      if (!host) {
        if (message.type !== 'register' || credential.expires <= Date.now() || (credential.installationId && credential.installationId !== message.installationId)) return socket.close(1008, 'Registration is not authorized');
        credential.installationId = message.installationId;
        if (options.durable) {
          credential.expires = Number.MAX_SAFE_INTEGER;
          for (const [hash, key] of keys) if (key !== credential && key.installationId === message.installationId) keys.delete(hash);
        }
        host = [...hosts.values()].find((value) => value.installationId === message.installationId);
        if (!host) {
          if (hosts.size >= 128) return socket.close(1013, 'Host capacity reached');
          const providers = 'providers' in message ? [...message.providers] : [{ providerId: 'dsh', displayName: 'DeepSeek DSH' }];
          host = { id: randomUUID(), installationId: message.installationId, name: message.name, providers,
            legacyDsh: 'providerId' in message, generation: 0, pending: new Map(), streams: new Map() };
          hosts.set(host.id, host);
        }
        if (host.socket) { const previous = host.socket; disconnected(host, previous); previous.close(1012, 'Host connection replaced'); }
        host.socket = socket; host.name = message.name;
        host.providers = 'providers' in message ? [...message.providers] : [{ providerId: 'dsh', displayName: 'DeepSeek DSH' }];
        host.legacyDsh = 'providerId' in message; host.generation += 1; clearTimeout(timer);
        try { persist(); } catch { return socket.close(1011, 'Device state could not be saved'); }
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
      } catch { socket.close(1011, 'Host message could not be processed'); }
    });
  }
  async function recoverBinding(host: Host, binding: Binding): Promise<void> {
    if (binding.generation === host.generation) return;
    if (!binding.recovery) {
      const generation = host.generation;
      binding.recovery = (async () => {
        if (binding.parentNativeSessionId) {
          const parent = nativeBindings.get(JSON.stringify([host.id, binding.providerId, binding.parentNativeSessionId]));
          if (!parent) throw new BrokerError(409, 'parent_binding_missing', 'The native parent session must be attached before its child.');
          await recoverBinding(host, parent);
        }
        const path = binding.parentNativeSessionId ? '/remote/child/attach' : '/remote/attach';
        const body = host.legacyDsh ? { nativeSessionId: binding.nativeSessionId } : {
          providerId: binding.providerId, nativeSessionId: binding.nativeSessionId,
          ...(binding.parentNativeSessionId ? { parentNativeSessionId: binding.parentNativeSessionId } : {}),
        };
        const result = await rpc(host, 'POST', path, binding.agentId, JSON.stringify(body));
        if (result.status >= 300) throw new BrokerError(result.status, 'session_unavailable', 'The native session could not be reattached after the host reconnected.');
        if (host.generation !== generation) throw new BrokerError(503, 'host_reconnected', 'The Remote Host changed while the session was reattaching.');
        if (!host.legacyDsh) {
          let returned: Record<string, unknown>;
          try { returned = JSON.parse(result.body); } catch { throw new BrokerError(502, 'invalid_host_response', 'The Remote Host returned invalid session identity.'); }
          if (returned.agentId !== binding.agentId || returned.nativeSessionId !== binding.nativeSessionId) {
            throw new BrokerError(409, 'session_binding_conflict', 'The Remote Host returned a different binding during recovery.');
          }
        }
        binding.generation = generation;
      })();
      void binding.recovery.finally(() => { binding.recovery = undefined; }).catch(() => undefined);
    }
    await binding.recovery;
  }
  async function mutate(host: Host, action: string, body: Record<string, unknown>): Promise<Binding> {
    const providerId = host.legacyDsh ? 'dsh' : required(body.providerId, 'providerId');
    if (!host.providers.some((provider) => provider.providerId === providerId)) throw new BrokerError(400, 'invalid_provider', 'The selected provider is unavailable on this Host.');
    if (host.legacyDsh && action === 'create' && ['cwd', 'model', 'reasoningEffort', 'planning'].some((key) => body[key] !== undefined)) {
      throw new BrokerError(400, 'unsupported_configuration', 'This Host uses native model settings and a registered workspace.');
    }
    if (host.legacyDsh && action === 'child/attach') throw new BrokerError(400, 'unsupported_operation', 'This Host does not support native child attachment.');
    if (bindings.size >= 4096) throw new BrokerError(429, 'capacity_exceeded', 'The local session binding registry is full.');
    const attaching = action !== 'create';
    const nativeSessionId = attaching ? required(body.nativeSessionId, 'nativeSessionId') : randomUUID();
    const parentNativeSessionId = action === 'child/attach' ? required(body.parentNativeSessionId, 'parentNativeSessionId') : undefined;
    const key = JSON.stringify([host.id, providerId, action === 'create' ? required(body.requestId, 'requestId') : nativeSessionId]);
    const operation = async () => {
      const proposedAgentId = randomUUID();
      const generation = host.generation;
      const request = host.legacyDsh
        ? { nativeSessionId, ...(body.workspaceId === undefined ? {} : { workspaceId: required(body.workspaceId, 'workspaceId') }) }
        : action === 'create'
          ? { providerId, requestId: required(body.requestId, 'requestId'),
              ...optionalSettings(body, ['cwd', 'workspaceId', 'model', 'reasoningEffort', 'planning']) }
          : { providerId, nativeSessionId, ...(parentNativeSessionId ? { parentNativeSessionId } : {}) };
      const result = await rpc(host, 'POST', `/remote/${action}`, proposedAgentId, JSON.stringify(request));
      if (host.generation !== generation) throw new BrokerError(503, 'host_reconnected', 'The Remote Host changed while the session operation was completing.');
      if (result.status >= 300) {
        let detail: Record<string, unknown> = {};
        try { detail = JSON.parse(result.body); } catch { /* Preserve the status if the host did not return JSON. */ }
        throw new BrokerError(result.status, typeof detail.code === 'string' ? detail.code : 'host_rejected', typeof detail.error === 'string' ? detail.error : 'The Remote Host rejected the operation.');
      }
      let returned: Record<string, unknown> = {};
      try { returned = JSON.parse(result.body); } catch {
        if (!host.legacyDsh) throw new BrokerError(502, 'invalid_host_response', 'The Remote Host returned invalid session identity.');
      }
      if (host.legacyDsh && returned.nativeSessionId !== undefined && returned.nativeSessionId !== nativeSessionId) {
        throw new BrokerError(409, 'native_identity_conflict', 'The Remote Host returned a different native session identity.');
      }
      const actualNativeSessionId = host.legacyDsh ? nativeSessionId : requiredHostIdentity(returned.nativeSessionId, 'nativeSessionId');
      const agentId = host.legacyDsh ? proposedAgentId : requiredHostIdentity(returned.agentId, 'agentId');
      if (attaching && actualNativeSessionId !== nativeSessionId) throw new BrokerError(409, 'native_identity_conflict', 'The Remote Host returned a different native session identity.');
      const nativeKey = JSON.stringify([host.id, providerId, actualNativeSessionId]);
      const byAgent = bindings.get(agentId); const byNative = nativeBindings.get(nativeKey);
      if ((byAgent && !sameBinding(byAgent, host.id, providerId, actualNativeSessionId)) || (byNative && byNative.agentId !== agentId)) {
        throw new BrokerError(409, 'session_binding_conflict', 'The Remote Host session identity conflicts with an existing binding.');
      }
      const binding = byAgent ?? byNative ?? { hostId: host.id, providerId, nativeSessionId: actualNativeSessionId, agentId,
        generation: host.generation, ...(parentNativeSessionId ? { parentNativeSessionId } : {}) };
      if (binding.parentNativeSessionId !== parentNativeSessionId) throw new BrokerError(409, 'session_binding_conflict', 'The native session parent conflicts with its existing binding.');
      binding.generation = host.generation;
      bindings.set(agentId, binding);
      nativeBindings.set(nativeKey, binding);
      attached.set(JSON.stringify([host.id, providerId, actualNativeSessionId]), Promise.resolve(binding));
      persist();
      return binding;
    };
    if (attaching) {
      let result = attached.get(key);
      if (!result) { result = operation(); attached.set(key, result); void result.catch(() => attached.delete(key)); }
      const binding = await result;
      if (binding.parentNativeSessionId !== parentNativeSessionId) {
        throw new BrokerError(409, 'session_binding_conflict', 'The native session parent conflicts with its existing binding.');
      }
      await recoverBinding(host, binding); return binding;
    }
    const fingerprint = JSON.stringify({ providerId, cwd: body.cwd ?? null, workspaceId: body.workspaceId ?? null,
      model: body.model ?? null, reasoningEffort: body.reasoningEffort ?? null, planning: body.planning ?? null });
    let existing = creations.get(key);
    if (existing && existing.fingerprint !== fingerprint) throw new BrokerError(409, 'request_conflict', 'This request identity was already used with different settings.');
    if (!existing) {
      if (creations.size >= 4096) throw new BrokerError(429, 'capacity_exceeded', 'The local creation ledger is full.');
      existing = { fingerprint, result: operation() }; creations.set(key, existing);
    }
    const binding = await existing.result;
    completedCreations.set(key, { fingerprint, agentId: binding.agentId }); persist();
    await recoverBinding(host, binding); return binding;
  }
  async function handle(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (!await permitted(request)) throw new BrokerError(403, 'forbidden', 'This endpoint is available only to the local application.');
    response.setHeader('cache-control', 'no-store');
    if (request.method === 'POST') {
      const access = (options.mutationPolicy ?? createLocalLabMutationPolicy(origin)).validate(request);
      if (access.status === 'rejected') throw new BrokerError(access.httpStatus, access.code, access.message);
    }
    if (url.pathname === '/v1/remote/hosts' && request.method === 'GET') return json(response, 200, { hosts: [...hosts.values()].map(({ id, name, providers, legacyDsh, socket }) => ({ id, name, online: socket?.readyState === WebSocket.OPEN, providers, ...(options.durable ? { managed: true } : {}),
      ...(legacyDsh ? { providerId: 'dsh' } : providers.length === 1 ? { providerId: providers[0]!.providerId } : {}) })) });
    if (url.pathname === '/v1/remote/pairings' && request.method === 'POST') {
      await readBody(request);
      for (const [hash, value] of keys) if (value.expires <= Date.now()) keys.delete(hash);
      if (keys.size >= 128) throw new BrokerError(429, 'capacity_exceeded', 'Too many active temporary keys.');
      const key = `arc_${randomBytes(32).toString('base64url')}`; const expires = Date.now() + (options.keyLifetimeMs ?? (options.durable ? 10 * 60 * 1000 : 24 * 60 * 60 * 1000));
      keys.set(keyHash(key), { expires });
      options.onPairing?.(key, expires); persist();
      const address = request.socket.localAddress?.includes(':') ? `[${request.socket.localAddress}]` : request.socket.localAddress;
      return json(response, 201, { key, expiresAt: new Date(expires).toISOString(), serverUrl: options.publicUrl ?? `http://${address}:${request.socket.localPort}`,
        ...(options.durable && options.publicUrl ? { command: `export AGENT_HOST_SERVER='${options.publicUrl.replaceAll("'", "'\\''")}'\nexport AGENT_HOST_REMOTE_KEY='${key}'\npnpm agent-host start` } : {}) });
    }
    const revoking = /^\/v1\/remote\/hosts\/([^/]+)\/revoke$/.exec(url.pathname);
    if (options.durable && revoking && request.method === 'POST') {
      await readBody(request);
      const host = hosts.get(revoking[1]!);
      if (!host) throw new BrokerError(404, 'host_not_found', 'The Remote Host is unknown.');
      for (const [key, credential] of keys) if (credential.installationId === host.installationId) keys.delete(key);
      for (const [id, binding] of bindings) if (binding.hostId === host.id) {
        bindings.delete(id); const key = JSON.stringify([host.id, binding.providerId, binding.nativeSessionId]);
        nativeBindings.delete(key); attached.delete(key);
      }
      for (const [key, value] of completedCreations) if (!bindings.has(value.agentId)) { completedCreations.delete(key); creations.delete(key); }
      hosts.delete(host.id); persist();
      if (host.socket) { const socket = host.socket; disconnected(host, socket); socket.close(1008, 'Device revoked'); }
      return json(response, 200, { ok: true });
    }
    const directory = /^\/v1\/remote\/hosts\/([^/]+)\/(catalog(?:\/revision)?|workspaces|models|child\/attach|attach|create)$/.exec(url.pathname);
    if (directory) {
      const host = requireHost(directory[1]!); const action = directory[2]!;
      if (action === 'models' && request.method === 'GET' && host.legacyDsh) return json(response, 200, { models: [] });
      if (['catalog', 'catalog/revision', 'workspaces', 'models'].includes(action) && request.method === 'GET') {
        const query = new URLSearchParams(url.search);
        const providerId = query.get('providerId');
        if (!host.legacyDsh && (!providerId || !host.providers.some((provider) => provider.providerId === providerId))) throw new BrokerError(400, 'invalid_provider', 'The selected provider is unavailable on this Host.');
        if (host.legacyDsh) query.delete('providerId');
        const result = await rpc(host, 'GET', `/remote/${action}${query.size ? '?' + query : ''}`);
        return rawJson(response, result);
      }
      if (['attach', 'child/attach', 'create'].includes(action) && request.method === 'POST') { const binding = await mutate(host, action, await readBody(request)); return json(response, 200, { agentId: binding.agentId, nativeSessionId: binding.nativeSessionId }); }
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
      return websockets.handleUpgrade(request, socket, head, (client) => { if (options.connectionExpiresAt) expire(client, () => keys.has(keyHash(header!.slice(7))) ? Math.min(key.expires, options.connectionExpiresAt?.(request) ?? key.expires) : 0, () => !keys.has(keyHash(header!.slice(7))) || key.expires <= Date.now() ? 1008 : (options.connectionExpiryCode?.(request) ?? 1008)); register(client, key, request, keyHash(header!.slice(7))); });
    }
    const match = /^\/v1\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    const binding = match && bindings.get(match[1]!);
    if (!binding || !await permitted(request) || request.headers.origin !== origin) return rejectUpgrade(socket, 403);
    let host: Host;
    try { host = requireHost(binding.hostId); await recoverBinding(host, binding); } catch { return rejectUpgrade(socket, 503); }
    if (host.streams.size >= 128) return rejectUpgrade(socket, 429);
    websockets.handleUpgrade(request, socket, head, (client) => {
      const expiry = () => options.connectionExpiresAt?.(request);
      expire(client, expiry);
      const streamId = randomUUID(); const stream: Host['streams'] extends Map<string, infer Value> ? Value : never = { socket: client, ready: false, buffered: [] };
      host.streams.set(streamId, stream);
      const opening = setTimeout(() => client.close(1013, 'Remote stream opening timed out'), options.rpcTimeoutMs ?? 30_000);
      stream.timer = opening;
      client.on('error', () => undefined);
      client.on('message', (raw, binary) => {
        const expiresAt = expiry();
        if (expiresAt !== undefined && expiresAt <= Date.now()) return client.close(1008, 'Credential expired');
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
    snapshot,
    enforceExpiry() { for (const check of expiryChecks) check(); },
    disconnect(code = 1008) {
      for (const host of hosts.values()) if (host.socket) { const socket = host.socket; disconnected(host, socket); socket.close(code, code === 1008 ? 'Access revoked' : 'Authority temporarily unavailable'); }
    },
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
      keys.clear(); hosts.clear(); bindings.clear(); nativeBindings.clear(); attached.clear(); creations.clear();
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
function requiredHostIdentity(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new BrokerError(502, 'invalid_host_response', `The Remote Host returned an invalid ${name}.`);
  return value;
}
function optionalSettings(body: Record<string, unknown>, names: readonly string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (const name of names) {
    const value = body[name];
    if (value === undefined) continue;
    if (name === 'planning') {
      if (typeof value !== 'boolean') throw new BrokerError(400, 'invalid_request', 'planning must be a boolean.');
      result[name] = value;
    } else result[name] = required(value, name);
  }
  return result;
}
function sameBinding(binding: Binding, hostId: string, providerId: string, nativeSessionId: string): boolean {
  return binding.hostId === hostId && binding.providerId === providerId && binding.nativeSessionId === nativeSessionId;
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

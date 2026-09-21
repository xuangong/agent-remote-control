import { MAX_PAIRING_HISTORY, pairingStatus, visiblePairing, type SavedPairingKey } from './pairing-keys.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { decodeRemoteHostUplinkMessage, type RemoteHostUplinkMessage, type HostEnvironment, isPairingPurpose, type PairingPurpose } from '@agent-remote-controller/agent-remote-protocol';
import { sessionAttachFailure } from './session-errors.js';
import { HostSharing, SharingError, type HostSharingState } from './host-sharing.js';
import { createHostPreviews, type HostPreviewState } from './host-previews.js';
import type { TunnelSocket } from '@agent-remote-controller/agent-remote-tunnel';
import { BROKER_MAX_BODY_BYTES, BROKER_MAX_FRAME_BYTES, defaultBrokerScheduler, RELAY_SOCKET_OPEN, type BrokerRequestContext, type BrokerScheduler, type RelaySocket } from './transport.js';

type RpcResponse = { status: number; body: string; requestId?: string };
type ProviderDescriptor = { providerId: string; displayName: string };
type DeviceCredential = { pairingId?: string; purpose?: PairingPurpose; claimedAt?: number; expires: number; installationId?: string; kind?: 'device'; requiresRotation?: boolean };
type Host = {
  pairingPurpose?: PairingPurpose;
  environment?: HostEnvironment;
  tunnelToken?: string;
  ready?: boolean; credentialRotation?: boolean; gatewayKeyRequested?: boolean; issueCredential?(): Promise<void>;
  id: string; installationId: string; name: string; providers: ProviderDescriptor[]; legacyDsh: boolean; generation: number; socket?: RelaySocket;
  pending: Map<string, { resolve(value: RpcResponse): void; reject(error: Error): void; timer: unknown; method: 'GET' | 'POST'; path: string }>;
  streams: Map<string, { socket: RelaySocket; subject?: string; authorized?(): boolean; ready: boolean; buffered: string[]; timer?: unknown }>;
};
type Binding = { hostId: string; providerId: string; nativeSessionId: string; agentId: string; generation: number;
  creatorSubject?: string; parentNativeSessionId?: string; recovery?: Promise<void> };
class BrokerError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly creationRejected = false, readonly requestId?: string) { super(message); }
}
export interface RemoteHostBrokerState {
  pairings?: SavedPairingKey[];
  previews?: HostPreviewState[];
  sharing?: HostSharingState;
  keys: Array<[string, DeviceCredential]>;
  hosts: Array<Pick<Host, 'id' | 'installationId' | 'name' | 'providers' | 'legacyDsh' | 'credentialRotation' | 'gatewayKeyRequested' | 'environment' | 'pairingPurpose'>>;
  bindings: Array<Omit<Binding, 'generation' | 'recovery'>>;
  creations: Array<[string, { fingerprint: string; agentId: string }]>;
}
export interface HostBrokerOptions {
  ownerSubject?: string;
  userStreamCount?(subject: string): number;
  origin: string;
  rpcTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  keyLifetimeMs?: number;
  publicUrl?: string;
  onPairing?(key: string, expiresAt: number): void;
  durable?: boolean;
  initialState?: RemoteHostBrokerState;
  onStateChange?(state: RemoteHostBrokerState): void | Promise<void>;
  now?(): number;
  scheduler?: BrokerScheduler;
}
export function createHostBroker(options: HostBrokerOptions) {
  const origin = new URL(options.origin).origin;
  const now = options.now ?? Date.now;
  const scheduler = options.scheduler ?? defaultBrokerScheduler;
  const setTimeout = scheduler.setTimeout.bind(scheduler);
  const clearTimeout = scheduler.clearTimeout.bind(scheduler);
  const heartbeat = { intervalMs: options.heartbeatIntervalMs ?? 30_000, timeoutMs: options.heartbeatTimeoutMs ?? 10_000 };
  if (!Number.isSafeInteger(heartbeat.intervalMs) || !Number.isSafeInteger(heartbeat.timeoutMs) || heartbeat.timeoutMs < 1 || heartbeat.timeoutMs >= heartbeat.intervalMs || heartbeat.intervalMs > 600_000) {
    throw new RangeError('Host heartbeat deadlines require 0 < timeout < interval <= 600000 milliseconds.');
  }
  const uplinkCleanups = new Map<RelaySocket, () => void>();
  const clients = new Set<RelaySocket>();
  function track(client: RelaySocket) { clients.add(client); client.onClose(() => clients.delete(client)); }
  const keys = new Map<string, DeviceCredential>();
  const hosts = new Map<string, Host>();
  let pairings = structuredClone(options.initialState?.pairings ?? []);
  const bindings = new Map<string, Binding>();
  const activeStreamCount = (subject: string) => [...hosts.values()].reduce((sum, host) => sum + [...host.streams.values()].filter(stream => stream.subject === subject).length, 0);
  const pendingBindingSlots = new Set<symbol>();
  const nativeBindings = new Map<string, Binding>();
  const attached = new Map<string, Promise<Binding>>();
  const creations = new Map<string, { fingerprint: string; result: Promise<Binding> }>();
  const completedCreations = new Map<string, { fingerprint: string; agentId: string }>();
  for (const [hash, key] of options.initialState?.keys ?? []) if (key.expires > now()) keys.set(hash, { ...key });
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
    return { pairings: structuredClone(pairings), previews: previews.snapshot(), ...(options.ownerSubject ? { sharing: sharing.snapshot() } : {}), keys: [...keys].map(([key, value]) => [key, { ...value }]),
      hosts: [...hosts.values()].map(({ id, installationId, name, providers, legacyDsh, credentialRotation, gatewayKeyRequested, environment, pairingPurpose }) => ({ ...(pairingPurpose ? { pairingPurpose } : {}), ...(environment ? { environment } : {}), id, installationId, name, providers, legacyDsh, ...(credentialRotation ? {credentialRotation} : {}), ...(gatewayKeyRequested ? { gatewayKeyRequested } : {}) })),
      bindings: [...bindings.values()].map(({ generation: _generation, recovery: _recovery, ...binding }) => binding),
      creations: [...completedCreations] };
  }
  let sharing = new HostSharing(options.initialState?.sharing, () => {});
  let unavailable = false;
  let commits: Promise<unknown> = Promise.resolve();
  const previews = createHostPreviews({ initial: options.initialState?.previews,
    save: (value, publish) => commit(draft => { draft.previews = value; return { value: undefined, publish }; }),
    renew: async (hostId, id) => {
      const result = await rpc(requireHost(hostId), 'POST', '/remote/previews/renew', undefined, JSON.stringify({ id }));
      if (result.status !== 200) throw new Error('Preview renewal unavailable.');
      return (JSON.parse(result.body) as { registration: { expiresAt: number } }).registration;
    },
    remove: async (hostId, id) => { const result = await rpc(requireHost(hostId), 'POST', '/remote/previews/unregister', undefined, JSON.stringify({ id }));
      if (result.status !== 200) throw new Error('Preview removal is pending.'); },
  });
  function assertAvailable() { if (unavailable) throw new BrokerError(503, 'state_unavailable', 'Relay state is unavailable.'); }
  function failClosed() {
    unavailable = true;
    for (const cleanup of [...uplinkCleanups.values()]) cleanup();
    for (const host of hosts.values()) if (host.socket) disconnected(host, host.socket);
    for (const client of clients) client.close(1011, 'Relay state is unavailable');
  }
  function commit<T>(stage: (draft: RemoteHostBrokerState) => { value: T; publish(): void }): Promise<T> {
    const operation = commits.then(async () => {
      assertAvailable();
      const draft = structuredClone(snapshot());
      const result = stage(draft);
      try { await options.onStateChange?.(draft); }
      catch (error) { failClosed(); throw error; }
      assertAvailable();
      result.publish();
      return result.value;
    });
    commits = operation.catch(() => undefined);
    return operation;
  }
  function changeSharing<T>(change: (draft: HostSharing) => T): Promise<T> {
    return commit(state => {
      const draft = new HostSharing(state.sharing, () => {});
      const value = change(draft); state.sharing = draft.snapshot();
      return { value, publish() { sharing = draft; } };
    });
  }
  const sharedCreates = new Map<string, Promise<Binding>>();
  const principal = (context: BrokerRequestContext) => context.principalSubject?.();
  const owner = (subject?: string) => options.ownerSubject === undefined || subject === options.ownerSubject;
  const hostAllowed = (hostId: string, subject?: string) => !unavailable && hosts.has(hostId) && (owner(subject) || (subject !== undefined && sharing.allowed(hostId, subject)));
  const sessionAllowed = (binding: Binding, subject?: string) => hostAllowed(binding.hostId, subject) && (owner(subject) || binding.creatorSubject === subject);
  function requireOwner(subject?: string) {
    if (!owner(subject)) throw new SharingError(403, 'owner_required', 'Only the Host owner can manage this Host.');
  }
  function requireAccess(hostId: string, subject?: string) {
    if (!hosts.has(hostId)) throw new SharingError(404, 'host_not_found', 'Host is unavailable.');
    if (!hostAllowed(hostId, subject)) throw new SharingError(403, 'host_forbidden', 'Host access is unavailable.');
  }
  function visibleHosts(subject?: string) {
    return [...hosts.values()].filter(host => hostAllowed(host.id, subject)).map(({ id, name, providers, legacyDsh, socket, ready, credentialRotation, environment }) => ({
      ...(environment ? { environment } : {}),
      ...(credentialRotation ? {credentialRotation:true} : {}), id, name, online: ready === true && socket?.readyState === RELAY_SOCKET_OPEN, providers,
      ...(options.durable && owner(subject) ? { managed: true } : {}),
      ...(options.ownerSubject ? { access: owner(subject) ? 'owner' as const : 'shared' as const } : {}),
      ...(!owner(subject) && subject ? { sessionQuota: sharing.quota(id, subject) } : {}),
      ...(legacyDsh ? { providerId: 'dsh' } : providers.length === 1 ? { providerId: providers[0]!.providerId } : {}),
    }));
  }

  const permitted = async (context: BrokerRequestContext) => !context.authorize || await context.authorize() === true;
  const expiryChecks = new Set<() => void>();
  function expire(client: RelaySocket, expiry: () => number | undefined, code: () => number = () => 1008, close = (code: number) => client.close(code, 'Credential expired')) {
    let timer: unknown;
    let active = true;
    const check = () => {
      if (!active) return;
      clearTimeout(timer);
      const expiresAt = expiry();
      if (expiresAt === undefined) return;
      if (expiresAt <= now()) { cleanup(); close(code()); return; }
      timer = setTimeout(check, Math.min(60_000, expiresAt - now()));
    };
    const cleanup = () => { active = false; clearTimeout(timer); expiryChecks.delete(check); };
    expiryChecks.add(check); client.onClose(cleanup); check();
    return cleanup;
  }
  const keyHash = (key: string) => createHash('sha256').update(key).digest('hex');
  const requireHost = (id: string) => {
    const host = hosts.get(id);
    if (!host) throw new BrokerError(404, 'host_not_found', 'The Remote Host is unknown.');
    assertAvailable();
    if (!host.ready || host.socket?.readyState !== RELAY_SOCKET_OPEN) throw new BrokerError(503, 'host_offline', 'The Remote Host is offline.', true);
    return host;
  };
  function send(host: Host, message: RemoteHostUplinkMessage) {
    assertAvailable();
    if (host.socket?.readyState !== RELAY_SOCKET_OPEN) throw new BrokerError(503, 'host_offline', 'The Remote Host is offline.', true);
    if (host.socket.bufferedAmount !== undefined && host.socket.bufferedAmount > BROKER_MAX_FRAME_BYTES) throw new BrokerError(503, 'host_backpressure', 'The Remote Host connection is busy.', true);
    host.socket.send(JSON.stringify(message));
  }
  function rpc(host: Host, method: 'GET' | 'POST', path: string, sessionId?: string, body?: string): Promise<RpcResponse> {
    if (host.pending.size >= 128) return Promise.reject(new BrokerError(429, 'host_busy', 'Too many pending Remote Host requests.', true));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        host.pending.delete(requestId);
        try { send(host, { uplinkVersion: 2, type: 'rpc_cancel', requestId }); } catch { /* An offline host has no request to cancel. */ }
        const attach = path === '/remote/attach' || path === '/remote/child/attach';
        reject(new BrokerError(504, attach ? 'session_attach_timeout' : method === 'GET' ? 'host_read_timeout' : 'host_timeout', attach
          ? 'The Host did not confirm opening the session before the Relay deadline. It may still be opening; wait briefly and reopen the same session.'
          : method === 'GET' ? 'The Host did not return the requested data before the Relay deadline. Try reading it again.'
          : 'The Host did not confirm the operation before the Relay deadline. Its outcome is unknown; check the session before retrying.', false, requestId));
      }, options.rpcTimeoutMs ?? 30_000);
      host.pending.set(requestId, { resolve, reject, timer, method, path });
      try { send(host, { uplinkVersion: 2, type: 'rpc_request', requestId, method, path, ...(sessionId ? { sessionId } : {}), ...(body === undefined ? {} : { body }) }); }
      catch (error) { clearTimeout(timer); host.pending.delete(requestId); reject(error); }
    });
  }
  function disconnected(host: Host, socket: RelaySocket) {
    uplinkCleanups.get(socket)?.();
    if (host.socket !== socket) return;
    previews.disconnect(host.id); host.tunnelToken = undefined;
    host.socket = undefined; host.ready = false;
    for (const [requestId, pending] of host.pending) {
      clearTimeout(pending.timer);
      const attach = pending.path === '/remote/attach' || pending.path === '/remote/child/attach';
      pending.reject(new BrokerError(503, 'host_offline', attach
        ? 'The Host disconnected while opening the session. Wait for it to reconnect, then reopen the same session.'
        : pending.method === 'GET' ? 'The Host disconnected while reading data. Wait for it to reconnect and try again.'
        : 'The Host disconnected before confirming the operation. Its outcome is unknown; check the session before retrying.', false, requestId));
    }
    host.pending.clear();
    for (const stream of host.streams.values()) { clearTimeout(stream.timer); stream.socket.close(1012, 'Remote Host disconnected'); }
    host.streams.clear();
  }
  function register(socket: RelaySocket, credential: DeviceCredential, context: BrokerRequestContext, credentialHash: string) {
    let host: Host | undefined;
    let pendingCredential: {hash: string; value: DeviceCredential} | undefined;
    let issuing: Promise<void> | undefined;
    let retired = false, heartbeatStarted = false;
    let timer: unknown, heartbeatTimer: unknown, heartbeatDeadline: unknown;
    let pendingNonce: string | undefined;
    let cancelExpiry = () => {};
    function cleanup() {
      retired = true;
      clearTimeout(timer); clearTimeout(heartbeatTimer); clearTimeout(heartbeatDeadline);
      pendingNonce = undefined; cancelExpiry(); uplinkCleanups.delete(socket);
    }
    function closeConnection(code: number, reason: string) {
      if (retired) return;
      cleanup(); if (host) disconnected(host, socket);
      socket.close(code, reason);
    }
    uplinkCleanups.set(socket, cleanup);
    cancelExpiry = expire(socket, () => keys.get(credentialHash) === credential ? Math.min(credential.expires, context.connectionExpiresAt?.() ?? credential.expires) : 0, () => keys.get(credentialHash) !== credential ? 1008 : context.connectionExpiryCode?.() ?? 1008, code => closeConnection(code, 'Credential expired'));
    if (!retired) timer = setTimeout(() => closeConnection(1008, 'Registration deadline exceeded'), 10_000);
    socket.onError(() => closeConnection(1011, 'Host transport failed'));
    socket.onClose(() => { cleanup(); if (host) disconnected(host, socket); });
    const current = () => !retired && host?.socket === socket && host.ready === true;
    function sendHeartbeat() {
      if (!current()) return;
      const nonce = randomUUID(); pendingNonce = nonce;
      heartbeatDeadline = setTimeout(() => {
        if (current() && pendingNonce === nonce) closeConnection(1012, 'Host heartbeat timed out');
      }, heartbeat.timeoutMs);
      heartbeatTimer = setTimeout(sendHeartbeat, heartbeat.intervalMs);
      try { send(host!, { uplinkVersion: 2, type: 'heartbeat', nonce }); }
      catch { closeConnection(1012, 'Host heartbeat delivery failed'); }
    }
    function registered() {
      if (retired || !host || host.socket !== socket) return;
      host.tunnelToken ??= randomBytes(32).toString('base64url');
      send(host, { uplinkVersion: 2, type: 'registered', hostId: host.id, pairingPurpose: host.pairingPurpose ?? (host.gatewayKeyRequested ? 'gateway-setup' : 'host-only'), heartbeat, tunnelToken: host.tunnelToken });
      if (retired || host.socket !== socket) return;
      host.ready = true;
      if (!heartbeatStarted) {
        heartbeatStarted = true; heartbeatTimer = setTimeout(sendHeartbeat, heartbeat.intervalMs);
      }
    }
    let registration: Promise<void> | undefined;
    socket.onMessage((raw, binary) => {
      return receive(raw, binary).catch(() => closeConnection(1011, 'Host message could not be processed'));
    });
    async function receive(raw: string, binary: boolean) {
      if (registration) await registration;
      if (retired) return;
      try {
      assertAvailable();
      if (socket.readyState !== RELAY_SOCKET_OPEN || keys.get(credentialHash) !== credential) return closeConnection(1008, 'Device credential revoked');
      if (context.connectionExpiresAt && Math.min(credential.expires, context.connectionExpiresAt() ?? credential.expires) <= now()) return closeConnection(credential.expires <= now() ? 1008 : (context.connectionExpiryCode?.() ?? 1008), 'Credential expired');
      const decoded = binary ? undefined : decodeRemoteHostUplinkMessage(raw.toString());
      if (!decoded || decoded.status !== 'ok') return closeConnection(1008, 'Invalid uplink envelope');
      const message = decoded.value;
      if (!host) {
        if (message.type !== 'register' || credential.claimedAt !== undefined || credential.expires <= now() || (credential.installationId && credential.installationId !== message.installationId)) return closeConnection(1008, 'Registration is not authorized');
        const invitation = credential.requiresRotation === true || credential.installationId === undefined;
        if (credential.requiresRotation && !message.credentialRotation) return closeConnection(1008, 'Update Agent Host to enroll this device');
        registration = commit(draft => {
          if (keys.get(credentialHash) !== credential || credential.claimedAt !== undefined || credential.expires <= now() || (credential.installationId && credential.installationId !== message.installationId)) throw new BrokerError(401, 'device_revoked', 'Registration is not authorized');
          const savedCredential = draft.keys.find(([hash]) => hash === credentialHash)![1];
          savedCredential.installationId = message.installationId;
          if (options.durable && invitation) savedCredential.claimedAt = now();
          if (options.durable) {
            if (!savedCredential.requiresRotation) savedCredential.expires = Number.MAX_SAFE_INTEGER;
            draft.keys = draft.keys.filter(([hash, key]) => hash === credentialHash || key.installationId !== message.installationId);
          }
          const existing = [...hosts.values()].find(value => value.installationId === message.installationId);
          if (!existing && hosts.size >= 128) throw new BrokerError(429, 'host_capacity', 'Host capacity reached');
          const purpose = existing
            ? existing.pairingPurpose ?? (existing.gatewayKeyRequested ? 'gateway-setup' : 'host-only')
            : credential.purpose ?? 'host-only';
          const providers = 'providers' in message ? [...message.providers] : [{ providerId: 'dsh', displayName: 'DeepSeek DSH' }];
          const next = { id: existing?.id ?? randomUUID(), installationId: message.installationId, name: message.name, environment: message.environment, pairingPurpose: purpose,
            ...(existing?.gatewayKeyRequested ? { gatewayKeyRequested: true } : {}),
            providers, legacyDsh: 'providerId' in message, ...(message.credentialRotation ? {credentialRotation:true} : {credentialRotation:undefined}) };
          draft.hosts = draft.hosts.filter(value => value.id !== next.id); draft.hosts.push(next);
          const pairing = draft.pairings?.find(value => value.id === credential.pairingId);
          if (pairing && pairing.usedAt === undefined) {
            pairing.usedAt = now(); pairing.hostId = next.id; pairing.hostName = next.name;
          }
          return { value: undefined, publish() {
            Object.assign(credential, savedCredential);
            pairings = draft.pairings ?? [];
            for (const hash of keys.keys()) if (!draft.keys.some(([saved]) => saved === hash)) keys.delete(hash);
            host = existing ?? { ...next, generation: 0, pending: new Map(), streams: new Map() };
            hosts.set(host.id, host);
            if (host.socket) { const previous = host.socket; disconnected(host, previous); previous.close(1012, 'Host connection replaced'); }
            Object.assign(host, next); host.generation += 1; clearTimeout(timer);
            if (!retired && socket.readyState === RELAY_SOCKET_OPEN) {
              host.socket = socket;
              host.issueCredential = message.credentialRotation ? () => issueCredential(false) : undefined;
              if (!options.durable || !message.credentialRotation || credential.kind === 'device') {
                registered();
              }
            }
          } };
        });
        try { await registration; } finally { registration = undefined; }
        if (options.durable && message.credentialRotation && credential.kind !== 'device') await issueCredential(invitation);
        return;
      }
      if (host.socket !== socket) return;
      if (message.type === 'credential_saved') {
        if (!pendingCredential) return closeConnection(1008, 'No pending device credential');
        const pending = pendingCredential;
        await commit(draft => {
          if (!host || host.socket !== socket || !draft.keys.some(([hash]) => hash === pending.hash)) throw new BrokerError(401, 'device_revoked', 'Device credential is unavailable.');
          draft.keys = draft.keys.filter(([hash, value]) => value.installationId !== host!.installationId || hash === pending.hash);
          return {value:undefined,publish() {
            for (const [hash,value] of keys) if (value.installationId === host!.installationId && hash !== pending.hash) keys.delete(hash);
            credentialHash = pending.hash; credential = keys.get(pending.hash)!; pendingCredential = undefined;
          }};
        });
        registered();
      } else if (message.type === 'heartbeat_ack') {
        if (pendingNonce === message.nonce) { clearTimeout(heartbeatDeadline); pendingNonce = undefined; }
      } else if (message.type === 'rpc_response') {
        const pending = host.pending.get(message.requestId);
        if (pending) { clearTimeout(pending.timer); host.pending.delete(message.requestId); pending.resolve(message); }
      } else if (message.type === 'stream_opened') {
        const stream = host.streams.get(message.streamId);
        if (stream && stream.socket.readyState === RELAY_SOCKET_OPEN && stream.authorized?.() !== false) { clearTimeout(stream.timer); stream.ready = true; for (const buffered of stream.buffered) send(host, { uplinkVersion: 2, type: 'stream_message', streamId: message.streamId, message: buffered }); stream.buffered = []; }
      } else if (message.type === 'stream_message') {
        const stream = host.streams.get(message.streamId);
        if (stream?.socket.readyState === RELAY_SOCKET_OPEN && stream.authorized?.() !== false) {
          if (stream.socket.bufferedAmount !== undefined && stream.socket.bufferedAmount > BROKER_MAX_FRAME_BYTES) stream.socket.close(1013, 'Slow browser connection');
          else stream.socket.send(message.message);
        }
      } else if (message.type === 'stream_close') {
        const stream = host.streams.get(message.streamId); host.streams.delete(message.streamId); stream?.socket.close(message.code, message.reason);
      } else if (message.type === 'preview_snapshot') {
        await previews.update(host.id, message.snapshot);
      } else closeConnection(1008, 'Unexpected uplink message');
      } catch (error) {
        const code = error instanceof BrokerError && error.status === 401 ? 1008 : error instanceof BrokerError && error.status === 429 ? 1013 : 1011;
        closeConnection(code, code === 1011 ? 'Host message could not be processed' : (error as Error).message);
      }
    }
    async function issueCredential(consumeInvitation: boolean): Promise<void> {
      if (issuing) return issuing;
      if (pendingCredential) throw new BrokerError(409, 'rotation_pending', 'A device credential is awaiting confirmation.');
      const value = `arc_device_${randomBytes(32).toString('base64url')}`;
      const nextHash = keyHash(value);
      const operation = commit(draft => {
        if (!host || host.socket !== socket || keys.get(credentialHash) !== credential) throw new BrokerError(401, 'device_revoked', 'Device is no longer connected.');
        if (draft.keys.length >= 128 && !consumeInvitation) throw new BrokerError(429, 'capacity_exceeded', 'Too many device credentials.');
        const next: DeviceCredential = {expires:Number.MAX_SAFE_INTEGER,installationId:host.installationId,kind:'device'};
        if (consumeInvitation) draft.keys = draft.keys.filter(([hash]) => hash !== credentialHash);
        draft.keys.push([nextHash,next]);
        return {value:undefined,publish() {
          keys.set(nextHash,next); pendingCredential = {hash:nextHash,value:next};
          if (consumeInvitation) {keys.delete(credentialHash);credentialHash=nextHash;credential=next;}
        }};
      }).then(() => { if (host?.socket === socket) send(host, {uplinkVersion:2,type:'credential_issued',credential:value}); });
      issuing=operation;
      try {await operation;} finally {issuing=undefined;}
    }
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
        if (result.status >= 300) {
          const failure = sessionAttachFailure(result.body);
          throw new BrokerError(result.status, failure.code, failure.error, false, result.requestId);
        }
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
  async function mutate(host: Host, action: string, body: Record<string, unknown>, creatorSubject?: string): Promise<Binding> {
    const providerId = host.legacyDsh ? 'dsh' : required(body.providerId, 'providerId');
    if (!host.providers.some((provider) => provider.providerId === providerId)) throw new BrokerError(400, 'invalid_provider', 'The selected provider is unavailable on this Host.');
    if (host.legacyDsh && action === 'create' && ['cwd', 'model', 'reasoningEffort', 'planning', 'sourceNativeSessionId'].some((key) => body[key] !== undefined)) {
      throw new BrokerError(400, 'unsupported_configuration', 'This Host uses native model settings and a registered workspace.');
    }
    if (host.legacyDsh && action === 'child/attach') throw new BrokerError(400, 'unsupported_operation', 'This Host does not support native child attachment.');
    const attaching = action !== 'create';
    const nativeSessionId = attaching ? required(body.nativeSessionId, 'nativeSessionId') : randomUUID();
    const parentNativeSessionId = action === 'child/attach' ? required(body.parentNativeSessionId, 'parentNativeSessionId') : undefined;
    if (parentNativeSessionId) creatorSubject ??= nativeBindings.get(JSON.stringify([host.id, providerId, parentNativeSessionId]))?.creatorSubject;
    const key = JSON.stringify([host.id, providerId, action === 'create' ? required(body.operationId, 'operationId') : nativeSessionId]);
    const operation = () => {
      if (bindings.size + pendingBindingSlots.size >= 4096) throw new BrokerError(429, 'capacity_exceeded', 'The local session binding registry is full.', true);
      const slot = Symbol(); pendingBindingSlots.add(slot);
      return (async () => {
        const proposedAgentId = randomUUID();
        const generation = host.generation;
        const request = host.legacyDsh
          ? { nativeSessionId, ...(body.workspaceId === undefined ? {} : { workspaceId: required(body.workspaceId, 'workspaceId') }) }
          : action === 'create'
            ? { providerId, operationId: required(body.operationId, 'operationId'),
                ...optionalSettings(body, ['cwd', 'workspaceId', 'model', 'reasoningEffort', 'planning', 'sourceNativeSessionId']) }
            : { providerId, nativeSessionId, ...(parentNativeSessionId ? { parentNativeSessionId } : {}) };
        const result = await rpc(host, 'POST', `/remote/${action}`, proposedAgentId, JSON.stringify(request));
        if (host.generation !== generation) throw new BrokerError(503, 'host_reconnected', 'The Remote Host changed while the session operation was completing.');
        if (result.status >= 300) {
          if (attaching) {
            const failure = sessionAttachFailure(result.body);
            throw new BrokerError(result.status, failure.code, failure.error, false, result.requestId);
          }
          let detail: Record<string, unknown> = {};
          try { detail = JSON.parse(result.body); } catch { /* Preserve the status if the host did not return JSON. */ }
          throw new BrokerError(result.status, typeof detail.code === 'string' ? detail.code : 'host_rejected', typeof detail.error === 'string' ? detail.error : 'The Remote Host rejected the operation.', result.status < 500 && [
            'invalid_request', 'invalid_provider', 'unsupported_configuration', 'invalid_operation_id',
            'operation_capacity_exceeded', 'operation_result_too_large', 'operation_rejected',
          ].includes(String(detail.code)), result.requestId);
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
        return commit(draft => {
          if (hosts.get(host.id) !== host || host.generation !== generation) throw new BrokerError(503, 'host_reconnected', 'The Remote Host changed while the session operation was completing.');
          const byAgent = bindings.get(agentId); const byNative = nativeBindings.get(nativeKey);
          if ((byAgent && !sameBinding(byAgent, host.id, providerId, actualNativeSessionId)) || (byNative && byNative.agentId !== agentId)) {
            throw new BrokerError(409, 'session_binding_conflict', 'The Remote Host session identity conflicts with an existing binding.');
          }
          if (!byAgent && !byNative && bindings.size >= 4096) throw new BrokerError(429, 'capacity_exceeded', 'The local session binding registry is full.');
          const binding = byAgent ?? byNative ?? { hostId: host.id, providerId, nativeSessionId: actualNativeSessionId, agentId,
            generation: host.generation, ...(creatorSubject ? { creatorSubject } : {}), ...(parentNativeSessionId ? { parentNativeSessionId } : {}) };
          if (binding.parentNativeSessionId !== parentNativeSessionId) throw new BrokerError(409, 'session_binding_conflict', 'The native session parent conflicts with its existing binding.');
          if (creatorSubject && binding.creatorSubject !== creatorSubject) throw new BrokerError(409, 'session_binding_conflict', 'The native session belongs to another user.');
          const { generation: _generation, recovery: _recovery, ...saved } = binding;
          draft.bindings = draft.bindings.filter(value => value.agentId !== agentId); draft.bindings.push(saved);
          return { value: binding, publish() {
            binding.generation = host.generation;
            bindings.set(agentId, binding); nativeBindings.set(nativeKey, binding); pendingBindingSlots.delete(slot);
            attached.set(nativeKey, Promise.resolve(binding));
          } };
        });
      })().finally(() => pendingBindingSlots.delete(slot));
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
      model: body.model ?? null, reasoningEffort: body.reasoningEffort ?? null, planning: body.planning ?? null, ...(body.sourceNativeSessionId === undefined ? {} : { sourceNativeSessionId: body.sourceNativeSessionId }) });
    let existing = creations.get(key);
    if (existing && existing.fingerprint !== fingerprint) throw new BrokerError(409, 'request_conflict', 'This request identity was already used with different settings.');
    if (!existing) {
      if (creations.size >= 4096) throw new BrokerError(429, 'capacity_exceeded', 'The local creation ledger is full.', true);
      existing = { fingerprint, result: operation() }; creations.set(key, existing);
    }
    let binding: Binding;
    try { binding = await existing.result; }
    catch (error) {
      // Only proven pre-dispatch rejections permit this intent to reach the Host again.
      if (error instanceof BrokerError && error.creationRejected && creations.get(key) === existing) creations.delete(key);
      throw error;
    }
    await commit(draft => {
      if (hosts.get(host.id) !== host || bindings.get(binding.agentId) !== binding) throw new BrokerError(404, 'session_unavailable', 'The session binding was revoked.');
      const value = { fingerprint, agentId: binding.agentId };
      draft.creations = draft.creations.filter(([id]) => id !== key); draft.creations.push([key, value]);
      return { value: undefined, publish() { completedCreations.set(key, value); } };
    });
    await recoverBinding(host, binding); return binding;
  }
  async function userMutation(host: Host, action: string, body: Record<string, unknown>, subject?: string): Promise<Binding> {
    if (action === 'create' && body.sourceNativeSessionId !== undefined) {
      requireAccess(host.id, subject);
      const sourceId = required(body.sourceNativeSessionId, 'sourceNativeSessionId');
      const providerId = required(body.providerId, 'providerId');
      const source = nativeBindings.get(JSON.stringify([host.id, providerId, sourceId]));
      if (!source || !sessionAllowed(source, subject)) throw new SharingError(403, 'session_forbidden', 'Source session access is unavailable. Open an accessible source session first.');
    }
    if (owner(subject)) return mutate(host, action, body);
    requireAccess(host.id, subject);
    const providerId = host.legacyDsh ? 'dsh' : required(body.providerId, 'providerId');
    if (action !== 'create') {
      const nativeSessionId = required(body.nativeSessionId, 'nativeSessionId');
      const existing = nativeBindings.get(JSON.stringify([host.id, providerId, nativeSessionId]));
      if (existing && sessionAllowed(existing, subject)) {
        await recoverBinding(host, existing); return existing;
      }
      if (action === 'child/attach') {
        const parentId = required(body.parentNativeSessionId, 'parentNativeSessionId');
        const parent = nativeBindings.get(JSON.stringify([host.id, providerId, parentId]));
        if (parent && sessionAllowed(parent, subject)) {
          await recoverBinding(host, parent);
          const result = await rpc(host, 'GET', `/v1/sessions/${encodeURIComponent(parent.agentId)}/snapshot`, parent.agentId);
          const data = JSON.parse(result.body);
          const children: unknown = data?.payload?.runtimeInfo?.childSessions;
          if (result.status === 200 && Array.isArray(children) && children.some(child => child?.nativeSessionId === nativeSessionId)) {
            requireAccess(host.id, subject);
            if (existing && existing.creatorSubject !== subject) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
            return mutate(host, action, body, subject);
          }
        }
      }
      throw new SharingError(403, 'session_forbidden', 'Only your own sessions can be attached.');
    }
    if (!host.providers.some(provider => provider.providerId === providerId)) throw new SharingError(400, 'invalid_provider', 'The selected provider is unavailable on this Host.');
    if (host.legacyDsh && ['cwd', 'model', 'reasoningEffort', 'planning', 'sourceNativeSessionId'].some(key => body[key] !== undefined)) throw new SharingError(400, 'unsupported_configuration', 'This Host uses native settings.');
    const operationId = required(body.operationId, 'operationId');
    const fingerprint = JSON.stringify({ providerId, ...optionalSettings(body, ['cwd', 'workspaceId', 'model', 'reasoningEffort', 'planning', 'sourceNativeSessionId']) });
    const reservation = await changeSharing(draft => draft.reserve(host.id, subject!, providerId, operationId, fingerprint));
    if (!reservation.fresh) {
      const completedId = reservation.agentId ?? completedCreations.get(JSON.stringify([host.id, providerId, reservation.nativeRequestId]))?.agentId;
      const binding = completedId && bindings.get(completedId);
      if (binding && sessionAllowed(binding, subject)) {
        if (!reservation.agentId) await changeSharing(draft => draft.complete(reservation.key, binding.agentId));
        await recoverBinding(host, binding); return binding;
      }
      const pending = sharedCreates.get(reservation.key);
      if (pending) return pending;
      throw new SharingError(409, 'creation_outcome_unknown', 'A previous creation is unresolved. Its quota reservation is retained; ask the Host owner to reconcile it.');
    }
    requireAccess(host.id, subject);
    const operation = mutate(host, action, { ...body, operationId: reservation.nativeRequestId }, subject).then(async binding => {
      await changeSharing(draft => draft.complete(reservation.key, binding.agentId)); return binding;
    }).catch(async error => {
      // Transport and persistence failures may occur after native creation succeeded.
      if (error instanceof BrokerError && error.creationRejected) {
        await changeSharing(draft => draft.release(reservation.key));
      }
      throw error;
    });
    sharedCreates.set(reservation.key, operation);
    try { return await operation; } finally { sharedCreates.delete(reservation.key); }
  }
  async function sharedCatalog(host: Host, action: string, query: URLSearchParams, subject: string): Promise<RpcResponse> {
    const providerId = host.legacyDsh ? 'dsh' : query.get('providerId');
    const owned = [...bindings.values()].filter(binding => binding.hostId === host.id && binding.providerId === providerId && binding.creatorSubject === subject && !binding.parentNativeSessionId);
    const revisionResult = await rpc(host, 'GET', `/remote/catalog/revision${query.size ? '?' + query : ''}`);
    requireAccess(host.id, subject);
    if (revisionResult.status !== 200) return revisionResult;
    const revision = createHash('sha256').update(JSON.stringify([JSON.parse(revisionResult.body).revision, owned.map(value => value.nativeSessionId)])).digest('hex');
    if (action === 'catalog/revision') return { status: 200, body: JSON.stringify({ revision }) };
    if (host.legacyDsh) {
      const result = await rpc(host, 'GET', `/remote/catalog${query.size ? '?' + query : ''}`);
      requireAccess(host.id, subject);
      if (result.status !== 200) return result;
      const page = JSON.parse(result.body);
      return { status: 200, body: JSON.stringify({ ...page, revision, items: Array.isArray(page.items) ? page.items.filter((item: { nativeSessionId?: string }) => owned.some(value => value.nativeSessionId === item.nativeSessionId)) : [] }) };
    }
    const offset = Number(query.get('cursor') ?? 0); const limit = Number(query.get('limit') ?? 30);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SharingError(400, 'invalid_cursor', 'Invalid session page.');
    const items = [];
    for (const binding of owned.slice(offset, offset + limit)) {
      const parameters = new URLSearchParams({ providerId: binding.providerId, nativeSessionId: binding.nativeSessionId });
      const result = await rpc(host, 'GET', `/remote/catalog/session?${parameters}`);
      requireAccess(host.id, subject);
      if (result.status === 404) continue;
      if (result.status !== 200) return result;
      const summary = JSON.parse(result.body);
      if (summary.nativeSessionId !== binding.nativeSessionId || summary.providerId !== binding.providerId) throw new SharingError(502, 'invalid_host_response', 'Host returned a different session summary.');
      items.push(summary);
    }
    requireAccess(host.id, subject);
    const next = offset + limit;
    return { status: 200, body: JSON.stringify({ items, hasMore: next < owned.length, ...(next < owned.length ? { nextCursor: String(next) } : {}), revision }) };
  }

  async function handle(request: Request, context: BrokerRequestContext, url: URL) {
    assertAvailable();
    if (!await permitted(context)) throw new BrokerError(403, 'forbidden', 'This endpoint is available only to the local application.');
    if (request.method === 'POST') {
      const access = context.validateMutation?.();
      if (access?.status === 'rejected') throw new BrokerError(access.httpStatus, access.code, access.message);
    }
    const subject = principal(context);
    const vscodeTunnel = /^\/v1\/remote\/hosts\/([^/]+)\/vscode-tunnel(?:\/(start|stop))?$/.exec(url.pathname);
    if (vscodeTunnel) {
      requireOwner(subject); requireAccess(vscodeTunnel[1]!, subject);
      const action = vscodeTunnel[2];
      if ((!action && request.method !== 'GET') || (action && request.method !== 'POST')) return json(405, { error: 'Method is not allowed.' });
      const body = action ? await readBody(request) : undefined;
      if (action === 'start' && body?.acceptLicense !== true) return json(400, { error: 'Accept the VS Code Server license terms before starting.' });
      const result = await rpc(requireHost(vscodeTunnel[1]!), action ? 'POST' : 'GET', `/remote/vscode-tunnel${action ? `/${action}` : ''}`, undefined,
        action ? JSON.stringify(action === 'start' ? { acceptLicense: true } : {}) : undefined);
      requireOwner(principal(context)); requireAccess(vscodeTunnel[1]!, principal(context));
      return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    const previewSession = /^\/v1\/sessions\/([^/]+)\/previews$/.exec(url.pathname);
    if (previewSession && request.method === 'POST') {
      requireOwner(subject);
      const binding = bindings.get(previewSession[1]!);
      if (!binding || !sessionAllowed(binding, subject)) throw new BrokerError(404, 'session_unavailable', 'Session is unavailable.');
      const body = await readBody(request);
      const target = required(body.target, 'target'); const itemId = required(body.itemId, 'itemId');
      if (body.pathMode !== undefined && body.pathMode !== 'strip' && body.pathMode !== 'preserve') throw new BrokerError(400, 'invalid_path_mode', 'Choose strip or preserve path mode.');
      const result = await rpc(requireHost(binding.hostId), 'POST', '/remote/previews', undefined,
        JSON.stringify({ target, source: { sessionId: binding.agentId, itemId }, pathMode: body.pathMode ?? 'strip' }));
      return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json' } });
    }
    const previewHost = /^\/v1\/remote\/hosts\/([^/]+)\/previews(?:\/([A-Za-z0-9_-]+)\/(unregister|renew))?$/.exec(url.pathname);
    if (previewHost) {
      requireOwner(subject); requireAccess(previewHost[1]!, subject);
      if (!previewHost[2] && request.method === 'GET') {
        const snapshot = previews.list(previewHost[1]!);
        return json(200, { ...snapshot, registrations: snapshot.registrations.filter(value => value.status === 'active') });
      }
      if (previewHost[2] && request.method === 'POST') {
        await readBody(request);
        if (previewHost[3] === 'renew') {
          const registration = previews.list(previewHost[1]!).registrations.find(value => value.id === previewHost[2]);
          if (!registration || registration.status === 'unregistered' || registration.pendingUnregister) return json(409, { error: 'Preview is unavailable or has been unregistered.' });
          const nameId = previews.nameId(previewHost[1]!, previewHost[2]);
          if (previews.list(previewHost[1]!).registrations.some(value => value.id !== registration.id && value.status === 'active'
            && value.expiresAt > now() && !value.pendingUnregister && previews.nameId(previewHost[1]!, value.id) === nameId))
            return json(409, { error: 'A newer registration uses this tunnel name. Open the current preview.' });
          const result = await rpc(requireHost(previewHost[1]!), 'POST', '/remote/previews/renew', undefined, JSON.stringify({ id: previewHost[2] }));
          return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json' } });
        }
        await previews.unregister(previewHost[1]!, previewHost[2]);
        return json(200, { registration: previews.list(previewHost[1]!).registrations.find(value => value.id === previewHost[2]) });
      }
      return json(405, { error: 'Method is not allowed.' });
    }
    if (url.pathname === '/v1/remote/hosts' && request.method === 'GET') return json(200, { hosts: visibleHosts(subject) });
    if (url.pathname === '/v1/remote/pairings') {
      requireOwner(subject);
      if (request.method === 'GET') return json(200, { availablePurposes: options.durable ? ['host-only', 'gateway-setup'] : ['host-only'],
        pairings: [...pairings].sort((a, b) => b.createdAt - a.createdAt).map(item => visiblePairing(item, now())) });
      if (request.method !== 'POST') return json(405, { error: 'Method is not allowed.' });
      const body = await readBody(request);
      const purpose = body.purpose ?? 'host-only';
      if (Object.keys(body).some(key => key !== 'purpose') || !isPairingPurpose(purpose)) throw new BrokerError(400, 'invalid_request', 'Select a supported pairing purpose.');
      if (!options.durable && purpose !== 'host-only') throw new BrokerError(400, 'unsupported_purpose', 'Gateway setup requires an account-backed Relay.');
      const key = `arc_${randomBytes(32).toString('base64url')}`;
      const createdAt = now(); const expires = createdAt + (options.keyLifetimeMs ?? (options.durable ? 10 * 60 * 1000 : 24 * 60 * 60 * 1000));
      const item: SavedPairingKey = { id: randomUUID(), purpose, createdAt, expiresAt: expires };
      await commit(draft => {
        draft.keys = draft.keys.filter(([, value]) => value.expires > now());
        if (draft.keys.length >= 128) throw new BrokerError(429, 'capacity_exceeded', 'Too many active temporary keys.');
        if ((draft.pairings?.length ?? 0) >= MAX_PAIRING_HISTORY) throw new BrokerError(429, 'pairing_history_full', 'Delete old pairing key records before creating another key.');
        const credential: DeviceCredential = { expires, purpose, pairingId: item.id, ...(options.durable ? { requiresRotation: true } : {}) };
        draft.keys.push([keyHash(key), credential]);
        (draft.pairings ??= []).push(item);
        return { value: undefined, publish() {
          for (const [hash, value] of keys) if (value.expires <= now()) keys.delete(hash);
          pairings = draft.pairings!;
          keys.set(keyHash(key), credential); options.onPairing?.(key, expires);
        } };
      });
      return json(201, { ...visiblePairing(item, now()), key, serverUrl: options.publicUrl ?? context.serverUrl ?? new URL(request.url).origin,
        ...(options.durable && options.publicUrl ? { command: `export AGENT_HOST_SERVER='${options.publicUrl.replaceAll("'", "'\\''")}'\nexport AGENT_HOST_REMOTE_KEY='${key}'\nagent-remote-controller start` } : {}) });
    }
    const pairingAction = /^\/v1\/remote\/pairings\/([^/]+)(\/revoke)?$/.exec(url.pathname);
    if (pairingAction) {
      requireOwner(subject);
      const revoke = pairingAction[2] === '/revoke';
      if (request.method !== (revoke ? 'POST' : 'DELETE')) return json(405, { error: 'Method is not allowed.' });
      const body = await readBody(request);
      if (Object.keys(body).length) throw new BrokerError(400, 'invalid_request', 'No pairing management parameters are accepted.');
      await commit(draft => {
        const item = draft.pairings?.find(item => item.id === pairingAction[1]);
        if (!item) throw new BrokerError(404, 'pairing_not_found', 'Pairing key record is unavailable.');
        if (revoke && pairingStatus(item, now()) === 'used') throw new BrokerError(409, 'pairing_used', 'This key has been used. Manage the paired Host to revoke its access.');
        if (item.usedAt === undefined) draft.keys = draft.keys.filter(([, key]) => key.pairingId !== item.id);
        if (revoke) item.revokedAt ??= now();
        else draft.pairings = draft.pairings!.filter(value => value.id !== item.id);
        return { value: undefined, publish() {
          pairings = draft.pairings ?? [];
          for (const hash of keys.keys()) if (!draft.keys.some(([saved]) => saved === hash)) keys.delete(hash);
          for (const check of expiryChecks) check();
        } };
      });
      return json(200, { ok: true });
    }
    const management = /^\/v1\/remote\/hosts\/([^/]+)\/(rotate|stop)$/.exec(url.pathname);
    if (management && request.method === 'POST') {
      requireOwner(subject);
      const body = await readBody(request);
      const host = requireHost(management[1]!);
      if (management[2] === 'rotate') {
        if (Object.keys(body).length) throw new BrokerError(400, 'invalid_request', 'No parameters are accepted.');
        if (!options.durable || !host.issueCredential) throw new BrokerError(409, 'host_upgrade_required', 'Update and reconnect Agent Host before rotating its credential.');
        await host.issueCredential();
        return json(200, {ok:true,status:'pending'});
      }
      if (Object.keys(body).some(key => key !== 'operationId')) throw new BrokerError(400, 'invalid_request', 'Stop accepts only an operation identity.');
      const result = await rpc(host, 'POST', '/remote/stop', undefined, JSON.stringify({ operationId: required(body.operationId, 'operationId') }));
      return rawJson(result);
    }
    const revoking = /^\/v1\/remote\/hosts\/([^/]+)\/revoke$/.exec(url.pathname);
    if (options.durable && revoking && request.method === 'POST') {
      requireOwner(subject);
      await readBody(request);
      const host = hosts.get(revoking[1]!);
      if (!host) throw new BrokerError(404, 'host_not_found', 'The Remote Host is unknown.');
      previews.invalidate(host.id);
      await commit(draft => {
        draft.keys = draft.keys.filter(([, credential]) => credential.installationId !== host.installationId);
        draft.bindings = draft.bindings.filter(binding => binding.hostId !== host.id);
        draft.creations = draft.creations.filter(([, value]) => draft.bindings.some(binding => binding.agentId === value.agentId));
        draft.hosts = draft.hosts.filter(value => value.id !== host.id);
        draft.previews = (draft.previews ?? []).filter(value => value.hostId !== host.id);
        return { value: undefined, publish() {
          for (const [key, credential] of keys) if (credential.installationId === host.installationId) keys.delete(key);
          for (const [id, binding] of bindings) if (binding.hostId === host.id) {
            bindings.delete(id); const key = JSON.stringify([host.id, binding.providerId, binding.nativeSessionId]);
            nativeBindings.delete(key); attached.delete(key);
          }
          for (const [key, value] of completedCreations) if (!bindings.has(value.agentId)) { completedCreations.delete(key); creations.delete(key); }
          hosts.delete(host.id);
          previews.forget(host.id);
          if (host.socket) { const socket = host.socket; disconnected(host, socket); socket.close(1008, 'Device revoked'); }
        } };
      });
      return json(200, { ok: true });
    }
    const directory = /^\/v1\/remote\/hosts\/([^/]+)\/(catalog(?:\/revision)?|workspaces|workspace-folders(?:\/create)?|models|child\/attach|attach|create)$/.exec(url.pathname);
    if (directory) {
      requireAccess(directory[1]!, subject);
      const action = directory[2]!;
      if (action.startsWith('workspace-folders')) requireOwner(subject);
      const host = requireHost(directory[1]!);
      if (action === 'models' && request.method === 'GET' && host.legacyDsh) return json(200, { models: [] });
      if (['catalog', 'catalog/revision', 'workspaces', 'workspace-folders', 'models'].includes(action) && request.method === 'GET') {
        const query = new URLSearchParams(url.search);
        const providerId = query.get('providerId');
        if (!host.legacyDsh && (!providerId || !host.providers.some((provider) => provider.providerId === providerId))) throw new BrokerError(400, 'invalid_provider', 'The selected provider is unavailable on this Host.');
        if (host.legacyDsh) query.delete('providerId');
        if (!owner(subject) && action.startsWith('catalog')) {
          return rawJson(await sharedCatalog(host, action, query, subject!));
        }
        const result = await rpc(host, 'GET', `/remote/${action}${query.size ? '?' + query : ''}`);
        requireAccess(host.id, subject);
        return rawJson(result);
      }
      if (action === 'workspace-folders/create' && request.method === 'POST') {
        const payload = await readBody(request);
        const providerId = required(payload.providerId, 'providerId');
        if (host.legacyDsh || !host.providers.some(provider => provider.providerId === providerId)) throw new BrokerError(400, 'invalid_provider', 'The selected provider is unavailable on this Host.');
        const result = await rpc(host, 'POST', '/remote/workspace-folders/create', undefined, JSON.stringify({
          providerId, parentPath: required(payload.parentPath, 'parentPath'), name: required(payload.name, 'name'),
        }));
        requireAccess(host.id, subject); requireOwner(subject);
        return rawJson(result);
      }
      if (['attach', 'child/attach', 'create'].includes(action) && request.method === 'POST') { const binding = await userMutation(host, action, await readBody(request), subject);
        if (!sessionAllowed(binding, subject)) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
        return json(200, { agentId: binding.agentId, nativeSessionId: binding.nativeSessionId }); }
    }
    const session = /^\/v1\/sessions\/([^/]+)\/(snapshot|timeline)$/.exec(url.pathname);
    const binding = session && bindings.get(session[1]!);
    if (binding && request.method === 'GET') {
      if (!sessionAllowed(binding, subject)) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
      const host = requireHost(binding.hostId); await recoverBinding(host, binding);
      const result = await rpc(host, 'GET', url.pathname + url.search, binding.agentId);
      if (!sessionAllowed(binding, subject)) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
      return rawJson(result);
    }
    throw new BrokerError(404, 'route_not_found', 'Unknown Remote Host route.');
  }
  async function upgrade(request: Request, context: BrokerRequestContext, url: URL) {
    assertAvailable();
    if (url.pathname === '/ws/remote-host') {
      const header = request.headers.get('authorization');
      const hash = header?.startsWith('Bearer ') ? keyHash(header.slice(7)) : undefined;
      const key = hash ? keys.get(hash) : undefined;
      if (!key || key.claimedAt !== undefined || key.expires <= now()) return rejectUpgrade(401);
      return { accept(client: RelaySocket) {
        if (unavailable || keys.get(hash!) !== key || key.claimedAt !== undefined || key.expires <= now()) { client.close(1008, 'Device credential revoked'); return; }
        track(client);
        register(client, key, context, hash!);
      } };
    }
    const match = /^\/v1\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    const binding = match && bindings.get(match[1]!);
    if (!binding || !sessionAllowed(binding, principal(context)) || !await permitted(context) || request.headers.get('origin') !== origin) return rejectUpgrade(403);
    let host: Host;
    try { host = requireHost(binding.hostId); await recoverBinding(host, binding); } catch { return rejectUpgrade(503); }
    const subject = principal(context);
    const userStreams = () => subject === undefined ? 0 : options.userStreamCount?.(subject) ?? activeStreamCount(subject);
    if (host.streams.size >= 128 || userStreams() >= 32) return rejectUpgrade(429);
    return { accept(client: RelaySocket) {
      if (!sessionAllowed(binding, principal(context))) { client.close(1008, 'Session access is unavailable'); return; }
      if (host.streams.size >= 128 || userStreams() >= 32) { client.close(1013, 'Remote stream capacity reached'); return; }
      track(client);
      const expiry = () => sessionAllowed(binding, principal(context)) ? context.connectionExpiresAt?.() : 0;
      expire(client, expiry);
      if (client.readyState !== RELAY_SOCKET_OPEN) return;
      const streamId = randomUUID(); const stream: Host['streams'] extends Map<string, infer Value> ? Value : never = { socket: client, subject: principal(context), authorized: () => { const end = expiry(); return end === undefined || end > now(); }, ready: false, buffered: [] };
      host.streams.set(streamId, stream);
      const opening = setTimeout(() => client.close(1013, 'Remote stream opening timed out'), options.rpcTimeoutMs ?? 30_000);
      stream.timer = opening;
      client.onError(() => undefined);
      let messageWindow = now(); let messageCount = 0; let imageChunkCount = 0; let imageChunkBytes = 0;
      client.onMessage((raw, binary) => {
        if (binary) return client.close(1003, 'Text protocol required');
        if (now()-messageWindow >= 60_000) { messageWindow=now(); messageCount=0; imageChunkCount=0; imageChunkBytes=0; }
        let publicMessage: { type?: string; payload?: { locator?: unknown } };
        try { publicMessage = JSON.parse(raw.toString()); } catch { return client.close(1008, 'Invalid session message'); }
        if (publicMessage?.type === 'image_upload_chunk') {
          const bytes = Buffer.byteLength(raw.toString());
          imageChunkBytes += bytes;
          if (bytes > 48 * 1024 || ++imageChunkCount > 2048 || imageChunkBytes > 48 * 1024 * 1024) return client.close(1008, 'Image upload rate exceeded');
        } else if (++messageCount > 120) return client.close(1008, 'Control message rate exceeded');
        if (context.authorizeMessage?.(raw.toString()) === false) return client.close(1008, 'Recent authentication is required');
        if (!owner(subject)) {
          try { if (publicMessage.type === 'resource_resolve_request' && !(typeof publicMessage.payload?.locator === 'string' && /^input-image:[a-f0-9-]{36}$/.test(publicMessage.payload.locator))) return client.close(1008, 'Only the Host owner can resolve local files'); }
          catch { return client.close(1008, 'Invalid session message'); }
        }
        const expiresAt = expiry();
        if (expiresAt !== undefined && expiresAt <= now()) return client.close(1008, 'Credential expired');
        if (!stream.ready) {
          if (stream.buffered.length >= 32 || stream.buffered.reduce((sum, value) => sum + Buffer.byteLength(value), 0) + Buffer.byteLength(raw.toString()) > 1024 * 1024) return client.close(1013, 'Remote stream is not ready');
          stream.buffered.push(raw.toString()); return;
        }
        clearTimeout(opening);
        try { send(host, { uplinkVersion: 2, type: 'stream_message', streamId, message: raw.toString() }); } catch { client.close(1012, 'Remote Host disconnected'); }
      });
      client.onClose(() => {
        clearTimeout(opening);
        if (!host.streams.delete(streamId)) return;
        try { send(host, { uplinkVersion: 2, type: 'stream_close', streamId, code: 1000, reason: 'Browser disconnected' }); } catch { /* The host may already be offline. */ }
      });
      try { send(host, { uplinkVersion: 2, type: 'stream_open', streamId, sessionId: binding.agentId }); }
      catch { client.close(1012, 'Remote Host disconnected'); }
    } };
  }
  const handlesRequest = (url: URL) => {
    const session = /^\/v1\/sessions\/([^/]+)\//.exec(url.pathname);
    return /^\/v1\/remote\/(hosts|pairings)(\/|$)/.test(url.pathname) || !!(session && bindings.has(session[1]!));
  };
  const handlesUpgrade = (url: URL) => {
    const session = /^\/v1\/sessions\/([^/]+)\//.exec(url.pathname);
    return url.pathname === '/ws/remote-host' || !!(session && bindings.has(session[1]!));
  };
  function authenticateDevice(value: string) {
    if (unavailable || !options.durable) return undefined;
    const hash = keyHash(value); const credential = keys.get(hash);
    if (!credential || credential.kind !== 'device' || credential.requiresRotation || !credential.installationId || credential.expires <= now()) return undefined;
    const host = [...hosts.values()].find(host => host.installationId === credential.installationId);
    if (!host) return undefined;
    return { hostId: host.id, hostName: host.name, pairingPurpose: host.pairingPurpose ?? (host.gatewayKeyRequested ? 'gateway-setup' : 'host-only'),
      current: () => !unavailable && keys.get(hash) === credential && credential.expires > now() && hosts.get(host.id) === host };
  }
  return {
    previews,
    authenticateDevice,
    async markGatewayKeyRequested(value: string): Promise<boolean> {
      return commit(draft => {
        const device = authenticateDevice(value);
        if (!device || device.pairingPurpose !== 'gateway-setup') return { value: false, publish() {} };
        draft.hosts.find(host => host.id === device.hostId)!.gatewayKeyRequested = true;
        return { value: true, publish() { hosts.get(device.hostId)!.gatewayKeyRequested = true; } };
      });
    },
    gatewayKeyHost(hostId: string, subject: string) {
      const host = hosts.get(hostId);
      return !unavailable && owner(subject) && host?.gatewayKeyRequested ? { hostId: host.id, hostName: host.name } : undefined;
    },
    ownsHost: (hostId: string, subject: string) => hosts.has(hostId) && owner(subject),
    tunnelHost: (token: string) => [...hosts.values()].find(host => host.ready && host.socket?.readyState === RELAY_SOCKET_OPEN && host.tunnelToken === token)?.id,
    acceptTunnel(token: string, socket: TunnelSocket) {
      const host = [...hosts.values()].find(host => host.ready && host.socket?.readyState === RELAY_SOCKET_OPEN && host.tunnelToken === token);
      if (!host || unavailable) { socket.close(1008, 'Tunnel authorization expired'); return; }
      previews.attach(host.id, socket);
    },
    snapshot,
    activeStreamCount,
    settled: () => commits.then(() => undefined),
    visibleHosts,
    hasHost: (hostId: string) => hosts.has(hostId),
    canAccessHost: hostAllowed,
    canStarSession: (item: { hostId: string; providerId: string; nativeSessionId: string }, subject: string) => {
      const host = hosts.get(item.hostId);
      if (!hostAllowed(item.hostId, subject) || !host?.providers.some(provider => provider.providerId === item.providerId)) return false;
      const binding = nativeBindings.get(JSON.stringify([item.hostId, item.providerId, item.nativeSessionId]));
      return owner(subject) || !!binding && sessionAllowed(binding, subject);
    },
    canAccessSession: (agentId: string, subject: string) => { const binding = bindings.get(agentId); return !!binding && sessionAllowed(binding, subject); },
    async manageShares(subject: string, hostId: string, action: 'shares' | 'share' | 'revoke-share', targetSubject?: string, targetLabel?: string, sessionLimit?: number) {
      assertAvailable();
      requireOwner(subject);
      if (!hosts.has(hostId)) throw new SharingError(404, 'host_not_found', 'Host is unavailable.');
      if (action === 'shares') return { shares: sharing.list(hostId) };
      if (!targetSubject || targetSubject === options.ownerSubject) throw new SharingError(400, 'invalid_recipient', 'Choose another user.');
      if (action === 'share') await changeSharing(draft => draft.set(hostId, targetSubject, targetLabel ?? targetSubject, sessionLimit!));
      else {
        await changeSharing(draft => draft.revoke(hostId, targetSubject));
        const host = hosts.get(hostId)!;
        for (const [streamId, stream] of host.streams) if (stream.subject === targetSubject) {
          host.streams.delete(streamId); stream.buffered = []; clearTimeout(stream.timer);
          stream.socket.close(1008, 'Host share revoked');
          try { send(host, { uplinkVersion: 2, type: 'stream_close', streamId, code: 1008, reason: 'Host share revoked' }); } catch { /* The Host may be offline. */ }
        }
      }
      for (const check of expiryChecks) check();
      return { ok: true };
    },
    enforceExpiry() { for (const check of expiryChecks) check(); },
    disconnect(code = 1008) {
      for (const host of hosts.values()) if (host.socket) { const socket = host.socket; disconnected(host, socket); socket.close(code, code === 1008 ? 'Access revoked' : 'Authority temporarily unavailable'); }
    },
    handlesRequest,
    handlesUpgrade,
    async handleRequest(request: Request, context: BrokerRequestContext = {}): Promise<Response | undefined> {
      const url = new URL(request.url);
      if (!handlesRequest(url)) return undefined;
      try { return await handle(request, context, url); }
      catch (error) {
        if (error instanceof BrokerError || error instanceof SharingError) return json(error.status, { code: error.code, error: error.message, ...(error instanceof BrokerError && error.requestId ? { requestId: error.requestId } : {}) });
        return json(503, { code: 'host_operation_failed', error: error instanceof Error ? error.message : 'Remote Host operation failed.' });
      }
    },
    async prepareUpgrade(request: Request, context: BrokerRequestContext = {}): Promise<{ accept(socket: RelaySocket): void } | Response | undefined> {
      const url = new URL(request.url);
      if (!handlesUpgrade(url)) return undefined;
      try { return await upgrade(request, context, url); }
      catch { return rejectUpgrade(503); }
    },
    close() {
      unavailable = true;
      previews.close();
      for (const cleanup of [...uplinkCleanups.values()]) cleanup();
      for (const host of hosts.values()) if (host.socket) disconnected(host, host.socket);
      for (const client of clients) client.close(1001, 'Broker closed');
      clients.clear();
      keys.clear(); hosts.clear(); bindings.clear(); nativeBindings.clear(); attached.clear(); creations.clear();
    },
  };
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
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const parts: Uint8Array[] = []; let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > BROKER_MAX_BODY_BYTES) {
          void reader.cancel().catch(() => undefined);
          throw new BrokerError(413, 'request_too_large', 'The request body is too large.');
        }
        parts.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(parts).toString() || '{}'); } catch { throw new BrokerError(400, 'invalid_json', 'The request body must be JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrokerError(400, 'invalid_request', 'The request body must be an object.');
  return value as Record<string, unknown>;
}
function json(status: number, value: unknown) { return rawJson({ status, body: JSON.stringify(value) }); }
function rawJson(result: RpcResponse) {
  const body = [204, 205, 304].includes(result.status) ? null : result.body;
  return new Response(body, { status: result.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
function rejectUpgrade(status: number) { return new Response(null, { status }); }

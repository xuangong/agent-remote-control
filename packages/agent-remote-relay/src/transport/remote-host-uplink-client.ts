import { WebSocket } from 'ws';

import {
  decodeRemoteHostUplinkMessage, REMOTE_HOST_UPLINK_VERSION, UPLINK_MAX_FRAME_BYTES,
  type ControllerIdentity, type RemoteHostHeartbeat, type HostEnvironment, type PairingPurpose,
  type PreviewRegistrationSnapshot,
} from '@orchardworks/agent-remote-protocol';

import type { AgentRemoteRelay } from '../relay.js';
import { createRemoteHostPluginHost, type RemoteHostPluginHostOptions } from './remote-host-plugin.js';
import type { SessionWireOperationExecutor } from '../session-wire.js';
import { createUplinkWriter } from './uplink-writer.js';

export interface RemoteHostUplinkDiagnostic {
  readonly event: 'connecting' | 'registered' | 'disconnected' | 'reconnect_scheduled' | 'reconnect_stopped' | 'closed';
  readonly connectionId: number;
  readonly registered: boolean;
  readonly reason?: 'heartbeat_timeout' | 'registration_timeout' | 'socket_error' | 'socket_closed' | 'http_rejected'
    | 'protocol_error' | 'write_failure' | 'host_failure' | 'credential_persistence_failed' | 'client_closed';
  readonly closeCode?: number;
  /** A known broker close reason, independently of the local first cause. */
  readonly peerReason?: 'heartbeat_timeout' | 'heartbeat_delivery_failed' | 'connection_replaced' | 'broker_closed';
  readonly httpStatus?: number;
  readonly errorCode?: string;
  readonly retryAttempt?: number;
  readonly retryDelayMs?: number;
  /** The complete local silence deadline, including the cloud interval and acknowledgement timeout. */
  readonly heartbeatTimeoutMs?: number;
  readonly lastHeartbeatAgeMs?: number;
}
type DiagnosticDetails = Omit<RemoteHostUplinkDiagnostic, 'event'>;
type DisconnectCause = Pick<RemoteHostUplinkDiagnostic, 'reason' | 'errorCode' | 'httpStatus'>;

export interface RemoteHostUplinkClientOptions {
  readonly previews?: {
    snapshot(): PreviewRegistrationSnapshot | undefined;
    subscribe(listener: (snapshot: PreviewRegistrationSnapshot) => void): () => void;
    registered(info: { hostId: string; tunnelToken: string }): void;
    disconnected(): void;
  };
  readonly relay: AgentRemoteRelay;
  readonly installationId: string;
  readonly name: string;
  readonly environment?: HostEnvironment;
  readonly controller?: ControllerIdentity;
  readonly providers?: readonly { providerId: string; displayName: string; promptEditing?: true; sessionRename?: true }[];
  readonly remoteKey: string;
  /** Must durably persist the offered credential before resolving. */
  readonly onCredential?: (credential: string) => Promise<void>;
  readonly url: string;
  readonly resolveSession: RemoteHostPluginHostOptions['resolveSession'];
  readonly acquireSession?: RemoteHostPluginHostOptions['acquireSession'];
  readonly control: RemoteHostPluginHostOptions['control'];
  readonly operationExecutor?: (scope: string) => SessionWireOperationExecutor;
  readonly registrationTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  readonly maxQueuedMessages?: number;
  readonly maxQueuedBytes?: number;
  readonly reconnectBaseDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  readonly onStateChange?: (state: 'connecting' | 'registered' | 'disconnected' | 'rejected' | 'closed') => void;
  readonly onDiagnostic?: (diagnostic: RemoteHostUplinkDiagnostic) => void | Promise<void>;
}

export interface RemoteHostUplinkClient {
  readonly ready: Promise<{ hostId: string; pairingPurpose?: PairingPurpose }>;
  close(): Promise<void>;
}

export function createRemoteHostUplinkClient(options: RemoteHostUplinkClientOptions): RemoteHostUplinkClient {
  validateConfiguration(options);
  const registrationTimeout = positive(options.registrationTimeoutMs ?? 5000);
  const writeTimeout = positive(options.writeTimeoutMs ?? 10000);
  const maxQueuedMessages = positive(options.maxQueuedMessages ?? 256);
  const maxQueuedBytes = positive(options.maxQueuedBytes ?? 64 * 1024 * 1024);
  const reconnectBaseDelay = positive(options.reconnectBaseDelayMs ?? 1000);
  const reconnectMaxDelay = positive(options.reconnectMaxDelayMs ?? 30000);
  if (reconnectMaxDelay < reconnectBaseDelay) throw new RangeError('Remote Host reconnect maximum must not precede its base delay.');
  let resolveReady!: (value: { hostId: string; pairingPurpose?: PairingPurpose }) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<{ hostId: string; pairingPurpose?: PairingPurpose }>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => undefined);
  let remoteKey = options.remoteKey;
  let credentialWrite: Promise<void> | undefined;
  let closed = false;
  let terminal = false;
  let attempts = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retireConnection: (() => void) | undefined;
  let connectionClosed: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  let connectionSequence = 0;
  let describeConnection: () => DiagnosticDetails = () => ({ connectionId: 0, registered: false });

  function diagnose(diagnostic: RemoteHostUplinkDiagnostic): void {
    try { void Promise.resolve(options.onDiagnostic?.(diagnostic)).catch(() => undefined); } catch {}
  }
  function scheduleReconnect(details: DiagnosticDetails): void {
    if (closed || terminal) return;
    const upper = Math.min(reconnectMaxDelay, reconnectBaseDelay * 2 ** Math.min(attempts, 20));
    attempts += 1;
    const delay = Math.floor(upper * (0.5 + Math.random() * 0.5));
    retry = setTimeout(connect, delay);
    diagnose({ ...details, event: 'reconnect_scheduled', retryAttempt: attempts, retryDelayMs: delay });
  }

  function connect(): void {
    if (closed || terminal) return;
    if (credentialWrite) { void credentialWrite.then(connect); return; }
    const connectionId = ++connectionSequence;
    diagnose({ event: 'connecting', connectionId, registered: false });
    options.onStateChange?.('connecting');
    const socket = new WebSocket(options.url, {
      headers: { authorization: `Bearer ${remoteKey}` },
      maxPayload: UPLINK_MAX_FRAME_BYTES,
      handshakeTimeout: registrationTimeout,
      perMessageDeflate: false,
      followRedirects: false,
    });
    let registered = false;
    let registeredHostId: string | undefined;
    let retired = false;
    let registrationDeadline: ReturnType<typeof setTimeout> | undefined;
    let heartbeatDeadline: ReturnType<typeof setTimeout> | undefined;
    let cloudHeartbeat: RemoteHostHeartbeat | undefined;
    let lastHeartbeatAt: number | undefined;
    let retirement: DiagnosticDetails | undefined;
    let operationScope: string | undefined;
    let unsubscribePreviews: (() => void) | undefined;
    function details(): DiagnosticDetails {
      return { connectionId, registered,
        ...(cloudHeartbeat ? { heartbeatTimeoutMs: cloudHeartbeat.intervalMs + cloudHeartbeat.timeoutMs } : {}),
        ...(lastHeartbeatAt === undefined ? {} : { lastHeartbeatAgeMs: Math.max(0, Math.floor(performance.now() - lastHeartbeatAt)) }) };
    }
    describeConnection = details;
    const writer = createUplinkWriter(socket, {
      maxMessages: maxQueuedMessages, maxBytes: maxQueuedBytes, writeTimeoutMs: writeTimeout, onFailure: error => retire({ reason: 'write_failure', errorCode: safeErrorCode(error) }),
    });
    const host = createRemoteHostPluginHost(options.relay, {
      resolveSession: options.resolveSession,
      acquireSession: options.acquireSession,
      imageScope: () => { if (!operationScope) throw new Error('Image scope is unavailable before Host registration.'); return operationScope; },
      control: request => options.control({ ...request, ...(operationScope ? { operationScope } : {}) }),
      ...(options.operationExecutor ? { executeOperation: (agent, operation, work) => {
        if (!operationScope) throw new Error('Remote Host operation scope is unavailable before registration.');
        return options.operationExecutor!(operationScope)(agent, operation, work);
      } } : {}),
      send: (json) => writer.send(json), onFailure: () => retire({ reason: 'host_failure' }),
    });
    function retire(cause: DisconnectCause): void {
      if (retired) return;
      retired = true;
      unsubscribePreviews?.();
      if (registered) options.previews?.disconnected();
      retirement = { ...details(), ...cause };
      clearTimeout(registrationDeadline);
      clearTimeout(heartbeatDeadline);
      host.close();
      writer.close();
      socket.terminate();
    }
    retireConnection = () => retire({ reason: 'client_closed' });
    connectionClosed = new Promise<void>((resolve) => {
      socket.once('close', (code, reason) => {
        if (code === 1008) {
          terminal = true;
          options.onStateChange?.('rejected');
          if (!registered) rejectReady(new Error('Remote Host uplink authorization was rejected.'));
        } else if (!closed && !terminal) options.onStateChange?.('disconnected');
        retire({ reason: 'socket_closed' });
        const peerReason = safePeerReason(reason.toString());
        const disconnected = { ...retirement!, closeCode: code, ...(peerReason ? { peerReason } : {}) };
        if (retirement!.reason !== 'client_closed') diagnose({ ...disconnected, event: 'disconnected' });
        resolve();
        scheduleReconnect(disconnected);
      });
    });
    socket.on('error', error => retire({ reason: error.message === 'Opening handshake has timed out' ? 'registration_timeout' : 'socket_error', errorCode: safeErrorCode(error) }));
    function resetCloudDeadline(): void {
      clearTimeout(heartbeatDeadline);
      heartbeatDeadline = setTimeout(() => retire({ reason: 'heartbeat_timeout' }), cloudHeartbeat!.intervalMs + cloudHeartbeat!.timeoutMs);
    }
    socket.on('unexpected-response', (_request, response) => {
      if (response.statusCode === 401 || response.statusCode === 403) {
        terminal = true;
        options.onStateChange?.('rejected');
        if (!registered) rejectReady(new Error('Remote Host uplink authorization was rejected.'));
      }
      retire({ reason: 'http_rejected', httpStatus: response.statusCode });
    });
    socket.once('open', () => {
      if (closed || terminal || retired) { retire({ reason: closed ? 'client_closed' : 'protocol_error' }); return; }
      registrationDeadline = setTimeout(() => retire({ reason: 'registration_timeout' }), registrationTimeout);
      writer.send(JSON.stringify({
        uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'register', installationId: options.installationId,
        ...(options.onCredential ? { credentialRotation: true } : {}),
        ...(options.environment ? { environment: options.environment } : {}),
        ...(options.controller ? { controller: options.controller } : {}),
        name: options.name, ...(options.providers === undefined ? { providerId: 'dsh' } : { providers: options.providers }),
      }));
    });
    socket.on('message', (data, isBinary) => {
      if (closed || retired) return;
      if (isBinary) { retire({ reason: 'protocol_error' }); return; }
      const decoded = decodeRemoteHostUplinkMessage(data.toString());
      if (decoded.status !== 'ok') { retire({ reason: 'protocol_error' }); return; }
      if (decoded.value.type === 'credential_issued') {
        if (!options.onCredential || credentialWrite) { retire({ reason: 'protocol_error' }); return; }
        const credential = decoded.value.credential;
        credentialWrite = Promise.resolve().then(() => options.onCredential!(credential)).then(() => {
          // The saved key is authoritative even when this connection disappeared during fsync.
          remoteKey = credential;
          if (!closed && !retired) writer.send(JSON.stringify({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'credential_saved' }));
        }).catch(() => {
          terminal = true;
          clearTimeout(retry);
          if (!closed && retired) diagnose({ ...details(), event: 'reconnect_stopped', reason: 'credential_persistence_failed' });
          if (!closed) options.onStateChange?.('rejected');
          rejectReady(new Error('Remote Host could not durably save its device credential. Pair again after fixing local storage.'));
          retire({ reason: 'credential_persistence_failed' });
        }).finally(() => { credentialWrite = undefined; });
        return;
      }
      if (registered && decoded.value.type === 'registered') {
        if (decoded.value.hostId !== registeredHostId
          || decoded.value.heartbeat?.intervalMs !== cloudHeartbeat?.intervalMs
          || decoded.value.heartbeat?.timeoutMs !== cloudHeartbeat?.timeoutMs) retire({ reason: 'protocol_error' });
        return;
      }
      if (!registered) {
        if (credentialWrite) { retire({ reason: 'protocol_error' }); return; }
        if (decoded.value.type !== 'registered') { retire({ reason: 'protocol_error' }); return; }
        clearTimeout(registrationDeadline);
        registered = true;
        registeredHostId = decoded.value.hostId;
        operationScope = JSON.stringify([new URL(options.url).origin, registeredHostId, options.installationId]);
        cloudHeartbeat = decoded.value.heartbeat;
        resetCloudDeadline();
        options.onStateChange?.('registered');
        diagnose({ ...details(), event: 'registered' });
        attempts = 0;
        resolveReady({ hostId: decoded.value.hostId, ...(decoded.value.pairingPurpose ? { pairingPurpose: decoded.value.pairingPurpose } : {}) });
        if (options.previews && decoded.value.tunnelToken) {
          const publish = (snapshot: PreviewRegistrationSnapshot) => {
            if (!retired) writer.send(JSON.stringify({ uplinkVersion: 2, type: 'preview_snapshot', snapshot }));
          };
          unsubscribePreviews = options.previews.subscribe(publish);
          options.previews.registered({ hostId: decoded.value.hostId, tunnelToken: decoded.value.tunnelToken });
        }
        return;
      }
      if (decoded.value.type === 'heartbeat') {
        if (!cloudHeartbeat) { retire({ reason: 'protocol_error' }); return; }
        lastHeartbeatAt = performance.now();
        resetCloudDeadline();
        writer.send(JSON.stringify({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'heartbeat_ack', nonce: decoded.value.nonce }));
        return;
      }
      host.receive(data.toString());
    });
  }

  connect();
  return {
    ready,
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closed = true;
      diagnose({ ...describeConnection(), event: 'closed', reason: 'client_closed' });
      options.onStateChange?.('closed');
      clearTimeout(retry);
      rejectReady(new Error('Remote Host uplink closed before registration.'));
      retireConnection?.();
      closePromise = Promise.all([connectionClosed, credentialWrite]).then(() => undefined);
      return closePromise;
    },
  };
}

function validateConfiguration(options: RemoteHostUplinkClientOptions): void {
  const url = new URL(options.url);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || url.pathname !== '/ws/remote-host') {
    throw new Error('Remote Host uplink requires a WebSocket /ws/remote-host URL.');
  }
  for (const [name, value] of [['installation identity', options.installationId], ['instance name', options.name]] as const) {
    if (!value.trim() || value.length > 512) throw new Error(`Remote Host uplink requires a valid ${name}.`);
  }
  if (!options.remoteKey || options.remoteKey.length > 512 || !/^[!-~]+$/.test(options.remoteKey)) {
    throw new Error('Remote Host uplink requires a valid Remote Access Key.');
  }
  if (options.providers !== undefined) {
    if (options.providers.length > 64) throw new Error('Remote Host uplink supports at most 64 providers.');
    const ids = new Set<string>();
    for (const provider of options.providers) {
      for (const [name, value] of [['provider identity', provider.providerId], ['provider display name', provider.displayName]] as const) {
        if (!value.trim() || value.length > 512) throw new Error(`Remote Host uplink requires a valid ${name}.`);
      }
      if (ids.has(provider.providerId)) throw new Error('Remote Host uplink provider identities must be unique.');
      ids.add(provider.providerId);
    }
  }
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Remote Host uplink limits and deadlines must be positive integers.');
  return value;
}

const diagnosticErrorCodes = new Set([
  'EAI_AGAIN', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTDOWN', 'EHOSTUNREACH', 'ENETDOWN', 'ENETUNREACH',
  'ENOTFOUND', 'EPIPE', 'ETIMEDOUT', 'EADDRNOTAVAIL', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_SSL_WRONG_VERSION_NUMBER',
  'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH', 'WS_ERR_INVALID_CLOSE_CODE', 'WS_ERR_INVALID_UTF8',
]);
function safeErrorCode(error: unknown): string | undefined {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && diagnosticErrorCodes.has(code) ? code : undefined;
}

function safePeerReason(reason: string): RemoteHostUplinkDiagnostic['peerReason'] {
  switch (reason) {
    case 'Host heartbeat timed out': return 'heartbeat_timeout';
    case 'Host heartbeat delivery failed': return 'heartbeat_delivery_failed';
    case 'Host connection replaced': return 'connection_replaced';
    case 'Broker closed': return 'broker_closed';
    default: return undefined;
  }
}

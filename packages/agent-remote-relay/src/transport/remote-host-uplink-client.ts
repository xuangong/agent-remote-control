import { WebSocket } from 'ws';

import {
  decodeRemoteHostUplinkMessage, REMOTE_HOST_UPLINK_VERSION, UPLINK_MAX_FRAME_BYTES,
} from '@borgee/agent-remote-protocol';

import type { AgentRemoteRelay } from '../relay.js';
import { createRemoteHostPluginHost, type RemoteHostPluginHostOptions } from './remote-host-plugin.js';
import { createUplinkWriter } from './uplink-writer.js';

export interface RemoteHostUplinkClientOptions {
  readonly relay: AgentRemoteRelay;
  readonly installationId: string;
  readonly name: string;
  readonly providers?: readonly { providerId: string; displayName: string }[];
  readonly remoteKey: string;
  /** Must durably persist the offered credential before resolving. */
  readonly onCredential?: (credential: string) => Promise<void>;
  readonly url: string;
  readonly resolveSession: RemoteHostPluginHostOptions['resolveSession'];
  readonly control: RemoteHostPluginHostOptions['control'];
  readonly registrationTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  readonly maxQueuedMessages?: number;
  readonly maxQueuedBytes?: number;
  readonly reconnectBaseDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  readonly onStateChange?: (state: 'connecting' | 'registered' | 'disconnected' | 'rejected' | 'closed') => void;
}

export interface RemoteHostUplinkClient {
  readonly ready: Promise<{ hostId: string }>;
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
  let resolveReady!: (value: { hostId: string }) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<{ hostId: string }>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
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

  function scheduleReconnect(): void {
    if (closed || terminal) return;
    const upper = Math.min(reconnectMaxDelay, reconnectBaseDelay * 2 ** Math.min(attempts, 20));
    attempts += 1;
    retry = setTimeout(connect, Math.floor(upper * (0.5 + Math.random() * 0.5)));
  }

  function connect(): void {
    if (closed || terminal) return;
    if (credentialWrite) { void credentialWrite.then(connect); return; }
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
    const writer = createUplinkWriter(socket, {
      maxMessages: maxQueuedMessages, maxBytes: maxQueuedBytes, writeTimeoutMs: writeTimeout, onFailure: () => retire(),
    });
    const host = createRemoteHostPluginHost(options.relay, {
      resolveSession: options.resolveSession, control: options.control, send: (json) => writer.send(json), onFailure: () => retire(),
    });
    function retire(): void {
      if (retired) return;
      retired = true;
      clearTimeout(registrationDeadline);
      host.close();
      writer.close();
      socket.terminate();
    }
    retireConnection = retire;
    connectionClosed = new Promise<void>((resolve) => {
      socket.once('close', (code) => {
        if (code === 1008) {
          terminal = true;
          options.onStateChange?.('rejected');
          if (!registered) rejectReady(new Error('Remote Host uplink authorization was rejected.'));
        } else if (!closed && !terminal) options.onStateChange?.('disconnected');
        retire();
        resolve();
        scheduleReconnect();
      });
    });
    socket.on('error', () => retire());
    socket.on('unexpected-response', (_request, response) => {
      if (response.statusCode === 401 || response.statusCode === 403) {
        terminal = true;
        options.onStateChange?.('rejected');
        if (!registered) rejectReady(new Error('Remote Host uplink authorization was rejected.'));
      }
      retire();
    });
    socket.once('open', () => {
      if (closed || terminal || retired) { retire(); return; }
      registrationDeadline = setTimeout(retire, registrationTimeout);
      writer.send(JSON.stringify({
        uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'register', installationId: options.installationId,
        ...(options.onCredential ? { credentialRotation: true } : {}),
        name: options.name, ...(options.providers === undefined ? { providerId: 'dsh' } : { providers: options.providers }),
      }));
    });
    socket.on('message', (data, isBinary) => {
      if (closed || retired) return;
      if (isBinary) { retire(); return; }
      const decoded = decodeRemoteHostUplinkMessage(data.toString());
      if (decoded.status !== 'ok') { retire(); return; }
      if (decoded.value.type === 'credential_issued') {
        if (!options.onCredential || credentialWrite) { retire(); return; }
        const credential = decoded.value.credential;
        credentialWrite = Promise.resolve().then(() => options.onCredential!(credential)).then(() => {
          // The saved key is authoritative even when this connection disappeared during fsync.
          remoteKey = credential;
          if (!closed && !retired) writer.send(JSON.stringify({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'credential_saved' }));
        }).catch(() => {
          terminal = true;
          if (!closed) options.onStateChange?.('rejected');
          rejectReady(new Error('Remote Host could not durably save its device credential. Pair again after fixing local storage.'));
          retire();
        }).finally(() => { credentialWrite = undefined; });
        return;
      }
      if (registered && decoded.value.type === 'registered') {
        if (decoded.value.hostId !== registeredHostId) retire();
        return;
      }
      if (!registered) {
        if (credentialWrite) { retire(); return; }
        if (decoded.value.type !== 'registered') { retire(); return; }
        clearTimeout(registrationDeadline);
        registered = true;
        registeredHostId = decoded.value.hostId;
        options.onStateChange?.('registered');
        attempts = 0;
        resolveReady({ hostId: decoded.value.hostId });
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
    if (options.providers.length < 1 || options.providers.length > 64) throw new Error('Remote Host uplink requires between 1 and 64 providers.');
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

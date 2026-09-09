import { WebSocket } from 'ws';
import { decodeUplinkMessage, UPLINK_MAX_FRAME_BYTES, UPLINK_VERSION } from '@borgee/agent-remote-protocol';
import type { AgentRemoteRelay } from '../relay.js';
import { createAgentRemotePluginHost, type AgentRemotePluginHostOptions } from './plugin-host.js';
import { createUplinkWriter } from './uplink-writer.js';

export interface AgentRemoteUplinkClientOptions {
  relay: AgentRemoteRelay;
  agentId: string;
  url: string;
  apiKey: string;
  reconnectDelayMs?: number;
  registrationTimeoutMs?: number;
  writeTimeoutMs?: number;
  maxQueuedMessages?: number;
  maxQueuedBytes?: number;
  requestPolicy?: AgentRemotePluginHostOptions['requestPolicy'];
}

export interface AgentRemoteUplinkClient {
  readonly ready: Promise<void>;
  close(): Promise<void>;
}

export function createAgentRemoteUplinkClient(options: AgentRemoteUplinkClientOptions): AgentRemoteUplinkClient {
  validateConfiguration(options);
  const registrationTimeout = options.registrationTimeoutMs ?? 5000;
  const reconnectDelay = options.reconnectDelayMs ?? 1000;
  const writeTimeout = options.writeTimeoutMs ?? 10000;
  const maxQueuedMessages = options.maxQueuedMessages ?? 256;
  const maxQueuedBytes = options.maxQueuedBytes ?? 64 * 1024 * 1024;
  for (const value of [registrationTimeout, reconnectDelay, writeTimeout, maxQueuedMessages, maxQueuedBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Uplink limits and deadlines must be positive integers.');
  }
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => undefined);
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retireConnection: (() => void) | undefined;
  let connectionClosed: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | undefined;

  function connect(): void {
    if (closed) return;
    const socket = new WebSocket(options.url, {
      headers: { authorization: `Bearer ${options.apiKey}` },
      maxPayload: UPLINK_MAX_FRAME_BYTES,
      handshakeTimeout: registrationTimeout,
      perMessageDeflate: false,
      followRedirects: false,
    });
    let registered = false, retired = false;
    let registrationDeadline: ReturnType<typeof setTimeout> | undefined;
    const writer = createUplinkWriter(socket, {
      maxMessages: maxQueuedMessages, maxBytes: maxQueuedBytes, writeTimeoutMs: writeTimeout,
      onFailure: () => retire(),
    });
    const host = createAgentRemotePluginHost(options.relay, {
      agentId: options.agentId, send: (json) => writer.send(json), onFailure: () => retire(),
      requestPolicy: options.requestPolicy,
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
      socket.once('close', () => {
        retire();
        resolve();
        if (!closed) retry = setTimeout(connect, reconnectDelay);
      });
    });
    socket.on('error', () => retire());
    socket.once('open', () => {
      if (closed || retired) { retire(); return; }
      registrationDeadline = setTimeout(retire, registrationTimeout);
      writer.send(JSON.stringify({ uplinkVersion: UPLINK_VERSION, type: 'register', agentId: options.agentId }));
    });
    socket.on('message', (data, isBinary) => {
      if (closed || retired) return;
      if (isBinary) { retire(); return; }
      const json = data.toString();
      if (!registered) {
        const decoded = decodeUplinkMessage(json);
        if (decoded.status !== 'ok' || decoded.value.type !== 'registered' || decoded.value.agentId !== options.agentId) {
          retire();
          return;
        }
        clearTimeout(registrationDeadline);
        registered = true;
        resolveReady();
        return;
      }
      host.receive(json);
    });
  }

  connect();
  return {
    ready,
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closed = true;
      clearTimeout(retry);
      rejectReady(new Error('Agent Remote uplink closed before registration.'));
      retireConnection?.();
      closePromise = connectionClosed;
      return closePromise;
    },
  };
}

function validateConfiguration(options: AgentRemoteUplinkClientOptions): void {
  const url = new URL(options.url);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.search
    || url.pathname !== '/ws/agent-remote') throw new Error('Agent Remote uplink requires a WebSocket /ws/agent-remote URL.');
  if (!options.agentId || options.agentId.length > 512) throw new Error('Agent Remote uplink requires an Agent identity.');
  if (!options.apiKey || !/^[!-~]+$/.test(options.apiKey)) throw new Error('Agent Remote uplink requires an API key without whitespace.');
}

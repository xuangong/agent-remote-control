import {
  decodeRemoteHostUplinkMessage, encodeRemoteHostUplinkMessage,
  REMOTE_HOST_UPLINK_VERSION, UPLINK_MAX_FRAME_BYTES, UPLINK_MAX_PUBLIC_REQUEST_BYTES,
  type RemoteHostUplinkMessage,
} from '@agent-remote-controller/agent-remote-protocol';

import type { AgentRemoteRelay } from '../relay.js';
import { createSessionWire, type SessionWire, type SessionWireAgent, type SessionWireOperationExecutor } from '../session-wire.js';
import { agentRemoteHttpError, agentRemoteHttpFailure, executeAgentRemoteHttpRequest, type AgentRemoteHttpResult } from './http-executor.js';

export interface RemoteHostControlRequest {
  readonly requestId?: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly sessionId?: string;
  readonly body?: string;
  readonly operationScope?: string;
}

export interface RemoteHostPluginHost {
  receive(json: string): void;
  close(): void;
}

export interface RemoteHostPluginHostOptions {
  resolveSession(sessionId: string): SessionWireAgent | undefined;
  control(request: RemoteHostControlRequest): Promise<AgentRemoteHttpResult> | AgentRemoteHttpResult;
  send(json: string): void;
  onFailure(error: Error): void;
  executeOperation?: SessionWireOperationExecutor;
  maxPendingRpcs?: number;
  maxStreams?: number;
  maxPendingPerStream?: number;
  maxPendingStreamBytes?: number;
}

interface VirtualStream {
  readonly wire: SessionWire;
  receiving: Promise<void>;
  pending: number;
  bytes: number;
}

export function createRemoteHostPluginHost(
  relay: AgentRemoteRelay,
  options: RemoteHostPluginHostOptions,
): RemoteHostPluginHost {
  const maxRpcs = positiveLimit(options.maxPendingRpcs ?? 128);
  const maxStreams = positiveLimit(options.maxStreams ?? 64);
  const maxReceives = positiveLimit(options.maxPendingPerStream ?? 64);
  const maxReceiveBytes = positiveLimit(options.maxPendingStreamBytes ?? 4 * 1024 * 1024);
  const streams = new Map<string, VirtualStream>();
  const pending = new Map<string, { cancelled: boolean }>();
  let closed = false;

  function close(): void {
    if (closed) return;
    closed = true;
    for (const stream of streams.values()) stream.wire.close();
    streams.clear();
    for (const request of pending.values()) request.cancelled = true;
    pending.clear();
  }

  function fail(error: Error): void {
    if (closed) return;
    close();
    options.onFailure(error);
  }

  function emit(message: RemoteHostUplinkMessage): void {
    if (closed) return;
    try {
      const encoded = encodeRemoteHostUplinkMessage(message);
      if (encoded.status !== 'ok' || Buffer.byteLength(encoded.json) > UPLINK_MAX_FRAME_BYTES) {
        throw new Error('Remote Host uplink response exceeds its transport contract.');
      }
      options.send(encoded.json);
    } catch (error) {
      fail(error instanceof Error ? error : new Error('Remote Host uplink delivery failed.'));
    }
  }

  function closeStream(streamId: string, code: number, reason: string, notify = true): void {
    streams.get(streamId)?.wire.close();
    streams.delete(streamId);
    if (notify) emit({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'stream_close', streamId, code, reason });
  }

  function openStream(streamId: string, sessionId: string): void {
    if (streams.has(streamId)) { fail(new Error('Duplicate Remote Host stream identity.')); return; }
    if (streams.size >= maxStreams) { closeStream(streamId, 1013, 'Remote Host stream capacity exceeded.'); return; }
    const agent = options.resolveSession(sessionId);
    if (!agent) { closeStream(streamId, 1008, 'Remote Session is unavailable.'); return; }
    let stream: VirtualStream;
    const wire = createSessionWire(agent, (message) => {
      if (streams.get(streamId) === stream) {
        emit({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'stream_message', streamId, message });
      }
    }, {
      authorize: () => true,
      ...(options.executeOperation ? { executeOperation: options.executeOperation } : {}),
      onFailure: () => closeStream(streamId, 1011, 'Remote Session delivery failed.'),
    });
    stream = { wire, receiving: Promise.resolve(), pending: 0, bytes: 0 };
    streams.set(streamId, stream);
    emit({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'stream_opened', streamId });
  }

  function receiveStream(streamId: string, message: string): void {
    const stream = streams.get(streamId);
    if (!stream) return;
    const bytes = Buffer.byteLength(message);
    if (bytes > UPLINK_MAX_PUBLIC_REQUEST_BYTES) { closeStream(streamId, 1009, 'Public message is too large.'); return; }
    if (stream.pending >= maxReceives || stream.bytes + bytes > maxReceiveBytes) {
      closeStream(streamId, 1013, 'Remote Session input capacity exceeded.');
      return;
    }
    stream.pending += 1;
    stream.bytes += bytes;
    stream.receiving = stream.receiving.then(async () => {
      if (!closed && streams.get(streamId) === stream) await stream.wire.receive(message);
    }).catch(() => closeStream(streamId, 1011, 'Remote Session failed.')).finally(() => {
      stream.pending -= 1;
      stream.bytes -= bytes;
    });
  }

  async function dispatch(request: Extract<RemoteHostUplinkMessage, { type: 'rpc_request' }>): Promise<AgentRemoteHttpResult> {
    if (request.path.startsWith('/remote/')) {
      return options.control({ requestId: request.requestId, method: request.method, path: request.path,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        ...(request.body === undefined ? {} : { body: request.body }) });
    }
    const url = new URL(request.path, 'http://remote-host.local');
    const providerList = url.pathname === '/v1/providers';
    const match = /^\/v1\/sessions\/([^/]+)\/(snapshot|timeline)$/.exec(url.pathname);
    if (providerList) {
      if (request.method !== 'GET' || request.sessionId === undefined) {
        return agentRemoteHttpError(404, 'route_not_found', 'Remote Host route was not found.', true);
      }
      if (!options.resolveSession(request.sessionId)) {
        return agentRemoteHttpError(403, 'forbidden', 'Remote Session target is unavailable.', false);
      }
      return executeAgentRemoteHttpRequest(relay, request);
    }
    if (!match || request.method !== 'GET' || request.sessionId === undefined) {
      return agentRemoteHttpError(404, 'route_not_found', 'Remote Host route was not found.', true);
    }
    let pathSessionId: string;
    try { pathSessionId = decodeURIComponent(match[1]!); } catch {
      return agentRemoteHttpError(400, 'invalid_request', 'Remote Session path is invalid.', true);
    }
    if (pathSessionId !== request.sessionId || !options.resolveSession(request.sessionId)) {
      return agentRemoteHttpError(403, 'forbidden', 'Remote Session target is unavailable.', false);
    }
    return executeAgentRemoteHttpRequest(relay, request);
  }

  function receiveRpc(message: Extract<RemoteHostUplinkMessage, { type: 'rpc_request' }>): void {
    if (pending.has(message.requestId)) { fail(new Error('Duplicate Remote Host RPC identity.')); return; }
    if (pending.size >= maxRpcs) { fail(new Error('Remote Host RPC capacity exceeded.')); return; }
    const token = { cancelled: false };
    pending.set(message.requestId, token);
    void dispatch(message).catch(agentRemoteHttpFailure).then((result) => {
      if (!token.cancelled && !closed) {
        emit({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'rpc_response', requestId: message.requestId, ...result });
      }
    }).finally(() => {
      if (pending.get(message.requestId) === token) pending.delete(message.requestId);
    });
  }

  return {
    receive(json: string): void {
      if (closed) return;
      if (Buffer.byteLength(json) > UPLINK_MAX_FRAME_BYTES) { fail(new Error('Remote Host uplink frame is too large.')); return; }
      const decoded = decodeRemoteHostUplinkMessage(json);
      if (decoded.status !== 'ok') { fail(new Error('Invalid Remote Host uplink envelope.')); return; }
      const message = decoded.value;
      switch (message.type) {
        case 'rpc_request': receiveRpc(message); return;
        case 'rpc_cancel': { const request = pending.get(message.requestId); if (request) request.cancelled = true; return; }
        case 'stream_open': openStream(message.streamId, message.sessionId); return;
        case 'stream_message': receiveStream(message.streamId, message.message); return;
        case 'stream_close': closeStream(message.streamId, message.code, message.reason, false); return;
        default: fail(new Error('Unexpected Remote Host broker message.'));
      }
    },
    close,
  };
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Remote Host transport limits must be positive integers.');
  return value;
}

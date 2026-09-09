import {
  decodeCreateAgentRequest, decodeUplinkMessage, encodeUplinkMessage,
  UPLINK_MAX_FRAME_BYTES, UPLINK_MAX_PUBLIC_REQUEST_BYTES, UPLINK_VERSION,
  type UplinkMessage,
} from '@borgee/agent-remote-protocol';
import type { AgentRemoteRelay } from '../relay.js';
import { createSessionWire, type SessionWire } from '../session-wire.js';
import {
  agentRemoteHttpError, executeAgentRemoteHttpRequest,
  type AgentRemoteHttpRequest, type AgentRemoteHttpResult,
} from './http-executor.js';

export interface AgentRemotePluginHost {
  receive(json: string): void;
  close(): void;
}

export interface AgentRemotePluginHostOptions {
  agentId: string;
  send(json: string): void;
  onFailure(error: Error): void;
  requestPolicy?: (request: AgentRemoteHttpRequest) => AgentRemoteHttpResult | undefined;
  maxPendingRpcs?: number;
  maxStreams?: number;
  maxPendingPerStream?: number;
  maxPendingStreamBytes?: number;
}

interface VirtualStream {
  wire: SessionWire;
  receiving: Promise<void>;
  pending: number;
  bytes: number;
}

export function createAgentRemotePluginHost(
  relay: AgentRemoteRelay,
  options: AgentRemotePluginHostOptions,
): AgentRemotePluginHost {
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

  function emit(message: UplinkMessage): void {
    if (closed) return;
    try {
      const encoded = encodeUplinkMessage(message);
      if (encoded.status !== 'ok' || Buffer.byteLength(encoded.json) > UPLINK_MAX_FRAME_BYTES) {
        throw new Error('Plugin uplink response exceeds its transport contract.');
      }
      options.send(encoded.json);
    } catch (error) {
      fail(error instanceof Error ? error : new Error('Plugin uplink delivery failed.'));
    }
  }

  function closeStream(streamId: string, code: number, reason: string, notify = true): void {
    streams.get(streamId)?.wire.close();
    streams.delete(streamId);
    if (notify) emit({ uplinkVersion: UPLINK_VERSION, type: 'stream_close', streamId, code, reason });
  }

  function openStream(streamId: string): void {
    if (streams.has(streamId)) { fail(new Error('Duplicate plugin stream identity.')); return; }
    if (streams.size >= maxStreams) { closeStream(streamId, 1013, 'Plugin stream capacity exceeded.'); return; }
    try { relay.requireAgent(options.agentId); } catch {
      closeStream(streamId, 1008, 'Agent was not found.');
      return;
    }
    let stream: VirtualStream;
    const wire = createSessionWire(() => relay.requireAgent(options.agentId), (message) => {
      if (streams.get(streamId) === stream) emit({ uplinkVersion: UPLINK_VERSION, type: 'stream_message', streamId, message });
    }, {
      authorize: () => true,
      onFailure: () => closeStream(streamId, 1011, 'Plugin session delivery failed.'),
    });
    stream = { wire, receiving: Promise.resolve(), pending: 0, bytes: 0 };
    streams.set(streamId, stream);
    emit({ uplinkVersion: UPLINK_VERSION, type: 'stream_opened', streamId });
  }

  function receiveStream(streamId: string, message: string): void {
    const stream = streams.get(streamId);
    if (!stream) return;
    const bytes = Buffer.byteLength(message);
    if (bytes > UPLINK_MAX_PUBLIC_REQUEST_BYTES) { closeStream(streamId, 1009, 'Public message is too large.'); return; }
    if (stream.pending >= maxReceives || stream.bytes + bytes > maxReceiveBytes) {
      closeStream(streamId, 1013, 'Plugin stream input capacity exceeded.');
      return;
    }
    stream.pending += 1;
    stream.bytes += bytes;
    stream.receiving = stream.receiving.then(async () => {
      if (!closed && streams.get(streamId) === stream) await stream.wire.receive(message);
    }).catch(() => closeStream(streamId, 1011, 'Plugin session failed.')).finally(() => {
      stream.pending -= 1;
      stream.bytes -= bytes;
    });
  }

  function receiveRpc(message: Extract<UplinkMessage, { type: 'rpc_request' }>): void {
    const { requestId } = message;
    if (pending.has(requestId)) { fail(new Error('Duplicate plugin RPC identity.')); return; }
    if (pending.size >= maxRpcs) { fail(new Error('Plugin RPC capacity exceeded.')); return; }
    const token = { cancelled: false };
    pending.set(requestId, token);
    void (async () => {
      const result = boundRequestPolicy(options.agentId, message)
        ?? options.requestPolicy?.(message)
        ?? await executeAgentRemoteHttpRequest(relay, message);
      if (!token.cancelled && !closed) emit({ uplinkVersion: UPLINK_VERSION, type: 'rpc_response', requestId, ...result });
    })().catch(() => fail(new Error('Plugin RPC dispatch failed.'))).finally(() => {
      if (pending.get(requestId) === token) pending.delete(requestId);
    });
  }

  return {
    receive(json: string): void {
      if (closed) return;
      if (Buffer.byteLength(json) > UPLINK_MAX_FRAME_BYTES) { fail(new Error('Plugin uplink frame is too large.')); return; }
      const decoded = decodeUplinkMessage(json);
      if (decoded.status !== 'ok') { fail(new Error('Invalid plugin uplink envelope.')); return; }
      const message = decoded.value;
      switch (message.type) {
        case 'rpc_request': receiveRpc(message); return;
        case 'rpc_cancel': { const request = pending.get(message.requestId); if (request) request.cancelled = true; return; }
        case 'stream_open': openStream(message.streamId); return;
        case 'stream_message': receiveStream(message.streamId, message.message); return;
        case 'stream_close': closeStream(message.streamId, message.code, message.reason, false); return;
        default: fail(new Error('Unexpected broker uplink message.'));
      }
    },
    close,
  };
}

function boundRequestPolicy(agentId: string, request: AgentRemoteHttpRequest): AgentRemoteHttpResult | undefined {
  const reject = (code: string, message: string) => agentRemoteHttpError(403, code, message, false);
  if (Buffer.byteLength(request.body ?? '') > UPLINK_MAX_PUBLIC_REQUEST_BYTES) {
    return agentRemoteHttpError(400, 'request_body_too_large', 'Relay request body exceeds one megabyte.', true);
  }
  const pathname = request.path.split('?')[0];
  if (pathname === '/v1/providers') return undefined;
  if (pathname === '/v1/sessions/resume') return reject('resume_unavailable', 'Session import is unavailable.');
  if (pathname === '/v1/sessions' && request.method === 'POST') {
    const decoded = decodeCreateAgentRequest(request.body ?? '');
    if (decoded.status === 'ok' && decoded.value.payload.agentId !== agentId) {
      return reject('agent_identity_mismatch', 'Request identifies a different Agent.');
    }
    return undefined;
  }
  const match = /^\/v1\/sessions\/([^/]+)\/(snapshot|timeline)$/.exec(pathname ?? '');
  if (match) {
    try {
      if (decodeURIComponent(match[1]!) === agentId) return undefined;
    } catch { return agentRemoteHttpError(400, 'invalid_path', 'Invalid Agent request path.', true); }
    return reject('agent_identity_mismatch', 'Request identifies a different Agent.');
  }
  return agentRemoteHttpError(404, 'route_not_found', 'Relay route was not found.', true);
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Plugin transport limits must be positive integers.');
  return value;
}

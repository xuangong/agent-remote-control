import { decodeTunnelFrame, encodeTunnelFrame, type TunnelFrame } from './codec.js';
import { TunnelError } from './errors.js';
import type { TunnelHttpRequest, TunnelHttpResponse, TunnelPeer, TunnelPeerHandlers, TunnelPeerOptions, TunnelSocket, TunnelWebSocketAcceptance, TunnelWebSocketEndpoint, TunnelWebSocketRequest } from './types.js';

type HttpState = {
  kind: 'http'; previewId: string; controller: AbortController; response?: (value: TunnelHttpResponse) => void; reject?: (error: Error) => void;
  requestReceiver?: BodyReceiver; responseReceiver?: BodyReceiver; requestCredit: CreditWindow; responseCredit: CreditWindow;
  timer?: ReturnType<typeof setTimeout>;
};
type WsState = {
  kind: 'ws'; previewId: string; controller: AbortController; resolve?: (value: TunnelWebSocketAcceptance) => void; reject?: (error: Error) => void;
  endpoint: LocalWebSocket; remote?: TunnelWebSocketEndpoint; credit: CreditWindow; timer?: ReturnType<typeof setTimeout>;
};
type StreamState = HttpState | WsState;

const DEFAULTS = { maxStreams: 64, maxFrameBytes: 256 * 1024, maxQueuedBytes: 1024 * 1024, initialCreditBytes: 64 * 1024, openTimeoutMs: 15_000, heartbeatIntervalMs: 15_000, heartbeatTimeoutMs: 45_000 };

class CreditWindow {
  private available = 0;
  private readonly waiters: Array<() => void> = [];
  private closed = false;
  grant(bytes: number) { this.available += bytes; while (this.available > 0 && this.waiters.length > 0) this.waiters.shift()?.(); }
  async take(bytes: number) {
    while (this.available < bytes && !this.closed) await new Promise<void>(resolve => this.waiters.push(resolve));
    if (this.closed) throw new TunnelError('cancelled', 'Tunnel stream ended.');
    this.available -= bytes;
  }
  close() { this.closed = true; while (this.waiters.length) this.waiters.shift()?.(); }
}

class BodyReceiver {
  readonly stream: ReadableStream<Uint8Array>;
  private readonly queue: Uint8Array[] = [];
  private waiting?: ReadableStreamDefaultController<Uint8Array>;
  private ended = false;
  private queuedBytes = 0;
  constructor(private readonly maxBytes: number, private readonly consumed: (bytes: number) => void, cancelled: () => void) {
    this.stream = new ReadableStream<Uint8Array>({
      pull: controller => {
        const chunk = this.queue.shift();
        if (chunk) { this.queuedBytes -= chunk.byteLength; controller.enqueue(chunk); this.consumed(chunk.byteLength); }
        else if (this.ended) controller.close();
        else this.waiting = controller;
      },
      cancel: cancelled,
    }, { highWaterMark: 0 });
  }
  push(chunk: Uint8Array) {
    if (this.ended) throw new TunnelError('state', 'Body chunk arrived after end.');
    if (this.waiting) { const controller = this.waiting; this.waiting = undefined; controller.enqueue(chunk); this.consumed(chunk.byteLength); return; }
    if (this.queuedBytes + chunk.byteLength > this.maxBytes) throw new TunnelError('backpressure', 'Tunnel inbound body queue is full.');
    this.queue.push(chunk); this.queuedBytes += chunk.byteLength;
  }
  close() { this.ended = true; if (this.waiting) { this.waiting.close(); this.waiting = undefined; } }
  error(error: Error) { this.ended = true; this.queue.length = 0; this.waiting?.error(error); this.waiting = undefined; }
}

class LocalWebSocket implements TunnelWebSocketEndpoint {
  private readonly messageListeners = new Set<(data: string | Uint8Array, binary: boolean) => void | Promise<void>>();
  private readonly closeListeners = new Set<(code: number, reason: string) => void>();
  private readonly pending: Array<{ data: string | Uint8Array; binary: boolean }> = [];
  private pendingBytes = 0;
  private sendingBytes = 0;
  constructor(private readonly transmit: (data: string | Uint8Array, binary: boolean) => void | Promise<void>, private readonly terminate: (code: number, reason: string) => void,
    private readonly maxPendingBytes: number, private readonly maxMessageBytes: number) {}
  send(data: string | Uint8Array, binary = data instanceof Uint8Array) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
    if (bytes > this.maxMessageBytes) { this.terminate(1009, 'WebSocket message is too large'); return; }
    if (this.sendingBytes + bytes > this.maxPendingBytes) { this.terminate(1013, 'WebSocket sender is too fast'); return; }
    this.sendingBytes += bytes;
    return Promise.resolve(this.transmit(data, binary)).then(() => { this.sendingBytes -= bytes; }, () => { this.sendingBytes -= bytes; this.terminate(1011, 'WebSocket send failed'); });
  }
  onMessage(listener: (data: string | Uint8Array, binary: boolean) => void | Promise<void>) {
    this.messageListeners.add(listener);
    for (const message of this.pending.splice(0)) listener(message.data, message.binary);
    this.pendingBytes = 0;
    return () => this.messageListeners.delete(listener);
  }
  close(code = 1000, reason = '') { this.terminate(normalizeCloseCode(code), reason.slice(0, 123)); }
  onClose(listener: (code: number, reason: string) => void) { this.closeListeners.add(listener); return () => this.closeListeners.delete(listener); }
  async receive(data: string | Uint8Array, binary: boolean) {
    if (this.messageListeners.size > 0) { await Promise.all([...this.messageListeners].map(listener => listener(data, binary))); return; }
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
    if (this.pendingBytes + bytes > this.maxPendingBytes) { this.terminate(1013, 'WebSocket consumer is too slow'); return; }
    this.pending.push({ data, binary }); this.pendingBytes += bytes;
  }
  closed(code: number, reason: string) { this.closeListeners.forEach(listener => listener(code, reason)); this.messageListeners.clear(); this.closeListeners.clear(); }
}

function normalizeCloseCode(code: number) {
  return code === 1000 || (code >= 3000 && code <= 4999) || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ? code : 1011;
}

export function createTunnelPeer(socket: TunnelSocket, handlers: TunnelPeerHandlers, options: TunnelPeerOptions = {}): TunnelPeer {
  const limits = { ...DEFAULTS, ...options };
  if (limits.maxFrameBytes < 1024 || limits.initialCreditBytes < 1 || limits.maxQueuedBytes < limits.maxFrameBytes) throw new Error('Tunnel peer limits are invalid.');
  const streams = new Map<string, StreamState>();
  let sequence = 0;
  let closed = false;
  let lastReceived = Date.now();
  let queuedBytes = 0;

  function transmit(frame: TunnelFrame) {
    if (closed) throw new TunnelError('closed', 'Tunnel connection is closed.');
    const encoded = encodeTunnelFrame(frame, limits.maxFrameBytes);
    const bytes = typeof encoded === 'string' ? new TextEncoder().encode(encoded).byteLength : encoded.byteLength;
    if (queuedBytes + bytes > limits.maxQueuedBytes || (socket.bufferedAmount ?? 0) + bytes > limits.maxQueuedBytes) {
      throw new TunnelError('backpressure', 'Tunnel outbound queue is full.');
    }
    queuedBytes += bytes;
    try {
      const sent = socket.send(encoded);
      void Promise.resolve(sent).then(() => { queuedBytes -= bytes; }, () => { queuedBytes -= bytes; socket.close(1011, 'Tunnel send failed'); });
    } catch (error) {
      queuedBytes -= bytes;
      throw error;
    }
  }
  function finish(id: string) {
    const state = streams.get(id);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    streams.delete(id);
  }
  function fail(id: string, code: string, message: string, notify = true) {
    const state = streams.get(id);
    if (!state) return;
    finish(id);
    state.controller.abort(new TunnelError(code, message));
    state.reject?.(new TunnelError(code, message));
    if (state.kind === 'http') { state.requestCredit.close(); state.responseCredit.close(); state.requestReceiver?.error(new TunnelError(code, message)); state.responseReceiver?.error(new TunnelError(code, message)); }
    else { state.credit.close(); state.endpoint.closed(code === 'preview_revoked' ? 1008 : 1011, message.slice(0, 123)); }
    if (notify && !closed) transmit({ type: 'cancel', streamId: id, code, message: message.slice(0, 256) });
  }
  function allocate(kind: StreamState['kind']) {
    if (streams.size >= limits.maxStreams) throw new TunnelError('capacity', 'Tunnel stream capacity is exhausted.');
    const id = `${Date.now().toString(36)}-${(++sequence).toString(36)}`;
    const controller = new AbortController();
    return { id, controller, kind } as const;
  }
  async function sendBody(id: string, direction: 'request' | 'response', body?: ReadableStream<Uint8Array>) {
    if (body) {
      const reader = body.getReader();
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          const chunkSize = Math.min(limits.maxFrameBytes - 512, limits.initialCreditBytes);
          for (let offset = 0; offset < item.value.byteLength; offset += chunkSize) {
            const data = item.value.slice(offset, offset + chunkSize);
            const state = streams.get(id);
            if (!state || state.kind !== 'http') throw new TunnelError('cancelled', 'HTTP stream ended.');
            await (direction === 'request' ? state.requestCredit : state.responseCredit).take(data.byteLength);
            transmit({ type: 'body_chunk', streamId: id, direction, data });
          }
        }
      } finally { reader.releaseLock(); }
    }
    transmit({ type: 'body_end', streamId: id, direction });
  }

  async function handle(frame: TunnelFrame) {
    lastReceived = Date.now();
    if (frame.type === 'ping') { transmit({ type: 'pong', nonce: frame.nonce }); return; }
    if (frame.type === 'pong') return;
    if (frame.type === 'http_open') {
      if (!handlers.http || streams.size >= limits.maxStreams) { transmit({ type: 'cancel', streamId: frame.streamId, code: 'capacity', message: 'HTTP forwarding is unavailable.' }); return; }
      const controller = new AbortController();
      const requestCredit = new CreditWindow(); const responseCredit = new CreditWindow();
      const requestReceiver = frame.hasBody ? new BodyReceiver(limits.initialCreditBytes, bytes => transmit({ type: 'credit', streamId: frame.streamId, direction: 'request', bytes }), () => controller.abort()) : undefined;
      const body = requestReceiver?.stream;
      streams.set(frame.streamId, { kind: 'http', previewId: frame.previewId, controller, requestReceiver, requestCredit, responseCredit });
      if (frame.hasBody) transmit({ type: 'credit', streamId: frame.streamId, direction: 'request', bytes: limits.initialCreditBytes });
      try {
        const response = await handlers.http({ previewId: frame.previewId, method: frame.method, path: frame.path, headers: frame.headers, body }, { signal: controller.signal });
        if (!streams.has(frame.streamId)) return;
        transmit({ type: 'http_response', streamId: frame.streamId, status: response.status, headers: response.headers, hasBody: Boolean(response.body) });
        await sendBody(frame.streamId, 'response', response.body);
        finish(frame.streamId);
      } catch (error) { fail(frame.streamId, controller.signal.aborted ? 'cancelled' : 'upstream_error', error instanceof Error ? error.message : 'Upstream request failed.'); }
      return;
    }
    const state = streams.get(frame.streamId);
    if (!state) return;
    if (frame.type === 'credit') {
      if (state.kind === 'ws' && frame.direction === 'ws') state.credit.grant(frame.bytes);
      else if (state.kind === 'http' && frame.direction !== 'ws') (frame.direction === 'request' ? state.requestCredit : state.responseCredit).grant(frame.bytes);
    } else if (frame.type === 'body_chunk' && state.kind === 'http') {
      (frame.direction === 'request' ? state.requestReceiver : state.responseReceiver)?.push(frame.data);
    } else if (frame.type === 'body_end' && state.kind === 'http') {
      (frame.direction === 'request' ? state.requestReceiver : state.responseReceiver)?.close();
      if (frame.direction === 'response') finish(frame.streamId);
    } else if (frame.type === 'http_response' && state.kind === 'http') {
      if (state.timer) clearTimeout(state.timer);
      const receiver = frame.hasBody ? new BodyReceiver(limits.initialCreditBytes, bytes => transmit({ type: 'credit', streamId: frame.streamId, direction: 'response', bytes }), () => fail(frame.streamId, 'cancelled', 'Response consumer cancelled.')) : undefined;
      state.responseReceiver = receiver;
      const body = receiver?.stream;
      state.response?.({ status: frame.status, headers: frame.headers, body });
      if (frame.hasBody) transmit({ type: 'credit', streamId: frame.streamId, direction: 'response', bytes: limits.initialCreditBytes });
      if (!frame.hasBody) finish(frame.streamId);
    } else if (frame.type === 'cancel') fail(frame.streamId, frame.code, frame.message, false);
    else if (frame.type === 'ws_accept' && state.kind === 'ws') { if (state.timer) clearTimeout(state.timer); state.resolve?.({ protocol: frame.protocol, socket: state.endpoint }); }
    else if (frame.type === 'ws_message' && state.kind === 'ws') {
      await state.endpoint.receive(frame.binary ? frame.data : new TextDecoder().decode(frame.data), frame.binary);
      if (streams.has(frame.streamId)) transmit({ type: 'credit', streamId: frame.streamId, direction: 'ws', bytes: frame.data.byteLength });
    }
    else if (frame.type === 'ws_close' && state.kind === 'ws') { state.endpoint.closed(frame.code, frame.reason); state.remote?.close(frame.code, frame.reason); finish(frame.streamId); }
  }

  async function acceptWebSocket(frame: Extract<TunnelFrame, { type: 'ws_open' }>) {
    if (!handlers.webSocket || streams.size >= limits.maxStreams) { transmit({ type: 'cancel', streamId: frame.streamId, code: 'capacity', message: 'WebSocket forwarding is unavailable.' }); return; }
    const controller = new AbortController();
    const credit = new CreditWindow();
    const endpoint = new LocalWebSocket(async (data, binary) => { const payload = typeof data === 'string' ? new TextEncoder().encode(data) : data; await credit.take(payload.byteLength); transmit({ type: 'ws_message', streamId: frame.streamId, binary, data: payload }); }, (code, reason) => transmit({ type: 'ws_close', streamId: frame.streamId, code, reason }), limits.maxQueuedBytes, limits.maxFrameBytes - 512);
    const state: WsState = { kind: 'ws', previewId: frame.previewId, controller, endpoint, credit };
    streams.set(frame.streamId, state);
    transmit({ type: 'credit', streamId: frame.streamId, direction: 'ws', bytes: limits.maxFrameBytes });
    try {
      const accepted = await handlers.webSocket({ previewId: frame.previewId, path: frame.path, headers: frame.headers, protocols: frame.protocols }, { signal: controller.signal });
      if (streams.get(frame.streamId) !== state) { accepted.socket.close(1008, 'WebSocket handshake was cancelled'); return; }
      state.remote = accepted.socket;
      accepted.socket.onMessage(async (data, binary) => {
        const payload = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        if (payload.byteLength > limits.maxFrameBytes - 512) { accepted.socket.close(1009, 'WebSocket message is too large'); fail(frame.streamId, 'frame_too_large', 'WebSocket message is too large.'); return; }
        await credit.take(payload.byteLength);
        if (streams.get(frame.streamId) === state) transmit({ type: 'ws_message', streamId: frame.streamId, binary, data: payload });
      });
      accepted.socket.onClose((code, reason) => { if (streams.has(frame.streamId)) transmit({ type: 'ws_close', streamId: frame.streamId, code: normalizeCloseCode(code), reason: reason.slice(0, 123) }); finish(frame.streamId); });
      endpoint.onMessage((data, binary) => accepted.socket.send(data, binary));
      endpoint.onClose((code, reason) => accepted.socket.close(code, reason));
      transmit({ type: 'ws_accept', streamId: frame.streamId, protocol: accepted.protocol });
    } catch (error) { fail(frame.streamId, 'ws_rejected', error instanceof Error ? error.message : 'WebSocket handshake failed.'); }
  }

  const removeMessage = socket.onMessage(data => {
    try { const frame = decodeTunnelFrame(data, limits.maxFrameBytes); void (frame.type === 'ws_open' ? acceptWebSocket(frame) : handle(frame)).catch(() => socket.close(1011, 'Tunnel frame handling failed')); }
    catch { socket.close(1002, 'Invalid tunnel frame'); }
  });
  const removeClose = socket.onClose((_code, reason) => { closed = true; for (const id of [...streams.keys()]) fail(id, 'disconnected', reason || 'Tunnel disconnected.', false); });
  const heartbeat = setInterval(() => {
    if (Date.now() - lastReceived > limits.heartbeatTimeoutMs) { socket.close(1011, 'Tunnel heartbeat timeout'); return; }
    try { transmit({ type: 'ping', nonce: Date.now().toString(36) }); } catch { socket.close(1013, 'Tunnel backpressure'); }
  }, limits.heartbeatIntervalMs);
  heartbeat.unref?.();

  return {
    async openHttp(request) {
      const allocated = allocate('http');
      return new Promise<TunnelHttpResponse>((resolve, reject) => {
        const state: HttpState = { kind: 'http', previewId: request.previewId, controller: allocated.controller, requestCredit: new CreditWindow(), responseCredit: new CreditWindow(), response: resolve, reject };
        state.timer = setTimeout(() => fail(allocated.id, 'timeout', 'HTTP response headers timed out.'), limits.openTimeoutMs);
        streams.set(allocated.id, state);
        request.signal?.addEventListener('abort', () => fail(allocated.id, 'cancelled', 'HTTP request cancelled.'), { once: true });
        transmit({ type: 'http_open', streamId: allocated.id, previewId: request.previewId, method: request.method, path: request.path, headers: request.headers, hasBody: Boolean(request.body) });
        void sendBody(allocated.id, 'request', request.body).catch(error => fail(allocated.id, 'body_error', String(error)));
      });
    },
    async openWebSocket(request: TunnelWebSocketRequest & { signal?: AbortSignal }) {
      const allocated = allocate('ws');
      const credit = new CreditWindow();
      const endpoint = new LocalWebSocket(async (data, binary) => { const payload = typeof data === 'string' ? new TextEncoder().encode(data) : data; await credit.take(payload.byteLength); transmit({ type: 'ws_message', streamId: allocated.id, binary, data: payload }); }, (code, reason) => transmit({ type: 'ws_close', streamId: allocated.id, code, reason }), limits.maxQueuedBytes, limits.maxFrameBytes - 512);
      return new Promise<TunnelWebSocketAcceptance>((resolve, reject) => {
        const state: WsState = { kind: 'ws', previewId: request.previewId, controller: allocated.controller, endpoint, credit, resolve, reject };
        state.timer = setTimeout(() => fail(allocated.id, 'timeout', 'WebSocket handshake timed out.'), limits.openTimeoutMs);
        streams.set(allocated.id, state);
        request.signal?.addEventListener('abort', () => fail(allocated.id, 'cancelled', 'WebSocket handshake cancelled.'), { once: true });
        transmit({ type: 'ws_open', streamId: allocated.id, previewId: request.previewId, path: request.path, headers: request.headers, protocols: request.protocols });
        transmit({ type: 'credit', streamId: allocated.id, direction: 'ws', bytes: limits.maxFrameBytes });
      });
    },
    cancelPreview(previewId, code = 'preview_revoked', message = 'Preview registration was revoked.') {
      for (const [id, state] of streams) if (state.previewId === previewId) fail(id, code, message);
    },
    close(code = 1000, reason = 'Tunnel closed') { if (closed) return; closed = true; clearInterval(heartbeat); removeMessage(); removeClose(); socket.close(code, reason); for (const id of [...streams.keys()]) fail(id, 'closed', reason, false); },
  };
}

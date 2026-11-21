import { decodeIncompatibleProtocolVersionError, decodeServerMessage, decodeSessionChannelClientMessage, encodeSessionChannelServerMessage } from './codec.js';
import type { ClientMessage } from './messages.js';
import type { SessionChannelServerMessage } from './session-channel.js';
import { PROTOCOL_VERSION } from './version.js';

/** A runtime-neutral socket compatible with existing per-session adapters. */
export interface SessionChannelSocket {
  readonly readyState: number;
  readonly bufferedAmount: number | undefined;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (data: string, binary: boolean) => void | Promise<void>): () => void;
  onClose(listener: () => void): () => void;
  onError(listener: () => void): () => void;
}

export type SessionChannelMode = 'session' | 'activity';
export type SessionChannelOpenResult = { accept(socket: SessionChannelSocket): void } | { code: number; reason: string };

export const SESSION_CHANNEL_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const SESSION_CHANNEL_MAX_SUBSCRIPTIONS = 128;
export const SESSION_CHANNEL_MAX_PENDING_FRAMES = 64;
export const SESSION_CHANNEL_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const OPEN_TIMEOUT_MS = 35_000;
const MAX_OPENS_PER_MINUTE = 120;
/**
 * Clients ping at least once a minute, also while their page is hidden. A channel silent for longer
 * belongs to a frozen or vanished page whose network connection was never closed; releasing it frees
 * the session streams it holds, which otherwise count against the account's stream limit indefinitely.
 */
export const SESSION_CHANNEL_IDLE_TIMEOUT_MS = 5 * 60_000;
/** A subscription refused because the account or Host has too many open session streams; retrying later can succeed. */
export const SESSION_CAPACITY_CLOSE_CODE = 4029;
/** A subscription closed so that one in more recent use could open; the client resumes it when it is in use again. */
export const SESSION_PREEMPTED_CLOSE_CODE = 4030;
const PREEMPTED_REASON = 'Paused to free a connection for a window used more recently. Return to this window to resume.';

/** An open subscription the Relay may close so that one in more recent use can open. */
export interface PreemptibleSubscription {
  /** When the subscription was last in use, or Infinity while it is in use. */
  lastUsed(): number;
  preempt(): void;
}
/** Offered to clients that request it; the channel registers each open subscription until it closes. */
export interface SessionChannelPreemption {
  register(subscription: PreemptibleSubscription): () => void;
}
// Keep browser/Worker/Node host types out of the public schema package.
const runtime = globalThis as unknown as {
  TextEncoder: new () => { encode(value: string): Uint8Array };
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
};
const utf8 = new runtime.TextEncoder();

type MessageListener = Parameters<SessionChannelSocket['onMessage']>[0];
interface Stream {
  id: number;
  socket: SessionChannelSocket;
  messages: Set<MessageListener>;
  closes: Set<() => void>;
  errors: Set<() => void>;
  queue: { data: string; bytes: number }[];
  pendingBytes: number;
  closed: boolean;
  attached: boolean;
  draining: boolean;
  opening: boolean;
  reserved: boolean;
  timer?: unknown;
  inUse: boolean;
  lastUsedAt: number;
  unregister?: () => void;
}

/**
 * Multiplex existing session wires; the opener owns authorization and routing. With preemption, the
 * opener learns when each subscription was last in use and may close less recently used ones.
 */
export function acceptSessionChannel(
  socket: SessionChannelSocket,
  mode: SessionChannelMode,
  openSession: (agentId: string, lastUsed: () => number) => Promise<SessionChannelOpenResult>,
  readiness: { successions?: 1 } = {},
  idleTimeoutMs = SESSION_CHANNEL_IDLE_TIMEOUT_MS,
  preemption?: SessionChannelPreemption,
): () => void {
  const streams = new Map<number, Stream>();
  const removers: (() => void)[] = [];
  const openedAt: number[] = [];
  let stopped = false;
  let highestId = 0;
  let pendingBytes = 0;
  let reservations = 0;
  let lastFrameAt = Date.now();
  let idleTimer: unknown;
  function watchIdle(delay: number) {
    idleTimer = runtime.setTimeout(() => {
      if (stopped) return;
      const quiet = Date.now() - lastFrameAt;
      if (quiet >= idleTimeoutMs) { stop(1001, 'Channel idle'); return; }
      watchIdle(idleTimeoutMs - quiet);
    }, delay);
    (idleTimer as { unref?(): void }).unref?.();
  }

  function release(stream: Stream) {
    if (stream.reserved && stream.closed && !stream.opening && !stream.draining) {
      stream.reserved = false;
      reservations--;
    }
  }

  function finish(stream: Stream, code = 1000, reason = '', notify = true) {
    if (stream.closed) return;
    stream.closed = true;
    stream.unregister?.();
    runtime.clearTimeout(stream.timer);
    streams.delete(stream.id);
    pendingBytes -= stream.pendingBytes;
    stream.pendingBytes = 0;
    stream.queue.length = 0;
    if (notify) send({ protocolVersion: PROTOCOL_VERSION, type: 'closed', subscriptionId: stream.id, code, reason });
    for (const listener of [...stream.closes]) { try { listener(); } catch { /* Keep sibling cleanup independent. */ } }
    stream.messages.clear(); stream.closes.clear(); stream.errors.clear();
    release(stream);
  }

  function stop(code = 1000, reason = 'Channel disposed', closePhysical = true) {
    if (stopped) return;
    stopped = true;
    runtime.clearTimeout(idleTimer);
    for (const remove of removers.splice(0)) remove();
    for (const stream of [...streams.values()]) finish(stream, code, reason, false);
    if (closePhysical && socket.readyState === 1) { try { socket.close(code, reason); } catch { /* Already disconnected. */ } }
  }

  function send(message: SessionChannelServerMessage) {
    if (stopped) return;
    if (socket.readyState !== 1) { stop(1001, 'Channel disconnected', false); return; }
    const encoded = encodeSessionChannelServerMessage(message);
    if (encoded.status !== 'ok') { stop(1011, 'Invalid channel response'); return; }
    const bytes = utf8.encode(encoded.json).byteLength;
    if (bytes > SESSION_CHANNEL_MAX_FRAME_BYTES) { stop(1009, 'Channel frame too large'); return; }
    if ((socket.bufferedAmount ?? 0) + bytes > SESSION_CHANNEL_MAX_BUFFERED_BYTES) { stop(1013, 'Channel backpressure limit'); return; }
    try { socket.send(encoded.json); } catch { stop(1011, 'Channel send failed'); }
  }

  async function drain(stream: Stream) {
    if (stream.closed || !stream.attached || stream.draining) return;
    stream.draining = true;
    try {
      while (!stream.closed && stream.queue.length > 0) {
        const next = stream.queue[0]!;
        for (const listener of [...stream.messages]) {
          if (stream.closed) return;
          await listener(next.data, false);
        }
        if (stream.closed) return;
        stream.queue.shift(); stream.pendingBytes -= next.bytes; pendingBytes -= next.bytes;
      }
    } catch { finish(stream, 1011, 'Session message handler failed'); }
    finally { stream.draining = false; release(stream); }
  }

  function enqueue(stream: Stream, message: ClientMessage) {
    if (stream.closed) return;
    if ((message.type === 'negotiate' && (message.observation === 'activity') !== (mode === 'activity'))
      || (mode === 'activity' && message.type !== 'negotiate')) {
      finish(stream, 1008, 'Message is not allowed in this observation mode'); return;
    }
    const data = JSON.stringify(message);
    const bytes = utf8.encode(data).byteLength;
    if (stream.queue.length >= SESSION_CHANNEL_MAX_PENDING_FRAMES || stream.pendingBytes + bytes > SESSION_CHANNEL_MAX_FRAME_BYTES
      || pendingBytes + bytes > SESSION_CHANNEL_MAX_BUFFERED_BYTES) {
      finish(stream, 1013, 'Session pending queue limit'); return;
    }
    stream.queue.push({ data, bytes }); stream.pendingBytes += bytes; pendingBytes += bytes;
    void drain(stream);
  }

  function subscribe(id: number, agentId: string, message: ClientMessage, idleMs?: number) {
    // Replayed IDs never create another incarnation or close an existing one.
    if (id <= highestId) return;
    highestId = id;
    const now = Date.now();
    while (openedAt.length > 0 && openedAt[0]! <= now - 60_000) openedAt.shift();
    if (reservations >= SESSION_CHANNEL_MAX_SUBSCRIPTIONS
      || openedAt.length >= MAX_OPENS_PER_MINUTE) {
      send({ protocolVersion: PROTOCOL_VERSION, type: 'closed', subscriptionId: id, code: 1013, reason: 'Session subscription limit' }); return;
    }
    const stream: Stream = {
      id, socket: undefined as unknown as SessionChannelSocket, messages: new Set(), closes: new Set(), errors: new Set(),
      queue: [], pendingBytes: 0, closed: false, attached: false, draining: false, opening: false, reserved: true,
      inUse: !preemption || idleMs === undefined, lastUsedAt: now - (preemption ? idleMs ?? 0 : 0),
    };
    const lastUsed = () => stream.inUse ? Number.POSITIVE_INFINITY : stream.lastUsedAt;
    stream.socket = {
      get readyState() { return stream.closed || stopped ? 3 : socket.readyState; },
      get bufferedAmount() { return socket.bufferedAmount; },
      send(data) {
        if (stream.closed || stopped) return;
        if (utf8.encode(data).byteLength > SESSION_CHANNEL_MAX_FRAME_BYTES) { finish(stream, 1009, 'Session frame too large'); return; }
        const decoded = decodeServerMessage(data);
        const response = decoded.status === 'ok' ? decoded : decodeIncompatibleProtocolVersionError(data);
        if (response.status !== 'ok') { finish(stream, 1011, 'Invalid session response'); return; }
        if (mode === 'activity' && !['negotiated', 'agent_activity', 'protocol_error'].includes(response.value.type)) {
          finish(stream, 1008, 'Response is not allowed in this observation mode'); return;
        }
        const frame: SessionChannelServerMessage = { protocolVersion: PROTOCOL_VERSION, type: 'message', subscriptionId: id, message: response.value };
        if (utf8.encode(JSON.stringify(frame)).byteLength > SESSION_CHANNEL_MAX_FRAME_BYTES) { finish(stream, 1009, 'Session frame too large'); return; }
        send(frame);
      },
      close(code, reason) { finish(stream, code, reason); },
      onMessage(listener) { if (!stream.closed) stream.messages.add(listener); return () => { stream.messages.delete(listener); }; },
      onClose(listener) { if (!stream.closed) stream.closes.add(listener); return () => { stream.closes.delete(listener); }; },
      onError(listener) { if (!stream.closed) stream.errors.add(listener); return () => { stream.errors.delete(listener); }; },
    };
    reservations++;
    streams.set(id, stream);
    enqueue(stream, message);
    if (stream.closed) return;
    openedAt.push(now);
    stream.opening = true;
    stream.timer = runtime.setTimeout(() => finish(stream, 1013, 'Session open timed out'), OPEN_TIMEOUT_MS);
    (stream.timer as unknown as { unref?(): void }).unref?.();
    // Cancellation removes the logical stream immediately, but unresolved opener
    // work retains its capacity reservation until the injected factory settles.
    void (async () => {
      try {
        const opened = await openSession(agentId, lastUsed);
        if (stream.closed || stopped) return;
        runtime.clearTimeout(stream.timer);
        if ('code' in opened) { finish(stream, opened.code, opened.reason); return; }
        opened.accept(stream.socket);
        if (stream.closed || stopped) return;
        stream.attached = true;
        stream.unregister = preemption?.register({ lastUsed, preempt: () => finish(stream, SESSION_PREEMPTED_CLOSE_CODE, PREEMPTED_REASON) });
        void drain(stream);
      } catch { finish(stream, 1011, 'Session open failed'); }
      finally { stream.opening = false; release(stream); }
    })();
  }

  function intent(ids: readonly number[], active: boolean) {
    const now = Date.now();
    for (const id of ids) {
      const stream = streams.get(id);
      if (!stream) continue;
      if (active) stream.inUse = true;
      else if (stream.inUse) { stream.inUse = false; stream.lastUsedAt = now; }
    }
  }

  removers.push(socket.onMessage((data, binary) => {
    if (stopped) return;
    lastFrameAt = Date.now();
    if (binary) { stop(1003, 'Channel requires text frames'); return; }
    if (utf8.encode(data).byteLength > SESSION_CHANNEL_MAX_FRAME_BYTES) { stop(1009, 'Channel frame too large'); return; }
    const decoded = decodeSessionChannelClientMessage(data);
    if (decoded.status !== 'ok') { stop(1008, 'Invalid channel frame'); return; }
    const message = decoded.value;
    if (message.type === 'ping') { send({ protocolVersion: PROTOCOL_VERSION, type: 'pong' }); return; }
    if (message.type === 'subscribe') { subscribe(message.subscriptionId, message.agentId, message.message, message.idleMs); return; }
    if (message.type === 'intent') { if (preemption) intent(message.subscriptionIds, message.active); return; }
    const stream = streams.get(message.subscriptionId);
    if (!stream) return;
    if (message.type === 'unsubscribe') finish(stream, 1000, 'Unsubscribed', false);
    else enqueue(stream, message.message);
  }));
  removers.push(socket.onClose(() => stop(1001, 'Channel disconnected', false)));
  removers.push(socket.onError(() => stop(1011, 'Channel socket error')));
  send({ protocolVersion: PROTOCOL_VERSION, type: 'ready', ...readiness, ...(preemption ? { preemption: 1 as const } : {}) });
  if (!stopped) watchIdle(idleTimeoutMs);
  return () => stop();
}

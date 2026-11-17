import { randomUUID } from 'node:crypto';

import type { NativeSessionOwner, RemoteHostUplinkMessage } from '@orchardworks/agent-remote-protocol';

import { sessionIdentityMessage, withoutItemKeysFlag } from './session-identity.js';
import type { StreamControl } from './stream-control.js';
import { RELAY_SOCKET_OPEN, type BrokerScheduler, type RelaySocket } from './transport.js';

/** The messages and bytes a stream holds for the Controller before it accepts the stream. */
const BUFFER_MAX_MESSAGES = 32;
const BUFFER_MAX_BYTES = 1024 * 1024;
const SOCKET_CLOSED = 3;
const encoder = new TextEncoder();

/** One session stream a Host holds open for a browser; the broker's `stream_*` handlers read and change these entries. */
export interface HostStreamEntry {
  publicAgentId: string;
  runtimeAgentId: string;
  socket: RelaySocket;
  subject?: string;
  authorized?(): boolean;
  /** A stream that passes through the Relay: it answers control itself, and says what the Controller's frames mean for it. */
  control?: StreamControl;
  ready: boolean;
  buffered: string[];
  timer?: unknown;
  /** Called by the broker after the Controller accepted the stream and the buffered messages were written. */
  onReady?(): void;
}

/** Where the frames of one Controller stream go. */
export interface HostStreamSink {
  /** A frame from the Controller session, addressed with the public session id. */
  frame(raw: string): void;
  /** The Controller accepted the stream. */
  ready(): void;
  /**
   * The stream ended: the Controller closed it, the Host went away, access was revoked, or it was never accepted.
   * Called once, and never after `HostStream.close()`.
   */
  ended(code: number, reason: string): void;
}

export interface HostStream {
  /**
   * Sends a frame addressed with the public session id; holds it until the Controller accepts the stream. Throws a
   * HostStreamRefusal (`invalid_session_target` when the frame addresses another session) or the Host write error.
   */
  send(raw: string): void;
  /** The browser left: ends the stream and tells the Controller. */
  close(): void;
}

export interface HostStreamOpener {
  /** Opens a stream; rejects with a HostStreamRefusal that names why not. */
  open(sink: HostStreamSink): Promise<HostStream>;
}

/**
 * Why a Controller stream could not be opened or written. `code` is the code a browser can show; `status` is the HTTP
 * status of the broker's refusal and `nativeOwner` the native owner it reported, when it had them.
 */
export class HostStreamRefusal extends Error {
  constructor(readonly code: string, message: string, readonly status?: number | undefined, readonly nativeOwner?: NativeSessionOwner | undefined) {
    super(message);
    this.name = 'HostStreamRefusal';
  }
}

export type HostStreamDiagnostic =
  | { event: 'stream_opening'; streamId: string; agentId: string }
  | { event: 'stream_open_timeout'; streamId: string }
  | { event: 'stream_closed'; streamId: string };

export interface HostStreamContext {
  /** The Host's open streams. */
  streams: Map<string, HostStreamEntry>;
  publicAgentId: string;
  /** The id the Controller knows the session by; read when the stream opens. */
  runtimeAgentId(): string;
  subject?: string;
  authorized(): boolean;
  /** Makes the Controller know the session; rejects with the reason when it cannot. */
  recover(): Promise<void>;
  /** Which stream limit is reached, if any. */
  capacity(): 'host' | 'account' | undefined;
  /** Writes to the Host's uplink; throws when the Host is offline or busy. */
  write(message: RemoteHostUplinkMessage): void;
  scheduler: BrokerScheduler;
  openTimeoutMs: number;
  diagnostic(details: HostStreamDiagnostic): void;
}

/** A refusal for an error from the broker: its code when it has one. */
function refusalOf(error: unknown): HostStreamRefusal {
  if (error instanceof HostStreamRefusal) return error;
  if (error instanceof Error) {
    const { code, status, nativeOwner } = error as { code?: unknown; status?: unknown; nativeOwner?: NativeSessionOwner };
    return new HostStreamRefusal(typeof code === 'string' ? code : 'host_unavailable', error.message, typeof status === 'number' ? status : undefined, nativeOwner);
  }
  return new HostStreamRefusal('host_unavailable', 'The Controller session is unavailable.');
}

export function createHostStreamOpener(context: HostStreamContext): HostStreamOpener {
  return {
    async open(sink) {
      try { await context.recover(); }
      catch (error) { throw refusalOf(error); }
      const full = context.capacity();
      if (full) {
        throw new HostStreamRefusal('session_stream_capacity', full === 'host'
          ? 'This Host has too many sessions open in browsers. Close session views you no longer use; operations on this session work again when a slot is free.'
          : 'Too many sessions are open across your browsers and devices. Close tabs, windows or session views you no longer use; operations on this session work again when a slot is free.', 429);
      }
      const streamId = randomUUID();
      let closed = false;
      const none = () => undefined;
      /** What a browser stream does when it ends: free the slot and tell the Controller, unless the broker already did. */
      const release = () => {
        context.scheduler.clearTimeout(entry.timer);
        if (context.streams.get(streamId) !== entry) return;
        context.streams.delete(streamId);
        context.diagnostic({ event: 'stream_closed', streamId });
        try { context.write({ uplinkVersion: 2, type: 'stream_close', streamId, code: 1000, reason: 'Browser disconnected' }); }
        catch { /* The Host may already be offline. */ }
      };
      const socket: RelaySocket = {
        get readyState() { return closed ? SOCKET_CLOSED : RELAY_SOCKET_OPEN; },
        bufferedAmount: undefined,
        send: data => { if (!closed) sink.frame(data); },
        close: (code = 1000, reason = '') => {
          if (closed) return;
          closed = true;
          release();
          sink.ended(code, reason);
        },
        onMessage: () => none,
        onClose: () => none,
        onError: () => none,
      };
      const entry: HostStreamEntry = {
        publicAgentId: context.publicAgentId, runtimeAgentId: context.runtimeAgentId(), socket,
        ...(context.subject === undefined ? {} : { subject: context.subject }), authorized: context.authorized,
        ready: false, buffered: [], onReady: () => sink.ready(),
      };
      context.streams.set(streamId, entry);
      context.diagnostic({ event: 'stream_opening', streamId, agentId: context.publicAgentId });
      entry.timer = context.scheduler.setTimeout(() => {
        context.diagnostic({ event: 'stream_open_timeout', streamId });
        socket.close(1013, 'Remote stream opening timed out');
      }, context.openTimeoutMs);
      try { context.write({ uplinkVersion: 2, type: 'stream_open', streamId, sessionId: entry.runtimeAgentId }); }
      catch (error) {
        context.scheduler.clearTimeout(entry.timer);
        context.streams.delete(streamId);
        closed = true;
        throw refusalOf(error);
      }
      return {
        send(raw) {
          if (closed) throw new HostStreamRefusal('host_stream_closed', 'The Controller session closed.');
          let outgoing: string;
          try { outgoing = withoutItemKeysFlag(sessionIdentityMessage(raw, entry.publicAgentId, entry.runtimeAgentId, 'client')); }
          catch { throw new HostStreamRefusal('invalid_session_target', 'The message addresses another session.'); }
          if (!entry.ready) {
            const held = entry.buffered.reduce((sum, value) => sum + encoder.encode(value).byteLength, 0);
            if (entry.buffered.length >= BUFFER_MAX_MESSAGES || held + encoder.encode(outgoing).byteLength > BUFFER_MAX_BYTES) {
              throw new HostStreamRefusal('host_stream_not_ready', 'The Controller session is not ready.');
            }
            entry.buffered.push(outgoing);
            return;
          }
          context.write({ uplinkVersion: 2, type: 'stream_message', streamId, message: outgoing });
        },
        close() {
          if (closed) return;
          closed = true;
          release();
        },
      };
    },
  };
}

import {
  PROTOCOL_VERSION, decodeSessionChannelServerMessage, encodeClientMessage,
  encodeSessionChannelClientMessage,
  SESSION_CHANNEL_MAX_FRAME_BYTES, SESSION_CHANNEL_MAX_BUFFERED_BYTES,
  SESSION_CHANNEL_MAX_SUBSCRIPTIONS, SESSION_CHANNEL_MAX_PENDING_FRAMES,
  type ClientMessage, type SessionChannelClientMessage,
} from '@orchardworks/agent-remote-protocol';
import type { WebSocketLike } from './http-websocket-transport.js';
import { watchPageResume } from './page-resume.js';
import type {
  RemoteConnection, RemoteProtocolObservation, RemoteTransportDiagnostic, RemoteTransportListener,
} from './transport.js';

type Mode = 'session' | 'activity';
type Negotiation = Extract<ClientMessage, { type: 'negotiate' }>;
interface Dependencies {
  onTitle?(session: import('@orchardworks/agent-remote-protocol').SessionTitleUpdate): void;
  onMigration?(migration: import('@orchardworks/agent-remote-protocol').SessionMigration): void;
  createSocket(mode: Mode): WebSocketLike;
  connectDirect(agentId: string, listener: RemoteTransportListener): RemoteConnection;
  observe(observation: RemoteProtocolObservation): void;
  diagnostic(diagnostic: RemoteTransportDiagnostic): void;
}
interface Subscription {
  id: number;
  readonly agentId: string;
  readonly listener: RemoteTransportListener;
  active: boolean;
  negotiation?: Negotiation;
  channel?: Channel;
  direct?: RemoteConnection;
  directReady: boolean;
  subscribed: boolean;
  queued: ClientMessage[];
  queuedBytes: number;
}
interface Channel {
  readonly mode: Mode;
  readonly socket: WebSocketLike;
  readonly subscriptions: Map<number, Subscription>;
  active: boolean;
  ready: boolean;
  readyTimer?: ReturnType<typeof setTimeout>;
  pingTimer?: ReturnType<typeof setInterval>;
  pongTimer?: ReturnType<typeof setTimeout>;
}

const utf8 = new TextEncoder();

/** Owns physical channels while existing session clients own reconnect and replay decisions. */
export class SessionChannelPool {
  private readonly channels = new Map<Mode, Channel>();
  private readonly legacyModes = new Set<Mode>();
  private readonly supportedModes = new Set<Mode>();
  private readonly subscriptions = new Set<Subscription>();
  private readonly unwatch: () => void;
  private nextId = 0;
  private disposed = false;
  private pendingBytes = 0;

  constructor(private readonly dependencies: Dependencies) {
    this.unwatch = watchPageResume(() => {
      for (const channel of [...this.channels.values()]) this.failChannel(channel, false);
    });
  }

  connect(agentId: string, listener: RemoteTransportListener): RemoteConnection {
    if (this.disposed) throw new Error('Remote session channels are disposed.');
    if (this.subscriptions.size >= SESSION_CHANNEL_MAX_SUBSCRIPTIONS || this.nextId >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Remote session channel subscription limit reached.');
    }
    const subscription: Subscription = {
      id: 0, agentId, listener, active: true, directReady: false,
      subscribed: false, queued: [], queuedBytes: 0,
    };
    this.subscriptions.add(subscription);
    queueMicrotask(() => { if (subscription.active) listener.onOpen(); });
    return {
      send: (message) => this.send(subscription, message),
      close: () => this.retire(subscription),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unwatch();
    for (const channel of [...this.channels.values()]) this.stopChannel(channel);
    for (const subscription of [...this.subscriptions]) this.retire(subscription);
  }

  private send(subscription: Subscription, message: ClientMessage): void {
    if (!subscription.active) throw new Error('Remote WebSocket connection is closed.');
    const encoded = encodeClientMessage(message);
    if (encoded.status === 'rejected') throw new Error('Client message was rejected by the public protocol.');
    if (!subscription.negotiation) {
      if (message.type !== 'negotiate') throw new Error('Remote session must negotiate before sending messages.');
      if (this.nextId >= Number.MAX_SAFE_INTEGER) throw new Error('Remote session channel subscription limit reached.');
      subscription.id = ++this.nextId;
      subscription.negotiation = message;
      const mode: Mode = message.observation === 'activity' ? 'activity' : 'session';
      if (this.legacyModes.has(mode)) { this.openDirect(subscription); return; }
      let channel = this.channels.get(mode);
      if (!channel) {
        try { channel = this.openChannel(mode); }
        catch {
          if (this.supportedModes.has(mode)) { this.disconnect(subscription); return; }
          this.legacyModes.add(mode);
          this.openDirect(subscription);
          return;
        }
      }
      subscription.channel = channel;
      channel.subscriptions.set(subscription.id, subscription);
      if (channel.ready) this.subscribe(subscription);
      return;
    }
    if (message.type === 'negotiate') throw new Error('Remote session has already negotiated.');
    if (subscription.directReady) { subscription.direct!.send(message); return; }
    if (subscription.channel?.ready && subscription.subscribed) {
      this.write(subscription.channel, { protocolVersion: PROTOCOL_VERSION, type: 'message', subscriptionId: subscription.id, message });
      this.observe('outbound', message);
      return;
    }
    const bytes = utf8.encode(encoded.json).byteLength;
    if (subscription.queued.length >= SESSION_CHANNEL_MAX_PENDING_FRAMES
      || subscription.queuedBytes + bytes > SESSION_CHANNEL_MAX_FRAME_BYTES
      || this.pendingBytes + bytes > SESSION_CHANNEL_MAX_BUFFERED_BYTES) {
      this.disconnect(subscription);
      throw new Error('Remote session pending message limit reached.');
    }
    subscription.queued.push(message);
    subscription.queuedBytes += bytes;
    this.pendingBytes += bytes;
  }

  private openChannel(mode: Mode): Channel {
    const socket = this.dependencies.createSocket(mode);
    const channel: Channel = { mode, socket, subscriptions: new Map(), active: true, ready: false };
    this.channels.set(mode, channel);
    channel.readyTimer = setTimeout(() => this.failChannel(channel), 3000);
    socket.onopen = () => undefined;
    socket.onmessage = ({ data }) => {
      if (!channel.active) return;
      if (typeof data !== 'string' || utf8.encode(data).byteLength > SESSION_CHANNEL_MAX_FRAME_BYTES) {
        this.invalidBody(); this.failChannel(channel); return;
      }
      const decoded = decodeSessionChannelServerMessage(data);
      if (decoded.status === 'rejected') { this.invalidBody(); this.failChannel(channel); return; }
      const frame = decoded.value;
      if (frame.type === 'session_title_updated') { this.dependencies.onTitle?.(frame.session); return; }
      if (frame.type === 'session_migrated') { this.dependencies.onMigration?.(frame.migration); return; }
      if (frame.type === 'ready' && !channel.ready) {
        channel.ready = true;
        this.supportedModes.add(mode);
        clearTimeout(channel.readyTimer);
        channel.pingTimer = setInterval(() => {
          if (!channel.active || channel.pongTimer) return;
          channel.pongTimer = setTimeout(() => this.failChannel(channel, false), 10_000);
          try { this.write(channel, { protocolVersion: PROTOCOL_VERSION, type: 'ping' }); } catch { /* write retires the channel. */ }
        }, 30_000);
        for (const subscription of [...channel.subscriptions.values()]) this.subscribe(subscription);
      } else if (!channel.ready || frame.type === 'ready') {
        this.invalidBody(); this.failChannel(channel);
      } else if (frame.type === 'pong') {
        clearTimeout(channel.pongTimer);
        channel.pongTimer = undefined;
      } else {
        const subscription = channel.subscriptions.get(frame.subscriptionId);
        if (!subscription?.active) return;
        if (frame.type === 'closed') this.disconnect(subscription);
        else {
          this.observe('inbound', frame.message);
          subscription.listener.onMessage(frame.message);
        }
      }
    };
    socket.onclose = () => this.failChannel(channel);
    socket.onerror = () => {
      if (!channel.active) return;
      this.dependencies.diagnostic({ source: 'websocket', code: 'connection_failed', message: 'Relay WebSocket connection failed.', recoverable: true });
      this.failChannel(channel);
    };
    return channel;
  }

  private subscribe(subscription: Subscription): void {
    if (!subscription.active || subscription.subscribed) return;
    try {
      this.write(subscription.channel!, {
        protocolVersion: PROTOCOL_VERSION, type: 'subscribe', subscriptionId: subscription.id,
        agentId: subscription.agentId, message: subscription.negotiation!,
      });
      subscription.subscribed = true;
      this.observe('outbound', subscription.negotiation!);
      const queued = subscription.queued.splice(0);
      this.pendingBytes -= subscription.queuedBytes;
      subscription.queuedBytes = 0;
      for (const message of queued) this.send(subscription, message);
    } catch {
      this.disconnect(subscription);
    }
  }

  private openDirect(subscription: Subscription): void {
    subscription.channel = undefined;
    try {
      subscription.direct = this.dependencies.connectDirect(subscription.agentId, {
        onOpen: () => {
          if (!subscription.active) return;
          subscription.directReady = true;
          try {
            subscription.direct!.send(subscription.negotiation!);
            const queued = subscription.queued.splice(0);
            this.pendingBytes -= subscription.queuedBytes;
            subscription.queuedBytes = 0;
            for (const message of queued) {
              if (!subscription.active) break;
              subscription.direct!.send(message);
            }
          } catch { this.disconnect(subscription); }
        },
        onMessage: (message) => { if (subscription.active) subscription.listener.onMessage(message); },
        onDisconnect: () => this.disconnect(subscription),
      });
    } catch { this.disconnect(subscription); }
  }

  private failChannel(channel: Channel, allowFallback = true): void {
    if (!channel.active) return;
    const fallback = allowFallback && !channel.ready && !this.supportedModes.has(channel.mode) && !this.disposed;
    const subscriptions = [...channel.subscriptions.values()];
    this.stopChannel(channel);
    if (fallback) this.legacyModes.add(channel.mode);
    for (const subscription of subscriptions) {
      subscription.channel = undefined;
      if (fallback && subscription.active) this.openDirect(subscription);
      else this.disconnect(subscription);
    }
  }

  private stopChannel(channel: Channel): void {
    channel.active = false;
    if (this.channels.get(channel.mode) === channel) this.channels.delete(channel.mode);
    channel.subscriptions.clear();
    clearTimeout(channel.readyTimer);
    clearInterval(channel.pingTimer);
    clearTimeout(channel.pongTimer);
    channel.socket.onopen = null;
    channel.socket.onmessage = null;
    channel.socket.onclose = null;
    channel.socket.onerror = () => undefined;
    channel.socket.close();
  }

  private retire(subscription: Subscription): void {
    if (!subscription.active) return;
    subscription.active = false;
    this.subscriptions.delete(subscription);
    subscription.queued = [];
    this.pendingBytes -= subscription.queuedBytes;
    subscription.queuedBytes = 0;
    subscription.direct?.close();
    const channel = subscription.channel;
    if (!channel) return;
    channel.subscriptions.delete(subscription.id);
    if (channel.active && channel.ready && subscription.subscribed) {
      try { this.write(channel, { protocolVersion: PROTOCOL_VERSION, type: 'unsubscribe', subscriptionId: subscription.id }); }
      catch { /* write disconnects remaining subscriptions on this channel. */ }
    }
  }

  private disconnect(subscription: Subscription): void {
    if (!subscription.active) return;
    this.retire(subscription);
    subscription.listener.onDisconnect();
  }

  private write(channel: Channel, message: SessionChannelClientMessage): void {
    if (!channel.active || (channel.socket.readyState !== undefined && channel.socket.readyState !== 1)) {
      this.failChannel(channel, false);
      throw new Error('Remote WebSocket connection is closed.');
    }
    const encoded = encodeSessionChannelClientMessage(message);
    if (encoded.status === 'rejected') throw new Error('Session channel message was rejected by the public protocol.');
    const bytes = utf8.encode(encoded.json).byteLength;
    if (bytes > SESSION_CHANNEL_MAX_FRAME_BYTES || (channel.socket.bufferedAmount ?? 0) + bytes > SESSION_CHANNEL_MAX_BUFFERED_BYTES) {
      this.failChannel(channel, false);
      throw new Error('Remote session channel buffer limit reached.');
    }
    try { channel.socket.send(encoded.json); }
    catch (error) { this.failChannel(channel, false); throw error; }
  }

  private observe(direction: RemoteProtocolObservation['direction'], message: RemoteProtocolObservation['message']): void {
    this.dependencies.observe({ direction, channel: 'websocket', message });
  }

  private invalidBody(): void {
    this.dependencies.diagnostic({
      source: 'websocket', code: 'invalid_wire_body',
      message: 'Relay response was rejected by the public protocol.', recoverable: true,
    });
  }
}

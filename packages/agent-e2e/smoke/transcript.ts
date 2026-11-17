import type { Frame, Marker, MarkerName, Transcript, WireMessage } from './invariants/types.js';

/** A message the proxy teed from a WebSocket: the raw text of one session-channel frame. */
export interface TappedMessage { t: number; connection: number; direction: 'browser->relay' | 'relay->browser'; text: string }

/**
 * Turns one session-channel frame into the transcript frames it carries. A `message` frame yields its inner message with the
 * subscription id; `subscribe`, `unsubscribe`, `closed`, `intent`, `ready` and the state frames yield a frame of their own type
 * with the rest of the envelope as payload. Keep-alive frames carry nothing and yield none.
 */
export function decodeChannelFrame(tapped: TappedMessage, number: () => number): Frame[] {
  let outer: Record<string, any>;
  try { outer = JSON.parse(tapped.text); } catch { return []; }
  if (typeof outer?.type !== 'string' || outer.type === 'ping' || outer.type === 'pong') return [];
  const base = { t: tapped.t, connection: tapped.connection, direction: tapped.direction, ...(typeof outer.subscriptionId === 'number' ? { subscriptionId: outer.subscriptionId } : {}) };
  if (outer.type === 'message' && outer.message && typeof outer.message.type === 'string') return [{ n: number(), ...base, message: outer.message as WireMessage }];
  const { type, protocolVersion: _version, subscriptionId: _id, message: inner, ...rest } = outer;
  const frames: Frame[] = [{ n: number(), ...base, message: { type, payload: rest } }];
  if (type === 'subscribe' && inner && typeof inner.type === 'string') frames.push({ n: number(), ...base, message: { ...(inner as WireMessage), payload: { ...(inner.payload ?? {}), agentId: outer.agentId } } });
  return frames;
}

/** Collects what the proxy tees into one transcript, with the markers a scenario adds, numbered in the order they arrive. */
export class TranscriptRecorder {
  private readonly entries: Transcript = [];
  private count = 0;
  private readonly nextNumber = () => ++this.count;
  constructor(private readonly now: () => number = Date.now, private readonly origin = now()) {}

  /** Time on the run's clock. */
  clock(): number { return this.now() - this.origin; }

  tap = (tapped: TappedMessage): void => {
    for (const frame of decodeChannelFrame({ ...tapped, t: tapped.t - this.origin }, this.nextNumber)) this.entries.push(frame);
  };

  socket = (event: { t: number; connection: number; event: 'open' | 'close' }): void => {
    this.entries.push({ n: this.nextNumber(), t: event.t - this.origin, marker: event.event === 'open' ? 'socket-open' : 'socket-close', connection: event.connection });
  };

  mark(marker: MarkerName, detail?: Record<string, unknown>): Marker {
    const entry: Marker = { n: this.nextNumber(), t: this.clock(), marker, ...(detail ? { detail } : {}) };
    this.entries.push(entry);
    return entry;
  }

  transcript(): Transcript { return [...this.entries]; }
  /** One JSON object per line, for the run's directory. */
  toJsonLines(): string { return this.entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'; }
}

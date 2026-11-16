import { randomUUID } from 'node:crypto';

import {
  JOURNAL_FILL_MAX_ITEMS, REMOTE_HOST_UPLINK_VERSION,
  type AgentSnapshot, type AgentSnapshotPayload, type BackgroundActivity, type CompleteItemInput, type JournalPublishEntry, type JournalRelayMessage,
  type RemoteHostUplinkMessage, type ResourceBinding,
} from '@orchardworks/agent-remote-protocol';
import type { AgentJournalSubscription, AgentJournalTap, AgentManagerEvent } from '@orchardworks/agent-remote-relay';
import { rowItemKey, type CanonicalTimelineRow } from '@orchardworks/agent-remote-relay/timeline-projection';

import {
  blocksOf, chunkOps, digestOf, entryBytes, groupItems, isLiveOnlyRow, mergedRow, MESSAGE_BUDGET_BYTES, sizedItems, type PublishOp, type SizedOp, type TimelineItem,
} from './journal-items.js';
import { outcomeOps, rebindOps, windowOp } from './journal-reconcile.js';

/** What a publication needs from the agent manager of its session. */
export interface JournalSource {
  subscribeJournal(tap: AgentJournalTap): AgentJournalSubscription;
  timelineRows(): CanonicalTimelineRow[];
  itemRows(key: string): CanonicalTimelineRow[];
  attentionItemKey(): string | undefined;
  snapshot(): AgentSnapshot;
  loadOlderHistory(): Promise<{ added: number; more: boolean }>;
  hasOlderHistory(): boolean;
}

/** What the Controller records about its publishing. It carries no content. */
export interface JournalPublisherDiagnostic {
  event: 'journal_open_refused' | 'journal_publication_refused' | 'journal_row_rejected' | 'journal_message_unencodable' | 'journal_session_restarted'
    | 'journal_session_stopped' | 'journal_session_unserved';
  providerId: string;
  reason?: string;
}

export interface PublisherLimits {
  /** How long rows are collected before a publication. */
  batchWindowMs: number;
  /** How long the Relay has to answer a request before the session opens its journal again. */
  responseTimeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** How long a session must publish without restarting before its backoff starts over. */
  sustainedMs: number;
  /** The most events of the manager held while a session opens; past it the session opens again. */
  heldEventsMax: number;
  /** The most pages of older native history read to find the newest items when the first read holds none. */
  gapReadsMax: number;
  /** Bytes in flight across every session of the connection: the uplink buffers a bounded number and refuses a send past it. */
  inFlightBytes: number;
}

export const DEFAULT_PUBLISHER_LIMITS: PublisherLimits = {
  batchWindowMs: 50, responseTimeoutMs: 30_000, backoffBaseMs: 250, backoffMaxMs: 30_000, sustainedMs: 60_000, heldEventsMax: 10_000, gapReadsMax: 8,
  inFlightBytes: 16 * 1024 * 1024,
};

export interface PublicationContext {
  publisherId: string;
  limits: PublisherLimits;
  now(): number;
  /** Writes one message to the Relay: `offline` when no connection holds the grant, `unencodable` when the wire refuses it. */
  send(message: RemoteHostUplinkMessage, providerId: string): 'sent' | 'offline' | 'unencodable';
  /** Waits for room to have one more message of `bytes` in flight; the returned function gives the room back. */
  reserve(bytes: number): Promise<() => void>;
  diagnostic(entry: JournalPublisherDiagnostic): void;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(timer: unknown): void;
}

export interface SessionPublicationOptions {
  agentId: string;
  providerId: string;
  sessionKey: string;
  source: JournalSource;
  context: PublicationContext;
  /** The publication ended for good: the session closed or was released. */
  onFinished(): void;
}

type QueuedOp =
  | { kind: 'append'; key: string; rows: CanonicalTimelineRow[] }
  | { kind: 'complete'; key: string }
  | { kind: 'rebind'; key: string; previous: ResourceBinding; replacement: ResourceBinding }
  | { kind: 'outcome'; providerId: string; turnId?: string; background: BackgroundActivity; occurredAt: number };

type Phase = 'suspended' | 'opening' | 'live' | 'gave_up' | 'stopped';

interface Waiter { match(message: JournalRelayMessage): boolean; resolve(message: JournalRelayMessage): void; reject(error: Error): void; timer: unknown }

/** The Relay refused a publication, or the open: whatever the reason, the journal opens again and the window is sent again. */
class Refused extends Error {
  constructor(readonly reason: string, readonly event: 'journal_publication_refused' | 'journal_open_refused' = 'journal_publication_refused') { super(`The Relay refused a journal ${event === 'journal_open_refused' ? 'open' : 'publication'}: ${reason}.`); }
}
/** The work was overtaken: the session opened again, stopped, or lost its connection. */
class Cancelled extends Error {}
class TimedOut extends Error {}
/** The head cannot be put on the wire, so the journal could never show the session's state. */
class HeadRejected extends Error {}

const OLDER_READS_PER_REQUEST = 3;
/** The Relay has at most 32 requests open on a connection; these wait for the session to be live. */
const MAX_PENDING_REQUESTS = 32;
const pendingKey = (payload: AgentSnapshotPayload): string => payload.pendingInteractions.map(request => request.requestId).sort().join('\n');

/**
 * Publishes one session to its journal on the Relay, with at most 20 mutable fields and 6 recovery outcomes.
 *
 * Every open sends the newest window of the Controller's timeline, the outcomes and rebinds of the whole timeline, and the
 * head; the Relay decides whether the window continues its journal, extends it or replaces it. Then the session publishes
 * what it emits, one acknowledged message at a time. The agent manager's timeline is what the Controller knows to be
 * true, so anything the Relay refuses or the connection loses ends the same way: the journal opens again and the window
 * is sent again.
 *
 * Recovery outcomes: (1) reopen with backoff after any refusal, a refused open, a timeout, a lost connection, a held-event
 * overflow or an unencodable message; (2) reopen at once after the provider rebuilt its timeline; (3) a head that cannot be
 * encoded gives up and unserves; (4) a provider that breaks the identity contract gives up and unserves.
 */
export class SessionPublication {
  private phase: Phase = 'suspended';
  private cycle = 0;
  private subscription: AgentJournalSubscription | undefined;
  /** The journal's generation on this connection, once it was opened; 0 before. */
  private generation = 0;
  private connected = false;
  private sequence = 0;
  private waiter: Waiter | undefined;
  /** What the session emitted since the window was read; it is published after the head. Bounded by `heldEventsMax` while opening. */
  private queue: QueuedOp[] = [];
  private headDirty = false;
  private urgent = false;
  private headPending = '';
  private flushTimer: unknown;
  private retryTimer: unknown;
  private lane: Promise<void> = Promise.resolve();
  private restarts = 0;
  private liveSince: number | undefined;
  /** The provider broke the identity contract: this connection's journal is only unserved, never published. */
  private identityBreach = false;
  private rebuilding = false;
  private requests: Array<Extract<JournalRelayMessage, { type: 'journal_fill_request' | 'journal_older_request' }>> = [];
  /** Items the wire refuses; they stay out for as long as the session is followed. */
  private readonly skipped = new Set<string>();

  constructor(private readonly options: SessionPublicationOptions) {}

  private get context(): PublicationContext { return this.options.context; }
  private get limits(): PublisherLimits { return this.options.context.limits; }
  private get source(): JournalSource { return this.options.source; }

  /** The agent manager this publication follows. */
  get followed(): JournalSource { return this.options.source; }

  /** Whether a request of the Relay can be answered soon: the journal is live, or was opened in this cycle and is being sent. */
  get requestable(): boolean { return this.phase === 'live' || (this.phase === 'opening' && this.generation > 0); }

  /** A connection holds the grant, or the session was just attached: open the journal. A connection that replaces another opens it again, because the Relay forgot what the earlier one opened. */
  resume(): void {
    if (this.phase === 'stopped') return;
    this.connected = true;
    if (this.identityBreach) {
      this.cycle += 1;
      this.teardown();
      this.phase = 'gave_up';
      this.unserveOnOpen();
      return;
    }
    this.restart(0, undefined, false);
  }

  /** The connection ended. The session opens its journal again when a connection returns. */
  suspend(): void {
    if (this.phase === 'stopped') return;
    this.connected = false;
    this.cycle += 1;
    this.teardown();
    if (this.phase !== 'gave_up') this.phase = 'suspended';
  }

  /** The session is no longer followed. */
  stop(): void {
    if (this.phase === 'stopped') return;
    this.cycle += 1;
    this.teardown();
    this.phase = 'stopped';
    this.options.onFinished();
  }

  /** Publishes what is queued, giving up after `timeoutMs`. */
  async drain(timeoutMs: number): Promise<void> {
    if (this.phase !== 'live') return;
    const token = this.cycle;
    this.urgent = true;
    let timer: unknown;
    const expired = new Promise<void>(resolve => { timer = this.context.schedule(resolve, timeoutMs); });
    const flushed = new Promise<void>(resolve => this.enqueue(() => this.flush(token).finally(resolve)));
    await Promise.race([flushed, expired]);
    this.context.cancel(timer);
  }

  /** A message of the Relay about this session. */
  receive(message: JournalRelayMessage): void {
    if (message.type === 'journal_refused') {
      if (this.generation === 0 || message.generation !== this.generation || this.phase === 'stopped') return;
      const refusal = new Refused(message.reason);
      if (!this.rejectWaiter(refusal)) this.recover(this.cycle, refusal);
      return;
    }
    if (message.type === 'journal_fill_request' || message.type === 'journal_older_request') {
      if (this.phase === 'stopped') return;
      // A request that does not fit is refused at once: the Relay waits for each one.
      if (this.requests.length >= MAX_PENDING_REQUESTS) this.refuse(this.requests.shift()!);
      this.requests.push(message);
      this.serveRequests();
      return;
    }
    const waiter = this.waiter;
    if (waiter?.match(message)) {
      this.waiter = undefined;
      this.context.cancel(waiter.timer);
      waiter.resolve(message);
    }
  }

  // Cycles: open, send the window, go live.

  private restart(delayMs: number, reason: string | undefined, counted: boolean): void {
    if (this.phase === 'stopped') return;
    const token = ++this.cycle;
    this.teardown();
    this.phase = 'opening';
    this.liveSince = undefined;
    if (counted) this.restarts += 1;
    if (reason !== undefined) this.context.diagnostic({ event: 'journal_session_restarted', providerId: this.options.providerId, reason });
    this.retryTimer = this.context.schedule(() => { this.retryTimer = undefined; this.enqueue(() => this.run(token)); }, delayMs);
  }

  /** The wait before opening again after a failure; it grows with failures that came close together and starts over after a sustained run. */
  private backoffDelay(): number {
    if (this.liveSince !== undefined && this.context.now() - this.liveSince >= this.limits.sustainedMs) this.restarts = 0;
    return Math.min(this.limits.backoffMaxMs, this.limits.backoffBaseMs * 2 ** this.restarts);
  }

  /** The Relay waits for an answer to each request; those this cycle can no longer answer are refused at once. */
  private refuseRequests(): void {
    for (const request of this.requests.splice(0)) this.refuse(request);
  }

  private refuse(request: (typeof this.requests)[number]): void {
    this.context.send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_request_refused', requestId: request.requestId, sessionKey: request.sessionKey, reason: 'not_ready' }, this.options.providerId);
  }

  private teardown(): void {
    this.refuseRequests();
    this.subscription?.release();
    this.subscription = undefined;
    this.rejectWaiter(new Cancelled());
    if (this.flushTimer !== undefined) this.context.cancel(this.flushTimer);
    if (this.retryTimer !== undefined) this.context.cancel(this.retryTimer);
    this.flushTimer = undefined;
    this.retryTimer = undefined;
    this.queue.length = 0;
    this.headDirty = false;
    this.urgent = false;
    this.rebuilding = false;
    this.generation = 0;
  }

  private enqueue(task: () => Promise<void>): void {
    this.lane = this.lane.then(task).catch(() => undefined);
  }

  /** Runs the publishing part of a request in the lane, and settles with its outcome. Reads of native history stay outside the lane, so they never delay a head. */
  private inLane(token: number, task: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => this.enqueue(async () => {
      try { this.check(token); await task(); resolve(); } catch (error) { reject(error); }
    }));
  }
  private check(token: number): void {
    if (token !== this.cycle) throw new Cancelled();
  }

  private async run(token: number): Promise<void> {
    if (token !== this.cycle) return;
    try {
      await this.publishWindow(token);
    } catch (error) {
      this.recover(token, error);
    }
  }

  /** Opens the journal, sends the newest window, the outcomes and rebinds of the whole timeline and the head, and goes live. */
  private async publishWindow(token: number): Promise<void> {
    const subscription = this.source.subscribeJournal({ event: event => this.onEvent(token, event), closed: () => this.onClosed(token), identityMissing: () => this.onIdentityMissing(token) });
    this.subscription = subscription;
    // A manager that already broke the identity contract says so in the next tick; the journal is not opened for a session that is given up.
    await Promise.resolve();
    this.check(token);
    await this.open(token);
    this.check(token);
    // Rows above this one reach the session as events; a reread that reaches them would publish them twice.
    const lastSeq = subscription.rows[subscription.rows.length - 1]?.seq ?? 0;
    let rows = subscription.rows;
    let timeline = this.sendable(rows);
    let window = await windowOp(timeline);
    // An empty window replaces the journal with nothing: while native history may hold older pages, they are read first.
    for (let reads = 0; window.count === 0 && reads < this.limits.gapReadsMax && this.source.hasOlderHistory(); reads += 1) {
      await this.source.loadOlderHistory();
      this.check(token);
      rows = this.source.timelineRows().filter(row => row.seq <= lastSeq);
      timeline = this.sendable(rows);
      window = await windowOp(timeline);
    }
    this.check(token);
    for (const key of window.refused) this.skip(key);
    const items = timeline.filter(item => !this.skipped.has(item.key));
    const sendWindow = window.count > 0 || !this.source.hasOlderHistory();
    const ops = [...(sendWindow ? [window.op] : []), ...outcomeOps(items), ...rebindOps(items), this.takeHead()];
    for (const chunk of chunkOps(ops)) await this.publish(token, chunk);
    this.check(token);
    this.goLive();
  }

  private goLive(): void {
    this.phase = 'live';
    this.liveSince = this.context.now();
    this.scheduleFlush();
    this.serveRequests();
  }

  /** Opens the journal: the Relay answers with the generation to publish under and the watermark to number from. */
  private async open(token: number): Promise<void> {
    const requestId = randomUUID();
    const reply = await this.ask(token, { uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_open', requestId, sessionKey: this.options.sessionKey, publisherId: this.context.publisherId },
      message => (message.type === 'journal_opened' || message.type === 'journal_open_refused') && message.requestId === requestId);
    if (reply.type !== 'journal_opened') throw new Refused(reply.type === 'journal_open_refused' ? reply.reason : 'unexpected', 'journal_open_refused');
    this.generation = reply.generation;
    this.sequence = reply.watermark;
  }

  /** The items of the rows that the wire has not refused. */
  private sendable(rows: readonly CanonicalTimelineRow[]): TimelineItem[] {
    return groupItems(rows).filter(item => !this.skipped.has(item.key));
  }

  /** Leaves an item out for as long as the session is followed, and records it once. */
  private skip(key: string): void {
    if (this.skipped.has(key)) return;
    this.skipped.add(key);
    this.context.diagnostic({ event: 'journal_row_rejected', providerId: this.options.providerId });
  }

  // Messages and answers.

  private expect(token: number, match: (message: JournalRelayMessage) => boolean): Promise<JournalRelayMessage> {
    return new Promise((resolve, reject) => {
      if (token !== this.cycle) { reject(new Cancelled()); return; }
      const timer = this.context.schedule(() => { this.waiter = undefined; reject(new TimedOut('The Relay did not answer in time.')); }, this.limits.responseTimeoutMs);
      this.waiter = { match, resolve, reject, timer };
    });
  }

  private rejectWaiter(error: Error): boolean {
    const waiter = this.waiter;
    if (!waiter) return false;
    this.waiter = undefined;
    this.context.cancel(waiter.timer);
    waiter.reject(error);
    return true;
  }

  private async ask(token: number, message: RemoteHostUplinkMessage, match: (message: JournalRelayMessage) => boolean): Promise<JournalRelayMessage> {
    const reply = this.expect(token, match);
    const sent = this.context.send(message, this.options.providerId);
    if (sent !== 'sent') this.rejectWaiter(sent === 'offline' ? new Cancelled() : new Refused('unencodable'));
    return reply;
  }

  /** Numbers the entries after the last publication, sends them and waits until the Relay's store holds them. */
  private async publish(token: number, chunk: { ops: PublishOp[]; bytes: number }): Promise<void> {
    const release = await this.context.reserve(chunk.bytes);
    try {
      this.check(token);
      const first = this.sequence + 1;
      const entries = chunk.ops.map((op, at) => ({ sequence: first + at, ...op }) as JournalPublishEntry);
      const last = first + chunk.ops.length - 1;
      const generation = this.generation;
      await this.ask(token, { uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_publish', sessionKey: this.options.sessionKey, generation, entries },
        message => message.type === 'journal_ack' && message.generation === generation && message.watermark >= last);
      this.sequence = last;
    } finally {
      release();
    }
  }

  // Recovery.

  private recover(token: number, error: unknown): void {
    if (token !== this.cycle || error instanceof Cancelled) return;
    if (error instanceof HeadRejected) { this.giveUp('head_rejected'); return; }
    const reason = error instanceof Refused ? error.reason : error instanceof TimedOut ? 'timeout' : 'failure';
    if (error instanceof Refused) this.context.diagnostic({ event: error.event, providerId: this.options.providerId, reason: error.reason });
    this.restart(this.backoffDelay(), error instanceof Refused ? undefined : reason, true);
  }

  /** Tells the Relay to stop serving this session's journal, which this Controller can no longer keep current. */
  private sendUnserve(reason: string, generation: number): void {
    if (generation < 1) return;
    const sent = this.context.send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_unserve', sessionKey: this.options.sessionKey, generation }, this.options.providerId);
    if (sent === 'sent') this.context.diagnostic({ event: 'journal_session_unserved', providerId: this.options.providerId, reason });
  }

  /**
   * The session cannot be published any more: the Relay stops serving its journal, and nothing more of it is published
   * until a connection returns. When the journal was not opened on this connection yet, the unserve waits for the first
   * open, because a head an earlier connection published would otherwise stay served.
   */
  private giveUp(reason: string): void {
    if (this.phase === 'stopped') return;
    this.context.diagnostic({ event: 'journal_session_stopped', providerId: this.options.providerId, reason });
    const generation = this.generation;
    this.cycle += 1;
    this.teardown();
    this.phase = 'gave_up';
    if (generation >= 1) this.sendUnserve(reason, generation);
    else {
      this.identityBreach = true;
      if (this.connected) this.unserveOnOpen();
    }
  }

  /** Opens the journal only to say, with the generation it gets, that it is not to be served. */
  private unserveOnOpen(): void {
    const token = this.cycle;
    this.enqueue(async () => {
      if (token !== this.cycle) return;
      try {
        const requestId = randomUUID();
        const reply = await this.ask(token, { uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_open', requestId, sessionKey: this.options.sessionKey, publisherId: this.context.publisherId },
          message => (message.type === 'journal_opened' || message.type === 'journal_open_refused') && message.requestId === requestId);
        if (reply.type === 'journal_opened') this.sendUnserve('identity_missing', reply.generation);
      } catch { /* The connection ended or the Relay did not answer; the next connection says it again. */ }
    });
  }

  // Live publishing.

  private onEvent(token: number, event: AgentManagerEvent): void {
    if (token !== this.cycle || (this.phase !== 'opening' && this.phase !== 'live')) return;
    if (this.phase === 'opening' && this.queue.length >= this.limits.heldEventsMax) { this.restart(this.backoffDelay(), 'held_events', true); return; }
    this.apply(event);
  }

  /** The manager closed, or dropped this tap: it is not followed any more until it is attached again. */
  private onClosed(token: number): void {
    if (token === this.cycle) this.stop();
  }

  /** The provider broke the identity contract: the journal would hold keys no reread can match, so it is not kept at all. */
  private onIdentityMissing(token: number): void {
    if (token === this.cycle) this.giveUp('identity_missing');
  }

  private apply(event: AgentManagerEvent): void {
    switch (event.type) {
      case 'agent_state':
        this.headDirty = true;
        if (pendingKey(event.snapshot.payload) !== this.headPending) this.urgent = true;
        break;
      case 'agent_stream': {
        const inner = event.event;
        if (inner.type === 'timeline') {
          if (event.row && !this.rebuilding) this.pushRow(event.row);
        } else if (inner.type === 'background_activity_updated') {
          const at = Date.parse(event.timestamp);
          this.queue.push({ kind: 'outcome', providerId: inner.provider, ...(inner.turnId === undefined ? {} : { turnId: inner.turnId }), background: inner.background, occurredAt: Number.isFinite(at) ? at : this.context.now() });
        }
        // The other events of the session wire change the Snapshot, and the head carries it.
        break;
      }
      case 'timeline_resource_binding_replaced':
        if (!this.rebuilding) this.queue.push({ kind: 'rebind', key: event.itemKey, previous: event.previous, replacement: event.replacement });
        break;
      case 'timeline_replacement':
        this.rebuilding = true;
        this.queue.length = 0;
        break;
      case 'timeline_rebuilt':
        this.restart(0, undefined, false);
        return;
      default:
        return;
    }
    this.scheduleFlush();
  }

  private pushRow(row: CanonicalTimelineRow): void {
    const key = rowItemKey(row);
    const last = this.queue[this.queue.length - 1];
    if (last?.kind === 'append' && last.key === key) last.rows.push(row);
    else this.queue.push({ kind: 'append', key, rows: [row] });
    if (row.identity === undefined || row.identity.completes === true) this.queue.push({ kind: 'complete', key });
  }

  private scheduleFlush(): void {
    if (this.phase !== 'live' || (this.queue.length === 0 && !this.headDirty)) return;
    if (this.flushTimer !== undefined) {
      if (!this.urgent) return;
      this.context.cancel(this.flushTimer);
    }
    const token = this.cycle;
    this.flushTimer = this.context.schedule(() => { this.flushTimer = undefined; this.enqueue(() => this.flush(token)); }, this.urgent ? 0 : this.limits.batchWindowMs);
  }

  private async flush(token: number): Promise<void> {
    try {
      await this.flushLive(token);
    } catch (error) {
      this.recover(token, error);
    }
  }

  /** Publishes everything queued, and the head when it changed, until nothing is left. */
  private async flushLive(token: number): Promise<void> {
    while (token === this.cycle && this.phase === 'live' && (this.queue.length > 0 || this.headDirty)) {
      const queued = this.queue.splice(0);
      const head = this.headDirty ? this.takeHead() : undefined;
      const ops = await this.materialize(queued);
      if (head) ops.push(head);
      for (const chunk of chunkOps(ops)) await this.publish(token, chunk);
    }
  }

  /** The Snapshot as the head, taken now, with the item its attention cursor points at; the head is no longer dirty. A head the wire refuses ends the session's publishing. */
  private takeHead(): SizedOp {
    const snapshot = this.source.snapshot().payload;
    const attentionItemKey = this.source.attentionItemKey();
    const op: PublishOp = { op: 'head', head: { snapshot, observedAt: this.context.now(), ...(attentionItemKey === undefined ? {} : { attentionItemKey }) } };
    const bytes = entryBytes(op);
    if (bytes === undefined) {
      this.context.diagnostic({ event: 'journal_row_rejected', providerId: this.options.providerId, reason: 'head' });
      throw new HeadRejected('The Snapshot cannot be published.');
    }
    this.headDirty = false;
    this.urgent = false;
    this.headPending = pendingKey(snapshot);
    return { op, bytes };
  }

  /** Turns queued changes into entries, measuring every one against the wire first. */
  private async materialize(queued: readonly QueuedOp[]): Promise<SizedOp[]> {
    const out: SizedOp[] = [];
    const add = (op: PublishOp, key?: string): void => {
      const bytes = entryBytes(op);
      if (bytes !== undefined) out.push({ op, bytes });
      else if (key !== undefined) this.skip(key);
    };
    for (const change of queued) {
      switch (change.kind) {
        case 'append':
          if (!this.skipped.has(change.key)) add({ op: 'append', row: mergedRow({ key: change.key, rows: change.rows, complete: false, liveOnly: change.rows.some(isLiveOnlyRow) }) }, change.key);
          break;
        case 'complete': {
          if (this.skipped.has(change.key)) break;
          const item = groupItems(this.source.itemRows(change.key))[0];
          if (item) add({ op: 'complete', itemKey: change.key, digest: await digestOf(item) }, change.key);
          break;
        }
        case 'rebind':
          if (!this.skipped.has(change.key)) add({ op: 'rebind', itemKey: change.key, previous: change.previous, replacement: change.replacement });
          break;
        case 'outcome':
          add({ op: 'outcome', providerId: change.providerId, ...(change.turnId === undefined ? {} : { turnId: change.turnId }), background: change.background, occurredAt: change.occurredAt });
          break;
      }
    }
    return out;
  }

  // Requests of the Relay.

  private serveRequests(): void {
    // The requests that arrived while the window was sent wait for the session to be live.
    if (this.phase !== 'live') return;
    const token = this.cycle;
    for (const request of this.requests.splice(0)) void this.answer(token, request);
  }

  private async answer(token: number, request: (typeof this.requests)[number]): Promise<void> {
    try {
      if (request.type === 'journal_older_request') await this.answerOlder(token, request);
      else await this.answerFill(token, request);
    } catch (error) {
      // The Relay waits for an answer; one it will not get is refused at once instead of at its deadline.
      this.refuse(request);
      this.recover(token, error);
    }
  }

  /** Publishes the complete items older than the journal's oldest in the manager's timeline, reading further native history when it has too few. */
  private async answerOlder(token: number, request: Extract<JournalRelayMessage, { type: 'journal_older_request' }>): Promise<void> {
    this.check(token);
    const older = (): TimelineItem[] => {
      const items = this.sendable(this.source.timelineRows());
      const anchor = items.findIndex(item => item.key === request.beforeItemKey);
      return anchor <= 0 ? [] : items.slice(0, anchor).filter(item => item.complete);
    };
    let candidates = older();
    for (let reads = 0; candidates.length < request.limit && reads < OLDER_READS_PER_REQUEST && this.source.hasOlderHistory(); reads += 1) {
      const loaded = await this.source.loadOlderHistory().catch(() => ({ added: 0, more: false }));
      this.check(token);
      candidates = older();
      if (loaded.added === 0) break;
    }
    const take = candidates.slice(-request.limit);
    const { accepted, refused } = await sizedItems(take, digestOf);
    for (const key of refused) this.skip(key);
    const ops: SizedOp[] = [];
    for (const block of blocksOf(accepted).reverse()) {
      const op: PublishOp = { op: 'prepend', items: block };
      ops.push({ op, bytes: entryBytes(op) ?? MESSAGE_BUDGET_BYTES });
    }
    await this.inLane(token, async () => {
      // One prepend to a message: a Relay that refuses one for its quota applies nothing of it, so the numbering stays where it was.
      let ended = false;
      for (const prepend of ops) {
        await this.flushLive(token);
        try { await this.publish(token, { ops: [prepend.op], bytes: prepend.bytes }); }
        catch (error) {
          // A quota refusal of older history leaves the journal whole: it only has no room for more history, and the session stays served.
          if (!(error instanceof Refused) || error.reason !== 'quota_exceeded') throw error;
          ended = true;
          break;
        }
      }
      if (!ended) {
        // What settled after the items were read arrived as a rebind or an outcome before the journal held them, which passes them over.
        const restated = groupItems(accepted.flatMap(({ item }) => this.source.itemRows(item.row.itemKey)));
        for (const chunk of chunkOps([...outcomeOps(restated), ...rebindOps(restated)])) await this.publish(token, chunk);
      }
      this.check(token);
      this.context.send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_older_done', requestId: request.requestId, sessionKey: this.options.sessionKey,
        olderAvailable: !ended && (candidates.length > take.length || this.source.hasOlderHistory()) }, this.options.providerId);
    });
  }

  /** Answers a fill with the bodies of the items it can find, in the order asked, as many as fit one message; the answer takes room in flight like a publication. */
  private async answerFill(token: number, request: Extract<JournalRelayMessage, { type: 'journal_fill_request' }>): Promise<void> {
    this.check(token);
    const wanted = new Set(request.itemKeys.slice(0, JOURNAL_FILL_MAX_ITEMS));
    const found = (): TimelineItem[] => this.sendable(this.source.timelineRows()).filter(item => wanted.has(item.key) && item.complete);
    let items = found();
    for (let reads = 0; items.length < wanted.size && reads < OLDER_READS_PER_REQUEST && this.source.hasOlderHistory(); reads += 1) {
      const loaded = await this.source.loadOlderHistory().catch(() => ({ added: 0, more: false }));
      this.check(token);
      items = found();
      if (loaded.added === 0) break;
    }
    const { accepted } = await sizedItems(items, digestOf);
    const fitting: CompleteItemInput[] = [];
    let bytes = 0;
    for (const sized of accepted) {
      if (sized.item.digest === undefined) continue;
      if (fitting.length > 0 && bytes + sized.bytes > MESSAGE_BUDGET_BYTES) break;
      fitting.push({ row: sized.item.row, digest: sized.item.digest });
      bytes += sized.bytes;
    }
    const release = await this.context.reserve(bytes);
    try {
      this.context.send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_fill', requestId: request.requestId, sessionKey: this.options.sessionKey, items: fitting }, this.options.providerId);
    } finally {
      release();
    }
  }
}

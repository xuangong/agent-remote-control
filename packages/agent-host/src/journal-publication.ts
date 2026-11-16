import { randomUUID } from 'node:crypto';

import { itemDigest, type JournalIndexEntry } from '@orchardworks/agent-remote-journal';
import {
  JOURNAL_FILL_MAX_ITEMS, REMOTE_HOST_UPLINK_VERSION,
  type AgentSnapshot, type AgentSnapshotPayload, type BackgroundActivity, type CompleteItemInput, type JournalPublishEntry, type JournalRelayMessage,
  type RemoteHostUplinkMessage, type ResourceBinding,
} from '@orchardworks/agent-remote-protocol';
import type { AgentJournalSubscription, AgentJournalTap, AgentManagerEvent } from '@orchardworks/agent-remote-relay';
import { rowItemKey, type CanonicalTimelineRow } from '@orchardworks/agent-remote-relay/timeline-projection';

import {
  blocksOf, chunkOps, entryBytes, groupItems, isLiveOnlyRow, mergedRow, MESSAGE_BUDGET_BYTES, sizedItems, type PublishOp, type SizedOp, type TimelineItem,
} from './journal-items.js';
import { planPublication, replacementPlan, type PublicationPlan } from './journal-reconcile.js';

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
    | 'journal_replacement_published' | 'journal_quota_window' | 'journal_session_stopped' | 'journal_session_unserved';
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
  /** The most events of the manager held while a session reconciles; past it the session reconciles again. */
  heldEventsMax: number;
  /** The most pages of older native history read to find where the journal and the timeline meet. */
  gapReadsMax: number;
  /** The newest items kept by each narrower replacement after a quota refusal, widest first. */
  quotaWindows: readonly number[];
  /** Bytes in flight across every session of the connection: the uplink buffers a bounded number and refuses a send past it. */
  inFlightBytes: number;
}

export const DEFAULT_PUBLISHER_LIMITS: PublisherLimits = {
  batchWindowMs: 50, responseTimeoutMs: 30_000, backoffBaseMs: 250, backoffMaxMs: 30_000, sustainedMs: 60_000, heldEventsMax: 10_000, gapReadsMax: 8,
  quotaWindows: [2000, 200, 20], inFlightBytes: 16 * 1024 * 1024,
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

type Phase = 'suspended' | 'opening' | 'live' | 'refused' | 'gave_up' | 'stopped';

interface Waiter { kind: 'publish' | 'other'; match(message: JournalRelayMessage): boolean; resolve(message: JournalRelayMessage): void; reject(error: Error): void; timer: unknown }

/** The Relay refused a publication at `sequence`. `carriedPrepend` says the refused message held older history. */
class Refused extends Error {
  carriedPrepend = false;
  constructor(readonly reason: string, readonly itemKey?: string, readonly sequence?: number) { super(`The Relay refused a journal publication: ${reason}.`); }
}
/** The Relay could not open the journal. */
class OpenRefused extends Error { constructor(readonly reason: string) { super(`The Relay refused to open the journal: ${reason}.`); } }
/** The work was overtaken: the session opened again, stopped, or lost its connection. */
class Cancelled extends Error {}
class TimedOut extends Error {}
/** The journal moved under the publication; it opens again at once. */
class Reopen extends Error { constructor(readonly reason: string) { super(reason); } }
/** The head cannot be put on the wire, so the journal could never show the session's state. */
class HeadRejected extends Error {}

const MAX_INDEX_PAGES = 200;
const MAX_REPLACEMENTS_IN_A_ROW = 3;
/** Rebinds sent and not yet acknowledged that are kept across cycles. */
const MAX_UNACKNOWLEDGED_REBINDS = 1000;
const OLDER_READS_PER_REQUEST = 3;
/** The Relay has at most 32 requests open on a connection; these wait for the session to be live. */
const MAX_PENDING_REQUESTS = 32;
/** Refusals about one item: the item is left out and the rest of the publication is sent again, instead of opening the journal again. */
const ITEM_REFUSALS: ReadonlySet<string> = new Set(['unknown_item', 'body_missing', 'type_changed', 'duplicate_item', 'invalid']);
const pendingKey = (payload: AgentSnapshotPayload): string => payload.pendingInteractions.map(request => request.requestId).sort().join('\n');
const rebindKey = (itemKey: string, binding: ResourceBinding): string => `${itemKey}\n${binding.locator}\n${binding.resourceId}\n${binding.status}`;
const opItemKey = (op: PublishOp): string | undefined => op.op === 'append' || op.op === 'correct' ? op.row.itemKey
  : op.op === 'complete' || op.op === 'seal' || op.op === 'rebind' || op.op === 'alias' ? op.itemKey : undefined;

/** Whether the entry is about the item: it carries the item's rows or is made of its key. */
const namesItem = (op: PublishOp, itemKey: string): boolean =>
  opItemKey(op) === itemKey || ((op.op === 'replace' || op.op === 'prepend') && op.items.some(({ row }) => row.itemKey === itemKey));

/** The entry without the item the Relay refused, or undefined when it holds no more items or does not hold that one. */
function withoutItem(op: PublishOp, itemKey: string): PublishOp | undefined {
  if (op.op !== 'replace' && op.op !== 'prepend') return undefined;
  const items = op.items.filter(({ row }) => row.itemKey !== itemKey);
  return items.length > 0 && items.length < op.items.length ? { ...op, items } : undefined;
}

/**
 * Publishes one session to its journal on the Relay: opens it, reconciles it with the Controller's timeline, and then
 * publishes what the session emits, one acknowledged message at a time. Everything that can go wrong ends in opening the
 * journal again, because the agent manager's timeline is what the Controller knows to be true; what cannot be mended ends
 * in telling the Relay to stop serving the journal, which would otherwise show a session that no longer moves.
 */
export class SessionPublication {
  private phase: Phase = 'suspended';
  private cycle = 0;
  private subscription: AgentJournalSubscription | undefined;
  /** The journal's generation on this connection, once it was opened; 0 before. */
  private generation = 0;
  private openedInCycle = false;
  private connected = false;
  private sequence = 0;
  private journalKeys = new Set<string>();
  private waiter: Waiter | undefined;
  private held: AgentManagerEvent[] = [];
  /** A head change arrived while the session reconciled; the head is read when the session goes live, not kept. */
  private heldHeadDirty = false;
  private queue: QueuedOp[] = [];
  private headDirty = false;
  private urgent = false;
  private headPending = '';
  private flushTimer: unknown;
  private retryTimer: unknown;
  private tasks = 0;
  private lane: Promise<void> = Promise.resolve();
  private restarts = 0;
  private liveSince: number | undefined;
  private quotaStep = 0;
  private forceReplace = false;
  /** The Relay refused to open a journal whose index is too large: opens ask for no index until a replacement is stored. */
  private resetOpen = false;
  private replaceStreak = 0;
  private incompleteStreak = 0;
  /** The provider broke the identity contract: this connection's journal is only unserved, never published. */
  private identityBreach = false;
  private rebuilding = false;
  /** A prepend was refused by the quota, or a quota window applies: older history is not published any more. */
  private olderBlocked = false;
  /** Whether the session is in the middle of a cycle's reconcile, which answers requests itself between blocks of older history. */
  private reconciling = false;
  /** Rebinds the manager told and the Relay has not acknowledged; a cycle that ends first sends them again. */
  private readonly unacknowledgedRebinds = new Map<string, Extract<QueuedOp, { kind: 'rebind' }>>();
  /** Items the wire refused; they stay out for as long as the session is followed. */
  private readonly skipped = new Set<string>();
  /** Items a publication refused, with the last row they had; they stay out until a row of theirs changes or a connection returns. */
  private readonly refusedItems = new Map<string, number>();
  /** Whether the wire accepts an item as it stands, by its last row, so reconciling measures an item once. */
  private readonly checked = new Map<string, { lastSeq: number }>();
  private readonly digests = new Map<string, { lastSeq: number; digest: string }>();
  private digestEpoch = '';
  private requests: Array<Extract<JournalRelayMessage, { type: 'journal_fill_request' | 'journal_older_request' }>> = [];
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly options: SessionPublicationOptions) {}

  private get context(): PublicationContext { return this.options.context; }
  private get limits(): PublisherLimits { return this.options.context.limits; }
  private get source(): JournalSource { return this.options.source; }

  /** The agent manager this publication follows. */
  get followed(): JournalSource { return this.options.source; }

  /** Whether a request of the Relay can be answered soon: the journal is live, or was opened in this cycle and is being reconciled. */
  get requestable(): boolean { return this.phase === 'live' || (this.phase === 'opening' && this.openedInCycle); }

  /** A connection holds the grant, or the session was just attached: open the journal. A connection that replaces another opens it again, because the Relay forgot what the earlier one opened. */
  resume(): void {
    if (this.phase === 'stopped') return;
    this.connected = true;
    this.generation = 0;
    this.refusedItems.clear();
    if (this.phase === 'gave_up' || this.phase === 'refused') {
      this.quotaStep = 0;
      this.forceReplace = false;
      this.resetOpen = false;
      this.olderBlocked = false;
      this.replaceStreak = 0;
      this.incompleteStreak = 0;
    }
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
    this.generation = 0;
    if (this.phase !== 'gave_up' && this.phase !== 'refused') this.phase = 'suspended';
    this.signalIdle();
  }

  /** The session is no longer followed. */
  stop(): void {
    if (this.phase === 'stopped') return;
    this.cycle += 1;
    this.teardown();
    this.phase = 'stopped';
    this.signalIdle();
    this.options.onFinished();
  }

  /** Publishes what is queued, giving up after `timeoutMs`. */
  async drain(timeoutMs: number): Promise<void> {
    if (this.phase !== 'live') return;
    this.urgent = true;
    this.scheduleFlush();
    await new Promise<void>(resolve => {
      const timer = this.context.schedule(resolve, timeoutMs);
      const check = (): void => {
        if (this.isIdle()) { this.context.cancel(timer); resolve(); } else this.idleWaiters.push(check);
      };
      check();
    });
  }

  private isIdle(): boolean {
    return this.phase !== 'live' || (this.tasks === 0 && this.queue.length === 0 && !this.headDirty);
  }

  private signalIdle(): void {
    for (const waiter of this.idleWaiters.splice(0)) waiter();
  }

  /** A message of the Relay about this session. */
  receive(message: JournalRelayMessage): void {
    if (message.type === 'journal_refused') {
      if (!this.openedInCycle || message.generation !== this.generation || this.phase === 'stopped') return;
      const refusal = new Refused(message.reason, message.itemKey, message.sequence);
      if (this.waiter && this.waiter.kind !== 'publish') return;
      if (!this.rejectWaiter(refusal)) this.recover(this.cycle, refusal);
      return;
    }
    if (message.type === 'journal_fill_request' || message.type === 'journal_older_request') {
      if (this.phase === 'stopped') return;
      if (this.requests.length >= MAX_PENDING_REQUESTS) this.requests.shift();
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

  // Cycles: open, reconcile, go live.

  private restart(delayMs: number, reason: string | undefined, counted: boolean): void {
    if (this.phase === 'stopped') return;
    const token = ++this.cycle;
    this.teardown();
    this.phase = 'opening';
    this.openedInCycle = false;
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
    for (const request of this.requests.splice(0)) {
      this.context.send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_request_refused', requestId: request.requestId, sessionKey: request.sessionKey, reason: 'not_ready' }, this.options.providerId);
    }
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
    this.held.length = 0;
    this.heldHeadDirty = false;
    this.headDirty = false;
    this.urgent = false;
    this.rebuilding = false;
  }

  private enqueue(task: () => Promise<void>): void {
    this.tasks += 1;
    this.lane = this.lane.then(task).catch(() => undefined).finally(() => { this.tasks -= 1; this.signalIdle(); });
  }

  private async run(token: number): Promise<void> {
    if (token !== this.cycle) return;
    this.reconciling = true;
    try {
      await this.reconcile(token);
    } catch (error) {
      this.recover(token, error);
    } finally {
      this.reconciling = false;
      this.serveRequests();
    }
  }

  private check(token: number): void {
    if (token !== this.cycle) throw new Cancelled();
  }

  private async reconcile(token: number): Promise<void> {
    const subscription = this.source.subscribeJournal({ event: event => this.onEvent(token, event), closed: () => this.onClosed(token), identityMissing: () => this.onIdentityMissing(token) });
    this.subscription = subscription;
    // A manager that already broke the identity contract says so in the next tick; the journal is not opened for a session that is given up.
    await Promise.resolve();
    this.check(token);
    const opened = await this.open(token);
    this.check(token);
    // Rows above this one reach the session as events; a reread that reaches them would publish them twice.
    const lastSeq = subscription.rows[subscription.rows.length - 1]?.seq ?? 0;
    let rows = subscription.rows;
    // A forced replacement of nothing would leave the journal empty: while native history may hold older pages, they are read first.
    if (this.forceReplace) {
      for (let reads = 0; reads < this.limits.gapReadsMax && this.source.hasOlderHistory() && (await this.items(rows)).length === 0; reads += 1) {
        const loaded = await this.source.loadOlderHistory();
        this.check(token);
        if (loaded.added === 0) break;
        rows = this.source.timelineRows().filter(row => row.seq <= lastSeq);
      }
    }
    let plan = await this.plan(opened.index, rows);
    for (let reads = 0; plan.kind === 'gap' && reads < this.limits.gapReadsMax; reads += 1) {
      const loaded = await this.source.loadOlderHistory();
      this.check(token);
      if (loaded.added === 0) break;
      rows = this.source.timelineRows().filter(row => row.seq <= lastSeq);
      plan = await this.plan(opened.index, rows);
    }
    if (plan.kind === 'gap') plan = await replacementPlan(await this.items(rows), item => this.digest(item), 'gap');
    this.check(token);
    // A replacement with nothing to replace with is not published: the journal keeps what it has, and the head follows.
    const replacing = plan.kind === 'replace' && plan.ops.length > 0;
    // The head goes before older history, which can be long and never delays what the session shows now.
    const head = this.headOp();
    const planned = plan.kind === 'gap' || (plan.kind === 'replace' && !replacing) ? [] : plan.ops;
    for (const chunk of chunkOps([...planned, ...(replacing ? [] : this.carriedRebinds(planned)), head])) await this.publish(token, chunk);
    this.check(token);
    if (replacing && plan.kind === 'replace') {
      if (plan.reason !== 'initial') this.context.diagnostic({ event: 'journal_replacement_published', providerId: this.options.providerId, reason: plan.reason });
      this.resetOpen = false;
      // A replacement a quota asked for is not a rewrite: the window it kept is what fits, and the next open finds it known.
      if (plan.reason === 'quota') this.forceReplace = false;
      else {
        this.replaceStreak += 1;
        if (this.replaceStreak >= MAX_REPLACEMENTS_IN_A_ROW) { this.giveUp('replace_loop'); return; }
      }
      // Opening again finds the replacement known and adds the older items as older history.
      this.restart(0, undefined, false);
      return;
    }
    this.replaceStreak = 0;
    this.incompleteStreak = 0;
    this.forceReplace = false;
    this.goLive(token);
    if (plan.kind === 'continue' && !this.olderBlocked) {
      for (const chunk of chunkOps(plan.older)) {
        // What the session shows now, and what the Relay asked for, go before every further block of older history.
        await this.flushLive(token);
        await this.drainRequests(token);
        await this.publish(token, chunk);
      }
    }
    this.check(token);
  }

  /** The rebinds the manager told that no acknowledged publication carries yet, minus those the plan says again. */
  private carriedRebinds(planned: readonly SizedOp[]): SizedOp[] {
    const said = new Set(planned.flatMap(({ op }) => op.op === 'rebind' ? [rebindKey(op.itemKey, op.replacement)] : []));
    const ops: SizedOp[] = [];
    for (const change of this.unacknowledgedRebinds.values()) {
      if (said.has(rebindKey(change.key, change.replacement))) continue;
      const op: PublishOp = { op: 'rebind', itemKey: change.key, previous: change.previous, replacement: change.replacement };
      const bytes = entryBytes(op);
      if (bytes !== undefined) ops.push({ op, bytes });
    }
    return ops;
  }

  private goLive(token: number): void {
    this.phase = 'live';
    this.liveSince = this.context.now();
    for (const event of this.held.splice(0)) {
      if (token !== this.cycle) return;
      this.apply(event);
    }
    if (this.heldHeadDirty) {
      this.heldHeadDirty = false;
      this.headDirty = true;
      if (pendingKey(this.source.snapshot().payload) !== this.headPending) this.urgent = true;
    }
    this.scheduleFlush();
    this.serveRequests();
  }

  /** Opens the journal and reads its whole item index, a page at a time. */
  private async open(token: number): Promise<{ index: JournalIndexEntry[] }> {
    const requestId = randomUUID();
    const reply = await this.ask(token, { uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_open', requestId, sessionKey: this.options.sessionKey, publisherId: this.context.publisherId, ...(this.resetOpen ? { reset: true as const } : {}) },
      message => (message.type === 'journal_opened' || message.type === 'journal_open_refused') && message.requestId === requestId);
    if (reply.type !== 'journal_opened') throw new OpenRefused(reply.type === 'journal_open_refused' ? reply.reason : 'unexpected');
    this.generation = reply.generation;
    this.sequence = reply.watermark;
    this.openedInCycle = true;
    const index = [...reply.index];
    let after = reply.indexAfter;
    for (let pages = 0; after !== undefined; pages += 1) {
      if (pages >= MAX_INDEX_PAGES) throw new Refused('index_pages');
      const id = randomUUID();
      const answer = await this.ask(token, { uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_index_request', requestId: id, sessionKey: this.options.sessionKey, generation: this.generation, epoch: reply.epoch, after },
        message => (message.type === 'journal_index_page' || message.type === 'journal_open_refused') && message.requestId === id);
      if (answer.type === 'journal_open_refused') {
        if (answer.reason === 'stale_epoch') throw new Reopen('stale_epoch');
        throw new OpenRefused(answer.reason);
      }
      if (answer.type !== 'journal_index_page') throw new Refused('unexpected');
      index.push(...answer.index);
      after = answer.indexAfter;
    }
    this.journalKeys = new Set(index.map(entry => entry.itemKey));
    return { index };
  }

  /**
   * The items of a reread that the wire accepts. An item it refuses is left out and recorded once, so that it cannot make
   * every reconcile look like a rewrite: left in, it would be an item the journal never has.
   */
  private async items(rows: readonly CanonicalTimelineRow[]): Promise<TimelineItem[]> {
    const kept: TimelineItem[] = [];
    for (const item of groupItems(rows)) {
      const lastSeq = (item.rows[item.rows.length - 1] as CanonicalTimelineRow).seq;
      if (this.skipped.has(item.key) || this.refusedItems.get(item.key) === lastSeq) continue;
      this.refusedItems.delete(item.key);
      if (this.checked.get(item.key)?.lastSeq !== lastSeq) {
        const bytes = entryBytes({ op: 'prepend', items: [{ row: mergedRow(item), ...(item.complete ? { digest: await this.digest(item) } : {}) }] });
        if (bytes === undefined) { this.skip(item.key); continue; }
        this.checked.set(item.key, { lastSeq });
      }
      kept.push(item);
    }
    return kept;
  }

  private async plan(index: readonly JournalIndexEntry[], rows: readonly CanonicalTimelineRow[]): Promise<PublicationPlan> {
    const window = this.quotaStep > 0 ? this.limits.quotaWindows[this.quotaStep - 1] : undefined;
    const items = await this.items(rows);
    // An empty forced replacement is sent only when native history is exhausted; otherwise the journal stays as it is.
    const force = this.forceReplace && (items.length > 0 || !this.source.hasOlderHistory());
    return planPublication(index, items, item => this.digest(item), {
      ...(window === undefined ? {} : { window }), ...(force ? { forceReplace: true } : {}),
    });
  }

  /** Leaves an item out for as long as the session is followed, and records it once. */
  private skip(key: string): void {
    if (this.skipped.has(key)) return;
    this.skipped.add(key);
    this.context.diagnostic({ event: 'journal_row_rejected', providerId: this.options.providerId });
  }

  /** Whether an item stays out: the wire refused it, or a publication did and none of its rows changed since. */
  private isSkipped(key: string): boolean {
    if (this.skipped.has(key)) return true;
    const refusedAt = this.refusedItems.get(key);
    if (refusedAt === undefined) return false;
    if (refusedAt === (this.source.itemRows(key).at(-1)?.seq ?? -1)) return true;
    this.refusedItems.delete(key);
    return false;
  }

  /** The digest of an item's whole content, as the journal compares it; kept while the item's rows do not change. */
  private async digest(item: TimelineItem): Promise<string> {
    const last = item.rows[item.rows.length - 1] as CanonicalTimelineRow;
    if (last.epoch !== this.digestEpoch) {
      this.digests.clear();
      this.checked.clear();
      this.digestEpoch = last.epoch;
    }
    const cached = this.digests.get(item.key);
    if (cached?.lastSeq === last.seq) return cached.digest;
    const digest = await itemDigest(mergedRow(item).item);
    this.digests.set(item.key, { lastSeq: last.seq, digest });
    return digest;
  }

  // Messages and answers.

  private expect(token: number, kind: Waiter['kind'], match: (message: JournalRelayMessage) => boolean): Promise<JournalRelayMessage> {
    return new Promise((resolve, reject) => {
      if (token !== this.cycle) { reject(new Cancelled()); return; }
      const timer = this.context.schedule(() => { this.waiter = undefined; reject(new TimedOut('The Relay did not answer in time.')); }, this.limits.responseTimeoutMs);
      this.waiter = { kind, match, resolve, reject, timer };
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

  private async ask(token: number, message: RemoteHostUplinkMessage, match: (message: JournalRelayMessage) => boolean, kind: Waiter['kind'] = 'other'): Promise<JournalRelayMessage> {
    const reply = this.expect(token, kind, match);
    const sent = this.context.send(message, this.options.providerId);
    if (sent !== 'sent') this.rejectWaiter(sent === 'offline' ? new Cancelled() : new Refused('unencodable'));
    return reply;
  }

  /**
   * Numbers the entries after the last publication, sends them and waits until the Relay's store holds them. When the Relay
   * refuses an entry because of its item, the entries before it are stored and the refused one consumed no sequence: the
   * item is left out and the entries after it are sent again, numbered from the refused one, instead of opening the journal again.
   */
  private async publish(token: number, chunk: { ops: PublishOp[]; bytes: number }): Promise<void> {
    let ops = chunk.ops;
    while (ops.length > 0) {
      const release = await this.context.reserve(chunk.bytes);
      try {
        this.check(token);
        const first = this.sequence + 1;
        const entries = ops.map((op, at) => ({ sequence: first + at, ...op }) as JournalPublishEntry);
        const last = first + ops.length - 1;
        const generation = this.generation;
        try {
          await this.ask(token, { uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_publish', sessionKey: this.options.sessionKey, generation, entries },
            message => message.type === 'journal_ack' && message.generation === generation && message.watermark >= last, 'publish');
          this.sequence = last;
          this.remember(ops);
          return;
        } catch (error) {
          // The refusal carries the Relay's number of the entry; the entries before it are stored.
          const applied = error instanceof Refused && error.sequence !== undefined ? error.sequence - first : -1;
          if (error instanceof Refused) error.carriedPrepend = ops.some(op => op.op === 'prepend');
          if (!(error instanceof Refused) || error.itemKey === undefined || !ITEM_REFUSALS.has(error.reason) || applied < 0 || applied >= ops.length) throw error;
          const itemKey = error.itemKey;
          const refusedOp = ops[applied] as PublishOp;
          if (!namesItem(refusedOp, itemKey)) throw error;
          const remaining = withoutItem(refusedOp, itemKey);
          this.remember(ops.slice(0, applied));
          this.sequence = error.sequence as number - 1;
          this.refusedItems.set(itemKey, this.source.itemRows(itemKey).at(-1)?.seq ?? -1);
          this.context.diagnostic({ event: 'journal_publication_refused', providerId: this.options.providerId, reason: `${error.reason}:item` });
          ops = [...(remaining ? [remaining] : []), ...ops.slice(applied + 1)].filter(op => opItemKey(op) !== itemKey);
        }
      } finally {
        release();
      }
    }
  }

  /**
   * Notes what a stored publication did: the items it added, for older-history requests, and the rebinds it carried. The
   * Relay passes over a rebind for an item it does not hold, so one that came before its item stays unacknowledged and is
   * queued again once an append or a prepend adds the item.
   */
  private remember(ops: readonly PublishOp[]): void {
    const added = new Set<string>();
    for (const op of ops) {
      if (op.op === 'rebind') {
        if (this.journalKeys.has(op.itemKey)) this.unacknowledgedRebinds.delete(rebindKey(op.itemKey, op.replacement));
      } else if (op.op === 'append') {
        if (!this.journalKeys.has(op.row.itemKey)) added.add(op.row.itemKey);
        this.journalKeys.add(op.row.itemKey);
      } else if (op.op === 'prepend') {
        for (const { row } of op.items) {
          if (!this.journalKeys.has(row.itemKey)) added.add(row.itemKey);
          this.journalKeys.add(row.itemKey);
        }
      }
    }
    if (added.size === 0) return;
    for (const change of this.unacknowledgedRebinds.values()) if (added.has(change.key)) this.queue.push(change);
    this.scheduleFlush();
  }

  // Recovery.

  private recover(token: number, error: unknown): void {
    if (token !== this.cycle || error instanceof Cancelled) return;
    const providerId = this.options.providerId;
    if (error instanceof Reopen) { this.restart(0, error.reason, false); return; }
    if (error instanceof OpenRefused) {
      this.context.diagnostic({ event: 'journal_open_refused', providerId, reason: error.reason });
      if (error.reason === 'index_too_large' && !this.resetOpen) {
        // The way out of an index too large to list: open without it, and make a replacement that fits the first publication.
        this.resetOpen = true;
        this.forceReplace = true;
        this.restart(0, undefined, false);
        return;
      }
      // The Relay took the session out of serving when it refused the open (a head cleared, or the old head forgotten); it is tried again on the next connection.
      this.cycle += 1;
      this.teardown();
      this.phase = 'refused';
      this.signalIdle();
      return;
    }
    if (error instanceof HeadRejected) { this.giveUp('head_rejected'); return; }
    if (error instanceof Refused && error.reason === 'quota_exceeded') {
      // The Relay has taken the session out of serving and fenced this generation: open again and replace with a window that fits.
      if (error.carriedPrepend) {
        // Older history was what did not fit: the window the journal has stays, and older history is not published any more.
        this.olderBlocked = true;
        this.forceReplace = true;
        this.context.diagnostic({ event: 'journal_quota_window', providerId, reason: 'older_history' });
        this.restart(0, undefined, false);
        return;
      }
      this.quotaStep += 1;
      if (this.quotaStep > this.limits.quotaWindows.length) { this.giveUp('quota_exceeded'); return; }
      this.forceReplace = true;
      this.context.diagnostic({ event: 'journal_quota_window', providerId, reason: String(this.limits.quotaWindows[this.quotaStep - 1]) });
      this.restart(0, undefined, false);
      return;
    }
    if (error instanceof Refused && error.reason === 'incomplete') {
      // The journal is missing rows (a quota refused part of an earlier publication, or it was reset): it takes a replacement, then its head.
      // Unlike a quota refusal this does not narrow the window; a Relay that keeps saying so ends the session.
      this.incompleteStreak += 1;
      if (this.incompleteStreak > MAX_REPLACEMENTS_IN_A_ROW) { this.giveUp('incomplete'); return; }
      this.forceReplace = true;
      this.context.diagnostic({ event: 'journal_publication_refused', providerId, reason: 'incomplete' });
      this.restart(0, undefined, false);
      return;
    }
    const reason = error instanceof Refused ? error.reason : error instanceof TimedOut ? 'timeout' : 'failure';
    if (error instanceof Refused) this.context.diagnostic({ event: 'journal_publication_refused', providerId, reason: error.reason });
    this.restart(this.backoffDelay(), error instanceof Refused ? undefined : reason, true);
  }

  /** Tells the Relay to stop serving this session's journal, which this Controller can no longer keep current. */
  private sendUnserve(reason: string, generation = this.generation): void {
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
    const opened = this.openedInCycle && this.generation >= 1;
    this.cycle += 1;
    this.teardown();
    this.phase = 'gave_up';
    this.signalIdle();
    if (opened) this.sendUnserve(reason);
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
    if (token !== this.cycle) return;
    if (this.phase === 'opening') {
      if (event.type === 'agent_state') { this.heldHeadDirty = true; return; }
      if (this.held.length >= this.limits.heldEventsMax) { this.restart(this.backoffDelay(), 'held_events', true); return; }
      this.held.push(event);
      return;
    }
    if (this.phase === 'live') this.apply(event);
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
        if (!this.rebuilding) {
          const change = { kind: 'rebind' as const, key: event.itemKey, previous: event.previous, replacement: event.replacement };
          this.queue.push(change);
          this.unacknowledgedRebinds.set(rebindKey(change.key, change.replacement), change);
          if (this.unacknowledgedRebinds.size > MAX_UNACKNOWLEDGED_REBINDS) this.unacknowledgedRebinds.delete(this.unacknowledgedRebinds.keys().next().value as string);
        }
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
      const head = this.headDirty ? this.headOp() : undefined;
      this.headDirty = false;
      this.urgent = false;
      const ops = await this.materialize(queued);
      if (head) ops.push(head);
      for (const chunk of chunkOps(ops)) await this.publish(token, chunk);
    }
  }

  /** The Snapshot as the head, taken now, with the item its attention cursor points at. A head the wire refuses ends the session's publishing. */
  private headOp(): SizedOp {
    const snapshot = this.source.snapshot().payload;
    const attentionItemKey = this.source.attentionItemKey();
    const op: PublishOp = { op: 'head', head: { snapshot, observedAt: this.context.now(), ...(attentionItemKey === undefined ? {} : { attentionItemKey }) } };
    const bytes = entryBytes(op);
    if (bytes === undefined) {
      this.context.diagnostic({ event: 'journal_row_rejected', providerId: this.options.providerId, reason: 'head' });
      throw new HeadRejected('The Snapshot cannot be published.');
    }
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
        case 'append': {
          if (this.skipped.has(change.key)) break;
          // An item a publication refused comes back whole once a row of it changed, not as the delta that follows what the journal lacks.
          const refusedBefore = this.refusedItems.has(change.key);
          if (this.isSkipped(change.key)) break;
          if (refusedBefore && this.journalKeys.has(change.key)) {
            // The journal holds part of the item: sending it whole would repeat what it has. The next reconcile corrects it.
            this.refusedItems.set(change.key, this.source.itemRows(change.key).at(-1)?.seq ?? -1);
            break;
          }
          const rows = refusedBefore ? this.source.itemRows(change.key) : change.rows;
          add({ op: 'append', row: mergedRow({ key: change.key, rows, complete: false, liveOnly: rows.some(isLiveOnlyRow) }) }, change.key);
          break;
        }
        case 'complete': {
          if (this.isSkipped(change.key)) break;
          const item = groupItems(this.source.itemRows(change.key))[0];
          if (item) add({ op: 'complete', itemKey: change.key, digest: await this.digest(item) }, change.key);
          break;
        }
        case 'rebind':
          if (!this.isSkipped(change.key)) add({ op: 'rebind', itemKey: change.key, previous: change.previous, replacement: change.replacement });
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
    // A reconcile answers the requests itself, between blocks of older history; the rest wait for it to end.
    if (this.phase !== 'live' || this.reconciling) return;
    const token = this.cycle;
    for (const request of this.requests.splice(0)) this.enqueue(() => this.answer(token, request));
  }

  /** Answers the requests that arrived while a reconcile was sending older history. */
  private async drainRequests(token: number): Promise<void> {
    while (token === this.cycle && this.requests.length > 0) await this.answer(token, this.requests.shift() as (typeof this.requests)[number]);
  }

  private async answer(token: number, request: (typeof this.requests)[number]): Promise<void> {
    try {
      if (request.type === 'journal_older_request') await this.answerOlder(token, request);
      else await this.answerFill(token, request);
    } catch (error) {
      // The Relay waits for an answer; one it will not get is refused at once instead of at its deadline.
      this.context.send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_request_refused', requestId: request.requestId, sessionKey: request.sessionKey, reason: 'not_ready' }, this.options.providerId);
      this.recover(token, error);
    }
  }

  /** Publishes the items older than the journal's oldest, reading further native history when the timeline has none. */
  private async answerOlder(token: number, request: Extract<JournalRelayMessage, { type: 'journal_older_request' }>): Promise<void> {
    this.check(token);
    // Under a quota window the journal holds no more than the window: older history would be refused again.
    if (this.quotaStep > 0 || this.olderBlocked) {
      this.context.send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_older_done', requestId: request.requestId, sessionKey: this.options.sessionKey, olderAvailable: false }, this.options.providerId);
      return;
    }
    const older = async (): Promise<TimelineItem[]> => {
      const items = await this.items(this.source.timelineRows());
      const first = items.findIndex(item => this.journalKeys.has(item.key));
      return first <= 0 ? [] : items.slice(0, first).filter(item => !this.journalKeys.has(item.key) && item.complete);
    };
    let candidates = await older();
    for (let reads = 0; candidates.length < request.limit && reads < OLDER_READS_PER_REQUEST && this.source.hasOlderHistory(); reads += 1) {
      const loaded = await this.source.loadOlderHistory().catch(() => ({ added: 0, more: false }));
      this.check(token);
      candidates = await older();
      if (loaded.added === 0) break;
    }
    const take = candidates.slice(-request.limit);
    const { accepted, refused } = await sizedItems(take, item => this.digest(item));
    for (const key of refused) this.skip(key);
    const ops: SizedOp[] = [];
    for (const block of blocksOf(accepted).reverse()) {
      const op: PublishOp = { op: 'prepend', items: block };
      ops.push({ op, bytes: entryBytes(op) ?? MESSAGE_BUDGET_BYTES });
    }
    for (const chunk of chunkOps(ops)) {
      await this.flushLive(token);
      await this.publish(token, chunk);
    }
    this.check(token);
    this.context.send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_older_done', requestId: request.requestId, sessionKey: this.options.sessionKey,
      olderAvailable: candidates.length > take.length || this.source.hasOlderHistory() }, this.options.providerId);
  }

  /** Answers a fill with the bodies of the items it can find, in the order asked, as many as fit one message; the answer takes room in flight like a publication. */
  private async answerFill(token: number, request: Extract<JournalRelayMessage, { type: 'journal_fill_request' }>): Promise<void> {
    this.check(token);
    const wanted = new Set(request.itemKeys.slice(0, JOURNAL_FILL_MAX_ITEMS));
    const found = async (): Promise<TimelineItem[]> => (await this.items(this.source.timelineRows())).filter(item => wanted.has(item.key) && item.complete);
    let items = await found();
    for (let reads = 0; items.length < wanted.size && reads < OLDER_READS_PER_REQUEST && this.source.hasOlderHistory(); reads += 1) {
      const loaded = await this.source.loadOlderHistory().catch(() => ({ added: 0, more: false }));
      this.check(token);
      items = await found();
      if (loaded.added === 0) break;
    }
    const { accepted } = await sizedItems(items, item => this.digest(item));
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

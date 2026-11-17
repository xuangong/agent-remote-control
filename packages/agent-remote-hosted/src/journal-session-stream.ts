import type { JournalHead, JournalPageRequest, JournalPageResult, JournalRow } from '@orchardworks/agent-remote-journal';
import {
  decodeClientMessage, encodeServerMessage, JOURNAL_FILL_MAX_ITEMS, JOURNAL_OLDER_MAX_LIMIT, PROTOCOL_VERSION,
  type AgentSnapshotPayload, type AgentStatus, type BackgroundActivity, type ClientMessage, type HistoryPage, type NativeSessionOwner, type ServerMessage, type TimelineCursor,
} from '@orchardworks/agent-remote-protocol';

import type { JournalPublished, JournalStatus } from './host-journals.js';
import type { HostStream, HostStreamOpener } from './journal-host-stream.js';
import { createStreamControl, requestIdOf } from './stream-control.js';
import { BROKER_MAX_FRAME_BYTES, RELAY_SOCKET_OPEN, type BrokerScheduler, type RelaySocket } from './transport.js';

const PAGE_DEFAULT_LIMIT = 100;
const PAGE_MAX_LIMIT = 500;
const HELD_MAX_MESSAGES = 32;
const HELD_MAX_BYTES = 1024 * 1024;
const CLOSE_REASON_MAX_BYTES = 123;
const ACTIVITY_COALESCE_MS = 500;
const TIMELINE_UNAVAILABLE = 'This part of the conversation is not available right now. It is shown again when the computer that holds it is reachable.';
/**
 * Frames of the Controller session that the journal answers instead; they never reach the browser. The interaction frames
 * are among them: the head carries the pending interactions, the publisher sends a head at once when that set changes, and a
 * client takes its pending interactions from every Snapshot and update.
 */
const READ_PATH_FRAMES = new Set([
  'negotiated', 'agent_snapshot', 'agent_update', 'agent_stream', 'agent_activity',
  'timeline_subscribed', 'timeline_page', 'timeline_replacement', 'timeline_resource_binding_replaced',
  'interaction_requested', 'interaction_resolved', 'interaction_invalidated',
]);
const NEGOTIATE_FRAME = JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' });
const encoder = new TextEncoder();

type TimelineRequestPayload = Extract<ClientMessage, { type: 'timeline_request' }>['payload'];
type Phase = 'new' | 'negotiating' | 'live' | 'closed';

/** What one stream reads from its session's journal; the shared state behind it lives in journal-sessions.ts. */
export interface JournalReads {
  status(): Promise<JournalStatus | undefined>;
  /** A page of the journal; the implementation says whether older history may still exist beyond it. */
  page(request: JournalPageRequest): Promise<JournalPageResult | undefined>;
  /**
   * Asks the Controller to read these bodies again; resolves with the page for `request`, read by the journal in the same
   * step as it took the bodies, and rejects when it cannot be done.
   */
  fill(itemKeys: string[], request: JournalPageRequest): Promise<JournalPageResult | undefined>;
  /** Asks the Controller to read up to `limit` older items and publish them; rejects when it cannot be done. */
  older(limit: number): Promise<void>;
  olderBeyondJournal(): boolean;
  /** The journal has no head although the index said it had one; the index forgets the session before the stream closes. */
  noHead?(): void;
  /** Reading the journal failed; the session leaves the in-memory head index (nothing is deleted), so the client's reconnect is read through the Controller. */
  readFailed?(): void;
}

export interface JournalSessionStreamOptions {
  publicAgentId: string;
  client: Pick<RelaySocket, 'readyState' | 'bufferedAmount' | 'send' | 'close'>;
  reads: JournalReads;
  hostStreams: HostStreamOpener;
  /** Asks the Controller who holds the session natively, when it refused a message for that; undefined when nobody does or it cannot say. */
  readNativeOwner(): Promise<NativeSessionOwner | undefined>;
  scheduler: BrokerScheduler;
}

export interface JournalSessionStream {
  /** One message from the browser; it has already passed the stream's limits and authorization. */
  receive(raw: string): void;
  /** What a stored publication changed in the session's journal. */
  deliver(result: JournalPublished): void;
  /** The browser stream ended. */
  close(): void;
}

function protocolError(code: string, message: string, recoverable: boolean, requestId?: string): ServerMessage {
  return { protocolVersion: PROTOCOL_VERSION, type: 'protocol_error', payload: { ...(requestId === undefined ? {} : { requestId }), code, message, recoverable } };
}

interface Refusal { code: string; message: string; status?: number; nativeOwner?: NativeSessionOwner }

/** The reason a Controller stream or a Host request failed: the error's own code, status and native owner when it has them. */
function refusalOf(error: unknown): Refusal {
  if (error instanceof Error) {
    const { code, status, nativeOwner } = error as { code?: unknown; status?: unknown; nativeOwner?: NativeSessionOwner };
    return {
      code: typeof code === 'string' ? code : 'host_unavailable', message: error.message,
      ...(typeof status === 'number' ? { status } : {}), ...(nativeOwner === undefined ? {} : { nativeOwner }),
    };
  }
  return { code: 'host_unavailable', message: 'The Controller session is unavailable.' };
}

/** True when the page holds the oldest item of the journal (or the journal holds none) and claims older history. */
function reachesJournalStart(page: HistoryPage): boolean {
  const { entries, window, hasOlder } = page.payload;
  return hasOlder && (entries.length === 0 || entries[0]!.seqStart <= window.minSeq);
}

function activityStatus(snapshot: AgentSnapshotPayload): AgentStatus {
  return snapshot.status === 'closed' || snapshot.status === 'failed' ? snapshot.status
    : snapshot.pendingInteractions.length || snapshot.status === 'waiting' ? 'waiting'
    : snapshot.activeTurn || snapshot.status === 'running' ? 'running' : snapshot.status;
}

/**
 * One browser stream of a session that is read from its journal. It answers negotiation, the Snapshot, subscriptions,
 * pages and control itself, delivers what publications change, and sends every other message to a Controller stream that it
 * opens when the first one needs it. Neither reads nor control wait for the Controller.
 */
export function createJournalSessionStream(options: JournalSessionStreamOptions): JournalSessionStream {
  const { publicAgentId, client, reads, hostStreams, scheduler } = options;
  const control = createStreamControl({ agentId: publicAgentId, send: message => sendServer(message), readNativeOwner: options.readNativeOwner, revoked: dropHostStream });
  let phase: Phase = 'new';
  const isPhase = (expected: Phase): boolean => phase === expected;
  let activityOnly = false;
  /** The client asked for item keys: its pages and live events carry them, and it is told so. */
  let keyed = false;
  let subscribed = false;
  /** Something was published while the Snapshot was being read; the head and cursor are read again once it is sent. */
  let stale = false;
  /** The Controller stream: none, being opened, written and awaiting the Controller, or accepted. */
  let hostState: 'idle' | 'opening' | 'open' | 'ready' = 'idle';
  let hostStream: HostStream | undefined;
  /** Messages for the Controller stream that wait for it to accept the stream. */
  const held: Array<{ raw: string; bytes: number; requestId?: string }> = [];
  /** Messages that arrived while negotiation was being answered; they are handled in order once it is done. */
  const queued: Array<{ raw: string; bytes: number }> = [];
  let activitySnapshot: AgentSnapshotPayload | undefined;
  let activityCursor: TimelineCursor | undefined;
  let lastActivity: string | undefined;
  /** What the observer was last told, to tell a status change (sent at once) from a content burst (coalesced). */
  let lastStatus: string | undefined;
  let lastActivityCursor: TimelineCursor | undefined;
  let activityTimer: unknown;

  /** Holds one more message against the limits shared by everything that waits; false when it would exceed them. */
  function hasRoomFor(bytes: number): boolean {
    const waiting = [...held, ...queued];
    return waiting.length < HELD_MAX_MESSAGES && waiting.reduce((sum, item) => sum + item.bytes, bytes) <= HELD_MAX_BYTES;
  }

  function sendRaw(json: string): void {
    if (isPhase('closed') || client.readyState !== RELAY_SOCKET_OPEN) return;
    if (client.bufferedAmount !== undefined && client.bufferedAmount > BROKER_MAX_FRAME_BYTES) { shutdown(1013, 'Slow browser connection'); return; }
    client.send(json);
  }

  function sendServer(message: ServerMessage): void {
    const encoded = encodeServerMessage(message);
    if (encoded.status === 'rejected') { shutdown(1011, 'Invalid journal message'); return; }
    sendRaw(encoded.json);
  }

  /** Closes the browser socket with a reason a WebSocket close frame can carry (at most 123 bytes of UTF-8); a failing close is ignored. */
  function closeClient(code: number, reason?: string): void {
    let fitted = '';
    let bytes = 0;
    for (const character of reason ?? '') {
      bytes += encoder.encode(character).byteLength;
      if (bytes > CLOSE_REASON_MAX_BYTES) break;
      fitted += character;
    }
    try { client.close(code, fitted); }
    catch { /* The socket is already going away. */ }
  }

  function shutdown(code?: number, reason?: string): void {
    if (isPhase('closed')) return;
    phase = 'closed';
    scheduler.clearTimeout(activityTimer);
    activityTimer = undefined;
    const stream = hostStream;
    hostStream = undefined;
    hostState = 'idle';
    stream?.close();
    held.length = 0;
    queued.length = 0;
    if (code !== undefined) closeClient(code, reason);
  }

  /** The Snapshot of the head, as the Controller published it. */
  function snapshotPayload(head: JournalHead): AgentSnapshotPayload {
    const payload = structuredClone(head.snapshot);
    payload.id = publicAgentId;
    return payload;
  }

  const snapshotMessage = (type: 'agent_snapshot' | 'agent_update', head: JournalHead): ServerMessage => type === 'agent_snapshot'
    ? { protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: snapshotPayload(head) }
    : { protocolVersion: PROTOCOL_VERSION, type: 'agent_update', payload: snapshotPayload(head) };

  /** The frame the session wire sends for a background outcome: an `agent_stream` event with no place in the timeline. */
  const outcomeFrame = (outcome: { providerId: string; turnId?: string; background: BackgroundActivity; occurredAt: number }): ServerMessage => ({
    protocolVersion: PROTOCOL_VERSION, type: 'agent_stream',
    payload: { agentId: publicAgentId, timestamp: new Date(outcome.occurredAt).toISOString(),
      event: { type: 'background_activity_updated', providerId: outcome.providerId, ...(outcome.turnId === undefined ? {} : { turnId: outcome.turnId }), background: outcome.background } },
  });

  const streamFrame = (row: JournalRow, itemSeqStart?: number): ServerMessage => ({
    protocolVersion: PROTOCOL_VERSION, type: 'agent_stream',
    payload: {
      agentId: publicAgentId, epoch: row.epoch, seq: row.seq, timestamp: row.timestamp,
      event: { type: 'timeline', providerId: row.providerId, ...(keyed ? { itemKey: row.itemKey, ...(itemSeqStart === undefined ? {} : { itemSeqStart }) } : {}), item: row.item, ...(row.turnId === undefined ? {} : { turnId: row.turnId }), resources: row.resources },
    },
  });

  function publishActivity(): void {
    scheduler.clearTimeout(activityTimer);
    activityTimer = undefined;
    if (!activitySnapshot) return;
    const background = activitySnapshot.attention?.background;
    const status = activityStatus(activitySnapshot);
    const payload = {
      agentId: publicAgentId, status,
      ...(activityCursor ? { cursor: activityCursor } : {}),
      ...(background ? { background: { id: background.id, kind: background.kind, status: background.status } } : {}),
    };
    const key = JSON.stringify(payload);
    if (key === lastActivity) return;
    lastActivity = key;
    lastStatus = JSON.stringify({ status, background: payload.background });
    lastActivityCursor = activityCursor;
    sendServer({ protocolVersion: PROTOCOL_VERSION, type: 'agent_activity', payload });
  }

  function scheduleActivity(): void {
    if (activityTimer !== undefined || !activitySnapshot) return;
    if (activityCursor?.epoch === lastActivityCursor?.epoch && activityCursor?.seq === lastActivityCursor?.seq) return;
    // Status is sent at once; content bursts share one bounded metadata update.
    activityTimer = scheduler.setTimeout(() => { activityTimer = undefined; publishActivity(); }, ACTIVITY_COALESCE_MS);
  }

  /** Takes a new head and cursor for the observer: a changed status or background goes out now, anything else waits for the window. */
  function observe(snapshot: AgentSnapshotPayload | undefined, cursor: TimelineCursor | undefined): void {
    if (cursor) activityCursor = cursor;
    if (snapshot) activitySnapshot = snapshot;
    if (!activitySnapshot) return;
    const background = activitySnapshot.attention?.background;
    const state = JSON.stringify({
      status: activityStatus(activitySnapshot),
      background: background ? { id: background.id, kind: background.kind, status: background.status } : undefined,
    });
    if (state !== lastStatus) publishActivity();
    else scheduleActivity();
  }

  /** Sends the head as it is now: an update for a content stream, activity for an observer. */
  async function refreshHead(): Promise<void> {
    const status = await reads.status();
    if (isPhase('closed')) return;
    if (!status?.head) { reads.noHead?.(); shutdown(1012, 'Session journal unavailable'); return; }
    if (activityOnly) observe(status.head.snapshot, status.cursor);
    else sendServer(snapshotMessage('agent_update', status.head));
  }

  function readFailure(): void {
    reads.readFailed?.();
    shutdown(1011, 'Session journal could not be read');
  }

  async function negotiate(): Promise<void> {
    const status = await reads.status();
    if (!isPhase('negotiating')) return;
    if (!status?.head) { reads.noHead?.(); shutdown(1012, 'Session journal unavailable'); return; }
    sendServer({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated', sessionControl: true, ...(keyed ? { itemKeys: true as const } : {}) });
    if (activityOnly) {
      observe(status.head.snapshot, status.cursor);
    } else {
      sendServer(snapshotMessage('agent_snapshot', status.head));
      control.announce();
    }
    if (!isPhase('negotiating')) return;
    phase = 'live';
    if (stale) { stale = false; refreshHead().catch(readFailure); }
    for (const item of queued.splice(0)) receive(item.raw);
  }

  /** Answers each request with the refusal. The browser stream stays: the next message tries again. */
  function refuse(requestIds: ReadonlyArray<string | undefined>, error: unknown): void {
    const { code, message, status } = refusalOf(error);
    // A 4xx other than a timeout or a capacity limit says the request itself cannot succeed.
    const recoverable = status === undefined || status >= 500 || status === 408 || status === 429;
    for (const requestId of requestIds) sendServer(protocolError(code, message, recoverable, requestId));
  }

  /** Opens the Controller stream when none is open or opening; what waits for it is sent once it is open. */
  function ensureHost(): void {
    if (hostState !== 'idle' || isPhase('closed')) return;
    hostState = 'opening';
    hostStreams.open({ frame: hostFrame, ready: hostIsReady, ended: hostEnded }).then(stream => {
      if (isPhase('closed')) { stream.close(); return; }
      hostStream = stream;
      hostState = 'open';
      try { stream.send(NEGOTIATE_FRAME); }
      catch (error) { openFailed(error); }
    }, error => { if (!isPhase('closed')) openFailed(error); });
  }

  /** Ends the Controller stream, if any; the next message opens a new one. */
  function dropHostStream(): void {
    const stream = hostStream;
    hostStream = undefined;
    hostState = 'idle';
    stream?.close();
  }

  /** The Controller stream could not be opened or was not accepted: what waits is refused, and a terminal's ownership is shown. */
  function openFailed(error: unknown): void {
    dropHostStream();
    refuse(held.splice(0).map(item => item.requestId), error);
    const { code, nativeOwner } = refusalOf(error);
    control.controllerRefused(code, nativeOwner);
  }

  /** The Controller accepted the stream: what waited for it is sent. */
  function hostIsReady(): void {
    hostState = 'ready';
    for (const item of held.splice(0)) {
      try { hostStream?.send(item.raw); }
      catch (error) { refuse([item.requestId], error); }
    }
  }

  function hostEnded(code: number, reason: string): void {
    const accepted = hostState === 'ready';
    hostState = 'idle';
    hostStream = undefined;
    if (accepted) { shutdown(code, reason); return; }
    // The Controller did not accept the stream. A terminal that holds the session is the reason a refusal at open would have named.
    void options.readNativeOwner().catch(() => undefined).then(nativeOwner => {
      if (isPhase('closed')) return;
      openFailed(nativeOwner
        ? Object.assign(new Error('A terminal holds this session. Take over to continue here.'), { code: 'native_session_owned', status: 409, nativeOwner })
        : Object.assign(new Error(reason || 'The Controller could not open the session.'), { code: 'host_unavailable' }));
    });
  }

  /** A frame from the Controller session: the read path belongs to the journal, the rest goes to the browser. */
  function hostFrame(raw: string): void {
    let parsed: { type?: unknown; payload?: { code?: unknown } } | undefined;
    try { parsed = JSON.parse(raw); } catch { return; }
    const type = parsed?.type;
    if (typeof type !== 'string' || READ_PATH_FRAMES.has(type)) return;
    sendRaw(raw);
    if (type === 'protocol_error' && typeof parsed?.payload?.code === 'string') control.controllerRefused(parsed.payload.code);
  }

  /** Sends a message to the Controller stream, holding it until the stream is open. */
  function forward(raw: string, requestId: string | undefined): void {
    const stream = hostStream;
    if (hostState === 'ready' && stream) {
      try { stream.send(raw); }
      catch (error) { refuse([requestId], error); }
      return;
    }
    const bytes = encoder.encode(raw).byteLength;
    if (!hasRoomFor(bytes)) { shutdown(1013, 'Remote stream is not ready'); return; }
    held.push({ raw, bytes, ...(requestId === undefined ? {} : { requestId }) });
    ensureHost();
  }

  async function servePage(payload: TimelineRequestPayload): Promise<void> {
    if (payload.agentId !== publicAgentId) {
      sendServer(protocolError('agent_identity_mismatch', 'Client message identifies a different Agent.', true, payload.requestId));
      return;
    }
    const query: JournalPageRequest = {
      requestId: payload.requestId, agentId: publicAgentId, direction: payload.direction,
      ...(payload.cursor === undefined ? {} : { cursor: payload.cursor }),
      limit: Math.min(payload.limit ?? PAGE_DEFAULT_LIMIT, PAGE_MAX_LIMIT),
      ...(keyed ? { itemKeys: true } : {}),
    };
    try {
      let result = await reads.page(query);
      if (isPhase('closed')) return;
      const rounds = Math.ceil(query.limit / JOURNAL_FILL_MAX_ITEMS) + 1;
      let previouslyMissing = Number.POSITIVE_INFINITY;
      for (let round = 0; result?.kind === 'missing' && round < rounds && result.itemKeys.length < previouslyMissing; round++) {
        previouslyMissing = result.itemKeys.length;
        result = await reads.fill(result.itemKeys.slice(0, JOURNAL_FILL_MAX_ITEMS), query);
        if (isPhase('closed')) return;
      }
      if (result?.kind === 'page' && query.direction === 'before' && reachesJournalStart(result.page) && reads.olderBeyondJournal()) {
        const served = result;
        try {
          await reads.older(Math.min(query.limit, JOURNAL_OLDER_MAX_LIMIT));
          if (isPhase('closed')) return;
          result = (await reads.page(query)) ?? served;
        } catch { result = served; }
      }
      if (result?.kind === 'page') sendServer(result.page);
      else sendServer(protocolError('timeline_unavailable', TIMELINE_UNAVAILABLE, true, payload.requestId));
    } catch {
      sendServer(protocolError('timeline_unavailable', TIMELINE_UNAVAILABLE, true, payload.requestId));
    }
  }

  function receive(raw: string): void {
    if (isPhase('closed')) return;
    if (isPhase('negotiating')) {
      const bytes = encoder.encode(raw).byteLength;
      if (!hasRoomFor(bytes)) { shutdown(1013, 'Remote stream is not ready'); return; }
      queued.push({ raw, bytes });
      return;
    }
    const decoded = decodeClientMessage(raw);
    if (decoded.status === 'rejected') {
      const issue = decoded.issues[0];
      sendServer(protocolError(issue?.code ?? 'invalid_shape', issue?.message ?? 'Client message was rejected.', !isPhase('new')));
      return;
    }
    const message = decoded.value;
    if (isPhase('new')) {
      if (message.type !== 'negotiate') {
        sendServer(protocolError('negotiation_required', 'Protocol negotiation must be the first message.', false));
        return;
      }
      phase = 'negotiating';
      activityOnly = message.observation === 'activity';
      keyed = message.itemKeys === true && !activityOnly;
      negotiate().catch(readFailure);
      return;
    }
    if (message.type === 'negotiate') {
      sendServer(protocolError('already_negotiated', 'Protocol version has already been negotiated.', true));
      return;
    }
    if (activityOnly) {
      sendServer(protocolError('activity_only', 'This connection observes activity only. Open the session to use content and controls.', false));
      return;
    }
    switch (message.type) {
      case 'timeline_subscription': {
        const agentIds = message.payload.agentIds.includes(publicAgentId) ? [publicAgentId] : [];
        sendServer({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds } });
        subscribed = agentIds.length === 1;
        return;
      }
      case 'timeline_request':
        void servePage(message.payload);
        return;
      default:
        if (!control.admit(message)) forward(raw, requestIdOf(message));
    }
  }

  function deliver(result: JournalPublished): void {
    if (isPhase('closed') || isPhase('new')) return;
    if (isPhase('negotiating')) { stale = true; return; }
    if (activityOnly) {
      // The publication's cursor is taken first, so a head published with it already carries the cursor it belongs to.
      let head: AgentSnapshotPayload | undefined;
      for (const event of result.events) if (event.kind === 'head') head = event.head.snapshot;
      if (result.events.length > 0) observe(head, result.cursor);
      return;
    }
    for (const event of result.events) {
      switch (event.kind) {
        case 'head':
          sendServer(snapshotMessage('agent_update', event.head));
          break;
        case 'row':
          if (subscribed) sendServer(streamFrame(event.row, event.itemSeqStart));
          break;
        case 'replaced':
          if (subscribed) sendServer({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_replacement', payload: { agentId: publicAgentId, epoch: event.epoch } });
          break;
        case 'rebound':
          if (subscribed) {
            sendServer({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_resource_binding_replaced',
              payload: { agentId: publicAgentId, epoch: event.epoch, seq: event.seq, previous: event.previous, replacement: event.replacement } });
          }
          break;
        case 'outcome':
          sendServer(outcomeFrame(event));
          break;
      }
    }
  }

  return { receive, deliver, close: () => shutdown() };
}

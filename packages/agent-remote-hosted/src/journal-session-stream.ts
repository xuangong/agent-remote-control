import type { JournalHead, JournalPageRequest, JournalPageResult, JournalRow } from '@orchardworks/agent-remote-journal';
import {
  decodeClientMessage, encodeServerMessage, JOURNAL_FILL_MAX_ITEMS, JOURNAL_OLDER_MAX_LIMIT, PROTOCOL_VERSION, SESSION_CAPACITY_CLOSE_CODE,
  type AgentSnapshotPayload, type AgentStatus, type ClientMessage, type HistoryPage, type NativeSessionOwner, type ServerMessage, type TimelineCursor,
} from '@orchardworks/agent-remote-protocol';

import type { JournalPublished, JournalStatus } from './host-journals.js';
import type { HostStream, HostStreamOpener } from './journal-host-stream.js';
import { BROKER_MAX_FRAME_BYTES, RELAY_SOCKET_OPEN, type BrokerScheduler, type RelaySocket } from './transport.js';

/** The control revision the Relay shows before the Controller session reports its own; a request naming it is rewritten. */
export const PENDING_CONTROL_REVISION = 'relay-pending';
/** What a browser is told when no Controller stream slot is free; short enough for a WebSocket close frame. */
export const CAPACITY_CLOSE_REASON = 'Too many sessions are open. Close views you no longer use; this one retries when a slot is free.';
const PAGE_DEFAULT_LIMIT = 100;
const PAGE_MAX_LIMIT = 500;
const HELD_MAX_MESSAGES = 32;
const HELD_MAX_BYTES = 1024 * 1024;
const CLOSE_REASON_MAX_BYTES = 123;
const ACTIVITY_COALESCE_MS = 500;
const TIMELINE_UNAVAILABLE = 'This part of the conversation is not available right now. It is shown again when the computer that holds it is reachable.';
const RESTORING_REASON = 'The Controller session is not connected yet.';
/** Frames of the Controller session that the journal answers instead; they never reach the browser. */
const READ_PATH_FRAMES = new Set([
  'negotiated', 'agent_snapshot', 'agent_update', 'agent_stream', 'agent_activity',
  'timeline_subscribed', 'timeline_page', 'timeline_replacement', 'timeline_resource_binding_replaced',
]);
const NEGOTIATE_FRAME = JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' });
const encoder = new TextEncoder();

type TimelineRequestPayload = Extract<ClientMessage, { type: 'timeline_request' }>['payload'];
type ControlRequest = Extract<ClientMessage, { type: 'session_control_request' }>;
type Phase = 'new' | 'negotiating' | 'live' | 'closed';

/** What one stream reads from its session's journal; the shared state behind it lives in journal-sessions.ts. */
export interface JournalReads {
  status(): Promise<JournalStatus | undefined>;
  /** A page of the journal; the implementation says whether older history may still exist beyond it. */
  page(request: JournalPageRequest): Promise<JournalPageResult | undefined>;
  /** Asks the Controller to read these bodies again; resolves when the journal took them, rejects when it cannot be done. */
  fill(itemKeys: string[]): Promise<void>;
  /** Asks the Controller to read up to `limit` older items and publish them; rejects when it cannot be done. */
  older(limit: number): Promise<void>;
  olderBeyondJournal(): boolean;
}

export interface JournalSessionStreamOptions {
  publicAgentId: string;
  client: Pick<RelaySocket, 'readyState' | 'bufferedAmount' | 'send' | 'close'>;
  reads: JournalReads;
  hostStreams: HostStreamOpener;
  scheduler: BrokerScheduler;
}

export interface JournalSessionStream {
  /** One message from the browser; it has already passed the stream's limits and authorization. */
  receive(raw: string): void;
  /** What a stored publication changed in the session's journal. */
  deliver(result: JournalPublished): void;
  /** The browser stream ended. */
  close(): void;
  /** The Host's Controller connected again: a stream that waits for it closes so the client reconnects and acquires control. */
  hostReturned(): void;
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

function requestIdOf(message: ClientMessage): string | undefined {
  if (message.type === 'interaction_response') return message.payload.submissionId;
  const payload = (message as unknown as { payload?: { requestId?: unknown } }).payload;
  return typeof payload?.requestId === 'string' ? payload.requestId : undefined;
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
 * One browser stream of a session that is read from its journal. It answers negotiation, the Snapshot, subscriptions and
 * pages itself, delivers what publications change, and sends every other message to a Controller stream that it opens in
 * the background. Reads never wait for the Controller.
 */
export function createJournalSessionStream(options: JournalSessionStreamOptions): JournalSessionStream {
  const { publicAgentId, client, reads, hostStreams, scheduler } = options;
  let phase: Phase = 'new';
  const isPhase = (expected: Phase): boolean => phase === expected;
  let activityOnly = false;
  let subscribed = false;
  let hostReady = false;
  /** Something was published while the Snapshot was being read; the head and cursor are read again once it is sent. */
  let stale = false;
  let hostState: 'idle' | 'opening' | 'open' = 'idle';
  let hostStream: HostStream | undefined;
  /** The last attempt to open the Controller stream failed because the Host is offline. */
  let waitingForHost = false;
  /** The control revision of the Controller session, once it has reported one. */
  let controlRevision: string | undefined;
  /** Messages for the Controller stream that wait for it to open. */
  const held: Array<{ raw: string; bytes: number; requestId?: string }> = [];
  /** Requests to acquire control that name the pending revision and wait for the Controller's own. */
  const heldControl: Array<{ request: ControlRequest; bytes: number }> = [];
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
    const waiting = [...held, ...heldControl, ...queued];
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
    heldControl.length = 0;
    queued.length = 0;
    if (code !== undefined) closeClient(code, reason);
  }

  /** The Snapshot of the head. While the Controller stream is not ready, the runtime shows as not connected yet. */
  function snapshotPayload(head: JournalHead): AgentSnapshotPayload {
    const payload = structuredClone(head.snapshot);
    payload.id = publicAgentId;
    if (!hostReady) payload.runtimeInfo = { ...payload.runtimeInfo, connection: { state: 'restoring', reason: RESTORING_REASON } };
    return payload;
  }

  const snapshotMessage = (type: 'agent_snapshot' | 'agent_update', head: JournalHead): ServerMessage => type === 'agent_snapshot'
    ? { protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: snapshotPayload(head) }
    : { protocolVersion: PROTOCOL_VERSION, type: 'agent_update', payload: snapshotPayload(head) };

  const streamFrame = (row: JournalRow): ServerMessage => ({
    protocolVersion: PROTOCOL_VERSION, type: 'agent_stream',
    payload: {
      agentId: publicAgentId, epoch: row.epoch, seq: row.seq, timestamp: row.timestamp,
      event: { type: 'timeline', providerId: row.providerId, item: row.item, ...(row.turnId === undefined ? {} : { turnId: row.turnId }), resources: row.resources },
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
    if (!status?.head) { shutdown(1012, 'Session journal unavailable'); return; }
    if (activityOnly) observe(status.head.snapshot, status.cursor);
    else sendServer(snapshotMessage('agent_update', status.head));
  }

  async function negotiate(): Promise<void> {
    const status = await reads.status();
    if (!isPhase('negotiating')) return;
    if (!status?.head) { shutdown(1012, 'Session journal unavailable'); return; }
    sendServer({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated', sessionControl: true });
    if (activityOnly) {
      observe(status.head.snapshot, status.cursor);
    } else {
      sendServer(snapshotMessage('agent_snapshot', status.head));
      sendServer({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: { agentId: publicAgentId, revision: PENDING_CONTROL_REVISION, access: 'read_only', available: false } });
    }
    if (!isPhase('negotiating')) return;
    phase = 'live';
    if (stale) { stale = false; refreshHead().catch(() => shutdown(1011, 'Session journal could not be read')); }
    if (!activityOnly) ensureHost();
    for (const item of queued.splice(0)) receive(item.raw);
  }

  function refuse(requestIds: ReadonlyArray<string | undefined>, error: unknown, final = false): void {
    const { code, message } = refusalOf(error);
    for (const requestId of requestIds) sendServer(protocolError(code, message, !final, requestId));
  }

  /** Opens the Controller stream when none is open or opening; what waits for it is sent once it is open. */
  function ensureHost(): void {
    if (hostState !== 'idle' || isPhase('closed')) return;
    hostState = 'opening';
    hostStreams.open({ frame: hostFrame, ready: hostIsReady, ended: hostEnded }).then(stream => {
      if (isPhase('closed')) { stream.close(); return; }
      hostStream = stream;
      hostState = 'open';
      waitingForHost = false;
      try { stream.send(NEGOTIATE_FRAME); }
      catch (error) {
        const requestIds = [...held.map(item => item.requestId), ...heldControl.map(item => item.request.payload.requestId)];
        held.length = 0;
        heldControl.length = 0;
        refuse(requestIds, error);
        return;
      }
      for (const item of held.splice(0)) {
        try { stream.send(item.raw); }
        catch (error) { refuse([item.requestId], error); }
      }
      flushControl();
    }, error => {
      hostState = 'idle';
      if (isPhase('closed')) return;
      const refusal = refusalOf(error);
      const messages = held.splice(0);
      const requests = heldControl.splice(0).map(item => item.request);
      const { status } = refusal;
      if (status === 429) { shutdown(SESSION_CAPACITY_CLOSE_CODE, CAPACITY_CLOSE_REASON); return; }
      // A refusal that retrying cannot change leaves the stream reading; one that depends on the Host waits for it.
      const hopeless = status !== undefined && status >= 400 && status < 500 && status !== 408;
      const offline = refusal.code === 'host_offline';
      waitingForHost = offline;
      if (!offline && !hopeless) {
        refuse([...messages.map(item => item.requestId), ...requests.map(item => item.payload.requestId)], error);
        return;
      }
      refuse(messages.map(item => item.requestId), error, !offline);
      for (const request of requests) {
        if (request.payload.action === 'acquire') {
          sendServer({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: {
            agentId: publicAgentId, revision: PENDING_CONTROL_REVISION, access: 'read_only', available: false, requestId: request.payload.requestId,
            ...(refusal.nativeOwner === undefined ? {} : { nativeOwner: refusal.nativeOwner }),
          } });
        } else refuse([request.payload.requestId], error, !offline);
      }
    });
  }

  function hostIsReady(): void {
    hostReady = true;
    if (!activityOnly) refreshHead().catch(() => shutdown(1011, 'Session journal could not be read'));
  }

  function hostEnded(code: number, reason: string): void {
    hostState = 'idle';
    hostStream = undefined;
    shutdown(code, reason);
  }

  /** A frame from the Controller session: the read path belongs to the journal, the rest goes to the browser. */
  function hostFrame(raw: string): void {
    let parsed: { type?: unknown; payload?: { revision?: unknown } } | undefined;
    try { parsed = JSON.parse(raw); } catch { return; }
    const type = parsed?.type;
    if (typeof type !== 'string' || READ_PATH_FRAMES.has(type)) return;
    sendRaw(raw);
    if (type === 'session_control' && typeof parsed?.payload?.revision === 'string') {
      controlRevision = parsed.payload.revision;
      flushControl();
    }
  }

  /** Sends the held control requests with the Controller's own revision, once it is known and the stream is open. */
  function flushControl(): void {
    if (controlRevision === undefined || hostState !== 'open') return;
    for (const { request } of heldControl.splice(0)) {
      forward(JSON.stringify({ ...request, payload: { ...request.payload, revision: controlRevision } }), request.payload.requestId);
    }
  }

  /** Sends a message to the Controller stream, holding it until the stream is open. */
  function forward(raw: string, requestId: string | undefined): void {
    const stream = hostStream;
    if (hostState === 'open' && stream) {
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
    };
    try {
      let result = await reads.page(query);
      if (isPhase('closed')) return;
      const rounds = Math.ceil(query.limit / JOURNAL_FILL_MAX_ITEMS) + 1;
      let previouslyMissing = Number.POSITIVE_INFINITY;
      for (let round = 0; result?.kind === 'missing' && round < rounds && result.itemKeys.length < previouslyMissing; round++) {
        previouslyMissing = result.itemKeys.length;
        await reads.fill(result.itemKeys.slice(0, JOURNAL_FILL_MAX_ITEMS));
        if (isPhase('closed')) return;
        result = await reads.page(query);
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
      negotiate().catch(() => shutdown(1011, 'Session journal could not be read'));
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
      case 'session_control_request':
        if (message.payload.revision !== PENDING_CONTROL_REVISION) { forward(raw, message.payload.requestId); return; }
        {
          const bytes = encoder.encode(raw).byteLength;
          if (!hasRoomFor(bytes)) { shutdown(1013, 'Remote stream is not ready'); return; }
          heldControl.push({ request: message, bytes });
        }
        ensureHost();
        flushControl();
        return;
      default:
        forward(raw, requestIdOf(message));
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
      if (event.kind === 'head') { sendServer(snapshotMessage('agent_update', event.head)); continue; }
      if (!subscribed) continue;
      sendServer(event.kind === 'row' ? streamFrame(event.row)
        : { protocolVersion: PROTOCOL_VERSION, type: 'timeline_replacement', payload: { agentId: publicAgentId, epoch: event.epoch } });
    }
  }

  function hostReturned(): void {
    if (waitingForHost && !isPhase('closed')) shutdown(1012, 'Remote Host reconnected');
  }

  return { receive, deliver, close: () => shutdown(), hostReturned };
}

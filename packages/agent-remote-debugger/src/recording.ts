import { decodeServerMessage, PROTOCOL_VERSION, type HistoryPage } from '@orchardworks/agent-remote-protocol';
import {
  applyAgentSnapshot, applyHistoryPage, applyInteractionRequested, applyInteractionResolved,
  applyResourceUpdate, applyTimelineReplacement, createReplicaState,
  type AgentReplicaState, type RemoteSessionStatus,
} from '@orchardworks/agent-remote-web/headless';
import type { DebuggerRecord } from './records.js';

export interface SessionRecording {
  agentId: string;
  duration: number;
  warnings: string[];
  events: { at: number; record: DebuggerRecord }[];
}
const statuses = ['idle', 'connecting', 'catching_up', 'ready', 'disconnected'];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const position = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Reads observer JSONL, never native events or browser-side diagnostic payloads. */
export function parseRecording(input: string): SessionRecording {
  const events: SessionRecording['events'] = [];
  const warnings = new Set<string>();
  const lines = input.replace(/^\uFEFF/, '').split('\n');
  let agentId = ''; let started = false; let ended = false;
  let clock = 0; let baseline = -1; let hasAgent = false; let hasReset = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line) continue;
    const fail = (message: string): never => { throw new Error(`Recording line ${index + 1}: ${message}`); };
    let value: unknown;
    try { value = JSON.parse(line); } catch {
      if (index === lines.length - 1 && events.length) { warnings.add('The final line was truncated; only the complete prefix is available.'); break; }
      fail('Invalid JSON.');
    }
    if (!object(value) || !text(value.kind)) fail('Expected a recording object.');
    const record = value as Record<string, unknown>;
    if (record.kind === 'server_ready' || record.kind === 'browser_trace') continue;
    if (record.schemaVersion !== '1.1.0') fail('Unsupported recording schema version.');
    if (!text(record.agentId) || !text(record.timestamp) || !Number.isFinite(Date.parse(record.timestamp))) fail('Missing session identity or valid timestamp.');
    if (agentId && record.agentId !== agentId) fail('Multiple sessions cannot share one recording.');
    agentId = record.agentId as string;
    const timestamp = Date.parse(record.timestamp as string);
    if (timestamp < clock) warnings.add('The recording clock moved backwards; line order is preserved.');
    clock = Math.max(clock, timestamp);
    if (ended) fail('Records were found after recording_end.');
    if (record.kind === 'recording_start') {
      if (started || events.length) fail('Unexpected recording_start.');
      started = true; continue;
    }
    if (record.kind === 'recording_end') {
      if (!started) fail('recording_end has no recording_start.');
      if (record.reason === 'size_limit') warnings.add('Recording stopped at its size limit; later session changes were not captured.');
      ended = true; continue;
    }
    validateRecord(record, fail);
    const typed = record as unknown as DebuggerRecord;
    if (typed.kind === 'agent') { if (typed.agent.id !== agentId) fail('Snapshot session identity does not match.'); hasAgent = true; }
    if (typed.kind === 'timeline_reset') hasReset = true;
    if (typed.kind === 'checkpoint') {
      if (hasAgent && hasReset && baseline < 0) baseline = events.length;
      if (typed.hasOlder) warnings.add('Only recorded history is available; older messages were not captured.');
    }
    if (typed.kind === 'resource' || typed.kind === 'timeline_upsert' && typed.entry.resources.length > 0) {
      warnings.add('Resource bodies and attachments are not embedded in this recording; original Host resources cannot be opened.');
    }
    events.push({ at: clock, record: typed });
  }
  if (baseline < 0) throw new Error('Recording has no complete Session View baseline (snapshot, timeline reset and checkpoint).');
  if (!ended) warnings.add('Recording completion is unknown: no closing marker was captured.');
  const origin = events[baseline]!.at;
  for (const event of events) event.at = Math.max(0, event.at - origin);
  return { agentId, duration: Math.max(0, clock - origin), warnings: [...warnings], events };
}

function validateRecord(record: Record<string, unknown>, fail: (message: string) => never): void {
  const wire = (type: string, payload: unknown) => {
    const result = decodeServerMessage(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type, payload }));
    if (result.status !== 'ok') fail(`Invalid ${String(record.kind)} payload.`);
  };
  const epoch = (value: unknown) => value === null || text(value);
  switch (record.kind) {
    case 'connection': if (!statuses.includes(String(record.status))) fail('Invalid connection status.'); break;
    case 'agent': wire('agent_snapshot', record.agent); break;
    case 'timeline_reset': if (!epoch(record.epoch) || !epoch(record.previousEpoch)) fail('Invalid timeline epoch.'); break;
    case 'timeline_upsert': {
      if (!text(record.epoch) || !object(record.entry)) fail('Invalid timeline entry.');
      wire('timeline_page', entryPage(record as unknown as Extract<DebuggerRecord, { kind: 'timeline_upsert' }>).payload); break;
    }
    case 'interaction_requested': wire('interaction_requested', { agentId: record.agentId, request: record.request }); break;
    case 'interaction_resolved': if (!text(record.requestId) || !text(record.interactionKind)) fail('Invalid interaction resolution.'); break;
    case 'resource': wire('resource_update', { agentId: record.agentId, resourceId: record.resourceId, state: record.state }); break;
    case 'diagnostic': {
      const d = record.diagnostic;
      if (!object(d) || !text(d.code) || !text(d.message) || typeof d.recoverable !== 'boolean') fail('Invalid diagnostic.'); break;
    }
    case 'checkpoint': if (!epoch(record.epoch) || !position(record.nextSeq) || !position(record.bufferedLive) || typeof record.hasOlder !== 'boolean') fail('Invalid checkpoint.'); break;
    default: fail(`Unknown record kind: ${String(record.kind)}.`);
  }
}

function entryPage(record: Extract<DebuggerRecord, { kind: 'timeline_upsert' }>, nextSeq = record.entry.seqEnd + 1): HistoryPage {
  const { entry, epoch, agentId } = record;
  return { protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
    requestId: 'replay', agentId, epoch, direction: 'after', reset: false, staleCursor: false, gap: false,
    window: { minSeq: entry.seqStart, maxSeq: entry.seqEnd, nextSeq },
    startCursor: { epoch, seq: entry.seqStart }, endCursor: { epoch, seq: entry.seqEnd },
    entries: [entry], hasOlder: false, hasNewer: false, error: null,
  } };
}

function applyRecord(state: AgentReplicaState, record: DebuggerRecord): AgentReplicaState {
  switch (record.kind) {
    case 'agent': return applyAgentSnapshot(state, { protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: record.agent });
    case 'timeline_reset': return record.epoch === null ? { ...state, timeline: createReplicaState().timeline } : applyTimelineReplacement(state, record.epoch);
    case 'timeline_upsert': return applyHistoryPage(state, entryPage(record, Math.max(state.timeline.nextSeq, record.entry.seqEnd + 1))).state;
    case 'interaction_requested': return applyInteractionRequested(state, record.request);
    case 'interaction_resolved': return applyInteractionResolved(state, record.requestId);
    case 'resource': return applyResourceUpdate(state, { protocolVersion: PROTOCOL_VERSION, type: 'resource_update', payload: { agentId: record.agentId, resourceId: record.resourceId, state: record.state } });
    case 'diagnostic': return { ...state, diagnostics: [...state.diagnostics, record.diagnostic] };
    // A recording can describe missing history, but it cannot load it from the original Host.
    case 'checkpoint': return { ...state, timeline: { ...state.timeline, initialized: record.epoch !== null, epoch: record.epoch, nextSeq: record.nextSeq, hasOlder: false } };
    default: return state;
  }
}

/** An incremental event cursor: normal playback never rebuilds earlier frames. */
export class RecordingPlayer {
  state = createReplicaState();
  status: RemoteSessionStatus = 'idle';
  position = 0;
  playing = false;
  speed = 1;
  private next = 0;
  constructor(readonly recording: SessionRecording) { this.seek(0); }
  play() { if (this.position >= this.recording.duration) this.seek(0); this.playing = this.recording.duration > 0; }
  pause() { this.playing = false; }
  advance(elapsed: number) { if (this.playing) this.seek(this.position + Math.max(0, elapsed) * this.speed); }
  seek(position: number) {
    if (!Number.isFinite(position)) return;
    const target = Math.max(0, Math.min(position, this.recording.duration));
    if (target < this.position) { this.next = 0; this.state = createReplicaState(); this.status = 'idle'; }
    while (this.next < this.recording.events.length && this.recording.events[this.next]!.at <= target) {
      const { record } = this.recording.events[this.next++]!;
      this.state = applyRecord(this.state, record);
      if (record.kind === 'connection') this.status = record.status;
    }
    this.position = target;
    if (target >= this.recording.duration) this.pause();
  }
  step() { this.pause(); this.seek(this.recording.events[this.next]?.at ?? this.recording.duration); }
}

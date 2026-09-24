import { describe, expect, it } from 'vitest';
import { AgentReplica, type RemoteSessionStatus } from '@orchardworks/agent-remote-web/headless';
import { PROTOCOL_VERSION, type AgentSnapshot, type HistoryPage, type ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { observeReplica, type DebuggerRecord } from './records.js';
import { parseRecording, RecordingPlayer } from './recording.js';

const snapshot: AgentSnapshot = { protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: {
  id: 'demo', providerId: 'fixture', createdAt: '2026-09-24T00:00:00Z', updatedAt: '2026-09-24T00:00:00Z',
  status: 'idle', activeTurn: null, pendingInteractions: [],
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  runtimeInfo: { providerId: 'fixture', sessionId: 'native-demo', status: 'idle' },
} };
function page(text: string, epoch = 'epoch'): HistoryPage {
  const entry: ProjectedTimelineEntry = { providerId: 'fixture', timestamp: '2026-09-24T00:00:00Z', seqStart: 1, seqEnd: 1,
    item: { type: 'assistant_message', messageId: 'reply', text }, sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], collapsed: [], resources: [] };
  return { protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
    requestId: 'history', agentId: 'demo', epoch, direction: 'tail', reset: false, staleCursor: false, gap: false,
    window: { minSeq: 1, maxSeq: 1, nextSeq: 2 }, startCursor: { epoch, seq: 1 }, endCursor: { epoch, seq: 1 },
    hasOlder: false, hasNewer: false, entries: [entry], error: null,
  } };
}
function capture() {
  const replica = new AgentReplica();
  replica.applySnapshot(snapshot); replica.applyHistory(page('first'));
  const records: DebuggerRecord[] = [];
  let time = 0;
  observeReplica('demo', replica, { subscribeStatus(listener: (s: RemoteSessionStatus) => void) { listener('ready'); return () => {}; } },
    record => records.push({ ...record, timestamp: new Date(Date.UTC(2026, 8, 24) + time).toISOString() }));
  time = 1000; replica.applyHistory(page('updated'));
  replica.applyInteractionRequested({ protocolVersion: PROTOCOL_VERSION, type: 'interaction_requested', payload: { agentId: 'demo', request: { kind: 'plan_approval', requestId: 'approval', plan: 'Review me', allowedActions: ['approve'] } } });
  time = 2000; replica.applyInteractionResolved({ protocolVersion: PROTOCOL_VERSION, type: 'interaction_resolved', payload: { agentId: 'demo', requestId: 'approval', response: { kind: 'plan_approval', action: 'approve' } } });
  replica.applyHistory(page('replacement', 'new-epoch'));
  return { replica, records };
}
const jsonl = (records: unknown[]) => records.map(r => JSON.stringify(r)).join('\n') + '\n';

describe('Session View recording', () => {
  it('replays real observer records through updates, approvals, epoch replacement and backwards seek', () => {
    const { replica, records } = capture();
    const recording = parseRecording(jsonl(records));
    const player = new RecordingPlayer(recording);
    expect(player.state.timeline.entries[0]?.item).toMatchObject({ text: 'first' });
    player.seek(1000);
    expect(player.state.timeline.entries).toHaveLength(1);
    expect(player.state.timeline.entries[0]?.item).toMatchObject({ text: 'updated' });
    expect(player.state.pendingInteractions[0]?.requestId).toBe('approval');
    player.seek(2000);
    expect(player.state.timeline).toEqual(replica.getState().timeline);
    expect(player.state.pendingInteractions).toEqual([]);
    player.seek(0);
    expect(player.state.timeline.entries[0]?.item).toMatchObject({ text: 'first' });
    expect(player.state.pendingInteractions).toEqual([]);
  });
  it('pauses, changes speed, steps equal-time events together and stops at the end', () => {
    const player = new RecordingPlayer(parseRecording(jsonl(capture().records)));
    player.advance(500); expect(player.position).toBe(0);
    player.play(); player.advance(400); expect(player.position).toBe(400);
    player.speed = 2; player.advance(300); expect(player.position).toBe(1000);
    player.pause(); player.advance(1000); expect(player.position).toBe(1000);
    player.step(); expect(player.position).toBe(2000); expect(player.playing).toBe(false);
    player.seek(0); player.play(); player.advance(10000);
    expect(player.position).toBe(2000); expect(player.playing).toBe(false);
  });
  it('distinguishes complete, legacy and truncated recordings; rejects malformed middle lines', () => {
    const { records } = capture();
    expect(parseRecording(jsonl(records)).warnings.join(' ')).toMatch(/completion/i);
    const markers = [{ kind: 'recording_start', schemaVersion: '1.1.0', agentId: 'demo', timestamp: records[0]!.timestamp }, ...records,
      { kind: 'recording_end', schemaVersion: '1.1.0', agentId: 'demo', timestamp: records.at(-1)!.timestamp }];
    expect(parseRecording(jsonl(markers)).warnings).toEqual([]);
    expect(parseRecording(jsonl(records) + '{"kind":').warnings.join(' ')).toMatch(/truncated/i);
    expect(() => parseRecording(jsonl(records.slice(0, 2)) + 'broken\n' + jsonl(records.slice(2)))).toThrow(/line 3/i);
  });
  it('rejects unsupported versions, mixed sessions, invalid payloads and recordings without a baseline', () => {
    const { records } = capture();
    expect(() => parseRecording(jsonl(records.map(r => ({ ...r, schemaVersion: '99' }))))).toThrow(/version/i);
    expect(() => parseRecording(jsonl([...records, { ...records[0], agentId: 'another' }]))).toThrow(/session/i);
    expect(() => parseRecording(jsonl(records.map(r => r.kind === 'timeline_upsert' ? { ...r, entry: {} } : r)))).toThrow(/line/i);
    expect(() => parseRecording(jsonl([{ kind: 'server_ready' }]))).toThrow(/baseline/i);
  });
  it('clamps backwards clocks and retains missing resource metadata without fetching content', () => {
    const { records } = capture();
    const recording = parseRecording(jsonl([...records, { ...records[0], timestamp: records[0]!.timestamp, kind: 'resource', resourceId: 'r', state: { status: 'available', mediaType: 'text/plain', byteLength: 3, sha256: 'digest' } }]));
    expect(recording.warnings.join(' ')).toMatch(/clock/i);
    expect(recording.warnings.join(' ')).toMatch(/resource/i);
    const player = new RecordingPlayer(recording); player.seek(recording.duration);
    expect(player.state.resources.r).toMatchObject({ status: 'available', byteLength: 3 });
    expect(player.state.resources.r).not.toHaveProperty('contentBase64');
  });
});

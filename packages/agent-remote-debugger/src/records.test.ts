import { describe, expect, it } from 'vitest';
import type { AgentSnapshot, HistoryPage, InteractionRequestedMessage, InteractionResolvedMessage, ProjectedTimelineEntry, ResourceResponse } from '@borgee/agent-remote-protocol';
import { AgentReplica, type RemoteSessionStatus } from '@borgee/agent-remote-web/headless';

import { observeReplica, type DebuggerRecord } from './records.js';

const capabilities = {
  history: true, sendMessage: true, steer: true, cancel: true, readResource: true,
  interactions: { question: true, planApproval: true, toolApproval: true },
};

function snapshot(status: 'idle' | 'running' = 'idle'): AgentSnapshot {
  return {
    protocolVersion: '1.1.0', type: 'agent_snapshot',
    payload: {
      id: 'agent-one', providerId: 'provider-one', createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:01.000Z', status, activeTurn: null, capabilities,
      pendingInteractions: [], runtimeInfo: { providerId: 'provider-one', sessionId: 'session-one', status },
    },
  };
}

function entry(seq: number, text: string): ProjectedTimelineEntry {
  return {
    providerId: 'provider-one', item: { type: 'assistant_message', text, messageId: `message-${seq}` },
    timestamp: '2026-09-03T00:00:00.000Z', seqStart: seq, seqEnd: seq,
    sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [], resources: [],
  };
}

function page(entries: ProjectedTimelineEntry[], epoch = 'epoch-one'): HistoryPage {
  return {
    protocolVersion: '1.1.0', type: 'timeline_page',
    payload: {
      requestId: 'page-one', agentId: 'agent-one', direction: 'tail', epoch, reset: false, staleCursor: false, gap: false,
      window: { minSeq: entries[0]?.seqStart ?? 0, maxSeq: entries.at(-1)?.seqEnd ?? 0, nextSeq: (entries.at(-1)?.seqEnd ?? 0) + 1 },
      startCursor: entries.length ? { epoch, seq: entries[0]?.seqStart as number } : null,
      endCursor: entries.length ? { epoch, seq: entries.at(-1)?.seqEnd as number } : null,
      hasOlder: false, hasNewer: false, entries, error: null,
    },
  };
}

class StatusSource {
  private status: RemoteSessionStatus = 'idle';
  private readonly listeners = new Set<(status: RemoteSessionStatus) => void>();

  subscribeStatus(listener: (status: RemoteSessionStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  set(status: RemoteSessionStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}

describe('observeReplica', () => {
  it('emits the ready baseline in its stable record order', () => {
    const replica = new AgentReplica();
    const status = new StatusSource();
    const records: DebuggerRecord[] = [];
    replica.applySnapshot(snapshot());
    replica.applyHistory(page([entry(1, 'first')]));

    const stop = observeReplica('agent-one', replica, status, (record) => records.push(record));
    status.set('ready');

    expect(records.map(({ kind }) => kind)).toEqual(['connection', 'agent', 'timeline_reset', 'timeline_upsert', 'checkpoint']);
    expect(records.every((record) => record.schemaVersion === '1.1.0' && record.agentId === 'agent-one' && !Number.isNaN(Date.parse(record.timestamp)))).toBe(true);
    stop();
  });

  it('projects new epochs and changed Timeline entries once', () => {
    const replica = new AgentReplica();
    const status = new StatusSource();
    const records: DebuggerRecord[] = [];
    replica.applySnapshot(snapshot());
    replica.applyHistory(page([entry(1, 'first')]));
    observeReplica('agent-one', replica, status, (record) => records.push(record));
    status.set('ready');
    records.length = 0;

    replica.applyHistory(page([entry(1, 'changed')], 'epoch-two'));
    replica.applyHistory(page([entry(1, 'changed')], 'epoch-two'));

    expect(records.map(({ kind }) => kind)).toEqual(['timeline_reset', 'timeline_upsert', 'checkpoint']);
    expect(records[0]).toMatchObject({ kind: 'timeline_reset', previousEpoch: 'epoch-one', epoch: 'epoch-two' });
    expect(records[1]).toMatchObject({ kind: 'timeline_upsert', epoch: 'epoch-two', entry: { item: { text: 'changed' } } });
  });

  it('resets the projection when an authoritative same-epoch page removes an emitted row', () => {
    const replica = new AgentReplica();
    const status = new StatusSource();
    const records: DebuggerRecord[] = [];
    replica.applySnapshot(snapshot());
    replica.applyHistory(page([entry(1, 'first'), entry(2, 'second')]));
    observeReplica('agent-one', replica, status, (record) => records.push(record));
    status.set('ready');
    records.length = 0;

    replica.applyHistory(page([entry(2, 'second')]));

    expect(records.map(({ kind }) => kind)).toEqual(['timeline_reset', 'timeline_upsert', 'checkpoint']);
    expect(records[0]).toMatchObject({ kind: 'timeline_reset', previousEpoch: 'epoch-one', epoch: 'epoch-one' });
    expect(records[1]).toMatchObject({ kind: 'timeline_upsert', entry: { seqStart: 2 } });
  });

  it('projects interaction membership, public resource state, diagnostics, and checkpoints', () => {
    const replica = new AgentReplica();
    const status = new StatusSource();
    const records: DebuggerRecord[] = [];
    replica.applySnapshot(snapshot());
    replica.applyHistory(page([]));
    observeReplica('agent-one', replica, status, (record) => records.push(record));
    status.set('ready');
    records.length = 0;
    const request: InteractionRequestedMessage = {
      protocolVersion: '1.1.0', type: 'interaction_requested',
      payload: { agentId: 'agent-one', request: { kind: 'plan_approval', requestId: 'approval-one', plan: 'A plan', allowedActions: ['approve'] } },
    };
    const resource: ResourceResponse = {
      protocolVersion: '1.1.0', type: 'resource_response',
      payload: { requestId: 'resource-request', agentId: 'agent-one', resourceId: 'resource-one', state: {
        status: 'available', mediaType: 'text/plain', byteLength: 3, sha256: 'digest', contentBase64: 'YWJj',
      } },
    };
    const resolved: InteractionResolvedMessage = {
      protocolVersion: '1.1.0', type: 'interaction_resolved',
      payload: { agentId: 'agent-one', requestId: 'approval-one', response: { kind: 'plan_approval', action: 'approve' } },
    };

    replica.applyInteractionRequested(request);
    replica.applyResource(resource);
    replica.reportDiagnostic('wire_problem', 'Wire problem.', true);
    replica.applyInteractionResolved(resolved);

    expect(records.map(({ kind }) => kind)).toEqual(['interaction_requested', 'resource', 'diagnostic', 'interaction_resolved']);
    expect(records.find(({ kind }) => kind === 'resource')).toMatchObject({
      kind: 'resource', resourceId: 'resource-one', state: { status: 'available', byteLength: 3 },
    });
    expect(JSON.stringify(records)).not.toContain('YWJj');
    expect(records.at(-1)).toMatchObject({ kind: 'interaction_resolved', requestId: 'approval-one', interactionKind: 'plan_approval' });
  });

  it('suppresses equal connection, Snapshot, interaction, resource, and diagnostic reapplications', () => {
    const replica = new AgentReplica();
    const status = new StatusSource();
    const records: DebuggerRecord[] = [];
    const request: InteractionRequestedMessage = {
      protocolVersion: '1.1.0', type: 'interaction_requested',
      payload: { agentId: 'agent-one', request: { kind: 'plan_approval', requestId: 'approval-one', plan: 'A plan', allowedActions: ['approve'] } },
    };
    const resource: ResourceResponse = {
      protocolVersion: '1.1.0', type: 'resource_response',
      payload: { requestId: 'resource-request', agentId: 'agent-one', resourceId: 'resource-one', state: {
        status: 'available', mediaType: 'text/plain', byteLength: 3, sha256: 'digest', contentBase64: 'YWJj',
      } },
    };
    replica.applySnapshot(snapshot());
    replica.applyHistory(page([]));
    observeReplica('agent-one', replica, status, (record) => records.push(record));
    status.set('ready');
    records.length = 0;

    status.set('connecting');
    status.set('connecting');
    expect(records.map(({ kind }) => kind)).toEqual(['connection']);
    expect(records[0]).toMatchObject({ kind: 'connection', status: 'connecting' });
    records.length = 0;
    replica.applySnapshot(snapshot());
    expect(records).toEqual([]);
    replica.applyInteractionRequested(request);
    records.length = 0;
    replica.applyInteractionRequested(request);
    expect(records).toEqual([]);
    replica.applyResource(resource);
    records.length = 0;
    replica.applyResource(resource);
    expect(records).toEqual([]);
    replica.reportDiagnostic('wire_problem', 'Wire problem.', true);
    records.length = 0;
    replica.reportDiagnostic('wire_problem', 'Wire problem.', true);

    expect(records).toEqual([]);
  });

  it('compares decoded protocol values structurally without depending on property insertion order', () => {
    const replica = new AgentReplica();
    const status = new StatusSource();
    const records: DebuggerRecord[] = [];
    replica.applySnapshot(snapshot());
    replica.applyHistory(page([]));
    observeReplica('agent-one', replica, status, (record) => records.push(record));
    status.set('ready');
    records.length = 0;
    const original = snapshot();
    const reordered: AgentSnapshot = {
      type: 'agent_snapshot',
      protocolVersion: '1.1.0',
      payload: {
        runtimeInfo: {
          status: original.payload.runtimeInfo.status,
          sessionId: original.payload.runtimeInfo.sessionId,
          providerId: original.payload.runtimeInfo.providerId,
        },
        pendingInteractions: [],
        capabilities: {
          interactions: { toolApproval: true, planApproval: true, question: true },
          readResource: true,
          cancel: true,
          steer: true,
          sendMessage: true,
          history: true,
        },
        activeTurn: null,
        status: 'idle',
        updatedAt: original.payload.updatedAt,
        createdAt: original.payload.createdAt,
        providerId: original.payload.providerId,
        id: original.payload.id,
      },
    };

    replica.applySnapshot(reordered);
    expect(records).toEqual([]);

    replica.applySnapshot(snapshot('running'));
    expect(records).toEqual([expect.objectContaining({ kind: 'agent', agent: expect.objectContaining({ status: 'running' }) })]);
  });
});

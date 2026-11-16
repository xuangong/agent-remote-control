import { SessionJournal } from '@orchardworks/agent-remote-journal';
import { PROTOCOL_VERSION, type AgentSnapshotPayload } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it, vi } from 'vitest';

import type { JournalPublished } from './host-journals.js';
import type { HostStream, HostStreamOpener, HostStreamSink } from './journal-host-stream.js';
import { createJournalSessionStream, type JournalReads } from './journal-session-stream.js';

type Wire = Record<string, any>;
const request = { kind: 'question' as const, requestId: 'question-1', questions: [{ questionId: 'q', header: 'Pick', prompt: 'Which?', required: true, selection: 'single' as const, options: [{ value: 'a', label: 'A', description: 'a' }], allowCustomText: false, allowDismiss: false }] };
const snapshot = (pending: unknown[] = []): AgentSnapshotPayload => ({
  id: 'native-id', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: pending as never, runtimeInfo: { providerId: 'codex', sessionId: 'native-id', status: 'idle' },
});
const frame = (fields: Wire) => JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...fields });

function fixture() {
  const journal = SessionJournal.create('host-1:codex:thread-1');
  const { generation } = journal.claim('controller-1');
  let sequence = 0;
  const at = () => ({ publisherId: 'controller-1', generation, sequence: ++sequence });
  journal.setHead(at(), { snapshot: snapshot(), observedAt: 5 });
  const reads: JournalReads = {
    status: async () => ({ cursor: journal.cursor, ...(journal.head ? { head: journal.head } : {}) }),
    page: async pageRequest => journal.page(pageRequest, { olderBeyondJournal: false }),
    fill: async () => undefined, older: async () => undefined, olderBeyondJournal: () => false,
  };
  const sent: Wire[] = [];
  const closes: Array<number | undefined> = [];
  const client = { readyState: 1, bufferedAmount: 0 as number | undefined, send: (data: string) => { sent.push(JSON.parse(data)); }, close: (code?: number) => { closes.push(code); } };
  let sink: HostStreamSink | undefined;
  const hostStreams: HostStreamOpener = { async open(next) { sink = next; const stream: HostStream = { send: () => undefined, close: () => undefined }; return stream; } };
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const scheduler = { setTimeout: (callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: (timer: unknown) => { timers.delete(timer as number); } };
  const stream = createJournalSessionStream({ publicAgentId: 'agent', client, reads, hostStreams, scheduler });
  const published = (events: JournalPublished['events']): JournalPublished => ({ events, watermark: sequence, cursor: journal.cursor });
  return {
    journal, sent, closes, at, stream, sink: () => sink!, timers,
    types: () => sent.map(message => message.type),
    fromController: (fields: Wire) => sink!.frame(frame(fields)),
    setHead(pending: unknown[]): JournalPublished {
      journal.setHead(at(), { snapshot: snapshot(pending), observedAt: 6 });
      return published([{ kind: 'head', head: journal.head! }]);
    },
    async ready(subscribe = true) {
      stream.receive(frame({ type: 'negotiate' }));
      await vi.waitFor(() => expect(sink).toBeDefined());
      if (subscribe) stream.receive(frame({ type: 'timeline_subscription', payload: { requestId: 'sub-1', agentIds: ['agent'] } }));
      await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(subscribe ? 4 : 3));
      sink!.ready();
      await vi.waitFor(() => expect(sent.at(-1)?.type).toBe('agent_update'));
    },
    published,
  };
}

describe('amendments of a journal-served stream', () => {
  it('sends a replaced resource binding to a subscriber, found by the item\'s epoch and sequence', async () => {
    const f = await (async () => { const value = fixture(); await value.ready(); return value; })();
    const previous = { locator: 'docs/plan.md', resourceId: 'resource-1', status: 'pending' as const };
    const replacement = { locator: 'docs/plan.md', resourceId: 'resource-2', status: 'available' as const };
    f.stream.deliver(f.published([{ kind: 'rebound', epoch: 'epoch-1', seq: 7, previous, replacement }]));
    expect(f.sent.at(-1)).toEqual({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_resource_binding_replaced', payload: { agentId: 'agent', epoch: 'epoch-1', seq: 7, previous, replacement } });
  });

  it('sends a background outcome as the agent_stream frame the session wire sends', async () => {
    const f = await (async () => { const value = fixture(); await value.ready(); return value; })();
    f.stream.deliver(f.published([
      { kind: 'outcome', providerId: 'codex', turnId: 'turn-1', background: { id: 'review-1', kind: 'review', status: 'visible' }, occurredAt: 1_725_000_000_000 },
    ]));
    expect(f.sent.at(-1)).toEqual({ protocolVersion: PROTOCOL_VERSION, type: 'agent_stream', payload: { agentId: 'agent', timestamp: '2024-08-30T06:40:00.000Z',
      event: { type: 'background_activity_updated', providerId: 'codex', turnId: 'turn-1', background: { id: 'review-1', kind: 'review', status: 'visible' } } } });
  });

  it('does not send an amendment of the timeline to a stream that did not subscribe, but still sends an outcome', async () => {
    const f = fixture();
    await f.ready(false);
    const before = f.sent.length;
    f.stream.deliver(f.published([{ kind: 'rebound', epoch: 'epoch-1', seq: 1, previous: { locator: 'a', resourceId: 'r1', status: 'pending' }, replacement: { locator: 'a', resourceId: 'r2', status: 'available' } }]));
    expect(f.sent).toHaveLength(before);
    f.stream.deliver(f.published([{ kind: 'outcome', providerId: 'codex', background: { id: 'review-1', kind: 'review', status: 'failed' }, occurredAt: 1_725_000_000_000 }]));
    expect(f.sent.at(-1)).toMatchObject({ type: 'agent_stream', payload: { event: { type: 'background_activity_updated' } } });
  });
});

describe('the attention cursor of a served head', () => {
  it('is served as a live cursor when the attention item sits below the first sequence', async () => {
    const f = fixture();
    const text = (itemKey: string) => ({ row: { itemKey, providerId: 'codex', sourceKey: `${itemKey}:1`, occurredAt: 1_725_000_000_000, turnId: 'turn-1', item: { type: 'assistant_message' as const, text: itemKey, messageId: itemKey } }, digest: 'a'.repeat(64) });
    f.journal.replace(f.at(), [text('a')], 1_000);
    f.journal.prepend(f.at(), [text('p1'), text('p2'), text('p3')]);
    f.journal.setHead(f.at(), { snapshot: { ...snapshot(), attention: { cursor: { epoch: 'controller-epoch', seq: 7 } } }, observedAt: 7, attentionItemKey: 'p1' });
    await f.ready(false);
    expect(f.sent.find(message => message.type === 'agent_snapshot')?.payload.attention.cursor).toEqual({ epoch: f.journal.epoch, seq: 0 });
    expect(f.closes).toEqual([]);
  });
});

describe('pending interactions on a journal-served stream', () => {
  const answer = { kind: 'question', answers: [] };
  it('never forward the interaction frames of the Controller, and keep no timer for them', async () => {
    const f = fixture();
    await f.ready();
    const before = f.sent.length;
    f.stream.deliver(f.setHead([request]));
    f.fromController({ type: 'interaction_requested', payload: { agentId: 'agent', request } });
    f.fromController({ type: 'interaction_invalidated', payload: { agentId: 'agent', requestId: 'question-1', reason: 'Canceled.' } });
    f.stream.deliver(f.setHead([]));
    f.fromController({ type: 'interaction_resolved', payload: { agentId: 'agent', requestId: 'question-1', response: answer } });
    expect(f.types().slice(before)).toEqual(['agent_update', 'agent_update']);
    expect(f.timers.size).toBe(0);
  });

  it('reach the browser only inside the head: an update that lacks a question removes it', async () => {
    const f = fixture();
    await f.ready();
    const before = f.sent.length;
    f.stream.deliver(f.setHead([request]));
    f.stream.deliver(f.setHead([]));
    const updates = f.sent.slice(before);
    expect(updates.map(message => message.type)).toEqual(['agent_update', 'agent_update']);
    expect(updates.map(message => message.payload.pendingInteractions.map((value: Wire) => value.requestId))).toEqual([['question-1'], []]);
  });
});

import { describe, expect, it } from 'vitest';
import type { AgentSnapshot, HistoryPage, ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';

import { AgentReplica } from './store.js';
import type { OutgoingMessage } from './types.js';

const capabilities = { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } };
const snapshot: AgentSnapshot = { protocolVersion: '1.8.0', type: 'agent_snapshot', payload: {
  id: 'agent-one', providerId: 'provider-neutral', createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:01.000Z', status: 'idle', activeTurn: null,
  capabilities, pendingInteractions: [], runtimeInfo: { providerId: 'provider-neutral', sessionId: 'session-one', status: 'idle' } } };

const row = (key: string, seq: number, text: string, type: 'user_message' | 'assistant_message' = 'assistant_message'): ProjectedTimelineEntry => ({
  providerId: 'provider-neutral', itemKey: key, item: type === 'user_message' ? { type, text } : { type, text, messageId: key },
  timestamp: `2026-09-02T00:00:${String(seq).padStart(2, '0')}.000Z`, seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [], resources: [] });
const tail = (epoch: string, entries: ProjectedTimelineEntry[]): HistoryPage => ({ protocolVersion: '1.8.0', type: 'timeline_page', payload: {
  requestId: 'r', agentId: 'agent-one', direction: 'tail', epoch, reset: false, staleCursor: false, gap: false,
  window: { minSeq: 1, maxSeq: entries.length, nextSeq: entries.length + 1 }, startCursor: { epoch, seq: 1 }, endCursor: { epoch, seq: entries.length }, hasOlder: false, hasNewer: false, entries, error: null } });

function sentAfter(rows: ProjectedTimelineEntry[], text = 'Ship it'): { replica: AgentReplica; id: string } {
  const replica = new AgentReplica();
  replica.applySnapshot(snapshot);
  replica.applyHistory(tail('epoch-one', rows));
  const id = replica.beginMessage('agent-one', text, undefined, 'operation');
  replica.acknowledgeMessage(id);
  return { replica, id };
}
const status = (replica: AgentReplica) => replica.getState().outgoingMessages?.map(message => message.status);

describe('the outgoing message ledger follows row keys', () => {
  it('names the newest row as the anchor of a message', () => {
    const { replica } = sentAfter([row('a', 1, 'A'), row('b', 2, 'B')]);
    expect(replica.getState().outgoingMessages?.[0]).toMatchObject({ afterKey: 'b', status: 'awaiting_echo' });
    expect(replica.getState().outgoingMessages?.[0]).not.toHaveProperty('afterSeq');
  });

  it('confirms the message by its echo when a replacement keeps the anchor row', () => {
    const { replica } = sentAfter([row('a', 1, 'A'), row('b', 2, 'B')]);
    replica.replaceTimeline('epoch-two');
    expect(status(replica)).toEqual(['awaiting_echo']);
    replica.applyHistory(tail('epoch-two', [row('a', 1, 'A'), row('b', 2, 'B'), row('echo', 3, 'Ship it', 'user_message')]));
    expect(replica.getState().outgoingMessages).toEqual([]);
  });

  it('marks the message unconfirmed when a replacement rewrote its anchor row', () => {
    const { replica } = sentAfter([row('a', 1, 'A'), row('b', 2, 'B')]);
    replica.replaceTimeline('epoch-two');
    replica.applyHistory(tail('epoch-two', [row('a', 1, 'A'), row('echo', 2, 'Ship it', 'user_message')]));
    expect(status(replica)).toEqual(['unconfirmed']);
    expect(replica.getState().outgoingMessages?.[0]?.error).toMatch(/history changed/);
  });

  it('does not take an older message with the same text for the echo', () => {
    const { replica } = sentAfter([row('old', 1, 'Ship it', 'user_message'), row('b', 2, 'B')]);
    expect(status(replica)).toEqual(['awaiting_echo']);
  });

  it('reads a ledger written before row keys once as unconfirmed and writes it back in the new form', () => {
    const replica = new AgentReplica();
    replica.applySnapshot(snapshot);
    const legacy = { id: 'saved', agentId: 'agent-one', text: 'Ship it', status: 'awaiting_echo', epoch: 'epoch-one', afterSeq: 3, consumedEchoSeqs: [4] } as unknown as OutgoingMessage;
    replica.restoreMessages([legacy]);
    replica.applyHistory(tail('epoch-one', [row('a', 1, 'A'), row('echo', 2, 'Ship it', 'user_message')]));
    const [restored] = replica.getState().outgoingMessages ?? [];
    expect(restored).toMatchObject({ id: 'saved', status: 'unconfirmed' });
    expect(restored).not.toHaveProperty('epoch');
    expect(restored).not.toHaveProperty('afterSeq');
    expect(restored).not.toHaveProperty('consumedEchoSeqs');
    replica.retryMessage('saved', 'operation-two');
    expect(replica.getState().outgoingMessages?.[0]).toMatchObject({ status: 'sending', afterKey: 'echo' });
  });
});

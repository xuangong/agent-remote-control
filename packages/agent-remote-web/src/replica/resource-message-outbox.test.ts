import { expect, it } from 'vitest';
import { MessageOutbox } from './message-outbox.js';
import { createReplicaState } from './reducer.js';
import type { AgentReplicaState } from './types.js';
it('matches resource echoes by stable identity instead of display labels or text', () => {
  const outbox = new MessageOutbox();
  const initial = createReplicaState();
  const state = { ...initial, agent: { id: 'agent' } as AgentReplicaState['agent'], timeline: { ...initial.timeline, initialized: true, epoch: 'epoch', nextSeq: 1 } };
  const message = outbox.create(state, 'agent', 'resource #1', undefined, 'operation', { content: [{ type: 'resource', resourceId: 'expected', label: 'resource #1' }] });
  const echo = (resourceId: string): AgentReplicaState => ({ ...state, outgoingMessages: [message], timeline: { ...state.timeline, entries: [{ providerId: 'test', seqStart: 1, seqEnd: 1, timestamp: '2026-10-13T00:00:00Z', sourceSeqRanges: [], collapsed: [], resources: [], item: { type: 'user_message', text: 'resource #1', content: [{ type: 'resource', locator: `input-resource:${resourceId}`, label: 'resource #1', name: 'fixture.zip', byteLength: 1, mediaType: 'application/zip', sha256: 'a'.repeat(64) }] } }] } });
  expect(outbox.reconcile(echo('foreign')).outgoingMessages).toHaveLength(1);
  expect(outbox.reconcile(echo('expected')).outgoingMessages).toHaveLength(0);
});

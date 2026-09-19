import { afterEach, expect, it } from 'vitest';
import { AgentReplica } from '@agent-remote-controller/agent-remote-web';
import { recoverMessages } from './message-recovery.js';

afterEach(() => localStorage.clear());

it('retains unconfirmed input across page restarts and deletes it only when requested', () => {
  const first = new AgentReplica();
  const stop = recoverMessages(first, 'relay', 'native-session', 'old-agent');
  const id = first.beginMessage('old-agent', 'Remember this', undefined, 'operation-one');
  stop();
  const restored = new AgentReplica();
  const unsubscribe = recoverMessages(restored, 'relay', 'native-session', 'new-agent');
  expect(restored.getState().outgoingMessages).toMatchObject([{ id, agentId: 'new-agent', text: 'Remember this', status: 'unconfirmed', operationId: 'operation-one' }]);
  restored.deleteMessage(id); unsubscribe();
  const next = new AgentReplica();
  recoverMessages(next, 'relay', 'native-session', 'new-agent')();
  expect(next.getState().outgoingMessages ?? []).toEqual([]);
});

it('restores the ordered image content and identity needed for an exact retry', () => {
  const first = new AgentReplica();
  const stop = recoverMessages(first, 'relay', 'rich-session', 'old-agent');
  const content = [{ type: 'text' as const, text: 'before' }, { type: 'image' as const, attachmentId: 'a', label: 'image #1' }];
  const imageDigests = { a: 'a'.repeat(64) };
  first.beginMessage('old-agent', 'before[image #1]', undefined, 'operation-image', { content, imageDigests }); stop();
  const restored = new AgentReplica();
  recoverMessages(restored, 'relay', 'rich-session', 'new-agent')();
  expect(restored.getState().outgoingMessages).toMatchObject([{ content, imageDigests, agentId: 'new-agent', status: 'unconfirmed' }]);
});

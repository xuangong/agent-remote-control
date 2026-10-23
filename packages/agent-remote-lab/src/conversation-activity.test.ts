import { expect, it } from 'vitest';
import { conversationActivity } from './conversation-activity.js';
import { replicaState } from './test/fixtures.js';

const agent = replicaState.agent!;

it('reports the activity the Host derives from the same snapshot', () => {
  expect(conversationActivity(replicaState, 'ready')).toEqual({ connection: 'ready', activity: 'idle', cursor: { epoch: 'epoch-1', seq: 6 } });
  const question = { ...replicaState, agent: { ...agent, status: 'running' as const, pendingInteractions: [{} as never] } };
  expect(conversationActivity(question, 'ready').activity).toBe('waiting');
  const turn = { ...replicaState, agent: { ...agent, activeTurn: { turnId: 'turn' } as never } };
  expect(conversationActivity(turn, 'ready').activity).toBe('running');
  // Application-owned attention excludes acknowledged quiet background work, so it wins over the timeline end.
  const attention = { ...replicaState, agent: { ...agent, attention: { cursor: { epoch: 'epoch-1', seq: 4 }, background: { id: 'review', kind: 'review' as const, status: 'silent' as const, summary: 'Not reported' } } } };
  expect(conversationActivity(attention, 'ready')).toEqual({ connection: 'ready', activity: 'idle', cursor: { epoch: 'epoch-1', seq: 4 },
    background: { id: 'review', kind: 'review', status: 'silent' } });
});

it('reports a conversation that is not ready the way an activity subscription would', () => {
  expect(conversationActivity(replicaState, 'catching_up')).toEqual({ connection: 'connecting' });
  const paused = { ...replicaState, diagnostics: [{ code: 'session_paused', message: 'Paused for a more recent window.', recoverable: true }] };
  expect(conversationActivity(paused, 'disconnected')).toEqual({ connection: 'disconnected', error: 'Paused for a more recent window.' });
  expect(conversationActivity(replicaState, 'disconnected')).toEqual({ connection: 'disconnected' });
  const refused = { ...replicaState, diagnostics: [{ code: 'session_unavailable', message: 'A native client owns this session.', recoverable: false }] };
  expect(conversationActivity(refused, 'unavailable')).toEqual({ connection: 'unavailable', error: 'A native client owns this session.' });
});

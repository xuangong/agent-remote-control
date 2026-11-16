import { expect, it } from 'vitest';
import type { AgentSnapshotPayload } from '@orchardworks/agent-remote-protocol';
import { AgentReplica } from '../replica/store.js';
import { remoteSessionState } from './session-state.js';

const snapshot = (): AgentSnapshotPayload => ({
  id: 'agent-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'native-1', status: 'idle' },
});

it('does not treat a refused session as recovering, so input is not held for a reconnect that will not happen', () => {
  expect(remoteSessionState(undefined, 'unavailable')).toMatchObject({ connection: 'unavailable', synchronized: false, recovering: false });
  expect(remoteSessionState(undefined, 'disconnected')).toMatchObject({ connection: 'disconnected', recovering: true });
});

it('holds rows while they came from the device or a replacement waits for its tail, and not once the connection confirmed them', () => {
  const replica = new AgentReplica();
  expect(remoteSessionState(replica.getState(), 'connecting').holdingRows).toBe(false);
  replica.restoreFromDevice({ snapshot: snapshot(), epoch: 'e1', nextSeq: 1, hasOlder: false, entries: [] });
  expect(remoteSessionState(replica.getState(), 'connecting').holdingRows).toBe(true);
  expect(remoteSessionState(undefined, 'connecting').holdingRows).toBe(false);
  replica.replaceTimeline('e2');
  expect(replica.getState().timeline.pendingEpoch).toBe('e2');
  expect(remoteSessionState(replica.getState(), 'catching_up').holdingRows).toBe(true);
});

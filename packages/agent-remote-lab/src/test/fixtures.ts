import type { AgentReplicaState } from '@orchardworks/agent-remote-web';

export const replicaState: AgentReplicaState = {
  agent: {
    id: 'agent-1',
    providerId: 'recorded',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:01.000Z',
    status: 'idle',
    activeTurn: null,
    capabilities: {
      history: true, sendMessage: true, steer: false, cancel: false, readResource: true,
      interactions: { question: true, planApproval: true, toolApproval: true },
    },
    pendingInteractions: [],
    runtimeInfo: {
      providerId: 'recorded', sessionId: 'recorded-session', status: 'idle',
      model: 'recorded-model', mode: 'deterministic',
    },
  },
  timeline: {
    epoch: 'epoch-1', initialized: true, entries: [], nextSeq: 7,
    hasOlder: true, pendingLive: [],
  },
  pendingInteractions: [],
  interactionRevision: 0,
  interactionChanges: {},
  resources: {},
  diagnostics: [],
  retiredEpochs: [],
};

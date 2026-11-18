import { useCallback, useSyncExternalStore } from 'react';

import type { AgentReplicaState } from '../replica/types.js';

export interface AgentReplicaStore {
  getState(): AgentReplicaState;
  subscribe(listener: () => void): () => void;
}

export function useAgentReplica(replica: AgentReplicaStore): AgentReplicaState {
  const subscribe = useCallback((listener: () => void) => replica.subscribe(listener), [replica]);
  const getSnapshot = useCallback(() => replica.getState(), [replica]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

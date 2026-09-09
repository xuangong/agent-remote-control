import type { AgentReplicaState } from './types.js';

export const selectAgent = (state: AgentReplicaState) => state.agent;
export const selectTimeline = (state: AgentReplicaState) => state.timeline;
export const selectPendingInteractions = (state: AgentReplicaState) => state.pendingInteractions;
export const selectResources = (state: AgentReplicaState) => state.resources;
export const selectDiagnostics = (state: AgentReplicaState) => state.diagnostics;

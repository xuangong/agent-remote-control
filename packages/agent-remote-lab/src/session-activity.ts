import type { AgentStatus } from '@orchardworks/agent-remote-protocol';
import type { AgentReplicaState } from '@orchardworks/agent-remote-web';

/** Pending input takes precedence over a turn that remains active while waiting. */
export function sessionActivity(state?: AgentReplicaState): AgentStatus | undefined {
  const agent = state?.agent;
  if (!agent) return undefined;
  if (agent.status === 'closed' || agent.status === 'failed') return agent.status;
  if (state.pendingInteractions.length || agent.status === 'waiting') return 'waiting';
  if (agent.activeTurn || agent.status === 'running') return 'running';
  return agent.status;
}

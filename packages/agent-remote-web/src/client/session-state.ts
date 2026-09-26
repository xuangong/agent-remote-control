import type { SessionHandoffState } from './session-control-extension.js';
import { sessionOperationAvailability, type AgentRuntimeInfo, type SessionOperationAvailability, type SessionOperationKind } from '@orchardworks/agent-remote-protocol';
import type { AgentReplicaState } from '../replica/types.js';
import type { RemoteSessionStatus } from './remote-session-client.js';

export interface RemoteSessionState {
  readonly handoff?: SessionHandoffState;
  readonly connection: RemoteSessionStatus;
  readonly synchronized: boolean;
  readonly runtime: AgentRuntimeInfo['connection'];
  readonly control: AgentReplicaState['sessionControl'];
  readonly operations: Readonly<Record<SessionOperationKind, SessionOperationAvailability>>;
}

const operations: readonly SessionOperationKind[] = ['send_message', 'queue_message', 'steer', 'cancel', 'set_planning', 'set_session_setting', 'execute_command', 'interaction_response'];

/** Public session facts for product composition, ARDB and non-rendered consumers. */
export function remoteSessionState(replica: AgentReplicaState, connection: RemoteSessionStatus): RemoteSessionState {
  const synchronized = connection === 'ready' && replica.agent !== null && replica.timeline.initialized;
  return {
    connection, synchronized,
    runtime: replica.agent ? replica.agent.runtimeInfo.connection ?? { state: 'connected' } : undefined,
    control: replica.sessionControl,
    operations: Object.fromEntries(operations.map(operation => [operation, sessionOperationAvailability(replica.agent, operation,
      { synchronized, control: replica.sessionControl?.access })])) as Record<SessionOperationKind, SessionOperationAvailability>,
  };
}

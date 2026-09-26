import type { SessionHandoffState } from './session-control-extension.js';
import { sessionOperationAvailability, type AgentStatus, type AgentRuntimeInfo, type SessionOperationAvailability, type SessionOperationKind } from '@orchardworks/agent-remote-protocol';
import type { AgentReplicaState } from '../replica/types.js';
import type { RemoteSessionStatus } from './remote-session-client.js';

export interface RemoteSessionState {
  readonly activity: AgentStatus | undefined;
  readonly busy: boolean;
  readonly controlChecking: boolean;
  readonly readOnly: boolean;
  readonly recovering: boolean;
  readonly handoff?: SessionHandoffState;
  readonly connection: RemoteSessionStatus;
  readonly synchronized: boolean;
  readonly runtime: AgentRuntimeInfo['connection'];
  readonly control: AgentReplicaState['sessionControl'];
  readonly operations: Readonly<Record<SessionOperationKind, SessionOperationAvailability>>;
}

const operations: readonly SessionOperationKind[] = ['send_message', 'queue_message', 'steer', 'cancel', 'set_planning', 'set_session_setting', 'execute_command', 'interaction_response'];

/** Public session facts for product composition, ARDB and non-rendered consumers. */
export function remoteSessionState(replica: AgentReplicaState | undefined, connection: RemoteSessionStatus): RemoteSessionState {
  const synchronized = connection === 'ready' && !!replica?.agent && replica.timeline.initialized;
  const activity = replica?.agent?.status;
  const runtime = replica?.agent ? replica.agent.runtimeInfo.connection ?? { state: 'connected' as const } : undefined;
  const control = replica?.sessionControl;
  const controlChecking = control?.access === 'checking';
  const readOnly = control !== undefined && !controlChecking && control.access !== 'control';
  return {
    connection, synchronized, activity,
    busy: activity === 'running' || activity === 'waiting', controlChecking, readOnly,
    recovering: !readOnly && runtime?.state !== 'unavailable' && (!synchronized || controlChecking || runtime?.state === 'reconnecting' || runtime?.state === 'restoring'),
    runtime, control,
    operations: Object.fromEntries(operations.map(operation => [operation, sessionOperationAvailability(replica?.agent ?? null, operation,
      { synchronized, control: control?.access })])) as Record<SessionOperationKind, SessionOperationAvailability>,
  };
}

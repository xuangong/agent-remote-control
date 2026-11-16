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
  /**
   * Rows are on screen that the connection has not confirmed as current: they came from this device's store, or a replacement is waiting for its tail.
   * While they are, the labels that say a session is opening, synchronizing or checking access give way to its last business label.
   */
  readonly holdingRows: boolean;
  readonly runtime: AgentRuntimeInfo['connection'];
  readonly control: AgentReplicaState['sessionControl'];
  readonly operations: Readonly<Record<SessionOperationKind, SessionOperationAvailability>>;
}

/** Rows are held that the connection has not confirmed as current: they came from this device's store, or a replacement waits for its tail. */
export function holdsUnconfirmedRows(replica: AgentReplicaState | undefined): boolean {
  return !!replica && (replica.timeline.restoredFromDevice === true || replica.timeline.pendingEpoch !== undefined);
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
  const holdingRows = holdsUnconfirmedRows(replica);
  return {
    connection, synchronized, holdingRows, activity,
    busy: activity === 'running' || activity === 'waiting', controlChecking, readOnly,
    recovering: !readOnly && connection !== 'unavailable' && runtime?.state !== 'unavailable' && (!synchronized || controlChecking || runtime?.state === 'reconnecting' || runtime?.state === 'restoring'),
    runtime, control,
    operations: Object.fromEntries(operations.map(operation => [operation, sessionOperationAvailability(replica?.agent ?? null, operation,
      { synchronized, control: control?.access })])) as Record<SessionOperationKind, SessionOperationAvailability>,
  };
}

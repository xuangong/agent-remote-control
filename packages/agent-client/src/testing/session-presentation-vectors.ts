import { PROTOCOL_VERSION, type AgentSnapshotPayload } from '@orchardworks/agent-remote-protocol';
import type { RemoteSessionStatus } from '../client/remote-session-client.js';
import { remoteSessionState } from '../client/session-state.js';
import type { ComposerAvailability, SessionFacts, SessionNotice } from '../client/session-presentation.js';
import { AgentReplica } from '../replica/store.js';
import type { AgentReplicaState } from '../replica/types.js';
import { buildEntry, buildSnapshot } from './builders.js';

/**
 * One table of what a person sees of a session, read by the rule module's tests and by every view that presents it
 * (`AgentActivityStatus`, `AgentComposer`, the lab's workbench). Each row is a session built from a replica and a
 * connection, with the notice, composer availability and activity label the rules give it.
 */

import { SESSION_CONNECTION_PATTERN } from './connection-words.js';
/** The T5 pattern, for the readers of the vector table. */
export const T5_PATTERN = SESSION_CONNECTION_PATTERN;

export const CONNECTIONS: readonly RemoteSessionStatus[] = ['idle', 'connecting', 'catching_up', 'ready', 'disconnected', 'unavailable'];

export type ControlFact = AgentReplicaState['sessionControl'];
export const CONTROL = {
  checking: { access: 'checking', available: true },
  granted: { access: 'control', available: true, revision: 'r1' },
  readOnly: { access: 'read_only', available: true, revision: 'r1' },
  nativeCli: { access: 'read_only', available: true, revision: 'r2', nativeOwner: { kind: 'native_cli', generation: 'g1' } },
  otherController: { access: 'read_only', available: true, revision: 'r2', nativeOwner: { kind: 'controller', generation: 'g1' } },
  writerElsewhere: { access: 'read_only', available: false, revision: 'r1', nativeRefusal: { reason: 'writer_elsewhere' } },
} as const satisfies Record<string, NonNullable<ControlFact>>;

export interface ReplicaFacts {
  /** The Snapshot's fields; undefined builds a replica that has seen no Snapshot. */
  readonly snapshot?: Partial<AgentSnapshotPayload>;
  /** The rows came from this device's store, not the Relay. */
  readonly restored?: boolean;
  readonly control?: ControlFact;
  readonly diagnostic?: { readonly message: string; readonly recoverable: boolean };
  /** A message the page sent that the session has not echoed. */
  readonly pendingSend?: string;
}

/** The replica state for the given facts. */
export function buildPresentationReplica(facts: ReplicaFacts = {}): AgentReplicaState {
  const replica = new AgentReplica();
  const snapshot = facts.snapshot ? buildSnapshot(facts.snapshot) : undefined;
  if (facts.restored && snapshot) replica.restoreFromDevice({ snapshot, epoch: 'e1', nextSeq: 3, hasOlder: false, entries: [buildEntry(1), buildEntry(2)] });
  else if (snapshot) {
    replica.applySnapshot({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: snapshot });
    replica.applyHistory({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
      requestId: 'page', agentId: snapshot.id, direction: 'tail', error: null, hasNewer: false, epoch: 'e1', reset: false, staleCursor: false, gap: false,
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 }, startCursor: { epoch: 'e1', seq: 1 }, endCursor: { epoch: 'e1', seq: 2 }, hasOlder: false,
      entries: [buildEntry(1), buildEntry(2)] } });
  }
  if (facts.control) replica.setSessionControl(facts.control);
  if (facts.diagnostic) replica.reportDiagnostic('test', facts.diagnostic.message, facts.diagnostic.recoverable);
  if (facts.pendingSend && snapshot) replica.beginMessage(snapshot.id, facts.pendingSend);
  return replica.getState();
}

/** The facts a view passes to the rules. */
export function buildSessionFacts(connection: RemoteSessionStatus, replica: ReplicaFacts | undefined, host?: SessionFacts['host']): SessionFacts {
  const state = replica ? buildPresentationReplica(replica) : undefined;
  return { session: remoteSessionState(state, connection), host, replica: state };
}

export interface SessionPresentationVector {
  readonly name: string;
  readonly facts: SessionFacts;
  readonly notice: SessionNotice | undefined;
  readonly composer: ComposerAvailability;
  readonly label: string | undefined;
}

type Status = AgentSnapshotPayload['status'];
type RuntimeConnection = NonNullable<AgentSnapshotPayload['runtimeInfo']['connection']>['state'];
/** Snapshot fields of a session in `status`; the runtime reports the same status, and `connection` when given. */
const agent = (status: Status, options: { connection?: RuntimeConnection; failure?: string; sendMessage?: boolean } = {}): Partial<AgentSnapshotPayload> => {
  const base = buildSnapshot();
  return {
    status, activeTurn: status === 'running' || status === 'waiting' ? { turnId: 't1', startedAt: '2026-11-15T00:00:00.000Z' } : null,
    runtimeInfo: { ...base.runtimeInfo, status, ...(options.connection ? { connection: { state: options.connection } } : {}), ...(options.failure ? { failure: { message: options.failure } } : {}) },
    ...(options.sendMessage === false ? { capabilities: { ...base.capabilities, sendMessage: false } } : {}),
  };
};
const idle = agent('idle'), running = agent('running');
const enabled = (dispatch: 'now' | 'when_ready'): ComposerAvailability => ({ input: 'enabled', dispatch });
const disabled = (reason: Extract<ComposerAvailability, { input: 'disabled' }>['reason'], words: string): ComposerAvailability => ({ input: 'disabled', reason, words });

export const SESSION_PRESENTATION_VECTORS: readonly SessionPresentationVector[] = [
  // 1. Every connection but `unavailable` (row 10), idle, control granted: only `ready` is synchronized and sends now.
  ...CONNECTIONS.filter(connection => connection !== 'unavailable').map(connection => ({
    name: `${connection}, idle, control granted`, facts: buildSessionFacts(connection, { snapshot: idle, control: CONTROL.granted }),
    notice: undefined, composer: enabled(connection === 'ready' ? 'now' : 'when_ready'), label: 'Ready' })),
  // 2. Nothing yet: no Snapshot while connecting.
  { name: 'connecting, no Snapshot', facts: buildSessionFacts('connecting', undefined), notice: undefined, composer: enabled('when_ready'), label: undefined },
  { name: 'ready, no Snapshot', facts: buildSessionFacts('ready', {}), notice: undefined, composer: enabled('when_ready'), label: undefined },
  // 3. Restored from this device while the Relay catches up and control is checked: the stored status speaks.
  { name: 'restored running turn, catching up, checking', facts: buildSessionFacts('catching_up', { snapshot: running, restored: true, control: CONTROL.checking }),
    notice: undefined, composer: enabled('when_ready'), label: 'Working' },
  { name: 'restored idle, connecting', facts: buildSessionFacts('connecting', { snapshot: idle, restored: true }), notice: undefined, composer: enabled('when_ready'), label: 'Ready' },
  { name: 'ready, granted, still checking a new revision', facts: buildSessionFacts('ready', { snapshot: idle, control: CONTROL.checking }), notice: undefined, composer: enabled('when_ready'), label: 'Ready' },
  // 4. A recovering runtime waits silently.
  { name: 'ready, runtime reconnecting', facts: buildSessionFacts('ready', { snapshot: agent('idle', { connection: 'reconnecting' }), control: CONTROL.granted }),
    notice: undefined, composer: enabled('when_ready'), label: 'Ready' },
  { name: 'ready, running, runtime restoring', facts: buildSessionFacts('ready', { snapshot: agent('running', { connection: 'restoring' }), control: CONTROL.granted }),
    notice: undefined, composer: enabled('when_ready'), label: 'Working' },
  // 5. An unavailable runtime is said once; sends wait (owner decision 1).
  { name: 'ready, runtime unavailable', facts: buildSessionFacts('ready', { snapshot: agent('idle', { connection: 'unavailable' }), control: CONTROL.granted }, { online: true, name: 'Mac mini' }),
    notice: { kind: 'agent_unavailable', message: 'The agent is not available on Mac mini.' }, composer: enabled('when_ready'), label: 'Ready' },
  // 6. An offline Host, whatever the connection: a notice, and the composer stays enabled.
  ...(['connecting', 'catching_up', 'disconnected'] as const).map(connection => ({
    name: `${connection}, Host offline`, facts: buildSessionFacts(connection, connection === 'connecting' ? undefined : { snapshot: idle, restored: true }, { online: false, name: 'Mac mini' }),
    notice: { kind: 'host_offline', hostName: 'Mac mini' } as const, composer: enabled('when_ready'), label: connection === 'connecting' ? undefined : 'Ready' })),
  { name: 'ready, Host offline, unnamed', facts: buildSessionFacts('ready', { snapshot: idle, control: CONTROL.granted }, { online: false }),
    notice: { kind: 'host_offline' }, composer: enabled('now'), label: 'Ready' },
  // 7. A native owner.
  { name: 'ready, a terminal has control', facts: buildSessionFacts('ready', { snapshot: idle, control: CONTROL.nativeCli }),
    notice: { kind: 'terminal_in_control' }, composer: disabled('terminal_in_control', 'Native CLI has control'), label: 'Native CLI has control' },
  { name: 'ready, another Controller has control', facts: buildSessionFacts('ready', { snapshot: running, control: CONTROL.otherController }),
    notice: { kind: 'other_controller' }, composer: disabled('other_controller', 'Another Controller has control'), label: 'Native control transferred' },
  // 8. Read-only, nobody owns it.
  { name: 'ready, read-only lease, no owner', facts: buildSessionFacts('ready', { snapshot: idle, control: CONTROL.readOnly }),
    notice: { kind: 'read_only' }, composer: disabled('read_only', 'Ready to take control'), label: 'Ready' },
  // 8b. The CLI refuses the Controller: another process writes the session (O48). Read-only with the CLI's reason, no take-over.
  { name: 'ready, the CLI refuses: a writer elsewhere', facts: buildSessionFacts('ready', { snapshot: idle, control: CONTROL.writerElsewhere }),
    notice: { kind: 'cli_refused', reason: 'writer_elsewhere' },
    composer: disabled('cli_refused', 'Another process is the active writer of this session, and its CLI lets one process write at a time. It stays readable here; retry once that process has finished.'), label: 'Ready' },
  // 9. Ended and failed.
  { name: 'ready, closed', facts: buildSessionFacts('ready', { snapshot: agent('closed'), control: CONTROL.granted }),
    notice: { kind: 'ended' }, composer: disabled('ended', 'This session has ended.'), label: 'Closed' },
  { name: 'ready, failed with a runtime failure', facts: buildSessionFacts('ready', { snapshot: agent('failed', { failure: 'Model quota exhausted.' }), control: CONTROL.granted }),
    notice: { kind: 'failed', message: 'Model quota exhausted.' }, composer: disabled('failed', 'Model quota exhausted.'), label: 'Agent failed' },
  // 10. Refused for good by the Relay.
  { name: 'unavailable, session deleted', facts: buildSessionFacts('unavailable', { snapshot: idle, diagnostic: { message: 'Session was deleted', recoverable: false } }),
    notice: { kind: 'unavailable', message: 'Session was deleted' }, composer: disabled('unavailable', 'Session was deleted'), label: undefined },
  { name: 'unavailable, no Snapshot, no reason', facts: buildSessionFacts('unavailable', undefined),
    notice: { kind: 'unavailable', message: 'This session is unavailable.' }, composer: disabled('unavailable', 'This session is unavailable.'), label: undefined },
  { name: 'connecting again, a stale refusal in the diagnostics', facts: buildSessionFacts('connecting', { snapshot: idle, diagnostic: { message: 'Protocol version is incompatible.', recoverable: false } }),
    notice: undefined, composer: enabled('when_ready'), label: 'Ready' },
  // 11. An agent that takes no messages.
  { name: 'ready, sendMessage unsupported', facts: buildSessionFacts('ready', { snapshot: agent('idle', { sendMessage: false }), control: CONTROL.granted }),
    notice: undefined, composer: disabled('unsupported', 'This agent does not take messages.'), label: 'Ready' },
  // 12. The link broke after `ready` while a send was on its way.
  { name: 'disconnected after ready, a send pending', facts: buildSessionFacts('disconnected', { snapshot: idle, control: CONTROL.granted, pendingSend: 'hello' }),
    notice: undefined, composer: enabled('when_ready'), label: 'Ready' },
  { name: 'disconnected, a recoverable diagnostic', facts: buildSessionFacts('disconnected', { snapshot: idle, control: CONTROL.granted, diagnostic: { message: 'Session synchronization timed out. Reconnecting.', recoverable: true } }),
    notice: undefined, composer: enabled('when_ready'), label: 'Ready' },
  // 13. Two business facts at once: the notice takes the first of the order (refused, failed, ended, Host offline, lease, runtime),
  // and the composer takes the first of its own reasons.
  { name: 'refused for good, and the agent had failed: the refusal speaks', facts: buildSessionFacts('unavailable', { snapshot: agent('failed', { failure: 'Model quota exhausted.' }), diagnostic: { message: 'Session was deleted', recoverable: false } }, { online: false, name: 'Mac mini' }),
    notice: { kind: 'unavailable', message: 'Session was deleted' }, composer: disabled('unavailable', 'Session was deleted'), label: undefined },
  { name: 'failed and the Host offline: the failure speaks', facts: buildSessionFacts('ready', { snapshot: agent('failed', { failure: 'Model quota exhausted.' }), control: CONTROL.granted }, { online: false, name: 'Mac mini' }),
    notice: { kind: 'failed', message: 'Model quota exhausted.' }, composer: disabled('failed', 'Model quota exhausted.'), label: 'Agent failed' },
  { name: 'failed and read-only: the failure speaks and blocks', facts: buildSessionFacts('ready', { snapshot: agent('failed', { failure: 'Model quota exhausted.' }), control: CONTROL.readOnly }),
    notice: { kind: 'failed', message: 'Model quota exhausted.' }, composer: disabled('failed', 'Model quota exhausted.'), label: 'Agent failed' },
  { name: 'closed and the Host offline: the end speaks', facts: buildSessionFacts('ready', { snapshot: agent('closed'), control: CONTROL.granted }, { online: false, name: 'Mac mini' }),
    notice: { kind: 'ended' }, composer: disabled('ended', 'This session has ended.'), label: 'Closed' },
  { name: 'closed and a terminal has control: the end speaks, the terminal words the label', facts: buildSessionFacts('ready', { snapshot: agent('closed'), control: CONTROL.nativeCli }),
    notice: { kind: 'ended' }, composer: disabled('ended', 'This session has ended.'), label: 'Native CLI has control' },
  { name: 'Host offline and a terminal has control: the Host speaks, the lease blocks', facts: buildSessionFacts('ready', { snapshot: idle, control: CONTROL.nativeCli }, { online: false, name: 'Mac mini' }),
    notice: { kind: 'host_offline', hostName: 'Mac mini' }, composer: disabled('terminal_in_control', 'Native CLI has control'), label: 'Native CLI has control' },
  { name: 'Host offline and the runtime unavailable: the Host speaks', facts: buildSessionFacts('ready', { snapshot: agent('idle', { connection: 'unavailable' }), control: CONTROL.granted }, { online: false, name: 'Mac mini' }),
    notice: { kind: 'host_offline', hostName: 'Mac mini' }, composer: enabled('when_ready'), label: 'Ready' },
  { name: 'read-only and the runtime unavailable: the lease speaks', facts: buildSessionFacts('ready', { snapshot: agent('idle', { connection: 'unavailable' }), control: CONTROL.readOnly }, { online: true, name: 'Mac mini' }),
    notice: { kind: 'read_only' }, composer: disabled('read_only', 'Ready to take control'), label: 'Ready' },
  { name: 'another Controller has control and the runtime unavailable: the lease speaks', facts: buildSessionFacts('ready', { snapshot: agent('idle', { connection: 'unavailable' }), control: CONTROL.otherController }, { online: true, name: 'Mac mini' }),
    notice: { kind: 'other_controller' }, composer: disabled('other_controller', 'Another Controller has control'), label: 'Native control transferred' },
  // 14. A read-only lease blocks before an agent that takes no messages does.
  { name: 'read-only and sendMessage unsupported: the lease blocks', facts: buildSessionFacts('ready', { snapshot: agent('idle', { sendMessage: false }), control: CONTROL.readOnly }),
    notice: { kind: 'read_only' }, composer: disabled('read_only', 'Ready to take control'), label: 'Ready' },
];

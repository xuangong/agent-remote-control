import type { AgentReplicaState } from '../replica/types.js';
import { leaseNoticeLabel, leaseView, type LeaseState } from './lease-view.js';
import type { RemoteSessionState } from './session-state.js';

/**
 * What a person sees of a session: its one business notice, whether the composer takes input and whether a send goes now,
 * and the activity label. Pure, with no clock. Every view reads these and none reads the connection phase, the control check,
 * the synchronization or the runtime's recovery for words or enablement (target T5; I1 plan, section 4.1).
 *
 * Rules:
 * - R1. Connection phase, control checking, synchronization, held rows and a recovering runtime never produce a notice, a
 *   disabled composer or a label of their own. They only decide whether a send goes now or waits.
 * - R2. The composer is disabled only for a business reason: read-only, a native owner, an ended or failed session,
 *   a session the Relay refused for good, or an agent that takes no messages.
 * - R3. A send goes now exactly when the session is synchronized, the control check is over and `send_message` is allowed.
 * - R4. An offline Host is a notice and leaves the composer enabled.
 * - R5. The words for a native owner come from `leaseNoticeLabel`.
 */

export interface SessionFacts {
  readonly session: RemoteSessionState;
  /** The session's Host as the Relay last said (SessionStatesView.host); undefined before it said anything. */
  readonly host?: { readonly online: boolean; readonly name?: string };
  /** The replica, read only for the words of a failure: the runtime failure and the last non-recoverable diagnostic. */
  readonly replica?: AgentReplicaState;
}

export type SessionNotice =
  | { readonly kind: 'host_offline'; readonly hostName?: string }
  | { readonly kind: 'ended' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'terminal_in_control' }
  | { readonly kind: 'other_controller' }
  | { readonly kind: 'read_only' }
  /** The Relay refused the session for good (`refuseDisconnected`), or a non-recoverable diagnostic. */
  | { readonly kind: 'unavailable'; readonly message: string }
  /** The adapter reports the native runtime unavailable. Sends wait (owner decision 1). */
  | { readonly kind: 'agent_unavailable'; readonly message: string };

export type ComposerBlock = 'read_only' | 'terminal_in_control' | 'other_controller' | 'ended' | 'failed' | 'unavailable' | 'unsupported';
export type ComposerAvailability =
  /** `dispatch: 'now'` when a send may go to the session at once; otherwise it waits in the send queue. */
  | { readonly input: 'enabled'; readonly dispatch: 'now' | 'when_ready' }
  | { readonly input: 'disabled'; readonly reason: ComposerBlock; readonly words: string };

const UNAVAILABLE = 'This session is unavailable.';
const FAILED = 'The agent failed without error details.';
const UNSUPPORTED = 'This agent does not take messages.';

function lastFailure(replica: AgentReplicaState | undefined): string | undefined {
  return [...(replica?.diagnostics ?? [])].reverse().find(diagnostic => !diagnostic.recoverable)?.message.trim() || undefined;
}

function leaseNotice(state: LeaseState): SessionNotice | undefined {
  return state === 'native_cli' ? { kind: 'terminal_in_control' }
    : state === 'other_controller' ? { kind: 'other_controller' }
    : state === 'read_only' ? { kind: 'read_only' } : undefined;
}

/** The one business notice of a session, or none. Never derived from connection phase, control checking or a recovering runtime. */
export function sessionNotice(facts: SessionFacts): SessionNotice | undefined {
  const { session, host, replica } = facts;
  const failure = lastFailure(replica);
  if (session.connection === 'unavailable') return { kind: 'unavailable', message: failure ?? UNAVAILABLE };
  if (session.connection === 'connecting' && failure) return { kind: 'unavailable', message: failure };
  if (session.activity === 'failed') {
    const agent = replica?.agent;
    return { kind: 'failed', message: agent?.runtimeInfo.failure?.message.trim() || agent?.lastError?.trim() || FAILED };
  }
  if (session.activity === 'closed') return { kind: 'ended' };
  if (host?.online === false) return host.name ? { kind: 'host_offline', hostName: host.name } : { kind: 'host_offline' };
  const lease = leaseNotice(leaseView(session.control).state);
  if (lease) return lease;
  if (session.runtime?.state === 'unavailable') return { kind: 'agent_unavailable', message: `The agent is not available on ${host?.name ?? 'its Host'}.` };
  return undefined;
}

/** Plain words for a notice, for example "Mac mini is offline. Messages will be delivered when it is back." */
export function sessionNoticeWords(notice: SessionNotice): string {
  switch (notice.kind) {
    case 'host_offline': return `${notice.hostName ?? 'The Host'} is offline. Messages will be delivered when it is back.`;
    case 'ended': return 'This session has ended.';
    case 'terminal_in_control': return leaseNoticeLabel('native_cli');
    case 'other_controller': return leaseNoticeLabel('other_controller');
    case 'read_only': return leaseNoticeLabel('read_only');
    case 'failed': case 'unavailable': case 'agent_unavailable': return notice.message;
  }
}

/** Whether the composer takes input, and whether a send goes now or waits. Only a business reason disables it. */
export function composerAvailability(facts: SessionFacts): ComposerAvailability {
  const { session } = facts;
  const notice = sessionNotice(facts);
  const blocking = session.connection === 'unavailable' || notice?.kind === 'failed' || notice?.kind === 'ended' ? notice
    : leaseNotice(leaseView(session.control).state);
  if (blocking) return { input: 'disabled', reason: blocking.kind as ComposerBlock, words: sessionNoticeWords(blocking) };
  if (facts.replica?.agent?.capabilities.sendMessage === false) return { input: 'disabled', reason: 'unsupported', words: UNSUPPORTED };
  // `send_message` is allowed only once the session is synchronized and its control check granted control (R3).
  const now = session.operations.send_message.allowed;
  return { input: 'enabled', dispatch: now ? 'now' : 'when_ready' };
}

/**
 * The business label of the activity line: Working, Waiting for response, Starting, Ready, Closed, Agent failed, the native
 * owner's words; undefined before any Snapshot and for a session the Relay refused.
 */
export function sessionActivityLabel(facts: SessionFacts, commandPending = false): string | undefined {
  const { session } = facts;
  // A session the Relay refused for good has no activity to report; its notice says why.
  if (session.activity === undefined || session.connection === 'unavailable') return undefined;
  const lease = leaseView(session.control).state;
  if (lease === 'native_cli') return leaseNoticeLabel('native_cli');
  if (lease === 'other_controller') return 'Native control transferred';
  switch (session.activity) {
    case 'failed': return 'Agent failed';
    case 'closed': return 'Closed';
    case 'waiting': return 'Waiting for response';
    case 'running': return 'Working';
    default: return commandPending ? 'Executing command' : session.activity === 'starting' ? 'Starting' : 'Ready';
  }
}

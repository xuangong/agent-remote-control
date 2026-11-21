import type { AgentReplicaState } from '../replica/types.js';
import { leaseNoticeLabel, leaseView, type NativeRefusalReason } from './lease-view.js';
import type { RemoteSessionState } from './session-state.js';
import { translator, type Locale, type Translate } from '../presentation/messages.js';
import { momentWords } from '../presentation/day-line.js';

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
 * - R6. A session the CLI refuses as a client (`cli_refused`: another process writes it) is read-only with the CLI's reason; its
 *   composer is disabled and nothing offers to take it over (O48).
 * - R7. The account's usage limit (`runtimeInfo.usageLimit`, gap 3) is a notice that says when it resets, and leaves the composer enabled;
 *   while the reset time is known and ahead of `now`, sends wait for it. A reset time that `now` has passed no longer limits.
 */

export interface SessionFacts {
  readonly session: RemoteSessionState;
  /** The session's Host as the Relay last said (SessionStatesView.host); undefined before it said anything. */
  readonly host?: { readonly online: boolean; readonly name?: string };
  /** The replica, read only for the words of a failure (the runtime failure and the last non-recoverable diagnostic) and the usage limit. */
  readonly replica?: AgentReplicaState;
  /** When the facts are read, in milliseconds since the epoch; without it a usage limit counts as long as the runtime reports it. */
  readonly now?: number;
}

export type SessionNotice =
  | { readonly kind: 'host_offline'; readonly hostName?: string }
  | { readonly kind: 'ended' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'terminal_in_control' }
  | { readonly kind: 'other_controller' }
  | { readonly kind: 'read_only' }
  /** The CLI refuses the Controller as a client of the session, for this reason (O48). */
  | { readonly kind: 'cli_refused'; readonly reason?: NativeRefusalReason }
  /** The Relay refused the session for good (`refuseDisconnected`), or a non-recoverable diagnostic. */
  | { readonly kind: 'unavailable'; readonly message: string }
  /** The adapter reports the native runtime unavailable. Sends wait (owner decision 1). */
  | { readonly kind: 'agent_unavailable'; readonly message: string }
  /** The account reached its usage limit, which resets at `resetsAt` when the CLI said; `now` is when it was read (R7). */
  | { readonly kind: 'usage_limited'; readonly resetsAt?: number; readonly now?: number };

/** The Host the notice names when the Relay gave none. */
const ITS_HOST = 'its Host';
const AGENT_UNAVAILABLE = /^The agent is not available on (.+)\.$/;

export type ComposerBlock = 'read_only' | 'terminal_in_control' | 'other_controller' | 'cli_refused' | 'ended' | 'failed' | 'unavailable' | 'unsupported';
export type ComposerAvailability =
  /** `dispatch: 'now'` when a send may go to the session at once; otherwise it waits in the send queue. */
  | { readonly input: 'enabled'; readonly dispatch: 'now' | 'when_ready' }
  | { readonly input: 'disabled'; readonly reason: ComposerBlock; readonly words: string };

const UNAVAILABLE = 'This session is unavailable.';
const FAILED = 'The agent failed without error details.';

function lastFailure(replica: AgentReplicaState | undefined): string | undefined {
  return [...(replica?.diagnostics ?? [])].reverse().find(diagnostic => !diagnostic.recoverable)?.message.trim() || undefined;
}

/** The usage limit that holds at `now` (R7). */
function usageLimit(facts: SessionFacts): { resetsAt?: number } | undefined {
  const limit = facts.replica?.agent?.runtimeInfo.usageLimit;
  return limit && !(limit.resetsAt !== undefined && facts.now !== undefined && limit.resetsAt <= facts.now) ? limit : undefined;
}

function leaseNotice(control: SessionFacts['session']['control']): SessionNotice | undefined {
  const { state, refusal } = leaseView(control);
  return state === 'native_cli' ? { kind: 'terminal_in_control' }
    : state === 'other_controller' ? { kind: 'other_controller' }
    : state === 'cli_refused' ? { kind: 'cli_refused', ...(refusal ? { reason: refusal } : {}) }
    : state === 'read_only' ? { kind: 'read_only' } : undefined;
}

/** The one business notice of a session, or none. Never derived from connection phase, control checking or a recovering runtime. */
export function sessionNotice(facts: SessionFacts): SessionNotice | undefined {
  const { session, host, replica } = facts;
  const failure = lastFailure(replica);
  // Only a refusal for good is a notice. Diagnostics outlive reconnects, so an older one never speaks for a later attempt.
  if (session.connection === 'unavailable') return { kind: 'unavailable', message: failure ?? UNAVAILABLE };
  if (session.activity === 'failed') {
    const agent = replica?.agent;
    return { kind: 'failed', message: agent?.runtimeInfo.failure?.message.trim() || agent?.lastError?.trim() || FAILED };
  }
  if (session.activity === 'closed') return { kind: 'ended' };
  if (host?.online === false) return host.name ? { kind: 'host_offline', hostName: host.name } : { kind: 'host_offline' };
  const lease = leaseNotice(session.control);
  if (lease) return lease;
  const limit = usageLimit(facts);
  if (limit) return { kind: 'usage_limited', ...(limit.resetsAt === undefined ? {} : { resetsAt: limit.resetsAt }), ...(facts.now === undefined ? {} : { now: facts.now }) };
  if (session.runtime?.state === 'unavailable') return { kind: 'agent_unavailable', message: `The agent is not available on ${host?.name ?? ITS_HOST}.` };
  return undefined;
}

/**
 * Plain words for a notice, for example "Mac mini is offline. Messages will be delivered when it is back." A usage limit's reset is said
 * in `locale`, as today, tomorrow or a date with the time.
 */
export function sessionNoticeWords(notice: SessionNotice, t: Translate = translator('en'), locale: Locale = 'en'): string {
  switch (notice.kind) {
    case 'host_offline': return t('client.notice.hostOffline', { host: notice.hostName ?? t('client.notice.theHost') });
    case 'ended': return t('client.notice.ended');
    case 'terminal_in_control': return leaseNoticeLabel('native_cli', t);
    case 'other_controller': return leaseNoticeLabel('other_controller', t);
    case 'read_only': return leaseNoticeLabel('read_only', t);
    case 'cli_refused': return leaseNoticeLabel('cli_refused', t, notice.reason);
    // The client's own default words are translated; a failure the agent, the Relay or a Controller described stays as sent.
    case 'failed': return notice.message === FAILED ? t('client.notice.failedNoDetails') : notice.message;
    case 'unavailable': return notice.message === UNAVAILABLE ? t('client.notice.unavailable') : notice.message;
    case 'agent_unavailable': {
      const host = AGENT_UNAVAILABLE.exec(notice.message)?.[1];
      return host === undefined ? notice.message : t('client.notice.agentUnavailable', { host: host === ITS_HOST ? t('client.notice.itsHost') : host });
    }
    case 'usage_limited': return notice.resetsAt === undefined ? t('client.notice.usageLimited')
      : t('client.notice.usageLimitedUntil', { time: momentWords(notice.resetsAt, notice.now ?? notice.resetsAt, locale, t) });
  }
}

/** Whether the composer takes input, and whether a send goes now or waits. Only a business reason disables it. */
export function composerAvailability(facts: SessionFacts, t: Translate = translator('en')): ComposerAvailability {
  const { session } = facts;
  const notice = sessionNotice(facts);
  const blocking = session.connection === 'unavailable' || notice?.kind === 'failed' || notice?.kind === 'ended' ? notice
    : leaseNotice(session.control);
  if (blocking) return { input: 'disabled', reason: blocking.kind as ComposerBlock, words: sessionNoticeWords(blocking, t) };
  if (facts.replica?.agent?.capabilities.sendMessage === false) return { input: 'disabled', reason: 'unsupported', words: t('client.notice.unsupported') };
  // A usage limit with a known reset holds sends until then (R7).
  if (usageLimit(facts)?.resetsAt !== undefined) return { input: 'enabled', dispatch: 'when_ready' };
  // `send_message` is allowed only once the session is synchronized and its control check granted control (R3).
  const now = session.operations.send_message.allowed;
  return { input: 'enabled', dispatch: now ? 'now' : 'when_ready' };
}

/**
 * The business label of the activity line: Working, Waiting for response, Starting, Ready, Closed, Agent failed, the native
 * owner's words; undefined before any Snapshot and for a session the Relay refused.
 */
export function sessionActivityLabel(facts: SessionFacts, commandPending = false, t: Translate = translator('en')): string | undefined {
  const { session } = facts;
  // A session the Relay refused for good has no activity to report; its notice says why.
  if (session.activity === undefined || session.connection === 'unavailable') return undefined;
  const lease = leaseView(session.control).state;
  if (lease === 'native_cli') return leaseNoticeLabel('native_cli', t);
  if (lease === 'other_controller') return t('client.activity.nativeTransferred');
  switch (session.activity) {
    case 'failed': return t('client.activity.failed');
    case 'closed': return t('client.activity.closed');
    case 'waiting': return t('client.activity.waiting');
    case 'running': return t('client.activity.working');
    default: return t(commandPending ? 'client.activity.executingCommand' : session.activity === 'starting' ? 'client.activity.starting' : 'client.activity.ready');
  }
}

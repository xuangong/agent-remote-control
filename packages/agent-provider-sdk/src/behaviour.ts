import type { AgentProviderDescriptor, AgentRuntimeErrorCode, AgentSessionInUseReason } from './provider.js';
import { AGENT_RUNTIME_ERROR_CODES, AGENT_SESSION_IN_USE_REASONS } from './provider.js';

/**
 * How a provider's native CLI behaves, declared by its adapter as data (`AgentProviderDescriptor.behaviour`). The Controller and the
 * session runtime apply one policy per declared field, never a branch on a provider id; the CLI simulator plays the same declaration;
 * the native checks compare it with the installed CLI. Onboarding a CLI means declaring these values, not changing the Controller.
 *
 * Contract.
 * - C1 A declaration states facts of the CLI at `verifiedVersion`: how it treats other clients of a session, what a reread of its history
 *   gives, what a resume costs and how long it may take, what it does with input, whether a running turn shows a heartbeat, how it signals
 *   a usage limit, which failures the adapter raises typed, and which kinds of items a reread cannot rebuild.
 * - C2 `resolveAgentProviderBehaviour` returns the descriptor's declaration when every field holds a value this contract names, and the
 *   undeclared behaviour otherwise: a declaration is taken whole or not at all, never completed field by field.
 * - C3 The undeclared behaviour is what the Controller assumed before declarations existed: it is the session's only client, a reread
 *   lists items in the live order, a resume is as expensive as a process start within the Relay's 30 s, input carries no identity and
 *   may be refused while busy, limits are not signalled, no failure is typed and no item is live-only.
 *
 * Pure: no clock, no I/O.
 */

/**
 * How the CLI treats a second client of one session.
 * - `single_writer`: one writer at a time; another is refused (`AgentSessionInUseError`, reason `writer_elsewhere`).
 * - `shared_clients`: the clients share the loaded session, the CLI orders their turns, and each sees the others' turns.
 * - `fork_on_divergence`: nothing coordinates writers; two writes at once fork the history.
 * - `none`: the session has no client but this one (a private runtime).
 */
export type AgentConcurrencyModel = 'single_writer' | 'shared_clients' | 'fork_on_divergence' | 'none';
export const AGENT_CONCURRENCY_MODELS: readonly AgentConcurrencyModel[] = ['single_writer', 'shared_clients', 'fork_on_divergence', 'none'];

/**
 * Kinds of items a reread of native history cannot rebuild; the adapter marks each such observation `itemIdentity.liveOnly`.
 * `synthetic_output` is what a local command prints, `partial_output` the text a turn streamed before it was interrupted.
 */
export type AgentLiveOnlyKind = 'interaction' | 'todo' | 'error' | 'startup_notice' | 'reasoning' | 'synthetic_output' | 'partial_output';
export const AGENT_LIVE_ONLY_KINDS: readonly AgentLiveOnlyKind[] = ['interaction', 'todo', 'error', 'startup_notice', 'reasoning', 'synthetic_output', 'partial_output'];

export interface AgentConcurrencyBehaviour {
  readonly model: AgentConcurrencyModel;
  /** How another writer is detected: the CLI says so, a lock file shows it, or nothing does. */
  readonly probe: 'native' | 'lock_file' | 'none';
  /** Whether another client's turns reach this attachment: live, only once history is read again, or never. */
  readonly othersVisible: 'live' | 'on_reread' | 'never';
  /** The CLI keeps a session loaded this long after its last client leaves, and refuses a writer outside its clients meanwhile. */
  readonly unloadAfterLastClientMs?: number;
}

export interface AgentRereadBehaviour {
  /** A reread lists items in the order the live stream showed them, or may permute the complete siblings of one turn. */
  readonly order: 'live' | 'siblings_unordered';
  /** How native history is paged. */
  readonly paging: 'turns' | 'messages' | 'none';
  /** History can be read without attaching the session, so without becoming one of its clients. */
  readonly withoutAttach: boolean;
  /** What one read costs: one page, or the whole session. */
  readonly cost: 'page' | 'whole_session';
}

export interface AgentResumeBehaviour {
  /** What attaching a session costs: a subscription to a running server, a call into a shared process, or a process of its own. */
  readonly cost: 'subscription' | 'shared_process' | 'process';
  /** How long a healthy resume takes at most; a resume that takes longer is a fault. */
  readonly deadlineMs: number;
}

export interface AgentInputBehaviour {
  /** The CLI keeps the client's input id, so a reread can prove whether an input arrived. */
  readonly identity: 'echoes_client_id' | 'none';
  /** What the CLI does with input while a turn runs. */
  readonly whileBusy: 'steer' | 'queue' | 'refuse';
}

export interface AgentTurnBehaviour {
  /**
   * The adapter shows that a running turn is alive at least this often, and itself ends a turn whose CLI stops answering (typed
   * `native_unresponsive`). Absent: a turn may be silent for any time, as through a long command, and the Controller watches it.
   */
  readonly heartbeatMs?: number;
}

export interface AgentProviderBehaviour {
  readonly concurrency: AgentConcurrencyBehaviour;
  readonly reread: AgentRereadBehaviour;
  readonly resume: AgentResumeBehaviour;
  readonly input: AgentInputBehaviour;
  /** How a running turn shows it is alive; absent like an empty one, a turn without a heartbeat. */
  readonly turn?: AgentTurnBehaviour;
  /** How the CLI signals a usage or rate limit: an event in the stream, an error, or not at all. */
  readonly limits: { readonly signal: 'event' | 'error' | 'none' };
  /** The failures the adapter recognises and raises typed (`AgentRuntimeError` codes, `AgentSessionInUseError` reasons); others are generic. */
  readonly failures: { readonly runtime: readonly AgentRuntimeErrorCode[]; readonly inUse: readonly AgentSessionInUseReason[] };
  /** The kinds of items that carry `itemIdentity.liveOnly`. */
  readonly liveOnly: readonly AgentLiveOnlyKind[];
  /** The CLI version the native checks last confirmed this declaration against. */
  readonly verifiedVersion?: string;
}

/** C3: what an adapter that declares nothing is taken to do. */
export const UNDECLARED_PROVIDER_BEHAVIOUR: AgentProviderBehaviour = Object.freeze({
  concurrency: Object.freeze({ model: 'none', probe: 'none', othersVisible: 'never' }),
  reread: Object.freeze({ order: 'live', paging: 'none', withoutAttach: false, cost: 'whole_session' }),
  resume: Object.freeze({ cost: 'process', deadlineMs: 30_000 }),
  input: Object.freeze({ identity: 'none', whileBusy: 'refuse' }),
  limits: Object.freeze({ signal: 'none' }),
  failures: Object.freeze({ runtime: Object.freeze([]), inUse: Object.freeze([]) }),
  liveOnly: Object.freeze([]),
}) as AgentProviderBehaviour;

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const oneOf = <T>(value: unknown, allowed: readonly T[]): value is T => allowed.includes(value as T);
const listOf = <T>(value: unknown, allowed: readonly T[]): value is readonly T[] => Array.isArray(value) && value.every(entry => oneOf(entry, allowed));
const duration = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/** Whether every field of a declaration holds a value this contract names (C2). */
export function validAgentProviderBehaviour(value: unknown): value is AgentProviderBehaviour {
  if (!record(value)) return false;
  const { concurrency, reread, resume, input, turn, limits, failures, liveOnly, verifiedVersion } = value;
  return record(concurrency) && oneOf(concurrency.model, AGENT_CONCURRENCY_MODELS) && oneOf(concurrency.probe, ['native', 'lock_file', 'none'])
    && oneOf(concurrency.othersVisible, ['live', 'on_reread', 'never'])
    && (concurrency.unloadAfterLastClientMs === undefined || duration(concurrency.unloadAfterLastClientMs))
    && record(reread) && oneOf(reread.order, ['live', 'siblings_unordered']) && oneOf(reread.paging, ['turns', 'messages', 'none'])
    && typeof reread.withoutAttach === 'boolean' && oneOf(reread.cost, ['page', 'whole_session'])
    && record(resume) && oneOf(resume.cost, ['subscription', 'shared_process', 'process']) && duration(resume.deadlineMs)
    && record(input) && oneOf(input.identity, ['echoes_client_id', 'none']) && oneOf(input.whileBusy, ['steer', 'queue', 'refuse'])
    && (turn === undefined || record(turn) && (turn.heartbeatMs === undefined || duration(turn.heartbeatMs)))
    && record(limits) && oneOf(limits.signal, ['event', 'error', 'none'])
    && record(failures) && listOf(failures.runtime, AGENT_RUNTIME_ERROR_CODES) && listOf(failures.inUse, AGENT_SESSION_IN_USE_REASONS)
    && listOf(liveOnly, AGENT_LIVE_ONLY_KINDS)
    && (verifiedVersion === undefined || typeof verifiedVersion === 'string' && verifiedVersion.length > 0);
}

/** C2: the declared behaviour of a provider, or the undeclared one when it declares none or misdeclares any field. */
export function resolveAgentProviderBehaviour(descriptor: Pick<AgentProviderDescriptor, 'behaviour'>): AgentProviderBehaviour {
  return validAgentProviderBehaviour(descriptor.behaviour) ? descriptor.behaviour : UNDECLARED_PROVIDER_BEHAVIOUR;
}

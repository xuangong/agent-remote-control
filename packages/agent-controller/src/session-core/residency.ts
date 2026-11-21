import type { AgentProviderBehaviour } from '@orchardworks/agent-provider-sdk';

/**
 * Residency: whether the Controller keeps a session attached to its CLI, and how long it waits once nothing needs it. Visibility is the
 * rule: a session a page shows stays resident and live; a session no page shows is let go after a short grace, so the Controller never
 * holds a CLI's session longer than the pages need it.
 *
 * Contract.
 * - R1 A session a page shows is kept, whatever else is true of it.
 * - R2 A session an operation or a Controller stream holds is kept, and so is one that cannot be released now (something runs for it, an
 *   outcome is unsettled, its directory or runtime refuses).
 * - R3 A session that nothing keeps waits for its release grace, counted from the last moment something kept it, and is released once
 *   the whole grace has passed: at the grace, not a millisecond before.
 * - R4 The release grace is keyed on the provider's declared behaviour, never on its id. A CLI that keeps a session loaded after its
 *   last client (`concurrency.unloadAfterLastClientMs`) re-attaches cheaply within that time, so the grace only absorbs a page that
 *   reloads or moves: `PAGE_RETURN_GRACE_MS`. Otherwise the grace grows with what a resume costs: a subscription to a running server, a
 *   call into a shared process, a process of its own (which keeps today's five minutes, as does an adapter that declares nothing).
 *
 * Pure: the facts and the time are the caller's.
 */
export type ResidencyDecision = 'keep' | 'wait' | 'release';

export interface ResidencyFacts {
  /** A page shows the session: the Relay serves a page's conversation of it. */
  shown: boolean;
  /** An operation or a Controller stream holds it. */
  held: boolean;
  /** Nothing runs for it, nothing of it is unsettled, and its directory and runtime allow a release. */
  releasable: boolean;
  /** How long nothing has kept it. */
  unkeptMs: number;
  /** Its release grace (`releaseGraceMs`). */
  graceMs: number;
}

export function decideResidency(facts: ResidencyFacts): ResidencyDecision {
  if (facts.shown || facts.held || !facts.releasable) return 'keep';
  return facts.unkeptMs >= facts.graceMs ? 'release' : 'wait';
}

/** The grace that covers a page reloading or moving, for a CLI that keeps a session loaded after its last client itself. */
export const PAGE_RETURN_GRACE_MS = 10_000;
/** The grace for each resume cost, when the CLI does not keep a session loaded after its last client. */
export const RESUME_COST_GRACE_MS: Readonly<Record<AgentProviderBehaviour['resume']['cost'], number>> = {
  subscription: 15_000,
  shared_process: 60_000,
  process: 5 * 60_000,
};

export function releaseGraceMs(behaviour: Pick<AgentProviderBehaviour, 'concurrency' | 'resume'>): number {
  return behaviour.concurrency.unloadAfterLastClientMs === undefined ? RESUME_COST_GRACE_MS[behaviour.resume.cost] : PAGE_RETURN_GRACE_MS;
}

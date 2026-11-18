import type { FamilyBinding } from './family.js';

/**
 * Idle release: when a session nobody holds may give up its runtime, and when it may be checked first.
 *
 * Contract.
 * - `mayReleaseIdle` is true only when the Controller is open, the session's idle state is certain, its binding is complete, its provider's
 *   directory allows the release, its runtime says it can be released idle, and no child bound under it has a runtime or a holder (a native
 *   child projection shares its ancestor's connection, even with no browser attached).
 * - `mayReconcileIdle` is the part that precedes a check of an uncertain session: the directory can reconcile, the runtime can be released idle,
 *   and no child is held. The check itself (and the uncertainty it clears) is the caller's.
 * - `hasHeldChild` looks at the bindings of one provider only.
 *
 * Pure: the facts are read by the caller.
 */
export function hasHeldChild(bindings: Iterable<FamilyBinding>, parent: FamilyBinding, held: (child: FamilyBinding) => boolean): boolean {
  for (const child of bindings) {
    if (child.providerId === parent.providerId && child.parentNativeSessionId === parent.nativeSessionId && held(child)) return true;
  }
  return false;
}

export interface IdleReleaseFacts {
  closed: boolean;
  /** An operation of the session is unsettled, or a family check began and did not finish. */
  uncertain: boolean;
  /** The binding is still being made. */
  pending: boolean;
  directoryCanRelease: boolean;
  runtimeCanReleaseIdle: boolean;
  childHeld: boolean;
}

export function mayReleaseIdle(facts: IdleReleaseFacts): boolean {
  if (facts.closed || facts.uncertain || facts.pending) return false;
  if (!facts.directoryCanRelease || !facts.runtimeCanReleaseIdle) return false;
  return !facts.childHeld;
}

export interface IdleReconcileFacts { directoryCanReconcile: boolean; runtimeCanReleaseIdle: boolean; childHeld: boolean }

export function mayReconcileIdle(facts: IdleReconcileFacts): boolean {
  return facts.directoryCanReconcile && facts.runtimeCanReleaseIdle && !facts.childHeld;
}

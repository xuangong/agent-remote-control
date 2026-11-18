/**
 * The one rule of when a device's stored rows may be shown: only while the person's lease is valid. A lease is valid while the Relay has confirmed it, or while
 * the end of the lease the Relay last reported has not passed and the Relay has not yet answered again. It is not valid after a refusal (401 or 403, which also purges
 * the records), while an expired lease is being confirmed again, or after the workspace was retired. A Relay without accounts has no gate and one person.
 */
export interface DisplayLeaseGate {
  /** The Relay confirmed the lease. */
  readonly ready: boolean;
  /** The local copy of the lease ran out and the Relay is being asked. */
  readonly confirming?: boolean;
  readonly retired?: boolean;
  /** The end of the lease the Relay last reported, in milliseconds; absent after a refusal. */
  readonly optimisticUntil?: number;
}

export function displayLeaseValid(gate: DisplayLeaseGate | undefined, now: number): boolean {
  if (!gate) return true;
  if (gate.retired) return false;
  if (gate.ready) return !gate.confirming;
  return gate.optimisticUntil !== undefined && now < gate.optimisticUntil;
}

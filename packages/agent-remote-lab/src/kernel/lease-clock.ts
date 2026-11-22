/**
 * Purpose: turn the Relay's absolute lease expiry into the lease's deadline on this device's clock.
 *
 * `expiresAt` is a moment on the Relay's clock. A device whose clock differs from the Relay's would otherwise see every
 * answer as already expired (clock ahead) or renew too late (clock behind). The answer's own time, the HTTP `Date`
 * header, tells the skew: device time at receipt minus the Relay's time when it answered.
 *
 * Contract: a skew within `LEASE_CLOCK_TOLERANCE_MS` (header resolution is 1 s, plus latency) is ignored, so a device
 * whose clock agrees with the Relay's keeps the Relay's `expiresAt` unchanged. A larger skew moves the deadline by the
 * skew. A missing or unparseable header means no correction. A lease that had already ended on the Relay's clock
 * never ends later than the moment of receipt.
 */
export const LEASE_CLOCK_TOLERANCE_MS = 5000;

export interface LeaseAnswerTimes {
  /** The Relay's absolute lease expiry, in epoch milliseconds on the Relay's clock. */
  expiresAt: number;
  /** The answer's `Date` header as received; may be absent or malformed. */
  relayDate: string | null | undefined;
  /** This device's `Date.now()` when the answer arrived. */
  receivedAt: number;
}

export function leaseDeadlineOnDeviceClock({ expiresAt, relayDate, receivedAt }: LeaseAnswerTimes): number {
  const relayNow = relayDate ? Date.parse(relayDate) : NaN;
  if (!Number.isFinite(relayNow)) return expiresAt;
  if (expiresAt <= relayNow) return Math.min(expiresAt, receivedAt);
  const skew = receivedAt - relayNow;
  return Math.abs(skew) <= LEASE_CLOCK_TOLERANCE_MS ? expiresAt : expiresAt + skew;
}

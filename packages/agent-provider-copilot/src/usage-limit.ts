import type { SessionEvent } from '@github/copilot-sdk';

/**
 * Copilot's usage limits, as `@github/copilot-sdk` 1.0.11 states them (`dist/generated/session-events.d.ts`): a `session.error` whose
 * `errorType` is `rate_limit` or `quota` is the account's limit, and carries no reset time; an `auto_mode_switch.requested` that may follow
 * a rate-limit error says `retryAfterSeconds`, the seconds until the limit resets, when known.
 *
 * Pure.
 */
export function copilotUsageLimited(event: SessionEvent): boolean {
  return event.type === 'session.error' && (event.data.errorType === 'rate_limit' || event.data.errorType === 'quota');
}

/** When the limit resets, in milliseconds since the epoch, from an event that says how many seconds remain. */
export function copilotLimitResetsAt(event: SessionEvent): number | undefined {
  if (event.type !== 'auto_mode_switch.requested') return undefined;
  const seconds = event.data.retryAfterSeconds, at = Date.parse(event.timestamp);
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 && Number.isFinite(at) ? at + Math.round(seconds * 1000) : undefined;
}

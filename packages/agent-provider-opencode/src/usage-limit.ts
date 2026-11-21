import type { SessionStructuredError } from '@opencode/client';

/**
 * OpenCode's usage limits, as `@opencode/schema` 2.0.25 states them (`dist/session-event.js`, `dist/session-error.js`): an error is
 * `Session.StructuredError { type, message, status?, response? }`, whose `status` is the model provider's HTTP status, 429 for a usage or
 * rate limit; `session.retry.scheduled { attempt, at, error }` says the server retries the turn itself at `at`, in milliseconds since the
 * epoch, as every OpenCode time is.
 *
 * Pure.
 */
export function openCodeUsageLimited(error: Pick<SessionStructuredError, 'status'> | undefined): boolean {
  return error?.status === 429;
}

/** The usage limit a scheduled retry reports: until the retry, when the server says when. */
export function openCodeRetryLimit(at: number): { resetsAt?: number } {
  return Number.isSafeInteger(at) && at > 0 ? { resetsAt: at } : {};
}

import { isRecord, readString } from './native.js';

/**
 * Codex's usage limits, as its app-server protocol states them (codex-cli 0.171.0, `codex app-server generate-ts`, `v2/TurnError.ts`,
 * `v2/CodexErrorInfo.ts`, `v2/RateLimitSnapshot.ts`, `v2/RateLimitWindow.ts`):
 * - a turn the account's limit stopped fails with `turn.error.codexErrorInfo` `usageLimitExceeded` or `rateLimitExceeded`;
 * - `account/rateLimits/updated` carries a sparse `RateLimitSnapshot` of one limit (`limitId`), whose `primary` and `secondary` windows
 *   say how much is used (`usedPercent`) and when the window resets (`resetsAt`, seconds since the epoch). A window the update leaves
 *   null keeps the last one known.
 *
 * Pure: the caller keeps the windows.
 */
export interface CodexRateLimitWindow { readonly usedPercent: number; readonly resetsAt?: number }
/** The windows known of each limit, by `limitId`. */
export type CodexRateLimits = ReadonlyMap<string, { readonly primary?: CodexRateLimitWindow; readonly secondary?: CodexRateLimitWindow }>;

const LIMIT_ERRORS = new Set(['usageLimitExceeded', 'rateLimitExceeded']);

/** Whether a turn's error says the account's usage or rate limit stopped it. */
export function codexUsageLimited(error: unknown): boolean {
  return isRecord(error) && typeof error.codexErrorInfo === 'string' && LIMIT_ERRORS.has(error.codexErrorInfo);
}

function readWindow(value: unknown): CodexRateLimitWindow | undefined {
  if (!isRecord(value) || typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent)) return undefined;
  const resetsAt = value.resetsAt;
  return { usedPercent: value.usedPercent, ...(Number.isSafeInteger(resetsAt) && (resetsAt as number) > 0 ? { resetsAt: resetsAt as number } : {}) };
}

/** The windows after an `account/rateLimits/updated`: the update's windows replace the known ones of its limit, and a missing one is kept. */
export function mergeCodexRateLimits(known: CodexRateLimits, params: unknown): CodexRateLimits {
  const snapshot = isRecord(params) && isRecord(params.rateLimits) ? params.rateLimits : undefined;
  if (!snapshot) return known;
  const limitId = readString(snapshot.limitId) ?? '';
  const previous = known.get(limitId) ?? {};
  const primary = readWindow(snapshot.primary) ?? previous.primary, secondary = readWindow(snapshot.secondary) ?? previous.secondary;
  return new Map([...known, [limitId, { ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) }]]);
}

/** When the limit that stopped a turn resets, in milliseconds since the epoch: the latest reset of a window used up, if any is known. */
export function codexLimitResetsAt(limits: CodexRateLimits): number | undefined {
  let latest: number | undefined;
  for (const { primary, secondary } of limits.values()) {
    for (const window of [primary, secondary]) {
      if (window && window.usedPercent >= 100 && window.resetsAt !== undefined) latest = Math.max(latest ?? 0, window.resetsAt * 1000);
    }
  }
  return latest;
}

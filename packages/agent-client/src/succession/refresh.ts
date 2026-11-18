/**
 * Refresh and recovery of succession evidence: what a page does when it asks the Relay for the committed replays of its
 * conversations and the answer is late, missing or unreachable. Pure: `reduceRefresh(state, event)` returns the next state and
 * the effects the shell must run, as data. The shell owns the requests, the timer and the evidence maps; this owns the rules.
 *
 * Rules:
 * - A discovery that succeeds confirms the evidence it read: the page has authoritative locators, nothing is stale, the retry
 *   backoff starts over and any waiting retry is cancelled.
 * - A discovery that cannot reach the Relay (the network failed or the browser is offline; a timeout is not that) after an
 *   earlier success, and that was not told by a notification that locators changed, restores the confirmed evidence and marks
 *   it stale: views stay attached, input waits. It retries after 1, 2, 5, 10, then every 30 seconds.
 * - A Relay that answers 404 or has no such route, on a page with nothing desired and no role, does not support succession:
 *   the page navigates by fixed locators and discovers again once.
 * - Any other failure is reported, and the page waits for a fresh answer; a view that was already invalid stays discovered.
 * - Another authority (a different account or access state) discards the evidence the previous one confirmed.
 * - A composition that a local edit overtook while it was being applied (`retired`, `local_edit`, `owner_edit`) did not fail: the
 *   document it applied is no longer the current one. The page discovers again, so the newer document is applied; after
 *   `maxSupersededRetries` consecutive overtaken applications it stops and leaves the explicit Retry. An applied composition
 *   starts the count over.
 */
export interface RefreshState {
  /** Authoritative evidence has been read, or restored as stale. */
  discovered: boolean;
  /** The evidence in use is the last confirmed one, restored because the Relay was unreachable. */
  evidenceStale: boolean;
  /** Retries scheduled since the evidence went stale; the backoff index. */
  staleAttempts: number;
  /** The Relay has no succession routes. */
  unsupported: boolean;
  /** Applications overtaken by an edit in a row, since the last applied one. */
  supersededAttempts: number;
}
export const initialRefreshState: RefreshState = { discovered: false, evidenceStale: false, staleAttempts: 0, unsupported: false, supersededAttempts: 0 };

/** Results of an application that a local edit overtook, as opposed to one that failed. */
export const supersededCodes: readonly string[] = ['retired', 'local_edit', 'owner_edit'];
export const maxSupersededRetries = 5;

/** Delays before refreshing locators restored from an unreachable Relay. */
export const staleRetryDelays: readonly number[] = [1000, 2000, 5000, 10000, 30000];

/** How long each wait of the succession flow lasts before it gives up. */
export const successionDeadlines = {
  /** One discovery request. */
  discoveryRequest: 20000,
  /** Waiting for a refresh that follows a Handoff to settle, and for discoveries that restart meanwhile. */
  refresh: 20000,
  /** Waiting for the confirmed native session to bind and synchronize after a refresh. */
  nativeConfirmation: 16000,
  /** One attach of a native session. */
  attach: 15000,
  /** How long a view keeps its previous native connection while the next one attaches. */
  navigationLease: 20000,
} as const;

export type DiscoveryFailure = { kind: 'unreachable' | 'timeout' | 'other'; code?: string; message?: string };

/**
 * Why a request failed, as a refresh needs it. `unreachable`: it never reached the Relay (a network error, or the browser is
 * offline). A timeout is not: a slow Relay that is online may be answering with a succession this page has not seen yet.
 */
export function classifyFailure(error: unknown, online: boolean | undefined): DiscoveryFailure {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
  const message = error instanceof Error ? error.message : undefined;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'TimeoutError') return { kind: 'timeout', code, message };
  if (code === 'network_error' || online === false) return { kind: 'unreachable', code, message };
  return { kind: 'other', code, message };
}

export type RefreshEvent =
  | { type: 'discovery_succeeded' }
  | { type: 'discovery_failed'; failure: DiscoveryFailure;
    /** A succession notification or favorites progress said locators changed: never fall back to old ones. */
    notified: boolean;
    /** The replay pages were read; the failure came after. */
    replayRead: boolean; hasConfirmedEvidence: boolean; hasDesired: boolean; hasRoles: boolean;
    /** The selected view no longer matches its session; that stays discovered and keeps its own error. */
    invalidView: boolean }
  | { type: 'composition_applied' }
  | { type: 'composition_pending'; code: string }
  | { type: 'stale_retry_due'; evidenceStale: boolean }
  | { type: 'authority_changed' };

export type RefreshEffect =
  | { type: 'restore_confirmed_evidence' }
  | { type: 'schedule_stale_retry'; delayMs: number }
  | { type: 'cancel_stale_retry' }
  /** Discover again on the next microtask. */
  | { type: 'rediscover' }
  /** Show the error, and unless the view was invalid, mark the replays unavailable. */
  | { type: 'report_failure'; message: string; keepResult: boolean };

/** `delays` are the waits before refreshing locators restored from an unreachable Relay; they are an input so a test need not wait them out. */
export function reduceRefresh(state: RefreshState, event: RefreshEvent, delays: readonly number[] = staleRetryDelays): { state: RefreshState; effects: RefreshEffect[] } {
  switch (event.type) {
    case 'discovery_succeeded':
      return { state: { ...state, discovered: true, evidenceStale: false, staleAttempts: 0 }, effects: [{ type: 'cancel_stale_retry' }] };
    case 'authority_changed':
      return { state: { ...state, discovered: false, evidenceStale: false, staleAttempts: 0 }, effects: [{ type: 'cancel_stale_retry' }] };
    case 'composition_applied':
      return { state: { ...state, supersededAttempts: 0 }, effects: [] };
    case 'composition_pending':
      if (!supersededCodes.includes(event.code) || state.supersededAttempts >= maxSupersededRetries) return { state, effects: [] };
      return { state: { ...state, supersededAttempts: state.supersededAttempts + 1 }, effects: [{ type: 'rediscover' }] };
    case 'stale_retry_due':
      return { state, effects: event.evidenceStale ? [{ type: 'rediscover' }] : [] };
    case 'discovery_failed': {
      const { failure } = event;
      if (!event.hasDesired && !event.hasRoles && failure.code !== undefined && ['http_404', 'route_not_found'].includes(failure.code)) {
        return { state: { ...state, unsupported: true }, effects: [{ type: 'rediscover' }] };
      }
      if (!event.notified && !event.replayRead && event.hasConfirmedEvidence && failure.kind === 'unreachable') {
        const delayMs = delays[Math.min(state.staleAttempts, delays.length - 1)]!;
        return { state: { ...state, discovered: true, evidenceStale: true, staleAttempts: state.staleAttempts + 1 },
          effects: [{ type: 'restore_confirmed_evidence' }, { type: 'cancel_stale_retry' }, { type: 'schedule_stale_retry', delayMs }] };
      }
      return { state: event.invalidView ? { ...state, discovered: true } : state,
        effects: [{ type: 'report_failure', message: failure.message ?? 'Session succession could not be recovered.', keepResult: event.invalidView }] };
    }
  }
}

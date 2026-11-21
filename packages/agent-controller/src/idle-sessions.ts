import { decideResidency } from './session-core/residency.js';

interface Entry {
  users: number;
  /** A page shows the session (`show`). */
  shown: boolean;
  /** Its release grace, or the default one. */
  graceMs: number;
  idleSince: number;
  safe(): boolean;
  release(): Promise<void>;
  releasing?: Promise<void>;
  dormant: boolean;
  checking?: boolean;
  revision: number;
  retryAt: number;
  failures: number;
  reconcile?: (isCurrent: () => boolean) => Promise<boolean>;
}

/**
 * Idle sessions: which sessions keep their runtime, and when one that nothing keeps is released. The decision is the residency rule
 * (`session-core/residency.ts`): a session a page shows or something holds is kept; one that nothing keeps is released after its own
 * release grace (`watch`), or the default grace. Host-local leases and the shown state survive uplink replacement; elapsed grace uses a
 * monotonic clock.
 */
export function createIdleSessions(options: { graceMs?: number; reconcileMs?: number } = {}) {
  const graceMs = options.graceMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(graceMs) || graceMs < 1) throw new RangeError('Idle grace must be a positive integer.');
  const reconcileMs = options.reconcileMs ?? 60_000;
  if (!Number.isSafeInteger(reconcileMs) || reconcileMs < 1) throw new RangeError('Idle reconciliation interval must be a positive integer.');
  let reconciling: Promise<void> | undefined;
  const reset = (entry: Entry) => {
    entry.revision++;
    entry.idleSince = performance.now();
    entry.retryAt = entry.idleSince + reconcileMs;
    entry.failures = 0;
  };
  const entries = new Map<string, Entry>();
  let connected = true;
  let closed = false;
  const timer = setInterval(sweep, Math.max(1, Math.min(1000, Math.floor(graceMs / 10))));
  timer.unref?.();
  function sweep() {
    if (closed || !connected) return;
    const now = performance.now();
    for (const entry of entries.values()) {
      if (entry.dormant || entry.releasing) continue;
      if (entry.checking) { entry.idleSince = now; continue; }
      let releasable = false;
      if (!entry.shown && !entry.users) {
        try { releasable = entry.safe(); } catch { /* Unknown native state must retain the connection. */ }
      }
      const decision = decideResidency({ shown: entry.shown, held: entry.users > 0, releasable, unkeptMs: now - entry.idleSince, graceMs: entry.graceMs });
      if (decision === 'keep') {
        entry.idleSince = now;
        if (!entry.shown && !entry.users && entry.reconcile && !reconciling && now >= entry.retryAt) {
          entry.checking = true;
          const revision = entry.revision;
          const isCurrent = () => !closed && connected && !entry.users && !entry.shown && entry.revision === revision;
          reconciling = Promise.resolve().then(() => isCurrent() ? entry.reconcile!(isCurrent) : false)
            .catch(() => false).then(confirmed => {
              if (!isCurrent()) return;
              entry.idleSince = performance.now();
              entry.failures = confirmed ? 0 : Math.min(10, entry.failures + 1);
              entry.retryAt = entry.idleSince + Math.min(15 * 60_000, reconcileMs * 2 ** entry.failures);
            }).finally(() => { entry.checking = false; reconciling = undefined; });
        }
        continue;
      }
      if (decision === 'wait') continue;
      // Begin closing synchronously so a new lease waits for this exact generation.
      const releasing = entry.release();
      entry.releasing = releasing;
      void releasing.then(() => { entry.dormant = true; }, () => { entry.idleSince = performance.now(); })
        .finally(() => { if (entry.releasing === releasing) entry.releasing = undefined; });
    }
  }
  return {
    /** Watches a session with its release rule; `releaseGraceMs` replaces the default grace for it. Holders and the shown state carry over. */
    watch(id: string, safe: () => boolean, release: () => Promise<void>, reconcile?: (isCurrent: () => boolean) => Promise<boolean>, releaseGraceMs = graceMs) {
      if (!Number.isSafeInteger(releaseGraceMs) || releaseGraceMs < 1) throw new RangeError('Release grace must be a positive integer.');
      const existing = entries.get(id);
      if (existing) reset(existing);
      const entry: Entry = { users: existing?.users ?? 0, shown: existing?.shown ?? false, graceMs: releaseGraceMs, idleSince: 0, safe, release, dormant: false,
        revision: 0, retryAt: 0, failures: 0, reconcile };
      reset(entry);
      entries.set(id, entry);
    },
    retain(id: string): () => void {
      const entry = entries.get(id);
      if (closed || !entry) return () => {};
      entry.users += 1;
      reset(entry);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // Restoration replaces the watch, but existing leases still refer to this identity.
        const current = entries.get(id);
        if (current) { current.users -= 1; reset(current); }
      };
    },
    /** Whether a page shows the session; a change restarts its grace. */
    show(id: string, shown: boolean) {
      const entry = entries.get(id);
      if (!entry || entry.shown === shown) return;
      entry.shown = shown;
      reset(entry);
    },
    /** Something holds the session, or a page shows it. */
    hasDemand(id: string) { const entry = entries.get(id); return !!entry && (entry.users > 0 || entry.shown); },
    touch(id: string) { const entry = entries.get(id); if (entry) reset(entry); },
    /** A session nobody holds and no page shows ends its idle grace now: the next sweep releases it when it is safe to. */
    expire(id: string) { const entry = entries.get(id); if (entry && !entry.users && !entry.shown) entry.idleSince = Number.NEGATIVE_INFINITY; },
    async wait(id: string) { await entries.get(id)?.releasing; },
    setConnected(value: boolean) {
      if (connected === value) return;
      connected = value;
      for (const entry of entries.values()) reset(entry);
    },
    close() { closed = true; clearInterval(timer); return Promise.allSettled([reconciling, ...[...entries.values()].flatMap(entry => entry.releasing ? [entry.releasing] : [])]); },
  };
}

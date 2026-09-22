interface Entry {
  users: number;
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

/** Host-local leases survive uplink replacement; elapsed grace uses a monotonic clock. */
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
      let safe = false;
      try { safe = !entry.users && entry.safe(); } catch { /* Unknown native state must retain the connection. */ }
      if (!safe) {
        entry.idleSince = now;
        if (!entry.users && entry.reconcile && !reconciling && now >= entry.retryAt) {
          entry.checking = true;
          const revision = entry.revision;
          const isCurrent = () => !closed && connected && !entry.users && entry.revision === revision;
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
      if (now - entry.idleSince < graceMs) continue;
      // Begin closing synchronously so a new lease waits for this exact generation.
      const releasing = entry.release();
      entry.releasing = releasing;
      void releasing.then(() => { entry.dormant = true; }, () => { entry.idleSince = performance.now(); })
        .finally(() => { if (entry.releasing === releasing) entry.releasing = undefined; });
    }
  }
  return {
    watch(id: string, safe: () => boolean, release: () => Promise<void>, reconcile?: (isCurrent: () => boolean) => Promise<boolean>) {
      const existing = entries.get(id);
      if (existing) reset(existing);
      const entry: Entry = { users: existing?.users ?? 0, idleSince: 0, safe, release, dormant: false,
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
    hasDemand(id: string) { return (entries.get(id)?.users ?? 0) > 0; },
    touch(id: string) { const entry = entries.get(id); if (entry) reset(entry); },
    async wait(id: string) { await entries.get(id)?.releasing; },
    setConnected(value: boolean) {
      if (connected === value) return;
      connected = value;
      for (const entry of entries.values()) reset(entry);
    },
    close() { closed = true; clearInterval(timer); return Promise.allSettled([reconciling, ...[...entries.values()].flatMap(entry => entry.releasing ? [entry.releasing] : [])]); },
  };
}

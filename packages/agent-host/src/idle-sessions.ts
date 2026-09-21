interface Entry {
  users: number;
  idleSince: number;
  safe(): boolean;
  release(): Promise<void>;
  releasing?: Promise<void>;
  dormant: boolean;
}

/** Host-local leases survive uplink replacement; elapsed grace uses a monotonic clock. */
export function createIdleSessions(options: { graceMs?: number } = {}) {
  const graceMs = options.graceMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(graceMs) || graceMs < 1) throw new RangeError('Idle grace must be a positive integer.');
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
      let safe = false;
      try { safe = !entry.users && entry.safe(); } catch { /* Unknown native state must retain the connection. */ }
      if (!safe) { entry.idleSince = now; continue; }
      if (now - entry.idleSince < graceMs) continue;
      // Begin closing synchronously so a new lease waits for this exact generation.
      const releasing = entry.release();
      entry.releasing = releasing;
      void releasing.then(() => { entry.dormant = true; }, () => { entry.idleSince = performance.now(); })
        .finally(() => { if (entry.releasing === releasing) entry.releasing = undefined; });
    }
  }
  return {
    watch(id: string, safe: () => boolean, release: () => Promise<void>) {
      const existing = entries.get(id);
      entries.set(id, { users: existing?.users ?? 0, idleSince: performance.now(), safe, release, dormant: false });
    },
    retain(id: string): () => void {
      const entry = entries.get(id);
      if (closed || !entry) return () => {};
      entry.users += 1;
      entry.idleSince = performance.now();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // Restoration replaces the watch, but existing leases still refer to this identity.
        const current = entries.get(id);
        if (current) { current.users -= 1; current.idleSince = performance.now(); }
      };
    },
    hasDemand(id: string) { return (entries.get(id)?.users ?? 0) > 0; },
    touch(id: string) { const entry = entries.get(id); if (entry) entry.idleSince = performance.now(); },
    async wait(id: string) { await entries.get(id)?.releasing; },
    setConnected(value: boolean) {
      if (connected === value) return;
      connected = value;
      for (const entry of entries.values()) entry.idleSince = performance.now();
    },
    close() { closed = true; clearInterval(timer); return Promise.allSettled([...entries.values()].flatMap(entry => entry.releasing ? [entry.releasing] : [])); },
  };
}

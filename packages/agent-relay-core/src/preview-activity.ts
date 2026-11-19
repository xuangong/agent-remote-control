import { defaultBrokerScheduler, type BrokerScheduler } from './transport.js';
/** Coalesce traffic into bounded renewal writes, including one trailing renewal. */
export function createPreviewActivity(options: {
  available(hostId: string, id: string): boolean;
  renew(hostId: string, id: string): Promise<{ expiresAt: number }>;
  /** Ports: the timer that waits out the delay between renewals, and the clock that dates them. */
  scheduler?: BrokerScheduler;
  now?(): number;
}) {
  const scheduler = options.scheduler ?? defaultBrokerScheduler, now = options.now ?? Date.now;
  type Entry = { hostId: string; id: string; dirty: boolean; pending: boolean; due: number; timer?: unknown };
  const entries = new Map<string, Entry>();
  let closed = false;
  function schedule(key: string, entry: Entry) {
    if (closed || entries.get(key) !== entry || entry.pending || entry.timer || !entry.dirty) return;
    if (!options.available(entry.hostId, entry.id)) { entries.delete(key); return; }
    const delay = entry.due - now();
    if (delay > 0) {
      entry.timer = scheduler.setTimeout(() => { entry.timer = undefined; schedule(key, entry); }, delay);
      return;
    }
    entry.pending = true; entry.dirty = false;
    void options.renew(entry.hostId, entry.id).then(registration => {
      entry.due = now() + Math.max(1, Math.min(60_000, (registration.expiresAt - now()) / 3));
    }).catch(() => {
      // Only subsequent traffic retries a failed renewal; idle pages never keep a lease alive.
      entry.due = now() + 1000;
    }).finally(() => { entry.pending = false; schedule(key, entry); });
  }
  return {
    record(hostId: string, id: string) {
      if (closed || !options.available(hostId, id)) return;
      const key = JSON.stringify([hostId, id]);
      let entry = entries.get(key);
      if (!entry) { entry = { hostId, id, dirty: false, pending: false, due: 0 }; entries.set(key, entry); }
      entry.dirty = true; schedule(key, entry);
    },
    forget(hostId: string, id?: string) {
      for (const [key, entry] of entries) if (entry.hostId === hostId && (id === undefined || entry.id === id)) {
        scheduler.clearTimeout(entry.timer); entries.delete(key);
      }
    },
    close() { closed = true; for (const entry of entries.values()) scheduler.clearTimeout(entry.timer); entries.clear(); },
  };
}

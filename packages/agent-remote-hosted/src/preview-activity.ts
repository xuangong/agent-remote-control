/** Coalesce traffic into bounded renewal writes, including one trailing renewal. */
export function createPreviewActivity(options: {
  available(hostId: string, id: string): boolean;
  renew(hostId: string, id: string): Promise<{ expiresAt: number }>;
}) {
  type Entry = { hostId: string; id: string; dirty: boolean; pending: boolean; due: number; timer?: ReturnType<typeof setTimeout> };
  const entries = new Map<string, Entry>();
  let closed = false;
  function schedule(key: string, entry: Entry) {
    if (closed || entries.get(key) !== entry || entry.pending || entry.timer || !entry.dirty) return;
    if (!options.available(entry.hostId, entry.id)) { entries.delete(key); return; }
    const delay = entry.due - Date.now();
    if (delay > 0) {
      entry.timer = setTimeout(() => { entry.timer = undefined; schedule(key, entry); }, delay);
      entry.timer.unref?.();
      return;
    }
    entry.pending = true; entry.dirty = false;
    void options.renew(entry.hostId, entry.id).then(registration => {
      entry.due = Date.now() + Math.max(1, Math.min(60_000, (registration.expiresAt - Date.now()) / 3));
    }).catch(() => {
      // Only subsequent traffic retries a failed renewal; idle pages never keep a lease alive.
      entry.due = Date.now() + 1000;
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
        clearTimeout(entry.timer); entries.delete(key);
      }
    },
    close() { closed = true; for (const entry of entries.values()) clearTimeout(entry.timer); entries.clear(); },
  };
}

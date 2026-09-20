const pending = new Map<string, () => string>();
let timer: ReturnType<typeof setTimeout> | undefined;

/** Persist the latest value at most once per burst, including before suspension. */
export function queueRecoveryWrite(key: string, serialize: () => string): void {
  pending.set(key, serialize);
  if (timer !== undefined) return;
  window.addEventListener('pagehide', flushAll);
  document.addEventListener('visibilitychange', onVisibility);
  timer = setTimeout(flushAll, 200);
}

export function flushRecoveryWrites(prefix = ''): void {
  for (const [key, serialize] of pending) {
    if (!key.startsWith(prefix)) continue;
    pending.delete(key);
    try { sessionStorage.setItem(key, serialize()); }
    catch { /* Editing and reading remain usable when browser storage is unavailable. */ }
  }
  releaseIfEmpty();
}

export function cancelRecoveryWrites(prefix: string): void {
  for (const key of pending.keys()) if (key.startsWith(prefix)) pending.delete(key);
  releaseIfEmpty();
}

function flushAll(): void { flushRecoveryWrites(); }
function onVisibility(): void { if (document.visibilityState === 'hidden') flushAll(); }
function releaseIfEmpty(): void {
  if (pending.size) return;
  clearTimeout(timer); timer = undefined;
  window.removeEventListener('pagehide', flushAll);
  document.removeEventListener('visibilitychange', onVisibility);
}

/** A single polling task that sleeps in hidden pages and never overlaps itself. Becoming visible restarts the interval; it does not poll. */
export function watchPagePolling(poll: () => unknown, intervalMs: number): () => void {
  let stopped = false;
  let running = false;
  let wakePending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const run = async () => {
    clearTimeout(timer);
    if (stopped || !visible()) return;
    if (running) { wakePending = true; return; }
    running = true;
    try { await poll(); }
    catch { /* Callers own error presentation; a failed refresh must not stop future polling. */ }
    finally {
      running = false;
      if (!stopped && visible()) {
        const delay = wakePending ? 0 : intervalMs;
        wakePending = false;
        timer = setTimeout(() => void run(), delay);
      }
    }
  };
  const visibility = () => {
    clearTimeout(timer);
    if (visible()) { if (!running) timer = setTimeout(() => void run(), intervalMs); }
    else wakePending = false;
  };
  document.addEventListener('visibilitychange', visibility);
  void run();
  return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
}

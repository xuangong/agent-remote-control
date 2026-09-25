/** A suspended browser may retain a WebSocket object after its network connection dies. */
export function watchPageResume(resume: (suspendedMs: number) => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined;
  let hidden = document.visibilityState === 'hidden';
  let hiddenAt = hidden ? Date.now() : undefined;
  const hide = () => { if (!hidden) hiddenAt = Date.now(); hidden = true; };
  const visible = () => {
    if (document.visibilityState === 'hidden') { hide(); return; }
    if (hidden) {
      const duration = hiddenAt === undefined ? Infinity : Math.max(0, Date.now() - hiddenAt);
      hidden = false; hiddenAt = undefined; resume(duration);
    }
  };
  const show = (event: PageTransitionEvent) => {
    if (event.persisted && !hidden) { hidden = true; hiddenAt = undefined; }
    visible();
  };
  const online = () => { if (document.visibilityState !== 'hidden') resume(0); };
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('pagehide', hide);
  window.addEventListener('pageshow', show);
  window.addEventListener('online', online);
  return () => {
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('pagehide', hide);
    window.removeEventListener('pageshow', show);
    window.removeEventListener('online', online);
  };
}

/** A suspended browser may retain a WebSocket object after its network connection dies. */
export function watchPageResume(resume: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined;
  let hidden = document.visibilityState === 'hidden';
  const hide = () => { hidden = true; };
  const visible = () => {
    if (document.visibilityState === 'hidden') { hide(); return; }
    if (hidden) { hidden = false; resume(); }
  };
  const show = (event: PageTransitionEvent) => {
    if (event.persisted) hidden = true;
    visible();
  };
  const online = () => { if (document.visibilityState !== 'hidden') resume(); };
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

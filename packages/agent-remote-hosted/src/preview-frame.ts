/** Navigation cooperation only; application URLs and networking are unchanged. */
export function previewFrameScript(controlOrigin: string): string {
  return `(() => {
    if (parent === window) return;
    const control = ${JSON.stringify(controlOrigin)};
    const send = (replace = false) => parent.postMessage({ type: 'arc-preview-navigation', url: location.href, replace }, control);
    for (const name of ['pushState', 'replaceState']) {
      const original = history[name];
      history[name] = function(...args) { const result = original.apply(this, args); send(name === 'replaceState'); return result; };
    }
    addEventListener('popstate', () => send()); addEventListener('hashchange', () => send());
    addEventListener('message', event => {
      if (event.source !== parent || event.origin !== control || event.data?.type !== 'arc-preview-navigate') return;
      try { const url = new URL(event.data.url); if (url.origin === location.origin) location.replace(url.href); } catch {}
    });
    document.addEventListener('click', event => { const anchor = event.target?.closest?.('a'); if (anchor && !anchor.hasAttribute('download')) anchor.target = '_self'; }, true);
    document.addEventListener('submit', event => { event.target.target = '_self'; event.submitter?.setAttribute('formtarget', '_self'); }, true);
    window.open = destination => { if (destination) location.assign(String(destination)); return window; };
    document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); parent.postMessage({ type: 'arc-preview-close' }, control); } });
    send();
  })();`;
}

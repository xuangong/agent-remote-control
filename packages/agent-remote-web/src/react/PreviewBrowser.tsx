import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePreviewVisibility } from './usePreviewVisibility.js';

export function PreviewBrowser({ url, target, error, returnFocus, onClose, onMinimize, visible, browserKey, container }: {
  readonly container?: HTMLElement | null;
  readonly visible: boolean; readonly browserKey: string; readonly onMinimize: () => void;
  readonly url?: string; readonly target: string; readonly error?: string; readonly returnFocus?: HTMLElement; readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const history = useRef({ urls: [] as string[], index: -1, navigating: false });
  const detach = useRef<() => void>(() => {});
  const [navigation, setNavigation] = useState({ address: '', back: false, forward: false });
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string>();

  usePreviewVisibility(dialog, visible, browserKey);

  useEffect(() => {
    const trigger = returnFocus;
    const element = dialog.current!;
    return () => { detach.current(); element.close(); trigger?.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    history.current = { urls: url ? [url] : [], index: url ? 0 : -1, navigating: false };
    setNavigation({ address: url ?? '', back: false, forward: false });
    setFailure(undefined); setLoading(true);
  }, [url]);

  useEffect(() => {
    if (!loading || !url || error) return;
    const timer = window.setTimeout(() => setFailure('The page is taking too long to load. Try reloading, or check the local application.'), 20_000);
    return () => window.clearTimeout(timer);
  }, [loading, url, error]);

  function record(address: string, replace = false) {
    if (!url || !address || address === 'about:blank') return;
    const current = history.current;
    if (current.navigating || replace) { current.urls[current.index] = address; current.navigating = false; }
    else if (current.urls[current.index] !== address) {
      current.urls = [...current.urls.slice(0, current.index + 1), address]; current.index += 1;
    }
    setNavigation({ address, back: current.index > 0, forward: current.index < current.urls.length - 1 });
  }

  function loaded() {
    detach.current();
    const frame = iframe.current?.contentWindow;
    if (!frame) return;
    try {
      if (frame.location.href === 'about:blank') {
        setFailure('This page could not be embedded. Check the application’s frame policy, then reload.');
        setLoading(false); return;
      }
      const document = frame.document;
      record(frame.location.href); setLoading(false); setFailure(undefined);
      const changed = () => { record(frame.location.href); setLoading(false); };
      const frameHistory = frame.history;
      const push = frameHistory.pushState; const replace = frameHistory.replaceState;
      frameHistory.pushState = function(...args) { push.apply(this, args); changed(); };
      frameHistory.replaceState = function(...args) { replace.apply(this, args); record(frame.location.href, true); };
      frame.addEventListener('popstate', changed); frame.addEventListener('hashchange', changed);
      const click = (event: MouseEvent) => {
        const element = event.target as Element | null;
        const anchor = element?.closest?.('a');
        if (anchor && !anchor.hasAttribute('download')) anchor.setAttribute('target', '_self');
      };
      const submit = (event: SubmitEvent) => {
        const form = event.target as HTMLFormElement;
        form.target = '_self';
        event.submitter?.setAttribute('formtarget', '_self');
      };
      document.addEventListener('click', click, true);
      document.addEventListener('submit', submit, true);
      const open = frame.open;
      frame.open = destination => { if (destination) frame.location.assign(String(destination)); return frame; };
      const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
      document.addEventListener('keydown', keyboard);
      detach.current = () => {
        document.removeEventListener('click', click, true); document.removeEventListener('submit', submit, true);
        document.removeEventListener('keydown', keyboard);
        try {
          // WindowProxy access can throw once this frame navigates to another origin.
          frame.removeEventListener('popstate', changed); frame.removeEventListener('hashchange', changed);
          if (frame.document === document) {
            frameHistory.pushState = push; frameHistory.replaceState = replace; frame.open = open;
          }
        } catch { /* Listeners on an inaccessible document leave with that document. */ }
      };
    } catch {
      // Cross-origin documents cannot expose their address or history to the workbench.
      setLoading(false); setFailure('This page left the preview origin. Reload to return to the local application.');
    }
  }

  function navigate(offset: number) {
    const current = history.current;
    const index = current.index + offset;
    if (index < 0 || index >= current.urls.length) return;
    current.index = index; current.navigating = true;
    setLoading(true); setFailure(undefined);
    // The toolbar owns a URL history; it must never traverse the parent conversation history.
    iframe.current?.contentWindow?.location.replace(current.urls[index]!);
  }

  function reload() {
    const address = history.current.urls[history.current.index] ?? url;
    if (!address || !iframe.current) return;
    setLoading(true); setFailure(undefined);
    iframe.current.src = address;
  }

  return createPortal(<dialog ref={dialog} className="agent-preview-browser"
    aria-label="Local preview browser" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }} onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="agent-preview-browser-layout">
      <header className="agent-preview-browser-toolbar">
        <nav aria-label="Preview navigation">
          <button type="button" aria-label="Back" title="Back" disabled={!navigation.back || loading || !!error} onClick={() => navigate(-1)}><BrowserIcon name="back" /></button>
          <button type="button" aria-label="Forward" title="Forward" disabled={!navigation.forward || loading || !!error} onClick={() => navigate(1)}><BrowserIcon name="forward" /></button>
          <button type="button" aria-label="Reload preview" title="Reload preview" disabled={!url || !!error} onClick={reload}><BrowserIcon name="reload" /></button>
        </nav>
        <div className="agent-preview-browser-address" aria-label="Preview address" title={`${target} → ${navigation.address || 'Opening…'}`}>
          <span className="agent-preview-source-address">{target}</span><span className="agent-preview-address-arrow">→</span><span className="agent-preview-mapped-address">{navigation.address || 'Opening…'}</span>
        </div>
        <button type="button" aria-label="Minimize preview" title="Minimize preview" onClick={onMinimize}><BrowserIcon name="minimize" /></button>
        <button type="button" aria-label="Close preview" title="Close preview" onClick={onClose} autoFocus><BrowserIcon name="close" /></button>
      </header>
      <div className="agent-preview-browser-content" aria-busy={loading && !error && !failure}>
        {error || failure ? <p className="agent-preview-browser-message" role="alert">{error || failure}</p> : null}
        {loading && !error && !failure ? <p className="agent-preview-browser-loading" role="status">{url ? 'Loading preview…' : 'Opening preview…'}</p> : null}
        {url && !error ? <iframe ref={iframe} src={url} title="Local preview" onLoad={loaded} referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" allow="fullscreen" /> : null}
      </div>
    </div>
  </dialog>, container ?? document.body);
}

function BrowserIcon({ name }: { readonly name: 'back' | 'forward' | 'reload' | 'close' | 'minimize' }) {
  const paths = { minimize: 'M5 17h14', back: 'm14 5-7 7 7 7', forward: 'm10 5 7 7-7 7', close: 'm6 6 12 12M18 6 6 18',
    reload: 'M20 7v5h-5M20 12a8 8 0 1 0-2 5M20 12a8 8 0 0 0-2-5' };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

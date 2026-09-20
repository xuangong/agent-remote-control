import { NativeSessionCommand } from './NativeSessionCommands.js';
import { useEffect, useRef, useState } from 'react';
import { controllerPath } from '@agent-remote-controller/agent-remote-hosted/controller-location';
import type { OpenedSession } from '../directory-client.js';

export function sessionUrl(session: OpenedSession): string {
  return window.location.origin + controllerPath({ ...session, hostId: session.hostId ?? 'local' });
}

export function SessionLink({ session }: { session: OpenedSession }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [qr, setQr] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [copied, setCopied] = useState(false);
  const url = sessionUrl(session);
  useEffect(() => {
    if (!open) return;
    let retired = false;
    setQr(undefined); setFailure(undefined); setCopied(false);
    dialog.current?.showModal();
    void import('qrcode').then((QRCode) => QRCode.toDataURL(url, { width: 320, margin: 4, errorCorrectionLevel: 'M' }))
      .then((value) => { if (!retired) setQr(value); })
      .catch(() => { if (!retired) setFailure('The QR code could not be generated. Copy the link below.'); });
    return () => { retired = true; };
  }, [open, url]);
  async function copyLink() {
    try { await navigator.clipboard.writeText(url); setCopied(true); setFailure(undefined); }
    catch { setFailure('Copy failed. Select and copy the URL.'); }
  }
  return <>
    <button ref={trigger} type="button" className="lab-session-link-trigger" aria-label="Share session link" title="Session link and local resume" onClick={() => setOpen(true)}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h3v3h3v3h-6v-6ZM12 3v3M3 12h3m3 0h6v-3m-3 6v6m6-9h3" /></svg>
    </button>
    <dialog ref={dialog} className="lab-session-link-dialog" aria-label="Open session on another device" onClose={() => { setOpen(false); trigger.current?.focus({ preventScroll: true }); }}>
      <header><h2>Open on another device</h2><button type="button" aria-label="Close session link" onClick={() => dialog.current?.close()}>×</button></header>
      <p>Scan the code or send this link. Sign in on the other device to open this session.</p>
      {qr ? <img className="lab-session-qr" src={qr} width="320" height="320" alt="Session QR code" /> : <p role="status">{failure ?? 'Generating QR code…'}</p>}
      <label>Session URL<input readOnly value={url} onFocus={(event) => event.currentTarget.select()} /></label>
      <button type="button" onClick={() => { void copyLink(); }}>{copied ? 'Copied' : 'Copy link'}</button>
      <NativeSessionCommand providerId={session.providerId} nativeSessionId={session.nativeSessionId} />
      {failure && qr ? <p role="alert">{failure}</p> : null}
      {['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname) ? <p className="lab-control-note">This address is local to this computer. Use a controller address reachable from your phone to scan it.</p> : null}
    </dialog>
  </>;
}

import { createPortal } from 'react-dom';
import { NativeSessionCommand } from './NativeSessionCommands.js';
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { controllerPath } from '@orchardworks/agent-remote-hosted/controller-location';
import type { OpenedSession } from '../directory-client.js';
import { readSessionCode, type ScannedSession } from '../session-transfer.js';
import { SessionScanner } from './SessionScanner.js';

export function sessionUrl(session: OpenedSession): string {
  return window.location.origin + controllerPath({ ...session, hostId: session.hostId ?? 'local' });
}

export function SessionLink({ session }: { session: OpenedSession }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return <>
    <button ref={trigger} type="button" className="lab-session-link-trigger" aria-label="Share session link" title="Share session" onClick={() => setOpen(true)}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h3v3h3v3h-6v-6ZM12 3v3M3 12h3m3 0h6v-3m-3 6v6m6-9h3" /></svg>
    </button>
    {open ? <SessionTransferDialog session={session} onClose={() => { setOpen(false); trigger.current?.focus({ preventScroll: true }); }} /> : null}
  </>;
}

export function SessionTransferDialog({ session, onOpen, onClose }: {
  session?: OpenedSession;
  onOpen?(session: ScannedSession): Promise<boolean>;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [qr, setQr] = useState<string>();
  const [qrFailure, setQrFailure] = useState<string>();
  const [qrAttempt, setQrAttempt] = useState(0);
  const [failure, setFailure] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [scanning, setScanning] = useState(true);
  const [opening, setOpening] = useState(false);
  const [pasted, setPasted] = useState('');
  const pending = useRef(false);
  const url = session ? sessionUrl(session) : '';
  const title = session ? 'Share session' : 'Scan session';
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    if (!url) return;
    let retired = false;
    setQr(undefined); setQrFailure(undefined); setFailure(undefined); setCopied(false);
    void Promise.resolve().then(() => QRCode.toDataURL(url, { width: 320, margin: 4, errorCorrectionLevel: 'M' }))
      .then(value => { if (!retired) setQr(value); })
      .catch(() => { if (!retired) setQrFailure('The QR code could not be generated. Copy the session link instead.'); });
    return () => { retired = true; };
  }, [url, qrAttempt]);
  async function copyLink() {
    try { await navigator.clipboard.writeText(url); setCopied(true); setFailure(undefined); }
    catch { setFailure('Copy failed. Expand Session link to select and copy the URL.'); }
  }
  async function receive(text: string) {
    if (pending.current || !onOpen) return;
    setScanning(false); setFailure(undefined);
    try {
      const target = readSessionCode(text, window.location.origin);
      pending.current = true; setOpening(true);
      if (await onOpen(target)) onClose();
      else setFailure('This session could not be opened. Check the connection notice, then retry.');
    } catch (error) { setFailure(error instanceof Error ? error.message : 'This session could not be opened.'); }
    finally { pending.current = false; setOpening(false); }
  }
  return createPortal(<dialog ref={dialog} className="lab-session-link-dialog" aria-label={title} onKeyDown={event => event.stopPropagation()} onClose={onClose}>
      <header><h2>{title}</h2><button type="button" aria-label={session ? 'Close session link' : 'Close scanner'} onClick={() => dialog.current?.close()}>×</button></header>
      <div className="lab-session-transfer-body">
        {session ? <>
          <div className="lab-session-transfer-identity"><strong title={session.title}>{session.title || session.nativeSessionId}</strong><small>{session.providerId}</small></div>
          <p className="lab-session-transfer-hint">On your other device, tap Scan beside Discover sessions.</p>
          <div className="lab-session-qr-frame">{qr ? <img className="lab-session-qr" src={qr} width="320" height="320" alt="Session QR code" /> : qrFailure ? <div>
            <p className="lab-session-transfer-error" role="alert">{qrFailure}</p>
            <button type="button" onClick={() => setQrAttempt(value => value + 1)}>Retry QR code</button>
          </div> : <p role="status">Generating QR code…</p>}</div>
          <button type="button" className="lab-session-copy-link" onClick={() => void copyLink()}>{copied ? 'Copied' : 'Copy link'}</button>
          <p className="lab-session-transfer-note">Uses the receiving device’s sign-in. Access stays unchanged.</p>
          <details className="lab-session-transfer-details"><summary>Session link</summary><label className="agent-visually-hidden" htmlFor="session-transfer-url">Session URL</label><input id="session-transfer-url" readOnly value={url} onFocus={event => event.currentTarget.select()} /></details>
          {['codex', 'copilot'].includes(session.providerId) ? <details className="lab-session-transfer-details"><summary>Resume locally</summary><NativeSessionCommand providerId={session.providerId} nativeSessionId={session.nativeSessionId} /></details> : null}
          {['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname) ? <p className="lab-control-note">This address is local to this computer. Use a site reachable from both devices.</p> : null}
        </> : <>
          {scanning && !opening ? <SessionScanner onRead={text => void receive(text)} /> : opening ? <div className="lab-session-scan-result" role="status">Opening session…</div> : <button type="button" onClick={() => { setFailure(undefined); setScanning(true); }}>Scan again</button>}
          <details className="lab-session-transfer-details"><summary>Paste a session link</summary><form onSubmit={event => { event.preventDefault(); void receive(pasted); }}>
            <label htmlFor="session-transfer-paste">Session link</label><input id="session-transfer-paste" type="url" required value={pasted} onChange={event => setPasted(event.target.value)} placeholder="https://…" autoComplete="off" />
            <button type="submit" disabled={opening || !pasted.trim()}>Open session</button>
          </form></details>
        </>}
        {failure ? <p className="lab-session-transfer-error" role="alert">{failure}</p> : null}
      </div>
    </dialog>, document.body);
}

import { errorWords } from '@orchardworks/agent-client';
import { createPortal } from 'react-dom';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { NativeSessionCommand, nativeOpenCommand } from './NativeSessionCommands.js';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { controllerPath } from '@orchardworks/agent-remote-protocol/model';
import type { OpenedSession } from '../directory-client.js';
import { readSessionCode, type ScannedSession } from '../session-transfer.js';
import { SessionScanner } from './SessionScanner.js';

type SessionLinkTarget = Pick<OpenedSession, 'hostId' | 'providerId' | 'nativeSessionId' | 'title' | 'parentNativeSessionId'> & { agentId?: string };

/** The working directory the displayed session reports, for opening that same session on its Host. */
export const SessionWorkspaceContext = createContext<{ providerId: string; nativeSessionId: string; cwd: string } | undefined>(undefined);

export function sessionUrl(session: SessionLinkTarget, sessionIntent?: 'history', keepOriginal?: boolean): string {
  return window.location.origin + controllerPath({ ...session, hostId: session.hostId ?? 'local', sessionIntent, keepOriginal });
}

export function SessionLink({ session, sessionIntent, keepOriginal }: { session: SessionLinkTarget; sessionIntent?: 'history'; keepOriginal?: boolean }) {
  const t = useTranslate();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return <>
    <button ref={trigger} type="button" className="lab-session-link-trigger" aria-label={t('sessions.link.shareLabel')} title={t('sessions.link.shareTitle')} onClick={() => setOpen(true)}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h3v3h3v3h-6v-6ZM12 3v3M3 12h3m3 0h6v-3m-3 6v6m6-9h3" /></svg>
    </button>
    {open ? <SessionTransferDialog session={session} sessionIntent={sessionIntent} keepOriginal={keepOriginal} onClose={() => { setOpen(false); trigger.current?.focus({ preventScroll: true }); }} /> : null}
  </>;
}

export function SessionTransferDialog({ session, sessionIntent, keepOriginal, onOpen, onClose }: {
  session?: SessionLinkTarget;
  sessionIntent?: 'history';
  keepOriginal?: boolean;
  onOpen?(session: ScannedSession): Promise<boolean>;
  onClose(): void;
}) {
  const t = useTranslate();
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
  const reported = useContext(SessionWorkspaceContext);
  // The displayed state can belong to another session while navigation or Handoff settles.
  const workspace = reported && session && reported.providerId === session.providerId && reported.nativeSessionId === session.nativeSessionId ? reported.cwd : undefined;
  const url = session ? sessionUrl(session, sessionIntent, keepOriginal) : '';
  const title = session ? t('sessions.link.shareTitle') : t('sessions.link.scanTitle');
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    if (!url) return;
    let retired = false;
    setQr(undefined); setQrFailure(undefined); setFailure(undefined); setCopied(false);
    // The encoder loads with the first QR code drawn, not with the workbench (stage 6).
    void import('qrcode').then(({ default: QRCode }) => QRCode.toDataURL(url, { width: 320, margin: 4, errorCorrectionLevel: 'M' }))
      .then(value => { if (!retired) setQr(value); })
      .catch(() => { if (!retired) setQrFailure(t('sessions.link.qrFailed')); });
    return () => { retired = true; };
  }, [url, qrAttempt]);
  async function copyLink() {
    try { await navigator.clipboard.writeText(url); setCopied(true); setFailure(undefined); }
    catch { setFailure(t('sessions.link.copyFailed')); }
  }
  async function receive(text: string) {
    if (pending.current || !onOpen) return;
    setScanning(false); setFailure(undefined);
    try {
      const target = readSessionCode(text, window.location.origin);
      pending.current = true; setOpening(true);
      if (await onOpen(target)) onClose();
      else setFailure(t('sessions.link.openFailed'));
    } catch (error) { setFailure(errorWords(error, t, 'sessions.link.openFailedShort')); }
    finally { pending.current = false; setOpening(false); }
  }
  return createPortal(<dialog ref={dialog} className="lab-session-link-dialog" aria-label={title} onKeyDown={event => event.stopPropagation()} onClose={onClose}>
      <header><h2>{title}</h2><button type="button" aria-label={session ? t('sessions.link.closeLink') : t('sessions.link.closeScanner')} onClick={() => dialog.current?.close()}>×</button></header>
      <div className="lab-session-transfer-body">
        {session ? <>
          <div className="lab-session-transfer-identity"><strong title={session.title}>{session.title || session.nativeSessionId}</strong><small>{session.providerId}</small></div>
          <p className="lab-session-transfer-hint">{t('sessions.link.otherDeviceHint')}</p>
          <div className="lab-session-qr-frame">{qr ? <img className="lab-session-qr" src={qr} width="320" height="320" alt={t('sessions.link.qrAlt')} /> : qrFailure ? <div>
            <p className="lab-session-transfer-error" role="alert">{qrFailure}</p>
            <button type="button" onClick={() => setQrAttempt(value => value + 1)}>{t('sessions.link.retryQr')}</button>
          </div> : <p role="status">{t('sessions.link.generatingQr')}</p>}</div>
          <button type="button" className="lab-session-copy-link" onClick={() => void copyLink()}>{copied ? t('common.copied') : t('sessions.link.copyLink')}</button>
          <p className="lab-session-transfer-note">{t('sessions.link.signInNote')}</p>
          <details className="lab-session-transfer-details"><summary>{t('sessions.link.linkSummary')}</summary><label className="agent-visually-hidden" htmlFor="session-transfer-url">{t('sessions.link.urlLabel')}</label><input id="session-transfer-url" readOnly value={url} onFocus={event => event.currentTarget.select()} /></details>
          {nativeOpenCommand(session) ? <details className="lab-session-transfer-details"><summary>{t('sessions.native.openOnHost')}</summary><NativeSessionCommand hostId={session.hostId} providerId={session.providerId} nativeSessionId={session.nativeSessionId} workspace={workspace} /></details> : null}
          {['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname) ? <p className="lab-control-note">{t('sessions.link.localAddressNote')}</p> : null}
        </> : <>
          {scanning && !opening ? <SessionScanner onRead={text => void receive(text)} /> : opening ? <div className="lab-session-scan-result" role="status">{t('sessions.link.opening')}</div> : <button type="button" onClick={() => { setFailure(undefined); setScanning(true); }}>{t('sessions.link.scanAgain')}</button>}
          <details className="lab-session-transfer-details"><summary>{t('sessions.link.pasteSummary')}</summary><form onSubmit={event => { event.preventDefault(); void receive(pasted); }}>
            <label htmlFor="session-transfer-paste">{t('sessions.link.pasteLabel')}</label><input id="session-transfer-paste" type="url" required value={pasted} onChange={event => setPasted(event.target.value)} placeholder="https://…" autoComplete="off" />
            <button type="submit" disabled={opening || !pasted.trim()}>{t('sessions.link.openSession')}</button>
          </form></details>
        </>}
        {failure ? <p className="lab-session-transfer-error" role="alert">{failure}</p> : null}
      </div>
    </dialog>, document.body);
}

import { useFeedbackToast } from '../../kernel/Toast.js';
import { useState } from 'react';
import { vscodeTunnelLink } from '@orchardworks/agent-remote-protocol';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { useVscodeTunnel } from '../../kernel/vscode-tunnel.js';
import { ReauthenticationNotice } from '../../conversation/ReauthenticationNotice.js';

const statusKeys = { checking: 'hosts.vscode.checkingAvailability', unavailable: 'hosts.vscode.unavailableHere', stopped: 'hosts.vscode.stopped', starting: 'hosts.vscode.starting',
  awaiting_auth: 'hosts.vscode.awaitingAuth', connecting: 'hosts.vscode.connecting', connected: 'hosts.vscode.connected', stopping: 'hosts.vscode.stopping',
  exited: 'hosts.vscode.exitedStatus', failed: 'hosts.vscode.failedStatus' } as const;

export function HostVscodeTunnel() {
  const t = useTranslate();
  const controller = useVscodeTunnel();
  const [accepted, setAccepted] = useState(false);
  const [copied, setCopied] = useState<string>();
  const [copyFailed, setCopyFailed] = useState(false);
  useFeedbackToast(t('hosts.toast.vscode'), controller?.error);
  if (!controller) return null;
  const { host, state, busy, error, errorCode } = controller;
  const online = host.online && !error;
  const connected = online && state?.status === 'connected' && state.processAlive;
  const link = connected && state.tunnelName ? vscodeTunnelLink(state.tunnelName) : undefined;
  const auth = online && state?.status === 'awaiting_auth' ? state.authorization : undefined;
  const authUrl = auth && ['https://github.com/login/device', 'https://microsoft.com/devicelogin', 'https://www.microsoft.com/devicelogin'].includes(auth.url) ? auth.url : undefined;
  return <section className="lab-host-vscode" aria-label={t('hosts.vscode.label')}>
    <div className="lab-directory-heading"><h2>VS Code</h2><button type="button" disabled={!host.online || busy} onClick={() => void controller.refresh()}>{t('common.refresh')}</button></div>
    <p className="lab-control-note">{host.name}</p>
    <div className="lab-vscode-status" data-status={online ? state?.status : 'unknown'} role="status">
      <span className="lab-vscode-dot" aria-hidden="true" />
      {!host.online ? t('hosts.vscode.hostOffline') : error ? t('hosts.vscode.statusUnavailable') : state ? t(statusKeys[state.status]) : t('hosts.vscode.checking')}
      {state?.processAlive && online ? <small>{t('hosts.vscode.processRunning')}</small> : null}
    </div>
    {link ? <a className="lab-vscode-machine" href={link} target="_blank" rel="noreferrer">{state?.tunnelName} ↗</a> : null}
    {authUrl ? <div className="lab-vscode-authorization">
      <p>{t('hosts.vscode.authorize')}</p>
      <code>{auth!.code}</code>
      <div><a href={authUrl} target="_blank" rel="noreferrer">{t('hosts.vscode.openSignIn')}</a>
        <button type="button" onClick={() => {
          setCopyFailed(false); void (navigator.clipboard?.writeText(auth!.code) ?? Promise.reject(new Error('Clipboard unavailable'))).then(() => setCopied(auth!.code)).catch(() => setCopyFailed(true));
        }}>{copied === auth!.code ? t('common.copied') : t('hosts.vscode.copyCode')}</button></div>
      {copyFailed ? <p role="alert">{t('hosts.vscode.copyCodeFailed')}</p> : null}
    </div> : null}
    {state?.message && online ? <p className="lab-control-note">{state.message}</p> : null}
    {state?.status === 'exited' && online ? <p className="lab-control-note">{state.signal ? t('hosts.vscode.stoppedBySignal', { signal: state.signal }) : state.exitCode !== null && state.exitCode !== undefined ? t('hosts.vscode.processExitedCode', { code: state.exitCode }) : t('hosts.vscode.processExited')} {t('hosts.vscode.restartHint')}</p> : null}
    {state && !state.processAlive && state.status !== 'checking' && state.status !== 'unavailable' ? <label className="lab-vscode-consent"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} />
      <span>{t('hosts.vscode.acceptBefore')}<a href="https://aka.ms/vscode-server-license" target="_blank" rel="noreferrer">{t('hosts.vscode.licenseTerms')}</a>{t('hosts.vscode.acceptAfter')}</span>
    </label> : null}
    <div className="lab-vscode-actions">
      {state?.processAlive ? <button type="button" disabled={!host.online || busy || state.status === 'stopping'} onClick={() => void controller.stop()}>{t('hosts.vscode.stopTunnel')}</button>
        : <button type="button" disabled={!online || busy || !state || state.status === 'unavailable' || state.status === 'checking' || !accepted} onClick={() => void controller.start()}>{t('hosts.vscode.startTunnel')}</button>}
    </div>
    {errorCode === 'reauthentication_required' ? <ReauthenticationNotice /> : error ? <p className="lab-control-note" role="alert">{error}</p> : null}
    <p className="lab-control-note">{t('hosts.vscode.shared')}</p>
  </section>;
}

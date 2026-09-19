import { useFeedbackToast } from './Toast.js';
import { useState } from 'react';
import { vscodeTunnelLink, vscodeWorkspaceLink } from '@agent-remote-controller/agent-remote-protocol';
import { useVscodeTunnel } from '../vscode-tunnel.js';
import { ReauthenticationNotice } from './ReauthenticationNotice.js';

const labels = { checking: 'Checking availability', unavailable: 'Unavailable on this Host', stopped: 'Stopped', starting: 'Starting', awaiting_auth: 'Waiting for sign-in', connecting: 'Connecting',
  connected: 'Connected', stopping: 'Stopping', exited: 'Exited', failed: 'Failed' };

export function HostVscodeTunnel() {
  const controller = useVscodeTunnel();
  const [accepted, setAccepted] = useState(false);
  const [copied, setCopied] = useState<string>();
  const [copyFailed, setCopyFailed] = useState(false);
  useFeedbackToast('VS Code connection', controller?.error);
  if (!controller) return null;
  const { host, state, busy, error, errorCode } = controller;
  const online = host.online && !error;
  const connected = online && state?.status === 'connected' && state.processAlive;
  const link = connected && state.tunnelName ? vscodeTunnelLink(state.tunnelName) : undefined;
  const auth = online && state?.status === 'awaiting_auth' ? state.authorization : undefined;
  const authUrl = auth && ['https://github.com/login/device', 'https://microsoft.com/devicelogin', 'https://www.microsoft.com/devicelogin'].includes(auth.url) ? auth.url : undefined;
  return <section className="lab-host-vscode" aria-label="Host VS Code tunnel">
    <div className="lab-directory-heading"><h2>VS Code</h2><button type="button" disabled={!host.online || busy} onClick={() => void controller.refresh()}>Refresh</button></div>
    <p className="lab-control-note">{host.name}</p>
    <div className="lab-vscode-status" data-status={online ? state?.status : 'unknown'} role="status">
      <span className="lab-vscode-dot" aria-hidden="true" />
      {!host.online ? 'Host offline · status unknown' : error ? 'Status unavailable' : state ? labels[state.status] : 'Checking…'}
      {state?.processAlive && online ? <small>Process running</small> : null}
    </div>
    {link ? <a className="lab-vscode-machine" href={link} target="_blank" rel="noreferrer">{state?.tunnelName} ↗</a> : null}
    {authUrl ? <div className="lab-vscode-authorization">
      <p>Sign in to authorize VS Code on this Host.</p>
      <code>{auth!.code}</code>
      <div><a href={authUrl} target="_blank" rel="noreferrer">Open GitHub / Microsoft sign-in ↗</a>
        <button type="button" onClick={() => {
          setCopyFailed(false); void (navigator.clipboard?.writeText(auth!.code) ?? Promise.reject(new Error('Clipboard unavailable'))).then(() => setCopied(auth!.code)).catch(() => setCopyFailed(true));
        }}>{copied === auth!.code ? 'Copied' : 'Copy code'}</button></div>
      {copyFailed ? <p role="alert">Copy failed. Select and copy the code above.</p> : null}
    </div> : null}
    {state?.message && online ? <p className="lab-control-note">{state.message}</p> : null}
    {state?.status === 'exited' && online ? <p className="lab-control-note">{state.signal ? `Stopped by ${state.signal}.` : `Process exited${state.exitCode !== null && state.exitCode !== undefined ? ` with code ${state.exitCode}` : ''}.`} Start again to reconnect.</p> : null}
    {state && !state.processAlive && state.status !== 'checking' && state.status !== 'unavailable' ? <label className="lab-vscode-consent"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} />
      <span>I accept the <a href="https://aka.ms/vscode-server-license" target="_blank" rel="noreferrer">VS Code Server license terms</a>.</span>
    </label> : null}
    <div className="lab-vscode-actions">
      {state?.processAlive ? <button type="button" disabled={!host.online || busy || state.status === 'stopping'} onClick={() => void controller.stop()}>Stop tunnel</button>
        : <button type="button" disabled={!online || busy || !state || state.status === 'unavailable' || state.status === 'checking' || !accepted} onClick={() => void controller.start()}>Start tunnel</button>}
    </div>
    {errorCode === 'reauthentication_required' ? <ReauthenticationNotice /> : error ? <p className="lab-control-note" role="alert">{error}</p> : null}
    <p className="lab-control-note">Shared by this Host’s workspaces. VS Code uses its own account sign-in.</p>
  </section>;
}

export function WorkspaceVscodeLink({ workspace }: { workspace?: string }) {
  const controller = useVscodeTunnel();
  if (!controller || !workspace) return null;
  const { state, host, error } = controller;
  const href = host.online && !error && state?.processAlive && state.status === 'connected' && state.tunnelName
    ? vscodeWorkspaceLink(state.tunnelName, workspace) : undefined;
  const unavailableReason = !host.online ? 'This Host is offline.'
    : state?.status === 'unavailable' ? state.message ?? 'VS Code tunnels are unavailable on this Host.'
      : 'Start or authorize the VS Code tunnel in the Host panel.';
  return href ? <a className="lab-vscode-workspace" data-vscode-workspace href={href} target="_blank" rel="noreferrer" title={`Open ${workspace} in VS Code`}>VS Code ↗</a>
    : <span className="lab-vscode-workspace lab-vscode-unavailable" title={unavailableReason} aria-label={`VS Code unavailable. ${unavailableReason}`}>VS Code</span>;
}

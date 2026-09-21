import type { HostEnvironment } from '@agent-remote-controller/agent-remote-protocol';
import { hostEnvironmentLabels, matchesHostEnvironment } from './host-environment.js';
import { useFeedbackToast } from './Toast.js';
import { useEffect, useState } from 'react';
import { HostSecurityActions } from './HostSecurityActions.js';
import { ReauthenticationNotice } from './ReauthenticationNotice.js';
import { needsReauthentication } from '../security-client.js';

export interface HostProvider { providerId: string; displayName: string }
export interface RemoteHost {
  id: string; name: string; online: boolean; managed?: boolean; providers?: HostProvider[]; providerId?: string;
  credentialRotation?: boolean; environment?: HostEnvironment;
  access?: 'owner' | 'shared'; sessionQuota?: { limit: number; used: number };
}
export interface PairingInvitation { id?: string; key: string; expiresAt: string; serverUrl: string; command?: string }
export interface HostStopResult { agentId: string; status: 'cancelled' | 'unsupported' | 'failed'; message?: string }
export interface HostPairingService {
  invitation?: PairingInvitation;
  hosts(): Promise<{ hosts: RemoteHost[] }>;
  pair(): Promise<PairingInvitation>;
  revoke?(hostId: string): Promise<void>;
  rotate?(hostId: string): Promise<{ ok: true; status: 'pending' | 'rotated' }>;
  stop?(hostId: string): Promise<{ results: HostStopResult[] }>;
}

export function HostPairing({ service, selectedHostId, selectionLocked, onSelect, hosts, hostError, onRetryHosts, onNewSession, managementVisible = true }: {
  managementVisible?: boolean;
  service: HostPairingService; selectedHostId: string; selectionLocked?: boolean; onSelect(host: RemoteHost): void; hosts: RemoteHost[]; hostError?: string; onRetryHosts(): void; onNewSession?(): void;
}) {
  const [filter, setFilter] = useState('');
  const matchingHosts = hosts.filter(host => matchesHostEnvironment(host, filter));
  const [revokeTarget, setRevokeTarget] = useState<RemoteHost>();
  const [revoking, setRevoking] = useState(false);
  const selectedHost = hosts.find(host => host.id === selectedHostId);
  const quota = selectedHost?.sessionQuota;
  const quotaExhausted = quota !== undefined && quota.used >= quota.limit;
  const [reauthenticate, setReauthenticate] = useState(false);
  const [failure, setFailure] = useState<string>();
  useFeedbackToast('Host connection', failure ?? hostError);
  const [invitation, setInvitation] = useState<PairingInvitation | undefined>(service.invitation);
  const [pairing, setPairing] = useState(false);
  const [showPairing, setShowPairing] = useState(service.invitation !== undefined);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const expired = invitation !== undefined && Date.parse(invitation.expiresAt) <= now;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  async function pair(): Promise<void> {
    if (pairing) return;
    setPairing(true);
    setReauthenticate(false);
    setFailure(undefined);
    try { const next = await service.pair(); service.invitation = next; setInvitation(next); setCopied(false); setShowPairing(true); }
    catch (error) { if (needsReauthentication(error)) { setReauthenticate(true); setInvitation(undefined); service.invitation = undefined; } else setFailure(error instanceof Error ? error.message : 'Could not create a pairing key.'); }
    finally { setPairing(false); }
  }

  async function revoke(): Promise<void> {
    if (!revokeTarget || !service.revoke || revoking) return;
    setRevoking(true);
    setFailure(undefined);
    try { await service.revoke(revokeTarget.id); setRevokeTarget(undefined); onRetryHosts(); }
    catch (error) { setFailure(error instanceof Error ? error.message : 'Could not revoke the Host.'); }
    finally { setRevoking(false); }
  }

  const configuration = invitation?.command ?? (invitation ? `serverUrl: ${invitation.serverUrl}\nremoteKey: ${invitation.key}` : '');
  return <section className="lab-host-pairing" aria-label="Remote Hosts">
    <div className="lab-directory-heading"><h2>Hosts</h2><button type="button" onClick={onRetryHosts}>Retry Hosts</button></div>
    <label htmlFor="host-environment-filter">Find an execution environment</label>
    <input id="host-environment-filter" type="search" value={filter} disabled={selectionLocked}
      placeholder="Filter Hosts: Linux, zsh, Chrome…" autoComplete="off" spellCheck={false}
      onChange={event => setFilter(event.target.value)} />
    {filter.trim() ? <small role="status">{matchingHosts.length ? `${matchingHosts.length} matching Hosts` : 'No matching Hosts'}</small> : null}
    <label htmlFor="remote-host">Connected Host</label>
    <select id="remote-host" value={selectedHostId} disabled={selectionLocked} onChange={(event) => { const host = hosts.find((item) => item.id === event.target.value); if (host) onSelect(host); }}>
      {hosts.length > 0 && !selectedHost ? <option value={selectedHostId}>Select a Host</option> : null}
      {selectedHost && !matchingHosts.includes(selectedHost) ? <option value={selectedHost.id} disabled>{selectedHost.name} · Current selection (filtered out)</option> : null}
      {hosts.length ? matchingHosts.map((host) => <option key={host.id} value={host.id}>{host.name} · {host.online ? 'Online' : 'Offline'}{host.access === 'shared' ? ' · Shared' : ''}{host.environment ? ` · ${hostEnvironmentLabels(host).join(' · ')}` : ' · Environment unknown'}</option>) : <option value={selectedHostId}>No connected Hosts</option>}
    </select>
    {selectedHost ? <div className="lab-host-environment" aria-label="Host environment">
      {selectedHost.environment ? <>
        <div className="lab-host-environment-tags">{hostEnvironmentLabels(selectedHost).map((label, index) => <span key={`${index}:${label}`}>{label}</span>)}</div>
        <details><summary>Detection details</summary>
          <dl><dt>System release</dt><dd>{selectedHost.environment.os.release}</dd>
            <dt>Primary shell</dt><dd>{selectedHost.environment.shell.name ?? 'Unknown'} · {selectedHost.environment.shell.source}</dd>
            <dt>WSL / Container</dt><dd>{[selectedHost.environment.wsl, selectedHost.environment.container].map(value => value === null ? 'Unknown' : value ? 'Yes' : 'No').join(' / ')}</dd>
            <dt>Browsers</dt><dd>{selectedHost.environment.browsers.map(item => `${item.name}: ${detectionLabel(item.status)}`).join(', ') || 'Unknown'}</dd>
            <dt>Shells</dt><dd>{selectedHost.environment.shells.map(item => `${item.name}: ${detectionLabel(item.status)}`).join(', ') || 'Unknown'}</dd>
            <dt>VS Code</dt><dd>{detectionLabel(selectedHost.environment.vscode.status)}</dd>
          </dl>
          <p>Detected at {new Date(selectedHost.environment.detectedAt).toLocaleString()}. Restart the Controller to refresh. Installed software does not imply a running desktop or remote browser control.</p>
        </details>
      </> : <small>Environment unknown · This Host has not reported detection results.</small>}
    </div> : null}
    {selectedHost?.access ? <p className="lab-control-note">{selectedHost.access === 'shared' ? 'Shared with you' : 'You own this Host'}</p> : null}
    {quota ? <p className="lab-control-note" role="status">Session creation allowance used: {quota.used} / {quota.limit}. This total does not reset when sessions finish.{quotaExhausted ? ' Creation limit reached. Existing sessions remain available.' : ''}</p> : null}
    <div hidden={!managementVisible}>
    {selectedHost?.managed && selectedHost.access !== 'shared' && service.revoke ? <button type="button" onClick={() => setRevokeTarget(selectedHost)}>Revoke Host</button> : null}
    {revokeTarget ? <div role="group" aria-label="Confirm Host revocation">
      <p>Revoke {revokeTarget.name}? Its remote connections will close. Running work may continue. Use Stop work first to request cancellation. Pair it again to restore access.</p>
      <button type="button" disabled={revoking} onClick={() => void revoke()}>{revoking ? 'Revoking…' : 'Confirm revoke'}</button>
      <button type="button" disabled={revoking} onClick={() => setRevokeTarget(undefined)}>Cancel</button>
    </div> : null}
    {selectedHost ? <HostSecurityActions key={selectedHost.id} host={selectedHost} service={service} /> : null}
    {onNewSession ? <button type="button" disabled={quotaExhausted} onClick={onNewSession}>New session</button> : null}
    <button type="button" className="lab-pair-host" onClick={() => setShowPairing((value) => !value)} aria-expanded={showPairing}>Pair Agent Host</button>
    </div>
    {hostError ? <p className="lab-control-note" role="alert">{hostError}</p> : null}
    {managementVisible && reauthenticate ? <ReauthenticationNotice /> : null}
    {failure ? <p className="lab-control-note" role="alert">{failure}</p> : null}
    {managementVisible && showPairing ? <div className="lab-pairing-details">
      <p className="lab-control-note">Generate a pairing key, then run <code>agent-remote-controller start</code> for a managed CLI Host or configure the DSH Host plugin. Use <code>agent-remote-controller pair</code> only to replace the uplink of an already-running Host daemon. Give a Host on another machine a reachable broker address instead of the loopback URL shown by a local browser.</p>
      {invitation?.command ? <p className="lab-control-note">Copy and run the setup command below. After pairing, the managed Host saves its connection privately for restart and stays paired until revoked.</p> : null}
      {invitation ? <>
        <label htmlFor="pairing-configuration">Agent Host configuration</label>
        <textarea id="pairing-configuration" readOnly value={configuration} rows={5} spellCheck={false} />
        <p className="lab-control-note" role="status">{expired ? 'This key expired. Generate a new key to pair another Host.' : `Pair before ${new Date(invitation.expiresAt).toLocaleTimeString()}. Keep the key private.`}</p>
        <button type="button" disabled={expired} onClick={() => {
          void navigator.clipboard.writeText(configuration).then(() => setCopied(true)).catch(() => setFailure('Copy failed. Select and copy the configuration above.'));
        }}>{copied ? 'Copied' : 'Copy configuration'}</button>
      </> : null}
      <button type="button" disabled={pairing} onClick={() => void pair()}>{pairing ? 'Generating…' : invitation ? 'Generate new key' : 'Generate pairing key'}</button>
    </div> : null}
  </section>;
}

function detectionLabel(status: 'found' | 'not-found' | 'unknown'): string {
  return status === 'found' ? 'Installed' : status === 'not-found' ? 'Not found' : 'Unknown';
}

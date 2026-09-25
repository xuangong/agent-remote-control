import type { HostProviderChange, HostProviderSettings, CodexDaemonRestart, CodexDaemonStatus, ControllerIdentity, ControllerRelease, ControllerUpdateStatus, HostEnvironment, PairingPurpose } from '@orchardworks/agent-remote-protocol';
import { hostDisplayLabel, hostEnvironmentLabels, matchesHostEnvironment } from './host-environment.js';
import { useFeedbackToast } from './Toast.js';
import { useState } from 'react';
import { PairingKeys } from './PairingKeys.js';
import { HostSecurityActions } from './HostSecurityActions.js';

export interface HostProvider { providerId: string; displayName: string; daemonControl?: true }
export interface RemoteHost {
  id: string; name: string; online: boolean; managed?: boolean; providers?: HostProvider[]; providerId?: string;
  controller?: ControllerIdentity;
  providerManagement?: true;
  credentialRotation?: boolean; environment?: HostEnvironment;
  access?: 'owner' | 'shared'; sessionQuota?: { limit: number; used: number };
}
export type { PairingPurpose } from '@orchardworks/agent-remote-protocol';
export interface PairingInvitation { id?: string; key: string; expiresAt: string; serverUrl: string; command?: string; purpose?: PairingPurpose; createdAt?: string }
export interface PairingRecord { id: string; purpose: PairingPurpose; createdAt: string; expiresAt: string; status: 'unused' | 'used' | 'obsolete' | 'revoked'; usedAt?: string; revokedAt?: string; hostId?: string; hostName?: string }
export interface PairingHistory { pairings: PairingRecord[]; availablePurposes?: PairingPurpose[] }
export interface HostStopResult { agentId: string; status: 'cancelled' | 'unsupported' | 'failed'; message?: string }
export interface HostPairingService {
  providerSettings?(hostId: string, input?: HostProviderChange): Promise<HostProviderSettings>;
  codexDaemon?(hostId: string, input?: CodexDaemonRestart): Promise<CodexDaemonStatus>;
  controllerRelease?(options?: { refresh?: boolean }): Promise<{ release: ControllerRelease | null }>;
  controllerUpdate?(hostId: string, input?: { version: string; operationId: string }): Promise<ControllerUpdateStatus>;
  invitation?: PairingInvitation;
  hosts(): Promise<{ hosts: RemoteHost[] }>;
  pair(purpose?: PairingPurpose): Promise<PairingInvitation>;
  pairings?(): Promise<PairingHistory>;
  revokePairing?(id: string): Promise<void>;
  deletePairing?(id: string): Promise<void>;
  revoke?(hostId: string): Promise<void>;
  rotate?(hostId: string): Promise<{ ok: true; status: 'pending' | 'rotated' }>;
  stop?(hostId: string): Promise<{ results: HostStopResult[] }>;
}

export function HostPairing({ service, selectedHostId, selectionLocked, onSelect, hosts, hostError, onRetryHosts, onNewSession, managementVisible = true, compact = false }: {
  compact?: boolean;
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
  const [failure, setFailure] = useState<string>();
  useFeedbackToast('Host connection', failure ?? hostError);
  const [showPairing, setShowPairing] = useState(service.invitation !== undefined);

  async function revoke(): Promise<void> {
    if (!revokeTarget || !service.revoke || revoking) return;
    setRevoking(true);
    setFailure(undefined);
    try { await service.revoke(revokeTarget.id); setRevokeTarget(undefined); onRetryHosts(); }
    catch (error) { setFailure(error instanceof Error ? error.message : 'Could not revoke the Host.'); }
    finally { setRevoking(false); }
  }

  const hostFilter = <>
    <label htmlFor="host-environment-filter">Find an execution environment</label>
    <input id="host-environment-filter" type="search" value={filter} disabled={selectionLocked}
      placeholder="Filter Hosts: Linux, zsh, Chrome…" autoComplete="off" spellCheck={false}
      onChange={event => setFilter(event.target.value)} />
    {filter.trim() ? <small role="status">{matchingHosts.length ? `${matchingHosts.length} matching Hosts` : 'No matching Hosts'}</small> : null}
  </>;
  const environment = <>
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
  </>;

  return <section className={`lab-host-pairing${compact ? ' lab-host-pairing-compact' : ''}`} aria-label="Remote Hosts">
    <div className="lab-directory-heading"><h2>Hosts</h2><button type="button" onClick={onRetryHosts}>Retry Hosts</button></div>
    {!compact ? hostFilter : null}
    <label className={compact ? 'agent-visually-hidden' : undefined} htmlFor="remote-host">Connected Host</label>
    <select id="remote-host" title={selectedHost ? hostDisplayLabel(selectedHost) : undefined} value={selectedHostId} disabled={selectionLocked} onChange={(event) => { const host = hosts.find((item) => item.id === event.target.value); if (host) onSelect(host); }}>
      {hosts.length > 0 && !selectedHost ? <option value={selectedHostId}>Select a Host</option> : null}
      {selectedHost && !matchingHosts.includes(selectedHost) ? <option value={selectedHost.id} disabled>{selectedHost.name} · Current selection (filtered out)</option> : null}
      {hosts.length ? matchingHosts.map((host) => <option key={host.id} value={host.id}>{hostDisplayLabel(host)}</option>) : <option value={selectedHostId}>No connected Hosts</option>}
    </select>
    {compact ? <details className="lab-host-disclosure"><summary>Filter &amp; Host details{filter.trim() ? <span>Filtered</span> : null}</summary><div>{hostFilter}{environment}</div></details> : environment}
    {quota ? <p className="lab-control-note" role="status">Session creation allowance used: {quota.used} / {quota.limit}. This total does not reset when sessions finish.{quotaExhausted ? ' Creation limit reached. Existing sessions remain available.' : ''}</p> : null}
    <div hidden={!managementVisible}>
    {selectedHost?.managed && selectedHost.access !== 'shared' && service.revoke ? <button type="button" onClick={() => setRevokeTarget(selectedHost)}>Revoke Host</button> : null}
    {revokeTarget ? <div role="group" aria-label="Confirm Host revocation">
      <p>Revoke {revokeTarget.name}? Its remote connections will close. Running work may continue. Use Stop work first to request cancellation. Pair it again to restore access.</p>
      <button type="button" disabled={revoking} onClick={() => void revoke()}>{revoking ? 'Revoking…' : 'Confirm revoke'}</button>
      <button type="button" disabled={revoking} onClick={() => setRevokeTarget(undefined)}>Cancel</button>
    </div> : null}
    {selectedHost ? <HostSecurityActions key={selectedHost.id} host={selectedHost} service={service} visible={managementVisible} /> : null}
    {onNewSession ? <button type="button" disabled={quotaExhausted} onClick={onNewSession}>New session</button> : null}
    <button type="button" className="lab-pair-host" onClick={() => setShowPairing((value) => !value)} aria-expanded={showPairing}>Pair Agent Host</button>
    </div>
    {hostError ? <p className="lab-control-note" role="alert">{hostError}</p> : null}
    {failure ? <p className="lab-control-note" role="alert">{failure}</p> : null}
    {managementVisible && showPairing ? <PairingKeys service={service} /> : null}
  </section>;
}

function detectionLabel(status: 'found' | 'not-found' | 'unknown'): string {
  return status === 'found' ? 'Installed' : status === 'not-found' ? 'Not found' : 'Unknown';
}

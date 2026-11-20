import type { HostProviderChange, HostProviderSettings, CodexDaemonRestart, CodexDaemonStatus, ControllerIdentity, ControllerReleaseDiscovery, ControllerUpdateStatus, HostEnvironment, PairingPurpose } from '@orchardworks/agent-remote-protocol';
import { hostDisplayLabel, hostEnvironmentLabels, matchesHostEnvironment } from './host-environment.js';
import { useFeedbackToast } from './Toast.js';
import { useState } from 'react';

export interface HostProvider { providerId: string; displayName: string; daemonControl?: true; sessionRename?: true; sessionReferences?: true; referenceNotes?: true; sessionCommands?: true }
export interface RemoteHost {
  id: string; name: string; online: boolean; managed?: boolean; providers?: HostProvider[]; providerId?: string;
  controller?: ControllerIdentity;
  providerManagement?: true;
  teamManagement?: true;
  /** The Controller answers Host status reads: open sessions, CPU, memory and disks. */
  hostStatus?: true;
  /** The Relay owns this Host's session control; without it the Controller cannot open sessions until it is updated. */
  sessionControl?: true;
  /** The Controller delivers messages that waited for this Host while it was offline; the Relay remembers it while offline. */
  outbox?: 1;
  credentialRotation?: boolean; environment?: HostEnvironment;
  access?: 'owner' | 'shared'; sessionQuota?: { limit: number; used: number };
}
export type { PairingPurpose } from '@orchardworks/agent-remote-protocol';
export interface PairingInvitation { id?: string; key: string; expiresAt: string; serverUrl: string; command?: string; purpose?: PairingPurpose; createdAt?: string }
export interface PairingRecord { id: string; purpose: PairingPurpose; createdAt: string; expiresAt: string; status: 'unused' | 'used' | 'obsolete' | 'revoked'; usedAt?: string; revokedAt?: string; hostId?: string; hostName?: string }
export interface PairingHistory { pairings: PairingRecord[]; availablePurposes?: PairingPurpose[] }
export interface HostStopResult { agentId: string; status: 'cancelled' | 'unsupported' | 'failed'; message?: string }
export interface HostPairingService {
  readonly serverUrl?: string;
  providerSettings?(hostId: string, input?: HostProviderChange): Promise<HostProviderSettings>;
  codexDaemon?(hostId: string, input?: CodexDaemonRestart): Promise<CodexDaemonStatus>;
  controllerRelease?(options?: { refresh?: boolean }): Promise<ControllerReleaseDiscovery>;
  controllerUpdate?(hostId: string, input?: { version: string; operationId: string }): Promise<ControllerUpdateStatus>;
  hostStatus?(hostId: string): Promise<import('@orchardworks/agent-remote-protocol').HostStatus>;
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

/** What a Host reports about where it runs: its tags, the detection details and whether the reader owns it. */
export function HostEnvironmentDetails({ host }: { host: RemoteHost }) {
  return <>
    <div className="lab-host-environment" aria-label="Host environment">
      {host.environment ? <>
        <div className="lab-host-environment-tags">{hostEnvironmentLabels(host).map((label, index) => <span key={`${index}:${label}`}>{label}</span>)}</div>
        <details><summary>Detection details</summary>
          <dl><dt>System release</dt><dd>{host.environment.os.release}</dd>
            <dt>Primary shell</dt><dd>{host.environment.shell.name ?? 'Unknown'} · {host.environment.shell.source}</dd>
            <dt>WSL / Container</dt><dd>{[host.environment.wsl, host.environment.container].map(value => value === null ? 'Unknown' : value ? 'Yes' : 'No').join(' / ')}</dd>
            <dt>Browsers</dt><dd>{host.environment.browsers.map(item => `${item.name}: ${detectionLabel(item.status)}`).join(', ') || 'Unknown'}</dd>
            <dt>Shells</dt><dd>{host.environment.shells.map(item => `${item.name}: ${detectionLabel(item.status)}`).join(', ') || 'Unknown'}</dd>
            <dt>VS Code</dt><dd>{detectionLabel(host.environment.vscode.status)}</dd>
          </dl>
          <p>Detected at {new Date(host.environment.detectedAt).toLocaleString()}. Restart the Controller to refresh. Installed software does not imply a running desktop or remote browser control.</p>
        </details>
      </> : <small>Environment unknown · This Host has not reported detection results.</small>}
    </div>
    {host.access ? <p className="lab-control-note">{host.access === 'shared' ? 'Shared with you' : 'You own this Host'}</p> : null}
  </>;
}

/** Revoke Host with its confirmation, for a Host the reader owns and a service that can revoke. */
export function HostRevoke({ host, service, onRevoked }: { host: RemoteHost; service: HostPairingService; onRevoked(): void }) {
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [failure, setFailure] = useState<string>();
  useFeedbackToast('Host connection', failure);
  async function revoke(): Promise<void> {
    if (!service.revoke || revoking) return;
    setRevoking(true);
    setFailure(undefined);
    try { await service.revoke(host.id); setConfirming(false); onRevoked(); }
    catch (error) { setFailure(error instanceof Error ? error.message : 'Could not revoke the Host.'); }
    finally { setRevoking(false); }
  }
  if (!host.managed || host.access === 'shared' || !service.revoke) return null;
  return <>
    <button type="button" onClick={() => setConfirming(true)}>Revoke Host</button>
    {confirming ? <div role="group" aria-label="Confirm Host revocation">
      <p>Revoke {host.name}? Its remote connections will close. Running work may continue. Use Stop work first to request cancellation. Pair it again to restore access.</p>
      <button type="button" disabled={revoking} onClick={() => void revoke()}>{revoking ? 'Revoking…' : 'Confirm revoke'}</button>
      <button type="button" disabled={revoking} onClick={() => setConfirming(false)}>Cancel</button>
    </div> : null}
    {failure ? <p className="lab-control-note" role="alert">{failure}</p> : null}
  </>;
}

/** The Host select of the sessions panels: the connected Host, a filter, its environment and the creation allowance. */
export function HostPairing({ selectedHostId, selectionLocked, onSelect, hosts, hostError, onRetryHosts, onNewSession, compact = false }: {
  compact?: boolean;
  selectedHostId: string; selectionLocked?: boolean; onSelect(host: RemoteHost): void; hosts: RemoteHost[]; hostError?: string; onRetryHosts(): void; onNewSession?(): void;
}) {
  const [filter, setFilter] = useState('');
  const matchingHosts = hosts.filter(host => matchesHostEnvironment(host, filter));
  const selectedHost = hosts.find(host => host.id === selectedHostId);
  const quota = selectedHost?.sessionQuota;
  const quotaExhausted = quota !== undefined && quota.used >= quota.limit;
  useFeedbackToast('Host connection', hostError);

  const hostFilter = <>
    <label htmlFor="host-environment-filter">Find an execution environment</label>
    <input id="host-environment-filter" type="search" value={filter} disabled={selectionLocked}
      placeholder="Filter Hosts: Linux, zsh, Chrome…" autoComplete="off" spellCheck={false}
      onChange={event => setFilter(event.target.value)} />
    {filter.trim() ? <small role="status">{matchingHosts.length ? `${matchingHosts.length} matching Hosts` : 'No matching Hosts'}</small> : null}
  </>;
  const environment = selectedHost ? <HostEnvironmentDetails host={selectedHost} /> : null;

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
    {onNewSession ? <button type="button" disabled={quotaExhausted} onClick={onNewSession}>New session</button> : null}
    {hostError ? <p className="lab-control-note" role="alert">{hostError}</p> : null}
  </section>;
}

function detectionLabel(status: 'found' | 'not-found' | 'unknown'): string {
  return status === 'found' ? 'Installed' : status === 'not-found' ? 'Not found' : 'Unknown';
}

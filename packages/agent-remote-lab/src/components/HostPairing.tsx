import { useEffect, useState } from 'react';

export interface HostProvider { providerId: string; displayName: string }
export interface RemoteHost {
  id: string; name: string; online: boolean; managed?: boolean; providers?: HostProvider[]; providerId?: string;
  access?: 'owner' | 'shared'; sessionQuota?: { limit: number; used: number };
}
export interface PairingInvitation { id?: string; key: string; expiresAt: string; serverUrl: string; command?: string }
export interface HostPairingService {
  invitation?: PairingInvitation;
  hosts(): Promise<{ hosts: RemoteHost[] }>;
  pair(): Promise<PairingInvitation>;
  revoke?(hostId: string): Promise<void>;
}

export function HostPairing({ service, selectedHostId, selectionLocked, onSelect, hosts, hostError, onRetryHosts, onNewSession, managementVisible = true }: {
  managementVisible?: boolean;
  service: HostPairingService; selectedHostId: string; selectionLocked?: boolean; onSelect(host: RemoteHost): void; hosts: RemoteHost[]; hostError?: string; onRetryHosts(): void; onNewSession?(): void;
}) {
  const [revokeTarget, setRevokeTarget] = useState<RemoteHost>();
  const [revoking, setRevoking] = useState(false);
  const selectedHost = hosts.find(host => host.id === selectedHostId);
  const quota = selectedHost?.sessionQuota;
  const quotaExhausted = quota !== undefined && quota.used >= quota.limit;
  const [failure, setFailure] = useState<string>();
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
    setFailure(undefined);
    try { const next = await service.pair(); service.invitation = next; setInvitation(next); setCopied(false); setShowPairing(true); }
    catch (error) { setFailure(error instanceof Error ? error.message : 'Could not create a pairing key.'); }
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
    <label htmlFor="remote-host">Connected Host</label>
    <select id="remote-host" value={selectedHostId} disabled={selectionLocked} onChange={(event) => { const host = hosts.find((item) => item.id === event.target.value); if (host) onSelect(host); }}>
      {hosts.length > 0 && !selectedHost ? <option value={selectedHostId}>Select a Host</option> : null}
      {hosts.length ? hosts.map((host) => <option key={host.id} value={host.id}>{host.name} · {host.online ? 'Online' : 'Offline'}{host.access === 'shared' ? ' · Shared' : ''}</option>) : <option value={selectedHostId}>No connected Hosts</option>}
    </select>
    {selectedHost?.access ? <p className="lab-control-note">{selectedHost.access === 'shared' ? 'Shared with you' : 'You own this Host'}</p> : null}
    {quota ? <p className="lab-control-note" role="status">Session creation allowance used: {quota.used} / {quota.limit}. This total does not reset when sessions finish.{quotaExhausted ? ' Creation limit reached. Existing sessions remain available.' : ''}</p> : null}
    <div hidden={!managementVisible}>
    {selectedHost?.managed && selectedHost.access !== 'shared' && service.revoke ? <button type="button" onClick={() => setRevokeTarget(selectedHost)}>Revoke Host</button> : null}
    {revokeTarget ? <div role="group" aria-label="Confirm Host revocation">
      <p>Revoke {revokeTarget.name}? Its connection and sessions will close. Pair it again to restore access.</p>
      <button type="button" disabled={revoking} onClick={() => void revoke()}>{revoking ? 'Revoking…' : 'Confirm revoke'}</button>
      <button type="button" disabled={revoking} onClick={() => setRevokeTarget(undefined)}>Cancel</button>
    </div> : null}
    {onNewSession ? <button type="button" disabled={quotaExhausted} onClick={onNewSession}>New session</button> : null}
    <button type="button" className="lab-pair-host" onClick={() => setShowPairing((value) => !value)} aria-expanded={showPairing}>Pair Agent Host</button>
    </div>
    {hostError ? <p className="lab-control-note" role="alert">{hostError}</p> : null}
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

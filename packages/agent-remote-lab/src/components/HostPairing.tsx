import { useEffect, useState } from 'react';

export interface HostProvider { providerId: string; displayName: string }
export interface RemoteHost { id: string; name: string; online: boolean; providers?: HostProvider[]; providerId?: string }
export interface PairingInvitation { id?: string; key: string; expiresAt: string; serverUrl: string; command?: string }
export interface HostPairingService {
  invitation?: PairingInvitation;
  hosts(): Promise<{ hosts: RemoteHost[] }>;
  pair(): Promise<PairingInvitation>;
}

export function HostPairing({ service, selectedHostId, selectionLocked, onSelect, hosts, hostError, onRetryHosts, onNewSession }: {
  service: HostPairingService; selectedHostId: string; selectionLocked?: boolean; onSelect(host: RemoteHost): void; hosts: RemoteHost[]; hostError?: string; onRetryHosts(): void; onNewSession?(): void;
}) {
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

  const configuration = invitation?.command ?? (invitation ? `serverUrl: ${invitation.serverUrl}\nremoteKey: ${invitation.key}` : '');
  return <section className="lab-host-pairing" aria-label="Remote Hosts">
    <div className="lab-directory-heading"><h2>Hosts</h2><button type="button" onClick={onRetryHosts}>Retry Hosts</button></div>
    <label htmlFor="remote-host">Connected Host</label>
    <select id="remote-host" value={selectedHostId} disabled={selectionLocked} onChange={(event) => { const host = hosts.find((item) => item.id === event.target.value); if (host) onSelect(host); }}>
      {hosts.length ? hosts.map((host) => <option key={host.id} value={host.id}>{host.name} · {host.online ? 'Online' : 'Offline'}</option>) : <option value="local">No connected Hosts</option>}
    </select>
    {onNewSession ? <button type="button" onClick={onNewSession}>New session</button> : null}
    <button type="button" className="lab-pair-host" onClick={() => setShowPairing((value) => !value)} aria-expanded={showPairing}>Pair Agent Host</button>
    {hostError ? <p className="lab-control-note" role="alert">{hostError}</p> : null}
    {failure ? <p className="lab-control-note" role="alert">{failure}</p> : null}
    {showPairing ? <div className="lab-pairing-details">
      <p className="lab-control-note">Generate a temporary key, then run <code>pnpm agent-host start</code> for a managed CLI Host or configure the DSH Host plugin. Use <code>pnpm agent-host pair</code> only to replace the uplink of an already-running Host daemon. Give a Host on another machine a reachable broker address instead of the loopback URL shown by a local browser.</p>
      {invitation ? <>
        <label htmlFor="pairing-configuration">Agent Host configuration</label>
        <textarea id="pairing-configuration" readOnly value={configuration} rows={5} spellCheck={false} />
        <p className="lab-control-note" role="status">{expired ? 'This key expired. Generate a new key to pair another Host.' : `Key expires ${new Date(invitation.expiresAt).toLocaleTimeString()}. Keep it private.`}</p>
        <button type="button" disabled={expired} onClick={() => {
          void navigator.clipboard.writeText(configuration).then(() => setCopied(true)).catch(() => setFailure('Copy failed. Select and copy the configuration above.'));
        }}>{copied ? 'Copied' : 'Copy configuration'}</button>
      </> : null}
      <button type="button" disabled={pairing} onClick={() => void pair()}>{pairing ? 'Generating…' : invitation ? 'Generate new key' : 'Generate pairing key'}</button>
    </div> : null}
  </section>;
}

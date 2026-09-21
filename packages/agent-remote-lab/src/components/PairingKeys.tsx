import { useEffect, useRef, useState } from 'react';
import type { HostPairingService, PairingHistory, PairingInvitation, PairingPurpose, PairingRecord } from './HostPairing.js';
import { needsReauthentication } from '../security-client.js';
import { ReauthenticationNotice } from './ReauthenticationNotice.js';

const purposeLabels: Record<PairingPurpose, string> = { 'host-only': 'Host only', 'gateway-setup': 'Gateway token + CLI setup' };
const statusLabels: Record<PairingRecord['status'], string> = { unused: 'Unused', used: 'Used', obsolete: 'Obsolete', revoked: 'Revoked' };

export function PairingKeys({ service }: { service: HostPairingService }) {
  const [invitation, setInvitation] = useState<PairingInvitation | undefined>(service.invitation);
  const [purpose, setPurpose] = useState<PairingPurpose>('host-only');
  const [history, setHistory] = useState<PairingHistory>();
  const [loading, setLoading] = useState(Boolean(service.pairings));
  const [failure, setFailure] = useState<string>();
  const [historyFailure, setHistoryFailure] = useState<string>();
  const [reauthenticate, setReauthenticate] = useState(false);
  const [busy, setBusy] = useState(false);
  const operation = useRef(false);
  const [confirmation, setConfirmation] = useState<{ record: PairingRecord; action: 'revoke' | 'delete' }>();
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(true);
  const expired = invitation !== undefined && Date.parse(invitation.expiresAt) <= now;
  const configuration = invitation?.command ?? (invitation ? `serverUrl: ${invitation.serverUrl}\nremoteKey: ${invitation.key}` : '');
  const availablePurposes = history?.availablePurposes ?? ['host-only'];

  function clearInvitation(): void { service.invitation = undefined; setInvitation(undefined); setCopied(false); }
  function authFailure(error: unknown): boolean {
    if (!needsReauthentication(error)) return false;
    setReauthenticate(true);
    setConfirmation(undefined);
    clearInvitation();
    return true;
  }
  async function refresh(): Promise<void> {
    if (!service.pairings) return;
    setLoading(true);
    setHistoryFailure(undefined);
    try {
      const next = await service.pairings();
      if (!mounted.current) return;
      setHistory(next);
      setPurpose(current => next.availablePurposes?.includes(current) ? current : 'host-only');
      const current = service.invitation;
      if (current?.id && !next.pairings.some(item => item.id === current.id && item.status === 'unused')) clearInvitation();
    } catch (error) {
      if (mounted.current && !authFailure(error)) setHistoryFailure(error instanceof Error ? error.message : 'Could not load pairing history.');
    } finally { if (mounted.current) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [service]);

  async function create(): Promise<void> {
    if (operation.current || loading) return;
    operation.current = true; setBusy(true); setFailure(undefined); setReauthenticate(false);
    try {
      const next = await service.pair(purpose);
      service.invitation = next;
      if (!mounted.current) return;
      setInvitation(next); setCopied(false);
      await refresh();
    } catch (error) {
      if (mounted.current && !authFailure(error)) setFailure(error instanceof Error ? error.message : 'Could not create a pairing key.');
    } finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  async function confirm(): Promise<void> {
    if (!confirmation || operation.current) return;
    const { record, action } = confirmation;
    const mutate = action === 'revoke' ? service.revokePairing : service.deletePairing;
    if (!mutate) return;
    operation.current = true; setBusy(true); setFailure(undefined); setReauthenticate(false);
    try {
      await mutate.call(service, record.id);
      if (!mounted.current) return;
      if (service.invitation?.id === record.id) clearInvitation();
      setConfirmation(undefined);
      await refresh();
    } catch (error) {
      if (mounted.current && !authFailure(error)) setFailure(error instanceof Error ? error.message : 'Could not update the pairing key. Refresh history before trying again.');
    } finally { operation.current = false; if (mounted.current) setBusy(false); }
  }

  return <div className="lab-pairing-details">
    <p className="lab-control-note">Generate a pairing key, then run <code>agent-remote-controller start</code> for a managed CLI Host or configure the DSH Host plugin. Use <code>agent-remote-controller pair</code> only to replace the uplink of an already-running Host daemon. Give a Host on another machine a reachable broker address instead of the loopback URL shown by a local browser.</p>
    <label htmlFor="pairing-purpose">Pairing purpose</label>
    <select id="pairing-purpose" value={purpose} disabled={busy || loading} onChange={event => setPurpose(event.target.value as PairingPurpose)} aria-describedby="pairing-purpose-help">
      <option value="host-only">Host only</option>
      {availablePurposes.includes('gateway-setup') ? <option value="gateway-setup">Gateway token + CLI setup</option> : null}
    </select>
    <p id="pairing-purpose-help" className="lab-control-note">{purpose === 'host-only' ? 'Connect the Host using its existing provider configuration.' : 'Create a Gateway token and initialize the CLI configured by this Host during setup.'}</p>
    {reauthenticate ? <ReauthenticationNotice /> : null}
    {failure ? <p role="alert" className="lab-control-note">{failure}</p> : null}
    {invitation?.command ? <p className="lab-control-note">Copy and run the setup command below. After pairing, the managed Host saves its connection privately for restart and stays paired until revoked.</p> : null}
    {invitation ? <>
      <label htmlFor="pairing-configuration">Agent Host configuration{invitation.purpose ? ` · ${purposeLabels[invitation.purpose]}` : ''}</label>
      <textarea id="pairing-configuration" readOnly value={configuration} rows={5} spellCheck={false} />
      <p className="lab-control-note" role="status">{expired ? 'This key expired. Generate a new key to pair another Host.' : `Pair before ${new Date(invitation.expiresAt).toLocaleString()}. Keep the key private.`}</p>
      <button type="button" disabled={expired} onClick={() => { void navigator.clipboard.writeText(configuration).then(() => setCopied(true)).catch(() => setFailure('Copy failed. Select and copy the configuration above.')); }}>{copied ? 'Copied' : 'Copy configuration'}</button>
    </> : null}
    <button type="button" disabled={busy || loading} onClick={() => void create()}>{busy ? 'Working…' : invitation ? 'Generate new key' : 'Generate pairing key'}</button>
    {service.pairings ? <section className="lab-pairing-history" aria-label="Pairing key history">
      <div className="lab-directory-heading"><h3>Pairing key history</h3><button type="button" disabled={loading || busy} onClick={() => void refresh()}>Refresh keys</button></div>
      <p className="lab-control-note">Keys are only shown when created. History contains no secrets.</p>
      {loading ? <p role="status">Loading pairing keys…</p> : null}
      {historyFailure ? <p role="alert">{historyFailure}</p> : null}
      {history?.pairings.length === 0 ? <p>No pairing keys yet.</p> : null}
      <ul>{history?.pairings.map(record => {
        const status = record.status === 'unused' && Date.parse(record.expiresAt) <= now ? 'obsolete' : record.status;
        return <li key={record.id} data-pairing-id={record.id}>
          <div className="lab-pairing-record-heading"><strong>{purposeLabels[record.purpose]}</strong><span>{statusLabels[status]}</span></div>
          <dl><dt>Created</dt><dd><time dateTime={record.createdAt}>{new Date(record.createdAt).toLocaleString()}</time></dd>
            <dt>Expires</dt><dd><time dateTime={record.expiresAt}>{new Date(record.expiresAt).toLocaleString()}</time></dd>
            {record.hostId ? <><dt>Host</dt><dd>{record.hostName ?? record.hostId}{record.hostName ? ` (${record.hostId})` : ''}</dd></> : null}
            {record.usedAt ? <><dt>Used</dt><dd>{new Date(record.usedAt).toLocaleString()}</dd></> : null}
            {record.revokedAt ? <><dt>Revoked</dt><dd>{new Date(record.revokedAt).toLocaleString()}</dd></> : null}
          </dl>
          <div className="lab-pairing-record-actions">
            {status === 'unused' && service.revokePairing ? <button type="button" disabled={busy} onClick={() => setConfirmation({ record, action: 'revoke' })}>Revoke key</button> : null}
            {service.deletePairing ? <button type="button" disabled={busy} onClick={() => setConfirmation({ record: { ...record, status }, action: 'delete' })}>Delete history</button> : null}
          </div>
        </li>;
      })}</ul>
      {confirmation ? <div role="group" aria-label={confirmation.action === 'delete' ? 'Confirm pairing history deletion' : 'Confirm pairing key revocation'} className="gateway-security-confirmation">
        <p>{confirmation.action === 'revoke' ? 'Revoke this unused key? It will no longer connect a Host.' : confirmation.record.status === 'unused' ? 'Deleting this record invalidates this unused key immediately.' : 'Delete this history record? This does not revoke Host credentials or Gateway tokens.'}</p>
        <button type="button" disabled={busy} onClick={() => void confirm()}>{confirmation.action === 'delete' ? 'Confirm deletion' : 'Confirm key revocation'}</button>
        <button type="button" disabled={busy} onClick={() => setConfirmation(undefined)}>{confirmation.action === 'delete' ? 'Cancel deletion' : 'Cancel revocation'}</button>
      </div> : null}
    </section> : null}
  </div>;
}

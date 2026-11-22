import { useEffect, useRef, useState } from 'react';
import { errorWords, type Translate } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { HostPairingService, PairingHistory, PairingInvitation, PairingPurpose, PairingRecord } from '../../kernel/remote-host.js';
import { needsReauthentication } from '../../kernel/security-client.js';
import { ReauthenticationNotice } from '../../conversation/ReauthenticationNotice.js';
import { ControllerInstallGuide } from './ControllerInstallGuide.js';

const purposeLabel = (t: Translate, purpose: PairingPurpose) => purpose === 'host-only' ? t('hosts.pairing.purposeHostOnly') : t('hosts.pairing.purposeGateway');
const statusLabel = (t: Translate, status: PairingRecord['status']) => t(({ unused: 'hosts.pairing.statusUnused', used: 'hosts.pairing.statusUsed', obsolete: 'hosts.pairing.statusObsolete', revoked: 'hosts.pairing.statusRevoked' } as const)[status]);

export function PairingKeys({ service }: { service: HostPairingService }) {
  const t = useTranslate();
  const words = useRef(t); words.current = t;
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
      if (mounted.current && !authFailure(error)) setHistoryFailure(errorWords(error, words.current, 'hosts.pairing.loadFailed'));
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
      if (mounted.current && !authFailure(error)) setFailure(errorWords(error, t, 'hosts.pairing.createFailed'));
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
      if (mounted.current && !authFailure(error)) setFailure(errorWords(error, t, 'hosts.pairing.updateFailed'));
    } finally { operation.current = false; if (mounted.current) setBusy(false); }
  }

  return <div className="lab-pairing-details">
    <ControllerInstallGuide serverUrl={invitation?.serverUrl ?? service.serverUrl} />
    <details><summary>{t('hosts.pairing.installedSummary')}</summary>
    <p className="lab-control-note">{t('hosts.pairing.installedBefore')}<code>agent-remote-controller start</code>{t('hosts.pairing.installedMiddle1')}<code>agent-remote-controller pair</code>{t('hosts.pairing.installedMiddle2')}</p>
    </details>
    <label htmlFor="pairing-purpose">{t('hosts.pairing.purpose')}</label>
    <select id="pairing-purpose" value={purpose} disabled={busy || loading} onChange={event => setPurpose(event.target.value as PairingPurpose)} aria-describedby="pairing-purpose-help">
      <option value="host-only">{purposeLabel(t, 'host-only')}</option>
      {availablePurposes.includes('gateway-setup') ? <option value="gateway-setup">{purposeLabel(t, 'gateway-setup')}</option> : null}
    </select>
    <p id="pairing-purpose-help" className="lab-control-note">{purpose === 'host-only' ? t('hosts.pairing.purposeHostHelp') : t('hosts.pairing.purposeGatewayHelp')}</p>
    {reauthenticate ? <ReauthenticationNotice /> : null}
    {failure ? <p role="alert" className="lab-control-note">{failure}</p> : null}
    {invitation?.command ? <p className="lab-control-note">{t('hosts.pairing.commandNote')}</p> : null}
    {invitation ? <>
      <label htmlFor="pairing-configuration">{t('hosts.pairing.configuration')}{invitation.purpose ? ` · ${purposeLabel(t, invitation.purpose)}` : ''}</label>
      <textarea id="pairing-configuration" readOnly value={configuration} rows={5} spellCheck={false} />
      <p className="lab-control-note" role="status">{expired ? t('hosts.pairing.expired') : t('hosts.pairing.validUntil', { time: new Date(invitation.expiresAt).toLocaleString() })}</p>
      <button type="button" disabled={expired} onClick={() => { void navigator.clipboard.writeText(configuration).then(() => setCopied(true)).catch(() => setFailure(t('hosts.pairing.copyConfigFailed'))); }}>{copied ? t('common.copied') : t('hosts.pairing.copyConfiguration')}</button>
    </> : null}
    <button type="button" disabled={busy || loading} onClick={() => void create()}>{busy ? t('hosts.pairing.working') : invitation ? t('hosts.pairing.generateNew') : t('hosts.pairing.generate')}</button>
    {service.pairings ? <section className="lab-pairing-history" aria-label={t('hosts.pairing.historyLabel')}>
      <div className="lab-directory-heading"><h3>{t('hosts.pairing.historyLabel')}</h3><button type="button" disabled={loading || busy} onClick={() => void refresh()}>{t('hosts.pairing.refresh')}</button></div>
      <p className="lab-control-note">{t('hosts.pairing.historyNote')}</p>
      {loading ? <p role="status">{t('hosts.pairing.loading')}</p> : null}
      {historyFailure ? <p role="alert">{historyFailure}</p> : null}
      {history?.pairings.length === 0 ? <p>{t('hosts.pairing.none')}</p> : null}
      <ul>{history?.pairings.map(record => {
        const status = record.status === 'unused' && Date.parse(record.expiresAt) <= now ? 'obsolete' : record.status;
        return <li key={record.id} data-pairing-id={record.id}>
          <div className="lab-pairing-record-heading"><strong>{purposeLabel(t, record.purpose)}</strong><span>{statusLabel(t, status)}</span></div>
          <dl><dt>{t('hosts.pairing.created')}</dt><dd><time dateTime={record.createdAt}>{new Date(record.createdAt).toLocaleString()}</time></dd>
            <dt>{t('hosts.pairing.expires')}</dt><dd><time dateTime={record.expiresAt}>{new Date(record.expiresAt).toLocaleString()}</time></dd>
            {record.hostId ? <><dt>{t('hosts.pairing.host')}</dt><dd>{record.hostName ?? record.hostId}{record.hostName ? ` (${record.hostId})` : ''}</dd></> : null}
            {record.usedAt ? <><dt>{t('hosts.pairing.used')}</dt><dd>{new Date(record.usedAt).toLocaleString()}</dd></> : null}
            {record.revokedAt ? <><dt>{t('hosts.pairing.revokedAt')}</dt><dd>{new Date(record.revokedAt).toLocaleString()}</dd></> : null}
          </dl>
          <div className="lab-pairing-record-actions">
            {status === 'unused' && service.revokePairing ? <button type="button" disabled={busy} onClick={() => setConfirmation({ record, action: 'revoke' })}>{t('hosts.pairing.revokeKey')}</button> : null}
            {service.deletePairing ? <button type="button" disabled={busy} onClick={() => setConfirmation({ record: { ...record, status }, action: 'delete' })}>{t('hosts.pairing.deleteHistory')}</button> : null}
          </div>
        </li>;
      })}</ul>
      {confirmation ? <div role="group" aria-label={confirmation.action === 'delete' ? t('hosts.pairing.confirmDeleteLabel') : t('hosts.pairing.confirmRevokeLabel')} className="gateway-security-confirmation">
        <p>{confirmation.action === 'revoke' ? t('hosts.pairing.confirmRevoke') : confirmation.record.status === 'unused' ? t('hosts.pairing.confirmDeleteUnused') : t('hosts.pairing.confirmDelete')}</p>
        <button type="button" disabled={busy} onClick={() => void confirm()}>{confirmation.action === 'delete' ? t('hosts.pairing.confirmDeletion') : t('hosts.pairing.confirmRevocation')}</button>
        <button type="button" disabled={busy} onClick={() => setConfirmation(undefined)}>{confirmation.action === 'delete' ? t('hosts.pairing.cancelDeletion') : t('hosts.pairing.cancelRevocation')}</button>
      </div> : null}
    </section> : null}
  </div>;
}

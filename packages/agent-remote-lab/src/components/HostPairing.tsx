import { hostDisplayLabel, hostEnvironmentLabels, matchesHostEnvironment } from './host-environment.js';
import { useFeedbackToast } from './Toast.js';
import { useState } from 'react';
import { errorWords } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';

import type { HostPairingService, RemoteHost } from '../kernel/remote-host.js';

/** What a Host reports about where it runs: its tags, the detection details and whether the reader owns it. */
export function HostEnvironmentDetails({ host }: { host: RemoteHost }) {
  const t = useTranslate();
  const unknown = t('common.unknown');
  const detection = (status: 'found' | 'not-found' | 'unknown') => status === 'found' ? t('hosts.env.installed') : status === 'not-found' ? t('hosts.env.notFound') : unknown;
  return <>
    <div className="lab-host-environment" aria-label={t('hosts.env.label')}>
      {host.environment ? <>
        <div className="lab-host-environment-tags">{hostEnvironmentLabels(host, t).map((label, index) => <span key={`${index}:${label}`}>{label}</span>)}</div>
        <details><summary>{t('hosts.env.detection')}</summary>
          <dl><dt>{t('hosts.env.systemRelease')}</dt><dd>{host.environment.os.release}</dd>
            <dt>{t('hosts.env.primaryShell')}</dt><dd>{host.environment.shell.name ?? unknown} · {host.environment.shell.source}</dd>
            <dt>{t('hosts.env.wslContainer')}</dt><dd>{[host.environment.wsl, host.environment.container].map(value => value === null ? unknown : value ? t('common.yes') : t('common.no')).join(' / ')}</dd>
            <dt>{t('hosts.env.browsers')}</dt><dd>{host.environment.browsers.map(item => `${item.name}: ${detection(item.status)}`).join(', ') || unknown}</dd>
            <dt>{t('hosts.env.shells')}</dt><dd>{host.environment.shells.map(item => `${item.name}: ${detection(item.status)}`).join(', ') || unknown}</dd>
            <dt>VS Code</dt><dd>{detection(host.environment.vscode.status)}</dd>
          </dl>
          <p>{t('hosts.env.detectedAt', { time: new Date(host.environment.detectedAt).toLocaleString() })}</p>
        </details>
      </> : <small>{t('hosts.env.unreported')}</small>}
    </div>
    {host.access ? <p className="lab-control-note">{host.access === 'shared' ? t('settings.computer.shared') : t('hosts.env.owned')}</p> : null}
  </>;
}

/** Revoke Host with its confirmation, for a Host the reader owns and a service that can revoke. */
export function HostRevoke({ host, service, onRevoked }: { host: RemoteHost; service: HostPairingService; onRevoked(): void }) {
  const t = useTranslate();
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [failure, setFailure] = useState<string>();
  useFeedbackToast(t('hosts.toast.connection'), failure);
  async function revoke(): Promise<void> {
    if (!service.revoke || revoking) return;
    setRevoking(true);
    setFailure(undefined);
    try { await service.revoke(host.id); setConfirming(false); onRevoked(); }
    catch (error) { setFailure(errorWords(error, t, 'hosts.revoke.failed')); }
    finally { setRevoking(false); }
  }
  if (!host.managed || host.access === 'shared' || !service.revoke) return null;
  return <>
    <button type="button" onClick={() => setConfirming(true)}>{t('hosts.revoke.action')}</button>
    {confirming ? <div role="group" aria-label={t('hosts.revoke.confirmLabel')}>
      <p>{t('hosts.revoke.confirm', { name: host.name })}</p>
      <button type="button" disabled={revoking} onClick={() => void revoke()}>{revoking ? t('hosts.revoke.revoking') : t('hosts.revoke.confirmAction')}</button>
      <button type="button" disabled={revoking} onClick={() => setConfirming(false)}>{t('common.cancel')}</button>
    </div> : null}
    {failure ? <p className="lab-control-note" role="alert">{failure}</p> : null}
  </>;
}

/** The Host select of the sessions panels: the connected Host, a filter, its environment and the creation allowance. */
export function HostPairing({ selectedHostId, selectionLocked, onSelect, hosts, hostError, onRetryHosts, onNewSession, compact = false }: {
  compact?: boolean;
  selectedHostId: string; selectionLocked?: boolean; onSelect(host: RemoteHost): void; hosts: RemoteHost[]; hostError?: string; onRetryHosts(): void; onNewSession?(): void;
}) {
  const t = useTranslate();
  const [filter, setFilter] = useState('');
  const matchingHosts = hosts.filter(host => matchesHostEnvironment(host, filter));
  const selectedHost = hosts.find(host => host.id === selectedHostId);
  const quota = selectedHost?.sessionQuota;
  const quotaExhausted = quota !== undefined && quota.used >= quota.limit;
  useFeedbackToast(t('hosts.toast.connection'), hostError);

  const hostFilter = <>
    <label htmlFor="host-environment-filter">{t('hosts.picker.filterLabel')}</label>
    <input id="host-environment-filter" type="search" value={filter} disabled={selectionLocked}
      placeholder={t('hosts.picker.filterPlaceholder')} autoComplete="off" spellCheck={false}
      onChange={event => setFilter(event.target.value)} />
    {filter.trim() ? <small role="status">{matchingHosts.length ? t('hosts.picker.matching', { count: matchingHosts.length }) : t('hosts.picker.noMatch')}</small> : null}
  </>;
  const environment = selectedHost ? <HostEnvironmentDetails host={selectedHost} /> : null;

  return <section className={`lab-host-pairing${compact ? ' lab-host-pairing-compact' : ''}`} aria-label={t('hosts.picker.label')}>
    <div className="lab-directory-heading"><h2>{t('hosts.picker.title')}</h2><button type="button" onClick={onRetryHosts}>{t('hosts.picker.retry')}</button></div>
    {!compact ? hostFilter : null}
    <label className={compact ? 'agent-visually-hidden' : undefined} htmlFor="remote-host">{t('hosts.picker.connected')}</label>
    <select id="remote-host" title={selectedHost ? hostDisplayLabel(selectedHost, t) : undefined} value={selectedHostId} disabled={selectionLocked} onChange={(event) => { const host = hosts.find((item) => item.id === event.target.value); if (host) onSelect(host); }}>
      {hosts.length > 0 && !selectedHost ? <option value={selectedHostId}>{t('hosts.picker.select')}</option> : null}
      {selectedHost && !matchingHosts.includes(selectedHost) ? <option value={selectedHost.id} disabled>{t('hosts.picker.filteredOut', { name: selectedHost.name })}</option> : null}
      {hosts.length ? matchingHosts.map((host) => <option key={host.id} value={host.id}>{hostDisplayLabel(host, t)}</option>) : <option value={selectedHostId}>{t('hosts.picker.none')}</option>}
    </select>
    {compact ? <details className="lab-host-disclosure"><summary>{t('hosts.picker.disclosure')}{filter.trim() ? <span>{t('hosts.picker.filtered')}</span> : null}</summary><div>{hostFilter}{environment}</div></details> : environment}
    {quota ? <p className="lab-control-note" role="status">{t('hosts.picker.quota', { used: quota.used, limit: quota.limit })}{quotaExhausted ? ` ${t('hosts.picker.quotaReached')}` : ''}</p> : null}
    {onNewSession ? <button type="button" disabled={quotaExhausted} onClick={onNewSession}>{t('hosts.picker.newSession')}</button> : null}
    {hostError ? <p className="lab-control-note" role="alert">{hostError}</p> : null}
  </section>;
}

import { useEffect, useRef, useState } from 'react';
import { compareControllerVersions, releaseCoversHost, PROTOCOL_VERSION, controllerUpdateTarget, controllerUpgradeBridgeVersion, type ControllerRelease, type ControllerUpdateStatus } from '@orchardworks/agent-remote-protocol';
import { errorWords, watchList } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { HostPairingService, RemoteHost } from '../../kernel/remote-host.js';
import { hostDisplayLabel } from './host-environment.js';
import { readControllerHealth, type ControllerHealthView } from './controller-health-view.js';

export function controllerUpdateCoverage(release: ControllerRelease | null, hosts: readonly RemoteHost[], bridge?: ControllerRelease | readonly ControllerRelease[]) {
  const owned = hosts.filter(host => host.access !== 'shared');
  const covered = !!release && owned.length > 0 && owned.every(host => {
    const platform = host.controller ?? (host.environment ? { platform: host.environment.os.platform, arch: host.environment.os.arch, nodeMajor: release.nodeMajor } : undefined);
    return host.controller ? !!controllerUpdateTarget(release, host.controller, bridge)
      : platform && release.protocolVersion === PROTOCOL_VERSION && releaseCoversHost(release, platform);
  });
  const outdated = release ? owned.filter(host => !host.controller || compareControllerVersions(release.version, host.controller.version) > 0) : [];
  return { owned, covered, outdated, eligible: outdated.filter(host => host.online && host.controller?.remoteUpdate && controllerUpdateTarget(release!, host.controller, bridge)) };
}
const phaseKeys = { idle: 'hosts.updates.phaseIdle', downloading: 'hosts.updates.phaseDownloading', waiting: 'hosts.updates.phaseWaiting', restarting: 'hosts.updates.phaseRestarting', succeeded: 'hosts.updates.phaseSucceeded', failed: 'hosts.updates.phaseFailed' } as const satisfies Record<ControllerUpdateStatus['phase'], string>;
export function ControllerUpdates({ service, hosts }: { service: HostPairingService; hosts: readonly RemoteHost[] }) {
  const t = useTranslate();
  const words = useRef(t); words.current = t;
  const [release, setRelease] = useState<ControllerRelease | null>(null);
  const [bridge, setBridge] = useState<ControllerRelease | readonly ControllerRelease[]>();
  const [bridgeError, setBridgeError] = useState<string>();
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const refreshRelease = useRef<() => void>(() => {});
  const [statuses, setStatuses] = useState<Record<string, ControllerUpdateStatus>>({});
  const current = useRef({ service, hosts }); current.current = { service, hosts };
  const mutationEpoch = useRef(0);
  const requests = useRef(new Map<string, { version: string; operationId: string }>());
  const { owned, covered, outdated, eligible } = controllerUpdateCoverage(release, hosts, bridge);
  const actionable = eligible.filter(host => !['downloading', 'waiting', 'restarting'].includes(statuses[host.id]?.phase ?? 'idle'));
  const available = eligible.length > 0;
  const confirmedBridges = [...new Set(eligible.flatMap(host => {
    if (!confirm?.includes(host.id) || !host.controller || !controllerUpgradeBridgeVersion(release!, host.controller)) return [];
    const target = controllerUpdateTarget(release!, host.controller, bridge);
    return target ? [target.version] : [];
  }))];
  useEffect(() => {
    let retired = false, loading = false;
    setRelease(null); setBridge(undefined); setBridgeError(undefined); setStatuses({}); setError(undefined); requests.current.clear(); setBusy(false); setConfirm(null);
    const discover = async (refresh = false) => {
      if (retired || loading || !service.controllerRelease) return;
      loading = true; setChecking(true);
      try { const result = await service.controllerRelease({ refresh }); if (!retired && current.current.service === service) { setRelease(result.release); setBridge(result.bridgeReleases ?? result.bridgeRelease); setBridgeError(result.bridgeError); setError(undefined); } }
      catch (cause) { if (!retired) setError(errorWords(cause, words.current, 'hosts.updates.checkFailed')); }
      finally { loading = false; if (!retired) setChecking(false); }
    };
    refreshRelease.current = () => { void discover(true); };
    const stop = watchList(() => discover(), 300000);
    return () => { retired = true; stop(); };
  }, [service]);
  const pending = Object.values(statuses).some(status => ['downloading', 'waiting', 'restarting'].includes(status.phase));
  const health = Object.fromEntries(Object.entries(statuses).flatMap(([hostId, status]) => { const value = readControllerHealth(status); return value ? [[hostId, value] as const] : []; }));
  const problems = Object.values(health).reduce((total, value) => total + value.warnings.filter(warning => warning.severity === 'warning').length, 0);
  useEffect(() => {
    // A collapsed panel still checks occasionally so Controller problems surface in its heading.
    let retired = false, loading = false;
    const stop = watchList(async () => {
      if (loading || !service.controllerUpdate) return; loading = true;
      const epoch = mutationEpoch.current;
      try {
        const values = await Promise.all(current.current.hosts.filter(host => host.access !== 'shared' && host.online && host.controller?.remoteUpdate).map(async host => {
          try { return [host.id, await service.controllerUpdate!(host.id)] as const; } catch { return undefined; }
        }));
        if (!retired && epoch === mutationEpoch.current) setStatuses(previous => ({ ...previous, ...Object.fromEntries(values.filter(value => value !== undefined)) }));
      } finally { loading = false; }
    }, pending ? 3000 : expanded ? 15000 : 300000);
    return () => { retired = true; stop(); };
  }, [service, expanded, pending]);
  async function update(targets: readonly RemoteHost[]) {
    if (busy || !release || !service.controllerUpdate) return;
    mutationEpoch.current++;
    setBusy(true); setConfirm(null); setError(undefined);
    try {
      for (const host of targets) {
        if (current.current.service !== service) return;
        const target = host.controller && controllerUpdateTarget(release, host.controller, bridge);
        if (!target) continue;
        const previous = requests.current.get(host.id);
        const input = previous?.version === target.version ? previous : { version: target.version, operationId: crypto.randomUUID() };
        requests.current.set(host.id, input);
        try {
          const status = await service.controllerUpdate(host.id, input);
          if (current.current.service === service) setStatuses(previous => ({ ...previous, [host.id]: status }));
        } catch (cause) {
          if (current.current.service === service) setStatuses(previous => ({ ...previous, [host.id]: { phase: 'failed', version: input.version, operationId: input.operationId, updatedAt: Date.now(),
            message: t('hosts.updates.retryNote', { message: errorWords(cause, t, 'hosts.updates.notConfirmed') }) } }));
        }
      }
    } finally { if (current.current.service === service) { mutationEpoch.current++; setBusy(false); } }
  }
  if (!service.controllerRelease || !owned.length) return null;
  return <section className="lab-controller-updates" aria-label={t('settings.computer.updates')}>
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{t('settings.computer.updates')}{available ? ` · ${t('hosts.updates.available', { version: release!.version })}` : ''}{problems ? ` · ${t('hosts.updates.problems', { count: problems })}` : ''}</button>
    {expanded ? <div>
      {error ? <p role="alert">{error}</p> : null}
      {bridgeError ? <p role="alert">{bridgeError}</p> : null}
      <p className="lab-controller-release">{release ? <span>{t('hosts.updates.latest')}<strong>{release.version}</strong></span> : <span>{checking ? t('hosts.updates.checkingLatest') : t('hosts.updates.noRelease')}</span>}
        <button type="button" disabled={checking} onClick={() => refreshRelease.current()}>{checking ? t('hosts.updates.refreshing') : t('common.refresh')}</button>
      </p>
      {release && !covered ? <p>{t('hosts.updates.incompatible')}</p> : null}
      <ul>{owned.map(host => {
        const status = statuses[host.id]; const needs = outdated.includes(host);
        const target = release && host.controller && controllerUpdateTarget(release, host.controller, bridge);
        const needsBridge = release && host.controller && controllerUpgradeBridgeVersion(release, host.controller);
        const continueUpdate = needs && eligible.includes(host) && status?.phase === 'succeeded' && status.version === host.controller?.version && status.version !== release?.version;
        const completed = status?.version === host.controller?.version && host.controller?.revision === release?.revision && host.online;
        return <li key={host.id}><div className="lab-controller-host-name" title={hostDisplayLabel(host, t)} role="region" aria-label={t('hosts.updates.hostName')} tabIndex={0}><strong>{host.name}</strong></div><span>{host.controller?.version ?? t('hosts.updates.versionMissing')} · {host.online ? t('common.online') : t('common.offline')}</span>
          {status && status.phase !== 'idle' ? <small role="status">{completed ? t('hosts.updates.phaseSucceeded') : continueUpdate ? t('hosts.updates.continueTo', { version: release?.version ?? '' }) : status.phase === 'succeeded' && status.version !== release?.version ? t('hosts.updates.bridgeInstalled') : t(phaseKeys[status.phase])}{!completed && status.message ? ` ${status.message}` : ''}</small> : null}
          {needsBridge ? <small>{target ? t('hosts.updates.bridgeTarget', { bridge: target.version, version: release?.version ?? '' }) : t('hosts.updates.bridgeNeeded')}</small> : null}
          {!host.controller?.remoteUpdate ? <small>{t('hosts.updates.launcher')}</small> : null}
          {needs && release && host.controller && !target && !needsBridge ? <small>{t('hosts.updates.unsupported', { version: release.version, current: host.controller.version })}</small> : null}
          {health[host.id] ? <ControllerHealthDetails value={health[host.id]!} /> : null}
          {needs && eligible.includes(host) ? <button type="button" disabled={busy || (!!status && ['downloading', 'waiting', 'restarting'].includes(status.phase))} onClick={() => setConfirm([host.id])}>{status?.phase === 'failed' ? t('hosts.updates.retryUpdate') : t('hosts.updates.updateHost')}</button> : null}
        </li>;
      })}</ul>
      {release ? <a href={`https://github.com/xuangong/agent-remote-control/releases/tag/controller-v${release.version}`} target="_blank" rel="noreferrer">{t('hosts.updates.notes')}</a> : null}
      {actionable.length > 1 ? <button type="button" disabled={busy} onClick={() => setConfirm(actionable.map(host => host.id))}>{t('hosts.updates.updateAll', { count: actionable.length })}</button> : null}
      {confirm?.length ? <div role="group" aria-label={t('hosts.updates.confirmLabel')}><p>{t('hosts.updates.confirm', { count: confirm.length, version: release?.version ?? '' })}</p>
        {confirmedBridges.length ? <p>{t('hosts.updates.confirmBridges', { versions: confirmedBridges.join(', '), version: release?.version ?? '' })}</p> : null}
        <button type="button" disabled={busy} onClick={() => void update(eligible.filter(host => confirm.includes(host.id)))}>{t('hosts.updates.confirmAction')}</button><button type="button" onClick={() => setConfirm(null)}>{t('common.cancel')}</button>
      </div> : null}
    </div> : null}
  </section>;
}

function ControllerHealthDetails({ value }: { value: ControllerHealthView }) {
  const t = useTranslate();
  const versions = [...value.natives.map(native => `${native.providerId} ${native.version}`), ...(value.launcher?.managed ? [t('hosts.updates.launcherVersion', { version: value.launcher.version ?? t('hosts.updates.launcherBefore') })] : [])];
  return <div className="lab-controller-health" role="group" aria-label={t('hosts.updates.healthLabel')}>
    {value.warnings.length ? <ul>{value.warnings.map(warning => <li key={warning.code} data-severity={warning.severity}>
      <small role={warning.severity === 'warning' ? 'alert' : undefined}>{warning.message}</small></li>)}</ul>
      : <small>{t('hosts.updates.healthOk')}</small>}
    {versions.length ? <small>{versions.join(' · ')}</small> : null}
  </div>;
}

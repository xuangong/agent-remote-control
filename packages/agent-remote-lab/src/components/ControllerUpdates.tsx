import { useEffect, useRef, useState } from 'react';
import { compareControllerVersions, releaseCoversHost, type ControllerRelease, type ControllerUpdateStatus } from '@orchardworks/agent-remote-protocol';
import { watchPagePolling } from '@orchardworks/agent-remote-web';
import type { HostPairingService, RemoteHost } from './HostPairing.js';
import { hostDisplayLabel } from './host-environment.js';

export function controllerUpdateCoverage(release: ControllerRelease | null, hosts: readonly RemoteHost[]) {
  const owned = hosts.filter(host => host.access !== 'shared');
  const covered = !!release && owned.length > 0 && owned.every(host => {
    const platform = host.controller ?? (host.environment ? { platform: host.environment.os.platform, arch: host.environment.os.arch, nodeMajor: release.nodeMajor } : undefined);
    return platform && releaseCoversHost(release, platform);
  });
  const outdated = release ? owned.filter(host => !host.controller || compareControllerVersions(release.version, host.controller.version) > 0) : [];
  return { owned, covered, outdated, eligible: outdated.filter(host => host.online && host.controller?.remoteUpdate && releaseCoversHost(release!, host.controller)) };
}
const labels: Record<ControllerUpdateStatus['phase'], string> = { idle: 'Ready', downloading: 'Downloading and installing…', waiting: 'Waiting for a safe restart…', restarting: 'Restarting…', succeeded: 'Updated', failed: 'Update failed' };
export function ControllerUpdates({ service, hosts }: { service: HostPairingService; hosts: readonly RemoteHost[] }) {
  const [release, setRelease] = useState<ControllerRelease | null>(null);
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, ControllerUpdateStatus>>({});
  const current = useRef({ service, hosts }); current.current = { service, hosts };
  const mutationEpoch = useRef(0);
  const requests = useRef(new Map<string, { version: string; operationId: string }>());
  const { owned, covered, outdated, eligible } = controllerUpdateCoverage(release, hosts);
  const actionable = eligible.filter(host => !['downloading', 'waiting', 'restarting'].includes(statuses[host.id]?.phase ?? 'idle'));
  const available = eligible.length > 0;
  useEffect(() => {
    let retired = false, loading = false;
    setRelease(null); setStatuses({}); setError(undefined); requests.current.clear(); setBusy(false); setConfirm(null);
    const stop = watchPagePolling(async () => {
      if (retired || loading || !service.controllerRelease) return;
      loading = true;
      try { const result = await service.controllerRelease(); if (!retired && current.current.service === service) { setRelease(result.release); setError(undefined); } }
      catch (cause) { if (!retired) setError(cause instanceof Error ? cause.message : 'Could not check Controller updates.'); }
      finally { loading = false; }
    }, 300000);
    return () => { retired = true; stop(); };
  }, [service]);
  const pending = Object.values(statuses).some(status => ['downloading', 'waiting', 'restarting'].includes(status.phase));
  useEffect(() => {
    if (!expanded && !pending) return;
    let retired = false, loading = false;
    const stop = watchPagePolling(async () => {
      if (loading || !service.controllerUpdate) return; loading = true;
      const epoch = mutationEpoch.current;
      try {
        const values = await Promise.all(current.current.hosts.filter(host => host.access !== 'shared' && host.online && host.controller?.remoteUpdate).map(async host => {
          try { return [host.id, await service.controllerUpdate!(host.id)] as const; } catch { return undefined; }
        }));
        if (!retired && epoch === mutationEpoch.current) setStatuses(previous => ({ ...previous, ...Object.fromEntries(values.filter(value => value !== undefined)) }));
      } finally { loading = false; }
    }, pending ? 3000 : 15000);
    return () => { retired = true; stop(); };
  }, [service, expanded, pending]);
  async function update(targets: readonly RemoteHost[]) {
    if (busy || !release || !service.controllerUpdate) return;
    mutationEpoch.current++;
    setBusy(true); setConfirm(null); setError(undefined);
    try {
      for (const host of targets) {
        if (current.current.service !== service) return;
        const previous = requests.current.get(host.id);
        const input = previous?.version === release.version ? previous : { version: release.version, operationId: crypto.randomUUID() };
        requests.current.set(host.id, input);
        try {
          const status = await service.controllerUpdate(host.id, input);
          if (current.current.service === service) setStatuses(previous => ({ ...previous, [host.id]: status }));
        } catch (cause) {
          if (current.current.service === service) setStatuses(previous => ({ ...previous, [host.id]: { phase: 'failed', version: input.version, operationId: input.operationId, updatedAt: Date.now(),
            message: `${cause instanceof Error ? cause.message : 'Update could not be confirmed.'} Retry checks the same update request.` } }));
        }
      }
    } finally { if (current.current.service === service) { mutationEpoch.current++; setBusy(false); } }
  }
  if (!service.controllerRelease || !owned.length) return null;
  return <section className="lab-controller-updates" aria-label="Controller updates">
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>Controller updates{available ? ` · ${release!.version} available` : ''}</button>
    {expanded ? <div>
      {error ? <p role="alert">{error}</p> : null}
      {release ? <p>Latest version: <strong>{release.version}</strong></p> : <p>No published Controller release is available yet.</p>}
      {release && !covered ? <p>Some Hosts are not compatible with this release. Compatible Hosts can still update independently.</p> : null}
      <ul>{owned.map(host => {
        const status = statuses[host.id]; const needs = outdated.includes(host);
        const completed = status?.version === host.controller?.version && host.controller?.revision === release?.revision && host.online;
        return <li key={host.id}><div className="lab-controller-host-name" title={hostDisplayLabel(host)} role="region" aria-label="Host name" tabIndex={0}><strong>{host.name}</strong></div><span>{host.controller?.version ?? 'Version not reported'} · {host.online ? 'Online' : 'Offline'}</span>
          {status && status.phase !== 'idle' ? <small role="status">{completed ? 'Updated' : labels[status.phase]}{!completed && status.message ? ` ${status.message}` : ''}</small> : null}
          {!host.controller?.remoteUpdate ? <small>Install the release launcher once on this Host to enable remote updates.</small> : null}
          {needs && eligible.includes(host) ? <button type="button" disabled={busy || (!!status && ['downloading', 'waiting', 'restarting'].includes(status.phase))} onClick={() => setConfirm([host.id])}>{status?.phase === 'failed' ? 'Retry update' : 'Update Host'}</button> : null}
        </li>;
      })}</ul>
      {release ? <a href={`https://github.com/xuangong/agent-remote-control/releases/tag/controller-v${release.version}`} target="_blank" rel="noreferrer">Release notes and manual installation</a> : null}
      {actionable.length > 1 ? <button type="button" disabled={busy} onClick={() => setConfirm(actionable.map(host => host.id))}>Update {actionable.length} Hosts</button> : null}
      {confirm?.length ? <div role="group" aria-label="Confirm Controller update"><p>Update {confirm.length} online {confirm.length === 1 ? 'Host' : 'Hosts'} to {release?.version}? The Controller restarts as soon as the download is verified. Remote connections briefly reconnect. Shared Codex daemon tasks keep running; private agent tasks and Controller-hosted tool calls may be interrupted. Offline Hosts are skipped.</p>
        <button type="button" disabled={busy} onClick={() => void update(eligible.filter(host => confirm.includes(host.id)))}>Confirm update</button><button type="button" onClick={() => setConfirm(null)}>Cancel</button>
      </div> : null}
    </div> : null}
  </section>;
}

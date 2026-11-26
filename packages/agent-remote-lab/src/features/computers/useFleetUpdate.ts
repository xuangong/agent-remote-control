import { useCallback, useEffect, useRef, useState } from 'react';
import { controllerUpdateTarget, type ControllerRelease, type ControllerUpdateStatus } from '@orchardworks/agent-remote-protocol';
import { errorWords, watchList } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { HostPairingService, RemoteHost } from '../../kernel/remote-host.js';
import { cardUpdate, planFleetUpdate, type FleetPlan, type FleetRelease } from './fleet-update.js';

/** How often the Controllers that are updating are asked how far they got. */
const PROGRESS_MS = 3_000;
export interface FleetUpdate {
  release: ControllerRelease | null;
  /** The plan for every Host the list shows, or for the owner's Hosts only when the reader owns none (then there is nothing to offer). */
  plan: FleetPlan;
  statuses: Readonly<Record<string, ControllerUpdateStatus>>;
  /** Sends the update request of each given Host at once, through the same per-Host request as a Host's own page; one failing leaves the others running. */
  start(hostIds: readonly string[]): Promise<void>;
  /** The Hosts' updates this page has started and not seen end. */
  updating: number;
}

/** The latest release, the update of every Host this page started, and the one request that starts any of them. */
export function useFleetUpdate(service: Pick<HostPairingService, 'controllerRelease' | 'controllerUpdate'>, hosts: readonly RemoteHost[]): FleetUpdate {
  const t = useTranslate();
  const words = useRef(t); words.current = t;
  const [release, setRelease] = useState<ControllerRelease | null>(null);
  const [bridge, setBridge] = useState<FleetRelease>();
  const [statuses, setStatuses] = useState<Record<string, ControllerUpdateStatus>>({});
  const live = useRef({ service, hosts, release, bridge }); live.current = { service, hosts, release, bridge };
  const requests = useRef(new Map<string, { version: string; operationId: string }>());
  const plan = planFleetUpdate(release, hosts, bridge, statuses);
  // An update is under way until the computer is back with the version asked for, or fails.
  const underway = hosts.filter(host => { const kind = cardUpdate(host, statuses[host.id])?.kind; return kind === 'updating' || kind === 'reconnecting'; }).map(host => host.id);
  const updating = underway.length;

  useEffect(() => {
    setRelease(null); setBridge(undefined); setStatuses({}); requests.current.clear();
    if (!service.controllerRelease) return;
    let retired = false, loading = false;
    const stop = watchList(async () => {
      if (loading) return; loading = true;
      try { const result = await service.controllerRelease!(); if (!retired) { setRelease(result.release); setBridge(result.bridgeReleases ?? result.bridgeRelease); } }
      catch { /* The last release stays; the Host pages report discovery errors. */ }
      finally { loading = false; }
    }, 300_000);
    return () => { retired = true; stop(); };
  }, [service]);
  const updatingIds = underway.join('\n');
  useEffect(() => {
    if (!updatingIds || !service.controllerUpdate) return;
    let retired = false, loading = false;
    const stop = watchList(async () => {
      if (loading) return; loading = true;
      try {
        const values = await Promise.all(updatingIds.split('\n').map(async id => { try { return [id, await service.controllerUpdate!(id)] as const; } catch { return undefined; } }));
        // A restarted Controller that no longer remembers the request answers idle: the Host's version decides, so the last phase stays.
        if (!retired) setStatuses(previous => ({ ...previous, ...Object.fromEntries(values.filter(value => value !== undefined && value[1].phase !== 'idle')) }));
      } finally { loading = false; }
    }, PROGRESS_MS);
    return () => { retired = true; stop(); };
  }, [service, updatingIds]);

  const start = useCallback(async (hostIds: readonly string[]) => {
    const { service: current, release: latest, bridge: bridges, hosts: known } = live.current;
    if (!latest || !current.controllerUpdate) return;
    const update = current.controllerUpdate.bind(current);
    await Promise.all(hostIds.map(async id => {
      const host = known.find(item => item.id === id), target = host?.controller && controllerUpdateTarget(latest, host.controller, bridges);
      if (!target) return;
      const previous = requests.current.get(id);
      // A retry for the same version repeats the request, so the Controller answers with what it already did.
      const input = previous?.version === target.version ? previous : { version: target.version, operationId: crypto.randomUUID() };
      requests.current.set(id, input);
      const mine = () => live.current.service === current;
      setStatuses(all => ({ ...all, [id]: { phase: 'downloading', ...input, updatedAt: Date.now() } }));
      try { const status = await update(id, input); if (mine()) setStatuses(all => ({ ...all, [id]: { ...input, ...status } })); }
      catch (cause) {
        if (mine()) setStatuses(all => ({ ...all, [id]: { phase: 'failed', ...input, updatedAt: Date.now(), message: words.current('hosts.updates.retryNote', { message: errorWords(cause, words.current, 'hosts.updates.notConfirmed') }) } }));
      }
    }));
  }, []);
  return { release, plan, statuses, start, updating };
}

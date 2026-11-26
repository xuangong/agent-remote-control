import { errorWords } from '@orchardworks/agent-client';
import './host-overview.css';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { HostStatus } from '@orchardworks/agent-remote-protocol';
import { Button } from '../../ui/Button.js';
import { Pill } from '@orchardworks/agent-client-web/primitives';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { Icon } from '../../ui/Icon.js';
import type { HostPairingService, RemoteHost } from '../../kernel/remote-host.js';
import { PairingKeys } from './PairingKeys.js';
import { useKeptPlace, useReservedHeight } from './kept-place.js';
import { FleetConfirm, FleetUpdateAction, HostUpdateLine } from './FleetUpdate.js';
import { useFleetUpdate, type FleetUpdate } from './useFleetUpdate.js';

/** How often an open Hosts page reads each Host's status. */
const REFRESH_MS = 5_000;
/** A figure at or above this share of its total is shown as a warning. */
const WARNING_SHARE = 0.9;
const GiB = 2 ** 30, TiB = 2 ** 40;

/** Sizes in binary units, as `df -h` and Activity Monitor count them, with one decimal. */
export function formatBytes(value: number): string {
  return value >= TiB ? `${(value / TiB).toFixed(1)} TB` : `${(value / GiB).toFixed(1)} GB`;
}
/** "14.2 / 24.0 GB" when both share a unit, otherwise "432.0 GB / 1.9 TB". */
function usageText(used: number, total: number): string {
  const [usedText, totalText] = [formatBytes(used), formatBytes(total)];
  const unit = totalText.slice(-2);
  return usedText.endsWith(unit) ? `${usedText.slice(0, -3)} / ${totalText}` : `${usedText} / ${totalText}`;
}
/** Megabytes under a gigabyte, so a small process does not read as 0.0 GB. */
const processBytes = (value: number) => value >= GiB ? formatBytes(value) : `${Math.max(1, Math.round(value / 2 ** 20))} MB`;
/** How many of the processes that use the most memory a card lists. */
const PROCESS_ROWS = 5;
const lastSegment = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

interface HostReading { status?: HostStatus; error?: string }
/** The last reading of each Host per service, kept while the page lives: Settings opens with the figures it last showed and refreshes them in place. */
const remembered = new WeakMap<object, Map<string, HostReading>>();
const lastReadings = (service: object) => { let map = remembered.get(service); if (!map) remembered.set(service, map = new Map()); return map; };
/** The height a card's figures are expected to take before the first reading arrives: sessions, CPU, memory and a disk. */
const FIGURES_HEIGHT = 150;

/** Reads the status of every online Host that offers it, while the page is visible; a failed read keeps the last figures. */
function useHostStatuses(service: Pick<HostPairingService, 'hostStatus'>, hosts: readonly RemoteHost[], visible: boolean): Record<string, HostReading> {
  const t = useTranslate();
  const [readings, setReadings] = useState<Record<string, HostReading>>(() => Object.fromEntries(lastReadings(service)));
  const eligible = hosts.filter(host => host.online && host.hostStatus).map(host => host.id).join('\n');
  useEffect(() => {
    const read = service.hostStatus?.bind(service);
    if (!visible || !read || !eligible) return;
    let cancelled = false;
    const reading = new Set<string>();
    const update = (id: string, next: (previous: HostReading | undefined) => HostReading) => {
      if (cancelled) return;
      const value = next(lastReadings(service).get(id));
      lastReadings(service).set(id, value);
      setReadings(current => ({ ...current, [id]: value }));
    };
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      for (const id of eligible.split('\n')) {
        if (reading.has(id)) continue;
        reading.add(id);
        read(id).then(status => update(id, () => ({ status })),
          (error: unknown) => update(id, previous => ({ ...previous, error: errorWords(error, t, 'hosts.statusUnavailable') })))
          .finally(() => reading.delete(id));
      }
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [service, eligible, visible, t]);
  return readings;
}

function Meter({ label, name, value, total, text, title }: { label: string; name?: string; value: number; total: number; text: string; title?: string }) {
  const share = total > 0 ? Math.min(1, value / total) : 0, percent = Math.round(share * 100);
  return <div className="lab-host-meter" role="meter" aria-label={name ?? label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
    title={title} data-warning={share >= WARNING_SHARE || undefined}>
    <div className="lab-host-meter-line"><span>{label}</span><span className="lab-host-meter-value">{text}</span></div>
    <div className="lab-host-bar" aria-hidden="true"><i style={{ width: `${percent}%` }} /></div>
  </div>;
}

/** The open sessions as a count, then by state, with the ones that need their owner stressed. */
function Sessions({ sessions }: { sessions: HostStatus['sessions'] }) {
  const t = useTranslate();
  const total = sessions.running + sessions.waiting + sessions.idle + sessions.failed;
  const parts: ReactNode[] = [sessions.running ? t('hosts.sessionsWorking', { count: sessions.running }) : null, sessions.waiting ? <em>{t('hosts.sessionsNeedYou', { count: sessions.waiting })}</em> : null,
    sessions.idle ? t('hosts.sessionsIdle', { count: sessions.idle }) : null, sessions.failed ? t('hosts.sessionsFailed', { count: sessions.failed }) : null].filter(part => part !== null);
  return <div className="lab-host-sessions">
    <strong>{total}</strong> <span>{t('hosts.sessionNoun', { count: total })}</span>
    {parts.length ? <> <small>{parts.map((part, index) => <Fragment key={index}>{index ? ' · ' : null}{part}</Fragment>)}</small></> : null}
  </div>;
}

/** What uses this machine: the Controller's heaviest processes, as the Host reported them with its status. */
function Processes({ processes }: { processes: NonNullable<HostStatus['processes']> }) {
  const t = useTranslate();
  return <div className="lab-host-processes">
    <h4>{t('hosts.processes')}</h4>
    <ul>{processes.slice(0, PROCESS_ROWS).map((process, index) => <li key={index} data-kind={process.kind}>
      <span className="lab-host-process-name" title={process.label} translate="no">{process.label}</span><small>{t(`hosts.processKind.${process.kind}`)}</small>
      <span className="lab-host-process-figure">{Math.round(process.cpu * 100)}%</span><span className="lab-host-process-figure">{processBytes(process.memory)}</span>
    </li>)}</ul>
  </div>;
}

function HostCard({ host, reading, fleet, onOpenHost }: { host: RemoteHost; reading?: HostReading; fleet: FleetUpdate; onOpenHost(id: string): void }) {
  const t = useTranslate();
  const status = reading?.status, shared = host.access === 'shared';
  // An online Host that answers status reads holds the space of its figures from the start, so they arrive in place.
  const figuresExpected = host.online && Boolean(host.hostStatus) && !shared;
  const figures = useReservedHeight(host.id, figuresExpected ? FIGURES_HEIGHT : 0);
  const subtitle = [host.environment?.os.name ?? host.controller?.platform, host.environment?.os.arch ?? host.controller?.arch,
    host.controller ? t('settings.computer.version', { version: host.controller.version }) : undefined].filter(Boolean).join(' · ');
  return <article className="lab-host-card" data-host-id={host.id} data-online={host.online || undefined}>
    <button type="button" className="lab-host-open" onClick={() => onOpenHost(host.id)}>
      <span className="lab-host-dot" aria-hidden="true" />
      <span className="lab-host-name"><strong>{host.name}</strong>{subtitle ? <small>{subtitle}</small> : null}</span>
      <Icon name="chevron-right" size={16} />
    </button>
    {figuresExpected || host.online && status ? <div ref={figures.ref} className="lab-host-figures" style={{ minHeight: figures.minHeight }}>
      {status ? <Sessions sessions={status.sessions} /> : null}
      {status?.cpu || status?.memory || status?.disks ? <div className="lab-host-meters">
        {status.cpu ? <Meter label="CPU" value={status.cpu.usage} total={1} text={`${Math.round(status.cpu.usage * 100)}% · ${t('hosts.cores', { count: status.cpu.cores })}`} /> : null}
        {status.memory ? <Meter label={t('hosts.memory')} value={status.memory.used} total={status.memory.total} text={usageText(status.memory.used, status.memory.total)} /> : null}
        {status.disks?.map(disk => <Meter key={disk.path} label={disk.kind === 'home' ? t('hosts.home') : lastSegment(disk.path)} name={t('hosts.disk', { name: disk.kind === 'home' ? t('hosts.home') : lastSegment(disk.path) })} title={disk.path}
          value={disk.used} total={disk.total} text={usageText(disk.used, disk.total)} />)}
      </div> : null}
      {status?.processes?.length ? <Processes processes={status.processes} /> : null}
    </div> : null}
    <HostUpdateLine host={host} fleet={fleet} />
    {!host.online ? <p className="lab-host-note">{t('settings.computer.offline')}</p>
      : !host.sessionControl ? <p className="lab-host-note" role="status" data-update-required>
        {shared ? t('hosts.updateSharedOwner')
          : !host.controller && host.providers?.some(provider => provider.providerId === 'dsh')
            ? t('hosts.updateDsh')
            : <>{t('hosts.updateControllerBefore')}<code>agent-remote-controller update --check</code>{t('hosts.updateControllerAfter')}</>}
        {!shared && host.controller ? <Button className="lab-host-update" onClick={() => onOpenHost(host.id)}>{t('hosts.updateAction')}</Button> : null}</p>
      : !host.hostStatus ? <p className="lab-host-note">{shared ? t('hosts.sharedNeedsUpdate') : t('hosts.needsUpdateToSee')}
        {!shared ? <Button className="lab-host-update" onClick={() => onOpenHost(host.id)}>{t('hosts.updateAction')}</Button> : null}</p>
      : shared && status ? <p className="lab-host-note">{t('hosts.sharedSessionsOnly')}</p> : null}
    {host.online && reading?.error ? <p className="lab-host-note" role="status">{reading.error}</p> : null}
  </article>;
}

/**
 * Every Host with its open sessions and, for its owner, CPU, memory and disks. A card opens the Host's settings.
 * `lead` is the line above the cards (how many are online); Pair a computer opens the pairing keys.
 */
export function HostOverview({ hosts, service, visible, compact = false, lead, onOpenHost }: {
  hosts: readonly RemoteHost[]; service: HostPairingService; visible: boolean; compact?: boolean; lead?: ReactNode; onOpenHost(id: string): void;
}) {
  const t = useTranslate();
  const readings = useHostStatuses(service, hosts, visible);
  const [pairing, setPairing] = useState(false);
  const [asking, setAsking] = useState(false);
  const fleet = useFleetUpdate(service, hosts);
  // A confirmation for a plan that no longer has a computer to update closes by itself.
  const confirming = asking && fleet.plan.eligible.length > 0;
  const grid = useRef<HTMLDivElement>(null);
  useKeptPlace(grid, hosts.length);
  return <section className="lab-host-overview" aria-label={t('settings.group.computers')}>
    <div className="lab-host-overview-head">{lead}<FleetUpdateAction fleet={fleet} asking={confirming} onAsk={() => setAsking(value => !value)} /><Pill className="lab-host-pair" aria-expanded={pairing} onClick={() => setPairing(value => !value)}>{t('settings.computers.pair')}</Pill></div>
    {confirming ? <FleetConfirm fleet={fleet} onCancel={() => setAsking(false)} onConfirm={() => { setAsking(false); void fleet.start(fleet.plan.eligible.map(entry => entry.host.id)); }} /> : null}
    {pairing ? <div className="lab-host-pairing-panel"><PairingKeys service={service} /></div> : null}
    {hosts.length ? <div ref={grid} className="lab-host-grid" data-compact={compact || undefined}>
      {hosts.map(host => <HostCard key={host.id} host={host} reading={readings[host.id]} fleet={fleet} onOpenHost={onOpenHost} />)}
    </div> : <p className="lab-host-empty">{t('hosts.empty')}</p>}
  </section>;
}

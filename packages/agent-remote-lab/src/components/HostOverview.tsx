import './host-overview.css';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { HostStatus } from '@orchardworks/agent-remote-protocol';
import { Button } from '../ui/Button.js';
import { Icon } from '../ui/Icon.js';
import type { HostPairingService, RemoteHost } from './HostPairing.js';
import { PairingKeys } from './PairingKeys.js';

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
const lastSegment = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

interface HostReading { status?: HostStatus; error?: string }

/** Reads the status of every online Host that offers it, while the page is visible; a failed read keeps the last figures. */
function useHostStatuses(service: Pick<HostPairingService, 'hostStatus'>, hosts: readonly RemoteHost[], visible: boolean): Record<string, HostReading> {
  const [readings, setReadings] = useState<Record<string, HostReading>>({});
  const eligible = hosts.filter(host => host.online && host.hostStatus).map(host => host.id).join('\n');
  useEffect(() => {
    const read = service.hostStatus?.bind(service);
    if (!visible || !read || !eligible) return;
    let cancelled = false;
    const reading = new Set<string>();
    const update = (id: string, next: (previous: HostReading | undefined) => HostReading) => {
      if (!cancelled) setReadings(current => ({ ...current, [id]: next(current[id]) }));
    };
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      for (const id of eligible.split('\n')) {
        if (reading.has(id)) continue;
        reading.add(id);
        read(id).then(status => update(id, () => ({ status })),
          (error: unknown) => update(id, previous => ({ ...previous, error: error instanceof Error ? error.message : 'Status unavailable.' })))
          .finally(() => reading.delete(id));
      }
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [service, eligible, visible]);
  return readings;
}

function Meter({ label, value, total, text, title }: { label: string; value: number; total: number; text: string; title?: string }) {
  const share = total > 0 ? Math.min(1, value / total) : 0, percent = Math.round(share * 100);
  return <div className="lab-host-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
    title={title} data-warning={share >= WARNING_SHARE || undefined}>
    <div className="lab-host-meter-line"><span>{label.replace(/ disk$/, '')}</span><span className="lab-host-meter-value">{text}</span></div>
    <div className="lab-host-bar" aria-hidden="true"><i style={{ width: `${percent}%` }} /></div>
  </div>;
}

/** The open sessions as a count, then by state, with the ones that need their owner stressed. */
function Sessions({ sessions }: { sessions: HostStatus['sessions'] }) {
  const total = sessions.running + sessions.waiting + sessions.idle + sessions.failed;
  const parts: ReactNode[] = [sessions.running ? `${sessions.running} working` : null, sessions.waiting ? <em>{sessions.waiting} needs you</em> : null,
    sessions.idle ? `${sessions.idle} idle` : null, sessions.failed ? `${sessions.failed} failed` : null].filter(part => part !== null);
  return <div className="lab-host-sessions">
    <strong>{total}</strong> <span>{total === 1 ? 'session' : 'sessions'}</span>
    {parts.length ? <> <small>{parts.map((part, index) => <Fragment key={index}>{index ? ' · ' : null}{part}</Fragment>)}</small></> : null}
  </div>;
}

function HostCard({ host, reading, onOpenHost }: { host: RemoteHost; reading?: HostReading; onOpenHost(id: string): void }) {
  const status = reading?.status, shared = host.access === 'shared';
  const subtitle = [host.environment?.os.name ?? host.controller?.platform, host.environment?.os.arch ?? host.controller?.arch,
    host.controller ? `Controller ${host.controller.version}` : undefined].filter(Boolean).join(' · ');
  return <article className="lab-host-card" data-host-id={host.id} data-online={host.online || undefined}>
    <button type="button" className="lab-host-open" onClick={() => onOpenHost(host.id)}>
      <span className="lab-host-dot" aria-hidden="true" />
      <span className="lab-host-name"><strong>{host.name}</strong>{subtitle ? <small>{subtitle}</small> : null}</span>
      <Icon name="chevron-right" size={16} />
    </button>
    {host.online && status ? <Sessions sessions={status.sessions} /> : null}
    {host.online && status?.cpu || host.online && status?.memory || host.online && status?.disks ? <div className="lab-host-meters">
      {status.cpu ? <Meter label="CPU" value={status.cpu.usage} total={1} text={`${Math.round(status.cpu.usage * 100)}% · ${plural(status.cpu.cores, 'core')}`} /> : null}
      {status.memory ? <Meter label="Memory" value={status.memory.used} total={status.memory.total} text={usageText(status.memory.used, status.memory.total)} /> : null}
      {status.disks?.map(disk => <Meter key={disk.path} label={`${disk.kind === 'home' ? 'Home' : lastSegment(disk.path)} disk`} title={disk.path}
        value={disk.used} total={disk.total} text={usageText(disk.used, disk.total)} />)}
    </div> : null}
    {!host.online ? <p className="lab-host-note">Offline</p>
      : !host.hostStatus ? <p className="lab-host-note">{shared ? 'Sessions show once the owner updates the Controller.' : 'Update the Controller to see CPU, memory and disks.'}
        {!shared ? <Button className="lab-host-update" onClick={() => onOpenHost(host.id)}>Update</Button> : null}</p>
      : shared && status ? <p className="lab-host-note">Shared with you: sessions only.</p> : null}
    {host.online && reading?.error ? <p className="lab-host-note" role="status">{reading.error}</p> : null}
  </article>;
}

/**
 * Every Host with its open sessions and, for its owner, CPU, memory and disks. A card opens the Host's settings.
 * Pair a Host sits in `actionsTarget` (the desktop page toolbar) when given, otherwise in the page's own heading;
 * `null` is a toolbar that has not mounted yet.
 */
export function HostOverview({ hosts, service, visible, compact = false, actionsTarget, onOpenHost }: {
  hosts: readonly RemoteHost[]; service: HostPairingService; visible: boolean; compact?: boolean; actionsTarget?: HTMLElement | null; onOpenHost(id: string): void;
}) {
  const readings = useHostStatuses(service, hosts, visible);
  const [pairing, setPairing] = useState(false);
  const pair = <Button className="lab-host-pair" aria-expanded={pairing} onClick={() => setPairing(value => !value)}>Pair a Host</Button>;
  return <section className="lab-host-overview" aria-label={actionsTarget === undefined ? 'Hosts' : undefined}>
    {actionsTarget ? createPortal(pair, actionsTarget) : actionsTarget === undefined ? <div className="lab-directory-heading"><h2>Hosts</h2>{pair}</div> : null}
    {pairing ? <div className="lab-host-pairing-panel"><PairingKeys service={service} /></div> : null}
    {hosts.length ? <div className="lab-host-grid" data-compact={compact || undefined}>
      {hosts.map(host => <HostCard key={host.id} host={host} reading={readings[host.id]} onOpenHost={onOpenHost} />)}
    </div> : <p className="lab-host-empty">No Hosts paired yet. Pair a Host to see it here.</p>}
  </section>;
}

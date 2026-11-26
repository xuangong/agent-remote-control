/**
 * Which computers one "Update all" reaches, and what a card shows while its Controller updates. Pure: the release, the Hosts and the
 * last update status of each Host go in; the plan and the card state come out. Requests and polling live in `useFleetUpdate`.
 */
import { compareControllerVersions, controllerUpdateTarget, type ControllerRelease, type ControllerUpdateStatus } from '@orchardworks/agent-remote-protocol';
import type { RemoteHost } from '../../kernel/remote-host.js';

export type FleetRelease = ControllerRelease | readonly ControllerRelease[];
/** Why a computer is left out of an update: it is shared with the reader, offline, cannot update remotely, has no release for its platform, is current, or is already updating. */
export type SkipReason = 'shared' | 'offline' | 'noRemoteUpdate' | 'unsupported' | 'current' | 'updating';
export interface FleetPlan {
  /** Computers an update request goes to, each with the version it installs next (a bridge release before the latest one, for old Controllers). */
  eligible: { host: RemoteHost; target: ControllerRelease }[];
  skipped: { host: RemoteHost; reason: SkipReason }[];
}

export function planFleetUpdate(release: ControllerRelease | null, hosts: readonly RemoteHost[], bridge: FleetRelease | undefined, statuses: Readonly<Record<string, ControllerUpdateStatus>>, overdue: ReadonlySet<string> = new Set()): FleetPlan {
  const plan: FleetPlan = { eligible: [], skipped: [] };
  if (!release) return plan;
  for (const host of hosts) {
    const target = host.controller && controllerUpdateTarget(release, host.controller, bridge);
    const reason: SkipReason | undefined = host.access === 'shared' ? 'shared'
      : !host.online ? 'offline'
      : host.controller && compareControllerVersions(release.version, host.controller.version) <= 0 ? 'current'
      : !host.controller?.remoteUpdate ? 'noRemoteUpdate'
      : !target ? 'unsupported'
      : ['updating', 'reconnecting'].includes(cardUpdate(host, statuses[host.id], overdue.has(host.id))?.kind ?? '') ? 'updating' : undefined;
    if (reason) plan.skipped.push({ host, reason });
    else plan.eligible.push({ host, target: target! });
  }
  return plan;
}

/**
 * How long a Host may take to come back on the version asked for before the card says so: the Controller downloads and verifies the
 * release, waits for a safe moment, restarts and registers again, which takes a minute or two; five minutes leaves room for a slow
 * download or a long wait for a safe restart without leaving a card on "Reconnecting" for ever.
 */
export const UPDATE_PATIENCE_MS = 5 * 60_000;

/** What a card shows of its Host's update: `updating` while it installs, `reconnecting` while the Controller restarts, then `updated` or `failed`. */
export type CardUpdate = { kind: 'updating'; phase: 'downloading' | 'waiting' } | { kind: 'reconnecting' } | { kind: 'updated'; version: string } | { kind: 'failed'; message?: string }
  /** The Host did not return on the version asked for within `UPDATE_PATIENCE_MS`: `current` is the version it runs now, when it is online again. */
  | { kind: 'stalled'; version: string; current?: string };
export function cardUpdate(host: RemoteHost, status: ControllerUpdateStatus | undefined, patienceOver = false): CardUpdate | undefined {
  if (!status || status.phase === 'idle') return undefined;
  if (status.phase === 'failed') return { kind: 'failed', ...(status.message ? { message: status.message } : {}) };
  // The Host registering again with the version asked for is the result, whatever phase the restarted Controller reports.
  if (status.version && host.online && host.controller?.version === status.version) return { kind: 'updated', version: status.version };
  if (patienceOver && status.version) return { kind: 'stalled', version: status.version, ...(host.online && host.controller ? { current: host.controller.version } : {}) };
  if (status.phase === 'downloading' || status.phase === 'waiting') return host.online ? { kind: 'updating', phase: status.phase } : { kind: 'reconnecting' };
  return { kind: 'reconnecting' };
}

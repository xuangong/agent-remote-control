import type { RemoteHostBrokerState } from './broker.js';

export interface HostRecoverySelection { hostId: string; installationId: string; revocationId: string }
export interface RevokedHost extends HostRecoverySelection { revokedAt?: number }
export const MAX_RETAINED_HOST_IDENTITIES = 8192;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function validHostRecovery(value: unknown): value is HostRecoverySelection {
  const item = value as HostRecoverySelection;
  return !!item && typeof item === 'object' && Object.keys(item).every(key => ['hostId', 'installationId', 'revocationId'].includes(key))
    && text(item.hostId) && text(item.installationId) && uuid(item.revocationId);
}
export function validRevokedHosts(value: unknown): value is RevokedHost[] {
  return Array.isArray(value) && value.length <= MAX_RETAINED_HOST_IDENTITIES && value.every(item => {
    if (!item || typeof item !== 'object') return false;
    const { revokedAt, ...selection } = item;
    return validHostRecovery(selection) && (revokedAt === undefined || Number.isSafeInteger(revokedAt) && revokedAt >= 0);
  }) && new Set(value.map(item => item.hostId)).size === value.length
    && new Set(value.map(item => item.installationId)).size === value.length;
}

/** Count historical identities at admission, so removing access never needs a new slot. */
export function retainedHostIdentities(state: Pick<RemoteHostBrokerState, 'hosts' | 'associations' | 'revokedHosts'>): Map<string, string> {
  const identities = new Map<string, string>();
  const installations = new Map<string, string>();
  const add = (hostId: string, installationId: string) => {
    if (identities.has(hostId) && identities.get(hostId) !== installationId
      || installations.has(installationId) && installations.get(installationId) !== hostId) throw new Error('Conflicting retained Host identity.');
    identities.set(hostId, installationId); installations.set(installationId, hostId);
  };
  for (const item of state.revokedHosts ?? []) add(item.hostId, item.installationId);
  for (const item of state.associations?.freezes ?? []) add(item.hostId, item.receipt.controllerId);
  for (const item of state.associations?.relationChanges ?? []) add(item.reservation.hostId, item.reservation.controllerId);
  // A pre-effect reset denies an exact historical intent; it reserves no recovery
  // authority. Its immutable Host ID can precede an ordinary installation re-pair.
  for (const item of state.associations?.admissions ?? []) {
    const host = state.hosts.find(host => host.installationId === item.source.controllerId);
    if (host) add(host.id, host.installationId);
  }
  for (const host of state.hosts) {
    if (identities.has(host.id) && identities.get(host.id) !== host.installationId
      || installations.has(host.installationId) && installations.get(host.installationId) !== host.id) throw new Error('Active Host contradicts retained identity.');
  }
  if (identities.size > MAX_RETAINED_HOST_IDENTITIES) throw new Error('Retained Host identity capacity is exhausted.');
  return identities;
}
export function hasHostRecoveryMetadata(state: RemoteHostBrokerState): boolean {
  return state.revokedHosts !== undefined || Array.isArray(state.keys) && state.keys.some(item => Array.isArray(item) && item[1]?.recovery !== undefined)
    || Array.isArray(state.pairings) && state.pairings.some(item => item?.recovery !== undefined);
}

/** Retained recovery history identifies actual device rows, not permission for another issuance. */
export function retainedRecoveryInstallations(state: RemoteHostBrokerState): Set<string> {
  return new Set([
    ...(state.revokedHosts ?? []).map(row => row.installationId),
    ...(state.pairings ?? []).flatMap(row => row.recovery ? [row.recovery.installationId] : []),
    ...state.keys.flatMap(([, key]) => key.recovery ? [key.recovery.installationId] : []),
  ]);
}

/** Missing completion evidence keeps one claim for the exact current workflow identity. */
export function currentRecoveryWorkflows(state: RemoteHostBrokerState): HostRecoverySelection[] {
  const workflows = new Map<string, HostRecoverySelection>();
  const add = (recovery: HostRecoverySelection) => {
    const marker = state.revokedHosts?.find(row => row.hostId === recovery.hostId);
    if (!marker || marker.installationId !== recovery.installationId || marker.revocationId !== recovery.revocationId) throw new Error('Recovery workflow requires reconciliation.');
    workflows.set(JSON.stringify([recovery.hostId, recovery.installationId, recovery.revocationId]), recovery);
  };
  for (const [, key] of state.keys) if (key.recovery) add(key.recovery);
  for (const pairing of state.pairings ?? []) {
    const recovery = pairing.recovery;
    if (recovery && pairing.usedAt !== undefined && state.revokedHosts?.some(marker => marker.hostId === recovery.hostId
      && marker.installationId === recovery.installationId && marker.revocationId === recovery.revocationId)) add(recovery);
  }
  return [...workflows.values()];
}

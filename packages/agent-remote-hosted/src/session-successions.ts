import { isDeepStrictEqual } from 'node:util';
import { isCommittedSuccessionProjection, nativePrefixSelectionKey, nativeSessionRefKey, type CommittedSuccessionProjection, type NativeSessionRef, type SessionSuccessionReplay, type SessionSuccessionReplayPage, type SuccessionSessionLocator } from '@orchardworks/agent-remote-protocol';
import type { BrokerAssociationState } from './succession-associations.js';
import type { HostedRelayState } from './state.js';
import { StarError } from './session-stars.js';
/** Accepted only as an exact redundant mirror during an explicit old-format migration. */
export interface SavedSessionSuccession extends CommittedSuccessionProjection { subject: string }
const sameRef = (a: NativeSessionRef, b: NativeSessionRef) => nativeSessionRefKey(a) === nativeSessionRefKey(b);
export function validCommittedSuccessionLineage(rows: BrokerAssociationState['freezes']): boolean {
  const groups = new Map<string, typeof rows>();
  const operations = new Set<string>();
  const nativeRoles = new Map<string, string>();
  for (const row of rows) {
    const freeze = row.receipt;
    if (operations.has(freeze.request.operationId)) return false;
    operations.add(freeze.request.operationId);
    if (!row.projection) continue;
    const projection = row.projection;
    if (!isCommittedSuccessionProjection(projection)) return false;
    const { receipt, role } = projection;
    const request = freeze.request;
    if (role.origin.controllerId !== freeze.controllerId || role.current.controllerId !== freeze.controllerId
      || request.operationId !== receipt.operationId || request.roleId !== receipt.roleId || request.expectedRevision !== receipt.expectedRevision
      || nativePrefixSelectionKey(request.preparation) !== nativePrefixSelectionKey(receipt.preparation)
      || !sameRef(request.from, receipt.from) || (request.targetProviderId ?? request.from.providerId) !== (receipt.targetProviderId ?? receipt.from.providerId)
      || new Set(receipt.prepared!.participants.map(item => item.relationId)).size !== receipt.prepared!.participants.length
      || receipt.prepared!.participants.some(item => item.before.controllerId !== freeze.controllerId || item.after.controllerId !== freeze.controllerId)) return false;
    const items = groups.get(role.id) ?? []; items.push(row); groups.set(role.id, items);
  }
  for (const [roleId, rows] of groups) {
    if (rows.length > 512) return false;
    const items = [...rows].sort((a, b) => a.projection!.role.revision - b.projection!.role.revision);
    const first = items[0]!.projection!;
    const chain: NativeSessionRef[] = [first.role.origin];
    for (let index = 0; index < items.length; index++) {
      const row = items[index]!, { role, receipt } = row.projection!;
      if (role.revision !== index + 2 || !sameRef(role.origin, first.role.origin) || !isDeepStrictEqual(role.workspace, first.role.workspace)
        || !sameRef(receipt.from, chain.at(-1)!) || !isDeepStrictEqual(row.receipt.lineage, chain)
        || chain.some(item => sameRef(item, role.current))) return false;
      for (const native of [...chain, role.current]) {
        const key = nativeSessionRefKey(native), prior = nativeRoles.get(key);
        if (prior && prior !== roleId) return false;
        nativeRoles.set(key, roleId);
      }
      chain.push(role.current);
    }
  }
  return true;
}
export function committedSuccessionRows(broker: { associations?: BrokerAssociationState }) {
  return (broker.associations?.freezes ?? []).filter(row => row.released === 'committed' && row.projection)
    .sort((a, b) => a.projection!.role.id.localeCompare(b.projection!.role.id) || a.projection!.role.revision - b.projection!.role.revision);
}
/** Structural evidence survives ordinary removal; a surviving contradictory mapping cannot. */
export function validSuccessionAuthorities(snapshot: HostedRelayState): boolean {
  return snapshot.tenants.every(tenant => (tenant.broker.associations?.freezes ?? []).every(row => {
    const authority = row.receipt.authority;
    if (authority.origin !== snapshot.config.origin || authority.issuer !== snapshot.config.issuer
      || authority.ownerSubject !== tenant.subject || authority.namespace !== tenant.namespace) return false;
    const named = tenant.broker.hosts.find(host => host.id === row.hostId);
    const installed = tenant.broker.hosts.find(host => host.installationId === row.receipt.controllerId);
    return (!named || named.installationId === row.receipt.controllerId) && (!installed || installed.id === row.hostId);
  }));
}
export function validLegacySuccessionMirrors(value: unknown, snapshot: HostedRelayState): boolean {
  if (!Array.isArray(value) || value.length > 16384) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item.subject !== 'string' || !item.subject || item.subject.length > 512) return false;
    const { subject, ...projection } = item;
    if (!isCommittedSuccessionProjection(projection)) return false;
    const identity = JSON.stringify([subject, projection.role.id, projection.role.revision]);
    if (seen.has(identity)) return false; seen.add(identity);
    const tenant = snapshot.tenants.find(tenant => tenant.subject === subject);
    const row = tenant && committedSuccessionRows(tenant.broker).find(row => row.projection!.role.id === projection.role.id && row.projection!.role.revision === projection.role.revision);
    if (!row || !isDeepStrictEqual(row.projection, projection)) return false;
  }
  return true;
}

export interface SuccessionReplaySelection { roleId?: string; afterRevision?: number; limit?: number; cursor?: string }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
/** Read only from the durable snapshot; current access can suppress but never originate evidence. */
export function createSuccessionReplay(read: () => HostedRelayState,
  locator: (subject: string, hostId: string, native: NativeSessionRef) => SuccessionSessionLocator | undefined) {
  function entries(subject: string): SessionSuccessionReplay[] {
    const tenant = read().tenants.find(tenant => tenant.subject === subject);
    if (!tenant) return [];
    return committedSuccessionRows(tenant.broker).flatMap(row => {
      const projection = row.projection!;
      const from = locator(subject, row.hostId, projection.receipt.from), to = locator(subject, row.hostId, projection.role.current);
      return from && to ? [{ version: 1 as const, projection: structuredClone(projection), from, to }] : [];
    }).sort((a, b) => compare(a.projection.role.id, b.projection.role.id) || a.projection.role.revision - b.projection.role.revision);
  }
  return {
    entries,
    list(subject: string, selection: SuccessionReplaySelection): SessionSuccessionReplayPage {
      const { roleId, afterRevision = 0, limit = 32, cursor } = selection;
      if (roleId !== undefined && (!roleId || roleId.length > 512) || !Number.isSafeInteger(afterRevision) || afterRevision < 0
        || afterRevision > 0 && !roleId || !Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new StarError(400, 'invalid_replay_selection', 'Invalid succession replay selection.');
      let after: { roleId: string; revision: number } | undefined;
      if (cursor !== undefined) {
        try {
          if (!cursor || cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
          const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
          if (!isDeepStrictEqual(decoded.scope, [subject, roleId ?? null, afterRevision]) || typeof decoded.roleId !== 'string'
            || !Number.isSafeInteger(decoded.revision) || decoded.revision < 2 || Object.keys(decoded).length !== 3) throw new Error();
          after = decoded;
        } catch { throw new StarError(400, 'invalid_replay_cursor', 'Invalid succession replay cursor.'); }
      }
      const available = entries(subject).filter(item => (!roleId || item.projection.role.id === roleId) && item.projection.role.revision > afterRevision
        && (!after || compare(item.projection.role.id, after.roleId) > 0 || item.projection.role.id === after.roleId && item.projection.role.revision > after.revision));
      const successions: SessionSuccessionReplay[] = []; let bytes = 0;
      for (const item of available) {
        const size = Buffer.byteLength(JSON.stringify(item));
        if (size > 8 * 1024 * 1024) throw new StarError(503, 'succession_replay_unavailable', 'Succession replay is unavailable.');
        if (successions.length >= limit || bytes + size > 8 * 1024 * 1024) break;
        successions.push(item); bytes += size;
      }
      const last = successions.at(-1)?.projection.role;
      const nextCursor = last && successions.length < available.length ? Buffer.from(JSON.stringify({ scope: [subject, roleId ?? null, afterRevision], roleId: last.id, revision: last.revision })).toString('base64url') : null;
      return { version: 1, successions, nextCursor };
    },
    operation(subject: string, roleId: string, operationId: string): SessionSuccessionReplay {
      const item = entries(subject).find(item => item.projection.role.id === roleId && item.projection.receipt.operationId === operationId);
      if (!item) throw new StarError(403, 'succession_unavailable', 'Succession access is unavailable.');
      return item;
    },
    current(subject: string, roleId: string) {
      const visible = entries(subject).filter(item => item.projection.role.id === roleId);
      const tenant = read().tenants.find(tenant => tenant.subject === subject);
      const complete = tenant ? committedSuccessionRows(tenant.broker).filter(item => item.projection!.role.id === roleId) : [];
      const latest = visible.at(-1);
      if (!latest || visible.length !== complete.length) throw new StarError(403, 'succession_unavailable', 'Succession access is unavailable.');
      return { version: 1 as const, role: latest.projection.role, locator: latest.to };
    },
  };
}

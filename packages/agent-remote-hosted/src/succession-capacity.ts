import { createHash } from 'node:crypto';
import { currentRecoveryWorkflows, retainedHostIdentities, retainedRecoveryInstallations } from './host-recovery.js';
import { MAX_PAIRING_HISTORY } from './pairing-keys.js';
import type { HostedRelayState } from './state.js';
import type { BrokerAssociationState } from './succession-associations.js';

/** Internal encoding boundary. This is neither physical storage quota nor effect permission. */
export interface SuccessionRecordCost {
  kind: string; owner: string; key: string; identity: string;
  byteLength: number; chunkCount: number; manifestBytes: number;
}
export interface SuccessionEncodingCosts {
  measureSnapshot(state: Readonly<HostedRelayState>): {
    snapshotFormat: number; recordFormat: number; chunkBytes: number; costs: readonly SuccessionRecordCost[];
  };
  quoteRecord(input: { kind: string; owner: string; key: string; payloadJsonBytesUpperBound: number }): Pick<SuccessionRecordCost, 'byteLength' | 'chunkCount' | 'manifestBytes'>;
}
export const SUCCESSION_FEATURE_BYTES = 8_388_608;
const MAX = Number.MAX_SAFE_INTEGER;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const widest = (length: number) => '\ud800'.repeat(length);
const jsonStringBound = (length: number) => sum(2, length * 6);
function recoveryHostBound(hostId: string, installationId: string): number {
  const label = widest(160);
  const tool = { id: label, name: label, status: 'not-found' };
  const environment = { detectedAt: null, os: { platform: label, name: label, arch: label, release: label }, wsl: false, container: false,
    shell: { name: label, source: 'environment' }, shells: Array(16).fill(tool), browsers: Array(16).fill(tool), vscode: { status: 'not-found' } };
  const controller = { version: '999999999.999999999.999999999', revision: 'f'.repeat(40), platform: widest(32), arch: widest(32), nodeMajor: 100, remoteUpdate: false };
  const provider = { providerId: widest(512), displayName: widest(512), promptEditing: true, sessionRename: true, daemonControl: true };
  // HostEnvironment.detectedAt accepts non-safe finite integers. JSON numbers need up to 24 bytes.
  return sum(bytes({ id: hostId, installationId, name: widest(512), environment, controller, providers: Array(64).fill(provider),
    legacyDsh: false, pairingPurpose: 'host-only', credentialRotation: true, providerManagement: true, tpmManagement: true }) - 4, 24);
}
const identity = (kind: string, owner: string, key: string) => JSON.stringify([kind, owner, key]);
const charge = (cost: Pick<SuccessionRecordCost, 'byteLength' | 'manifestBytes'>) => sum(cost.byteLength, cost.manifestBytes);
function sum(...values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(total + value)) throw new Error('Succession encoding bound overflow.');
    total += value;
  }
  return total;
}
/** Remaining durable transitions, shared by final accounting and pre-effect consumers. */
export function remainingAssociationRevisions(state: BrokerAssociationState): number {
  return sum(state.freezes.filter(row => row.released === undefined).length, state.admissions.length,
    ...state.relationChanges.map(row => ({ reserved: 3, metadata_committed: 2, overlay_applied: 1, committed: 0 })[row.phase]));
}
class SuccessionCapacityError extends Error {
  readonly code = 'succession_projection_capacity_exceeded';
  readonly status = 409;
}
/** Identifies only the owning pre-write policy check; callers must separately prove pre-effect safety. */
export function isSuccessionCapacityError(error: unknown): error is Error & { code: string; status: number } {
  return error instanceof SuccessionCapacityError;
}
export function requireSuccessionEncodingCosts(value: SuccessionEncodingCosts | undefined): asserts value is SuccessionEncodingCosts {
  if (!value || typeof value.measureSnapshot !== 'function' || typeof value.quoteRecord !== 'function') throw new Error('Succession accounting requires complete encoding costs.');
}
export interface SuccessionTenantCapacity {
  namespace: string; remainingAssociationRevisions: number; bindingSlots: number; creationSlots: number;
  progressSlots: number; credentialSlots: number; hostSlots: number;
}
export interface SuccessionCapacity {
  retainedBytes: number; remainingBytes: number; featureCharge: number;
  tenants: SuccessionTenantCapacity[]; violations: string[];
}

/** Complete ordinary sizing view, preserving unrelated values, extras, presence and array order. Never persisted. */
function ordinaryView(state: Readonly<HostedRelayState>): HostedRelayState {
  const ordinary = structuredClone(state);
  for (const tenant of ordinary.tenants) {
    const recoveryInstallations = retainedRecoveryInstallations(tenant.broker);
    delete tenant.favoritesSuccession;
    delete tenant.broker.associations;
    delete tenant.broker.revokedHosts;
    tenant.broker.keys = tenant.broker.keys.filter(([, key]) => key.recovery === undefined
      && !(key.kind === 'device' && key.installationId && recoveryInstallations.has(key.installationId)));
    if (tenant.broker.pairings !== undefined) tenant.broker.pairings = tenant.broker.pairings.filter(pairing => pairing.recovery === undefined);
  }
  return ordinary;
}

/** Maximum manifest number-width growth at any later ordinary header length, without a fictitious chunk fee. */
function headerNumberGrowth(minimum: number, delta: number, chunkBytes: number): number {
  if (!delta) return 0;
  const digits = (value: number) => String(value).length;
  const width = (length: number) => digits(length) + digits(Math.ceil(length / chunkBytes));
  let maximum = 0;
  const examine = (length: number) => {
    if (length >= minimum && Number.isSafeInteger(length) && Number.isSafeInteger(length + delta)) maximum = Math.max(maximum, width(length + delta) - width(length));
  };
  examine(minimum);
  for (let power = 10; power <= MAX; power *= 10) {
    examine(Math.max(minimum, power - delta));
    const boundary = (power - 1) * chunkBytes + 1;
    if (Number.isSafeInteger(boundary)) examine(Math.max(minimum, boundary - delta));
  }
  return maximum;
}

/** Derive every retained identity and remaining obligation from one authoritative complete snapshot. */
export function deriveSuccessionCapacity(state: Readonly<HostedRelayState>, encoding: SuccessionEncodingCosts): SuccessionCapacity {
  requireSuccessionEncodingCosts(encoding);
  const actual = encoding.measureSnapshot(state);
  const ordinary = encoding.measureSnapshot(ordinaryView(state));
  if (actual.snapshotFormat !== 3 || actual.recordFormat !== 1 || actual.chunkBytes !== 262144
    || actual.snapshotFormat !== ordinary.snapshotFormat || actual.recordFormat !== ordinary.recordFormat || actual.chunkBytes !== ordinary.chunkBytes) throw new Error('Unsupported succession encoding costs.');
  function index(costs: readonly SuccessionRecordCost[]) {
    const result = new Map<string, SuccessionRecordCost>();
    for (const cost of costs) {
      if (typeof cost.kind !== 'string' || typeof cost.owner !== 'string' || typeof cost.key !== 'string' || typeof cost.identity !== 'string'
        || !Number.isSafeInteger(cost.byteLength) || cost.byteLength < 1 || !Number.isSafeInteger(cost.manifestBytes) || cost.manifestBytes < 1
        || cost.chunkCount !== Math.ceil(cost.byteLength / actual.chunkBytes)) throw new Error('Invalid succession record costs.');
      const id = identity(cost.kind, cost.owner, cost.key);
      if (result.has(id)) throw new Error('Duplicate succession record costs.');
      result.set(id, cost);
    }
    return result;
  }
  const records = index(actual.costs), ordinaryRecords = index(ordinary.costs);
  const quote = (kind: string, owner: string, key: string, payloadJsonBytesUpperBound: number) => {
    sum(payloadJsonBytesUpperBound);
    const cost = encoding.quoteRecord({ kind, owner, key, payloadJsonBytesUpperBound });
    if (cost.byteLength < payloadJsonBytesUpperBound || cost.chunkCount !== Math.ceil(cost.byteLength / actual.chunkBytes)) throw new Error('Invalid succession record quote.');
    charge(cost); return cost;
  };
  const current = (kind: string, owner: string, key: string) => records.get(identity(kind, owner, key));
  const requireCurrent = (kind: string, owner: string, key: string) => {
    const cost = current(kind, owner, key);
    if (!cost) throw new Error('Missing complete succession record cost.');
    return cost;
  };
  const headers = new Map<string, { kind: string; owner: string; key: string; delta: number; absentPayload?: number }>();
  const replacements = new Map<string, number>();
  let retainedBytes = 0, remainingBytes = 0;
  for (const [id, cost] of records) retainedBytes = sum(retainedBytes, Math.max(0, charge(cost) - (ordinaryRecords.has(id) ? charge(ordinaryRecords.get(id)!) : 0)));
  const replacement = (kind: string, owner: string, key: string, payload: number) => {
    const present = current(kind, owner, key);
    const id = identity(kind, owner, key);
    replacements.set(id, Math.max(replacements.get(id) ?? 0, Math.max(0, charge(quote(kind, owner, key, payload)) - (present ? charge(present) : 0))));
  };
  const insertion = (kind: string, owner: string, key: string, payload: number) => { remainingBytes = sum(remainingBytes, charge(quote(kind, owner, key, payload))); };
  const headerGrowth = (kind: string, owner: string, key: string, delta: number, absentPayload?: number) => {
    const id = identity(kind, owner, key), saved = headers.get(id);
    headers.set(id, { kind, owner, key, delta: sum(saved?.delta ?? 0, delta), absentPayload: saved?.absentPayload ?? absentPayload });
  };
  // The sole codec's complete zero-payload envelope upper-bounds its tuple reference.
  const reference = (kind: string, owner: string, key: string) => sum(quote(kind, owner, key, 0).byteLength, 1);
  const field = (name: string, valueBytes: number) => sum(bytes(name), 2, valueBytes);
  const tenants: SuccessionTenantCapacity[] = [], violations: string[] = [];
  for (const tenant of state.tenants) {
    const broker = tenant.broker, owner = tenant.namespace, associations = broker.associations;
    const slots: SuccessionTenantCapacity = { namespace: owner, remainingAssociationRevisions: 0, bindingSlots: 0, creationSlots: 0, progressSlots: 0, credentialSlots: 0, hostSlots: 0 };
    tenants.push(slots);
    const brokerHeader = (delta: number) => headerGrowth('brokerHeader', owner, 'broker', delta);
    const identities = retainedHostIdentities(broker);
    for (const [hostId, installationId] of identities) {
      const existing = broker.revokedHosts?.find(row => row.hostId === hostId);
      const key = JSON.stringify([hostId, installationId]);
      replacement('revokedHost', owner, key, bytes({ ...existing, hostId, installationId, revocationId: existing?.revocationId ?? '00000000-0000-4000-8000-000000000000', revokedAt: MAX }));
      if (!existing) brokerHeader(reference('revokedHost', owner, key));
    }
    if (identities.size && broker.revokedHosts === undefined) brokerHeader(field('revokedHosts', 2));
    if (associations) {
      slots.bindingSlots = slots.creationSlots = associations.admissions.length;
      slots.remainingAssociationRevisions = remainingAssociationRevisions(associations);
      if (associations.revision > MAX - slots.remainingAssociationRevisions) violations.push('Association revision headroom is exhausted.');
      if (broker.bindings.length + slots.bindingSlots > 4096 || broker.creations.length + slots.creationSlots > 4096) violations.push('Source completion slots are exhausted.');
      const roles = new Map<string, number>();
      for (const row of associations.freezes) roles.set(row.receipt.request.roleId, (roles.get(row.receipt.request.roleId) ?? 0) + 1);
      if ([...roles.values()].some(count => count > 512)) violations.push('Succession role history is exhausted.');
      headerGrowth('associationHeader', owner, 'associations', bytes(associations.revision > MAX - slots.remainingAssociationRevisions ? MAX : sum(associations.revision, slots.remainingAssociationRevisions)) - bytes(associations.revision));
      for (const row of associations.freezes) {
        if (row.cancelOnly) {
          if (row.released === undefined) replacement('freeze', owner, row.receipt.token, bytes({ ...row, released: 'cancelled' }));
          continue;
        }
        if (row.receipt.version === 2 && row.projection && bytes(row.projection) > row.receipt.maxProjectionBytes) throw new Error('Succession projection bound invariant failed.');
        if (row.released === undefined) {
          if (row.receipt.version !== 2) throw new Error('Unresolved legacy succession has no finite projection bound.');
          replacement('freeze', owner, row.receipt.token, Math.max(
            sum(bytes({ ...row, released: 'committed', projection: null }) - 4, row.receipt.maxProjectionBytes),
            bytes({ ...row, released: 'cancelled' }), bytes({ ...row, released: 'rejected' })));
        }
        if (row.released !== undefined && row.released !== 'committed') continue;
        const progress = tenant.favoritesSuccession?.receipts.find(entry => entry.token === row.receipt.token);
        if (!progress) {
          slots.progressSlots++;
          insertion('favoritesReceipt', owner, row.receipt.token, bytes({ token: row.receipt.token, operationId: row.receipt.request.operationId,
            roleId: row.receipt.request.roleId, roleRevision: MAX, receiptHash: '0'.repeat(64), status: 'pending' }));
          headerGrowth('favoritesHeader', owner, 'favorites', reference('favoritesReceipt', owner, row.receipt.token), bytes({ version: 1, receipts: [] }));
        }
      }
      if ((tenant.favoritesSuccession?.receipts.length ?? 0) + slots.progressSlots > 1024) violations.push('Favorites progress slots are exhausted.');
      if (slots.progressSlots && tenant.favoritesSuccession === undefined) headerGrowth('tenant', '', owner, field('favoritesSuccession', reference('favoritesHeader', owner, 'favorites')));
      for (const admission of associations.admissions) {
        const hostId = broker.hosts.find(host => host.installationId === admission.source.controllerId)?.id ?? widest(512);
        const bindingKey = widest(512), creationKey = widest(16384);
        const relation = { id: widest(512), kind: 'side', sourceNativeSessionId: admission.source.nativeSessionId,
          nativeSourceRef: admission.source, createdAt: '0000-00-00T00:00:00.000Z' };
        const bindingBytes = bytes({ hostId, providerId: admission.source.providerId, agentId: bindingKey,
          nativeSessionId: widest(512), creatorSubject: widest(512), sourceRelation: relation });
        insertion('binding', owner, bindingKey, bindingBytes);
        insertion('creation', owner, creationKey, sum(bytes({ fingerprint: null, agentId: null }) - 8, jsonStringBound(65536), jsonStringBound(512)));
        brokerHeader(sum(reference('binding', owner, bindingKey), reference('creation', owner, creationKey)));
      }
      // The real shared-create route passes this native request ID into the owner creation tuple.
      // Imported admissions that do not match that constructor cannot complete an unrelated receipt.
      for (const receipt of broker.sharing?.reservations ?? []) {
        if (receipt.agentId !== undefined) continue;
        const host = broker.hosts.find(host => host.id === receipt.hostId);
        const applicable = associations.admissions.some(admission => host?.installationId === admission.source.controllerId
          && createHash('sha256').update(JSON.stringify([receipt.hostId, admission.source.providerId, receipt.nativeRequestId])).digest('hex') === admission.id);
        if (applicable) replacement('reservation', owner, receipt.key, bytes({ ...receipt, agentId: widest(512) }));
      }
      for (const row of associations.relationChanges) {
        if (row.phase === 'committed') continue;
        const phases = row.phase === 'reserved' ? ['metadata_committed', 'overlay_applied', 'committed']
          : row.phase === 'metadata_committed' ? ['overlay_applied', 'committed'] : ['committed'];
        replacement('relationChange', owner, row.reservation.operationId, Math.max(...phases.map(phase => bytes({ reservation: row.reservation, phase,
          hostReceipt: { reservation: row.reservation, phase: phase === 'metadata_committed' ? 'reserved' : 'released',
            associationRevision: row.reservation.associationRevision + (phase === 'metadata_committed' ? 0 : Number(row.reservation.previousMember !== row.reservation.linked)) } }))));
        if (row.phase !== 'reserved') continue;
        const reservation = row.reservation;
        const binding = broker.bindings.find(binding => binding.hostId === reservation.hostId && binding.providerId === reservation.readerRef.providerId && binding.nativeSessionId === reservation.readerRef.nativeSessionId);
        if (binding?.sourceRelation) replacement('binding', owner, binding.agentId, bytes({ ...binding, sourceRelation: { ...binding.sourceRelation,
          nativeSourceRef: reservation.sourceRef, linked: reservation.linked, revision: reservation.expectedRelationRevision + 1 } }));
      }
      const products = associations.freezes.filter(row => !row.cancelOnly && (row.released === undefined || row.released === 'committed')
        && tenant.favoritesSuccession?.receipts.find(entry => entry.token === row.receipt.token)?.status !== 'applied');
      if (products.length) {
        const stars = state.sessionStars?.filter(star => star.subject === tenant.subject) ?? [];
        const tree = state.favoritesTrees?.find(tree => tree.subject === tenant.subject);
        const affected = stars.filter(star => products.some(row => row.hostId === star.hostId && row.receipt.request.from.providerId === star.providerId && row.receipt.request.from.nativeSessionId === star.nativeSessionId));
        if (affected.length) {
          // Organizing one source star can materialize every legacy owner star and normalize all orders.
          for (const star of stars) {
            const key = JSON.stringify([star.subject, star.hostId, star.providerId, star.nativeSessionId]);
            const organized = { ...star, favoriteId: star.favoriteId ?? 'star_' + '0'.repeat(64), folderId: star.folderId ?? null, order: MAX };
            if (!affected.includes(star)) { replacement('sessionStar', '', key, bytes(organized)); continue; }
            // A pending lineage can move this star through several providers in one application.
            // Bound every accepted final target, rather than only its first directly matching edge.
            const candidate = { ...organized, providerId: widest(512), nativeSessionId: widest(512),
              title: widest(512), workspace: widest(4096), parentNativeSessionId: widest(4096) };
            const nextKey = JSON.stringify([candidate.subject, candidate.hostId, candidate.providerId, candidate.nativeSessionId]);
            const largest = charge(quote('sessionStar', '', nextKey, bytes(candidate)));
            remainingBytes = sum(remainingBytes, Math.max(0, largest - charge(requireCurrent('sessionStar', '', key))));
            // The existing reference can be shorter; charging a whole bounded reference is conservative.
            headerGrowth('relayHeader', '', 'relay', reference('sessionStar', '', nextKey));
          }
          if (tree) {
            replacement('favoritesTree', '', tree.subject, bytes({ ...tree, revision: MAX, folders: tree.folders.map(folder => ({ ...folder, order: MAX })) }));
          } else {
            insertion('favoritesTree', '', tenant.subject, bytes({ subject: tenant.subject, revision: MAX, folders: [] }));
            headerGrowth('relayHeader', '', 'relay', sum(reference('favoritesTree', '', tenant.subject), state.favoritesTrees === undefined ? field('favoritesTrees', 2) : 0));
          }
        }
      }
    }
    const recoveryKeys = broker.keys.filter(([, key]) => key.recovery !== undefined);
    for (const recovery of currentRecoveryWorkflows(broker)) {
      const installationId = recovery.installationId;
      const claimGrowth = Math.max(0, ...recoveryKeys.filter(([, key]) => key.recovery!.installationId === installationId).map(([hash, key]) =>
        key.claimedAt === undefined ? charge(quote('deviceKey', owner, hash, bytes({ ...key, claimedAt: MAX }))) - charge(requireCurrent('deviceKey', owner, hash)) : 0));
      remainingBytes = sum(remainingBytes, claimGrowth);
      if (!broker.hosts.some(host => host.id === recovery.hostId && host.installationId === installationId)) {
        slots.hostSlots++;
        insertion('host', owner, recovery.hostId, recoveryHostBound(recovery.hostId, installationId));
        brokerHeader(reference('host', owner, recovery.hostId));
      }
      if (!broker.keys.some(([, key]) => key.kind === 'device' && key.installationId === installationId)) {
        slots.credentialSlots++;
        const nextHash = '0'.repeat(64);
        insertion('deviceKey', owner, nextHash, bytes({ expires: MAX, installationId, kind: 'device' }));
        brokerHeader(reference('deviceKey', owner, nextHash));
      }
      if (!identities.has(recovery.hostId)) throw new Error('Recovery identity has no retained marker.');
    }
    for (const pairing of broker.pairings ?? []) {
      if (!pairing.recovery || pairing.usedAt !== undefined || pairing.revokedAt !== undefined) continue;
      replacement('pairing', owner, pairing.id, Math.max(
        bytes({ ...pairing, usedAt: 8_640_000_000_000_000, hostId: pairing.recovery.hostId, hostName: widest(512) }),
        bytes({ ...pairing, revokedAt: 8_640_000_000_000_000 })));
    }
    if (broker.keys.length + slots.credentialSlots > 128) violations.push('Recovery credential slots are exhausted.');
    if (broker.hosts.length + slots.hostSlots > 128) violations.push('Recovery Host slots are exhausted.');
    if ((broker.pairings?.length ?? 0) > MAX_PAIRING_HISTORY) violations.push('Pairing history slots are exhausted.');
  }
  // Existing shared headers also reserve future numeric widths attributable only to feature bytes.
  for (const [id, cost] of records) {
    if (!ordinaryRecords.has(id) || !['relayHeader', 'tenant', 'brokerHeader'].includes(cost.kind)) continue;
    if (cost.byteLength !== ordinaryRecords.get(id)!.byteLength && !headers.has(id)) headers.set(id, { kind: cost.kind, owner: cost.owner, key: cost.key, delta: 0 });
  }
  for (const [id, growth] of headers) {
    const present = records.get(id), ordinaryCost = ordinaryRecords.get(id);
    if (!present) {
      if (growth.absentPayload === undefined) throw new Error('Missing header payload bound.');
      remainingBytes = sum(remainingBytes, charge(quote(growth.kind, growth.owner, growth.key, sum(growth.absentPayload, growth.delta))));
    } else if (ordinaryCost) {
      const delta = sum(Math.max(0, present.byteLength - ordinaryCost.byteLength), growth.delta);
      const maximum = sum(delta, headerNumberGrowth(ordinaryCost.byteLength, delta, actual.chunkBytes));
      remainingBytes = sum(remainingBytes, Math.max(0, maximum - Math.max(0, charge(present) - charge(ordinaryCost))));
    } else {
      const payload = present.byteLength - quote(growth.kind, growth.owner, growth.key, 0).byteLength;
      if (payload < 0) throw new Error('Invalid complete header encoding cost.');
      replacement(growth.kind, growth.owner, growth.key, sum(payload, growth.delta));
    }
  }
  remainingBytes = sum(remainingBytes, ...replacements.values());
  const featureCharge = sum(retainedBytes, remainingBytes);
  if (featureCharge > SUCCESSION_FEATURE_BYTES) violations.push('Succession evidence encoding capacity is exhausted.');
  return { retainedBytes, remainingBytes, featureCharge, tenants, violations };
}

export function assertSuccessionCapacity(state: Readonly<HostedRelayState>, encoding: SuccessionEncodingCosts): SuccessionCapacity {
  const capacity = deriveSuccessionCapacity(state, encoding);
  if (capacity.violations.length) throw new SuccessionCapacityError(capacity.violations.join(' '));
  return capacity;
}

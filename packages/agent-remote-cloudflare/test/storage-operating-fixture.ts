import { createHash } from 'node:crypto';
import { validateRelayState, emptyRelayState, type HostedRelayState } from '../../agent-remote-hosted/src/state.js';
import { deriveSuccessionCapacity, SUCCESSION_FEATURE_BYTES } from '../../agent-remote-hosted/src/succession-capacity.js';
import { encodeSqlSnapshot, decodeSqlSnapshot, quoteSqlRecord, SQL_CHUNK_BYTES } from '../src/storage-codec.js';
import { accountingAuth as auth } from './accounting-worker-fixture.js';
import { codecState } from './storage-codec-fixture.js';
import { retentionState } from './retention-consumption-fixture.js';
import { successionFreezeKey } from '../../agent-remote-protocol/src/index.js';

export const operatingCases = ['S', 'M', 'B0', 'B1', 'L', 'O'] as const;
export type OperatingCase = typeof operatingCases[number];
export const operatingEncoding = {
  measureSnapshot: (state: Readonly<HostedRelayState>) => ({ snapshotFormat: 3, recordFormat: 1, chunkBytes: SQL_CHUNK_BYTES, costs: encodeSqlSnapshot(state as HostedRelayState, auth).costs }),
  quoteRecord: quoteSqlRecord,
};
const namespace = (subject: string) => createHash('sha256').update(JSON.stringify([auth.issuer, subject])).digest('hex');
export const stateDigest = (state: unknown) => createHash('sha256').update(JSON.stringify(state)).digest('hex');

function complete(state: HostedRelayState): HostedRelayState {
  state.version = 10;
  const validated = validateRelayState(state, auth), encoded = encodeSqlSnapshot(validated, auth);
  const decoded = decodeSqlSnapshot([...encoded.records.values()].map(record => record.manifest), [...encoded.records.values()].flatMap(record => record.chunks), auth);
  if (JSON.stringify(decoded) !== JSON.stringify(validated)) throw new Error('Operating dataset lost complete ordered snapshot identity.');
  if (deriveSuccessionCapacity(validated, operatingEncoding).violations.length) throw new Error('Operating dataset violates final capacity.');
  return validated;
}

function ordinary() {
  const state = emptyRelayState(auth);
  state.tenants.push({ subject: 'owner', namespace: namespace('owner'), broker: {
    keys: [], pairings: [], hosts: [{ id: 'host', installationId: 'installation', name: 'Fixture', legacyDsh: false, providers: [{ providerId: 'fixture', displayName: 'Fixture' }] }],
    bindings: [{ hostId: 'host', providerId: 'fixture', nativeSessionId: 'source', agentId: 'source-agent', creatorSubject: 'owner' }], creations: [],
  } });
  return state;
}

function inventory() {
  const state = codecState(auth);
  for (const row of state.tenants[0]!.broker.associations!.freezes) {
    if (row.released === undefined) row.receipt = { ...row.receipt, version: 2, maxProjectionBytes: 65536 };
  }
  // Frozen expiry values avoid wall-clock dataset drift and the restart authority-lease reset.
  for (const tenant of state.tenants) for (const [, key] of tenant.broker.keys) key.expires = Number.MAX_SAFE_INTEGER;
  for (const tenant of state.tenants) for (const preview of tenant.broker.previews ?? []) {
    for (const registration of preview.snapshot.registrations) registration.expiresAt = Number.MAX_SAFE_INTEGER;
  }
  for (const session of state.sessions) {
    session.sessionExpiresAt = Number.MAX_SAFE_INTEGER; session.grant.expiresAt = 0; session.grant.sessionExpiresAt = Number.MAX_SAFE_INTEGER;
  }
  return state;
}

/** Rebind the complete constructor's authorities and native tuples consistently to an independent tenant. */
function inventoryTenant() {
  const state = inventory();
  const replacements: Record<string, string> = {
    owner: 'inventory', [namespace('owner')]: namespace('inventory'),
    'mapped-host': 'inventory-mapped-host', 'historic-host': 'inventory-historic-host',
    installation: 'inventory-installation', 'historic-installation': 'inventory-historic-installation',
  };
  const rebind = (value: any): any => typeof value === 'string' ? replacements[value] ?? value
    : Array.isArray(value) ? value.map(rebind)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebind(item)])) : value;
  const rebound = rebind(state) as HostedRelayState, tenant = rebound.tenants[0]!;
  for (const progress of tenant.favoritesSuccession!.receipts) {
    const row = tenant.broker.associations!.freezes.find(item => item.receipt.token === progress.token)!;
    progress.receiptHash = createHash('sha256').update(JSON.stringify([successionFreezeKey(row.receipt), row.projection])).digest('hex');
  }
  return rebound;
}

function large() {
  const state = retentionState(auth, true), additional = inventoryTenant();
  state.tenants.push(additional.tenants[0]!);
  state.sessions = additional.sessions;
  state.sessionStars!.push(...additional.sessionStars!);
  state.favoritesTrees = additional.favoritesTrees; state.sessionTitles = additional.sessionTitles; state.sessionTitleRevision = additional.sessionTitleRevision;
  state.sessionMigrations = additional.sessionMigrations;
  state.tenants[0]!.broker.bindings.push({ hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'B', agentId: 'operating-source-B', creatorSubject: 'owner' });
  const padded = state.tenants[1]!.broker.associations!.freezes.find(row => row.released === 'cancelled')! as any;
  padded.operatingRetainedExtra = '';
  return { state, padded };
}

export function prepareOperatingDatasets() {
  const datasets = {} as Record<OperatingCase, HostedRelayState>, calibration: any[] = [];
  datasets.S = complete(ordinary());
  const many = ordinary(); many.tenants = [];
  for (let tenantIndex = 0; tenantIndex < 4; tenantIndex++) {
    const subject = `many-${tenantIndex}`, tenant = structuredClone(ordinary().tenants[0]!);
    tenant.subject = subject; tenant.namespace = namespace(subject);
    const template = structuredClone(retentionState(auth).tenants[0]!.broker.associations!.freezes[0]!);
    tenant.broker.associations = { version: 5, revision: 128, admissions: [], relationChanges: [], relationResets: [], freezes: [] };
    for (let rowIndex = 0; rowIndex < 32; rowIndex++) {
      const row: any = structuredClone(template);
      row.hostId = 'host'; row.receipt.authority.namespace = tenant.namespace; row.receipt.authority.ownerSubject = subject;
      row.receipt.token = `many-${tenantIndex}-${rowIndex}`; row.receipt.request.operationId = `many-op-${tenantIndex}-${rowIndex}`;
      row.receipt.request.roleId = `many-role-${tenantIndex}-${rowIndex}`;
      row.released = rowIndex % 2 ? 'cancelled' : 'rejected';
      tenant.broker.associations.freezes.push(row);
    }
    many.tenants.push(tenant);
  }
  datasets.M = complete(many);
  for (const [id, target] of [['B0', 262144], ['B1', 262145]] as const) {
    const state = inventory(), row: any = state.tenants[0]!.broker.associations!.freezes.find(item => item.released === 'cancelled')!;
    row.operatingRetainedExtra = ''; (state.tenants[0]!.broker as any).operatingHeaderExtra = '';
    for (let attempt = 1; attempt <= 4; attempt++) {
      const measured = operatingEncoding.measureSnapshot(state).costs;
      const record = measured.find(cost => cost.kind === 'freeze' && cost.key === row.receipt.token)!;
      const header = measured.find(cost => cost.kind === 'brokerHeader' && cost.owner === state.tenants[0]!.namespace)!;
      calibration.push({ id, attempt, target, recordBytes: record.byteLength, headerBytes: header.byteLength });
      if (record.byteLength === target && header.byteLength === target) break;
      row.operatingRetainedExtra = 'x'.repeat(Math.max(0, row.operatingRetainedExtra.length + target - record.byteLength));
      (state.tenants[0]!.broker as any).operatingHeaderExtra = 'x'.repeat(Math.max(0, (state.tenants[0]!.broker as any).operatingHeaderExtra.length + target - header.byteLength));
    }
    datasets[id] = complete(state);
  }
  const { state, padded } = large(), target = SUCCESSION_FEATURE_BYTES - 4096;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const capacity = deriveSuccessionCapacity(state, operatingEncoding);
    calibration.push({ id: 'L', attempt, target, ...capacity });
    if (capacity.featureCharge === target) break;
    padded.operatingRetainedExtra = 'x'.repeat(Math.max(0, padded.operatingRetainedExtra.length + target - capacity.featureCharge));
  }
  datasets.L = complete(state);
  const ordinaryExtra: any = structuredClone(datasets.L); ordinaryExtra.operatingOrdinaryExtra = 'x'.repeat(1048576);
  datasets.O = complete(ordinaryExtra);
  const summaries = operatingCases.map(id => ({ id, snapshotSha256: stateDigest(datasets[id]),
    capacity: deriveSuccessionCapacity(datasets[id], operatingEncoding), records: operatingEncoding.measureSnapshot(datasets[id]).costs }));
  return { datasets, calibration, summaries };
}

export function operatingWarmUpdate(id: OperatingCase, initial: HostedRelayState) {
  const next: any = structuredClone(initial);
  if (id === 'S') next.operatingUpdate = 'warm';
  else if (id === 'M') next.tenants[0].broker.associations.freezes[0].operatingUpdate = 'warm';
  else if (id === 'B0' || id === 'B1') {
    const row = next.tenants[0].broker.associations.freezes.find((item: any) => item.released === 'cancelled');
    row.operatingRetainedExtra = 'y' + row.operatingRetainedExtra.slice(1);
    next.tenants[0].broker.operatingHeaderExtra = 'y' + next.tenants[0].broker.operatingHeaderExtra.slice(1);
  } else throw new Error('Large cases use the frozen consumer chain.');
  return complete(next);
}

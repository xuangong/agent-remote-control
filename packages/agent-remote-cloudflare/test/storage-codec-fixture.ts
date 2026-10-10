import { createHash } from 'node:crypto';
import { emptyRelayState, validateRelayState, type GatewayAuthOptions, type HostedRelayState } from '@orchardworks/agent-remote-hosted';
import { successionFreezeKey } from '../../agent-remote-protocol/src/index.js';

/** Complete A -> B -> C evidence follows the hosted immutable replay fixture. */
export function codecState(auth: GatewayAuthOptions): HostedRelayState {
  const namespace = (subject: string) => createHash('sha256').update(JSON.stringify([auth.issuer, subject])).digest('hex');
  const ref = (nativeSessionId: string, controllerId = 'installation') => ({ controllerId, providerId: 'fixture', nativeSessionId });
  const workspace = { controllerId: 'installation', canonicalCwd: '/workspace' };
  const authority = { version: 1, origin: auth.origin, issuer: auth.issuer, namespace: namespace('owner'), ownerSubject: 'owner' };
  const row = (revision: number) => {
    const from = ref(revision === 2 ? 'A' : 'B'), to = ref(revision === 2 ? 'B' : 'C');
    const request = { operationId: `op-${revision}`, roleId: 'role', expectedRevision: revision - 1, from };
    const projection = { version: 1, role: { id: 'role', revision, origin: ref('A'), current: to, workspace },
      receipt: { ...request, to, phase: 'committed', committedRevision: revision, startedAt: 'now', updatedAt: 'now',
        prepared: { ...request, to, workspace, associationRevision: 1, participants: [], capture: { epoch: 'e', seq: 1, capturedAt: 'now' } } } };
    const receipt = { version: revision === 2 ? 1 : 2, token: `freeze-${revision}`, authority, controllerId: 'installation', request,
      associationRevision: 0, lineage: revision === 2 ? [ref('A')] : [ref('A'), ref('B')], relations: [],
      ...(revision === 2 ? {} : { maxProjectionBytes: 2 * 1024 * 1024 }) };
    return { hostId: 'mapped-host', receipt, released: 'committed', projection };
  };
  const freezes: any[] = [row(2), row(3)];
  for (const [index, released] of [undefined, 'cancelled', 'rejected'].entries()) freezes.push({ hostId: 'historic-host',
    receipt: { version: 1, token: `historic-${index}`, authority, controllerId: 'historic-installation',
      request: { operationId: `historic-op-${index}`, roleId: `historic-role-${index}`, expectedRevision: 1, from: ref('historic-A', 'historic-installation') },
      associationRevision: 0, lineage: [ref('historic-A', 'historic-installation')], relations: [] }, ...(released ? { released } : {}) });
  const relationChanges = ['reserved', 'metadata_committed', 'overlay_applied', 'committed'].map((phase, index) => {
    const readerRef = ref(`reader-${index}`), sourceRef = ref('A');
    const reservation = { version: 1, operationId: `relation-${index}`, token: `relation-token-${index}`, authority,
      hostId: 'mapped-host', controllerId: 'installation', roleId: `relation-role-${index}`, expectedRoleRevision: 1,
      origin: sourceRef, current: sourceRef, lineage: [sourceRef], associationRevision: 4, catalogRevision: 5,
      relationId: `relation-id-${index}`, kind: 'side', readerRef, sourceRef, expectedRelationRevision: 3,
      previousLinked: true, linked: false, previousMember: true,
      relations: [{ relationId: `relation-id-${index}`, kind: 'side', readerRef, sourceRef, linked: true, revision: 3 }] };
    return { reservation, phase, ...(phase === 'reserved' ? {} : { hostReceipt: { reservation: structuredClone(reservation),
      phase: phase === 'metadata_committed' ? 'reserved' : phase === 'committed' ? 'released' : 'applied',
      associationRevision: phase === 'metadata_committed' ? 4 : 5 } }) };
  });
  const recovery = { hostId: 'historic-host', installationId: 'historic-installation', revocationId: '00000000-0000-4000-8000-000000000001' };
  const state: any = emptyRelayState(auth); state.version = 9; state.extraRelay = { data: '\ud800😀' };
  state.tenants = [{ subject: 'owner', namespace: namespace('owner'), extraTenant: { kept: true }, broker: {
    keys: [['a'.repeat(64), { expires: Date.now() + 600000, installationId: 'historic-installation', purpose: 'host-only', requiresRotation: true, recovery, extraCredential: 'retained' }]],
    hosts: [{ id: 'mapped-host', installationId: 'installation', name: 'Host', legacyDsh: false, providers: [{ providerId: 'fixture', displayName: 'Fixture' }], extraHost: 'retained' }],
    bindings: [{ agentId: 'agent-C', hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'C', creatorSubject: 'owner', parentNativeSessionId: 'A',
      sourceRelation: { id: 'source-relation', kind: 'side', sourceNativeSessionId: 'A', nativeSourceRef: ref('A'), createdAt: '2026-10-10T00:00:00.000Z', linked: true, revision: 1 } }],
    creations: [['create-C', { agentId: 'agent-C', fingerprint: 'full-fingerprint', extraCreation: 'retained' }]],
    previews: [{ hostId: 'mapped-host', snapshot: { epoch: 'preview-epoch', revision: 1, registrations: [{ id: 'preview', target: 'http://127.0.0.1:5173', status: 'active', createdAt: 1, expiresAt: Date.now() + 600000, revision: 1, pathMode: 'strip', sources: [{ sessionId: 'C', itemId: 'item' }] }] },
      pendingRemovals: ['pending'], pins: [{ target: 'http://127.0.0.1:5173', nameId: 'pinned' }], names: [{ id: 'preview', nameId: 'pinned' }], extraPreview: true }],
    sharing: { grants: [{ hostId: 'historic-host', subject: 'viewer', label: 'Retained grant', sessionLimit: 3, revoked: true }], reservations: [{ key: 'quota', hostId: 'historic-host', subject: 'viewer', fingerprint: 'quota-fingerprint', nativeRequestId: 'request', agentId: 'historic-agent' }], extraSharing: true },
    pairings: [{ id: 'unused', purpose: 'host-only', createdAt: 1, expiresAt: 10, recovery },
      { id: 'used', purpose: 'host-only', createdAt: 1, expiresAt: 10, usedAt: 2, hostId: 'historic-host', hostName: 'Historic', recovery },
      { id: 'revoked', purpose: 'host-only', createdAt: 1, expiresAt: 10, revokedAt: 3, recovery }],
    revokedHosts: [{ ...recovery, revokedAt: 4 }], extraBroker: { kept: true },
    associations: { version: 5, revision: 20, extraAssociations: true,
      admissions: [{ id: 'admission', fingerprint: 'admission-fingerprint', source: ref('A'), extraAdmission: true }],
      freezes, relationChanges, relationResets: [{ version: 1, phase: 'pre_effect', intent: { version: 1, operationId: 'reset', authority,
        hostId: 'mapped-host', controllerId: 'installation', readerRef: ref('reader-reset'), sourceRef: ref('A'),
        relationId: 'reset-relation', linked: false, expectedRelationRevision: 0, expectedRoleRevision: 1 } }] } },
    favoritesSuccession: { version: 1, receipts: freezes.slice(0, 2).map((row, index) => ({ token: row.receipt.token,
      operationId: row.projection.receipt.operationId, roleId: row.projection.role.id, roleRevision: row.projection.role.revision,
      receiptHash: createHash('sha256').update(JSON.stringify([successionFreezeKey(row.receipt), row.projection])).digest('hex'), status: index ? 'pending' : 'applied' })) } },
    { subject: 'viewer', namespace: namespace('viewer'), broker: { keys: [], hosts: [], bindings: [], creations: [], pairings: [] } }];
  state.sessionStars = [{ subject: 'owner', hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'C', title: 'Saved', starredAt: 1, favoriteId: 'favorite', folderId: 'folder', order: 0 }];
  state.favoritesTrees = [{ subject: 'owner', revision: 1, folders: [{ id: 'folder', parentId: null, title: 'Work', order: 0 }] }];
  state.sessionTitles = [{ hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'C', title: 'Current C', revision: 1 }]; state.sessionTitleRevision = 1;
  state.sessions = [{ hash: 'b'.repeat(64), sessionExpiresAt: Date.now() + 600000, id: 'session', label: 'Browser', createdAt: 1, lastSeenAt: 2, activity: [1, 2],
    grant: { subject: 'owner', namespace: namespace('owner'), authenticatedAt: 1, expiresAt: Date.now() + 600000, ticket: 'complete-ticket', nonce: 'nonce', continuation: 'owner', sessionExpiresAt: Date.now() + 600000, profile: { name: 'Owner', email: 'owner@example.test' } } }];
  state.loginChallenges = [['c'.repeat(43), { expiresAt: 10, hostId: 'mapped-host' }]];
  state.consumedProofs = [['proof-identity-01', 20]];
  state.sessionMigrations = [{ subject: 'owner', id: 'migration', from: { hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'old', agentId: 'old-agent' }, to: { hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'branch', agentId: 'branch-agent' }, createdAt: 1 }];
  state.securityEvents = [{ id: 'later', subject: 'owner', at: 20, action: 'login', outcome: 'allowed' }, { id: 'earlier', subject: 'owner', at: 10, action: 'login', outcome: 'allowed' }];
  return validateRelayState(state, auth);
}

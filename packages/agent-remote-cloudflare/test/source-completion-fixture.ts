import { createHash } from 'node:crypto';
import { createHostBroker } from '../../agent-remote-hosted/src/broker.js';
import type { RelaySocket } from '../../agent-remote-hosted/src/transport.js';
import { emptyRelayState, type HostedRelayState, type RelayState } from '../../agent-remote-hosted/src/state.js';
import type { GatewayAuthOptions } from '../../agent-remote-hosted/src/auth.js';

export function sourceCompletionState(auth: GatewayAuthOptions): HostedRelayState {
  const state = emptyRelayState(auth); state.version = 9;
  state.tenants.push({ subject: 'owner', namespace: createHash('sha256').update(JSON.stringify([auth.issuer, 'owner'])).digest('hex'), broker: {
    keys: [[createHash('sha256').update('arc_fixture').digest('hex'), { expires: Date.now() + 600000, installationId: 'installation', kind: 'device' }]],
    hosts: [{ id: 'host', installationId: 'installation', name: 'Fixture', providers: [{ providerId: 'fixture', displayName: 'Fixture' }], legacyDsh: false }],
    bindings: [{ hostId: 'host', providerId: 'fixture', nativeSessionId: 'source', agentId: 'source-agent', creatorSubject: 'viewer' }], creations: [],
    associations: { version: 5, revision: 0, admissions: [], freezes: [], relationChanges: [], relationResets: [] },
    sharing: { grants: [{ hostId: 'host', subject: 'viewer', label: 'Viewer', sessionLimit: 10, revoked: false }], reservations: [] },
  } });
  return state;
}

/** Isolated protocol peer only: there is no native provider or producer certificate. */
export async function sourceCompletionBroker(relay: RelayState, auth: GatewayAuthOptions, beforeTerminal: () => void = () => {}) {
  const initial = relay.read().tenants[0]!;
  const broker = createHostBroker({ origin: auth.origin, ownerSubject: 'owner', durable: true, initialState: initial.broker,
    successionEnrollment: { version: 1, origin: auth.origin, issuer: auth.issuer, ownerSubject: 'owner', namespace: initial.namespace },
    onStateChange: value => relay.mutate(draft => { draft.tenants[0]!.broker = value; }) });
  const listeners = new Set<(data: string, binary: boolean) => void | Promise<void>>(), closers = new Set<() => void>();
  let readyState = 1, registered!: () => void, creates = 0, readbacks = 0, attaches = 0;
  const registration = new Promise<void>(resolve => { registered = resolve; });
  const send = (message: unknown) => queueMicrotask(() => { if (readyState === 1) for (const listener of listeners) void listener(JSON.stringify(message), false); });
  const socket: RelaySocket = {
    get readyState() { return readyState; }, bufferedAmount: 0,
    send(text) {
      const message = JSON.parse(text);
      if (message.type === 'registered') { registered(); return; }
      if (message.type === 'heartbeat') { send({ uplinkVersion: 2, type: 'heartbeat_ack', nonce: message.nonce }); return; }
      if (message.type !== 'rpc_request') return;
      const input = JSON.parse(message.body ?? '{}'); let body: unknown = {};
      if (message.path === '/remote/create') { creates++; beforeTerminal(); body = { agentId: 'reader-agent', nativeSessionId: 'reader' }; }
      if (message.path === '/remote/attach') { attaches++; body = { agentId: 'reader-agent', nativeSessionId: input.nativeSessionId }; }
      if (input.action === 'source-result') { readbacks++; body = { operationId: input.operationId,
        source: { controllerId: 'installation', providerId: 'fixture', nativeSessionId: 'source' }, reader: { controllerId: 'installation', providerId: 'fixture', nativeSessionId: 'reader' } }; }
      if (input.action === 'relation_status') { beforeTerminal(); body = { receipt: { reservation: input.reservation, phase: 'released', associationRevision: 5 } }; }
      send({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: 200, body: JSON.stringify(body) });
    },
    close() { if (readyState !== 1) return; readyState = 3; for (const close of closers) close(); },
    onMessage(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onClose(listener) { closers.add(listener); return () => { closers.delete(listener); }; }, onError() { return () => {}; },
  };
  const upgrade = await broker.prepareUpgrade(new Request(auth.origin + '/ws/remote-host?successionEnrollment=2', { headers: { authorization: 'Bearer arc_fixture' } }));
  if (!upgrade || upgrade instanceof Response) { broker.close(); throw new Error('Fixture Host registration rejected.'); }
  upgrade.accept(socket); send({ uplinkVersion: 2, type: 'register', installationId: 'installation', name: 'Fixture', providers: [{ providerId: 'fixture', displayName: 'Fixture' }] });
  await registration;
  return { broker, counts: () => ({ creates, readbacks, attaches }), reconcile: () => broker.reconcileSessionRelationChange('owner', { hostId: 'host', operationId: 'relation-edit' }), create: () => broker.handleRequest(new Request(auth.origin + '/v1/remote/hosts/host/create', {
    method: 'POST', body: JSON.stringify({ providerId: 'fixture', operationId: 'shared-source', sourceNativeSessionId: 'source', conversationKind: 'ask', cwd: '/escaped/"\\' }),
  }), { principalSubject: () => 'viewer' }) };
}

export function relationCompletionState(auth: GatewayAuthOptions): HostedRelayState {
  const state = sourceCompletionState(auth), tenant = state.tenants[0]!, broker = tenant.broker;
  const sourceRef = { controllerId: 'installation', providerId: 'fixture', nativeSessionId: 'source' }, readerRef = { ...sourceRef, nativeSessionId: 'reader' };
  broker.bindings.push({ hostId: 'host', providerId: 'fixture', nativeSessionId: 'reader', agentId: 'reader-agent',
    sourceRelation: { id: 'side', kind: 'side', sourceNativeSessionId: 'source', nativeSourceRef: sourceRef, linked: false, revision: 4, createdAt: '2026-10-10T00:00:00.000Z' } });
  const reservation = { version: 1 as const, operationId: 'relation-edit', token: 'relation-token',
    authority: { version: 1 as const, origin: auth.origin, issuer: auth.issuer, namespace: tenant.namespace, ownerSubject: 'owner' },
    hostId: 'host', controllerId: 'installation', roleId: 'role', expectedRoleRevision: 1, origin: sourceRef, current: sourceRef, lineage: [sourceRef],
    associationRevision: 4, catalogRevision: 7, relationId: 'side', kind: 'side' as const, readerRef, sourceRef, expectedRelationRevision: 3, previousLinked: true, linked: false, previousMember: true,
    relations: [{ relationId: 'side', kind: 'side' as const, readerRef, sourceRef, linked: true, revision: 3 }] };
  broker.associations!.revision = 10;
  broker.associations!.relationChanges.push({ reservation, phase: 'overlay_applied', hostReceipt: { reservation, phase: 'applied', associationRevision: 5 } });
  return state;
}

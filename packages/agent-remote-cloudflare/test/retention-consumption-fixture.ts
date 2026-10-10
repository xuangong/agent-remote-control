import { createHash } from 'node:crypto';
import { createHostBroker } from '../../agent-remote-hosted/src/broker.js';
import { projectSuccessionFavorites } from '../../agent-remote-hosted/src/favorites-succession.js';
import { pruneSessionTitles } from '../../agent-remote-hosted/src/session-titles.js';
import type { GatewayAuthOptions } from '../../agent-remote-hosted/src/auth.js';
import type { RelayState } from '../../agent-remote-hosted/src/state.js';
import type { RelaySocket } from '../../agent-remote-hosted/src/transport.js';
import { codecState } from './storage-codec-fixture.js';

export function retentionState(auth: GatewayAuthOptions, recovery = false) {
  const state = codecState(auth), tenant = state.tenants[0]!, broker = tenant.broker;
  state.tenants = [tenant]; state.sessions = []; state.sessionMigrations = [];
  state.sessionStars = [{ subject: 'owner', hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'A', title: 'Saved source', starredAt: 1 }];
  state.favoritesTrees = []; state.sessionTitles = [];
  broker.associations!.admissions = []; broker.associations!.relationChanges = broker.associations!.relationChanges.filter(row => row.phase === 'committed');
  broker.associations!.freezes = broker.associations!.freezes.slice(0, 1);
  const row = broker.associations!.freezes[0]!;
  row.receipt = { ...row.receipt, version: 2, maxProjectionBytes: 65536 };
  delete row.released; delete row.projection; delete tenant.favoritesSuccession;
  broker.keys = [[createHash('sha256').update('arc_fixture').digest('hex'), { expires: Number.MAX_SAFE_INTEGER, installationId: 'installation', kind: 'device' }]];
  broker.bindings = []; broker.creations = []; broker.previews = [];
  const selection = { hostId: 'mapped-host', installationId: 'installation', revocationId: '00000000-0000-4000-8000-000000000001' };
  broker.revokedHosts = [{ ...selection, revokedAt: 1 }];
  broker.pairings = recovery ? [{ id: 'recovered', purpose: 'host-only', createdAt: 1, expiresAt: 100, usedAt: 2, hostId: 'mapped-host', hostName: 'Host', recovery: selection }] : [];
  return state;
}

/** Actual Broker consumer with a deterministic protocol peer; no native provider or credential disk. */
export function retentionPeer(relay: RelayState, auth: GatewayAuthOptions) {
  const initial = relay.read().tenants[0]!;
  let authorized = false, releases = 0, statuses = 0, issued = 0, registered = 0, creates = 0;
  const messages: any[] = [], sockets: RelaySocket[] = [];
  let active: { send(message: unknown): Promise<void>; socket: RelaySocket } | undefined;
  const broker = createHostBroker({ origin: auth.origin, ownerSubject: 'owner', durable: true, initialState: initial.broker,
    successionEnrollment: { version: 1, origin: auth.origin, issuer: auth.issuer, namespace: initial.namespace, ownerSubject: 'owner' },
    onStateChange: value => relay.mutate(draft => {
      draft.tenants[0]!.broker = value; projectSuccessionFavorites(draft, 'owner', authorized); pruneSessionTitles(draft);
    }) });
  async function connect(key = 'arc_fixture', metadata: Record<string, unknown> = {}) {
    const listeners = new Set<(data: string, binary: boolean) => void | Promise<void>>(), closers = new Set<() => void>();
    let readyState = 1;
    const send = async (message: unknown) => { if (readyState === 1) await Promise.all([...listeners].map(listener => listener(JSON.stringify(message), false))); };
    const socket: RelaySocket = {
      get readyState() { return readyState; }, bufferedAmount: 0,
      send(text) {
        const message = JSON.parse(text); messages.push(message);
        if (message.type === 'registered') { registered++; return; }
        if (message.type === 'credential_issued') { issued++; return; }
        if (message.type === 'heartbeat') { void send({ uplinkVersion: 2, type: 'heartbeat_ack', nonce: message.nonce }); return; }
        if (message.type !== 'rpc_request') return;
        if (message.path === '/remote/create') creates++;
        const input = JSON.parse(message.body ?? '{}');
        if (input.action === 'release') releases++; else statuses++;
        const projection = structuredClone(codecState(auth).tenants[0]!.broker.associations!.freezes[0]!.projection!);
        const result = { record: projection.receipt, role: projection.role, freeze: input.freeze };
        queueMicrotask(() => { void send({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: 200, body: JSON.stringify(result) }); });
      },
      close() { if (readyState !== 1) return; readyState = 3; for (const listener of closers) listener(); },
      onMessage(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      onClose(listener) { closers.add(listener); return () => { closers.delete(listener); }; }, onError() { return () => {}; },
    };
    const upgrade = await broker.prepareUpgrade(new Request(auth.origin + '/ws/remote-host?successionEnrollment=2', { headers: { authorization: 'Bearer ' + key } }));
    if (!upgrade || upgrade instanceof Response) throw new Error('Retention fixture authorization refused.');
    sockets.push(socket); active = { send, socket }; upgrade.accept(socket);
    await send({ uplinkVersion: 2, type: 'register', installationId: 'installation', name: 'Host', credentialRotation: true, providers: [{ providerId: 'fixture', displayName: 'Fixture' }], ...metadata });
  }
  const request = (path: string, body: unknown = {}) => broker.handleRequest(new Request(auth.origin + path, { method: 'POST', body: JSON.stringify(body) }), { principalSubject: () => 'owner' });
  return { broker, connect, messages, counts: () => ({ releases, statuses, issued, registered, creates }),
    terminal: () => request('/v1/remote/hosts/mapped-host/succession/reconcile', { operationId: 'op-2' }),
    admission: () => request('/v1/remote/hosts/mapped-host/create', { providerId: 'fixture', operationId: 'operating-refused', sourceNativeSessionId: 'B', conversationKind: 'ask' }),
    rotate: () => request('/v1/remote/hosts/mapped-host/rotate'),
    revoke: () => request('/v1/remote/hosts/mapped-host/revoke'),
    invitation: () => request('/v1/remote/pairings', { recoverHostId: 'mapped-host' }),
    acknowledge: () => active!.send({ uplinkVersion: 2, type: 'credential_saved' }),
    async apply() { authorized = true; await relay.mutate(draft => { projectSuccessionFavorites(draft, 'owner', true); pruneSessionTitles(draft); }); },
    close() { for (const socket of sockets) socket.close(); broker.close(); },
  };
}

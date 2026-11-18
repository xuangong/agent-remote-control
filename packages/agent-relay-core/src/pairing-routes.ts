import { JOURNAL_DELETION_LIMIT } from './state.js';
import { type HostRecoverySelection, type RevokedHost } from './host-recovery.js';
import { MAX_PAIRING_HISTORY, pairingStatus, visiblePairing, type SavedPairingKey } from './pairing-keys.js';
import { isPairingPurpose } from '@orchardworks/agent-remote-protocol';
import { HostSharing, SharingError } from './host-sharing.js';
import { createHostPreviews } from './host-previews.js';
import { createJournalSessions } from './journal-sessions.js';
import { required, readBody, type RouteGroup } from './request-input.js';
import { json, rawJson } from './http-replies.js';
import { BrokerError, type DeviceCredential, type Host, type HostBrokerOptions } from './broker-types.js';
import { type Access } from './access.js';
import { type BrokerState } from './broker-state.js';
import { type HostSession } from './host-session.js';
import { type RelayIds } from './relay-ids.js';
import { type JournalDeletion } from './journal-deletion.js';
import { type HostJournals } from './host-journals.js';
import { type HostViews } from './host-views.js';
import { type Expiry } from './credential-expiry.js';
import { type SessionBindings } from './session-bindings.js';

/**
 * Host listing, pairing keys, and a Host's lifecycle: rotate, stop, smart reading and revoke.
 *
 * Contract: `createPairingRoutes` returns one function that is given each request after the Relay's common checks (available, permitted,
 * mutation allowed) and the caller's subject. It answers a `Response` when the path is one of its routes and `undefined` when it is not,
 * so the next group is tried. A failure is thrown as `BrokerError` or `SharingError` and the Relay turns it into the HTTP answer.
 * - A pairing key is a temporary credential saved with its purpose and expiry; revoking a pairing or a Host saves the change before any connection is closed.
 * - Revoking a Host removes its keys, bindings, previews and sharing in one commit, records the identity for recovery when it must be retained, queues its journals for deletion, and only then closes its connection.
 *
 * Ports: access, brokerState, now, ids, rpc, disconnected, previews, deletion, journals, journalSessions, visibleHosts, credentialExpiry, accountBacked, keyHash, sessionBindings, options. It keeps no state of its own beyond what is said above.
 */
export interface PairingRoutesPorts {
  options: Pick<HostBrokerOptions, 'gatewaySetup' | 'keyLifetimeMs' | 'onPairing' | 'ownerSubject' | 'publicUrl' | 'successionEnrollment'>;
  access: Access;
  brokerState: BrokerState;
  now: () => number;
  ids: RelayIds;
  rpc: HostSession['rpc'];
  disconnected: HostSession['disconnected'];
  previews: ReturnType<typeof createHostPreviews>;
  deletion: JournalDeletion;
  journals: HostJournals | undefined;
  journalSessions: ReturnType<typeof createJournalSessions> | undefined;
  visibleHosts: HostViews['visibleHosts'];
  credentialExpiry: Expiry;
  accountBacked: boolean;
  keyHash: (key: string) => string;
  sessionBindings: SessionBindings;
}

export function createPairingRoutes(ports: PairingRoutesPorts): RouteGroup {
  const { access, brokerState, now, ids, rpc, disconnected, previews, deletion, journals, journalSessions, visibleHosts, credentialExpiry, accountBacked, keyHash, sessionBindings, options } = ports;
  const { owner, requireOwner, requireHost } = access;
  return async (request, context, url, subject) => {
    if (url.pathname === '/v1/remote/hosts' && request.method === 'GET') return json(200, { hosts: visibleHosts(subject) });
    if (url.pathname === '/v1/remote/pairings') {
      requireOwner(subject);
      if (request.method === 'GET') return json(200, { availablePurposes: accountBacked && options.gatewaySetup !== false ? ['host-only', 'gateway-setup'] : ['host-only'],
        pairings: [...brokerState.pairings].sort((a, b) => b.createdAt - a.createdAt).map(item => visiblePairing(item, now())) });
      if (request.method !== 'POST') return json(405, { error: 'Method is not allowed.' });
      const body = await readBody(request);
      const purpose = body.purpose ?? 'host-only';
      if (Object.keys(body).some(key => !['purpose', 'recoverHostId'].includes(key)) || !isPairingPurpose(purpose)) throw new BrokerError(400, 'invalid_request', 'Select a supported pairing purpose.');
      const recoverHostId = body.recoverHostId === undefined ? undefined : required(body.recoverHostId, 'recoverHostId');
      if (recoverHostId && (recoverHostId.length > 512 || purpose !== 'host-only' || !accountBacked || !options.ownerSubject || !options.successionEnrollment)) throw new BrokerError(400, 'host_recovery_unavailable', 'Recovery requires an authenticated owner and a retained succession identity.');
      if (options.gatewaySetup === false && purpose !== 'host-only') throw new BrokerError(403, 'unsupported_purpose', 'Gateway setup is unavailable for this authentication provider.');
      if (!accountBacked && purpose !== 'host-only') throw new BrokerError(400, 'unsupported_purpose', 'Gateway setup requires an account-backed Relay.');
      const key = `arc_${ids.token()}`;
      const createdAt = now(); const expires = createdAt + (options.keyLifetimeMs ?? (accountBacked ? 10 * 60 * 1000 : 24 * 60 * 60 * 1000));
      const item: SavedPairingKey = { id: ids.uuid(), purpose, createdAt, expiresAt: expires };
      await brokerState.commit(draft => {
        let recovery: HostRecoverySelection | undefined;
        if (recoverHostId) {
          const installationId = brokerState.retainedIdentities().get(recoverHostId);
          if (!installationId || brokerState.hosts.has(recoverHostId) || [...brokerState.hosts.values()].some(host => host.installationId === installationId)) throw new BrokerError(409, 'host_recovery_unavailable', 'The selected historical Host is unavailable for recovery.');
          let marker = draft.revokedHosts?.find(host => host.hostId === recoverHostId);
          if (!marker) {
            marker = { hostId: recoverHostId, installationId, revocationId: ids.uuid() };
            (draft.revokedHosts ??= []).push(marker);
          }
          recovery = { hostId: marker.hostId, installationId: marker.installationId, revocationId: marker.revocationId };
          item.recovery = recovery;
          draft.keys = draft.keys.filter(([, value]) => value.installationId !== installationId || value.recovery?.revocationId === marker.revocationId);
          if (draft.sharing) for (const grant of draft.sharing.grants) if (grant.hostId === recoverHostId) grant.revoked = true;
        }
        draft.keys = draft.keys.filter(([, value]) => value.expires > now());
        if (draft.keys.length >= 128) throw new BrokerError(429, 'capacity_exceeded', 'Too many active temporary keys.');
        if ((draft.pairings?.length ?? 0) >= MAX_PAIRING_HISTORY) throw new BrokerError(429, 'pairing_history_full', 'Delete old pairing key records before creating another key.');
        const credential: DeviceCredential = { expires, purpose, pairingId: item.id, ...(recovery ? { recovery, installationId: recovery.installationId } : {}), ...(accountBacked ? { requiresRotation: true } : {}) };
        draft.keys.push([keyHash(key), credential]);
        (draft.pairings ??= []).push(item);
        return { value: undefined, publish() {
          for (const hash of brokerState.keys.keys()) if (!draft.keys.some(([saved]) => saved === hash)) brokerState.keys.delete(hash);
          brokerState.pairings = draft.pairings!;
          brokerState.revokedHosts = draft.revokedHosts;
          brokerState.sharing = new HostSharing(draft.sharing, () => {});
          brokerState.keys.set(keyHash(key), credential); options.onPairing?.(key, expires);
        } };
      // No key or access removal is published, and no external grant effect occurs, before admission.
      }, true);
      return json(201, { ...visiblePairing(item, now()), key, serverUrl: options.publicUrl ?? context.serverUrl ?? new URL(request.url).origin,
        ...(accountBacked && options.publicUrl ? { command: `export AGENT_HOST_SERVER='${options.publicUrl.replaceAll("'", "'\\''")}'\nexport AGENT_HOST_REMOTE_KEY='${key}'\nagent-remote-controller start` } : {}) });
    }
    const pairingAction = /^\/v1\/remote\/pairings\/([^/]+)(\/revoke)?$/.exec(url.pathname);
    if (pairingAction) {
      requireOwner(subject);
      const revoke = pairingAction[2] === '/revoke';
      if (request.method !== (revoke ? 'POST' : 'DELETE')) return json(405, { error: 'Method is not allowed.' });
      const body = await readBody(request);
      if (Object.keys(body).length) throw new BrokerError(400, 'invalid_request', 'No pairing management parameters are accepted.');
      await brokerState.commit(draft => {
        const item = draft.pairings?.find(item => item.id === pairingAction[1]);
        if (!item) throw new BrokerError(404, 'pairing_not_found', 'Pairing key record is unavailable.');
        if (revoke && pairingStatus(item, now()) === 'used') throw new BrokerError(409, 'pairing_used', 'This key has been used. Manage the paired Host to revoke its access.');
        if (item.usedAt === undefined) draft.keys = draft.keys.filter(([, key]) => key.pairingId !== item.id);
        if (revoke) item.revokedAt ??= now();
        else draft.pairings = draft.pairings!.filter(value => value.id !== item.id);
        return { value: undefined, publish() {
          brokerState.pairings = draft.pairings ?? [];
          for (const hash of brokerState.keys.keys()) if (!draft.keys.some(([saved]) => saved === hash)) brokerState.keys.delete(hash);
          credentialExpiry.enforce();
        } };
      });
      return json(200, { ok: true });
    }
    const management = /^\/v1\/remote\/hosts\/([^/]+)\/(rotate|stop)$/.exec(url.pathname);
    if (management && request.method === 'POST') {
      requireOwner(subject);
      const body = await readBody(request);
      const host = requireHost(management[1]!);
      if (management[2] === 'rotate') {
        if (Object.keys(body).length) throw new BrokerError(400, 'invalid_request', 'No parameters are accepted.');
        if (!accountBacked || !host.issueCredential) throw new BrokerError(409, 'host_upgrade_required', 'Update and reconnect Agent Host before rotating its credential.');
        await host.issueCredential();
        return json(200, {ok:true,status:'pending'});
      }
      if (Object.keys(body).some(key => key !== 'operationId')) throw new BrokerError(400, 'invalid_request', 'Stop accepts only an operation identity.');
      const result = await rpc(host, 'POST', '/remote/stop', undefined, JSON.stringify({ operationId: required(body.operationId, 'operationId') }));
      return rawJson(result);
    }
    const reading = /^\/v1\/remote\/hosts\/([^/]+)\/smart-reading$/.exec(url.pathname);
    if (reading) {
      requireOwner(subject);
      const host = brokerState.hosts.get(reading[1]!);
      if (!host) throw new BrokerError(404, 'host_not_found', 'The Remote Host is unknown.');
      if (request.method === 'GET') return json(200, { providers: host.smartReading ?? [] });
      if (request.method !== 'PUT') return json(405, { error: 'Method is not allowed.' });
      if (!journals) throw new BrokerError(409, 'journals_unavailable', 'This Relay does not keep session journals.');
      const body = await readBody(request);
      if (Object.keys(body).some(key => key !== 'providerId' && key !== 'enabled') || typeof body.enabled !== 'boolean') {
        throw new BrokerError(400, 'invalid_request', 'Name a provider and whether smart reading is on for it.');
      }
      const providerId = required(body.providerId, 'providerId');
      const enabled = body.enabled;
      if (enabled && !host.smartReading?.includes(providerId) && (host.smartReading?.length ?? 0) >= 64) {
        throw new BrokerError(400, 'invalid_request', 'Smart reading names at most 64 providers per Host.');
      }
      const providers = await brokerState.commit(draft => {
        brokerState.assertHostCurrent(host);
        const saved = draft.hosts.find(value => value.id === host.id);
        if (!saved) throw new BrokerError(404, 'host_not_found', 'The Remote Host is unknown.');
        const next = new Set(saved.smartReading ?? []);
        if (enabled) next.add(providerId); else next.delete(providerId);
        if (next.size > 64) throw new BrokerError(400, 'invalid_request', 'Smart reading names at most 64 providers per Host.');
        const list = [...next].sort();
        if (list.length > 0) saved.smartReading = list; else delete saved.smartReading;
        return { value: list, publish() {
          host.smartReading = list.length > 0 ? list : undefined;
          if (!enabled) journalSessions?.stopReading(host.id, providerId);
        } };
      });
      return json(200, { providers });
    }
    const revoking = /^\/v1\/remote\/hosts\/([^/]+)\/revoke$/.exec(url.pathname);
    if (accountBacked && revoking && request.method === 'POST') {
      requireOwner(subject);
      await readBody(request);
      const host = brokerState.hosts.get(revoking[1]!);
      if (!host) throw new BrokerError(404, 'host_not_found', 'The Remote Host is unknown.');
      let droppedDeletion: string | undefined;
      await brokerState.commit(draft => {
        droppedDeletion = undefined;
        brokerState.assertHostCurrent(host);
        if (brokerState.retainedIdentities().get(host.id) === host.installationId) {
          const marker: RevokedHost = { hostId: host.id, installationId: host.installationId, revocationId: ids.uuid(), revokedAt: now() };
          draft.revokedHosts = [...(draft.revokedHosts ?? []).filter(item => item.hostId !== host.id), marker];
        }
        if (draft.sharing) for (const grant of draft.sharing.grants) if (grant.hostId === host.id) grant.revoked = true;
        for (const item of draft.pairings ?? []) if (item.recovery?.hostId === host.id && item.usedAt === undefined) item.revokedAt ??= now();
        draft.keys = draft.keys.filter(([, credential]) => credential.installationId !== host.installationId);
        draft.bindings = draft.bindings.filter(binding => binding.hostId !== host.id);
        draft.creations = draft.creations.filter(([, value]) => draft.bindings.some(binding => binding.agentId === value.agentId));
        draft.hosts = draft.hosts.filter(value => value.id !== host.id);
        if (journals) {
          const pending = (draft.journalDeletions ?? []).filter(id => id !== host.id);
          // A revoke always succeeds: when the list is full, the oldest pending deletion is dropped.
          if (pending.length >= JOURNAL_DELETION_LIMIT) droppedDeletion = pending.shift();
          draft.journalDeletions = [...pending, host.id];
        }
        draft.previews = (draft.previews ?? []).filter(value => value.hostId !== host.id);
        return { value: undefined, publish() {
          brokerState.revokedHosts = draft.revokedHosts;
          brokerState.pairings = draft.pairings ?? [];
          brokerState.sharing = new HostSharing(draft.sharing, () => {});
          for (const [key, credential] of brokerState.keys) if (credential.installationId === host.installationId) brokerState.keys.delete(key);
          sessionBindings.forgetHost(host.id);
          brokerState.hosts.delete(host.id);
          previews.forget(host.id);
          if (journals) {
            brokerState.journalDeletions = draft.journalDeletions ?? [];
            deletion.revoked(host.id, droppedDeletion);
          }
          if (host.socket) { const socket = host.socket; disconnected(host, socket, 'access_revoked', 1008); socket.close(1008, 'Device revoked'); }
        } };
      });
      return json(200, { ok: true });
    }
    return undefined;
  };
}

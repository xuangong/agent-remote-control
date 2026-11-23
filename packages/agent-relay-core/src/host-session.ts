import { TeamBroker } from './teams.js';
import { committed } from './drafts.js';
import { sessionIdentityMessage } from './session-identity.js';
import { JOURNAL_VERSION, decodeRemoteHostUplinkMessage, type RemoteHostUplinkMessage } from '@orchardworks/agent-remote-protocol';
import { isDeepStrictEqual } from 'node:util';
import { retainedRecoveryInstallations } from './host-recovery.js';
import { relayDiagnosticsForVersion, RELAY_DIAGNOSTIC_PATH, type RelayDiagnostic } from '@orchardworks/agent-remote-protocol/model';
import { BROKER_MAX_FRAME_BYTES, RELAY_SOCKET_OPEN, type BrokerRequestContext, type RelaySocket } from './transport.js';
import { createJournalConnection, isJournalHostMessage } from './journal-uplink.js';
import { diagnosticOperation, diagnosticCloseReason } from './host-diagnostics.js';
import { BrokerError, type DeviceCredential, type Host, type HostBrokerOptions, type RpcResponse } from './broker-types.js';
import { type BrokerState } from './broker-state.js';
import { type RelayIds } from './relay-ids.js';
import { type HostViews } from './host-views.js';
import { type Expiry } from './credential-expiry.js';
import { type JournalDeletion } from './journal-deletion.js';
import { type HostJournals } from './host-journals.js';
import { type createHostPreviews } from './host-previews.js';
import { type BrokerScheduler } from './transport.js';

/**
 * One Host's connection to the Relay: the registration handshake, the credential rotation that follows it, the heartbeat that keeps
 * it, the requests the Relay sends it and the answers it matches, and the way the connection ends.
 *
 * Contract:
 * - `register` takes the server end of an upgraded socket. Until the Host's `register` message is committed (its credential is
 *   claimed and its record saved) nothing else is accepted; a registration that does not arrive within the deadline, a message
 *   that does not decode, or a credential that was revoked or expired closes the socket (1008). The grants the Host asked for
 *   (`HostSessionGrants`) are acknowledged in `registered` only when the Relay can serve them.
 * - A Host has one live connection. A newer registration closes the older one (1012, `connection_replaced`) and bumps the Host's
 *   `generation`; every request that began on the older generation fails with `host_reconnected` instead of being answered.
 * - The heartbeat is a nonce the Relay sends every `intervalMs`; the Host must acknowledge the current nonce within `timeoutMs`,
 *   else the connection closes (1012, `heartbeat_timeout`). Acknowledgements of an old nonce do not count.
 * - `rpc` sends one request to the Controller and resolves with its answer, rejects `host_offline` when the connection ends first, and
 *   rejects 504 at its deadline after telling the Controller to cancel. A Host holds at most 128 pending requests (429).
 * - `disconnected` ends one connection exactly once: it rejects the pending requests, closes the Host's streams, closes the journal
 *   connection and the previews, and clears what only a connection holds (session states, tunnel token, grants).
 * - It owns the connection's live fields on the Host record and the timers of each connection; it saves records only through
 *   `BrokerState.commit`.
 *
 * Ports: the scheduler (every timer), the clock, `RelayIds` (nonces, request and connection ids, tokens), `BrokerState`, the
 * journal service and its deletion, the previews registry, the Team broker's Host calls, the outbox, diagnostics.
 */
export interface HostSessionGrants {
  enrollmentRequested?: 1 | 2 | 3;
  teamRequested?: boolean; resourcesRequested?: boolean; recipientsRequested?: boolean; inboxRequested?: boolean;
  statesRequested?: false | 1 | 2;
  successionRequested?: boolean;
  callForSupportRequested?: false | string[];
  /** The Host asked for tasks, naming the providers whose sessions can be coordinators (they take the task tools). */
  tasksRequested?: false | string[];
  statusRequested?: boolean; outboxRequested?: boolean;
  journalRequested?: 0 | typeof JOURNAL_VERSION;
  /** The Controller takes the sessions pages show (`journalShown=1`), with the journal grant. */
  shownRequested?: boolean;
  controlRequested?: boolean;
}

export interface HostSessionPorts {
  brokerState: BrokerState;
  options: Pick<HostBrokerOptions, 'diagnostics' | 'rpcTimeoutMs' | 'creationTimeoutMs' | 'registrationDeadlineMs' | 'successionEnrollment' | 'outbox' | 'journalDeletionWaitMs' | 'journalRequestTimeoutMs' | 'teamResources' | 'onSessionStates'>;
  accountBacked: boolean;
  heartbeat: { intervalMs: number; timeoutMs: number };
  now(): number;
  scheduler: BrokerScheduler;
  ids: RelayIds;
  journals: HostJournals | undefined;
  /** A Host's journal accepted a publication; the served sessions follow it. */
  journalPublished: (hostId: string, sessionKey: string, result: Parameters<NonNullable<Parameters<typeof createJournalConnection>[0]['published']>>[1]) => void;
  /** A Host finished registering on a connection; what the Relay tells a new connection follows. */
  hostReady?(host: Host): void;
  deletion: JournalDeletion;
  previews: ReturnType<typeof createHostPreviews>;
  teams: Pick<TeamBroker, 'hostCall'>;
  views: Pick<HostViews, 'receiveSessionStates'>;
  expiry: Expiry;
  keyHash(key: string): string;
}

export type HostSession = ReturnType<typeof createHostSession>;

export function createHostSession(ports: HostSessionPorts) {
  const { brokerState, options, accountBacked, heartbeat, now, scheduler, ids, journals, journalPublished, deletion, previews, teams, views, expiry, keyHash, hostReady } = ports;
  const { receiveSessionStates } = views;
  const setTimeout = scheduler.setTimeout.bind(scheduler);
  const clearTimeout = scheduler.clearTimeout.bind(scheduler);
  const uplinkCleanups = new Map<RelaySocket, () => void>();
  function notifySessionStates() {
    try { options.onSessionStates?.(); } catch { /* Sharing states never affects the Host connection. */ }
  }
  function send(host: Host, message: RemoteHostUplinkMessage) {
    brokerState.assertHostCurrent(host);
    if (host.socket?.readyState !== RELAY_SOCKET_OPEN) throw new BrokerError(503, 'host_offline', 'The Remote Host is offline.', true);
    if (host.socket.bufferedAmount !== undefined && host.socket.bufferedAmount > BROKER_MAX_FRAME_BYTES) throw new BrokerError(503, 'host_backpressure', 'The Remote Host connection is busy.', true);
    host.socket.send(JSON.stringify(message));
  }
  function diagnostic(host: Host, details: Omit<RelayDiagnostic, 'id' | 'timestamp' | 'source' | 'hostId' | 'relayInstanceId'>) {
    options.diagnostics?.record(host.id, { ...details, connectionId: host.connectionId });
  }
  function rpc(host: Host, method: 'GET' | 'POST', path: string, sessionId?: string, body?: string, diagnosticRequest = false): Promise<RpcResponse> {
    brokerState.assertHostCurrent(host);
    const generation = host.generation;
    if (host.pending.size >= 128) return Promise.reject(new BrokerError(429, 'host_busy', 'Too many pending Remote Host requests.', true));
    const requestId = ids.uuid(), startedAt = now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        host.pending.delete(requestId);
        if (!diagnosticRequest) diagnostic(host, {event:'rpc_timeout', requestId, operation: diagnosticOperation(path), durationMs: Math.max(0, now()-startedAt)});
        try { send(host, { uplinkVersion: 2, type: 'rpc_cancel', requestId }); } catch { /* An offline host has no request to cancel. */ }
        const attach = path === '/remote/attach' || path === '/remote/child/attach';
        reject(new BrokerError(504, attach ? 'session_attach_timeout' : method === 'GET' ? 'host_read_timeout' : 'host_timeout', attach
          ? 'The Host did not confirm opening the session before the Relay deadline. It may still be opening; wait briefly and reopen the same session.'
          : method === 'GET' ? 'The Host did not return the requested data before the Relay deadline. Try reading it again.'
          : 'The Host did not confirm the operation before the Relay deadline. Its outcome is unknown; check the session before retrying.', false, requestId));
      }, diagnosticRequest ? 5000 : path === '/remote/create' ? options.creationTimeoutMs ?? 180_000
        : options.rpcTimeoutMs ?? (path === '/remote/provider-settings' ? 45000 : 30000));
      host.pending.set(requestId, { resolve(value) {
        try { brokerState.assertHostCurrent(host, generation); resolve(value); } catch (error) { reject(error as Error); }
      }, reject, timer, method, path, diagnostic: diagnosticRequest, startedAt });
      try { send(host, { uplinkVersion: 2, type: 'rpc_request', requestId, method, path, ...(sessionId ? { sessionId } : {}), ...(body === undefined ? {} : { body }) }); }
      catch (error) { clearTimeout(timer); host.pending.delete(requestId); if (!diagnosticRequest) diagnostic(host, {event:'rpc_failed',requestId,operation:diagnosticOperation(path),reason:error instanceof BrokerError && error.code==='host_backpressure'?'host_backpressure':'write_failed'}); reject(error); }
    });
  }
  function disconnected(host: Host, socket: RelaySocket, reason: RelayDiagnostic['reason'] = 'socket_closed', closeCode?: number, heartbeatAgeMs?: number, wasClean?: boolean) {
    uplinkCleanups.get(socket)?.();
    if (host.socket !== socket) return;
    host.stopDiagnostics?.(); host.stopDiagnostics=undefined;
    diagnostic(host, {event:'host_disconnected',reason,closeCode,heartbeatAgeMs,wasClean,pendingRequests:[...host.pending.values()].filter(p=>!p.diagnostic).length,streams:host.streams.size});
    previews.disconnect(host.id); host.tunnelToken = undefined;
    host.socket = undefined; host.ready = false; host.sessionStates = undefined;
    host.journal?.close(); host.journal = undefined; host.journalShown = undefined; host.control = undefined;
    notifySessionStates();
    for (const [requestId, pending] of host.pending) {
      clearTimeout(pending.timer);
      const attach = pending.path === '/remote/attach' || pending.path === '/remote/child/attach';
      pending.reject(new BrokerError(503, 'host_offline', attach
        ? 'The Host disconnected while opening the session. Wait for it to reconnect, then reopen the same session.'
        : pending.method === 'GET' ? 'The Host disconnected while reading data. Wait for it to reconnect and try again.'
        : 'The Host disconnected before confirming the operation. Its outcome is unknown; check the session before retrying.', false, requestId));
    }
    host.pending.clear();
    for (const stream of host.streams.values()) {
      clearTimeout(stream.timer);
      stream.socket.close(reason === 'access_revoked' ? 1008 : 1012, reason === 'access_revoked' ? 'Host access revoked' : 'Remote Host disconnected');
    }
    host.streams.clear();
  }
  function register(socket: RelaySocket, credential: DeviceCredential, context: BrokerRequestContext, credentialHash: string, grants: HostSessionGrants) {
    const { enrollmentRequested, teamRequested = false, resourcesRequested = false, recipientsRequested = false, inboxRequested = false, statesRequested = false, successionRequested = false, callForSupportRequested = false, tasksRequested = false, statusRequested = false, outboxRequested = false, journalRequested = 0, shownRequested = false, controlRequested = false } = grants;
    let host: Host | undefined;
    let pendingCredential: {hash: string; value: DeviceCredential} | undefined;
    let issuing: Promise<void> | undefined;
    let retired = false, heartbeatStarted = false;
    let timer: unknown, heartbeatTimer: unknown, heartbeatDeadline: unknown;
    let pendingNonce: string | undefined;
    let lastHeartbeatAck = now();
    let cancelExpiry = () => {};
    function cleanup() {
      retired = true;
      clearTimeout(timer); clearTimeout(heartbeatTimer); clearTimeout(heartbeatDeadline);
      pendingNonce = undefined; cancelExpiry(); uplinkCleanups.delete(socket);
    }
    function closeConnection(code: number, reason: string) {
      if (retired) return;
      cleanup(); if (host) disconnected(host, socket, diagnosticCloseReason(reason), code, Math.max(0,now()-lastHeartbeatAck));
      socket.close(code, reason);
    }
    uplinkCleanups.set(socket, cleanup);
    cancelExpiry = expiry.expire(socket, () => brokerState.keys.get(credentialHash) === credential ? Math.min(credential.expires, context.connectionExpiresAt?.() ?? credential.expires) : 0, () => brokerState.keys.get(credentialHash) !== credential ? 1008 : context.connectionExpiryCode?.() ?? 1008, code => closeConnection(code, 'Credential expired'));
    if (!retired) timer = setTimeout(() => closeConnection(1008, 'Registration deadline exceeded'), options.registrationDeadlineMs ?? 10_000);
    socket.onError(() => closeConnection(1011, 'Host transport failed'));
    socket.onClose(details => { cleanup(); if (host) disconnected(host, socket, 'socket_closed', details?.code, Math.max(0, now() - lastHeartbeatAck), details?.wasClean); });
    const current = () => !retired && host?.socket === socket && host.ready === true;
    function sendHeartbeat() {
      if (!current()) return;
      const nonce = ids.uuid(); pendingNonce = nonce;
      heartbeatDeadline = setTimeout(() => {
        if (current() && pendingNonce === nonce) closeConnection(1012, 'Host heartbeat timed out');
      }, heartbeat.timeoutMs);
      heartbeatTimer = setTimeout(sendHeartbeat, heartbeat.intervalMs);
      try { send(host!, { uplinkVersion: 2, type: 'heartbeat', nonce }); }
      catch { closeConnection(1012, 'Host heartbeat delivery failed'); }
    }
    let pendingDeletionHandled = false;
    function registered() {
      if (retired || !host || host.socket !== socket) return;
      if (!pendingDeletionHandled && journals && journalRequested && brokerState.journalDeletions.includes(host.id)) {
        // A Host that returns with the id of a revoked Host waits for that id's deletion only, and only for a while: after the
        // deadline it is registered without journals and the id stays pending.
        pendingDeletionHandled = true;
        const ownId = host.id;
        let resumed = false;
        const resume = () => { if (resumed) return; resumed = true; clearTimeout(timer); registered(); };
        const timer = setTimeout(resume, options.journalDeletionWaitMs ?? 5000);
        void deletion.deleteOne(ownId).then(resume);
        return;
      }
      host.tunnelToken ??= ids.token();
      const journalHost = host;
      host.journal ??= journalRequested && journals && !brokerState.journalDeletions.includes(host.id)
        ? createJournalConnection({ hostId: host.id, journals, current, scheduler, requestTimeoutMs: options.journalRequestTimeoutMs,
          send: message => send(journalHost, message), diagnostic: (event, details) => diagnostic(journalHost, { event, ...details }),
          published: (sessionKey, result) => journalPublished(journalHost.id, sessionKey, result) })
        : undefined;
      send(host, { uplinkVersion: 2, type: 'registered', ...(statesRequested ? { sessionStates: statesRequested } : {}), ...(host.outbox === 1 ? { outbox: 1 as const } : {}), ...(controlRequested ? { control: 1 as const } : {}), ...(host.journal ? { journal: JOURNAL_VERSION } : {}), ...(host.teamRecipients === 1 && inboxRequested ? { teamInbox: 1 } : {}), ...(host.teamRecipients === 1 ? { teamRecipients: 1 } : {}), ...(host.teamSuccession === 1 ? { teamSuccession: 1 } : {}), ...(host.callForSupport === 1 ? { callForSupport: 1 } : {}), ...(host.tasks === 1 ? { tasks: 1 as const } : {}), ...(host.teamManagement && resourcesRequested && options.teamResources ? {teamResources:true} : {}), ...(host.teamManagement ? {teamManagement: true} : {}), hostId: host.id, ...(host.successionEnrollmentVersion && options.successionEnrollment ? { successionEnrollment: options.successionEnrollment, ...(host.successionEnrollmentVersion !== 1 ? { successionEnrollmentVersion: host.successionEnrollmentVersion } : {}) } : {}), pairingPurpose: host.pairingPurpose ?? (host.gatewayKeyRequested ? 'gateway-setup' : 'host-only'), heartbeat, tunnelToken: host.tunnelToken });
      if (retired || host.socket !== socket) return;
      host.ready = true;
      host.control = controlRequested ? true : undefined;
      host.journalShown = shownRequested && host.journal ? true : undefined;
      if (brokerState.journalDeletions.length > 0) deletion.drain();
      host.hostStatus = statusRequested ? true : undefined;
      if (statesRequested) host.sessionStates ??= { states: new Map() };
      notifySessionStates();
      try { hostReady?.(host); } catch { /* What follows a registration never fails it. */ }
      if (!heartbeatStarted) {
        heartbeatStarted = true; lastHeartbeatAck = now(); heartbeatTimer = setTimeout(sendHeartbeat, heartbeat.intervalMs);
        diagnostic(host, {event:'host_registered'});
        const connectedHost = host;
        let diagnosticVersion: number | undefined;
        const canDeliverDiagnostics = () => !retired && connectedHost.socket === socket && connectedHost.pending.size <= 16
          && (socket.bufferedAmount === undefined || socket.bufferedAmount === 0);
        host.stopDiagnostics = options.diagnostics?.connect(host.id, async entries => {
          if (!canDeliverDiagnostics()) return {status:503};
          if (diagnosticVersion === undefined) {
            const result = await rpc(connectedHost, 'GET', '/remote/controller-update', undefined, undefined, true);
            // Diagnostics can remain available when the independent updater status fails.
            try { const version = JSON.parse(result.body).diagnosticDelivery; if (Number.isSafeInteger(version) && version >= 1) diagnosticVersion = version; } catch { /* No capability advertised. */ }
            if (diagnosticVersion === undefined) {
              if (result.status === 404 || result.status === 200) diagnosticVersion = 0;
              else return result;
            }
          }
          if (!diagnosticVersion) return {status:404};
          if (!canDeliverDiagnostics()) return {status:503};
          const compatible = relayDiagnosticsForVersion(entries, diagnosticVersion);
          if (!compatible.length) return { status: 204 };
          return rpc(connectedHost, 'POST', RELAY_DIAGNOSTIC_PATH, undefined, JSON.stringify({ entries: compatible }), true);
        });
      }
    }
    let registration: Promise<void> | undefined;
    socket.onMessage((raw, binary) => {
      return receive(raw, binary).catch(() => closeConnection(1011, 'Host message could not be processed'));
    });
    async function receive(raw: string, binary: boolean) {
      if (registration) await registration;
      if (retired) return;
      try {
      brokerState.assertAvailable();
      if (socket.readyState !== RELAY_SOCKET_OPEN || brokerState.keys.get(credentialHash) !== credential) return closeConnection(1008, 'Device credential revoked');
      if (context.connectionExpiresAt && Math.min(credential.expires, context.connectionExpiresAt() ?? credential.expires) <= now()) return closeConnection(credential.expires <= now() ? 1008 : (context.connectionExpiryCode?.() ?? 1008), 'Credential expired');
      const decoded = binary ? undefined : decodeRemoteHostUplinkMessage(raw.toString());
      if (!decoded || decoded.status !== 'ok') return closeConnection(1008, 'Invalid uplink envelope');
      const message = decoded.value;
      if (!host) {
        if (message.type !== 'register' || credential.claimedAt !== undefined || credential.expires <= now() || (credential.installationId && credential.installationId !== message.installationId)) return closeConnection(1008, 'Registration is not authorized');
        const invitation = credential.requiresRotation === true || credential.installationId === undefined;
        if (credential.requiresRotation && !message.credentialRotation) return closeConnection(1008, 'Update Agent Host to enroll this device');
        registration = brokerState.commit(draft => {
          if (brokerState.keys.get(credentialHash) !== credential || credential.claimedAt !== undefined || credential.expires <= now() || (credential.installationId && credential.installationId !== message.installationId)) throw new BrokerError(401, 'device_revoked', 'Registration is not authorized');
          const savedCredential = draft.keys.find(([hash]) => hash === credentialHash)![1];
          savedCredential.installationId = message.installationId;
          if (accountBacked && invitation) savedCredential.claimedAt = now();
          if (accountBacked) {
            if (!savedCredential.requiresRotation) savedCredential.expires = Number.MAX_SAFE_INTEGER;
            // Reconnection proves possession of this key, not which overlapping recovery key was saved.
            const retainOverlap = credential.kind === 'device' && retainedRecoveryInstallations(draft).has(message.installationId);
            if (!retainOverlap) draft.keys = draft.keys.filter(([hash, key]) => hash === credentialHash || key.installationId !== message.installationId);
          }
          const existing = [...brokerState.hosts.values()].find(value => value.installationId === message.installationId);
          const historical = [...brokerState.retainedIdentities()].find(([, installationId]) => installationId === message.installationId);
          const recovery = credential.recovery;
          if (recovery) {
            const marker = brokerState.revokedHosts?.find(item => item.hostId === recovery.hostId);
            if (existing || !marker || marker.installationId !== message.installationId || marker.revocationId !== recovery.revocationId
              || brokerState.hosts.has(recovery.hostId)) throw new BrokerError(401, 'host_recovery_changed', 'This recovery invitation no longer authorizes the selected Host.');
          } else if (!existing && historical) throw new BrokerError(401, 'host_recovery_required', 'Create a recovery pairing for the retained Host identity.');
          if (!existing && brokerState.hosts.size >= 128) throw new BrokerError(429, 'host_capacity', 'Host capacity reached');
          const purpose = existing
            ? existing.pairingPurpose ?? (existing.gatewayKeyRequested ? 'gateway-setup' : 'host-only')
            : credential.purpose ?? 'host-only';
          const providers = 'providers' in message ? [...message.providers] : [{ providerId: 'dsh', displayName: 'DeepSeek DSH' }];
          const next = { id: existing?.id ?? recovery?.hostId ?? ids.uuid(), installationId: message.installationId, name: message.name, environment: message.environment, controller: message.controller, providerManagement: message.providerManagement, tpmManagement: message.tpmManagement, teamManagement: teamRequested ? true as const : undefined, teamRecipients: teamRequested && recipientsRequested ? 1 as const : undefined, teamSuccession: teamRequested && recipientsRequested && successionRequested ? 1 as const : undefined, callForSupport: teamRequested && recipientsRequested && successionRequested && callForSupportRequested ? 1 as const : undefined,
            tasks: teamRequested && recipientsRequested && successionRequested && callForSupportRequested && tasksRequested ? 1 as const : undefined,
            readOnlyProviders: teamRequested && recipientsRequested && successionRequested && callForSupportRequested ? callForSupportRequested : undefined, pairingPurpose: purpose,
            coordinatorProviders: teamRequested && recipientsRequested && successionRequested && callForSupportRequested && tasksRequested ? tasksRequested : undefined,
            outbox: outboxRequested && options.outbox ? 1 as const : undefined,
            ...(existing?.gatewayKeyRequested ? { gatewayKeyRequested: true } : {}),
            ...(existing?.smartReading ? { smartReading: existing.smartReading } : {}),
            providers, legacyDsh: 'providerId' in message, ...(message.credentialRotation ? {credentialRotation:true} : {credentialRotation:undefined}) };
          draft.hosts = draft.hosts.filter(value => value.id !== next.id); draft.hosts.push(next);
          const pairing = draft.pairings?.find(value => value.id === credential.pairingId);
          if (pairing && pairing.usedAt === undefined) {
            pairing.usedAt = now(); pairing.hostId = next.id; pairing.hostName = next.name;
          }
          if (recovery) for (const item of draft.pairings ?? []) {
            if (item.recovery?.hostId === recovery.hostId && item.usedAt === undefined) item.revokedAt ??= now();
          }
          return { value: undefined, publish() {
            Object.assign(credential, savedCredential);
            brokerState.pairings = draft.pairings ?? [];
            for (const hash of brokerState.keys.keys()) if (!draft.keys.some(([saved]) => saved === hash)) brokerState.keys.delete(hash);
            host = existing ?? { ...next, generation: 0, pending: new Map(), streams: new Map() };
            brokerState.hosts.set(host.id, host);
            if (host.socket) { const previous = host.socket; disconnected(host, previous, 'connection_replaced', 1012); previous.close(1012, 'Host connection replaced'); }
            Object.assign(host, next); host.successionEnrollmentVersion = options.successionEnrollment ? enrollmentRequested : undefined; host.connectionId=ids.uuid(); host.generation += 1; clearTimeout(timer);
            if (!retired && socket.readyState === RELAY_SOCKET_OPEN) {
              host.socket = socket;
              host.issueCredential = message.credentialRotation ? () => issueCredential(false, true) : undefined;
              if (!accountBacked || !message.credentialRotation || credential.kind === 'device') {
                registered();
              }
            }
          } };
        });
        try { await registration; } finally { registration = undefined; }
        if (accountBacked && message.credentialRotation && credential.kind !== 'device') await issueCredential(invitation);
        return;
      }
      if (host.socket !== socket) return;
      if (message.type === 'credential_saved') {
        if (!pendingCredential) return closeConnection(1008, 'No pending device credential');
        const pending = pendingCredential, currentHost = host, generation = host.generation;
        await brokerState.commit(draft => {
          brokerState.assertHostCurrent(currentHost, generation);
          if (retired || currentHost.socket !== socket || brokerState.keys.get(credentialHash) !== credential || pendingCredential !== pending
            || !draft.keys.some(([hash, key]) => hash === pending.hash && isDeepStrictEqual(key, pending.value)
              && key.installationId === currentHost.installationId)) throw new BrokerError(401, 'device_revoked', 'Device credential is unavailable.');
          draft.keys = draft.keys.filter(([hash, value]) => value.installationId !== host!.installationId || hash === pending.hash);
          return {value:undefined,publish() {
            for (const [hash,value] of brokerState.keys) if (value.installationId === host!.installationId && hash !== pending.hash) brokerState.keys.delete(hash);
            credentialHash = pending.hash; credential = brokerState.keys.get(pending.hash)!; pendingCredential = undefined;
          }};
        });
        registered();
      } else if (message.type === 'heartbeat_ack') {
        if (pendingNonce === message.nonce) { clearTimeout(heartbeatDeadline); pendingNonce = undefined; lastHeartbeatAck=now(); }
      } else if (message.type === 'outbox_request') {
        if (host.outbox !== 1 || !options.outbox) return closeConnection(1008, 'The outbox was not acknowledged');
        const current = host, generation = host.generation;
        void (async () => {
          let status = 200, body: string;
          try { brokerState.assertHostCurrent(current, generation); body = JSON.stringify(await options.outbox!.hostCall(current.id, message.call)); }
          catch (error) {
            const known = error as { status?: unknown; code?: unknown };
            status = typeof known.status === 'number' && known.status >= 400 && known.status < 500 ? known.status : 409;
            body = JSON.stringify({ ...(typeof known.code === 'string' ? { code: known.code } : {}), error: error instanceof Error ? error.message : 'Outbox request failed.' });
          }
          if (current.socket === socket && current.generation === generation) send(current, { uplinkVersion: 2, type: 'outbox_response', requestId: message.requestId, status, body });
        })().catch(() => closeConnection(1011, 'Outbox response delivery failed'));
      } else if (message.type === 'team_request') {
        const current = host, generation = host.generation;
        void (async () => {
          let status = 200, body: string;
          try { brokerState.assertHostCurrent(current, generation); body = JSON.stringify(await teams.hostCall(current.id, message.call, () => brokerState.assertHostCurrent(current, generation), current.teamRecipients === 1)); }
          catch (error) { status = 409; body = JSON.stringify({ error: error instanceof Error ? error.message : 'Team request failed.' }); }
          if (current.socket === socket && current.generation === generation) send(current, { uplinkVersion: 2, type: 'team_response', requestId: message.requestId, status, body });
        })().catch(() => closeConnection(1011, 'Team response delivery failed'));
      } else if (message.type === 'rpc_response') {
        const pending = host.pending.get(message.requestId);
        if (pending) { clearTimeout(pending.timer); host.pending.delete(message.requestId); if (!pending.diagnostic && message.status>=400) diagnostic(host, {event:'rpc_failed',requestId:message.requestId,operation:diagnosticOperation(pending.path),status:message.status,durationMs:Math.max(0,now()-pending.startedAt)}); pending.resolve(message); }
      } else if (message.type === 'stream_opened') {
        const stream = host.streams.get(message.streamId);
        if (stream && stream.socket.readyState === RELAY_SOCKET_OPEN && stream.authorized?.() !== false) { clearTimeout(stream.timer); if(!stream.ready)diagnostic(host,{event:'stream_ready',streamId:message.streamId}); stream.ready = true; for (const buffered of stream.buffered) send(host, { uplinkVersion: 2, type: 'stream_message', streamId: message.streamId, message: buffered }); stream.buffered = []; stream.onReady?.(); }
      } else if (message.type === 'stream_message') {
        const stream = host.streams.get(message.streamId);
        if (stream?.socket.readyState === RELAY_SOCKET_OPEN && stream.authorized?.() !== false) {
          if (stream.socket.bufferedAmount !== undefined && stream.socket.bufferedAmount > BROKER_MAX_FRAME_BYTES) stream.socket.close(1013, 'Slow browser connection');
          else {
            try {
              const frame = sessionIdentityMessage(message.message, stream.runtimeAgentId, stream.publicAgentId, 'server');
              if (stream.control) stream.control.controllerFrame(frame, forwarded => stream.socket.send(forwarded)); else stream.socket.send(frame);
            } catch { stream.socket.close(1008, 'Invalid Remote Host session identity'); }
          }
        }
      } else if (message.type === 'stream_close') {
        const stream = host.streams.get(message.streamId); host.streams.delete(message.streamId); if(stream)diagnostic(host,{event:'stream_closed',streamId:message.streamId,closeCode:message.code}); stream?.socket.close(message.code, message.reason);
      } else if (message.type === 'provider_snapshot') {
        if (!host.providerManagement) return closeConnection(1008, 'Provider management was not advertised');
        const currentHost = host;
        await brokerState.commit(draft => {
          if (currentHost.socket !== socket) throw new BrokerError(409, 'host_replaced', 'Host connection changed.');
          const saved = draft.hosts.find(value => value.id === currentHost.id);
          if (!saved) throw new BrokerError(404, 'host_unavailable', 'Host is unavailable.');
          saved.providers = [...message.providers];
          return { value: undefined, publish() { if (currentHost.socket === socket) currentHost.providers = [...message.providers]; } };
        });
      } else if (message.type === 'preview_snapshot') {
        await previews.update(host.id, message.snapshot);
      } else if (message.type === 'session_states') {
        if (!host.sessionStates) return closeConnection(1008, 'Session states were not acknowledged');
        receiveSessionStates(host.sessionStates, message);
        notifySessionStates();
      } else if (isJournalHostMessage(message)) {
        if (!host.journal) return closeConnection(1008, 'Journals were not acknowledged');
        try { await host.journal.receive(message); }
        catch (error) { if (!(error instanceof BrokerError)) diagnostic(host, { event: 'journal_store_failed' }); throw error; }
      } else closeConnection(1008, 'Unexpected uplink message');
      } catch (error) {
        const code = error instanceof BrokerError && error.status === 401 ? 1008 : error instanceof BrokerError && error.status === 429 ? 1013 : 1011;
        closeConnection(code, code === 1011 ? 'Host message could not be processed' : (error as Error).message);
      }
    }
    async function issueCredential(consumeInvitation: boolean, preEffect = false): Promise<void> {
      if (issuing) return issuing;
      if (pendingCredential) throw new BrokerError(409, 'rotation_pending', 'A device credential is awaiting confirmation.');
      const value = `arc_device_${ids.token()}`;
      const nextHash = keyHash(value);
      const currentHost = host, generation = host?.generation;
      const operation = brokerState.commit(draft => {
        if (!currentHost || retired || currentHost.socket !== socket || brokerState.keys.get(credentialHash) !== credential) throw new BrokerError(401, 'device_revoked', 'Device is no longer connected.');
        brokerState.assertHostCurrent(currentHost, generation);
        if (!consumeInvitation && retainedRecoveryInstallations(draft).has(currentHost.installationId)
          && draft.keys.filter(([, key]) => key.installationId === currentHost.installationId && key.kind === 'device').length > 1) {
          throw new BrokerError(409, 'rotation_pending', 'Retained recovery credentials require explicit reconciliation.');
        }
        if (draft.keys.length >= 128 && !consumeInvitation) throw new BrokerError(429, 'capacity_exceeded', 'Too many device credentials.');
        const next: DeviceCredential = {expires:Number.MAX_SAFE_INTEGER,installationId:currentHost.installationId,kind:'device'};
        if (consumeInvitation) draft.keys = draft.keys.filter(([hash]) => hash !== credentialHash);
        draft.keys.push([nextHash,next]);
        return {value:undefined,publish() {
          brokerState.keys.set(nextHash,next); pendingCredential = {hash:nextHash,value:next};
          if (consumeInvitation) {brokerState.keys.delete(credentialHash);credentialHash=nextHash;credential=next;}
        }};
      // A requested rotation has produced no new usable authorization before this commit.
      // Invitation consumption follows registration and retains terminal fail-closed handling.
      }, preEffect).then(() => {
        if (!currentHost || retired || currentHost.socket !== socket || pendingCredential?.hash !== nextHash || !brokerState.keys.has(nextHash)) return;
        brokerState.assertHostCurrent(currentHost, generation);
        send(currentHost, {uplinkVersion:2,type:'credential_issued',credential:value});
      });
      issuing=operation;
      try {await operation;} finally {issuing=undefined;}
    }
  }

  return {
    register, rpc, send, diagnostic, disconnected, notifySessionStates,
    /** Ends every connection's timers and, with `reason` and `code`, the connections themselves. */
    closeAll(reason: RelayDiagnostic['reason'], code: number) {
      for (const cleanup of [...uplinkCleanups.values()]) cleanup();
      for (const host of brokerState.hosts.values()) if (host.socket) disconnected(host, host.socket, reason, code);
    },
    stopTimers() { for (const cleanup of [...uplinkCleanups.values()]) cleanup(); },
  };
}

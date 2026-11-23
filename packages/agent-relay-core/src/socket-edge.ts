/**
 * Where a WebSocket upgrade becomes something: a Controller uplink, or a browser session stream.
 *
 * Contract. `upgrade(request, context, url)` returns `undefined`-free outcomes only: a `{ accept(socket) }` that takes the socket, or a
 * `Response` that refuses the upgrade (401 for a Controller key that is unknown, expired or already claimed; 403 for a session the
 * caller may not see, a request without this Relay's origin or a failed `authorize`; the error's own status and code for a Host refusal
 * such as native ownership; 503 for an unknown failure; 429 `session_stream_capacity` when the Host or the account is full). A Host with a
 * journal head for the session serves it from the journal (`acceptJournalServed`), whether or not the Host is online; a journal store that
 * cannot be read falls back to the Controller path and writes a `journal_store_failed` diagnostic. `accept` closes the socket instead of
 * serving it when access was withdrawn after the upgrade was prepared (1008), the Host is full (1013) or smart reading was turned off
 * (1012). Every stream is tracked, expires with its credential, and passes `admitClientMessages` before any message is acted on.
 */
import { JOURNAL_VERSION } from '@orchardworks/agent-remote-protocol';
import type { NativeSessionOwner } from '@orchardworks/agent-remote-protocol';
import type { Access } from './access.js';
import type { BrokerState } from './broker-state.js';
import { BrokerError, type Binding, type Host, type HostBrokerOptions } from './broker-types.js';
import type { createClientAdmission } from './client-admission.js';
import type { createExpiry } from './credential-expiry.js';
import type { HostSession } from './host-session.js';
import { json, rejectUpgrade, USER_STREAM_LIMIT, capacityRefusal } from './http-replies.js';
import { createHostStreamOpener } from './journal-host-stream.js';
import type { createJournalSessions } from './journal-sessions.js';
import { journalSessionKey } from './journal-sessions.js';
import { principal, namedProviders } from './request-input.js';
import type { RelayIds } from './relay-ids.js';
import type { SessionBindings } from './session-bindings.js';
import { createStreamControl } from './stream-control.js';
import { RELAY_SOCKET_OPEN, type BrokerRequestContext, type BrokerScheduler, type RelaySocket } from './transport.js';
import { sessionIdentityMessage, withoutItemKeysFlag } from './session-identity.js';

export interface SocketEdgePorts {
  brokerState: BrokerState;
  options: HostBrokerOptions;
  now: () => number;
  ids: RelayIds;
  scheduler: BrokerScheduler;
  origin: string;
  hostStreamLimit: number;
  sessionAllowed: Access['sessionAllowed'];
  requireHost: Access['requireHost'];
  permitted(context: BrokerRequestContext): Promise<boolean>;
  keyHash(key: string): string;
  track(client: RelaySocket): void;
  credentialExpiry: ReturnType<typeof createExpiry>;
  register: HostSession['register'];
  send: HostSession['send'];
  diagnostic: HostSession['diagnostic'];
  /** Absent when the Relay keeps no journals. */
  journalSessions: ReturnType<typeof createJournalSessions> | undefined;
  runtimeAgentId: SessionBindings['runtimeAgentId'];
  recoverBinding: SessionBindings['recoverBinding'];
  nativeRefusal: SessionBindings['nativeRefusal'];
  activeStreamCount(subject: string): number;
  admitClientMessages: ReturnType<typeof createClientAdmission>;
}

export function createSocketEdge(ports: SocketEdgePorts) {
  const { brokerState, options, now, ids, scheduler, origin, hostStreamLimit, sessionAllowed, requireHost, permitted, keyHash, track, credentialExpiry,
    register, send, diagnostic, journalSessions, runtimeAgentId, recoverBinding, nativeRefusal, activeStreamCount, admitClientMessages } = ports;
  const setTimeout = scheduler.setTimeout.bind(scheduler);
  const clearTimeout = scheduler.clearTimeout.bind(scheduler);
  /**
   * Makes the Controller know the session before a stream opens. A Host whose uplink was replaced while the attach was in
   * flight rejects the attach as offline although it is connected again; that is retryable, not a wait for the Host.
   */
  async function recoverForJournalStream(host: Host, binding: Binding): Promise<void> {
    requireHost(host.id);
    try { await recoverBinding(host, binding); }
    catch (error) {
      if (error instanceof BrokerError && error.code === 'host_offline' && host.ready && host.socket?.readyState === RELAY_SOCKET_OPEN) {
        throw new BrokerError(503, 'host_reconnected', 'The Host reconnected while the session was opening. Reconnect to continue.');
      }
      throw error;
    }
  }
  /** Asks the Controller to attach the session again, which refuses with the native owner when a terminal holds it; any other refusal is thrown. */
  async function readNativeOwner(host: Host, binding: Binding): Promise<NativeSessionOwner | undefined> {
    try { await recoverBinding(host, binding, true); return undefined; }
    catch (error) { if (error instanceof BrokerError && error.nativeOwner) return error.nativeOwner; throw error; }
  }
  /**
   * A browser stream whose session is read from its journal. Reads and control never touch the Controller; the Controller
   * stream for operations opens at the first message that needs it, through the Host's stream table, so limits, revocation
   * and Host disconnects apply to it like to any other stream.
   */
  function acceptJournalServed(host: Host, binding: Binding, context: BrokerRequestContext) {
    const subject = principal(context);
    return { accept(client: RelaySocket) {
      if (!sessionAllowed(binding, principal(context))) { client.close(1008, 'Session access is unavailable'); return; }
      // The switch may have been turned off after the upgrade was prepared.
      if (brokerState.hosts.get(host.id)?.smartReading?.includes(binding.providerId) !== true) { client.close(1012, 'Smart reading turned off'); return; }
      track(client);
      const expiry = () => sessionAllowed(binding, principal(context)) ? context.connectionExpiresAt?.() : 0;
      credentialExpiry.expire(client, expiry);
      if (client.readyState !== RELAY_SOCKET_OPEN) return;
      client.onError(() => undefined);
      const admit = admitClientMessages(client, context, subject, expiry);
      const userStreams = () => subject === undefined ? 0 : options.userStreamCount?.(subject) ?? activeStreamCount(subject);
      const stream = journalSessions!.attach({
        hostId: host.id, providerId: binding.providerId, sessionKey: journalSessionKey(binding.providerId, binding.nativeSessionId), publicAgentId: binding.agentId, client,
        readNativeOwner: () => readNativeOwner(host, binding),
        // The CLI's refusal of the Controller, and a retry of the attach it refused, which tells every stream of the session the outcome.
        nativeRefusal: () => nativeRefusal(binding.agentId),
        retryNative: () => { void (async () => { requireHost(host.id); await recoverBinding(host, binding, true); })().catch(() => undefined); },
        hostStreams: createHostStreamOpener({
          streams: host.streams, publicAgentId: binding.agentId, runtimeAgentId: () => runtimeAgentId(host, binding), subject,
          authorized: () => { const end = expiry(); return end === undefined || end > now(); },
          recover: () => recoverForJournalStream(host, binding),
          capacity: () => host.streams.size >= hostStreamLimit ? 'host' : userStreams() >= USER_STREAM_LIMIT ? 'account' : undefined,
          write: message => send(host, message), scheduler, openTimeoutMs: options.rpcTimeoutMs ?? 30_000,
          diagnostic: details => diagnostic(host, details),
        }),
      });
      client.onMessage((raw, binary) => { if (admit(raw, binary)) stream.receive(raw); });
      client.onClose(() => stream.close());
    } };
  }
  async function upgrade(request: Request, context: BrokerRequestContext, url: URL) {
    brokerState.assertAvailable();
    if (url.pathname === '/ws/remote-host') {
      const header = request.headers.get('authorization');
      const hash = header?.startsWith('Bearer ') ? keyHash(header.slice(7)) : undefined;
      const key = hash ? brokerState.keys.get(hash) : undefined;
      if (!key || key.claimedAt !== undefined || key.expires <= now()) return rejectUpgrade(401);
      return { accept(client: RelaySocket) {
        if (brokerState.unavailable || brokerState.keys.get(hash!) !== key || key.claimedAt !== undefined || key.expires <= now()) { client.close(1008, 'Device credential revoked'); return; }
        track(client);
        const asked = (name: string) => url.searchParams.get(name) === '1';
        const enrollment = url.searchParams.get('successionEnrollment');
        register(client, key, context, hash!, { enrollmentRequested: enrollment === '3' ? 3 : enrollment === '2' ? 2 : enrollment === '1' ? 1 : undefined,
          teamRequested: asked('team'), recipientsRequested: asked('teamRecipients'),
          statesRequested: !asked('sessionStates') ? false : asked('sessionReplyFacts') ? 2 : 1, successionRequested: asked('teamSuccession'),
          tasksRequested: asked('tasks') && namedProviders(url.searchParams.getAll('coordinatorProvider')), statusRequested: asked('hostStatus'), outboxRequested: asked('outbox'),
          journalRequested: url.searchParams.get('journal') === String(JOURNAL_VERSION) ? JOURNAL_VERSION : 0, shownRequested: asked('journalShown'), controlRequested: asked('control') });
      } };
    }
    const match = /^\/v1\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    const binding = match && brokerState.bindings.get(match[1]!);
    if (!binding || !sessionAllowed(binding, principal(context)) || !await permitted(context) || request.headers.get('origin') !== origin) return rejectUpgrade(403);
    // Authorization above is the same for both modes. A session with a journal head is read from it, whether or not its Host is online.
    const journalHost = journalSessions && brokerState.hosts.get(binding.hostId);
    // A store that cannot be read must not stop the session from opening: the Controller path still works.
    const journaled = journalHost && await journalSessions!.serves(journalHost.id, binding.providerId, journalSessionKey(binding.providerId, binding.nativeSessionId)).catch(() => {
      diagnostic(journalHost, { event: 'journal_store_failed' });
      return false;
    });
    if (journalHost && journaled) return acceptJournalServed(journalHost, binding, context);
    let host: Host;
    try { host = requireHost(binding.hostId); await recoverBinding(host, binding); }
    catch (error) {
      // A Host refusal such as native ownership is permanent until the user acts; only unknown failures stay retryable.
      return error instanceof BrokerError ? new Response(JSON.stringify({ code: error.code, error: error.message }), { status: error.status, headers: { 'content-type': 'application/json' } }) : rejectUpgrade(503);
    }
    const subject = principal(context);
    const userStreams = () => subject === undefined ? 0 : options.userStreamCount?.(subject) ?? activeStreamCount(subject);
    if (host.streams.size >= hostStreamLimit || userStreams() >= USER_STREAM_LIMIT) return capacityRefusal(host.streams.size >= hostStreamLimit, hostStreamLimit);
    return { accept(client: RelaySocket) {
      if (!sessionAllowed(binding, principal(context))) { client.close(1008, 'Session access is unavailable'); return; }
      if (host.streams.size >= hostStreamLimit || userStreams() >= USER_STREAM_LIMIT) { client.close(1013, 'Remote stream capacity reached'); return; }
      track(client);
      const expiry = () => sessionAllowed(binding, principal(context)) ? context.connectionExpiresAt?.() : 0;
      credentialExpiry.expire(client, expiry);
      if (client.readyState !== RELAY_SOCKET_OPEN) return;
      const streamId = ids.uuid(); const stream: Host['streams'] extends Map<string, infer Value> ? Value : never = { publicAgentId: binding.agentId, runtimeAgentId: runtimeAgentId(host, binding), socket: client, subject: principal(context), authorized: () => { const end = expiry(); return end === undefined || end > now(); }, ready: false, buffered: [],
        control: createStreamControl({ agentId: binding.agentId, readNativeOwner: () => readNativeOwner(host, binding), send: frame => { if (client.readyState === RELAY_SOCKET_OPEN) client.send(JSON.stringify(frame)); } }) };
      host.streams.set(streamId, stream);
      diagnostic(host,{event:'stream_opening',streamId,agentId:binding.agentId});
      const opening = setTimeout(() => { diagnostic(host,{event:'stream_open_timeout',streamId}); client.close(1013, 'Remote stream opening timed out'); }, options.rpcTimeoutMs ?? 30_000);
      stream.timer = opening;
      client.onError(() => undefined);
      const admit = admitClientMessages(client, context, subject, expiry);
      client.onMessage((raw, binary) => {
        if (!admit(raw, binary)) return;
        if (stream.control!.admitRaw(raw.toString())) return;
        let outgoing: string;
        try { outgoing = withoutItemKeysFlag(sessionIdentityMessage(raw.toString(), stream.publicAgentId, stream.runtimeAgentId, 'client')); }
        catch { return client.close(1008, 'Invalid session target'); }
        if (!stream.ready) {
          if (stream.buffered.length >= 32 || stream.buffered.reduce((sum, value) => sum + Buffer.byteLength(value), 0) + Buffer.byteLength(raw.toString()) > 1024 * 1024) return client.close(1013, 'Remote stream is not ready');
          stream.buffered.push(outgoing); return;
        }
        clearTimeout(opening);
        try { send(host, { uplinkVersion: 2, type: 'stream_message', streamId, message: outgoing }); } catch { client.close(1012, 'Remote Host disconnected'); }
      });
      client.onClose(() => {
        clearTimeout(opening);
        if (!host.streams.delete(streamId)) return;
        diagnostic(host,{event:'stream_closed',streamId});
        try { send(host, { uplinkVersion: 2, type: 'stream_close', streamId, code: 1000, reason: 'Browser disconnected' }); } catch { /* The host may already be offline. */ }
      });
      try { send(host, { uplinkVersion: 2, type: 'stream_open', streamId, sessionId: stream.runtimeAgentId }); }
      catch { client.close(1012, 'Remote Host disconnected'); }
    } };
  }
  return { upgrade };
}

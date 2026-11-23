import { randomUUID } from 'node:crypto';
import type { OutboxHostCall, TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { WebSocket } from 'ws';

import {
  successionAuthorityKey, decodeRemoteHostUplinkMessage, JOURNAL_VERSION, REMOTE_HOST_UPLINK_VERSION, UPLINK_MAX_FRAME_BYTES,
  type ControllerIdentity, type JournalRelayMessage, type RemoteHostHeartbeat, type HostEnvironment, type PairingPurpose,
  type HostSessionStates, type PreviewRegistrationSnapshot, type TrustedSuccessionContext,
} from '@orchardworks/agent-remote-protocol';

import type { AgentRemoteRelay } from '../relay.js';
import { createRemoteHostPluginHost, type RemoteHostPluginHostOptions } from './remote-host-plugin.js';
import type { SessionWireOperationExecutor } from '../session-wire.js';
import { createUplinkWriter } from './uplink-writer.js';

const JOURNAL_RELAY_MESSAGE_TYPES: ReadonlySet<string> = new Set<JournalRelayMessage['type']>([
  'journal_opened', 'journal_open_refused', 'journal_ack', 'journal_refused', 'journal_fill_request', 'journal_older_request',
]);
const isJournalRelayMessage = (message: { type: string }): message is JournalRelayMessage => JOURNAL_RELAY_MESSAGE_TYPES.has(message.type);

export interface RemoteHostUplinkDiagnostic {
  readonly event: 'connecting' | 'registered' | 'disconnected' | 'reconnect_scheduled' | 'reconnect_stopped' | 'closed';
  readonly connectionId: number;
  readonly registered: boolean;
  readonly reason?: 'heartbeat_timeout' | 'registration_timeout' | 'socket_error' | 'socket_closed' | 'http_rejected'
    | 'protocol_error' | 'write_failure' | 'host_failure' | 'credential_persistence_failed' | 'client_closed';
  readonly closeCode?: number;
  /** A known broker close reason, independently of the local first cause. */
  readonly peerReason?: 'heartbeat_timeout' | 'heartbeat_delivery_failed' | 'connection_replaced' | 'broker_closed';
  readonly httpStatus?: number;
  readonly errorCode?: string;
  readonly retryAttempt?: number;
  readonly retryDelayMs?: number;
  /** The complete local silence deadline, including the cloud interval and acknowledgement timeout. */
  readonly heartbeatTimeoutMs?: number;
  readonly lastHeartbeatAgeMs?: number;
}
type DiagnosticDetails = Omit<RemoteHostUplinkDiagnostic, 'event'>;
type DisconnectCause = Pick<RemoteHostUplinkDiagnostic, 'reason' | 'errorCode' | 'httpStatus'>;

/**
 * The socket of one uplink connection, as the client uses it: the events of a `ws` WebSocket and its two write operations.
 * The default is a `ws` client; `connect` replaces it, so a Relay that plays the other end needs no listener.
 */
export interface UplinkSocket {
  send(json: string, callback: (error?: Error) => void): void;
  terminate(): void;
  once(event: 'open', listener: () => void): unknown;
  once(event: 'close', listener: (code: number, reason: { toString(): string }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'message', listener: (data: { toString(): string }, isBinary: boolean) => void): unknown;
  on(event: 'unexpected-response', listener: (request: unknown, response: { statusCode?: number }) => void): unknown;
}
export interface UplinkSocketInit { readonly authorization: string; readonly maxPayload: number; readonly handshakeTimeout: number }

export interface RemoteHostUplinkClientOptions {
  /** Opens the socket of one connection to `endpoint`. Defaults to a WebSocket client; the Relay's side is then a listener. */
  readonly connect?: (endpoint: URL, init: UplinkSocketInit) => UplinkSocket;
  readonly previews?: {
    snapshot(): PreviewRegistrationSnapshot | undefined;
    subscribe(listener: (snapshot: PreviewRegistrationSnapshot) => void): () => void;
    registered(info: { hostId: string; tunnelToken: string }): void;
    disconnected(): void;
  };
  /** Session states shared through the Relay, sent once it acknowledges them: complete reports and changes. */
  readonly sessionStates?: {
    snapshot(): HostSessionStates['states'];
    subscribe(listener: (report: HostSessionStates) => void): () => void;
  };
  readonly relay: AgentRemoteRelay;
  readonly installationId: string;
  readonly name: string;
  readonly environment?: HostEnvironment;
  readonly controller?: ControllerIdentity;
  readonly tpmManagement?: true;
  /** Answer Host status reads (sessions, CPU, memory and disks); advertised so a Relay asks only Controllers that can. */
  readonly hostStatus?: true;
  readonly teamManagement?: true;
  /** Request bots (temporary bots, inboxes, links and rooms of main sessions); honored only with teamManagement. */
  readonly tasks?: true;
  /** Providers whose sessions take the task tools, so their assistants can be coordinators; sent with the tasks request, in the query too. */
  readonly coordinatorProviders?: readonly string[];
  readonly providers?: readonly { providerId: string; displayName: string; promptEditing?: true; sessionRename?: true; sessionReferences?: true; referenceNotes?: true; sessionCommands?: true; daemonControl?: true }[];
  readonly providerChanges?: { current(): NonNullable<RemoteHostUplinkClientOptions['providers']>; subscribe(listener: () => void): () => void };
  readonly remoteKey: string;
  /** Must durably persist the offered credential before resolving. */
  readonly onCredential?: (credential: string) => Promise<void>;
  readonly url: string;
  readonly resolveSession: RemoteHostPluginHostOptions['resolveSession'];
  readonly acquireSession?: RemoteHostPluginHostOptions['acquireSession'];
  readonly control: RemoteHostPluginHostOptions['control'];
  /** Unpublished integration: the context is created from this registered socket only. */
  readonly successionEnrollment?: { control(request: Parameters<RemoteHostPluginHostOptions['control']>[0], context: TrustedSuccessionContext): ReturnType<RemoteHostPluginHostOptions['control']> };
  readonly operationExecutor?: (scope: string) => SessionWireOperationExecutor;
  readonly registrationTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  readonly maxQueuedMessages?: number;
  readonly maxQueuedBytes?: number;
  readonly reconnectBaseDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  readonly onStateChange?: (state: 'connecting' | 'registered' | 'disconnected' | 'rejected' | 'closed') => void;
  readonly onDiagnostic?: (diagnostic: RemoteHostUplinkDiagnostic) => void | Promise<void>;
  /**
   * Delivers messages that waited in the outbox for this Host: asks the Relay for them, then says whether this connection
   * may poll, claim and settle them (onAvailable), and when the Relay says a message arrived (onReady).
   */
  readonly outbox?: { onAvailable(available: boolean): void; onReady(): void };
  /**
   * Publishes session journals. The client asks the Relay for the grant; `available` is called with a writer once the
   * Relay acknowledged it, with undefined when it did not and again with undefined when the connection ends, and
   * `receive` with every journal message the Relay sends while the grant holds. The owner validates what it writes. With `shown`, the
   * client also asks for the sessions pages show (`journalShown=1`), and `shown` is called with each complete set the Relay sends.
   */
  readonly journal?: {
    available(writer: { send(json: string): void } | undefined): void;
    receive(message: JournalRelayMessage): void;
    shown?(sessionKeys: readonly string[]): void;
  };
}

export interface RemoteHostUplinkClient {
  teamRequest(call: TeamHostCall): Promise<unknown>;
  /** A call for the messages waiting for this Host; rejects with the Relay's status and code when it refuses. */
  outboxRequest(call: OutboxHostCall): Promise<unknown>;
  /** The Relay routes Team recipients across a generic succession of their session, including a provider change. */
  readonly teamSuccession: boolean;
  /** The Relay runs tasks for this Host's sessions. Absent on clients that predate tasks. */
  readonly tasks?: boolean;
  readonly ready: Promise<{ hostId: string; pairingPurpose?: PairingPurpose }>;
  close(): Promise<void>;
}

const connectWebSocket = (endpoint: URL, init: UplinkSocketInit): UplinkSocket => new WebSocket(endpoint, {
  headers: { authorization: init.authorization }, maxPayload: init.maxPayload, handshakeTimeout: init.handshakeTimeout, perMessageDeflate: false, followRedirects: false,
}) as unknown as UplinkSocket;

/** Host calls only a Relay that acknowledged bots understands. */
const taskActions = new Set<string>(['create_task', 'task_status', 'report_task', 'bot_enablement']);

export function createRemoteHostUplinkClient(options: RemoteHostUplinkClientOptions): RemoteHostUplinkClient {
  validateConfiguration(options);
  const registrationTimeout = positive(options.registrationTimeoutMs ?? 5000);
  const writeTimeout = positive(options.writeTimeoutMs ?? 10000);
  const maxQueuedMessages = positive(options.maxQueuedMessages ?? 256);
  const maxQueuedBytes = positive(options.maxQueuedBytes ?? 64 * 1024 * 1024);
  const reconnectBaseDelay = positive(options.reconnectBaseDelayMs ?? 1000);
  const reconnectMaxDelay = positive(options.reconnectMaxDelayMs ?? 30000);
  if (reconnectMaxDelay < reconnectBaseDelay) throw new RangeError('Remote Host reconnect maximum must not precede its base delay.');
  let resolveReady!: (value: { hostId: string; pairingPurpose?: PairingPurpose }) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<{ hostId: string; pairingPurpose?: PairingPurpose }>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => undefined);
  const teamPending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let teamSuccession = false;
  let tasks = false;
  let sendTeam: ((json: string) => void) | undefined;
  const outboxPending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let sendOutbox: ((json: string) => void) | undefined;
  const rejectOutbox = () => {
    const available = !!sendOutbox; sendOutbox = undefined;
    for (const pending of outboxPending.values()) { clearTimeout(pending.timer); pending.reject(new Error('The outbox connection closed; the Relay keeps the messages.')); }
    outboxPending.clear();
    if (available) options.outbox?.onAvailable(false);
  };
  const rejectTeam = () => { teamSuccession = false; tasks = false; sendTeam = undefined; for (const pending of teamPending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Team transport disconnected; query the original operation before retrying.')); } teamPending.clear(); };
  let remoteKey = options.remoteKey;
  let credentialWrite: Promise<void> | undefined;
  let closed = false;
  let terminal = false;
  let attempts = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retireConnection: (() => void) | undefined;
  let connectionClosed: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  let connectionSequence = 0;
  let describeConnection: () => DiagnosticDetails = () => ({ connectionId: 0, registered: false });

  function diagnose(diagnostic: RemoteHostUplinkDiagnostic): void {
    try { void Promise.resolve(options.onDiagnostic?.(diagnostic)).catch(() => undefined); } catch {}
  }
  function scheduleReconnect(details: DiagnosticDetails): void {
    if (closed || terminal) return;
    const upper = Math.min(reconnectMaxDelay, reconnectBaseDelay * 2 ** Math.min(attempts, 20));
    attempts += 1;
    const delay = Math.floor(upper * (0.5 + Math.random() * 0.5));
    retry = setTimeout(connect, delay);
    diagnose({ ...details, event: 'reconnect_scheduled', retryAttempt: attempts, retryDelayMs: delay });
  }

  function connect(): void {
    if (closed || terminal) return;
    if (credentialWrite) { void credentialWrite.then(connect); return; }
    const connectionId = ++connectionSequence;
    diagnose({ event: 'connecting', connectionId, registered: false });
    options.onStateChange?.('connecting');
    const endpoint = new URL(options.url);
    if (options.successionEnrollment) endpoint.searchParams.set('successionEnrollment', '3');
    // A Relay that understands reply facts acknowledges sessionStates: 2; older ones keep acknowledging 1.
    if (options.sessionStates) { endpoint.searchParams.set('sessionStates', '1'); endpoint.searchParams.set('sessionReplyFacts', '1'); }
    if (options.hostStatus) endpoint.searchParams.set('hostStatus', '1');
    if (options.outbox) endpoint.searchParams.set('outbox', '1');
    endpoint.searchParams.set('control', '1');
    if (options.journal) endpoint.searchParams.set('journal', String(JOURNAL_VERSION));
    if (options.journal?.shown) endpoint.searchParams.set('journalShown', '1');
    if (options.teamManagement) { endpoint.searchParams.set('team', '1'); endpoint.searchParams.set('teamSuccession', '1'); if (options.tasks) { endpoint.searchParams.set('tasks', '1'); for (const providerId of options.coordinatorProviders ?? []) endpoint.searchParams.append('coordinatorProvider', providerId); } }
    const socket: UplinkSocket = (options.connect ?? connectWebSocket)(endpoint, { authorization: `Bearer ${remoteKey}`, maxPayload: UPLINK_MAX_FRAME_BYTES, handshakeTimeout: registrationTimeout });
    let registered = false;
    let registeredHostId: string | undefined;
    /** The Relay acknowledged that it owns session control on this connection; without it no session opens. */
    let sessionControl = false;
    let registeredEnrollmentIdentity: string | undefined;
    let retired = false;
    let registrationDeadline: ReturnType<typeof setTimeout> | undefined;
    let heartbeatDeadline: ReturnType<typeof setTimeout> | undefined;
    let cloudHeartbeat: RemoteHostHeartbeat | undefined;
    let lastHeartbeatAt: number | undefined;
    let retirement: DiagnosticDetails | undefined;
    let operationScope: string | undefined;
    let journalWriter: { send(json: string): void } | undefined;
    let successionContext: TrustedSuccessionContext | undefined;
    let unsubscribeProviders: (() => void) | undefined;
    let unsubscribePreviews: (() => void) | undefined;
    let unsubscribeStates: (() => void) | undefined;
    function details(): DiagnosticDetails {
      return { connectionId, registered,
        ...(cloudHeartbeat ? { heartbeatTimeoutMs: cloudHeartbeat.intervalMs + cloudHeartbeat.timeoutMs } : {}),
        ...(lastHeartbeatAt === undefined ? {} : { lastHeartbeatAgeMs: Math.max(0, Math.floor(performance.now() - lastHeartbeatAt)) }) };
    }
    describeConnection = details;
    const writer = createUplinkWriter(socket, {
      maxMessages: maxQueuedMessages, maxBytes: maxQueuedBytes, writeTimeoutMs: writeTimeout, onFailure: error => retire({ reason: 'write_failure', errorCode: safeErrorCode(error) }),
    });
    const host = createRemoteHostPluginHost(options.relay, {
      sessionsAvailable: () => sessionControl,
      resolveSession: options.resolveSession,
      acquireSession: options.acquireSession,
      imageScope: () => { if (!operationScope) throw new Error('Image scope is unavailable before Host registration.'); return operationScope; },
      control: request => request.path === '/remote/succession/enrollment'
        ? options.successionEnrollment && successionContext ? options.successionEnrollment.control({ ...request, ...(operationScope ? { operationScope } : {}) }, structuredClone(successionContext))
          : { status: 403, body: JSON.stringify({ code: 'succession_enrollment_unavailable', error: 'Succession v2 enrollment was not acknowledged. Retain saved records until the Relay is upgraded.' }) }
        : request.method === 'POST' && request.path === '/remote/create' && options.successionEnrollment && successionContext
          ? options.successionEnrollment.control({ ...request, ...(operationScope ? { operationScope } : {}) }, structuredClone(successionContext))
          : options.control({ ...request, ...(operationScope ? { operationScope } : {}) }),
      executeOperation: (agent, operation, work) => {
        if (!operationScope) throw new Error('Remote Host operation scope is unavailable before registration.');
        return (options.operationExecutor?.(operationScope) ?? options.relay.executeOperation(operationScope))(agent, operation, work);
      },
      send: (json) => writer.send(json), onFailure: () => retire({ reason: 'host_failure' }),
    });
    function retire(cause: DisconnectCause): void {
      if (retired) return;
      rejectTeam(); rejectOutbox();
      if (journalWriter) { journalWriter = undefined; options.journal?.available(undefined); }
      retired = true;
      unsubscribeProviders?.(); unsubscribeProviders = undefined; unsubscribePreviews?.();
      unsubscribeStates?.(); unsubscribeStates = undefined;
      if (registered) options.previews?.disconnected();
      retirement = { ...details(), ...cause };
      clearTimeout(registrationDeadline);
      clearTimeout(heartbeatDeadline);
      host.close();
      writer.close();
      socket.terminate();
    }
    retireConnection = () => retire({ reason: 'client_closed' });
    connectionClosed = new Promise<void>((resolve) => {
      socket.once('close', (code, reason) => {
        if (code === 1008) {
          terminal = true;
          options.onStateChange?.('rejected');
          if (!registered) rejectReady(new Error('Remote Host uplink authorization was rejected.'));
        } else if (!closed && !terminal) options.onStateChange?.('disconnected');
        retire({ reason: 'socket_closed' });
        const peerReason = safePeerReason(reason.toString());
        const disconnected = { ...retirement!, closeCode: code, ...(peerReason ? { peerReason } : {}) };
        if (retirement!.reason !== 'client_closed') diagnose({ ...disconnected, event: 'disconnected' });
        resolve();
        scheduleReconnect(disconnected);
      });
    });
    socket.on('error', error => retire({ reason: error.message === 'Opening handshake has timed out' ? 'registration_timeout' : 'socket_error', errorCode: safeErrorCode(error) }));
    function resetCloudDeadline(): void {
      clearTimeout(heartbeatDeadline);
      heartbeatDeadline = setTimeout(() => retire({ reason: 'heartbeat_timeout' }), cloudHeartbeat!.intervalMs + cloudHeartbeat!.timeoutMs);
    }
    socket.on('unexpected-response', (_request, response) => {
      if (response.statusCode === 401 || response.statusCode === 403) {
        terminal = true;
        options.onStateChange?.('rejected');
        if (!registered) rejectReady(new Error('Remote Host uplink authorization was rejected.'));
      }
      retire({ reason: 'http_rejected', httpStatus: response.statusCode });
    });
    socket.once('open', () => {
      if (closed || terminal || retired) { retire({ reason: closed ? 'client_closed' : 'protocol_error' }); return; }
      registrationDeadline = setTimeout(() => retire({ reason: 'registration_timeout' }), registrationTimeout);
      writer.send(JSON.stringify({
        uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'register', installationId: options.installationId,
        ...(options.onCredential ? { credentialRotation: true } : {}),
        ...(options.environment ? { environment: options.environment } : {}),
        ...(options.controller ? { controller: options.controller } : {}),
        ...(options.tpmManagement ? { tpmManagement: true } : {}),
        ...(options.providerChanges ? { providerManagement: true } : {}),
        name: options.name, ...(options.providers === undefined ? { providerId: 'dsh' } : { providers: options.providerChanges?.current() ?? options.providers }),
      }));
    });
    socket.on('message', (data, isBinary) => {
      if (closed || retired) return;
      if (isBinary) { retire({ reason: 'protocol_error' }); return; }
      const decoded = decodeRemoteHostUplinkMessage(data.toString());
      if (decoded.status !== 'ok') { retire({ reason: 'protocol_error' }); return; }
      if (decoded.value.type === 'credential_issued') {
        if (!options.onCredential || credentialWrite) { retire({ reason: 'protocol_error' }); return; }
        const credential = decoded.value.credential;
        credentialWrite = Promise.resolve().then(() => options.onCredential!(credential)).then(() => {
          // The saved key is authoritative even when this connection disappeared during fsync.
          remoteKey = credential;
          if (!closed && !retired) writer.send(JSON.stringify({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'credential_saved' }));
        }).catch(() => {
          terminal = true;
          clearTimeout(retry);
          if (!closed && retired) diagnose({ ...details(), event: 'reconnect_stopped', reason: 'credential_persistence_failed' });
          if (!closed) options.onStateChange?.('rejected');
          rejectReady(new Error('Remote Host could not durably save its device credential. Pair again after fixing local storage.'));
          retire({ reason: 'credential_persistence_failed' });
        }).finally(() => { credentialWrite = undefined; });
        return;
      }
      if (registered && decoded.value.type === 'registered') {
        if ((decoded.value.successionEnrollment && JSON.stringify([successionAuthorityKey(decoded.value.successionEnrollment), decoded.value.successionEnrollmentVersion])) !== registeredEnrollmentIdentity || decoded.value.hostId !== registeredHostId
          || (!!options.outbox && decoded.value.outbox === 1) !== !!sendOutbox || (decoded.value.control === 1) !== sessionControl || (!!options.journal && decoded.value.journal === JOURNAL_VERSION) !== !!journalWriter || !!decoded.value.teamManagement !== !!sendTeam || (decoded.value.teamSuccession === 1) !== teamSuccession
          || decoded.value.heartbeat?.intervalMs !== cloudHeartbeat?.intervalMs
          || decoded.value.heartbeat?.timeoutMs !== cloudHeartbeat?.timeoutMs) retire({ reason: 'protocol_error' });
        return;
      }
      if (!registered) {
        if (credentialWrite) { retire({ reason: 'protocol_error' }); return; }
        if (decoded.value.type !== 'registered') { retire({ reason: 'protocol_error' }); return; }
        clearTimeout(registrationDeadline);
        registered = true;
        teamSuccession = options.teamManagement === true && decoded.value.teamManagement === true && decoded.value.teamSuccession === 1;
        tasks = teamSuccession && options.tasks === true && decoded.value.tasks === 1;
        sendTeam = decoded.value.teamManagement ? json => { writer.send(json); } : undefined;
        registeredHostId = decoded.value.hostId;
        sessionControl = decoded.value.control === 1;
        registeredEnrollmentIdentity = decoded.value.successionEnrollment && JSON.stringify([successionAuthorityKey(decoded.value.successionEnrollment), decoded.value.successionEnrollmentVersion]);
        operationScope = JSON.stringify([new URL(options.url).origin, registeredHostId, options.installationId]);
        if (options.successionEnrollment && decoded.value.successionEnrollment && (decoded.value.successionEnrollmentVersion === 2 || decoded.value.successionEnrollmentVersion === 3)) {
          const relayOrigin = new URL(options.url); relayOrigin.protocol = relayOrigin.protocol === 'wss:' ? 'https:' : 'http:';
          if (decoded.value.successionEnrollment.origin !== relayOrigin.origin) { retire({ reason: 'protocol_error' }); return; }
          successionContext = { authority: decoded.value.successionEnrollment, installationId: options.installationId, successionEnrollmentVersion: decoded.value.successionEnrollmentVersion };
        }
        cloudHeartbeat = decoded.value.heartbeat;
        resetCloudDeadline();
        options.onStateChange?.('registered');
        diagnose({ ...details(), event: 'registered' });
        attempts = 0;
        resolveReady({ hostId: decoded.value.hostId, ...(decoded.value.pairingPurpose ? { pairingPurpose: decoded.value.pairingPurpose } : {}) });
        if (options.outbox) {
          sendOutbox = decoded.value.outbox === 1 ? json => { writer.send(json); } : undefined;
          options.outbox.onAvailable(!!sendOutbox);
        }
        if (options.journal) {
          if (decoded.value.journal === JOURNAL_VERSION) journalWriter = { send: json => { writer.send(json); } };
          options.journal.available(journalWriter);
        }
        if (options.providerChanges) {
          const publish = () => { if (!retired) writer.send(JSON.stringify({ uplinkVersion: 2, type: 'provider_snapshot', providers: options.providerChanges!.current() })); };
          unsubscribeProviders = options.providerChanges.subscribe(publish);
          publish();
        }
        if (options.sessionStates && decoded.value.sessionStates) {
          // A Relay that did not acknowledge reply facts validates states without them.
          const facts = decoded.value.sessionStates === 2;
          const publish = (report: HostSessionStates) => {
            if (retired) return;
            const states = facts ? report.states : report.states.map(({ replyAt: _replyAt, preview: _preview, ...state }) => state);
            writer.send(JSON.stringify({ uplinkVersion: 2, type: 'session_states', ...report, states }));
          };
          unsubscribeStates = options.sessionStates.subscribe(publish);
          publish({ full: true, states: options.sessionStates.snapshot() });
        }
        if (options.previews && decoded.value.tunnelToken) {
          const publish = (snapshot: PreviewRegistrationSnapshot) => {
            if (!retired) writer.send(JSON.stringify({ uplinkVersion: 2, type: 'preview_snapshot', snapshot }));
          };
          unsubscribePreviews = options.previews.subscribe(publish);
          options.previews.registered({ hostId: decoded.value.hostId, tunnelToken: decoded.value.tunnelToken });
        }
        return;
      }
      if (isJournalRelayMessage(decoded.value)) {
        if (!journalWriter) { retire({ reason: 'protocol_error' }); return; }
        options.journal!.receive(decoded.value);
        return;
      }
      if (decoded.value.type === 'journal_shown') {
        if (!journalWriter || !options.journal?.shown) { retire({ reason: 'protocol_error' }); return; }
        options.journal.shown(decoded.value.sessionKeys);
        return;
      }
      if (decoded.value.type === 'outbox_response') {
        const pending = outboxPending.get(decoded.value.requestId);
        if (pending) { outboxPending.delete(decoded.value.requestId); clearTimeout(pending.timer);
          try {
            const value = JSON.parse(decoded.value.body);
            if (decoded.value.status < 400) pending.resolve(value);
            else pending.reject(Object.assign(new Error(typeof value?.error === 'string' ? value.error : 'Outbox request failed.'), { status: decoded.value.status, ...(typeof value?.code === 'string' ? { code: value.code } : {}) }));
          } catch { pending.reject(new Error('Invalid outbox response.')); }
        }
        return;
      }
      if (decoded.value.type === 'outbox_ready') { if (sendOutbox) options.outbox?.onReady(); return; }
      if (decoded.value.type === 'team_response') {
        const pending = teamPending.get(decoded.value.requestId);
        if (pending) { teamPending.delete(decoded.value.requestId); clearTimeout(pending.timer);
          try { const value = JSON.parse(decoded.value.body); if (decoded.value.status >= 400) pending.reject(new Error(value.error ?? 'Team request failed.')); else pending.resolve(value); }
          catch { pending.reject(new Error('Invalid Team response.')); }
        }
        return;
      }
      if (decoded.value.type === 'heartbeat') {
        if (!cloudHeartbeat) { retire({ reason: 'protocol_error' }); return; }
        lastHeartbeatAt = performance.now();
        resetCloudDeadline();
        writer.send(JSON.stringify({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'heartbeat_ack', nonce: decoded.value.nonce }));
        return;
      }
      host.receive(data.toString());
    });
  }

  connect();
  return {
    ready,
    get teamSuccession() { return teamSuccession; },
    get tasks() { return tasks; },
    outboxRequest(call) {
      if (!sendOutbox || closed || outboxPending.size >= 32) return Promise.reject(new Error('The outbox is unavailable on this connection.'));
      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { outboxPending.delete(requestId); reject(new Error('The outbox request timed out.')); }, 15000);
        outboxPending.set(requestId, { resolve, reject, timer });
        try { sendOutbox!(JSON.stringify({ uplinkVersion: 2, type: 'outbox_request', requestId, call })); }
        catch (error) { clearTimeout(timer); outboxPending.delete(requestId); reject(error instanceof Error ? error : new Error('The outbox write failed.')); }
      });
    },
    teamRequest(call) {
      if (!tasks && taskActions.has(call.action)) return Promise.reject(new Error('Update the Relay to use tasks.'));
      if (!sendTeam || closed || teamPending.size >= 32) return Promise.reject(new Error('Team transport is unavailable.'));
      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { teamPending.delete(requestId); reject(new Error('Team request timed out; query its operation before retrying.')); }, 15000);
        teamPending.set(requestId, {resolve, reject, timer});
        try { sendTeam!(JSON.stringify({ uplinkVersion: 2, type: 'team_request', requestId, call })); }
        catch (error) { clearTimeout(timer); teamPending.delete(requestId); reject(error instanceof Error ? error : new Error('Team transport write failed.')); }
      });
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closed = true;
      diagnose({ ...describeConnection(), event: 'closed', reason: 'client_closed' });
      options.onStateChange?.('closed');
      clearTimeout(retry);
      rejectOutbox();
      rejectReady(new Error('Remote Host uplink closed before registration.'));
      retireConnection?.();
      closePromise = Promise.all([connectionClosed, credentialWrite]).then(() => undefined);
      return closePromise;
    },
  };
}

function validateConfiguration(options: RemoteHostUplinkClientOptions): void {
  const url = new URL(options.url);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || url.pathname !== '/ws/remote-host') {
    throw new Error('Remote Host uplink requires a WebSocket /ws/remote-host URL.');
  }
  for (const [name, value] of [['installation identity', options.installationId], ['instance name', options.name]] as const) {
    if (!value.trim() || value.length > 512) throw new Error(`Remote Host uplink requires a valid ${name}.`);
  }
  if (!options.remoteKey || options.remoteKey.length > 512 || !/^[!-~]+$/.test(options.remoteKey)) {
    throw new Error('Remote Host uplink requires a valid Remote Access Key.');
  }
  if (options.providers !== undefined) {
    if (options.providers.length > 64) throw new Error('Remote Host uplink supports at most 64 providers.');
    const ids = new Set<string>();
    for (const provider of options.providers) {
      for (const [name, value] of [['provider identity', provider.providerId], ['provider display name', provider.displayName]] as const) {
        if (!value.trim() || value.length > 512) throw new Error(`Remote Host uplink requires a valid ${name}.`);
      }
      if (ids.has(provider.providerId)) throw new Error('Remote Host uplink provider identities must be unique.');
      ids.add(provider.providerId);
    }
  }
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Remote Host uplink limits and deadlines must be positive integers.');
  return value;
}

const diagnosticErrorCodes = new Set([
  'EAI_AGAIN', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTDOWN', 'EHOSTUNREACH', 'ENETDOWN', 'ENETUNREACH',
  'ENOTFOUND', 'EPIPE', 'ETIMEDOUT', 'EADDRNOTAVAIL', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_SSL_WRONG_VERSION_NUMBER',
  'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH', 'WS_ERR_INVALID_CLOSE_CODE', 'WS_ERR_INVALID_UTF8',
]);
function safeErrorCode(error: unknown): string | undefined {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && diagnosticErrorCodes.has(code) ? code : undefined;
}

function safePeerReason(reason: string): RemoteHostUplinkDiagnostic['peerReason'] {
  switch (reason) {
    case 'Host heartbeat timed out': return 'heartbeat_timeout';
    case 'Host heartbeat delivery failed': return 'heartbeat_delivery_failed';
    case 'Host connection replaced': return 'connection_replaced';
    case 'Broker closed': return 'broker_closed';
    default: return undefined;
  }
}

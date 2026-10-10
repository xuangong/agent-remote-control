import type { SessionTitleUpdate } from '@orchardworks/agent-remote-protocol';
import {
  PROTOCOL_VERSION,
  isSessionSuccessionReplay, isSessionSuccessionReplayPage, isSessionSuccessionCurrent,
  type SessionSuccessionReplay, type SessionSuccessionReplayPage, type SessionSuccessionCurrent,
  type SessionMigration,
  decodeAgentSnapshot,
  decodeHistoryPage,
  decodeIncompatibleProtocolVersionError,
  decodeServerMessage,
  encodeClientMessage,
  type AgentPersistenceHandle,
  type AgentSessionConfig,
  type AgentSessionResponse,
  type ClientMessage,
  type CreateAgentRequest,
  type HistoryPage,
  type ProviderListResponse,
  type ResumeAgentRequest,
  type TimelineCursor,
  type TimelineDirection,
} from '@orchardworks/agent-remote-protocol';

import { watchPageResume } from './page-resume.js';
import { SessionChannelPool } from './session-channel-transport.js';
import { RemoteOperationError } from './transport.js';
import type {
  RemoteAgentTransport,
  RemoteConnection,
  RemoteProtocolObservation,
  RemoteRequestOptions,
  RemoteTransportDiagnostic,
  RemoteTransportListener,
  RemoteServerMessage, SessionSuccessionSelection, SessionSuccessionSupport,
} from './transport.js';

type WebSocketEventHandler<TEvent> = {
  bivarianceHack(event: TEvent): void;
}['bivarianceHack'];

export interface WebSocketLike {
  readonly readyState?: number;
  readonly bufferedAmount?: number;
  onopen: WebSocketEventHandler<unknown> | null;
  onmessage: WebSocketEventHandler<{ data: unknown }> | null;
  onclose: WebSocketEventHandler<unknown> | null;
  onerror: WebSocketEventHandler<unknown> | null;
  send(value: string): void;
  close(): void;
}

export interface HttpWebSocketTransportDependencies {
  readonly sessionChannels?: boolean;
  readonly sessionSuccessions?: boolean;
  readonly fetch?: typeof fetch;
  readonly WebSocket?: new (url: string) => WebSocketLike;
  readonly webSocketFactory?: (url: string) => WebSocketLike;
  readonly requestId?: () => string;
  readonly operationId?: () => string;
}

export class HttpWebSocketTransport implements RemoteAgentTransport {
  readonly timelineRecovery = 'websocket' as const;
  private successionSupport: SessionSuccessionSupport = 'disabled';
  private successionDisposed = false;
  get sessionSuccessionSupport(): SessionSuccessionSupport { return this.successionSupport; }
  private readonly successionListeners = new Set<(succession: SessionSuccessionReplay) => void>();
  private readonly successions = new Map<string, { value: SessionSuccessionReplay; identity: string; bytes: number }>();
  private successionBytes = 0;
  onSessionSuccession(listener: (succession: SessionSuccessionReplay) => void): () => void {
    if (this.successionDisposed) return () => {};
    this.successionListeners.add(listener);
    for (const item of this.successions.values()) listener(structuredClone(item.value));
    return () => { this.successionListeners.delete(listener); };
  }
  private receiveSuccession(value: SessionSuccessionReplay): void {
    if (this.successionDisposed) return;
    const key = JSON.stringify([value.projection.role.id, value.projection.role.revision]);
    const identity = stableIdentity(value), previous = this.successions.get(key);
    const operation = [...this.successions.values()].find(item => item.value.projection.receipt.operationId === value.projection.receipt.operationId);
    if (previous || operation) {
      if ((previous ?? operation)!.identity !== identity) this.diagnostic({ source: 'websocket', code: 'succession_replay_conflict', message: 'Committed succession replay changed.', recoverable: false });
      return;
    }
    const bytes = new TextEncoder().encode(identity).byteLength;
    if (bytes > 16 * 1024 * 1024) return;
    this.successions.set(key, { value: structuredClone(value), identity, bytes }); this.successionBytes += bytes;
    while (this.successions.size > 1024 || this.successionBytes > 16 * 1024 * 1024) {
      const oldest = this.successions.keys().next().value!; this.successionBytes -= this.successions.get(oldest)!.bytes; this.successions.delete(oldest);
    }
    for (const listener of this.successionListeners) { try { listener(structuredClone(value)); } catch { /* Presentation hooks do not own delivery. */ } }
  }
  private readonly titleListeners = new Set<(session: SessionTitleUpdate) => void>();
  private readonly titles = new Map<string, SessionTitleUpdate>();
  onSessionTitle(listener: (session: SessionTitleUpdate) => void): () => void {
    this.titleListeners.add(listener);
    for (const value of this.titles.values()) listener(value);
    return () => { this.titleListeners.delete(listener); };
  }
  private readonly migrationListeners = new Set<(migration: SessionMigration) => void>();
  private readonly migrations = new Map<string, SessionMigration>();
  onSessionMigration(listener: (migration: SessionMigration) => void): () => void {
    this.migrationListeners.add(listener);
    for (const value of this.migrations.values()) listener(value);
    return () => { this.migrationListeners.delete(listener); };
  }
  private readonly fetchImplementation: typeof fetch;
  private readonly createWebSocket: (url: string) => WebSocketLike;
  private readonly createRequestId: () => string;
  private readonly createOperationId: () => string;
  private readonly diagnosticListeners = new Set<(diagnostic: RemoteTransportDiagnostic) => void>();
  private readonly protocolListeners = new Set<(observation: RemoteProtocolObservation) => void>();
  private requestCounter = 0;
  private readonly sessionChannels?: SessionChannelPool;

  constructor(
    private readonly baseUrl: string,
    dependencies: HttpWebSocketTransportDependencies = {},
  ) {
    this.fetchImplementation = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    const WebSocketImplementation = dependencies.WebSocket
      ?? (globalThis.WebSocket as unknown as new (url: string) => WebSocketLike);
    this.createWebSocket = dependencies.webSocketFactory ?? ((url) => new WebSocketImplementation(url));
    this.createRequestId = dependencies.requestId ?? (() => `remote-http-${++this.requestCounter}`);
    this.createOperationId = dependencies.operationId ?? (() => crypto.randomUUID());
    this.successionSupport = dependencies.sessionSuccessions ? 'unknown' : 'disabled';
    if (dependencies.sessionChannels) {
      this.sessionChannels = new SessionChannelPool({
        sessionSuccessions: dependencies.sessionSuccessions,
        onSuccession: succession => this.receiveSuccession(succession),
        onSuccessionSupport: supported => { if (dependencies.sessionSuccessions && !this.successionDisposed) this.successionSupport = supported ? 'supported' : 'unsupported'; },
        onTitle: session => {
          const key = JSON.stringify([session.hostId, session.providerId, session.nativeSessionId]);
          const previous = this.titles.get(key);
          if (previous && previous.revision >= session.revision) return;
          this.titles.set(key, session);
          if (this.titles.size > 1024) this.titles.delete(this.titles.keys().next().value!);
          for (const listener of this.titleListeners) listener(session);
        },
        onMigration: migration => {
          if (this.migrations.has(migration.id)) return;
          this.migrations.set(migration.id, migration);
          if (this.migrations.size > 1024) this.migrations.delete(this.migrations.keys().next().value!);
          for (const listener of this.migrationListeners) listener(migration);
        },
        createSocket: (mode) => this.createWebSocket(this.websocketUrl(`v1/session-channel?observation=${mode}&migrations=1&titles=1${dependencies.sessionSuccessions ? '&successions=1' : ''}`)),
        connectDirect: (agentId, listener) => this.connectDirect(agentId, listener),
        observe: (observation) => this.observe(observation),
        diagnostic: (diagnostic) => this.diagnostic(diagnostic),
      });
    }
  }

  async fetchSessionSuccessions(selection: SessionSuccessionSelection = {}, options?: RemoteRequestOptions): Promise<SessionSuccessionReplayPage> {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(selection)) if (value !== undefined) query.set(name, String(value));
    return this.fetchSuccession(`v1/session-successions?${query}`, isSessionSuccessionReplayPage, options);
  }
  async fetchSessionSuccessionOperation(roleId: string, operationId: string, options?: RemoteRequestOptions): Promise<SessionSuccessionReplay> {
    return this.fetchSuccession(`v1/session-successions/operation?${new URLSearchParams({ roleId, operationId })}`, isSessionSuccessionReplay, options);
  }
  async fetchSessionSuccessionCurrent(roleId: string, options?: RemoteRequestOptions): Promise<SessionSuccessionCurrent> {
    return this.fetchSuccession(`v1/session-successions/current?${new URLSearchParams({ roleId })}`, isSessionSuccessionCurrent, options);
  }
  private async fetchSuccession<T>(path: string, valid: (value: unknown) => value is T, options?: RemoteRequestOptions): Promise<T> {
    const body = await this.fetchBody(path, undefined, options);
    if (new TextEncoder().encode(body).byteLength <= 16 * 1024 * 1024) {
      try { const value: unknown = JSON.parse(body); if (valid(value)) return value; } catch { /* Invalid JSON follows the same rejection path. */ }
    }
    this.invalidBody('http'); throw new Error('Relay succession response was invalid.');
  }

  async fetchSnapshot(agentId: string, options?: RemoteRequestOptions) {
    const query = new URLSearchParams({ protocolVersion: PROTOCOL_VERSION });
    const body = await this.fetchBody(
      `v1/sessions/${encodeURIComponent(agentId)}/snapshot?${query}`,
      undefined,
      options,
    );
    this.throwIfHttpProtocolError(body);
    const decoded = decodeAgentSnapshot(body);
    if (decoded.status === 'ok') {
      this.observe({ direction: 'inbound', channel: 'http', message: decoded.value });
      return decoded.value;
    }
    this.invalidBody('http');
    throw new Error('Relay response was invalid.');
  }

  async fetchTimeline(
    agentId: string,
    direction: TimelineDirection,
    cursor?: TimelineCursor,
    limit = 100,
    options?: RemoteRequestOptions,
  ): Promise<HistoryPage> {
    const query = new URLSearchParams({
      protocolVersion: PROTOCOL_VERSION,
      requestId: this.createRequestId(),
      direction,
      limit: String(limit),
    });
    if (cursor) {
      query.set('epoch', cursor.epoch);
      query.set('seq', String(cursor.seq));
    }
    const body = await this.fetchBody(
      `v1/sessions/${encodeURIComponent(agentId)}/timeline?${query}`,
      undefined,
      options,
    );
    this.throwIfHttpProtocolError(body);
    const decoded = decodeHistoryPage(body);
    if (decoded.status === 'ok') {
      this.observe({ direction: 'inbound', channel: 'http', message: decoded.value });
      return decoded.value;
    }
    this.invalidBody('http');
    throw new Error('Relay response was invalid.');
  }

  async listProviders(options?: RemoteRequestOptions): Promise<ProviderListResponse['payload']['providers']> {
    const query = new URLSearchParams({ protocolVersion: PROTOCOL_VERSION });
    const message = await this.fetchServerMessage(`v1/providers?${query}`, undefined, options);
    if (message.type !== 'provider_list') throw new Error('Relay response was invalid.');
    return message.payload.providers;
  }

  async createAgent(
    agentId: string,
    providerId: string,
    config: AgentSessionConfig,
    options?: RemoteRequestOptions,
  ): Promise<AgentSessionResponse> {
    const request: CreateAgentRequest = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'create_agent',
      payload: { requestId: this.createRequestId(), operationId: this.createOperationId(), agentId, providerId, config },
    };
    return this.fetchSession('v1/sessions', request, options);
  }

  async resumeAgent(
    agentId: string,
    persistence: AgentPersistenceHandle,
    options?: RemoteRequestOptions,
  ): Promise<AgentSessionResponse> {
    const request: ResumeAgentRequest = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'resume_agent',
      payload: { requestId: this.createRequestId(), agentId, persistence },
    };
    return this.fetchSession('v1/sessions/resume', request, options);
  }

  connect(agentId: string, listener: RemoteTransportListener): RemoteConnection {
    return this.sessionChannels?.connect(agentId, listener) ?? this.connectDirect(agentId, listener);
  }

  dispose(): void {
    this.successionDisposed = true;
    this.successions.clear(); this.successionListeners.clear(); this.successionBytes = 0;
    this.successionSupport = 'disabled';
    this.sessionChannels?.dispose();
    this.titles.clear(); this.titleListeners.clear();
    this.migrations.clear(); this.migrationListeners.clear();
  }

  private connectDirect(agentId: string, listener: RemoteTransportListener): RemoteConnection {
    const socket = this.createWebSocket(this.websocketUrl(
      `v1/sessions/${encodeURIComponent(agentId)}/events`,
    ));
    let active = true;
    const retire = () => {
      if (!active) return;
      active = false;
      unwatch();
      socket.close();
    };
    const disconnect = () => {
      if (!active) return;
      retire();
      listener.onDisconnect();
    };
    const unwatch = watchPageResume(disconnect);
    socket.onopen = () => {
      if (active) listener.onOpen();
    };
    socket.onmessage = (event) => {
      if (!active) return;
      if (typeof event.data !== 'string') {
        this.invalidBody('websocket');
        return;
      }
      const decoded = decodeRemoteServerMessage(event.data);
      if (decoded.status === 'rejected') {
        this.invalidBody('websocket');
        return;
      }
      this.observe({ direction: 'inbound', channel: 'websocket', message: decoded.value });
      listener.onMessage(decoded.value);
    };
    socket.onclose = () => {
      disconnect();
    };
    socket.onerror = () => {
      if (!active) return;
      this.diagnostic({
        source: 'websocket', code: 'connection_failed',
        message: 'Relay WebSocket connection failed.', recoverable: true,
      });
      disconnect();
    };
    return {
      send: (message) => {
        if (!active || (socket.readyState !== undefined && socket.readyState !== 1)) throw new Error('Remote WebSocket connection is closed.');
        const encoded = encodeClientMessage(message);
        if (encoded.status === 'rejected') throw new Error('Client message was rejected by the public protocol.');
        socket.send(encoded.json);
        this.observe({ direction: 'outbound', channel: 'websocket', message });
      },
      close: retire,
    };
  }

  onDiagnostic(listener: (diagnostic: RemoteTransportDiagnostic) => void): () => void {
    this.diagnosticListeners.add(listener);
    return () => this.diagnosticListeners.delete(listener);
  }

  onProtocolMessage(listener: (observation: RemoteProtocolObservation) => void): () => void {
    this.protocolListeners.add(listener);
    return () => this.protocolListeners.delete(listener);
  }

  private async fetchSession(
    path: string,
    request: ClientMessage,
    options?: RemoteRequestOptions,
  ): Promise<AgentSessionResponse> {
    const encoded = encodeClientMessage(request);
    if (encoded.status === 'rejected') throw new Error('Client message was rejected by the public protocol.');
    this.observe({ direction: 'outbound', channel: 'http', message: request });
    const message = await this.fetchServerMessage(path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: encoded.json,
    }, options);
    if (message.type !== 'agent_session') throw new Error('Relay response was invalid.');
    return message;
  }

  private async fetchServerMessage(path: string, init?: RequestInit, options?: RemoteRequestOptions) {
    const body = await this.fetchBody(path, init, options);
    this.throwIfHttpProtocolError(body);
    const decoded = decodeRemoteServerMessage(body);
    if (decoded.status === 'ok') {
      this.observe({ direction: 'inbound', channel: 'http', message: decoded.value });
      return decoded.value;
    }
    this.invalidBody('http');
    throw new Error('Relay response was invalid.');
  }

  private async fetchBody(
    path: string,
    init?: RequestInit,
    options?: RemoteRequestOptions,
  ): Promise<string> {
    let response: Response;
    try {
      response = await waitForAbort(this.fetchImplementation(this.httpUrl(path), {
        ...init,
        signal: options?.signal,
      }), options?.signal);
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      if (!options?.signal?.aborted) {
        this.diagnostic({
          source: 'http', code: 'request_failed',
          message: 'Relay request could not be completed.', recoverable: true,
        });
      }
      throw new RemoteOperationError('network_error', 'Could not reach the Relay. Check your connection and try again.', true);
    }
    if (options?.signal?.aborted) throw new Error('Relay request was retired.');
    let body: string;
    try {
      body = await waitForAbort(response.text(), options?.signal);
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      this.diagnostic({
        source: 'http', code: 'response_body_failed',
        message: 'Relay response body could not be read.', recoverable: true,
      });
      throw new Error('Relay response body failed.');
    }
    if (response.ok) return body;

    const decoded = decodeRemoteServerMessage(body);
    if (decoded.status === 'ok' && decoded.value.type === 'protocol_error') {
      this.observe({ direction: 'inbound', channel: 'http', message: decoded.value });
      this.throwProtocolError(decoded.value);
    }
    const failure = httpFailure(response.status, body);
    this.diagnostic({ source: 'http', code: failure.code, message: failure.message, recoverable: failure.recoverable });
    throw failure;
  }

  private httpUrl(path: string): string {
    return new URL(path, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`).toString();
  }

  private websocketUrl(path: string): string {
    const url = new URL(this.httpUrl(path));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  private invalidBody(source: RemoteTransportDiagnostic['source']): void {
    this.diagnostic({
      source, code: 'invalid_wire_body',
      message: 'Relay response was rejected by the public protocol.', recoverable: true,
    });
  }

  private throwIfHttpProtocolError(body: string): void {
    const decoded = decodeRemoteServerMessage(body);
    if (decoded.status === 'ok' && decoded.value.type === 'protocol_error') {
      this.observe({ direction: 'inbound', channel: 'http', message: decoded.value });
      this.throwProtocolError(decoded.value);
    }
  }

  private throwProtocolError(message: Extract<RemoteServerMessage, { type: 'protocol_error' }>): never {
    this.diagnostic({
      source: 'http',
      code: message.payload.code,
      message: message.payload.message,
      recoverable: message.payload.recoverable,
    });
    throw new RemoteOperationError(
      message.payload.code,
      message.payload.message,
      message.payload.recoverable,
      message.payload.requestId,
    );
  }

  private observe(observation: RemoteProtocolObservation): void {
    const message = observation.message;
    if ('controlToken' in message || message.type === 'session_control' || message.type === 'session_control_request') {
      const redacted = structuredClone(message);
      if ('controlToken' in redacted) delete redacted.controlToken;
      if (redacted.type === 'session_control') delete redacted.payload.token;
      if (redacted.type === 'session_control_request') delete redacted.payload.resumeToken;
      observation = { ...observation, redacted: true, message: redacted };
    }
    if (observation.direction === 'outbound' && observation.message.type === 'interaction_response') {
      const message = observation.message;
      let response = message.payload.response;
      if (response.kind === 'question') response = { ...response, answers: response.answers.map(({ questionId }) => ({ questionId, selectedValues: [], redacted: true })) };
      else if (response.kind === 'form' && response.action === 'submit') response = { ...response, values: {}, redactedFields: Object.keys(response.values) };
      else if (response.kind === 'plan_approval' && response.action === 'reject' && response.feedback !== undefined) response = { ...response, feedback: '[redacted]' };
      else if (response.kind === 'tool_approval' && response.decision !== 'allow' && response.message !== undefined) response = { ...response, message: '[redacted]' };
      observation = { ...observation, redacted: true, message: { ...message, payload: { ...message.payload, response } } };
    }
    for (const listener of this.protocolListeners) {
      try {
        listener(observation);
      } catch {
        // Protocol observers are presentation hooks and cannot change transport delivery.
      }
    }
  }

  private diagnostic(diagnostic: RemoteTransportDiagnostic): void {
    for (const listener of this.diagnosticListeners) {
      try {
        listener(diagnostic);
      } catch {
        // Diagnostic observers cannot change transport delivery.
      }
    }
  }
}

function decodeRemoteServerMessage(json: string) {
  const decoded = decodeServerMessage(json);
  if (decoded.status === 'ok') return decoded;
  const incompatible = decodeIncompatibleProtocolVersionError(json);
  return incompatible.status === 'ok' ? incompatible : decoded;
}

function waitForAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(signal.reason ?? new Error('Remote request was retired.'));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error !== undefined) reject(error); else resolve(value as T);
    };
    const onAbort = () => finish(signal.reason ?? new Error('Remote request was retired.'));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then((value) => finish(undefined, value), (error) => finish(error));
  });
}

function httpFailure(status: number, body: string): RemoteOperationError {
  let detail: { code?: unknown; error?: unknown; requestId?: unknown } | undefined;
  try {
    const value: unknown = JSON.parse(body);
    if (value && typeof value === 'object' && !Array.isArray(value)) detail = value;
  } catch { /* Proxy HTML is not a user-facing diagnostic. */ }
  const fallback = status === 401 ? 'Sign in again to read this session.'
    : status === 403 ? 'Access to this session is unavailable.'
    : status === 413 ? 'The requested data exceeds the Relay transfer limit.'
    : 'The Relay could not complete this request.';
  return new RemoteOperationError(
    typeof detail?.code === 'string' && detail.code ? detail.code : `http_${status}`,
    typeof detail?.error === 'string' && detail.error.trim() && detail.error !== 'Relay request failed.'
      ? detail.error : `${fallback} (HTTP ${status})`,
    status >= 500 || status === 408 || status === 429,
    typeof detail?.requestId === 'string' ? detail.requestId : undefined,
  );
}

function stableIdentity(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableIdentity).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableIdentity((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}

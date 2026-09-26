import type { AgentHistoryQuery, AgentHistoryPage } from '@orchardworks/agent-provider-sdk';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  AgentCapabilities,
  AgentInteractionRequest,
  AgentInteractionResponse,
  AgentProviderAdapter,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  ProviderObservation,
  ProviderStreamItem,
} from '@orchardworks/agent-provider-sdk';

import { createProtocolValidationServer } from '../server.js';

const LAB_ORIGIN = process.env.AGENT_REMOTE_ORIGIN ?? 'http://127.0.0.1:6175';
const PROVIDER_ID = 'recorded';
const resourceBytes = new TextEncoder().encode('BORgee Agent Remote durable resource\n');

const defaultCapabilities: AgentCapabilities = {
  history: true,
  sendMessage: true,
  steer: true,
  cancel: true,
  readResource: true,
  interactions: { question: true, planApproval: true, toolApproval: true },
};

export interface RecordedLabController {
  advance(sessionId: string): void;
  fail(sessionId: string): void;
  waitForDeferredSteer(sessionId: string): Promise<void>;
  releaseDeferredSteer(sessionId: string): void;
  rehydrate(sessionId: string): void;
  stopResourceReader(sessionId: string): void;
}

export interface RecordedLabProviderOptions {
  capabilities?: Partial<Omit<AgentCapabilities, 'interactions'>> & {
    interactions?: Partial<AgentCapabilities['interactions']>;
  };
  deferSteerObservation?: boolean;
}

export function createRecordedLabProvider(options: RecordedLabProviderOptions = {}): {
  provider: AgentProviderAdapter;
  controller: RecordedLabController;
} {
  const sessions = new Map<string, RecordedLabSession>();
  const sessionCapabilities: AgentCapabilities = {
    ...defaultCapabilities,
    ...options.capabilities,
    interactions: {
      ...defaultCapabilities.interactions,
      ...options.capabilities?.interactions,
    },
  };
  const provider: AgentProviderAdapter = {
    descriptor: { providerId: PROVIDER_ID, displayName: 'Recorded semantic Provider' },
    async readSessionHistory(id, query) { return requireSession(sessions, id).historyPage(query); },
    async createSession(config) {
      return openSession(config);
    },
    async resumeSession(handle) {
      if (handle.providerId !== PROVIDER_ID || handle.opaque !== persistenceOpaque(handle.sessionId)) {
        throw new Error('Recorded persistence handle does not match this Provider.');
      }
      return openSession({ sessionId: handle.sessionId });
    },
  };
  function openSession(config: AgentSessionConfig): RecordedLabSession {
    if (sessions.has(config.sessionId)) {
      throw new Error(`Recorded Lab session already exists: ${config.sessionId}`);
    }
    let session: RecordedLabSession;
    session = new RecordedLabSession(
      config.sessionId,
      config,
      sessionCapabilities,
      options.deferSteerObservation ?? false,
      () => {
        if (sessions.get(config.sessionId) === session) sessions.delete(config.sessionId);
      },
    );
    sessions.set(config.sessionId, session);
    return session;
  }
  return {
    provider,
    controller: {
      advance(sessionId) { requireSession(sessions, sessionId).advance(); },
      fail(sessionId) { requireSession(sessions, sessionId).fail(); },
      waitForDeferredSteer(sessionId) { return requireSession(sessions, sessionId).waitForDeferredSteer(); },
      releaseDeferredSteer(sessionId) { requireSession(sessions, sessionId).releaseDeferredSteer(); },
      rehydrate(sessionId) { requireSession(sessions, sessionId).rehydrate(); },
      stopResourceReader(sessionId) { requireSession(sessions, sessionId).stopResourceReader(); },
    },
  };
}

class RecordedLabSession implements AgentSession {
  private readonly history: Array<{ id: string; turnId: string; role: string; text: string }> = [];
  private readonly stream = new AsyncQueue<ProviderStreamItem>();
  private readonly pending = new Map<string, AgentInteractionRequest>();
  private nextSource = 100;
  private readerActive = true;
  private closed = false;
  private readonly deferredSteers: Array<{
    text: string;
    accepted: boolean;
    notification: NodeJS.Immediate;
  }> = [];
  private readonly deferredSteerWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>();

  constructor(
    private readonly sessionId: string,
    private readonly config: AgentSessionConfig,
    readonly capabilities: AgentCapabilities,
    private readonly deferSteerObservation: boolean,
    private readonly onDispose: () => void,
  ) {
    for (const observation of recordedHistory(sessionId)) { this.remember(observation.event); this.stream.push(observation); }
    this.stream.push({ type: 'history_boundary' });
  }

  observe(): AsyncIterable<ProviderStreamItem> {
    return this.stream;
  }

  historyPage(query: AgentHistoryQuery): AgentHistoryPage {
    const entries = this.history.filter(entry => !query.query || entry.text.toLowerCase().includes(query.query.toLowerCase())).slice().reverse();
    const offset = Number(query.cursor ?? 0), limit = query.limit ?? 5, textOffset = query.textOffset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid recorded cursor.');
    return { entries: entries.slice(offset, offset + limit).map(entry => ({ ...entry, text: entry.text.slice(textOffset, textOffset + 6000), totalChars: entry.text.length, textOffset })),
      ...(entries.length > offset + limit ? { nextCursor: String(offset + limit) } : {}) };
  }

  private remember(event: AgentStreamEvent): void {
    if (event.type !== 'timeline' || !['user_message', 'assistant_message'].includes(event.item.type)) return;
    const item = event.item;
    if (item.type === 'user_message' || item.type === 'assistant_message') this.history.push({ id: String(this.history.length), turnId: 'recorded-turn', role: item.type, text: item.text });
  }

  async sendMessage(text: string): Promise<void> {
    this.assertOpen();
    this.emitTimeline({ type: 'user_message', text, clientMessageId: `message-${this.nextSource}` });
    this.emitTimeline({ type: 'assistant_message', text: `Recorded reply: ${text}`, messageId: `reply-${this.nextSource}` });
  }

  async steer(text: string): Promise<void> {
    this.assertOpen();
    if (this.deferSteerObservation) {
      const deferred = {
        text,
        accepted: false,
        notification: setImmediate(() => {
          deferred.accepted = true;
          for (const waiter of this.deferredSteerWaiters) waiter.resolve();
          this.deferredSteerWaiters.clear();
        }),
      };
      this.deferredSteers.push(deferred);
      return;
    }
    this.emitTimeline({ type: 'reasoning', text: `Steered: ${text}` });
  }

  async cancel(): Promise<void> {
    this.assertOpen();
    for (const requestId of this.pending.keys()) {
      this.emit({ type: 'interaction_invalidated', provider: PROVIDER_ID, requestId, reason: 'Canceled from the Lab.' });
    }
    this.pending.clear();
    this.emit({ type: 'turn_canceled', provider: PROVIDER_ID, reason: 'Canceled from the Lab.', turnId: 'recorded-turn' });
  }

  async respondToInteraction(requestId: string, response: AgentInteractionResponse): Promise<void> {
    this.assertOpen();
    const request = this.pending.get(requestId);
    if (!request || request.kind !== response.kind) throw new Error('Recorded interaction response does not match a pending request.');
    this.pending.delete(requestId);
    this.emit({ type: 'interaction_resolved', provider: PROVIDER_ID, requestId, response });
    if (requestId === 'recorded-question') this.request(planRequest());
    else if (requestId === 'recorded-plan') this.request(toolOnceRequest());
    else if (requestId === 'recorded-tool-once') this.request(toolDenyRequest());
    else this.emitTimeline({ type: 'assistant_message', text: 'All recorded interactions resolved.', messageId: 'interactions-complete' });
  }

  async readResource(locator: string) {
    if (!this.readerActive) return { status: 'unavailable' as const, reason: 'Recorded Provider resource reader is stopped.' };
    if (locator === 'artifacts/failed.txt') throw new Error('Recorded resource acquisition failed.');
    if (locator !== 'artifacts/lab-proof.txt') {
      return { status: 'unavailable' as const, reason: 'Recorded resource is unavailable.' };
    }
    return { status: 'available' as const, bytes: resourceBytes, mediaType: 'text/plain' };
  }

  async runtimeInfo(): Promise<AgentRuntimeInfo> {
    return {
      providerId: PROVIDER_ID,
      sessionId: this.sessionId,
      status: 'idle',
      ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
      model: this.config.model ?? 'recorded-model',
      mode: 'deterministic',
      persistence: {
        providerId: PROVIDER_ID,
        sessionId: this.sessionId,
        opaque: persistenceOpaque(this.sessionId),
      },
    };
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const error = new Error('Recorded Lab session is closed.');
    for (const waiter of this.deferredSteerWaiters) waiter.reject(error);
    this.deferredSteerWaiters.clear();
    for (const deferred of this.deferredSteers) clearImmediate(deferred.notification);
    this.deferredSteers.splice(0);
    this.stream.close();
    this.onDispose();
  }

  waitForDeferredSteer(): Promise<void> {
    this.assertOpen();
    if (this.deferredSteers.some(({ accepted }) => accepted)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.deferredSteerWaiters.add({ resolve, reject });
    });
  }

  releaseDeferredSteer(): void {
    this.assertOpen();
    const index = this.deferredSteers.findIndex(({ accepted }) => accepted);
    if (index === -1) throw new Error('Recorded deferred steer is not pending.');
    const [deferred] = this.deferredSteers.splice(index, 1);
    if (!deferred) throw new Error('Recorded deferred steer is not pending.');
    clearImmediate(deferred.notification);
    this.emitTimeline({ type: 'reasoning', text: `Steered: ${deferred.text}` });
  }

  advance(): void {
    this.assertOpen();
    this.emit({ type: 'turn_started', provider: PROVIDER_ID, turnId: 'recorded-turn' });
    this.emitTimeline({ type: 'assistant_message', text: 'Live recorded output.', messageId: 'live-message' }, 'recorded-turn');
    this.emitTimeline({ type: 'reasoning', text: 'Checking the deterministic fixture.' }, 'recorded-turn');
    this.emitTimeline({
      type: 'tool_call', callId: 'recorded-tool', name: 'read',
      detail: { type: 'read', filePath: 'fixtures/input.txt' }, status: 'running', error: null,
    }, 'recorded-turn');
    this.emitTimeline({
      type: 'tool_call', callId: 'recorded-tool', name: 'read',
      detail: { type: 'read', filePath: 'fixtures/input.txt' }, status: 'completed', error: null,
    }, 'recorded-turn');
    this.emitTimeline({
      type: 'todo', items: [
        { id: 'inspect', text: 'Inspect fixture', completed: true, status: 'completed' },
        { id: 'report', text: 'Report result', completed: false, status: 'in_progress' },
      ],
    }, 'recorded-turn');
    this.emit({ type: 'turn_completed', provider: PROVIDER_ID, turnId: 'recorded-turn' });
    this.request(questionRequest());
  }

  fail(): void {
    this.assertOpen();
    this.emit({
      type: 'turn_failed',
      provider: PROVIDER_ID,
      error: 'Recorded deterministic failure.',
      code: 'recorded_failure',
    });
  }

  rehydrate(): void {
    this.assertOpen();
    this.emitTimeline({
      type: 'assistant_message',
      text: 'Authoritative rehydrated Timeline. Download [lab-proof.txt](artifacts/lab-proof.txt).',
      messageId: 'rehydrated-message',
    });
  }

  stopResourceReader(): void {
    this.readerActive = false;
  }

  private request(request: AgentInteractionRequest): void {
    this.pending.set(request.requestId, request);
    this.emit({ type: 'interaction_requested', provider: PROVIDER_ID, request });
  }

  private emitTimeline(item: Extract<AgentStreamEvent, { type: 'timeline' }>['item'], turnId?: string): void {
    this.emit({
      type: 'timeline', provider: PROVIDER_ID, item,
      ...(turnId ? { turnId } : {}),
    });
  }

  private emit(event: AgentStreamEvent): void {
    this.remember(event);
    this.stream.push({
      type: 'observation',
      sourceKey: `recorded-live-${this.nextSource++}`,
      occurredAt: Date.UTC(2026, 8, 2, 1, 0, this.nextSource),
      delivery: 'live',
      event,
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Recorded Lab session is closed.');
  }
}

function recordedHistory(sessionId: string): ProviderObservation[] {
  const items: Extract<AgentStreamEvent, { type: 'timeline' }>['item'][] = [
    { type: 'user_message', text: 'Recorded history 1', messageId: `${sessionId}-history-1` },
    { type: 'assistant_message', text: 'Recorded history 2', messageId: `${sessionId}-history-2` },
    { type: 'reasoning', text: 'Recorded history 3' },
    {
      type: 'tool_call', callId: `${sessionId}-history-tool`, name: 'search',
      detail: { type: 'search', query: 'history' }, status: 'completed', error: null,
    },
    { type: 'todo', items: [{ text: 'Recorded history 5', completed: false, status: 'pending' }] },
    {
      type: 'assistant_message', messageId: `${sessionId}-resource`,
      text: 'Download [lab-proof.txt](artifacts/lab-proof.txt). Missing [file](artifacts/missing.txt). Failed [file](artifacts/failed.txt).',
    },
  ];
  return items.map((item, index) => ({
    type: 'observation',
    sourceKey: `recorded-history-${index + 1}`,
    occurredAt: Date.UTC(2026, 8, 2, 0, 0, index),
    delivery: 'history',
    event: { type: 'timeline', provider: PROVIDER_ID, item },
  }));
}

function questionRequest(): Extract<AgentInteractionRequest, { kind: 'question' }> {
  return {
    kind: 'question', requestId: 'recorded-question',
    questions: [{
      questionId: 'release', header: 'Release channel', prompt: 'Select channels to continue.',
      description: 'This covers both single and multiple selection fields.', required: true,
      selection: 'multiple',
      options: [
        { value: 'stable', label: 'Stable (Recommended)' },
        { value: 'preview', label: 'Preview' },
      ],
      allowCustomText: true, allowDismiss: false,
    }],
  };
}

function planRequest(): Extract<AgentInteractionRequest, { kind: 'plan_approval' }> {
  return {
    kind: 'plan_approval', requestId: 'recorded-plan',
    plan: '1. Verify the shared stack.\n2. Continue with the recorded Provider.',
    allowedActions: ['approve', 'reject'],
  };
}

function toolOnceRequest(): Extract<AgentInteractionRequest, { kind: 'tool_approval' }> {
  return {
    kind: 'tool_approval', requestId: 'recorded-tool-once', toolCallId: 'recorded-write',
    toolName: 'write', summary: 'Write the deterministic result.',
    detail: { type: 'write', filePath: 'artifacts/result.txt' },
    allowedDecisions: ['allow', 'deny'], allowScopes: ['once'],
  };
}

function toolDenyRequest(): Extract<AgentInteractionRequest, { kind: 'tool_approval' }> {
  return {
    kind: 'tool_approval', requestId: 'recorded-tool-deny', toolCallId: 'recorded-delete',
    toolName: 'delete', summary: 'Reject a destructive fixture action.',
    detail: { type: 'other', description: 'Delete the deterministic fixture.' },
    allowedDecisions: ['deny'], allowScopes: [],
  };
}

function persistenceOpaque(sessionId: string): string {
  return `recorded:${sessionId}`;
}

function requireSession(sessions: Map<string, RecordedLabSession>, sessionId: string): RecordedLabSession {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Recorded Lab session was not found: ${sessionId}`);
  return session;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly readers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const reader = this.readers.shift();
    if (reader) reader({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const reader of this.readers.splice(0)) reader({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.readers.push(resolve));
      },
    };
  }
}

export function createRecordedValidationServer(options: RecordedLabProviderOptions = {}) {
  const { provider, controller } = createRecordedLabProvider(options);
  const server = createProtocolValidationServer({ providers: [provider], labOrigin: LAB_ORIGIN });
  attachFixtureControls(server, controller);
  return { ...server, recorded: controller };
}

export function attachFixtureControls(
  server: ReturnType<typeof createProtocolValidationServer>,
  controller: RecordedLabController,
): void {
  const [relayRequest] = server.http.server.listeners('request') as Array<(
    request: IncomingMessage,
    response: ServerResponse,
  ) => void>;
  if (!relayRequest) throw new Error('Relay request handler is missing.');
  server.http.server.removeListener('request', relayRequest);
  server.http.server.on('request', (request, response) => {
    const url = new URL(request.url ?? '/', 'http://relay.local');
    const match = /^\/v1\/lab\/recorded\/([^/]+)\/(advance|fail|rehydrate|stop-reader)$/.exec(url.pathname);
    if (!match) {
      relayRequest(request, response);
      return;
    }
    if (request.method !== 'POST' || request.headers.origin !== LAB_ORIGIN) {
      response.writeHead(request.method === 'POST' ? 403 : 405).end();
      return;
    }
    let sessionId: string;
    try {
      const agentId = decodeURIComponent(match[1] as string);
      const agent = server.relay.requireAgent(agentId);
      sessionId = agent.snapshot().payload.runtimeInfo.sessionId ?? agentId;
      const action = match[2];
      if (action === 'advance') controller.advance(sessionId);
      else if (action === 'fail') controller.fail(sessionId);
      else if (action === 'rehydrate') {
        agent.replaceTimeline(`recorded-rehydrated-${Date.now()}`);
        controller.rehydrate(sessionId);
      } else controller.stopResourceReader(sessionId);
      response.writeHead(204).end();
    } catch {
      response.writeHead(404).end();
    }
  });
}

const entry = process.argv[1] === undefined ? undefined : new URL(`file://${process.argv[1]}`).href;
if (entry === import.meta.url) {
  const server = createRecordedValidationServer();
  const address = await server.http.listen(Number(process.env.AGENT_REMOTE_PORT ?? 5910), '127.0.0.1');
  process.stdout.write(`Recorded Agent Remote relay listening on ${address.url}\n`);
  const close = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
}

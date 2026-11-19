import { AgentOperationRejectedError } from '@orchardworks/agent-provider-sdk';

import type {
  AgentCapabilities,
  AgentInteractionRequest,
  AgentInteractionResponse,
  AgentPersistenceHandle,
  AgentProviderAdapter,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  ProviderStreamItem,
} from '@orchardworks/agent-provider-sdk';
import {
  decodeAgentSessionResponse,
  decodeAgentSnapshot,
  decodeHistoryPage,
  decodeProviderListResponse,
  decodeServerMessage,
  encodeCreateAgentRequest,
  encodeResumeAgentRequest,
} from '@orchardworks/agent-remote-protocol';
import { afterEach, expect, vi } from 'vitest';
import WebSocket, { type RawData } from 'ws';
import { memoryHttp, type MemoryHttp } from '@orchardworks/agent-session-runtime/testing';

import {
  AgentReplica,
  HttpWebSocketTransport,
  RemoteSessionClient,
  type RemoteProtocolObservation,
  type RemoteSessionStatus,
  type WebSocketLike,
} from '@orchardworks/agent-client';
import type { AgentRemoteRelay } from '@orchardworks/agent-session-runtime';
import { createAgentRemoteRelay } from '@orchardworks/agent-session-runtime';
import type { AgentRemoteHttpServer } from '@orchardworks/agent-session-runtime';
import { createAgentRemoteHttpServer } from '@orchardworks/agent-session-runtime';
import type { AgentRemoteWebSocketAuthorizer } from '@orchardworks/agent-session-runtime';

/**
 * The Runtime HTTP server's seam fixture: a Relay with a scripted Provider behind `createAgentRemoteHttpServer`. By default it is
 * reached in memory (`memoryHttp`: real HTTP parsing and WebSocket framing over in-memory sockets, no port); `{ listener: true }`
 * binds a port for the tests that are about the socket itself (`tests/transport/runtime-http-server.transport.test.ts`).
 */

const capabilities: AgentCapabilities = {
  history: true,
  sendMessage: true,
  steer: false,
  cancel: false,
  readResource: false,
  interactions: { question: true, planApproval: true, toolApproval: true },
};

export const closeables: Array<() => Promise<void>> = [];

export const interactionCases: Array<{
  kind: AgentInteractionRequest['kind'];
  request: AgentInteractionRequest;
  response: AgentInteractionResponse;
  invalid: AgentInteractionResponse;
  malformed: unknown;
}> = [
  {
    kind: 'question',
    request: {
      kind: 'question', requestId: 'question-one',
      questions: [{
        questionId: 'runtime', header: 'Runtime', prompt: 'Choose a runtime.', required: true,
        selection: 'single', options: [{ value: 'web', label: 'Web' }],
        allowCustomText: false, allowDismiss: false,
      }],
    },
    response: { kind: 'question', answers: [{ questionId: 'runtime', selectedValues: ['web'] }] },
    invalid: { kind: 'question', answers: [{ questionId: 'runtime', selectedValues: ['unknown'] }] },
    malformed: { kind: 'question', answers: [{ questionId: 'runtime', selectedValues: ['web', 'web'] }] },
  },
  {
    kind: 'plan_approval',
    request: {
      kind: 'plan_approval', requestId: 'plan-one', plan: 'Update the documentation.',
      allowedActions: ['reject', 'approve_and_resume'],
    },
    response: { kind: 'plan_approval', action: 'reject', feedback: 'Include recovery examples.' },
    invalid: { kind: 'plan_approval', action: 'approve' },
    malformed: { kind: 'plan_approval', action: 'approve', feedback: 'Not valid on approval.' },
  },
  {
    kind: 'tool_approval',
    request: {
      kind: 'tool_approval', requestId: 'tool-one', toolCallId: 'call-one', toolName: 'read',
      summary: 'Read the documentation.', detail: { type: 'read', filePath: '/workspace/guide.md' },
      allowedDecisions: ['allow'], allowScopes: ['once'],
    },
    response: { kind: 'tool_approval', decision: 'allow', scope: 'once' },
    invalid: { kind: 'tool_approval', decision: 'allow', scope: 'session' },
    malformed: { kind: 'tool_approval', decision: 'allow' },
  },
];

interactionCases.push(
  {
    kind: 'form',
    request: { kind: 'form', requestId: 'form-one', title: 'Count', message: '', fields: [{ type: 'number', fieldId: 'count', label: 'Count', required: true, integer: true, minimum: 1, maximum: 3 }] },
    response: { kind: 'form', action: 'submit', values: { count: 2 } },
    invalid: { kind: 'form', action: 'submit', values: { count: 4 } },
    malformed: { kind: 'form', action: 'submit', values: { count: { nested: true } } },
  },
  {
    kind: 'permission_approval',
    request: { kind: 'permission_approval', requestId: 'permission-one', summary: 'Read project', permissions: [{ resource: 'filesystem', access: 'read', target: '/workspace' }], allowScopes: ['turn'] },
    response: { kind: 'permission_approval', decision: 'allow', scope: 'turn' },
    invalid: { kind: 'permission_approval', decision: 'allow', scope: 'session' },
    malformed: { kind: 'permission_approval', decision: 'allow' },
  },
  {
    kind: 'external_action',
    request: { kind: 'external_action', requestId: 'external-one', title: 'Authenticate', message: 'Complete authentication', url: 'https://example.com/auth' },
    response: { kind: 'external_action', action: 'completed' },
    invalid: { kind: 'form', action: 'cancel' },
    malformed: { kind: 'external_action', action: 'navigate' },
  },
);


export interface StartOptions { /** Bind a real port instead of the in-memory network. */ listener?: true }
const networks = new Map<string, MemoryHttp>();
let networkCount = 0;
const networkOf = (url: string) => networks.get(new URL(url).host);

/** `fetch` to a server `start` returned: through its memory network, or the real one when it listens. */
export const relayFetch: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return (networkOf(url)?.fetch ?? fetch)(input, init);
};
/** A WebSocket client to a server `start` returned. */
export const socketTo = (url: string): WebSocket => networkOf(url)?.webSocket(url) ?? new WebSocket(url);
/** `vi.waitFor` polling every 2 ms: nothing here waits on a real network. */
export const waitFor = <T>(check: () => T | Promise<T>) => vi.waitFor(check, { interval: 2 });

afterEach(async () => {
  await Promise.all(closeables.splice(0).reverse().map((close) => close()));
});

/** An accepted interaction response survives a lost socket: the Provider got it once, and the client sees it completed after reconnect. */
export async function recoversInFlightResponse(request: AgentInteractionRequest, response: AgentInteractionResponse, options: StartOptions = {}) {
  const context = await startInteraction(request, options);
  const connected = await connectInteractionClient(context.url);
  const submission = deferred();
  const original = context.session.respondToInteraction.bind(context.session);
  const submit = vi.spyOn(context.session, 'respondToInteraction').mockImplementation(async (id, value) => {
    await submission.promise;
    await original(id, value);
  });
  const pending = connected.client.respondToInteraction(request.requestId, response);
  const disconnected = expect(pending).rejects.toMatchObject({ code: 'connection_disconnected' });
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  connected.socket().terminate();
  await disconnected;

  submission.resolve();
  await waitFor(() => expect(context.session.interactionResponses).toEqual([{ requestId: request.requestId, response }]));
  context.resolve(response);
  await waitFor(async () => {
    expect((await connected.transport.fetchSnapshot('agent-interaction')).payload.pendingInteractions).toEqual([]);
  });
  await connected.reconnect();
  await connected.ready();
  expectCompleted(connected.replica, request, response);

  const fresh = await connectInteractionClient(context.url);
  expectCompleted(fresh.replica, request, response);
  expect(submit).toHaveBeenCalledOnce();
  expect(connected.observations.filter((event) => event.direction === 'outbound'
    && event.message.type === 'interaction_response')).toHaveLength(1);
}


export async function startInteraction(request: AgentInteractionRequest, options: StartOptions = {}) {
  const context = await start([{
    type: 'observation', sourceKey: 'request-one', occurredAt: 1, delivery: 'live',
    event: { type: 'interaction_requested', provider: 'fake', request },
  }], undefined, options);
  await new HttpWebSocketTransport(context.url, { fetch: relayFetch }).createAgent('agent-interaction', 'fake', { sessionId: 'session-interaction' });
  return {
    ...context,
    session: context.provider.requireSession('session-interaction'),
    resolve(response: AgentInteractionResponse) {
      context.provider.emit('session-interaction', {
        type: 'observation', sourceKey: 'resolved-one', occurredAt: 2, delivery: 'live',
        event: { type: 'interaction_resolved', provider: 'fake', requestId: request.requestId, response },
      });
    },
  };
}

export async function connectInteractionClient(url: string, fetchImplementation?: typeof fetch, waitForReady = true) {
  const sockets: WebSocket[] = [];
  const observations: RemoteProtocolObservation[] = [];
  let status: RemoteSessionStatus = 'idle';
  let reconnect: (() => void) | undefined;
  const transport = new HttpWebSocketTransport(url, {
    fetch: fetchImplementation ?? relayFetch,
    webSocketFactory: (socketUrl) => {
      const socket = socketTo(socketUrl);
      sockets.push(socket);
      return socket as unknown as WebSocketLike;
    },
  });
  transport.onProtocolMessage((observation) => observations.push(observation));
  const replica = new AgentReplica();
  const client = new RemoteSessionClient('agent-interaction', transport, replica, {
    timelineRecovery: fetchImplementation ? 'http' : 'websocket',
    operationTimeoutMs: 5_000,
    scheduleReconnect: (_delay, restart) => {
      reconnect = restart;
      return () => { reconnect = undefined; };
    },
  });
  client.subscribeStatus((next) => { status = next; });
  closeables.push(async () => { client.stop(); });
  client.start();
  const ready = () => waitFor(() => expect(status).toBe('ready'));
  if (waitForReady) await ready();
  return {
    client, transport, replica, observations, ready,
    socket: () => sockets.at(-1)!,
    reconnect: async () => {
      await waitFor(() => expect(reconnect).toBeTypeOf('function'));
      reconnect!();
    },
  };
}

export function expectCompleted(replica: AgentReplica, request: AgentInteractionRequest, response: AgentInteractionResponse): void {
  expect(replica.getState().pendingInteractions).toEqual([]);
  expect(replica.getState().timeline.entries.map((entry) => entry.item)).toEqual([{ type: 'interaction', request, response }]);
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export function createRequest(agentId: string, sessionId: string) {
  return {
    protocolVersion: '1.8.0' as const,
    type: 'create_agent' as const,
    payload: { requestId: `create-${agentId}`, operationId: '00000000-0000-4000-8000-000000000003', agentId, providerId: 'fake', config: { sessionId } },
  };
}

export async function openSocket(url: string): Promise<WebSocket> {
  const socket = socketTo(url);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

export function collectMessages(socket: WebSocket, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const messages: string[] = [];
    const onMessage = (data: RawData): void => {
      messages.push(data.toString());
      if (messages.length !== count) return;
      cleanup();
      resolve(messages);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error(`WebSocket closed after ${messages.length} of ${count} expected messages.`));
    };
    const cleanup = (): void => {
      socket.off('message', onMessage);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    socket.on('message', onMessage);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

export async function start(
  history: readonly ProviderStreamItem[] = [],
  authorizer: AgentRemoteWebSocketAuthorizer | null = {
    authenticate: () => ({ subject: 'local-test' }),
    authorize: () => true,
  },
  options: StartOptions = {},
): Promise<{
  provider: TestProvider;
  relay: AgentRemoteRelay;
  server: AgentRemoteHttpServer;
  url: string;
}> {
  const provider = new TestProvider(history);
  const relay = createAgentRemoteRelay({ providers: [provider], epoch: () => 'epoch-http' });
  const server = authorizer === null
    ? createAgentRemoteHttpServer(relay)
    : createAgentRemoteHttpServer(relay, { websocketAuthorizer: authorizer });
  closeables.push(async () => {
    await server.close();
    await relay.close();
  });
  if (options.listener) return { provider, relay, server, url: (await server.listen(0, '127.0.0.1')).url };
  const host = `relay-${++networkCount}.test`;
  networks.set(host, memoryHttp(server.server));
  closeables.push(async () => { networks.get(host)?.close(); networks.delete(host); });
  return { provider, relay, server, url: `http://${host}` };
}

export function timelineObservation(
  sourceKey: string,
  text: string,
  occurredAt: number,
  delivery: 'history' | 'live' = 'live',
): ProviderStreamItem {
  return {
    type: 'observation', sourceKey, occurredAt, delivery,
    event: {
      type: 'timeline', provider: 'fake', turnId: 'turn-1',
      item: { type: 'assistant_message', messageId: 'message-1', text },
    },
  };
}

export class TestProvider implements AgentProviderAdapter {
  readonly descriptor = { providerId: 'fake', displayName: 'Fake Agent' };
  private readonly sessions = new Map<string, TestSession>();

  constructor(private readonly history: readonly ProviderStreamItem[]) {}

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return this.createOwnedSession(config.sessionId, config.cwd);
  }

  async resumeSession(handle: AgentPersistenceHandle): Promise<AgentSession> {
    return this.createOwnedSession(handle.sessionId);
  }

  emit(sessionId: string, item: ProviderStreamItem): void {
    this.requireSession(sessionId).stream.push(item);
  }

  requireSession(sessionId: string): TestSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown test session: ${sessionId}`);
    return session;
  }

  private createOwnedSession(sessionId: string, cwd?: string): TestSession {
    const session = new TestSession(sessionId, cwd);
    for (const item of this.history) session.stream.push(structuredClone(item));
    session.stream.push({ type: 'history_boundary' });
    this.sessions.set(sessionId, session);
    return session;
  }
}

class TestSession implements AgentSession {
  readonly capabilities = capabilities;
  readonly stream = new ManualProviderStream();
  readonly interactionResponses: Array<{ requestId: string; response: AgentInteractionResponse }> = [];

  constructor(private readonly sessionId: string, private readonly cwd?: string) {}

  observe(): AsyncIterable<ProviderStreamItem> { return this.stream; }
  async sendMessage(): Promise<void> {}
  async respondToInteraction(requestId: string, response: AgentInteractionResponse): Promise<void> {
    this.interactionResponses.push({ requestId, response });
  }
  async runtimeInfo(): Promise<AgentRuntimeInfo> {
    return {
      providerId: 'fake', sessionId: this.sessionId, status: 'idle',
      ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
      persistence: { providerId: 'fake', sessionId: this.sessionId, opaque: `fake:${this.sessionId}` },
    };
  }
  async dispose(): Promise<void> { this.stream.finish(); }
}

class ManualProviderStream implements AsyncIterable<ProviderStreamItem> {
  private readonly values: ProviderStreamItem[] = [];
  private readonly waiters: Array<(result: IteratorResult<ProviderStreamItem>) => void> = [];
  private finished = false;

  push(value: ProviderStreamItem): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  finish(): void {
    this.finished = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<ProviderStreamItem> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { done: false, value };
        if (this.finished) return { done: true, value: undefined };
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

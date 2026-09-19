import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSession, ProviderStreamItem } from '@agent-remote-controller/agent-provider-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { CodexAppServerProvider } from './provider.js';
import { normalizeRecoverySettings } from './shared-recovery.js';
import { AgentManager } from '../../agent-remote-relay/dist/agent-manager.js';
import { createSessionWire } from '../../agent-remote-relay/dist/session-wire.js';
import { decodeServerMessage } from '../../agent-remote-protocol/dist/index.js';

interface NativeThread {
  id: string;
  status: { type: string; activeFlags?: string[] };
  canAcceptDirectInput: boolean;
  turns: Array<Record<string, unknown>>;
  parentThreadId?: string;
  approvalPolicy?: string;
}

interface RpcRequestContext {
  socket: WebSocket;
  connection: number;
  method: string;
  params: Record<string, unknown>;
}

type RpcOverride = { kind: 'result'; value: unknown } | { kind: 'error'; code: number; message: string };

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class UnixAppServer {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly nativeResponses: Array<{ id: string; result?: unknown; error?: unknown }> = [];
  readonly sockets = new Set<WebSocket>();
  thread: NativeThread = { id: 'root', status: { type: 'idle' }, canAcceptDirectInput: true, turns: [] };
  model = 'mock-model';
  supportsPlanning = false;
  readonly children = new Map<string, NativeThread>();
  threadReadError: { code: number; message: string } | undefined;
  requestHook: ((context: RpcRequestContext) => RpcOverride | undefined | Promise<RpcOverride | undefined>) | undefined;
  private server: Server | undefined;
  private websocketServer: WebSocketServer | undefined;
  private readonly connections = new Map<WebSocket, number>();
  private nextConnection = 0;

  constructor(readonly socketPath: string) {}

  async start(): Promise<void> {
    this.server = createServer();
    this.websocketServer = new WebSocketServer({ server: this.server });
    this.websocketServer.on('connection', socket => {
      this.sockets.add(socket);
      this.connections.set(socket, ++this.nextConnection);
      socket.on('close', () => {
        this.sockets.delete(socket);
        this.connections.delete(socket);
      });
      socket.on('message', data => void this.handle(socket, JSON.parse(data.toString()) as Record<string, unknown>));
    });
    this.server.listen(this.socketPath);
    await once(this.server, 'listening');
  }

  disconnectClients(): void {
    for (const socket of this.sockets) socket.terminate();
  }

  requestInteraction(nativeRequestId = 'native-question', threadId = 'root', connection?: number): void {
    for (const socket of this.selectedSockets(connection)) socket.send(JSON.stringify({
      id: nativeRequestId,
      method: 'item/tool/requestUserInput',
      params: {
        threadId, turnId: 'turn-question',
        questions: [{ id: 'choice', header: 'Choice', question: 'Choose', options: [{ label: 'One', description: 'One' }] }],
      },
    }));
  }

  notify(method: string, params: unknown, connection?: number): void {
    for (const socket of this.selectedSockets(connection)) socket.send(JSON.stringify({ method, params }));
  }

  resolveInteraction(nativeRequestId: string, threadId = 'root', connection?: number): void {
    this.notify('serverRequest/resolved', { threadId, requestId: nativeRequestId }, connection);
  }

  async stop(): Promise<void> {
    const websocketServer = this.websocketServer;
    const server = this.server;
    if (!websocketServer || !server) return;
    this.disconnectClients();
    await new Promise<void>(resolve => websocketServer.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    this.websocketServer = undefined;
    this.server = undefined;
  }

  private selectedSockets(connection?: number): WebSocket[] {
    return [...this.sockets].filter(socket => connection === undefined || this.connections.get(socket) === connection);
  }

  private async handle(socket: WebSocket, message: Record<string, unknown>): Promise<void> {
    if (typeof message.id === 'string' && typeof message.method !== 'string') {
      this.nativeResponses.push({ id: message.id, ...('result' in message ? { result: message.result } : {}),
        ...('error' in message ? { error: message.error } : {}) });
      return;
    }
    if (typeof message.id !== 'number' || typeof message.method !== 'string') return;
    const params = message.params && typeof message.params === 'object' ? message.params as Record<string, unknown> : {};
    this.requests.push({ method: message.method, params });
    const override = await this.requestHook?.({
      socket,
      connection: this.connections.get(socket) ?? 0,
      method: message.method,
      params,
    });
    if (override?.kind === 'error') {
      socket.send(JSON.stringify({ id: message.id, error: { code: override.code, message: override.message } }));
      return;
    }
    let result: unknown = {};
    if (override?.kind === 'result') result = override.value;
    else if (message.method === 'model/list') result = { data: [] };
    else if (message.method === 'configRequirements/read') result = { requirements: {} };
    else if (message.method === 'collaborationMode/list') {
      if (this.supportsPlanning) {
        socket.send(JSON.stringify({ id: message.id, result: { data: [{ mode: 'plan' }, { mode: 'default' }] } }));
        return;
      }
      socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'not supported' } }));
      return;
    } else if (message.method === 'thread/start') {
      result = { thread: structuredClone(this.thread), cwd: '/workspace', model: this.model };
    } else if (message.method === 'thread/read') {
      if (this.threadReadError) {
        socket.send(JSON.stringify({ id: message.id, error: this.threadReadError }));
        return;
      }
      const threadId = typeof params.threadId === 'string' ? params.threadId : 'root';
      result = { thread: structuredClone(threadId === 'root' ? this.thread : this.children.get(threadId)), cwd: '/workspace', model: this.model };
    } else if (message.method === 'thread/resume') {
      result = { thread: structuredClone(this.thread), cwd: '/workspace', model: this.model };
    } else if (message.method === 'turn/start') {
      result = { turn: { id: 'unexpected-turn' } };
    }
    socket.send(JSON.stringify({ id: message.id, result }));
  }
}

const roots: string[] = [];
const sessions: AgentSession[] = [];
const servers: UnixAppServer[] = [];
const managerCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(managerCleanups.splice(0).map(close => close()));
  await Promise.allSettled(sessions.splice(0).map(session => session.dispose()));
  await Promise.allSettled(servers.splice(0).map(server => server.stop()));
  await Promise.allSettled(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function harness(settings: NonNullable<ConstructorParameters<typeof CodexAppServerProvider>[0]>['sharedRecovery'] = {}, observe = true) {
  const root = await mkdtemp(join(tmpdir(), 'arc-shared-recovery-'));
  roots.push(root);
  const server = new UnixAppServer(join(root, 'codex.sock'));
  server.supportsPlanning = !observe;
  if (!observe) server.thread.approvalPolicy = 'on-request';
  servers.push(server);
  await server.start();
  const provider = new CodexAppServerProvider({
    connectionMode: 'shared', socketPath: server.socketPath, requestTimeoutMs: 500,
    sharedRecovery: { initialDelayMs: 150, maximumDelayMs: 150, maximumAttempts: 5, jitter: () => 1, ...settings },
  });
  const session = await provider.createSession({ sessionId: 'remote', cwd: '/workspace' });
  sessions.push(session);
  let consumer: AsyncIterator<ProviderStreamItem> | undefined;
  const iterator: AsyncIterator<ProviderStreamItem> = { next: () => (consumer ??= session.observe()[Symbol.asyncIterator]()).next() };
  if (observe) await expect(iterator.next()).resolves.toEqual({ value: { type: 'history_boundary' }, done: false });
  return { server, provider, session, iterator };
}

async function nextItem(iterator: AsyncIterator<ProviderStreamItem>, type: ProviderStreamItem['type']): Promise<ProviderStreamItem> {
  for (let index = 0; index < 30; index += 1) {
    const result = await iterator.next();
    if (result.done) throw new Error(`Observation ended before ${type}`);
    if (result.value.type === type) return result.value;
  }
  throw new Error(`Observation did not publish ${type}`);
}

async function nextEvent(iterator: AsyncIterator<ProviderStreamItem>, type: string): Promise<Extract<ProviderStreamItem, { type: 'observation' }>> {
  for (let index = 0; index < 30; index += 1) {
    const item = await nextItem(iterator, 'observation');
    if (item.type === 'observation' && item.event.type === type) return item;
  }
  throw new Error(`Observation did not publish ${type}`);
}

function replacementAssistantText(item: ProviderStreamItem): string {
  if (item.type !== 'timeline_replacement') throw new Error('Expected timeline replacement');
  return item.observations.flatMap(observation => observation.event.type === 'timeline'
    && observation.event.item.type === 'assistant_message' ? [observation.event.item.text] : []).join('');
}

async function drainAvailable(iterator: AsyncIterator<ProviderStreamItem>, quietMs = 60): Promise<ProviderStreamItem[]> {
  const items: ProviderStreamItem[] = [];
  for (let index = 0; index < 30; index += 1) {
    const next = iterator.next();
    const result = await Promise.race([
      next,
      new Promise<'quiet'>(resolve => setTimeout(() => resolve('quiet'), quietMs)),
    ]);
    if (result === 'quiet') break;
    if (result.done) break;
    items.push(result.value);
  }
  return items;
}

describe('shared Codex recovery', () => {
  it('opens an already running native turn as working in both content and activity connections', async () => {
    const { server, provider } = await harness();
    server.thread.status = { type: 'active', activeFlags: [] };
    server.thread.turns = [{ id: 'existing-turn', status: 'inProgress', items: [] }];
    const resumed = await provider.resumeSession({ providerId: 'codex', sessionId: 'root', opaque: '{}' });
    sessions.push(resumed);
    const manager = await AgentManager.attach({ agentId: 'remote', provider: provider.descriptor, session: resumed, epoch: 'initial' });
    const content: string[] = [], activity: string[] = [];
    const contentWire = createSessionWire(manager, json => content.push(json));
    const activityWire = createSessionWire(manager, json => activity.push(json));
    managerCleanups.push(async () => { contentWire.close(); activityWire.close(); await manager.close(); });
    await manager.ready;
    await contentWire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));
    await activityWire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate', observation: 'activity' }));
    expect(content.map(json => JSON.parse(json))).toContainEqual(expect.objectContaining({ type: 'agent_snapshot', payload: expect.objectContaining({ status: 'running' }) }));
    expect(activity.map(json => JSON.parse(json))).toEqual([
      { protocolVersion: '1.4.0', type: 'negotiated' },
      { protocolVersion: '1.4.0', type: 'agent_activity', payload: { agentId: 'remote', status: 'running', cursor: { epoch: 'initial', seq: 0 } } },
    ]);
    server.notify('turn/completed', { threadId: 'root', turn: { id: 'existing-turn', status: 'completed' } });
    await expect.poll(() => manager.snapshot().payload.status).toBe('idle');
    expect(JSON.parse(activity.at(-1)!)).toMatchObject({ type: 'agent_activity', payload: { status: 'idle' } });
  });

  it.each(['resume', 'repeated read'])('removes a resolved interaction before the authoritative cutoff during %s', async interval => {
    const { server, session, iterator } = await harness({ initialDelayMs: 10, maximumDelayMs: 10 });
    const entered = deferred();
    const release = deferred();
    let reads = 0;
    server.requestHook = async ({ connection, method, params }) => {
      if (connection !== 2) return undefined;
      if (method === 'thread/read' && params.threadId === 'root') reads += 1;
      if ((interval === 'resume' && method === 'thread/resume')
        || (interval === 'repeated read' && method === 'thread/read' && reads === 1)) {
        entered.resolve(undefined);
        await release.promise;
      }
      return undefined;
    };
    server.disconnectClients();
    await entered.promise;
    server.requestInteraction('resolved-before-cutoff', 'root', 2);
    const requested = await nextEvent(iterator, 'interaction_requested');
    if (requested.event.type !== 'interaction_requested') throw new Error('Expected interaction');
    const requestId = requested.event.request.requestId;
    server.resolveInteraction('resolved-before-cutoff', 'root', 2);
    if (interval === 'repeated read') {
      server.thread.turns = [{ id: 'turn', items: [{ id: 'answer', type: 'agentMessage', text: 'A' }] }];
      server.notify('item/agentMessage/delta', { threadId: 'root', turnId: 'turn', itemId: 'answer', delta: 'A' }, 2);
    }
    release.resolve(undefined);
    await nextItem(iterator, 'timeline_replacement');
    await expect.poll(async () => (await session.runtimeInfo()).connection?.state).toBe('connected');
    const remaining = await drainAvailable(iterator);
    expect(remaining.flatMap(item => item.type === 'observation'
      && (item.event.type === 'interaction_invalidated' || item.event.type === 'interaction_resolved') ? [item.event.requestId] : []))
      .toContain(requestId);
    await expect(session.respondToInteraction!(requestId, { kind: 'question', answers: [] })).rejects.toThrow('No pending');
    expect(server.nativeResponses.find(response => response.id === 'resolved-before-cutoff')).toBeUndefined();
    if (interval === 'repeated read') expect(reads).toBe(2);
  });

  it('discovers spawn provenance and unknown children while a loaded child snapshot is held', async () => {
    const { server, provider, session, iterator } = await harness({ initialDelayMs: 10, maximumDelayMs: 10 });
    for (const id of ['old-child', 'spawned-child', 'unknown-child']) server.children.set(id, {
      id, parentThreadId: 'root', status: { type: 'idle' }, canAcceptDirectInput: id === 'spawned-child', turns: [],
    });
    server.notify('item/completed', { threadId: 'root', turnId: 'old-turn', item: {
      id: 'old-spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['old-child'], status: 'completed',
    } });
    await expect.poll(async () => (await session.runtimeInfo()).childSessions?.some(child => child.nativeSessionId === 'old-child')).toBe(true);
    const oldChild = await provider.openChildSession('root', 'old-child');
    sessions.push(oldChild);
    const entered = deferred();
    const release = deferred();
    server.requestHook = async ({ connection, method, params }) => {
      if (connection === 2 && method === 'thread/read' && params.threadId === 'old-child' && params.includeTurns) {
        entered.resolve(undefined);
        await release.promise;
      }
      return undefined;
    };
    server.disconnectClients();
    await entered.promise;
    server.notify('item/completed', { threadId: 'root', turnId: 'spawn-turn', item: {
      id: 'late-spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['spawned-child'],
      prompt: 'Inspect the result', status: 'completed',
    } }, 2);
    for (const threadId of ['spawned-child', 'unknown-child']) {
      server.notify('thread/status/changed', { threadId, status: { type: 'idle' } }, 2);
    }
    release.resolve(undefined);
    await nextItem(iterator, 'timeline_replacement');
    await expect.poll(async () => (await session.runtimeInfo()).connection?.state).toBe('connected');
    await expect.poll(async () => (await session.runtimeInfo()).childSessions?.some(child => child.nativeSessionId === 'spawned-child')).toBe(true);
    await expect.poll(async () => (await session.runtimeInfo()).childSessions?.some(child => child.nativeSessionId === 'unknown-child')).toBe(true);
    expect((await session.runtimeInfo()).childSessions).toContainEqual(expect.objectContaining({
      nativeSessionId: 'spawned-child', parentTurnId: 'spawn-turn', parentCallId: 'late-spawn', description: 'Inspect the result',
    }));
    for (const id of ['spawned-child', 'unknown-child']) {
      const child = await provider.openChildSession('root', id);
      sessions.push(child);
      expect(child.capabilities.sendMessage).toBe(id === 'spawned-child');
    }
    expect(await provider.openChildSession('root', 'old-child')).toBe(oldChild);
  });

  it.each([null, 'surviving-turn', 'old-turn'])('reconciles the manager active turn from native recovery to %s', async activeTurnId => {
    const { server, session } = await harness({ initialDelayMs: 10, maximumDelayMs: 10 }, false);
    const manager = await AgentManager.attach({ agentId: 'remote', provider: { providerId: 'codex', displayName: 'Codex' },
      session, epoch: 'initial' });
    const wireOutput: string[] = [];
    const wire = createSessionWire(manager, json => wireOutput.push(json));
    managerCleanups.push(async () => { wire.close(); await manager.close(); });
    await manager.ready;
    await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));
    const events: string[] = [];
    const connections: string[] = [];
    manager.subscribe(message => {
      if (message.type !== 'agent_stream') return;
      events.push(message.event.type);
      if (message.event.type === 'runtime_updated' && message.event.runtimeInfo.connection) connections.push(message.event.runtimeInfo.connection.state);
    });
    server.notify('turn/started', { threadId: 'root', turn: { id: 'old-turn' } });
    await expect.poll(() => manager.snapshot().payload.activeTurn?.turnId).toBe('old-turn');
    const previousTurn = manager.snapshot().payload.activeTurn;
    server.thread.status = { type: activeTurnId ? 'active' : 'idle' };
    server.thread.turns = activeTurnId ? [{ id: activeTurnId, status: 'inProgress', items: [] }] : [];
    server.disconnectClients();
    await expect.poll(() => connections).toContain('reconnecting');
    await expect.poll(() => connections).toContain('connected');
    expect(manager.snapshot().payload.activeTurn?.turnId ?? null).toBe(activeTurnId);
    if (activeTurnId === 'old-turn') expect(manager.snapshot().payload.activeTurn).toEqual(previousTurn);
    const decoded = wireOutput.map(json => decodeServerMessage(json));
    expect(decoded.every(message => message.status === 'ok')).toBe(true);
    expect(decoded).toContainEqual(expect.objectContaining({ status: 'ok', value: expect.objectContaining({
      type: 'agent_stream', payload: expect.objectContaining({ event: expect.objectContaining({ type: 'runtime_updated', activeTurnId }) }),
    }) }));
    expect(decoded).toContainEqual(expect.objectContaining({ status: 'ok', value: expect.objectContaining({
      type: 'agent_update', payload: expect.objectContaining({ activeTurn: activeTurnId === null ? null : expect.objectContaining({ turnId: activeTurnId }) }),
    }) }));
    expect(events.filter(type => ['turn_completed', 'turn_canceled', 'turn_failed'].includes(type))).toEqual([]);
    if (activeTurnId === null) {
      await expect(manager.setPlanning(true)).resolves.toBeUndefined();
      expect((await session.runtimeInfo()).planning?.active).toBe(true);
      server.requestHook = ({ method, params }) => {
        if (method === 'thread/settings/update') server.notify('thread/settings/updated', { threadId: 'root', threadSettings: params });
        return undefined;
      };
      await expect(manager.setSessionSetting('approval', 'untrusted')).resolves.toBeUndefined();
      expect((await session.runtimeInfo()).settings?.find(setting => setting.id === 'approval')?.value).toBe('untrusted');
    } else {
      await expect(manager.setPlanning(true)).rejects.toThrow(/idle/i);
      await manager.cancel();
      expect(server.requests.at(-1)).toEqual({ method: 'turn/interrupt', params: { threadId: 'root', turnId: activeTurnId } });
    }
  });

  it('keeps transient recovery unbounded unless a caller sets an attempt limit', () => {
    expect(normalizeRecoverySettings().maximumAttempts).toBeUndefined();
    expect(normalizeRecoverySettings({ maximumAttempts: 3 }).maximumAttempts).toBe(3);
  });

  it('keeps the session and observer stable and replaces authoritative history without replaying mutations', async () => {
    const { server, session, iterator } = await harness();
    const baseline = server.requests.length;
    server.thread.turns = [{ id: 'turn-native', items: [
      { id: 'user-native', type: 'userMessage', content: [{ type: 'text', text: 'Native input' }] },
      { id: 'answer-native', type: 'agentMessage', text: 'Native answer' },
    ] }];
    server.model = 'native-client-model';

    server.disconnectClients();
    await expect.poll(async () => (await session.runtimeInfo()).connection?.state).toBe('reconnecting');
    await expect(session.sendMessage('Do not replay')).rejects.toThrow(/reconnecting|restoring/i);

    const replacement = await nextItem(iterator, 'timeline_replacement');
    expect(replacement).toMatchObject({ type: 'timeline_replacement', observations: [
      { event: { type: 'timeline', item: { type: 'user_message' } } },
      { event: { type: 'timeline', item: { type: 'assistant_message', text: 'Native answer' } } },
    ] });
    await expect.poll(async () => (await session.runtimeInfo()).connection?.state).toBe('connected');
    expect((await session.runtimeInfo()).model).toBe('native-client-model');
    expect(server.requests.slice(baseline).map(request => request.method)).not.toContain('thread/start');
    expect(server.requests.slice(baseline).filter(request => request.method === 'thread/resume')).toEqual([
      { method: 'thread/resume', params: { threadId: 'root', historyMode: 'paginated' } },
    ]);
    expect(server.requests.slice(baseline).map(request => request.method)).not.toContain('turn/start');
    expect(server.requests.slice(baseline).map(request => request.method)).not.toContain('thread/settings/update');
  });

  it('invalidates old interactions and gives repeated native request ids a fresh public identity', async () => {
    const { server, session, iterator } = await harness();
    server.requestInteraction('same-native-id');
    const requested = await nextEvent(iterator, 'interaction_requested');
    expect(requested).toMatchObject({ event: { type: 'interaction_requested' } });
    if (requested.type !== 'observation' || requested.event.type !== 'interaction_requested') throw new Error('Expected interaction');
    const oldRequestId = requested.event.request.requestId;

    server.disconnectClients();
    const invalidated = await nextEvent(iterator, 'interaction_invalidated');
    expect(invalidated).toMatchObject({ event: { type: 'interaction_invalidated', requestId: oldRequestId } });
    await expect(nextItem(iterator, 'timeline_replacement')).resolves.toMatchObject({ type: 'timeline_replacement' });
    await expect.poll(async () => (await session.runtimeInfo()).connection?.state).toBe('connected');

    server.requestInteraction('same-native-id');
    const fresh = await nextEvent(iterator, 'interaction_requested');
    expect(fresh).toMatchObject({ event: { type: 'interaction_requested' } });
    if (fresh.type !== 'observation' || fresh.event.type !== 'interaction_requested') throw new Error('Expected fresh interaction');
    expect(fresh.event.request.requestId).not.toBe(oldRequestId);
    await expect(session.respondToInteraction!(oldRequestId, { kind: 'question', answers: [] })).rejects.toThrow('No pending');
  });

  it('keeps a post-snapshot delta for an item that already existed before recovery', async () => {
    const { server, provider, session, iterator } = await harness({ initialDelayMs: 10, maximumDelayMs: 10 });
    server.notify('item/agentMessage/delta', {
      threadId: 'root', turnId: 'root-turn', itemId: 'root-answer', delta: 'A',
    });
    await expect(nextItem(iterator, 'observation')).resolves.toMatchObject({
      event: { type: 'timeline', item: { type: 'assistant_message', text: 'A' } },
    });

    server.children.set('child', {
      id: 'child', parentThreadId: 'root', status: { type: 'idle' }, canAcceptDirectInput: false,
      turns: [{ id: 'child-turn', items: [{ id: 'child-answer', type: 'agentMessage', text: 'Child' }] }],
    });
    server.notify('item/completed', {
      threadId: 'root', turnId: 'root-turn',
      item: { id: 'spawn-child', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'], status: 'completed' },
    });
    await expect.poll(async () => (await session.runtimeInfo()).childSessions?.map(child => child.nativeSessionId)).toContain('child');
    const child = await provider.openChildSession('root', 'child');
    sessions.push(child);

    const childReadEntered = deferred();
    const releaseChildRead = deferred();
    server.requestHook = async ({ connection, method, params }) => {
      if (connection === 2 && method === 'thread/read' && params.threadId === 'child' && params.includeTurns === true) {
        childReadEntered.resolve(undefined);
        await releaseChildRead.promise;
      }
      return undefined;
    };
    server.thread.turns = [{ id: 'root-turn', status: 'inProgress', items: [
      { id: 'root-answer', type: 'agentMessage', text: 'AB' },
    ] }];
    server.disconnectClients();
    await childReadEntered.promise;
    server.notify('item/agentMessage/delta', {
      threadId: 'root', turnId: 'root-turn', itemId: 'root-answer', delta: 'C',
    }, 2);
    releaseChildRead.resolve(undefined);

    const replacement = await nextItem(iterator, 'timeline_replacement');
    expect(replacementAssistantText(replacement)).toBe('ABC');
  });

  it('cancels an interaction resolved while its restored snapshot is still loading', async () => {
    const { server, session, iterator } = await harness({ initialDelayMs: 10, maximumDelayMs: 10 });
    const readEntered = deferred();
    const releaseRead = deferred();
    server.requestHook = async ({ connection, method, params }) => {
      if (connection === 2 && method === 'thread/read' && params.threadId === 'root') {
        readEntered.resolve(undefined);
        await releaseRead.promise;
      }
      return undefined;
    };

    server.disconnectClients();
    await readEntered.promise;
    server.requestInteraction('resolved-during-restore', 'root', 2);
    const requested = await nextEvent(iterator, 'interaction_requested');
    if (requested.event.type !== 'interaction_requested') throw new Error('Expected interaction');
    const requestId = requested.event.request.requestId;
    server.resolveInteraction('resolved-during-restore', 'root', 2);
    releaseRead.resolve(undefined);

    await expect(nextItem(iterator, 'timeline_replacement')).resolves.toMatchObject({ type: 'timeline_replacement' });
    await expect.poll(async () => (await session.runtimeInfo()).connection?.state).toBe('connected');
    await expect(session.respondToInteraction!(requestId, { kind: 'question', answers: [] })).rejects.toThrow('No pending');
    expect(server.nativeResponses.find(response => response.id === 'resolved-during-restore')).toBeUndefined();
  });

  it('suppresses a native request resolved before child dispatch completes', async () => {
    const { server, provider, session } = await harness({ initialDelayMs: 10, maximumDelayMs: 10 });
    server.children.set('late-child', {
      id: 'late-child', parentThreadId: 'root', status: { type: 'idle' }, canAcceptDirectInput: false, turns: [],
    });
    const rootReadEntered = deferred();
    const releaseRootRead = deferred();
    const childReadEntered = deferred();
    const releaseChildRead = deferred();
    let childReadBlocked = false;
    server.requestHook = async ({ connection, method, params }) => {
      if (connection !== 2 || method !== 'thread/read') return undefined;
      if (params.threadId === 'root') {
        rootReadEntered.resolve(undefined);
        await releaseRootRead.promise;
      } else if (params.threadId === 'late-child' && !childReadBlocked) {
        childReadBlocked = true;
        childReadEntered.resolve(undefined);
        await releaseChildRead.promise;
      }
      return undefined;
    };

    server.disconnectClients();
    await rootReadEntered.promise;
    server.requestInteraction('resolved-before-dispatch', 'late-child', 2);
    await childReadEntered.promise;
    server.resolveInteraction('resolved-before-dispatch', 'late-child', 2);
    releaseChildRead.resolve(undefined);
    await expect.poll(() => server.requests.filter(request => request.method === 'thread/read'
      && request.params.threadId === 'late-child').length).toBeGreaterThanOrEqual(2);
    releaseRootRead.resolve(undefined);
    await expect.poll(async () => (await session.runtimeInfo()).connection?.state).toBe('connected');

    const child = await provider.openChildSession('root', 'late-child');
    sessions.push(child);
    const items = await drainAvailable(child.observe()[Symbol.asyncIterator]());
    expect(items.filter(item => item.type === 'observation' && item.event.type === 'interaction_requested')).toEqual([]);
    expect(server.nativeResponses.find(response => response.id === 'resolved-before-dispatch')).toBeUndefined();
  });

  it('retires interactions created by a restoration attempt that later fails', async () => {
    const { server, session, iterator } = await harness({ initialDelayMs: 10, maximumDelayMs: 10 });
    const firstReadEntered = deferred();
    const failFirstRead = deferred<RpcOverride>();
    server.requestHook = async ({ connection, method, params }) => {
      if (connection === 2 && method === 'thread/read' && params.threadId === 'root') {
        firstReadEntered.resolve(undefined);
        return await failFirstRead.promise;
      }
      return undefined;
    };

    server.disconnectClients();
    await firstReadEntered.promise;
    server.requestInteraction('failed-attempt-question', 'root', 2);
    const requested = await nextEvent(iterator, 'interaction_requested');
    if (requested.event.type !== 'interaction_requested') throw new Error('Expected interaction');
    const requestId = requested.event.request.requestId;
    failFirstRead.resolve({ kind: 'error', code: -32000, message: 'temporary snapshot failure' });

    await expect(nextItem(iterator, 'timeline_replacement')).resolves.toMatchObject({ type: 'timeline_replacement' });
    await expect.poll(async () => (await session.runtimeInfo()).connection?.state).toBe('connected');
    await expect(session.respondToInteraction!(requestId, { kind: 'question', answers: [] })).rejects.toThrow('No pending');
    expect(server.nativeResponses.find(response => response.id === 'failed-attempt-question')).toBeUndefined();
  });

  it('retires a timed-out restoration and ignores its late snapshot result', async () => {
    const { server, session, iterator } = await harness({
      initialDelayMs: 10, maximumDelayMs: 10, restorationDeadlineMs: 40,
    });
    const firstReadEntered = deferred();
    const lateRead = deferred<RpcOverride>();
    server.requestHook = async ({ connection, method, params }) => {
      if (connection === 2 && method === 'thread/read' && params.threadId === 'root') {
        firstReadEntered.resolve(undefined);
        return await lateRead.promise;
      }
      return undefined;
    };

    server.disconnectClients();
    await firstReadEntered.promise;
    const replacement = await nextItem(iterator, 'timeline_replacement');
    expect(replacementAssistantText(replacement)).toBe('');
    await expect.poll(async () => (await session.runtimeInfo()).connection?.state).toBe('connected');

    lateRead.resolve({ kind: 'result', value: {
      thread: { ...server.thread, turns: [{ id: 'stale-turn', items: [{ id: 'stale-answer', type: 'agentMessage', text: 'Stale' }] }] },
      cwd: '/stale', model: 'stale-model',
    } });
    await new Promise(resolve => setTimeout(resolve, 80));
    expect((await session.runtimeInfo()).model).toBe('mock-model');
    expect(await drainAvailable(iterator, 30)).not.toContainEqual(expect.objectContaining({ type: 'timeline_replacement' }));
  });

  it('limits concurrent restoration work to four roots process-wide', async () => {
    const harnesses = await Promise.all(Array.from({ length: 5 }, () => harness({
      initialDelayMs: 10, maximumDelayMs: 10, restorationDeadlineMs: 500,
    })));
    const releases = harnesses.map(() => deferred());
    let entered = 0;
    const enteredRoots: number[] = [];
    let active = 0;
    let maximumActive = 0;
    harnesses.forEach(({ server }, index) => {
      server.requestHook = async ({ connection, method }) => {
        if (connection !== 2 || method !== 'initialize') return undefined;
        entered += 1;
        enteredRoots.push(index);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await releases[index].promise;
        active -= 1;
        return undefined;
      };
    });

    for (const { server } of harnesses) server.disconnectClients();
    await expect.poll(() => entered).toBe(4);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(entered).toBe(4);
    expect(maximumActive).toBe(4);

    releases[enteredRoots[0]!]!.resolve(undefined);
    await expect.poll(() => entered).toBe(5);
    for (const release of releases) release.resolve(undefined);
    await Promise.all(harnesses.map(({ session }) => expect.poll(async () =>
      (await session.runtimeInfo()).connection?.state).toBe('connected')));
    expect(maximumActive).toBe(4);
  });

  it('cancels retry work on disposal and never manages the external daemon', async () => {
    const { server, session } = await harness();
    server.disconnectClients();
    await expect.poll(async () => (await session.runtimeInfo()).connection?.state).toBe('reconnecting');
    await session.dispose();
    const connections = server.sockets.size;
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(server.sockets.size).toBe(connections);
    expect(server.requests.filter(request => request.method === 'initialize')).toHaveLength(1);
  });

  it('recovers after the external daemon disappears and later returns at the same socket', async () => {
    const { server, session, iterator } = await harness({ initialDelayMs: 30, maximumDelayMs: 40, maximumAttempts: 8 });
    await server.stop();
    await expect.poll(async () => (await session.runtimeInfo()).connection?.state).toBe('reconnecting');
    await new Promise(resolve => setTimeout(resolve, 90));
    server.thread.turns = [{ id: 'turn-after-restart', items: [{ id: 'answer-after-restart', type: 'agentMessage', text: 'After restart' }] }];
    await server.start();

    await expect(nextItem(iterator, 'timeline_replacement')).resolves.toMatchObject({
      observations: [{ event: { type: 'timeline', item: { type: 'assistant_message', text: 'After restart' } } }],
    });
    await expect.poll(async () => (await session.runtimeInfo()).connection?.state).toBe('connected');
  });

  it('bounds retries and keeps the stable observation stream available in unavailable state', async () => {
    const { server, session, iterator } = await harness({ initialDelayMs: 10, maximumDelayMs: 10, maximumAttempts: 2 });
    await server.stop();
    await expect.poll(async () => (await session.runtimeInfo()).connection).toMatchObject({
      state: 'unavailable', reason: 'retry_exhausted', attempt: 2,
    });
    await expect(session.sendMessage('Rejected')).rejects.toThrow(/unavailable/i);
    for (;;) {
      const item = await nextEvent(iterator, 'runtime_updated');
      if (item.event.type === 'runtime_updated' && item.event.runtimeInfo.connection?.state === 'unavailable') break;
    }
    const waiting = iterator.next();
    const winner = await Promise.race([waiting.then(() => 'ended'), new Promise(resolve => setTimeout(() => resolve('waiting'), 50))]);
    expect(winner).toBe('waiting');
  });

  it('classifies a missing native root as permanently unavailable without a retry loop', async () => {
    const { server, session } = await harness({ initialDelayMs: 10, maximumDelayMs: 10, maximumAttempts: 5 });
    const priorInitializations = server.requests.filter(request => request.method === 'initialize').length;
    server.threadReadError = { code: -32600, message: 'no rollout found for thread id root' };
    server.disconnectClients();
    await expect.poll(async () => (await session.runtimeInfo()).connection).toMatchObject({
      state: 'unavailable', reason: 'thread_unavailable', attempt: 1,
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(server.requests.filter(request => request.method === 'initialize')).toHaveLength(priorInitializations + 1);
  });

  it('keeps a loaded child object and its native read-only eligibility across repeated loss', async () => {
    const { server, provider, session, iterator } = await harness({ initialDelayMs: 20, maximumDelayMs: 20 });
    server.children.set('child', {
      id: 'child', parentThreadId: 'root', status: { type: 'idle' }, canAcceptDirectInput: false,
      turns: [{ id: 'child-turn', items: [{ id: 'child-answer', type: 'agentMessage', text: 'Child answer' }] }],
    });
    server.thread.turns = [{ id: 'root-turn', items: [{
      id: 'spawn-child', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'], prompt: 'Inspect', status: 'completed',
    }] }];
    server.disconnectClients();
    await expect(nextItem(iterator, 'timeline_replacement')).resolves.toMatchObject({ type: 'timeline_replacement' });
    await expect.poll(async () => (await session.runtimeInfo()).childSessions?.map(child => child.nativeSessionId)).toContain('child');

    const child = await provider.openChildSession('root', 'child');
    sessions.push(child);
    const childIterator = child.observe()[Symbol.asyncIterator]();
    while ((await childIterator.next()).value?.type !== 'history_boundary') { /* Drain saved native history. */ }
    expect(child.capabilities.sendMessage).toBe(false);
    await expect(child.sendMessage('Must remain read-only')).rejects.toThrow(/does not accept direct input/i);

    server.disconnectClients();
    await expect(nextItem(childIterator, 'timeline_replacement')).resolves.toMatchObject({ type: 'timeline_replacement' });
    await expect.poll(async () => (await child.runtimeInfo()).connection?.state).toBe('connected');
    expect(await provider.openChildSession('root', 'child')).toBe(child);
    expect(child.capabilities.sendMessage).toBe(false);
  });

  it('uses a fresh public interaction identity for the same native request after a Host runtime restart', async () => {
    const { server, provider, session, iterator } = await harness();
    server.requestInteraction('reused-native-id');
    const first = await nextEvent(iterator, 'interaction_requested');
    if (first.event.type !== 'interaction_requested') throw new Error('Expected first interaction');

    await session.dispose();
    const replacementHostSession = await provider.createSession({ sessionId: 'replacement-host', cwd: '/workspace' });
    sessions.push(replacementHostSession);
    const replacementIterator = replacementHostSession.observe()[Symbol.asyncIterator]();
    await replacementIterator.next();
    server.requestInteraction('reused-native-id');
    const second = await nextEvent(replacementIterator, 'interaction_requested');
    if (second.event.type !== 'interaction_requested') throw new Error('Expected replacement interaction');

    expect(second.event.request.requestId).not.toBe(first.event.request.requestId);
    await expect(replacementHostSession.respondToInteraction!(first.event.request.requestId, { kind: 'question', answers: [] }))
      .rejects.toThrow('No pending');
  });
});

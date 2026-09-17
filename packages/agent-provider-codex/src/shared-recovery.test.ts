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

interface NativeThread {
  id: string;
  status: { type: string; activeFlags?: string[] };
  canAcceptDirectInput: boolean;
  turns: Array<Record<string, unknown>>;
  parentThreadId?: string;
}

class UnixAppServer {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly sockets = new Set<WebSocket>();
  thread: NativeThread = { id: 'root', status: { type: 'idle' }, canAcceptDirectInput: true, turns: [] };
  model = 'mock-model';
  readonly children = new Map<string, NativeThread>();
  threadReadError: { code: number; message: string } | undefined;
  private server: Server | undefined;
  private websocketServer: WebSocketServer | undefined;

  constructor(readonly socketPath: string) {}

  async start(): Promise<void> {
    this.server = createServer();
    this.websocketServer = new WebSocketServer({ server: this.server });
    this.websocketServer.on('connection', socket => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('message', data => this.handle(socket, JSON.parse(data.toString()) as Record<string, unknown>));
    });
    this.server.listen(this.socketPath);
    await once(this.server, 'listening');
  }

  disconnectClients(): void {
    for (const socket of this.sockets) socket.terminate();
  }

  requestInteraction(nativeRequestId = 'native-question'): void {
    for (const socket of this.sockets) socket.send(JSON.stringify({
      id: nativeRequestId,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'root', turnId: 'turn-question',
        questions: [{ id: 'choice', header: 'Choice', question: 'Choose', options: [{ label: 'One', description: 'One' }] }],
      },
    }));
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

  private handle(socket: WebSocket, message: Record<string, unknown>): void {
    if (typeof message.id !== 'number' || typeof message.method !== 'string') return;
    const params = message.params && typeof message.params === 'object' ? message.params as Record<string, unknown> : {};
    this.requests.push({ method: message.method, params });
    let result: unknown = {};
    if (message.method === 'model/list') result = { data: [] };
    else if (message.method === 'configRequirements/read') result = { requirements: {} };
    else if (message.method === 'collaborationMode/list') {
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

afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map(session => session.dispose()));
  await Promise.allSettled(servers.splice(0).map(server => server.stop()));
  await Promise.allSettled(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function harness(settings: NonNullable<ConstructorParameters<typeof CodexAppServerProvider>[0]>['sharedRecovery'] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'arc-shared-recovery-'));
  roots.push(root);
  const server = new UnixAppServer(join(root, 'codex.sock'));
  servers.push(server);
  await server.start();
  const provider = new CodexAppServerProvider({
    connectionMode: 'shared', socketPath: server.socketPath, requestTimeoutMs: 500,
    sharedRecovery: { initialDelayMs: 150, maximumDelayMs: 150, maximumAttempts: 5, jitter: () => 1, ...settings },
  });
  const session = await provider.createSession({ sessionId: 'remote', cwd: '/workspace' });
  sessions.push(session);
  const iterator = session.observe()[Symbol.asyncIterator]();
  await expect(iterator.next()).resolves.toEqual({ value: { type: 'history_boundary' }, done: false });
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

describe('shared Codex recovery', () => {
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

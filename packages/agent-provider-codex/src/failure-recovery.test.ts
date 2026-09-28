import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { AgentManager } from '../../agent-remote-relay/src/agent-manager.js';
import { decodeServerMessage } from '../../agent-remote-protocol/src/index.js';
import { CodexAppServerProvider } from './provider.js';

it('restores native failure evidence over a shared socket and clears it on a new turn', async () => {
  const root = await mkdtemp('/tmp/arc-failure-view-');
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const reason = 'Encrypted function output content could not be decrypted or decoded.';
  sockets.on('connection', socket => socket.on('message', raw => {
    const request = JSON.parse(raw.toString()); if (request.id === undefined) return;
    const result = request.method === 'thread/resume'
      ? { thread: { id: 'thread', status: { type: 'systemError' } } }
      : request.method === 'thread/turns/list'
        ? { data: [{ id: 'failed-turn', status: 'failed', completedAt: 2, error: { message: reason }, items: [] }], nextCursor: null }
        : {};
    socket.send(JSON.stringify({ id: request.id, result }));
  }));
  const socketPath = join(root, 'native.sock'); server.listen(socketPath); await once(server, 'listening');
  const provider = new CodexAppServerProvider({ connectionMode: 'shared', socketPath, requestTimeoutMs: 1000 });
  let manager: AgentManager | undefined;
  try {
    manager = await AgentManager.resume({ agentId: 'agent', adapter: provider, epoch: 'epoch', handle: { providerId: 'codex', sessionId: 'thread', opaque: '{}' } });
    expect(manager.snapshot().payload.runtimeInfo).toMatchObject({ status: 'failed', failure: { message: reason, turnId: 'failed-turn' } });
    expect(decodeServerMessage(JSON.stringify(manager.snapshot()))).toEqual({ status: 'ok', value: manager.snapshot() });
    const entries = () => manager!.fetchTimeline({ agentId: 'agent', requestId: 'tail', direction: 'tail', limit: 100 }).payload.entries;
    expect(entries().map(e => e.item)).toEqual([{ type: 'error', message: reason }]);
    const notify = (method: string, params: unknown) => { for (const socket of sockets.clients) socket.send(JSON.stringify({ method, params })); };
    notify('turn/started', { threadId: 'thread', turn: { id: 'next' } });
    await expect.poll(() => manager!.snapshot().payload.status).toBe('running');
    expect(manager.snapshot().payload.runtimeInfo.failure).toBeUndefined();
    notify('error', { threadId: 'thread', turnId: 'next', willRetry: false, error: { message: 'New failure\n' } });
    notify('turn/completed', { threadId: 'thread', turn: { id: 'next', status: 'failed', error: { message: 'New failure' } } });
    notify('thread/status/changed', { threadId: 'thread', status: { type: 'systemError' } });
    await expect.poll(() => manager!.snapshot().payload.runtimeInfo.failure).toEqual({ message: 'New failure', turnId: 'next' });
    expect(entries().filter(e => e.item.type === 'error').map(e => e.item)).toEqual([{ type: 'error', message: reason }, { type: 'error', message: 'New failure' }]);
  } finally {
    await manager?.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

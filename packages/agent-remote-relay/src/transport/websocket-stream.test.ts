import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSession, ProviderStreamItem } from '@agent-remote-controller/agent-provider-sdk';
import type { AgentManagerEvent } from '../agent-manager-events.js';
import { AgentManager } from '../agent-manager.js';
import type { AgentRemoteRelay } from '../relay.js';
import type { SessionWireAgent } from '../session-wire.js';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { attachAgentRemoteWebSocketStream, type AgentRemoteWebSocketStream } from './websocket-stream.js';

const closeables: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((close) => close()));
});

describe('Agent Remote WebSocket session failures', () => {
  it('resolves and reads document-relative Markdown image bytes through the real session socket', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-remote-session-resource-'));
    await mkdir(join(workspace, 'docs', 'images'), { recursive: true });
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    await writeFile(join(workspace, 'docs', 'images', 'result.png'), png);
    const session = boundarySession(workspace);
    const manager = await AgentManager.attach({
      agentId: 'agent-1', provider: { providerId: 'fake', displayName: 'Fake' }, session, epoch: 'epoch-1',
    });
    await manager.ready;
    const actions: string[] = [];
    const socket = await openControlledSocket(manager, (action) => { actions.push(action); return true; });
    const inbox = socketInbox(socket);
    try {
      socket.send(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));
      await inbox.next('agent_snapshot');
      socket.send(JSON.stringify({
        protocolVersion: '1.4.0', type: 'resource_resolve_request',
        payload: {
          requestId: 'resolve-one', agentId: 'agent-1', locator: './images/result.png',
          sourceLocator: join(workspace, 'docs', 'report.md'),
        },
      }));
      const resolved = await inbox.next('resource_resolve_response');
      const binding = (resolved.payload as { binding: { resourceId: string } }).binding;
      socket.send(JSON.stringify({
        protocolVersion: '1.4.0', type: 'resource_request',
        payload: { requestId: 'read-one', agentId: 'agent-1', resourceId: binding.resourceId },
      }));
      const read = await inbox.next('resource_response');
      expect(read.payload).toMatchObject({
        requestId: 'read-one', agentId: 'agent-1', resourceId: binding.resourceId,
        state: { status: 'available', mediaType: 'image/png', contentBase64: Buffer.from(png).toString('base64') },
      });
      expect(actions).toEqual(['attach', 'resolve_resource', 'read_resource']);
    } finally {
      socket.close();
      await manager.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });
  it('closes with an internal-error reason when a manager event cannot be delivered', async () => {
    const controlled = controlledAgent((emit) => {
      emit({
        type: 'interaction_requested', agentId: 'agent-1',
        request: { kind: 'question', requestId: 'question-1' },
      } as AgentManagerEvent);
    });
    const socket = await openControlledSocket(controlled.agent);
    const closed = socketClose(socket);

    socket.send(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));

    await expect(closed).resolves.toEqual({ code: 1011, reason: 'Agent Remote event delivery failed' });
    expect(controlled.unsubscribeCount()).toBe(1);
  });

  it('keeps retry-later semantics when the manager event buffer overflows', async () => {
    const controlled = controlledAgent((emit) => {
      for (let index = 0; index < 1_025; index += 1) {
        emit({ type: 'agent_state', agentId: 'agent-1', snapshot: validSnapshot() });
      }
    });
    const socket = await openControlledSocket(controlled.agent);
    const closed = socketClose(socket);

    socket.send(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));

    await expect(closed).resolves.toEqual({ code: 1013, reason: 'Agent event buffer overflowed' });
    expect(controlled.unsubscribeCount()).toBe(1);
  });
});

function controlledAgent(onSnapshot: (emit: (event: AgentManagerEvent) => void) => void): {
  agent: SessionWireAgent;
  unsubscribeCount(): number;
} {
  let listener: ((event: AgentManagerEvent) => void) | undefined;
  let unsubscriptions = 0;
  return {
    agent: {
      agentId: 'agent-1',
      snapshot() {
        onSnapshot((event) => listener?.(event));
        return validSnapshot();
      },
      fetchTimeline: () => { throw new Error('Timeline is not used by this test.'); },
      subscribe(next) {
        listener = next;
        return () => {
          unsubscriptions += 1;
          listener = undefined;
        };
      },
      async sendMessage() {},
      async respondToInteraction() {},
    },
    unsubscribeCount: () => unsubscriptions,
  };
}

function validSnapshot() {
  return {
    protocolVersion: '1.4.0' as const,
    type: 'agent_snapshot' as const,
    payload: {
      id: 'agent-1', providerId: 'fake', createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:00.000Z', status: 'idle' as const, activeTurn: null,
      capabilities: {
        history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
        interactions: { question: true, planApproval: true, toolApproval: true },
      },
      pendingInteractions: [],
      runtimeInfo: { providerId: 'fake', sessionId: 'session-1', status: 'idle' as const },
    },
  };
}

async function openControlledSocket(
  agent: SessionWireAgent,
  authorize: (action: string) => boolean = () => true,
): Promise<WebSocket> {
  const server = createServer();
  const stream = attachAgentRemoteWebSocketStream(server, {
    requireAgent: () => agent,
  } as AgentRemoteRelay, {
    authorizer: {
      authenticate: () => ({ subject: 'test-user' }),
      authorize: ({ action }) => authorize(action),
    },
  });
  const port = await listen(server);
  closeables.push(() => close(server, stream));
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/sessions/agent-1/events`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

function socketInbox(socket: WebSocket) {
  const queued: Array<Record<string, unknown>> = [];
  const waiting: Array<{ type: string; resolve: (message: Record<string, unknown>) => void }> = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    const index = waiting.findIndex(({ type }) => message.type === type);
    if (index === -1) queued.push(message);
    else waiting.splice(index, 1)[0]!.resolve(message);
  });
  return {
    next(type: string): Promise<Record<string, unknown>> {
      const index = queued.findIndex((message) => message.type === type);
      if (index !== -1) return Promise.resolve(queued.splice(index, 1)[0]!);
      return new Promise((resolve) => waiting.push({ type, resolve }));
    },
  };
}

function boundarySession(cwd: string): AgentSession {
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => { finish = resolve; });
  return {
    capabilities: {
      history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
      interactions: { question: true, planApproval: true, toolApproval: true },
    },
    async *observe(): AsyncIterable<ProviderStreamItem> {
      yield { type: 'history_boundary' };
      await closed;
    },
    async sendMessage() {},
    async respondToInteraction() {},
    async runtimeInfo() { return { providerId: 'fake', sessionId: 'session-1', status: 'idle', cwd }; },
    async dispose() { finish(); },
  };
}

function socketClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    socket.once('error', reject);
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an assigned TCP port.');
  return address.port;
}

async function close(server: Server, stream: AgentRemoteWebSocketStream): Promise<void> {
  await stream.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

it('streams only distinct activity over a real socket and keeps normal content subscriptions independent', async () => {
  const listeners = new Set<(event: AgentManagerEvent) => void>();
  let current = validSnapshot();
  const agent: SessionWireAgent = {
    agentId: 'agent-1', snapshot: () => current,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    fetchTimeline: () => { throw new Error('Activity must not load history'); },
    sendMessage: async () => { throw new Error('Activity must not send'); }, respondToInteraction: async () => {},
  };
  const tracking = await openControlledSocket(agent);
  const content = await openControlledSocket(agent);
  const inbox = socketInbox(tracking), full = socketInbox(content);
  const received: Array<{ type: string; payload?: unknown }> = [];
  tracking.on('message', data => received.push(JSON.parse(data.toString())));
  tracking.send(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate', observation: 'activity' }));
  expect((await inbox.next('agent_activity')).payload).toEqual({ agentId: 'agent-1', status: 'idle' });
  content.send(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));
  await full.next('agent_snapshot');
  for (let index = 0; index < 10; index++) for (const emit of listeners) {
    emit({ type: 'agent_state', agentId: 'agent-1', snapshot: current });
    emit({ type: 'resource_update', agentId: 'agent-1', resourceId: 'large-file', state: { status: 'available', text: 'private output' } });
  }
  const waiting = { ...current, payload: { ...current.payload, status: 'waiting' as const } };
  for (const emit of listeners) emit({ type: 'agent_state', agentId: 'agent-1', snapshot: waiting });
  expect((await inbox.next('agent_activity')).payload).toEqual({ agentId: 'agent-1', status: 'waiting' });
  tracking.send(JSON.stringify({ protocolVersion: '1.4.0', type: 'timeline_subscription', payload: { requestId: 'no-content', agentIds: ['agent-1'] } }));
  expect((await inbox.next('protocol_error')).payload).toMatchObject({ code: 'activity_only' });
  expect(received.map(item => item.type)).toEqual(['negotiated', 'agent_activity', 'agent_activity', 'protocol_error']);
  expect(JSON.stringify(received)).not.toContain('private output');
  tracking.close(); content.close();
});

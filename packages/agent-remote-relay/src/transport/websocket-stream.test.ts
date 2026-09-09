import { createServer, type Server } from 'node:http';

import type { AgentManagerEvent } from '../agent-manager-events.js';
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
  it('closes with an internal-error reason when a manager event cannot be delivered', async () => {
    const controlled = controlledAgent((emit) => {
      emit({
        type: 'interaction_requested', agentId: 'agent-1',
        request: { kind: 'question', requestId: 'question-1' },
      } as AgentManagerEvent);
    });
    const socket = await openControlledSocket(controlled.agent);
    const closed = socketClose(socket);

    socket.send(JSON.stringify({ protocolVersion: '1.2.0', type: 'negotiate' }));

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

    socket.send(JSON.stringify({ protocolVersion: '1.2.0', type: 'negotiate' }));

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
    protocolVersion: '1.2.0' as const,
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

async function openControlledSocket(agent: SessionWireAgent): Promise<WebSocket> {
  const server = createServer();
  const stream = attachAgentRemoteWebSocketStream(server, {
    requireAgent: () => agent,
  } as AgentRemoteRelay, {
    authorizer: {
      authenticate: () => ({ subject: 'test-user' }),
      authorize: () => true,
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

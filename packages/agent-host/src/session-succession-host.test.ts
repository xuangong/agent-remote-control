import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { expect, test } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type ServerMessage } from '@orchardworks/agent-remote-protocol';
import { createAgentRemoteHttpServer } from '@orchardworks/agent-remote-relay';
import type { AgentSession, AgentCapabilities, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { createAgentHostRuntime } from './host.js';
import { SessionSuccessionStore } from './session-succession-store.js';
import { SessionSuccessionContextStore } from './session-succession-context.js';
import { SessionSuccessionCoordinator } from './session-succession.js';
import { LocalSuccessionPreparation } from './local-succession-preparation.js';

const ref = (nativeSessionId: string) => ({ controllerId: 'controller', providerId: 'fixture', nativeSessionId });
const inputId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

class NativeSession implements AgentSession {
  capabilities: AgentCapabilities = {
    history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
    interactions: { question: false, toolApproval: false, planApproval: false },
  };
  closed = false;
  sent: string[] = [];
  private stop?: () => void;

  constructor(readonly id: string, readonly cwd: string) {}
  async *observe(): AsyncIterable<ProviderStreamItem> {
    yield { type: 'history_boundary' };
    if (!this.closed) await new Promise<void>(resolve => { this.stop = resolve; });
  }
  async runtimeInfo() { return { providerId: 'fixture', sessionId: this.id, status: 'idle' as const, cwd: this.cwd }; }
  async sendMessage(text: string) { this.sent.push(text); return { disposition: 'queued' as const }; }
  async respondToInteraction() {}
  async dispose() { this.closed = true; this.stop?.(); }
}

async function openStores(root: string) {
  const store = new SessionSuccessionStore(join(root, 'roles'));
  const contexts = new SessionSuccessionContextStore(join(root, 'contexts'));
  await Promise.all([store.ready, contexts.ready]);
  return { store, contexts };
}

async function commitFixtureSuccession(root: string) {
  const { store, contexts } = await openStores(root);
  const role = {
    id: 'role', revision: 1, origin: ref('A'), current: ref('A'),
    workspace: { controllerId: 'controller', canonicalCwd: root },
  };
  await store.createRole(role);
  const capture = { epoch: 'e', seq: 0, capturedAt: '2026-10-10T00:00:00Z' };
  await contexts.attach({
    operationId: 'handoff', roleId: 'role', roleRevision: 2, source: ref('A'), target: ref('B'),
    capturedAt: capture.capturedAt, boundary: { epoch: 'e', seq: 0 },
    text: '[{"role":"user","text":"inherited requirement"}]', itemCount: 1,
  });
  const request = { operationId: 'handoff', roleId: 'role', expectedRevision: 1, from: ref('A') };
  await store.begin(request);
  await store.advance('handoff', 'preparing', { phase: 'quiescing', to: ref('B') });
  await store.advance('handoff', 'quiescing', { phase: 'transferring' });
  await store.advance('handoff', 'transferring', {
    phase: 'ready', prepared: { ...request, to: ref('B'), workspace: role.workspace, associationRevision: 0, participants: [], capture },
  });
  await store.commit('handoff');
}

async function startHost(root: string) {
  const { store, contexts } = await openStores(root);
  const sessions = new Map(['A', 'B'].map(id => [id, new NativeSession(id, root)]));
  const unexpectedPreparation = async (): Promise<never> => { throw new Error('No preparation during send'); };
  const coordinator = new SessionSuccessionCoordinator(store, new LocalSuccessionPreparation('controller', 'fixture', {
    inspect: unexpectedPreparation, create: unexpectedPreparation, capture: unexpectedPreparation, saveContext: unexpectedPreparation, bind: unexpectedPreparation,
    supports: async () => true, verifyAttachment: async () => {},
  }));
  const host = createAgentHostRuntime({
    succession: { controllerId: 'controller', store, contexts, coordinator },
    registrations: [{
      adapter: {
        descriptor: { providerId: 'fixture', displayName: 'Fixture' },
        createSession: unexpectedPreparation, resumeSession: unexpectedPreparation,
      },
      directory: {
        providerId: 'fixture', list: () => [], workspaces: () => [], create: unexpectedPreparation,
        async open(id) { return sessions.get(id)!; },
        async close() { await Promise.all([...sessions.values()].map(session => session.dispose())); },
      },
    }],
  });
  const server = createAgentRemoteHttpServer(host.relay, {
    websocketAuthorizer: {
      authenticate: request => ({ subject: String(request.headers['x-test-subject'] ?? 'owner') }),
      authorize: () => true,
    },
  });
  const address = await server.listen(0);
  for (const id of ['A', 'B']) {
    const result = await host.control({
      method: 'POST', path: '/remote/attach', sessionId: id,
      body: JSON.stringify({ providerId: 'fixture', nativeSessionId: id }),
    });
    expect(result.status).toBe(200);
  }
  return {
    contexts, sessions, url: address.url,
    async close() { await server.close(); await host.close(); },
  };
}

/** Each send uses a fresh authenticated connection and closes it before returning. */
async function sendOverWebSocket(url: string, agentId: string, text: string, operationId: string, subject = 'owner') {
  const socket = new WebSocket(`${url.replace('http', 'ws')}/v1/sessions/${agentId}/events`, {
    headers: { 'x-test-subject': subject },
  });
  const messages: ServerMessage[] = [];
  const listeners = new Set<() => void>();
  socket.on('message', data => {
    messages.push(JSON.parse(data.toString()));
    for (const listener of listeners) listener();
  });
  const next = (matches: (message: ServerMessage) => boolean): Promise<ServerMessage> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(check);
      reject(new Error('Session response deadline exceeded.'));
    }, 3000);
    function check() {
      const index = messages.findIndex(matches);
      if (index < 0) return;
      clearTimeout(timer);
      listeners.delete(check);
      resolve(messages.splice(index, 1)[0]!);
    }
    listeners.add(check);
    check();
  });
  try {
    await once(socket, 'open', { signal: AbortSignal.timeout(3000) });
    socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' }));
    await next(message => message.type === 'agent_snapshot');
    const state = await next(message => message.type === 'session_control');
    if (state.type !== 'session_control') throw new Error('Missing control state');
    socket.send(JSON.stringify({
      protocolVersion: PROTOCOL_VERSION, type: 'session_control_request',
      payload: { agentId, requestId: 'control', action: 'take_over', revision: state.payload.revision },
    }));
    const granted = await next(message => message.type === 'session_control' && message.payload.requestId === 'control');
    if (granted.type !== 'session_control') throw new Error('Missing control grant');
    socket.send(JSON.stringify({
      protocolVersion: PROTOCOL_VERSION, type: 'send_message', controlToken: granted.payload.token,
      payload: { requestId: operationId, operationId, agentId, text },
    }));
    return await next(message => (message.type === 'protocol_error' || message.type === 'command_acknowledged')
      && message.payload.requestId === operationId);
  } finally {
    const closed = once(socket, 'close', { signal: AbortSignal.timeout(3000) });
    socket.terminate();
    await closed;
  }
}

function expectQueuedReceipt(message: ServerMessage, operationId: string) {
  expect(message).toMatchObject({
    type: 'command_acknowledged',
    payload: { requestId: operationId, command: 'send_message', inputAcceptance: { disposition: 'queued' } },
  });
}

function expectRejection(message: ServerMessage, operationId: string, code: string) {
  expect(message).toMatchObject({ type: 'protocol_error', payload: { requestId: operationId, code } });
}

test('real WebSocket sends inject context and reject later input and the superseded source', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-succession-host-')));
  let running: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    await commitFixtureSuccession(root);
    running = await startHost(root);
    expectQueuedReceipt(await sendOverWebSocket(running.url, 'B', 'continue', inputId(1)), inputId(1));
    expect(running.sessions.get('B')!.sent).toEqual([expect.stringContaining('inherited requirement')]);
    expectRejection(await sendOverWebSocket(running.url, 'B', 'again', inputId(2)), inputId(2), 'succession_delivery_unresolved');
    expectRejection(await sendOverWebSocket(running.url, 'A', 'stale', inputId(3)), inputId(3), 'operation_rejected');
    expect(running.sessions.get('B')!.sent).toHaveLength(1);
    expect(running.sessions.get('A')!.sent).toEqual([]);
  } finally {
    await running?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('disconnected and cold-restarted clients recover the original receipt without another native send', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-succession-restart-')));
  let running: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    await commitFixtureSuccession(root);
    running = await startHost(root);
    const operationId = inputId(1);
    expectQueuedReceipt(await sendOverWebSocket(running.url, 'B', 'continue', operationId), operationId);
    expectQueuedReceipt(await sendOverWebSocket(running.url, 'B', 'continue', operationId), operationId);
    expect(running.sessions.get('B')!.sent).toHaveLength(1);
    expect(running.contexts.read('handoff').deliveries).toHaveLength(1);

    await running.close();
    running = undefined;
    running = await startHost(root);
    expect(running.contexts.read('handoff').deliveries[0]).toMatchObject({
      state: 'accepted', inputAcceptance: { disposition: 'queued' },
    });
    expectQueuedReceipt(await sendOverWebSocket(running.url, 'B', 'continue', operationId), operationId);
    expect(running.sessions.get('B')!.sent).toEqual([]);
    expect(running.contexts.read('handoff').deliveries).toHaveLength(1);

    expectRejection(await sendOverWebSocket(running.url, 'B', 'continue', operationId, 'other-owner'),
      operationId, 'succession_delivery_unresolved');
    expect(running.sessions.get('B')!.sent).toEqual([]);
    expect(running.contexts.read('handoff').deliveries).toHaveLength(1);
  } finally {
    await running?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

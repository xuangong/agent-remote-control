// @vitest-environment node
import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { CodexEventProjector } from '@orchardworks/agent-provider-codex';
import type { AgentProviderAdapter, AgentSession, ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { PROTOCOL_VERSION, type AgentStreamMessage } from '@orchardworks/agent-remote-protocol';
import { AgentReplica, HttpWebSocketTransport, RemoteSessionClient, type WebSocketLike } from '@orchardworks/agent-remote-web';
import { createProtocolValidationServer } from './server.js';

it.each([
  { type: 'agentMessage', deltas: ['e', 'e'], final: 'ee' },
  { type: 'agentMessage', deltas: ['e', 'a', 'e', 'b'], final: 'eaeb' },
  { type: 'plan', deltas: ['e', 'a', 'e', 'b'], final: 'eaeb' },
  { type: 'reasoning', deltas: ['e', 'e'], final: 'ee' },
])('preserves $type $final over live delivery, record replay, and reconnect', async ({ type, deltas, final }) => {
  const projector = new CodexEventProjector('thread');
  const observations: ProviderObservation[] = [];
  const accept = (method: string, params: unknown) => {
    const observation = projector.projectNotification(method, params);
    if (observation) observations.push(observation);
  };
  accept('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
  for (const delta of deltas) accept(
    type === 'reasoning' ? 'item/reasoning/summaryTextDelta' : type === 'plan' ? 'item/plan/delta' : 'item/agentMessage/delta',
    { threadId: 'thread', turnId: 'turn', itemId: 'message', delta, summaryIndex: 0 },
  );
  const completion = { threadId: 'thread', turnId: 'turn', item: type === 'reasoning'
    ? { type, id: 'message', summary: [final] } : { type, id: 'message', text: final } };
  accept('item/completed', completion);
  accept('item/completed', completion);
  accept('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
  const start = deferred();
  const closed = deferred();
  const session: AgentSession = {
    capabilities: { history: true, sendMessage: false, steer: false, cancel: false, readResource: false, interactions: { question: false, toolApproval: false, planApproval: false } },
    async *observe() {
      yield { type: 'history_boundary' };
      await start.promise;
      for (const observation of observations) {
        yield observation;
        // Replay an actual observation identity, separately from equal native occurrences.
        if (observation.event.type === 'timeline') yield structuredClone(observation);
      }
      await closed.promise;
    },
    async sendMessage() {}, async respondToInteraction() {},
    async runtimeInfo() { return { providerId: 'codex', sessionId: 'thread', status: 'idle' }; },
    async dispose() { start.resolve(); closed.resolve(); },
  };
  const provider: AgentProviderAdapter = { descriptor: { providerId: 'codex', displayName: 'Codex' }, createSession: async () => session, resumeSession: async () => session };
  const server = createProtocolValidationServer({ providers: [provider], labOrigin: 'http://localhost' });
  const clients: RemoteSessionClient[] = [];
  const received: AgentStreamMessage[] = [];
  try {
    const { url } = await server.http.listen();
    const transport = new HttpWebSocketTransport(url, { webSocketFactory: url => {
      const socket = new WebSocket(url, { origin: 'http://localhost' });
      socket.on('message', raw => { const message = JSON.parse(String(raw)); if (message.type === 'agent_stream') received.push(message); });
      return socket as unknown as WebSocketLike;
    } });
    await transport.createAgent('agent', 'codex', { sessionId: 'thread' });
    async function connect() {
      const replica = new AgentReplica();
      const client = new RemoteSessionClient('agent', transport, replica, { operationTimeoutMs: 2000, historyPageSize: 1 });
      let status = '';
      client.subscribeStatus(value => { status = value; });
      clients.push(client);
      client.start();
      await vi.waitFor(() => expect(status).toBe('ready'));
      return { client, replica };
    }
    const first = await connect();
    start.resolve();
    await vi.waitFor(() => expect(received.some(message => message.payload.event.type === 'turn_completed')).toBe(true));
    const expected = type === 'reasoning' ? { type: 'reasoning', text: final } : { type: 'assistant_message', messageId: 'message', text: final };
    expect(first.replica.getState().timeline.entries.map(entry => entry.item)).toEqual([expected]);
    const timeline = received.filter(message => message.payload.event.type === 'timeline');
    expect(timeline).toHaveLength(deltas.length);
    for (const message of timeline) first.replica.applyStream(message);
    expect(first.replica.getState().timeline.entries.map(entry => entry.item)).toEqual([expected]);
    first.client.stop();
    const restored = await connect();
    expect(restored.replica.getState().timeline.entries.map(entry => entry.item)).toEqual([expected]);
    const response = await fetch(`${url}/v1/sessions/agent/timeline?protocolVersion=${PROTOCOL_VERSION}&requestId=verify&direction=tail&limit=100`);
    expect(response.status).toBe(200);
    expect((await response.json()).payload.entries.map((entry: { item: unknown }) => entry.item)).toEqual([expected]);
  } finally {
    clients.forEach(client => client.stop());
    await server.close();
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

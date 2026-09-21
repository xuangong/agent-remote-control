// @vitest-environment node
import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { CodexEventProjector } from '@orchardworks/agent-provider-codex';
import { DshProjector } from '@orchardworks/agent-provider-dsh';
import type { AgentProviderAdapter, AgentSession, ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import { AgentReplica, HttpWebSocketTransport, RemoteSessionClient, type WebSocketLike } from '@orchardworks/agent-remote-web';
import { createProtocolValidationServer } from './server.js';

it.each(['codex', 'dsh', 'codex-files', 'codex-activity', 'codex-wait', 'codex-wait-any'])('preserves %s results over live transport, history, and reconnection without duplicating calls', async (scenario) => {
  const providerId = scenario.startsWith('codex') ? 'codex' : scenario;
  const [running, completed] = observations(scenario);
  const start = deferred();
  const finish = deferred();
  const closed = deferred();
  const session: AgentSession = {
    capabilities: { history: true, sendMessage: false, steer: false, cancel: false, readResource: false, interactions: { question: false, toolApproval: false, planApproval: false } },
    async *observe() { yield { type: 'history_boundary' }; await start.promise; yield running!; await finish.promise; yield completed!; yield completed!; await closed.promise; },
    async sendMessage() {}, async respondToInteraction() {},
    async runtimeInfo() { return { providerId, sessionId: 'native', status: 'idle' }; },
    async dispose() { start.resolve(); finish.resolve(); closed.resolve(); },
  };
  const provider: AgentProviderAdapter = { descriptor: { providerId, displayName: providerId }, createSession: async () => session, resumeSession: async () => session };
  const server = createProtocolValidationServer({ providers: [provider], labOrigin: 'http://localhost' });
  const clients: RemoteSessionClient[] = [];
  try {
    const { url } = await server.http.listen();
    const transport = new HttpWebSocketTransport(url, { webSocketFactory: url => new WebSocket(url, { origin: 'http://localhost' }) as unknown as WebSocketLike });
    await transport.createAgent('agent', providerId, { sessionId: 'native' });
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
    await vi.waitFor(() => expect(first.replica.getState().timeline.entries[0]?.item).toMatchObject({ status: 'running' }));
    if (scenario === 'codex-wait') expect(first.replica.getState().timeline.entries[0]?.item).toMatchObject({ detail: {
      sessionReferences: [{ nativeSessionId: 'child', title: 'child' }, { nativeSessionId: 'sibling', title: 'sibling' }],
    } });
    if (scenario === 'codex-wait-any') expect(first.replica.getState().timeline.entries[0]?.item).toMatchObject({ detail: { description: 'Waiting for updates from any sub-agent' } });
    finish.resolve();
    const content = scenario.startsWith('codex-wait') ? [{ type: 'json', value: { receiverThreadIds: scenario === 'codex-wait' ? ['child', 'sibling'] : [], agentsStates: {} } }] : scenario === 'codex-activity' ? [{ type: 'json', value: { kind: 'interacted', agentThreadId: 'child', agentPath: '/root/review' } }] : scenario === 'codex-files' ? [{ type: 'json', value: { format: 'file_changes', version: 1, files: [
      { path: '/workspace/a.ts', kind: 'modified', diff: '@@ -1 +1 @@\n-old\n+new\n' },
    ] } }] : [expect.objectContaining({ type: 'text', text: 'hello\n' })];
    await vi.waitFor(() => expect(first.replica.getState().timeline.entries[0]?.item).toMatchObject({ status: 'completed', result: { content } }));
    expect(first.replica.getState().timeline.entries).toHaveLength(1);
    if (scenario === 'codex-activity') expect(first.replica.getState().timeline.entries[0]?.item).toMatchObject({ detail: { sessionReference: { nativeSessionId: 'child', title: '/root/review' } } });
    first.client.stop();
    const reconnected = await connect();
    const entries = reconnected.replica.getState().timeline.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.item).toEqual(first.replica.getState().timeline.entries[0]?.item);
    const response = await fetch(`${url}/v1/sessions/agent/timeline?protocolVersion=${PROTOCOL_VERSION}&requestId=verify-history&direction=tail&limit=1`);
    expect(response.status).toBe(200);
    expect((await response.json()).payload.entries[0].item).toEqual(entries[0]?.item);
  } finally { clients.forEach(client => client.stop()); await server.close(); }
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function observations(providerId: string): ProviderObservation[] {
  if (providerId.startsWith('codex-wait')) {
    const projector = new CodexEventProjector('thread');
    const item = { id: 'wait', type: 'collabAgentToolCall', tool: 'wait', receiverThreadIds: providerId === 'codex-wait' ? ['child', 'sibling'] : [], agentsStates: {} };
    return [projector.projectNotification('item/started', { threadId: 'thread', item })!, projector.projectNotification('item/completed', { threadId: 'thread', item })!];
  }
  if (providerId === 'codex-activity') {
    const projector = new CodexEventProjector('thread');
    const item = { id: 'activity', type: 'subAgentActivity', kind: 'interacted', agentThreadId: 'child', agentPath: '/root/review' };
    return [projector.projectNotification('item/started', { threadId: 'thread', item })!, projector.projectNotification('item/completed', { threadId: 'thread', item })!];
  }
  if (providerId === 'codex-files') {
    const projector = new CodexEventProjector('thread');
    const item = { id: 'file-call', type: 'fileChange', changes: [{ path: '/workspace/a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+new\n' }] };
    return [
      projector.projectNotification('item/started', { threadId: 'thread', item: { ...item, status: 'inProgress' } })!,
      projector.projectNotification('item/completed', { threadId: 'thread', item: { ...item, status: 'completed' } })!,
    ];
  }
  if (providerId === 'codex') {
    const projector = new CodexEventProjector('thread');
    const item = { id: 'call', type: 'commandExecution', command: 'echo hello' };
    return [
      projector.projectNotification('item/started', { threadId: 'thread', item: { ...item, status: 'inProgress' } })!,
      projector.projectNotification('item/completed', { threadId: 'thread', item: { ...item, status: 'completed', aggregatedOutput: 'hello\n', exitCode: 0 } })!,
    ];
  }
  const projector = new DshProjector({ sessionId: 'native', tools: { get: () => undefined } });
  return [
    ...projector.project({ recordId: 'call', occurredAt: 1, kind: 'session_event', payload: { type: 'tool/call', data: { callId: 'call', name: 'bash', arguments: '{"command":"echo hello"}' } } }),
    ...projector.project({ recordId: 'result', occurredAt: 2, kind: 'session_event', payload: { type: 'tool/result', data: { message: { source: { callId: 'call' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'hello\n' }] }] } } } }),
  ];
}

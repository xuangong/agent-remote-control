import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentCapabilities, AgentRuntimeInfo, AgentSession, AgentStreamEvent, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { createAgentHost, type AgentHostDirectory } from '@orchardworks/agent-remote-controller';
import { createHostBroker } from '@orchardworks/agent-relay-core';
import { browserStream, connectToRelay } from '@orchardworks/agent-remote-fixtures';
import { createRemoteHostUplinkClient } from '@orchardworks/agent-session-runtime';

/**
 * S2 and S3 with the real Controller and the real Relay joined in memory: a TPM-owned main session keeps its public identity when the
 * Controller restarts or the Relay restarts from its saved state, and two browser streams share it. Nothing listens on a port.
 */
class NativeSession implements AgentSession {
  readonly capabilities: AgentCapabilities = { history: true, sendMessage: true, queueMessage: true, steer: false, cancel: false, readResource: false,
    interactions: { question: false, toolApproval: false, planApproval: false } };
  readonly sent: string[] = [];
  observed = 0;
  closed = false;
  private status: AgentRuntimeInfo['status'] = 'idle';
  private turnId = 'initial';
  private sequence = 0;
  private queued: ProviderStreamItem[] = [{ type: 'history_boundary' }];
  private wake?: () => void;
  constructor(readonly id: string, private readonly cwd: string, private readonly receiptGate?: Promise<void>) {}
  async *observe() {
    this.observed++;
    while (!this.closed) {
      if (this.queued.length) yield this.queued.shift()!;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
  async runtimeInfo(): Promise<AgentRuntimeInfo> { return { providerId: 'codex', sessionId: this.id, cwd: this.cwd, status: this.status,
    persistence: { providerId: 'codex', sessionId: this.id, opaque: '{}' } }; }
  private emit(event: AgentStreamEvent) { this.queued.push({ type: 'observation', sourceKey: `${this.id}:${++this.sequence}`, occurredAt: Date.now(), delivery: 'live', event }); this.wake?.(); }
  async sendMessage(text: string) {
    this.sent.push(text); this.status = 'running'; this.turnId = `review-${this.sent.length}`;
    this.emit({ type: 'timeline', provider: 'codex', turnId: this.turnId, item: { type: 'user_message', text } });
    this.emit({ type: 'turn_started', provider: 'codex', turnId: this.turnId });
    this.emit({ type: 'runtime_updated', provider: 'codex', runtimeInfo: await this.runtimeInfo(), activeTurnId: this.turnId });
    if (this.receiptGate) await this.receiptGate;
    return { disposition: 'started' as const };
  }
  reply(text: string) { this.emit({ type: 'timeline', provider: 'codex', turnId: this.turnId, item: { type: 'assistant_message', text } }); }
  async finish() {
    this.status = 'idle'; this.emit({ type: 'turn_completed', provider: 'codex', turnId: this.turnId });
    this.emit({ type: 'runtime_updated', provider: 'codex', runtimeInfo: await this.runtimeInfo(), activeTurnId: null });
  }
  async respondToInteraction() {}
  async dispose() { this.closed = true; this.wake?.(); }
}
it.each(['attach', 'snapshot', 'relay-restart'] as const)('restores a TPM-owned main session after Host restart through %s without changing the public identity', async firstRead => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-tpm-binding-')));
  const origin = 'http://relay.test';
  const closers: Array<() => void | Promise<void>> = [];
  let broker = createHostBroker({ origin, rpcTimeoutMs: 2000 });
  const connect = connectToRelay(() => broker, closers);
  const request = async (path: string, input?: unknown) => {
    const response = await broker.handleRequest(new Request(origin + path, input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }));
    if (!response) throw new Error('Fixture route missing.');
    return { status: response.status, body: await response.json() };
  };
  let credential = (await request('/v1/remote/pairings', {})).body.key;
  let sessions = new Map<string, NativeSession>();
  const startHost = () => {
    sessions = new Map();
    const nativeSessions = sessions;
    const directory: AgentHostDirectory = { providerId: 'codex', list: () => [], workspaces: () => [],
      create: async () => 'tpm-native',
      async open(id) { let session = nativeSessions.get(id); if (!session) { session = new NativeSession(id, root); nativeSessions.set(id, session); } return session; },
      async close() { await Promise.all([...nativeSessions.values()].map(session => session.dispose())); } };
    return createAgentHost({ installationId: 'tpm-binding-host', name: 'Host', registrations: [{ directory, adapter: {
      descriptor: { providerId: 'codex', displayName: 'Codex', sessionExtensions: { instructions: true, tools: true } },
      async createSession() { throw new Error('Use directory'); }, async resumeSession() { throw new Error('Use directory'); },
    } }], tpm: { stateDirectory: join(root, 'state'), tickMs: 20 },
    uplink: { url: 'ws://relay.test/ws/remote-host', remoteKey: credential, onCredential: async key => { credential = key; } },
    uplinkClient: options => createRemoteHostUplinkClient({ reconnectBaseDelayMs: 10, reconnectMaxDelayMs: 40, ...options, connect }) });
  };
  let host = startHost();
  const browsers: Array<{ send(message: unknown): void; close(): void }> = [];
  try {
    const { hostId } = await host.ready;
    const attachPath = `/v1/remote/hosts/${hostId}/attach`;
    const attached = await request(attachPath, { providerId: 'codex', nativeSessionId: 'main' });
    expect(attached.status).toBe(200);
    const publicId = attached.body.agentId;
    const created = await request(`/v1/remote/hosts/${hostId}/tpm/create`, { providerId: 'codex', mainNativeSessionId: 'main', delegated: true, operationId: 'create-work' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    await expect.poll(() => sessions.get('tpm-native')?.sent.length).toBe(1);
    await expect.poll(async () => (await request(`/v1/remote/hosts/${hostId}/tpm/work?id=${created.body.id}`)).body.outbox?.[0]?.status).toBe('accepted');
    await host.close();
    if (firstRead === 'relay-restart') {
      const initialState = broker.snapshot(); broker.close();
      broker = createHostBroker({ origin, rpcTimeoutMs: 2000, initialState });
    }
    host = startHost(); await host.ready;
    // The background owner restores the runtime before either browser requests its saved binding.
    await expect.poll(() => sessions.get('main')?.observed).toBe(1);
    const main = sessions.get('main')!;
    const snapshotPath = `/v1/sessions/${publicId}/snapshot?protocolVersion=1.8.0`;
    const first = firstRead === 'attach' ? await request(attachPath, { providerId: 'codex', nativeSessionId: 'main' }) : await request(snapshotPath);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect((await request(attachPath, { providerId: 'codex', nativeSessionId: 'main' })).body).toEqual(attached.body);
    const snapshot = await request(snapshotPath);
    expect(snapshot.body).toMatchObject({ type: 'agent_snapshot', payload: { id: publicId, runtimeInfo: { sessionId: 'main' } } });
    expect(broker.snapshot().bindings.find(binding => binding.nativeSessionId === 'main')?.agentId).toBe(publicId);
    const received: any[][] = [];
    const last = (messages: any[], match: (message: any) => boolean) => [...messages].reverse().find(match);
    for (let i = 0; i < 2; i++) {
      const client = await browserStream(broker, `${origin}/v1/sessions/${publicId}/events`, closers); browsers.push(client);
      const messages = client.messages; received.push(messages);
      client.send({ protocolVersion: '1.8.0', type: 'negotiate' });
      await expect.poll(() => messages.some(message => message.type === 'negotiated')).toBe(true);
      await expect.poll(() => messages.find(message => message.type === 'session_control')?.payload.agentId).toBe(publicId);
      const control = messages.find(message => message.type === 'session_control')!.payload;
      client.send({ protocolVersion: '1.8.0', type: 'session_control_request', payload: { requestId: `control-${i}`, agentId: publicId, revision: control.revision, action: 'acquire' } });
      await expect.poll(() => last(messages, message => message.type === 'session_control')?.payload.access).toBe('control');
      client.send({ protocolVersion: '1.8.0', type: 'timeline_subscription', payload: { requestId: `subscribe-${i}`, agentIds: [publicId] } });
      await expect.poll(() => messages.find(message => message.type === 'timeline_subscribed')?.payload.agentIds).toEqual([publicId]);
    }
    browsers[0]!.send({ protocolVersion: '1.8.0', type: 'send_message', controlToken: last(received[0]!, message => message.type === 'session_control')!.payload.token, payload: {
      requestId: 'send', operationId: '00000000-0000-4000-8000-000000000001', agentId: publicId, text: publicId,
    } });
    await expect.poll(() => ({ sent: main.sent, errors: received[0]!.filter(message => message.type === 'protocol_error') })).toEqual({ sent: [publicId], errors: [] });
    await expect.poll(() => received[0]!.find(message => message.type === 'command_acknowledged')?.payload.agentId).toBe(publicId);
    for (const messages of received) await expect.poll(() => messages.some(message => message.type === 'agent_stream' && message.payload.agentId === publicId
      && message.payload.event.item?.text === publicId)).toBe(true);
    const timeline = await request(`/v1/sessions/${publicId}/timeline?protocolVersion=1.8.0&requestId=history&direction=tail&limit=20`);
    expect(timeline.status, JSON.stringify(timeline.body)).toBe(200);
    expect(timeline.body.payload.agentId).toBe(publicId);
    const watcher = await browserStream(broker, `${origin}/v1/sessions/${publicId}/events`, closers); browsers.push(watcher);
    const activity = watcher.messages;
    watcher.send({ protocolVersion: '1.8.0', type: 'negotiate', observation: 'activity' });
    await expect.poll(() => activity.find(message => message.type === 'agent_activity')?.payload.agentId).toBe(publicId);
    expect(main.observed).toBe(1);
  } finally {
    for (const browser of browsers) browser.close();
    await host.close(); broker.close();
    for (const close of closers.splice(0).reverse()) await close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 10000);

import { mkdtemp, rm, realpath, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createHostBroker } from '../../agent-remote-hosted/src/broker.js';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { expect, it } from 'vitest';
import type { AgentCapabilities, AgentRuntimeInfo, AgentSession, AgentSessionConfig, AgentStreamEvent, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { createAgentHostRuntime, createAgentHost, type AgentHostDirectory } from './host.js';

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
async function uplink() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  let socket: WebSocket | undefined; let sequence = 0;
  server.on('connection', connection => {
    socket = connection;
    connection.on('message', data => {
      const request = JSON.parse(data.toString());
      if (request.type === 'register') connection.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'isolated-tpm-host', heartbeat: { intervalMs: 30000, timeoutMs: 10000 } }));
    });
  });
  return {
    url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/remote-host`,
    async rpc(method: 'GET' | 'POST', path: string, body?: unknown, sessionId?: string) {
      if (!socket) throw new Error('Host is disconnected.'); const target = socket; const requestId = `rpc-${++sequence}`;
      return new Promise<{ status: number; body: any }>((resolve, reject) => {
        const timer = setTimeout(() => { target.off('message', receive); reject(new Error('Host RPC deadline exceeded.')); }, 3000);
        const receive = (data: RawData) => {
          const response = JSON.parse(data.toString()); if (response.type !== 'rpc_response' || response.requestId !== requestId) return;
          clearTimeout(timer); target.off('message', receive); resolve({ status: response.status, body: JSON.parse(response.body || '{}') });
        };
        target.on('message', receive); target.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_request', requestId, method, path,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close: () => new Promise<void>(resolve => { for (const client of server.clients) client.terminate(); server.close(() => resolve()); }),
  };
}

it.each([false, true])('creates a scoped TPM over the real Host uplink and keeps shared observation and heartbeat after disconnect (delayed receipt: %s)', async delayedReceipt => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-tpm-host-'))); const broker = await uplink();
  let releaseReceipt!: () => void; const receiptGate = new Promise<void>(resolve => { releaseReceipt = resolve; });
  let now = 1_000_000; const sessions = new Map<string, NativeSession>(); const configurations: AgentSessionConfig[] = [];
  const directory: AgentHostDirectory = { providerId: 'codex', list: async () => [], workspaces: async () => [],
    async create(config) { const id = `tpm-${configurations.length + 1}`; configurations.push({ ...config, sessionId: id }); sessions.set(id, new NativeSession(id, root, delayedReceipt ? receiptGate : undefined)); return id; },
    async open(id) { let session = sessions.get(id); if (!session || session.closed) { session = new NativeSession(id, root); sessions.set(id, session); } return session; },
    async close() { await Promise.all([...sessions.values()].map(session => session.dispose())); } };
  const host = createAgentHost({ installationId: 'tpm-test', name: 'Isolated TPM Host', registrations: [{ directory,
    adapter: { descriptor: { providerId: 'codex', displayName: 'Codex', sessionExtensions: { instructions: true, tools: true } },
      createSession: async () => { throw new Error('Use the directory.'); }, resumeSession: async () => { throw new Error('Use the directory.'); } } }],
    idleGraceMs: 20, idleReconcileMs: 20,
    tpm: { stateDirectory: join(root, 'state'), now: () => now, heartbeatMs: 1000, minimumReviewMs: 30, tickMs: 20 },
    uplink: { url: broker.url, remoteKey: 'isolated-process-key' } });
  try {
    await host.ready;
    const created = await broker.rpc('POST', '/remote/tpm/create', { providerId: 'codex', mainNativeSessionId: 'main', delegated: true, operationId: 'create-operation' });
    expect(created.status, JSON.stringify(created.body)).toBe(200); expect(created.body.tpmNativeSessionId).toBe('tpm-1');
    expect(created.body).toMatchObject({ title: expect.stringMatching(/^[A-Z][a-z]+ [A-Z][a-z]+$/), waiting: 'user' });
    await expect.poll(() => sessions.get('tpm-1')!.sent.length, { timeout: 3000 }).toBe(1);
    let beforeRename = await broker.rpc('GET', '/remote/tpm/work?id=' + created.body.id);
    const earlierRevision = beforeRename.body.revision;
    if (delayedReceipt) expect(beforeRename.body.outbox).toEqual([expect.objectContaining({ purpose: 'initial', status: 'dispatching' })]);
    releaseReceipt();
    await expect.poll(async () => {
      beforeRename = await broker.rpc('GET', '/remote/tpm/work?id=' + created.body.id);
      expect(beforeRename.status, JSON.stringify(beforeRename.body)).toBe(200);
      return beforeRename.body.outbox?.find((intent: { purpose: string }) => intent.purpose === 'initial');
    }, { timeout: 3000 }).toMatchObject({ status: 'accepted', acceptance: 'started' });
    if (delayedReceipt) {
      expect(beforeRename.body.revision).toBeGreaterThan(earlierRevision);
      const staleRename = await broker.rpc('POST', '/remote/tpm/action', { id: created.body.id, revision: earlierRevision, operationId: 'stale-rename-operation', action: 'rename', title: 'Stale rename' });
      expect(staleRename, JSON.stringify(staleRename.body)).toMatchObject({ status: 409, body: { code: 'tpm_request_failed', error: 'TPM work changed. Refresh before applying this change.' } });
    }
    const renamed = await broker.rpc('POST', '/remote/tpm/action', { id: created.body.id, revision: beforeRename.body.revision, operationId: 'rename-operation', action: 'rename', title: 'Investigate mobile reconnect' });
    expect(renamed.status, JSON.stringify({ beforeRename: beforeRename.body, renamed: renamed.body })).toBe(200); expect(renamed.body.title).toBe('Investigate mobile reconnect');
    const workId = created.body.id; const native = sessions.get('tpm-1')!;
    await expect.poll(() => native.sent.length).toBe(1);
    const attached = await broker.rpc('POST', '/remote/attach', { providerId: 'codex', nativeSessionId: 'main' }, 'browser-main'); expect(attached.status).toBe(200);
    expect(sessions.get('main')!.observed).toBe(1); expect(native.observed).toBe(1);
    const listed = await broker.rpc('GET', '/remote/tpm'); expect(listed.body.works).toEqual([expect.objectContaining({ id: workId })]);
    expect(configurations[0]?.instructions).toContain(workId);
    const tools = configurations[0]!.tools!; const read = tools.find(tool => tool.name === 'read_work')!; const update = tools.find(tool => tool.name === 'update_work')!;
    const current = JSON.parse(await read.execute({}));
    await update.execute({ revision: current.revision, phase: 'implementing', waiting: 'main_session', summary: 'Waiting for implementation evidence', nextAction: 'Check main evidence' });
    await native.finish();
    await broker.close(); await expect.poll(() => host.state).toBe('disconnected');
    now += 1000; await expect.poll(() => native.sent.length).toBe(2);
    await expect.poll(async () => {
      const work = JSON.parse(await read.execute({}));
      const record = JSON.parse(await readFile(join(root, 'state', `${workId}.json`), 'utf8'));
      return { accepted: work.outbox?.find((intent: { id: string }) => intent.id === work.activeReviewId)?.status,
        turnId: record.backgroundReviews?.find((review: { id: string }) => review.id === work.activeReviewId)?.turnId };
    }, { timeout: 3000 }).toEqual({ accepted: 'accepted', turnId: 'review-2' });
    const reviewing = JSON.parse(await read.execute({}));
    await update.execute({ revision: reviewing.revision, reviewId: reviewing.activeReviewId, notify: false,
      phase: reviewing.phase, waiting: reviewing.waiting, summary: reviewing.summary, nextAction: reviewing.nextAction });
    native.reply('No change'); await native.finish();
    await expect.poll(async () => {
      const record = JSON.parse(await readFile(join(root, 'state', `${workId}.json`), 'utf8'));
      return record.backgroundReviews?.at(-1);
    }).toMatchObject({ turnId: 'review-2', result: { notify: false } });
    expect(native.sent[1]).toContain('Heartbeat.'); expect(sessions.get('main')!.closed).toBe(false);
    expect(sessions.get('main')!.observed).toBe(1); expect(native.observed).toBe(1);
  } finally { releaseReceipt(); await host.close(); await broker.close(); await rm(root, { recursive: true, force: true }); }
}, 10000);


it('isolates corrupt TPM persistence from ordinary native session attachment', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-tpm-corrupt-')));
  await writeFile(join(root, 'corrupt.json'), '{invalid-json');
  const session = new NativeSession('ordinary', root);
  const directory: AgentHostDirectory = { providerId: 'codex', list: () => [], workspaces: () => [],
    async create() { throw new Error('Unexpected create'); }, async open() { return session; }, close: () => session.dispose() };
  const host = createAgentHostRuntime({ tpm: { stateDirectory: root }, registrations: [{ directory, adapter: {
    descriptor: { providerId: 'codex', displayName: 'Codex' }, async createSession() { throw new Error('Unexpected direct create'); }, async resumeSession() { throw new Error('Unexpected direct resume'); },
  } }] });
  try {
    const tpm = await host.control({ method: 'GET', path: '/remote/tpm' }); expect(tpm.status).toBe(409);
    const ordinary = await host.control({ method: 'POST', path: '/remote/attach', sessionId: 'ordinary-agent', body: JSON.stringify({ providerId: 'codex', nativeSessionId: 'ordinary' }) });
    expect(ordinary.status).toBe(200); expect(session.observed).toBe(1);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
}, 10000);

it.each(['attach', 'snapshot', 'relay-restart'] as const)('restores a TPM-owned main session after Host restart through %s without changing the public identity', async firstRead => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-tpm-binding-')));
  const http = createServer();
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  let broker = createHostBroker({ origin, rpcTimeoutMs: 2000 });
  const sockets = new WebSocketServer({ noServer: true });
  http.on('upgrade', (request, socket, head) => {
    void (async () => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(key, value);
      const prepared = await broker.prepareUpgrade(new Request(origin + request.url, { headers }));
      if (!prepared || prepared instanceof Response) { socket.destroy(); return; }
      sockets.handleUpgrade(request, socket, head, client => prepared.accept({
        get readyState() { return client.readyState; }, get bufferedAmount() { return client.bufferedAmount; },
        send: data => client.send(data), close: (code, reason) => client.close(code, reason),
        onMessage(listener) { const receive = (data: RawData, binary: boolean) => { void listener(data.toString(), binary); }; client.on('message', receive); return () => { client.off('message', receive); }; },
        onClose(listener) { client.on('close', listener); return () => { client.off('close', listener); }; },
        onError(listener) { client.on('error', listener); return () => { client.off('error', listener); }; },
      }));
    })().catch(() => socket.destroy());
  });
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
    uplink: { url: origin.replace('http:', 'ws:') + '/ws/remote-host', remoteKey: credential, onCredential: async key => { credential = key; } } });
  };
  let host = startHost();
  const browsers: WebSocket[] = [];
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
    const snapshotPath = `/v1/sessions/${publicId}/snapshot?protocolVersion=1.7.0`;
    const first = firstRead === 'attach' ? await request(attachPath, { providerId: 'codex', nativeSessionId: 'main' }) : await request(snapshotPath);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect((await request(attachPath, { providerId: 'codex', nativeSessionId: 'main' })).body).toEqual(attached.body);
    const snapshot = await request(snapshotPath);
    expect(snapshot.body).toMatchObject({ type: 'agent_snapshot', payload: { id: publicId, runtimeInfo: { sessionId: 'main' } } });
    expect(broker.snapshot().bindings.find(binding => binding.nativeSessionId === 'main')?.agentId).toBe(publicId);
    const received: any[][] = [];
    for (let i = 0; i < 2; i++) {
      const messages: any[] = []; received.push(messages);
      const client = new WebSocket(origin.replace('http:', 'ws:') + `/v1/sessions/${publicId}/events`, { origin }); browsers.push(client);
      client.on('message', data => messages.push(JSON.parse(data.toString())));
      await once(client, 'open');
      client.send(JSON.stringify({ protocolVersion: '1.7.0', type: 'negotiate' }));
      await expect.poll(() => messages.some(message => message.type === 'negotiated')).toBe(true);
      await expect.poll(() => messages.find(message => message.type === 'session_control')?.payload.agentId).toBe(publicId);
      const control = messages.find(message => message.type === 'session_control')!.payload;
      client.send(JSON.stringify({ protocolVersion: '1.7.0', type: 'session_control_request', payload: { requestId: `control-${i}`, agentId: publicId, revision: control.revision, action: 'acquire' } }));
      await expect.poll(() => messages.findLast(message => message.type === 'session_control')?.payload.access).toBe('control');
      client.send(JSON.stringify({ protocolVersion: '1.7.0', type: 'timeline_subscription', payload: { requestId: `subscribe-${i}`, agentIds: [publicId] } }));
      await expect.poll(() => messages.find(message => message.type === 'timeline_subscribed')?.payload.agentIds).toEqual([publicId]);
    }
    browsers[0]!.send(JSON.stringify({ protocolVersion: '1.7.0', type: 'send_message', controlToken: received[0]!.findLast(message => message.type === 'session_control')!.payload.token, payload: {
      requestId: 'send', operationId: '00000000-0000-4000-8000-000000000001', agentId: publicId, text: publicId,
    } }));
    await expect.poll(() => ({ sent: main.sent, errors: received[0]!.filter(message => message.type === 'protocol_error') })).toEqual({ sent: [publicId], errors: [] });
    await expect.poll(() => received[0]!.find(message => message.type === 'command_acknowledged')?.payload.agentId).toBe(publicId);
    for (const messages of received) await expect.poll(() => messages.some(message => message.type === 'agent_stream' && message.payload.agentId === publicId
      && message.payload.event.item?.text === publicId)).toBe(true);
    const timeline = await request(`/v1/sessions/${publicId}/timeline?protocolVersion=1.7.0&requestId=history&direction=tail&limit=20`);
    expect(timeline.status, JSON.stringify(timeline.body)).toBe(200);
    expect(timeline.body.payload.agentId).toBe(publicId);
    const activity: any[] = [];
    const watcher = new WebSocket(origin.replace('http:', 'ws:') + `/v1/sessions/${publicId}/events`, { origin }); browsers.push(watcher);
    watcher.on('message', data => activity.push(JSON.parse(data.toString())));
    await once(watcher, 'open');
    watcher.send(JSON.stringify({ protocolVersion: '1.7.0', type: 'negotiate', observation: 'activity' }));
    await expect.poll(() => activity.find(message => message.type === 'agent_activity')?.payload.agentId).toBe(publicId);
    expect(main.observed).toBe(1);
  } finally {
    for (const browser of browsers) browser.terminate();
    await host.close(); broker.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

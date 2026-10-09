import { mkdtemp, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
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
  private sequence = 0;
  private queued: ProviderStreamItem[] = [{ type: 'history_boundary' }];
  private wake?: () => void;
  constructor(readonly id: string, private readonly cwd: string) {}
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
    this.sent.push(text); this.status = 'running';
    this.emit({ type: 'turn_started', provider: 'codex', turnId: 'review' });
    this.emit({ type: 'runtime_updated', provider: 'codex', runtimeInfo: await this.runtimeInfo(), activeTurnId: 'review' });
    return { disposition: 'started' as const };
  }
  async finish() {
    this.status = 'idle'; this.emit({ type: 'turn_completed', provider: 'codex', turnId: 'review' });
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

it('creates a scoped TPM over the real Host uplink and keeps shared observation and heartbeat after disconnect', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-tpm-host-'))); const broker = await uplink();
  let now = 1_000_000; const sessions = new Map<string, NativeSession>(); const configurations: AgentSessionConfig[] = [];
  const directory: AgentHostDirectory = { providerId: 'codex', list: async () => [], workspaces: async () => [],
    async create(config) { const id = `tpm-${configurations.length + 1}`; configurations.push({ ...config, sessionId: id }); sessions.set(id, new NativeSession(id, root)); return id; },
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
    const created = await broker.rpc('POST', '/remote/tpm/create', { providerId: 'codex', mainNativeSessionId: 'main', title: 'Persistent background work', requirement: 'Agree scope and verify delivery.', operationId: 'create-operation' });
    expect(created.status).toBe(200); expect(created.body.tpmNativeSessionId).toBe('tpm-1');
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
    expect(native.sent[1]).toContain('Heartbeat check'); expect(sessions.get('main')!.closed).toBe(false);
    expect(sessions.get('main')!.observed).toBe(1); expect(native.observed).toBe(1);
  } finally { await host.close(); await broker.close(); await rm(root, { recursive: true, force: true }); }
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

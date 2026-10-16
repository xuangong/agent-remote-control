import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentCapabilities, AgentProviderAdapter, AgentSession, AgentStreamEvent, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { createProtocolValidationServer } from '../src/server.js';

/** A real Relay transport with a deterministic native session that remains working. */
class WorkingSession implements AgentSession {
  readonly capabilities: AgentCapabilities = { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
    interactions: { question: false, toolApproval: false, planApproval: false } };
  private readonly items: ProviderStreamItem[] = [];
  private wake?: () => void;
  private closed = false;
  private running = false;
  private sequence = 0;
  constructor(private readonly id: string) {}
  async runtimeInfo() { return { providerId: 'working', sessionId: this.id, status: this.running ? 'running' as const : 'idle' as const, model: 'fixture-model' }; }
  async *observe(): AsyncIterable<ProviderStreamItem> {
    yield { type: 'observation', sourceKey: 'old-history', occurredAt: Date.now(), delivery: 'history',
      event: { type: 'timeline', provider: 'working', item: { type: 'assistant_message', messageId: 'old-reply', text: 'Previous completed round.' } } };
    yield { type: 'history_boundary' };
    while (!this.closed) {
      const item = this.items.shift();
      if (item) yield item;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
  private emit(event: AgentStreamEvent) {
    this.items.push({ type: 'observation', sourceKey: `live-${++this.sequence}`, occurredAt: Date.now(), delivery: 'live', event });
    this.wake?.();
  }
  async sendMessage(text: string) {
    this.running = true;
    this.emit({ type: 'runtime_updated', provider: 'working', runtimeInfo: await this.runtimeInfo() });
    this.emit({ type: 'turn_started', provider: 'working', turnId: 'working-turn' });
    this.emit({ type: 'timeline', provider: 'working', turnId: 'working-turn', item: { type: 'user_message', text } });
    this.emit({ type: 'timeline', provider: 'working', turnId: 'working-turn', item: { type: 'assistant_message', messageId: 'working-reply', text: 'Latest visible reply while work continues.' } });
  }
  async respondToInteraction() {}
  async dispose() { this.closed = true; this.wake?.(); }
}

const root = await mkdtemp(join(tmpdir(), 'arc-live-cache-'));
const sessions = new Map<string, WorkingSession>();
const provider: AgentProviderAdapter = {
  descriptor: { providerId: 'working', displayName: 'Working cache fixture' },
  async createSession(config) { const session = new WorkingSession(config.sessionId); sessions.set(config.sessionId, session); return session; },
  async resumeSession(handle) { const session = sessions.get(handle.sessionId); if (!session) throw new Error('Missing fixture session'); return session; },
};
const server = createProtocolValidationServer({ providers: [provider], labOrigin: process.env.AGENT_REMOTE_ORIGIN!,
  imageDirectory: join(root, 'images'), resourceDirectory: join(root, 'resources'), teamResourceDirectory: join(root, 'team-resources'), successionStateDirectory: join(root, 'succession') });
const address = await server.http.listen(Number(process.env.AGENT_REMOTE_PORT), '127.0.0.1');
process.stdout.write(`Working cache fixture listening on ${address.url}\n`);
async function close() { await server.close(); await rm(root, { recursive: true, force: true }); process.exit(0); }
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });

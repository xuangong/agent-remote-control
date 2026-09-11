import type { SessionEvent } from '@github/copilot-sdk';
import type { AgentCapabilities, AgentChildSession, AgentRuntimeInfo, AgentSession, ProviderStreamItem } from '@borgee/agent-provider-sdk';
import { Channel } from './channel.js';
import { Projector, record } from './projector.js';
import type { CopilotAgentSession } from './session.js';
/** A child is a view over its parent's native task and event journal, never a resumed root. */
export class CopilotChildSession implements AgentSession {
  readonly capabilities: AgentCapabilities = { history: true, sendMessage: true, steer: true, cancel: true, readResource: false, interactions: {question: false, planApproval: false, toolApproval: false} };
  private readonly stream = new Channel<ProviderStreamItem>();
  private readonly projector = new Projector();
  private readonly seen = new Set<string>();
  private buffered: SessionEvent[] | undefined = [];
  private closed = false;
  private observed = false;
  private revision = 0;
  constructor(private readonly parent: CopilotAgentSession, private readonly info: AgentChildSession, private readonly onDispose: () => void) {}
  async initialize(): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.parent.call(this.parent.rpc.eventLog.read({cursor, max: 1000, agentIds: [this.info.nativeSessionId, ...(this.info.parentCallId ? [this.info.parentCallId] : [])], includeEphemeral: false}), 'Copilot child history');
      for (const event of page.events) this.project(event, 'history');
      if (!page.hasMore) break;
      if (page.cursor === cursor) throw new Error('Copilot child history cursor did not advance.');
      cursor = page.cursor;
    } while (!this.closed);
    this.stream.push({type: 'history_boundary'}); const buffered = this.buffered!; this.buffered = undefined;
    for (const event of buffered) this.project(event, 'live');
  }
  accept(event: SessionEvent, delivery: 'history' | 'live'): void {
    const d = record(event.data); const owner = event.agentId ?? d.parentToolCallId;
    if (owner !== this.info.nativeSessionId && owner !== this.info.parentCallId) return;
    if (this.buffered) this.buffered.push(event); else this.project(event, delivery);
  }
  private project(event: SessionEvent, delivery: 'history' | 'live') {
    if (this.closed || this.seen.has(event.id)) return; this.seen.add(event.id);
    const projected = this.projector.project(event);
    if (projected) this.stream.push({type: 'observation', sourceKey: `copilot:child:${this.info.nativeSessionId}:${projected.key}`, nativeRevision: ++this.revision, occurredAt: Date.parse(event.timestamp), delivery, event: projected.event});
  }
  observe() { if (this.observed) throw new Error('Copilot child observation already attached.'); this.observed = true; return this.stream; }
  async sendMessage(text: string): Promise<void> {
    if (this.closed || this.parent.isClosed) throw new Error('Copilot child view is closed.');
    const result = await this.parent.call(this.parent.rpc.tasks.sendMessage({id: this.info.nativeSessionId, message: text}), 'Copilot child input');
    if (!result.sent) throw new Error(result.error ?? 'Copilot child input was rejected.');
  }
  async steer(text: string) { await this.sendMessage(text); }
  async cancel() {
    if (this.closed || this.parent.isClosed) throw new Error('Copilot child view is closed.');
    const result = await this.parent.call(this.parent.rpc.tasks.cancel({id: this.info.nativeSessionId}), 'Copilot child cancellation');
    if (!result.cancelled) throw new Error('Copilot child cancellation was rejected.');
  }
  async respondToInteraction(): Promise<void> { throw new Error('Copilot child interactions are owned by the parent session.'); }
  async runtimeInfo(): Promise<AgentRuntimeInfo> {
    const parent = await this.parent.runtimeInfo(); const current = parent.childSessions?.find(child => child.nativeSessionId === this.info.nativeSessionId) ?? this.info;
    return {providerId: 'copilot', sessionId: this.info.nativeSessionId, status: this.closed ? 'closed' : current.status, cwd: parent.cwd};
  }
  async dispose(): Promise<void> { if (this.closed) return; this.closed = true; this.stream.close(); this.onDispose(); }
}

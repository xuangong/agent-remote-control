import type { SessionEvent } from '@github/copilot-sdk';
import type { AgentCapabilities, AgentChildSession, AgentRuntimeInfo, AgentSession, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { Channel } from './channel.js';
import {isNativeInteraction} from './interaction-mapping.js';
import { Projector, record } from './projector.js';
import type { CopilotAgentSession } from './session.js';
/** A child is a view over its parent's native task and event journal, never a resumed root. */
export class CopilotChildSession implements AgentSession {
  readonly capabilities: AgentCapabilities = { history: true, sendMessage: true, steer: true, cancel: true, readResource: false, interactions: {question: false, planApproval: false, toolApproval: false} };
  private readonly stream = new Channel<ProviderStreamItem>();
  private readonly projector: Projector;
  private readonly seen = new Set<string>();
  private buffered: SessionEvent[] | undefined = [];
  private closed = false;
  private observed = false;
  private revision = 0;
  activityGeneration = 0;
  private taskRevision = 0;
  private lastTaskTerminal?: string;
  private deferredTask?: {info: AgentChildSession; expectedGeneration: number; nativeStatus?: string};
  constructor(private readonly parent: CopilotAgentSession, private readonly info: AgentChildSession, private readonly onDispose: () => void) {
    this.projector = new Projector(parent.cwd);
  }
  async initialize(): Promise<void> {
    let cursor: string | undefined;
    const history: SessionEvent[] = [];
    do {
      const page = await this.parent.call(this.parent.rpc.eventLog.read({cursor, max: 1000, agentIds: [this.info.nativeSessionId, ...(this.info.parentCallId ? [this.info.parentCallId] : [])], includeEphemeral: false}), 'Copilot child history');
      history.push(...page.events);
      if (!page.hasMore) break;
      if (page.cursor === cursor) throw new Error('Copilot child history cursor did not advance.');
      cursor = page.cursor;
    } while (!this.closed);
    this.projector.prepareHistory(history, this.info.status === 'idle' || this.info.status === 'closed');
    for (const event of history) this.project(event, 'history');
    this.stream.push({type: 'history_boundary'}); const buffered = this.buffered!; this.buffered = undefined;
    for (const event of buffered) this.project(event, 'live');
    if (this.deferredTask) {
      const snapshot = this.deferredTask; this.deferredTask = undefined;
      this.updateTask(snapshot.info, snapshot.expectedGeneration, snapshot.nativeStatus);
    }
  }
  accept(event: SessionEvent, delivery: 'history' | 'live'): void {
    const d = record(event.data); const owner = event.agentId ?? d.parentToolCallId;
    if (owner !== this.info.nativeSessionId && owner !== this.info.parentCallId) return;
    if (event.type === 'assistant.turn_start') this.activityGeneration++;
    if (this.buffered) this.buffered.push(event); else this.project(event, delivery);
  }
  private project(event: SessionEvent, delivery: 'history' | 'live') {
    if (this.closed || this.seen.has(event.id) || isNativeInteraction(event)) return; this.seen.add(event.id);
    for (const projected of this.projector.projectAll(event, delivery)) this.stream.push({type: 'observation', sourceKey: `copilot:child:${this.info.nativeSessionId}:${projected.key}`, nativeRevision: ++this.revision, occurredAt: Date.parse(event.timestamp), delivery, event: projected.event});
  }
  updateTask(info: AgentChildSession, expectedGeneration?: number, nativeStatus?: string): void {
    if (this.closed || expectedGeneration !== this.activityGeneration) return;
    if (this.buffered) { this.deferredTask = {info, expectedGeneration, nativeStatus}; return; }
    const terminal = `${nativeStatus ?? info.status}:${this.activityGeneration}`;
    if (this.lastTaskTerminal === terminal) return;
    if (info.status !== 'running' && info.status !== 'starting' && info.status !== 'waiting') this.lastTaskTerminal = terminal;
    if (nativeStatus === 'cancelled') { this.finishCanceled(); return; }
    if (nativeStatus === 'failed') {
      this.project({type: 'session.error', id: `task-failed:${this.info.nativeSessionId}:${++this.taskRevision}`, parentId: null, timestamp: new Date().toISOString(), data: {message: 'Native child task failed', errorType: 'task'}} as SessionEvent, 'live');
      return;
    }
    if (info.status === 'idle' || info.status === 'closed') {
      this.project({type: 'assistant.idle', id: `task-idle:${this.info.nativeSessionId}:${++this.taskRevision}`, parentId: null, timestamp: new Date().toISOString(), ephemeral: true, data: {}} as SessionEvent, 'live');
    }
  }
  observe() { if (this.observed) throw new Error('Copilot child observation already attached.'); this.observed = true; return this.stream; }
  async sendMessage(text: string): Promise<void> {
    if (this.closed || this.parent.isClosed) throw new Error('Copilot child view is closed.');
    this.activityGeneration++;
    const result = await this.parent.call(this.parent.rpc.tasks.sendMessage({id: this.info.nativeSessionId, message: text}), 'Copilot child input');
    if (!result.sent) throw new Error(result.error ?? 'Copilot child input was rejected.');
  }
  async steer(text: string) { await this.sendMessage(text); }
  async cancel() {
    if (this.closed || this.parent.isClosed) throw new Error('Copilot child view is closed.');
    const result = await this.parent.call(this.parent.rpc.tasks.cancel({id: this.info.nativeSessionId}), 'Copilot child cancellation');
    if (!result.cancelled) throw new Error('Copilot child cancellation was rejected.');
    this.finishCanceled();
  }
  private finishCanceled(): void {
    this.parent.cancelChildInteractions(this.info.nativeSessionId);
    this.project({type: 'abort', id: `task-canceled:${this.info.nativeSessionId}:${++this.taskRevision}`, parentId: null, timestamp: new Date().toISOString(), data: {}} as SessionEvent, 'live');
  }
  async respondToInteraction(): Promise<void> { throw new Error('Copilot child interactions are owned by the parent session.'); }
  async runtimeInfo(): Promise<AgentRuntimeInfo> {
    const parent = await this.parent.runtimeInfo(); const current = parent.childSessions?.find(child => child.nativeSessionId === this.info.nativeSessionId) ?? this.info;
    return {providerId: 'copilot', sessionId: this.info.nativeSessionId, status: this.closed ? 'closed' : current.status, cwd: parent.cwd};
  }
  async dispose(): Promise<void> { if (this.closed) return; this.closed = true; this.stream.close(); this.onDispose(); }
}

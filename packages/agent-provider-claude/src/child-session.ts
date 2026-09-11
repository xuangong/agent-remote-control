import type { AgentChildSession, AgentSession, AgentRuntimeInfo, ProviderObservation, ProviderStreamItem } from '@borgee/agent-provider-sdk';
import { Channel } from './channel.js';
import { ClaudeEventProjector, record } from './projector.js';

interface NativeFrame { message: Record<string, unknown>; streamMessageId?: string; blockIndex?: number }
const blockKey = (messageId: string, index: number): string => JSON.stringify([messageId, index]);

/** A view of a root-owned native task; releasing it never controls the native process. */
export class ClaudeChildSession implements AgentSession {
  readonly capabilities = { history: true, sendMessage: false, steer: false, cancel: false, readResource: false,
    interactions: { question: false, toolApproval: false, planApproval: false } };
  private history: ProviderObservation[] = [];
  private readonly projector: ClaudeEventProjector;
  private historyProjector: ClaudeEventProjector;
  private pending: NativeFrame[] = [];
  private readonly savedBlocks = new Set<string>();
  private streamMessageId?: string;
  private lastDelivered?: NativeFrame;
  private output?: Channel<ProviderStreamItem>;
  private sequence = 0;
  private model?: string;

  constructor(readonly descriptor: AgentChildSession, private readonly cwd?: string) {
    this.projector = new ClaudeEventProjector(descriptor.nativeSessionId);
    this.historyProjector = new ClaudeEventProjector(descriptor.nativeSessionId);
  }
  get hasHistory(): boolean { return this.history.length > 0; }

  accept(message: Record<string, unknown>): void {
    if (message.type === 'stream_event' && record(message.event) && message.event.type === 'message_start' && record(message.event.message)) {
      this.streamMessageId = message.event.message.id;
    }
    const index = message.type === 'stream_event' && record(message.event) && typeof message.event.index === 'number' ? message.event.index : undefined;
    if (this.streamMessageId && index !== undefined && this.savedBlocks.has(blockKey(this.streamMessageId, index))) return;
    const frame = { message, ...(message.type === 'stream_event' ? { streamMessageId: this.streamMessageId, blockIndex: index } : {}) };
    this.pending.push(frame);
    if (typeof (message.message as { model?: unknown } | undefined)?.model === 'string') this.model = (message.message as { model: string }).model;
    this.history.push(...this.project(this.historyProjector, message));
    for (const observation of this.project(this.projector, message)) {
      this.lastDelivered = frame;
      this.output?.push(observation);
    }
  }

  /** Replace future replay from native order; an existing append-only observer receives only a new suffix. */
  reconcileHistory(messages: Record<string, unknown>[]): void {
    const uuids = new Map<string, number>();
    const blocks = new Map<string, number>();
    const blockCounts = new Map<string, number>();
    messages.forEach((message, index) => {
      if (typeof message.uuid === 'string' && uuids.has(message.uuid)) return;
      if (typeof message.uuid === 'string') uuids.set(message.uuid, index);
      if (message.type === 'assistant' && record(message.message) && typeof message.message.id === 'string' && Array.isArray(message.message.content)) {
        const id = message.message.id;
        let count = blockCounts.get(id) ?? 0;
        for (const block of message.message.content) {
          if (!record(block)) continue;
          const key = blockKey(id, count++);
          blocks.set(key, index);
          this.savedBlocks.add(key);
        }
        blockCounts.set(id, count);
      }
    });
    const position = (frame: NativeFrame): number | undefined => frame.streamMessageId && frame.blockIndex !== undefined
      ? blocks.get(blockKey(frame.streamMessageId, frame.blockIndex))
      : typeof frame.message.uuid === 'string' ? uuids.get(frame.message.uuid) : undefined;
    const anchor = this.lastDelivered ? position(this.lastDelivered) ?? Infinity : -1;
    this.historyProjector = new ClaudeEventProjector(this.descriptor.nativeSessionId);
    this.history = messages.flatMap((message) => this.project(this.historyProjector, message));
    this.pending = this.pending.filter((frame) => position(frame) === undefined);
    for (const frame of this.pending) this.history.push(...this.project(this.historyProjector, frame.message));
    messages.forEach((message, index) => {
      // Seed deduplication for older messages without appending missing history behind live output.
      for (const observation of this.project(this.projector, message)) {
        if (index < anchor) continue;
        this.lastDelivered = { message };
        this.output?.push(observation);
      }
      if (record(message.message) && typeof message.message.model === 'string') this.model = message.message.model;
    });
  }

  private project(projector: ClaudeEventProjector, message: Record<string, unknown>): ProviderObservation[] {
    return projector.project({ ...message, session_id: this.descriptor.nativeSessionId, parent_tool_use_id: null });
  }

  async *observe(): AsyncIterable<ProviderStreamItem> {
    if (this.output) throw new Error('Claude child already has an observer.');
    const output = new Channel<ProviderStreamItem>();
    this.output = output;
    const history = this.history.slice();
    try {
      for (const item of history) yield { ...item, delivery: 'history' };
      yield { type: 'history_boundary' };
      yield* output;
    } finally { if (this.output === output) this.output = undefined; output.close(); }
  }

  async sendMessage(): Promise<void> { throw new Error('Claude child views are read-only.'); }
  async respondToInteraction(): Promise<void> { throw new Error('Claude child views are read-only; respond in the parent session.'); }
  async runtimeInfo(): Promise<AgentRuntimeInfo> {
    return { providerId: 'claude', sessionId: this.descriptor.nativeSessionId, status: this.descriptor.status, cwd: this.cwd, model: this.model ?? null };
  }
  changed(): void {
    this.output?.push({ type: 'observation', sourceKey: `claude-child:${this.descriptor.nativeSessionId}:runtime:${++this.sequence}`,
      occurredAt: Date.now(), delivery: 'live', event: { type: 'runtime_updated', provider: 'claude', runtimeInfo: {
        providerId: 'claude', sessionId: this.descriptor.nativeSessionId, status: this.descriptor.status, cwd: this.cwd, model: this.model ?? null } } });
  }
  async dispose(): Promise<void> { this.output?.close(); this.output = undefined; }
}

import type { SessionEvent } from '@github/copilot-sdk';
import { boundToolResult, type AgentStreamEvent, type AgentToolDetail } from '@borgee/agent-provider-sdk';
export const provider = 'copilot';
export function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function detail(name: string, value: unknown): AgentToolDetail {
  const args = record(value);
  const command = args.command ?? args.fullCommandText;
  if (typeof command === 'string') return { type: 'shell', command };
  const path = args.path ?? args.file_path ?? args.fileName;
  if (typeof path === 'string') return { type: /edit|patch/i.test(name) ? 'edit' : /write|create/i.test(name) ? 'write' : 'read', filePath: path };
  return { type: 'other', description: name };
}
/** Durable messages replace streaming snapshots through the same source key. */
export class Projector {
  private readonly tools = new Map<string, { name: string; detail: AgentToolDetail }>();
  private readonly messages = new Map<string, string>();
  private turnId: string | undefined;
  private active = false;
  private readonly finalizedMessages = new Set<string>();
  private readonly historicalCompletions = new Set<string>();
  prepareHistory(events: SessionEvent[], trailingComplete = true): void {
    let lastEnd: string | undefined;
    for (const event of events) {
      if (event.type === 'user.message') {
        if (lastEnd) this.historicalCompletions.add(lastEnd);
        lastEnd = undefined;
      }
      if (event.type === 'assistant.turn_end') lastEnd = event.id;
      if (event.type === 'abort' || event.type === 'session.error') lastEnd = undefined;
    }
    if (lastEnd && trailingComplete) this.historicalCompletions.add(lastEnd);
  }
  project(event: SessionEvent, delivery: 'history' | 'live' = 'live'): { key: string; event: AgentStreamEvent } | undefined {
    const d = record(event.data);
    // Native child loops reuse numeric turn IDs on follow-up; event IDs remain unique.
    if (event.type === 'assistant.turn_start' && !this.active) this.turnId = `turn:${event.id}`;
    const turnId = this.turnId;
    const wrap = (value: AgentStreamEvent, key = event.id) => ({ key, event: value });
    const timeline = (item: Extract<AgentStreamEvent, {type: 'timeline'}>['item'], key?: string) => wrap({ type: 'timeline', provider, item, turnId }, key);
    switch (event.type) {
      case 'user.message': return timeline({ type: 'user_message', text: event.data.content, messageId: event.id });
      case 'assistant.message_delta': {
        const { messageId, deltaContent } = event.data;
        if (this.finalizedMessages.has(messageId)) return undefined;
        const text = (this.messages.get(messageId) ?? '') + deltaContent;
        this.messages.set(messageId, text); return timeline({ type: 'assistant_message', text, messageId }, `message:${messageId}`);
      }
      case 'assistant.message': this.finalizedMessages.add(event.data.messageId); this.messages.delete(event.data.messageId); return timeline({ type: 'assistant_message', text: event.data.content, messageId: event.data.messageId }, `message:${event.data.messageId}`);
      case 'assistant.reasoning': return timeline({ type: 'reasoning', text: event.data.content });
      case 'assistant.turn_start':
        if (this.active) return undefined;
        this.active = true; return wrap({ type: 'turn_started', provider, turnId });
      case 'assistant.turn_end':
        if (delivery !== 'history' || !this.historicalCompletions.has(event.id)) return undefined;
        if (!this.active) return undefined;
        this.active = false; return wrap({ type: 'turn_completed', provider, turnId });
      case 'assistant.idle':
        if (!this.active) return undefined;
        this.active = false; return wrap({ type: 'turn_completed', provider, turnId });
      case 'abort': this.active = false; return wrap({ type: 'turn_canceled', provider, reason: 'Native turn aborted', turnId });
      case 'session.error': this.active = false; return wrap({ type: 'turn_failed', provider, error: event.data.message, turnId });
      case 'tool.execution_start': {
        const tool = { name: event.data.toolName, detail: detail(event.data.toolName, event.data.arguments) };
        this.tools.set(event.data.toolCallId, tool);
        return timeline({ type: 'tool_call', callId: event.data.toolCallId, ...tool, status: 'running', error: null }, `tool:${event.data.toolCallId}`);
      }
      case 'tool.execution_complete': {
        const tool = this.tools.get(event.data.toolCallId) ?? { name: 'Tool', detail: { type: 'other' as const, description: 'Native tool' } };
        const result = boundToolResult({ content: event.data.result ? [{ type: 'text', text: event.data.result.content }] : [] });
        return timeline({ type: 'tool_call', callId: event.data.toolCallId, ...tool, result, ...(event.data.success ? {status: 'completed' as const, error: null} : {status: 'failed' as const, error: event.data.error?.message ?? 'Native tool failed'}) }, `tool:${event.data.toolCallId}`);
      }
      case 'assistant.usage': return wrap({ type: 'usage_updated', provider, usage: { inputTokens: event.data.inputTokens, outputTokens: event.data.outputTokens, cachedInputTokens: event.data.cacheReadTokens }, turnId });
      case 'session.compaction_start': return timeline({type: 'compaction', status: 'loading'});
      case 'session.compaction_complete': return timeline({type: 'compaction', status: 'completed'});
      default: return undefined;
    }
  }
}

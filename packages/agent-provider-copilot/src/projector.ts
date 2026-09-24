import type { SessionEvent } from '@github/copilot-sdk';
import {resolve} from 'node:path';
import { boundToolResult, TOOL_RESULT_MAX_CHARS, redactInteractionResponse, type AgentStreamEvent, type AgentToolDetail, type AgentInteractionRequest } from '@orchardworks/agent-provider-sdk';
import {provider, record, detail} from './native.js';
export {provider, record, detail} from './native.js';
import {interactionRequest, interactionResponse} from './interaction-mapping.js';
import {copilotToolResult, patchFiles} from './tool-result.js';
/** Assistant text observations are append-only; durable messages contribute only an unsent suffix. */
export class Projector {
  private readonly tools = new Map<string, { name: string; detail: AgentToolDetail }>();
  private readonly toolPaths = new Map<string, string[]>();
  private readonly reasoning = new Map<string, string>();
  private readonly finalizedReasoning = new Set<string>();
  private readonly toolOutput = new Map<string, string>();
  private readonly completedTools = new Set<string>();
  private readonly messages = new Map<string, string>();
  private readonly historicalInteractions = new Map<string, AgentInteractionRequest>();
  private turnId: string | undefined;
  private active = false;
  private inputTurnId?: string;
  private interactionId?: string;
  private readonly finalizedMessages = new Set<string>();
  private readonly historicalCompletions = new Set<string>();
  constructor(private readonly cwd?: string) {}
  prepareHistory(events: SessionEvent[], trailingComplete = true): void {
    let lastEnd: string | undefined;
    let interactionId: unknown;
    let hasStep = false;
    for (const event of events) {
      const data = record(event.data);
      if (event.type === 'user.message' && data.delivery !== 'steering' && (!data.interactionId || data.interactionId !== interactionId)) {
        if (lastEnd) this.historicalCompletions.add(lastEnd);
        lastEnd = undefined;
      }
      // A reset model-step counter starts a new foreground run, including background follow-ups.
      if (event.type === 'assistant.turn_start') {
        if (hasStep && data.turnId === '0' && lastEnd) { this.historicalCompletions.add(lastEnd); lastEnd = undefined; }
        hasStep = true;
      }
      if (data.interactionId) interactionId = data.interactionId;
      if (event.type === 'assistant.turn_end') lastEnd = event.id;
      if (event.type === 'abort' || event.type === 'session.error') lastEnd = undefined;
    }
    if (lastEnd && trailingComplete) this.historicalCompletions.add(lastEnd);
  }
  /** Native queue drain has one idle event; each delivered interaction still owns a public turn. */
  projectAll(event: SessionEvent, delivery: 'history' | 'live' = 'live'): {key: string; event: AgentStreamEvent}[] {
    const d = record(event.data);
    if (delivery === 'history') {
      let request: AgentInteractionRequest | undefined;
      try {request = interactionRequest(event);} catch {
        return [{key: event.id, event: {type: 'timeline', provider, item: {type: 'error', message: 'Historical Copilot interaction uses an unsupported schema.'}}}];
      }
      if (request) this.historicalInteractions.set(request.requestId, request);
      const requestId = typeof d.requestId === 'string' ? d.requestId : '';
      const pending = this.historicalInteractions.get(requestId);
      const response = pending && interactionResponse(event, pending);
      if (pending && response) {
        this.historicalInteractions.delete(requestId);
        return [{key: `interaction:${requestId}`, event: {type: 'timeline', provider, turnId: this.turnId, item: {type: 'interaction', request: pending, response: redactInteractionResponse(pending, response)}}}];
      }
    }
    const interactionId = typeof d.interactionId === 'string' ? d.interactionId : undefined;
    const boundary = (event.type === 'user.message' || event.type === 'assistant.turn_start')
      && d.delivery !== 'steering'
      && ((interactionId && this.interactionId && interactionId !== this.interactionId)
        || (event.type === 'user.message' && d.delivery === 'queued' && !interactionId));
    const result: {key: string; event: AgentStreamEvent}[] = [];
    if (this.active && boundary) {
      result.push({key: `interaction-end:${event.id}`, event: {type: 'turn_completed', provider, turnId: this.turnId}});
      this.active = false;
    }
    if (interactionId) this.interactionId = interactionId;
    const projected = this.project(event, delivery);
    if (projected) result.push(projected);
    return result;
  }
  project(event: SessionEvent, delivery: 'history' | 'live' = 'live'): { key: string; event: AgentStreamEvent } | undefined {
    const d = record(event.data);
    // Native child loops reuse numeric turn IDs on follow-up; event IDs remain unique.
    if (event.type === 'user.message' && !this.active) {
      this.inputTurnId = `turn:${event.id}`;
      this.turnId = this.inputTurnId;
    }
    if (event.type === 'assistant.turn_start' && !this.active) {
      this.turnId = this.inputTurnId ?? `turn:${event.id}`;
      this.inputTurnId = undefined;
    }
    const turnId = this.turnId;
    const wrap = (value: AgentStreamEvent, key = event.id) => ({ key, event: value });
    const timeline = (item: Extract<AgentStreamEvent, {type: 'timeline'}>['item'], key?: string) => wrap({ type: 'timeline', provider, item, turnId }, key);
    switch (event.type) {
      case 'user.message': return timeline({ type: 'user_message', text: event.data.content, messageId: event.id });
      case 'assistant.message_delta': {
        const { messageId, deltaContent } = event.data;
        if (this.finalizedMessages.has(messageId) || !deltaContent) return undefined;
        const text = (this.messages.get(messageId) ?? '') + deltaContent;
        this.messages.set(messageId, text); return timeline({ type: 'assistant_message', text: deltaContent, messageId }, `message:${messageId}`);
      }
      case 'assistant.message': {
        const {messageId, content} = event.data;
        if (this.finalizedMessages.has(messageId)) return undefined;
        const streamed = this.messages.get(messageId) ?? '';
        this.finalizedMessages.add(messageId); this.messages.delete(messageId);
        if (!content || content === streamed) return undefined;
        if (!content.startsWith(streamed)) {
          // A corrected final cannot replace an append-only stream; preserve it as a separate message.
          return timeline({type: 'assistant_message', text: content, messageId: `${messageId}:correction`}, `message:${messageId}:correction`);
        }
        return timeline({type: 'assistant_message', text: content.slice(streamed.length), messageId}, `message:${messageId}`);
      }
      case 'assistant.reasoning_delta': {
        const {reasoningId, deltaContent} = event.data;
        if (this.finalizedReasoning.has(reasoningId) || !deltaContent) return undefined;
        this.reasoning.set(reasoningId, (this.reasoning.get(reasoningId) ?? '') + deltaContent);
        return timeline({type: 'reasoning', text: deltaContent});
      }
      case 'assistant.reasoning': {
        const {reasoningId, content} = event.data;
        if (this.finalizedReasoning.has(reasoningId)) return undefined;
        const streamed = this.reasoning.get(reasoningId) ?? '';
        this.finalizedReasoning.add(reasoningId); this.reasoning.delete(reasoningId);
        const text = content.startsWith(streamed) ? content.slice(streamed.length) : `\n${content}`;
        return text.trim() ? timeline({type: 'reasoning', text}) : undefined;
      }
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
      case 'abort': this.active = false; this.inputTurnId = undefined; return wrap({ type: 'turn_canceled', provider, reason: 'Native turn aborted', turnId });
      case 'session.error': this.active = false; this.inputTurnId = undefined; return wrap({ type: 'turn_failed', provider, error: event.data.message, turnId });
      case 'tool.execution_start': {
        const tool = { name: event.data.toolName, detail: detail(event.data.toolName, event.data.arguments) };
        this.tools.set(event.data.toolCallId, tool);
        const paths = tool.name === 'apply_patch' ? patchFiles(event.data.arguments).map(file => file.path)
          : 'filePath' in tool.detail ? [tool.detail.filePath] : [];
        this.toolPaths.set(event.data.toolCallId, this.cwd ? paths.flatMap(path => [path, resolve(this.cwd!, path)]) : paths);
        return timeline({ type: 'tool_call', callId: event.data.toolCallId, ...tool, status: 'running', error: null }, `tool:${event.data.toolCallId}`);
      }
      case 'tool.execution_partial_result': {
        const {toolCallId, partialOutput} = event.data;
        if (this.completedTools.has(toolCallId) || !partialOutput) return undefined;
        const tool = this.tools.get(toolCallId); if (!tool) return undefined;
        const text = ((this.toolOutput.get(toolCallId) ?? '') + partialOutput).slice(0, TOOL_RESULT_MAX_CHARS + 1);
        this.toolOutput.set(toolCallId, text);
        return timeline({type: 'tool_call', callId: toolCallId, ...tool, status: 'running', error: null, result: boundToolResult({content: [{type: 'text', text}]})}, `tool:${toolCallId}`);
      }
      case 'tool.execution_complete': {
        this.completedTools.add(event.data.toolCallId); this.toolOutput.delete(event.data.toolCallId);
        const tool = this.tools.get(event.data.toolCallId) ?? { name: 'Tool', detail: { type: 'other' as const, description: 'Native tool' } };
        const result = copilotToolResult(tool.name, tool.detail, event.data.result, this.toolPaths.get(event.data.toolCallId));
        return timeline({ type: 'tool_call', callId: event.data.toolCallId, ...tool, result, ...(event.data.success ? {status: 'completed' as const, error: null} : {status: 'failed' as const, error: event.data.error?.message ?? 'Native tool failed'}) }, `tool:${event.data.toolCallId}`);
      }
      case 'session.usage_info': return wrap({type: 'usage_updated', provider, turnId, usage: {contextWindowUsedTokens: event.data.currentTokens, contextWindowMaxTokens: event.data.tokenLimit}});
      case 'assistant.usage': return wrap({ type: 'usage_updated', provider, usage: { inputTokens: event.data.inputTokens, outputTokens: event.data.outputTokens, cachedInputTokens: event.data.cacheReadTokens }, turnId });
      case 'session.compaction_start': return timeline({type: 'compaction', status: 'loading'});
      case 'session.compaction_complete': return event.data.success
        ? timeline({type: 'compaction', status: 'completed', trigger: event.data.trigger === 'manual' ? 'manual' : event.data.trigger ? 'auto' : undefined, preTokens: event.data.preCompactionTokens})
        : timeline({type: 'error', message: `Copilot compaction failed: ${event.data.error ?? 'Unknown native error'}`});
      default: return undefined;
    }
  }
}

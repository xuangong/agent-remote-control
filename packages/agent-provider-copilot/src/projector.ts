import type { SessionEvent } from '@github/copilot-sdk';
import {resolve} from 'node:path';
import { boundToolResult, TOOL_RESULT_MAX_CHARS, redactInteractionResponse, type AgentStreamEvent, type AgentToolDetail, type AgentInteractionRequest, type ProviderItemIdentity } from '@orchardworks/agent-provider-sdk';
import {provider, record, detail} from './native.js';
export {provider, record, detail} from './native.js';
import {interactionRequest, interactionResponse} from './interaction-mapping.js';
import {copilotToolResult, patchFiles} from './tool-result.js';
import {copilotContextUsage} from './usage.js';
import {copilotUsageLimited} from './usage-limit.js';
/** One observation of a native event: its source key, what it says, and the item it belongs to. */
export interface Projected { key: string; event: AgentStreamEvent; identity?: ProviderItemIdentity }
/** Assistant text observations are append-only; durable messages contribute only an unsent suffix. Every timeline observation carries the identity of its item, the same live and when read again from history. */
export class Projector {
  private readonly tools = new Map<string, { name: string; detail: AgentToolDetail }>();
  private readonly toolPaths = new Map<string, string[]>();
  private readonly reasoning = new Map<string, string>();
  private readonly finalizedReasoning = new Set<string>();
  private readonly toolOutput = new Map<string, string>();
  private readonly completedTools = new Set<string>();
  private readonly messages = new Map<string, string>();
  private readonly historicalInteractions = new Map<string, AgentInteractionRequest>();
  private pendingCompaction: string | undefined;
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
  projectAll(event: SessionEvent, delivery: 'history' | 'live' = 'live'): Projected[] {
    const d = record(event.data);
    if (delivery === 'history') {
      let request: AgentInteractionRequest | undefined;
      try {request = interactionRequest(event);} catch {
        return [{key: event.id, event: {type: 'timeline', provider, item: {type: 'error', message: 'Historical Copilot interaction uses an unsupported schema.'}}, identity: {key: `error:${event.id}`, completes: true}}];
      }
      if (request) this.historicalInteractions.set(request.requestId, request);
      const requestId = typeof d.requestId === 'string' ? d.requestId : '';
      const pending = this.historicalInteractions.get(requestId);
      const response = pending && interactionResponse(event, pending);
      if (pending && response) {
        this.historicalInteractions.delete(requestId);
        return [{key: `interaction:${requestId}`, event: {type: 'timeline', provider, turnId: this.turnId, item: {type: 'interaction', request: pending, response: redactInteractionResponse(pending, response)}}, identity: {key: `interaction:${requestId}`, completes: true, ...(pending.kind === 'tool_approval' ? {} : {liveOnly: true as const})}}];
      }
    }
    const interactionId = typeof d.interactionId === 'string' ? d.interactionId : undefined;
    const boundary = (event.type === 'user.message' || event.type === 'assistant.turn_start')
      && d.delivery !== 'steering'
      && ((interactionId && this.interactionId && interactionId !== this.interactionId)
        || (event.type === 'user.message' && d.delivery === 'queued' && !interactionId));
    const result: Projected[] = [];
    if (this.active && boundary) {
      result.push({key: `interaction-end:${event.id}`, event: {type: 'turn_completed', provider, turnId: this.turnId}});
      this.active = false;
    }
    if (interactionId) this.interactionId = interactionId;
    result.push(...this.project(event, delivery));
    return result;
  }
  project(event: SessionEvent, delivery: 'history' | 'live' = 'live'): Projected[] {
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
    const wrap = (value: AgentStreamEvent, key = event.id, identity?: ProviderItemIdentity): Projected[] => [{ key, event: value, ...(identity ? { identity } : {}) }];
    const timeline = (item: Extract<AgentStreamEvent, {type: 'timeline'}>['item'], key: string | undefined, identity: ProviderItemIdentity): Projected[] => wrap({ type: 'timeline', provider, item, turnId }, key, identity);
    const identityOf = (key: string, completes: boolean, liveOnly = false): ProviderItemIdentity => ({ key, ...(completes ? { completes: true as const } : {}), ...(liveOnly ? { liveOnly: true as const } : {}) });
    const message = (messageId: string, itemKey: string, sourceKey: string, body: string, completes: boolean, liveOnly = false): Projected[] => timeline({ type: 'assistant_message', text: body, messageId }, sourceKey, identityOf(itemKey, completes, liveOnly));
    // The native history does not keep the reasoning stream: a reread cannot reproduce it, so the journal keeps its only copy.
    const thought = (reasoningId: string, body: string, completes: boolean): Projected[] => timeline({ type: 'reasoning', text: body }, event.id, identityOf(`reasoning:${reasoningId}`, completes, true));
    switch (event.type) {
      case 'user.message': return timeline({ type: 'user_message', text: event.data.content, messageId: event.id }, event.id, { key: `user:${event.id}`, completes: true });
      case 'assistant.message_delta': {
        const { messageId, deltaContent } = event.data;
        if (this.finalizedMessages.has(messageId) || !deltaContent) return [];
        const streamed = (this.messages.get(messageId) ?? '') + deltaContent;
        this.messages.set(messageId, streamed);
        return message(messageId, `assistant:${messageId}`, `message:${messageId}`, deltaContent, false);
      }
      case 'assistant.message': {
        const {messageId, content} = event.data;
        if (this.finalizedMessages.has(messageId)) return [];
        const streamed = this.messages.get(messageId) ?? '';
        this.finalizedMessages.add(messageId); this.messages.delete(messageId);
        if (!streamed && !content) return [];
        const itemKey = `assistant:${messageId}`;
        // The final message completes the item with the text the stream lacks: nothing when the stream was whole.
        if (content.startsWith(streamed)) return message(messageId, itemKey, `message:${messageId}`, content.slice(streamed.length), true);
        // A corrected final cannot replace an append-only stream; preserve it as a separate message.
        return [
          ...message(messageId, itemKey, `message:${messageId}`, '', true),
          ...(content ? message(`${messageId}:correction`, `${itemKey}:correction`, `message:${messageId}:correction`, content, true) : []),
        ];
      }
      case 'assistant.reasoning_delta': {
        const {reasoningId, deltaContent} = event.data;
        if (this.finalizedReasoning.has(reasoningId) || !deltaContent) return [];
        this.reasoning.set(reasoningId, (this.reasoning.get(reasoningId) ?? '') + deltaContent);
        return thought(reasoningId, deltaContent, false);
      }
      case 'assistant.reasoning': {
        const {reasoningId, content} = event.data;
        if (this.finalizedReasoning.has(reasoningId)) return [];
        const streamed = this.reasoning.get(reasoningId) ?? '';
        this.finalizedReasoning.add(reasoningId); this.reasoning.delete(reasoningId);
        if (!streamed && !content.trim()) return [];
        // The body is what the item still lacks; a content that does not continue what streamed completes the item with nothing, as the final text of a message does.
        return thought(reasoningId, content.startsWith(streamed) ? content.slice(streamed.length) : '', true);
      }
      case 'assistant.turn_start':
        if (this.active) return [];
        this.active = true; return wrap({ type: 'turn_started', provider, turnId });
      case 'assistant.turn_end':
        if (delivery !== 'history' || !this.historicalCompletions.has(event.id)) return [];
        if (!this.active) return [];
        this.active = false; return wrap({ type: 'turn_completed', provider, turnId });
      case 'assistant.idle':
        if (!this.active) return [];
        this.active = false; return wrap({ type: 'turn_completed', provider, turnId });
      case 'abort': {
        this.active = false; this.inputTurnId = undefined;
        // Text that streamed and never got its final message ends here, so no item stays open; reading it again cannot reproduce that ending.
        const finished = [
          ...[...this.messages.keys()].flatMap(messageId => message(messageId, `assistant:${messageId}`, `message:${messageId}`, '', true, true)),
          ...[...this.reasoning.keys()].flatMap(reasoningId => thought(reasoningId, '', true)),
        ];
        this.messages.clear(); this.reasoning.clear();
        return [...finished, ...wrap({ type: 'turn_canceled', provider, reason: 'Native turn aborted', turnId })];
      }
      case 'session.error': this.active = false; this.inputTurnId = undefined;
        return wrap({ type: 'turn_failed', provider, error: event.data.message, turnId, ...(copilotUsageLimited(event) ? { code: 'native_usage_limited' } : {}) });
      case 'tool.execution_start': {
        const tool = { name: event.data.toolName, detail: detail(event.data.toolName, event.data.arguments) };
        this.tools.set(event.data.toolCallId, tool);
        const paths = tool.name === 'apply_patch' ? patchFiles(event.data.arguments).map(file => file.path)
          : 'filePath' in tool.detail ? [tool.detail.filePath] : [];
        this.toolPaths.set(event.data.toolCallId, this.cwd ? paths.flatMap(path => [path, resolve(this.cwd!, path)]) : paths);
        return timeline({ type: 'tool_call', callId: event.data.toolCallId, ...tool, status: 'running', error: null }, `tool:${event.data.toolCallId}`, { key: `tool:${event.data.toolCallId}` });
      }
      case 'tool.execution_partial_result': {
        const {toolCallId, partialOutput} = event.data;
        if (this.completedTools.has(toolCallId) || !partialOutput) return [];
        const tool = this.tools.get(toolCallId); if (!tool) return [];
        const output = ((this.toolOutput.get(toolCallId) ?? '') + partialOutput).slice(0, TOOL_RESULT_MAX_CHARS + 1);
        this.toolOutput.set(toolCallId, output);
        return timeline({type: 'tool_call', callId: toolCallId, ...tool, status: 'running', error: null, result: boundToolResult({content: [{type: 'text', text: output}]})}, `tool:${toolCallId}`, { key: `tool:${toolCallId}` });
      }
      case 'tool.execution_complete': {
        this.completedTools.add(event.data.toolCallId); this.toolOutput.delete(event.data.toolCallId);
        const tool = this.tools.get(event.data.toolCallId) ?? { name: 'Tool', detail: { type: 'other' as const, description: 'Native tool' } };
        const result = copilotToolResult(tool.name, tool.detail, event.data.result, this.toolPaths.get(event.data.toolCallId));
        return timeline({ type: 'tool_call', callId: event.data.toolCallId, ...tool, result, ...(event.data.success ? {status: 'completed' as const, error: null} : {status: 'failed' as const, error: event.data.error?.message ?? 'Native tool failed'}) }, `tool:${event.data.toolCallId}`, { key: `tool:${event.data.toolCallId}`, completes: true });
      }
      case 'session.usage_info': {
        const usage = copilotContextUsage(d);
        return usage ? wrap({type: 'usage_updated', provider, turnId, usage}) : [];
      }
      case 'session.compaction_start': {
        this.pendingCompaction = event.id;
        return timeline({type: 'compaction', status: 'loading'}, event.id, { key: `compaction:${event.id}` });
      }
      case 'session.compaction_complete': {
        const itemKey = `compaction:${this.pendingCompaction ?? event.id}`;
        this.pendingCompaction = undefined;
        if (event.data.success) {
          return timeline({type: 'compaction', status: 'completed', trigger: event.data.trigger === 'manual' ? 'manual' : event.data.trigger ? 'auto' : undefined, preTokens: event.data.preCompactionTokens}, event.id, { key: itemKey, completes: true });
        }
        // The item ends as failed, and the error item beside it tells the cause.
        return [
          ...timeline({type: 'compaction', status: 'failed'}, event.id, { key: itemKey, completes: true }),
          ...timeline({type: 'error', message: `Copilot compaction failed: ${event.data.error ?? 'Unknown native error'}`}, `${event.id}:error`, { key: `error:${event.id}`, completes: true }),
        ];
      }
      default: return [];
    }
  }
}

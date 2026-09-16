import { dshToolResult } from './tool-result.js';
import type {
  AgentInteractionRequest,
  AgentInteractionResponse,
  AgentRuntimeInfo,
  AgentStreamEvent,
  AgentTaskItem,
  AgentToolCallTimelineItem,
  ProviderObservation,
  ProviderResourceReference,
} from '@agent-remote-controller/agent-provider-sdk';

import { readDshContent, type DshImageReference } from './content.js';
import { normalizeGeneratedResourceLocator } from './generated-resource.js';
import {
  dshIdentifier,
  dshProviderSourceKey,
  isRecord,
  nativeEvent,
  nonEmptyString,
  safeNonNegativeInteger,
  type DshNativeObservation,
  type NativeRecord,
} from './native.js';
import { DshSessionState } from './session-state.js';
import { projectDshToolDetails, type DshToolRegistry } from './tools.js';

export { type DshNativeObservation } from './native.js';

const PROVIDER_ID = 'dsh';

export interface DshProjectorOptions {
  sessionId: string;
  tools: DshToolRegistry;
  referenceGeneratedResource?(locator: string, revisionKey: string): string | undefined;
  runtimeInfo?(): AgentRuntimeInfo;
}

interface Projection {
  events: AgentStreamEvent[];
  resourceReferences?: ProviderResourceReference[];
}

export class DshProjector {
  private readonly state = new DshSessionState();
  private readonly sessionId: string;
  private closed = false;
  private compaction: { id: string; turnId: string | undefined; sourceCommandId: string | undefined } | undefined;

  constructor(private readonly options: DshProjectorOptions) {
    this.sessionId = nonEmptyString(options.sessionId) ?? 'unknown-session';
  }

  project(input: DshNativeObservation): ProviderObservation[] {
    if (this.closed) return this.emit(input, [this.error('DSH observation arrived after the session closed.')]);
    if (input.kind !== 'session_event') return this.projectInteraction(input);
    const native = nativeEvent(input);
    if (!native.type || !native.data) return this.emit(input, [this.error('Malformed DSH session event.')]);
    const projection = this.projectSessionEvent(native.type, native.data, dshProviderSourceKey(this.sessionId, input));
    return this.emit(input, projection.events, projection.resourceReferences);
  }

  close(status: 'completed' | 'failed' | 'cancelled', occurredAt = Date.now()): ProviderObservation[] {
    if (this.closed) return [];
    this.closed = true;
    const runtimeStatus = status === 'completed' ? 'closed' : status === 'cancelled' ? 'closed' : 'failed';
    return this.emit({
      recordId: `session-close:${status}`,
      occurredAt,
      kind: 'session_event',
      payload: { type: 'session/close', data: {} },
    }, [{
      type: 'runtime_updated',
      provider: PROVIDER_ID,
      runtimeInfo: { providerId: PROVIDER_ID, sessionId: this.sessionId, status: runtimeStatus },
    }]);
  }

  imageReference(locator: string): DshImageReference | undefined {
    return this.state.images.get(locator);
  }

  private projectSessionEvent(type: string, data: NativeRecord, revisionKey: string): Projection {
    switch (type) {
      case 'turn/start': return this.turnStarted(data);
      case 'turn/end': return this.turnEnded(data);
      case 'user/message': return this.userMessage(data);
      case 'assistant/chunk': return this.assistantChunk(data);
      case 'assistant/message': return this.assistantMessage(data, false);
      case 'assistant/correction': return this.assistantMessage(data, true);
      case 'tool/call': return this.toolCall(data);
      case 'tool/result': return this.toolResult(data, revisionKey);
      case 'todo/write': return this.todo(data);
      case 'plan/mode': return this.planningChanged(data);
      case 'compaction/start': return this.compactionChanged(data, 'loading');
      case 'compaction/end': return this.compactionChanged(data, 'completed');
      case 'compaction/summary':
      case 'compaction/prune':
      case 'command/run': return { events: [] };
      case 'command/done': return this.commandCompleted(data);
      case 'request/header': return this.requestModelChanged(data);
      case 'llm/retry':
      case 'llm/retry-started':
      case 'agent/inbox/spliced':
      case 'step/start':
      case 'step/end':
      case 'tool-call-chunks':
      case 'agent-preset/selected':
      case 'request/context':
      case 'session/end-seed':
      case 'session/title':
      case 'session/title-llm-request':
      case 'approval/asked':
      case 'approval/decided':
        return { events: [] };
      case 'model/selection':
      case 'permission/preset':
      case 'sandbox/mode':
      case 'approval/policy': {
        const runtimeInfo = this.options.runtimeInfo?.();
        return { events: runtimeInfo ? [{ type: 'runtime_updated', provider: PROVIDER_ID, runtimeInfo }] : [] };
      }
      default: return { events: [this.error(`Unsupported DSH event ${type}.`)] };
    }
  }

  private compactionChanged(data: NativeRecord, status: 'loading' | 'completed'): Projection {
    const id = nonEmptyString(data.compactionId);
    const turnId = dshIdentifier(data.turn);
    const sourceCommandId = nonEmptyString(data.sourceCommandId);
    if (!id || (data.turn !== null && !turnId)
      || (data.sourceCommandId !== undefined && !sourceCommandId)
      || (data.error !== undefined && typeof data.error !== 'string')) {
      return { events: [this.error('Malformed DSH compaction event.', turnId)] };
    }
    if (status === 'loading') {
      if (this.compaction) return { events: [this.error(`DSH compaction ${id} started while ${this.compaction.id} is active.`, turnId)] };
      this.compaction = { id, turnId, sourceCommandId };
    } else {
      if (this.compaction?.id !== id || this.compaction.turnId !== turnId || this.compaction.sourceCommandId !== sourceCommandId) {
        return { events: [this.error(`DSH compaction ${id} ended without a matching start.`, turnId)] };
      }
      this.compaction = undefined;
    }
    if (status === 'completed' && data.error !== undefined) {
      return { events: [this.error(`DSH compaction ${id} failed: ${readError(data.error)}`, turnId)] };
    }
    return { events: [this.timeline({ type: 'compaction', status, ...(sourceCommandId ? { trigger: 'manual' as const } : {}) }, turnId)] };
  }

  private requestModelChanged(data: NativeRecord): Projection {
    const header = isRecord(data.header) ? data.header : undefined;
    const config = isRecord(header?.config) ? header.config : undefined;
    const model = nonEmptyString(config?.model);
    if (!model) return { events: [] };
    const runtime = this.options.runtimeInfo?.() ?? {
      providerId: PROVIDER_ID, sessionId: this.sessionId, status: 'idle' as const,
    };
    return { events: [{
      type: 'runtime_updated', provider: PROVIDER_ID,
      runtimeInfo: { ...runtime, model },
    }] };
  }

  private planningChanged(data: NativeRecord): Projection {
    if (typeof data.active !== 'boolean') return { events: [this.error('Malformed DSH plan/mode event.')] };
    const runtime = this.options.runtimeInfo?.() ?? {
      providerId: PROVIDER_ID, sessionId: this.sessionId, status: 'idle' as const,
    };
    const requested = runtime.planning?.requested;
    return { events: [{
      type: 'runtime_updated', provider: PROVIDER_ID,
      runtimeInfo: {
        ...runtime,
        planning: { active: data.active, ...(requested !== undefined && requested !== data.active ? { requested } : {}) },
      },
    }] };
  }

  private commandCompleted(data: NativeRecord): Projection {
    if (data.kind === 'success') return { events: [] };
    if (data.kind === 'error') {
      const message = nonEmptyString(data.text) ?? 'The command failed without an error message.';
      return { events: [this.error(`DSH command failed: ${message}`)] };
    }
    return { events: [this.error('Malformed DSH command/done event.')] };
  }

  private turnStarted(data: NativeRecord): Projection {
    const turnId = dshIdentifier(data.turn);
    if (!turnId) return { events: [this.error('Malformed DSH turn/start event.')] };
    return { events: [{ type: 'turn_started', provider: PROVIDER_ID, turnId }] };
  }

  private turnEnded(data: NativeRecord): Projection {
    const turnId = dshIdentifier(data.turn);
    if (!turnId) return { events: [this.error('Malformed DSH turn/end event.')] };
    const reason = isRecord(data.reason) ? nonEmptyString(data.reason.kind) : nonEmptyString(data.reason);
    const base = { provider: PROVIDER_ID, turnId } as const;
    let event: AgentStreamEvent;
    if (reason === 'completed') event = { type: 'turn_completed', ...base };
    else if (reason === 'aborted' || reason === 'cancelled' || reason === 'interrupted') {
      event = { type: 'turn_canceled', ...base, reason };
    } else if (reason === 'error' || reason === 'failed') {
      const nested = isRecord(data.reason) ? data.reason.error : undefined;
      event = { type: 'turn_failed', ...base, error: readError(nested) };
    } else {
      event = { type: 'turn_failed', ...base, error: `Unsupported DSH turn end reason ${reason ?? 'without a kind'}.` };
    }
    return { events: [event] };
  }

  private userMessage(data: NativeRecord): Projection {
    const messageId = dshIdentifier(data.id);
    const turnId = dshIdentifier(data.turn);
    const source = isRecord(data.source) ? data.source : undefined;
    const sourceKind = nonEmptyString(source?.kind);
    if (sourceKind === 'tool' || sourceKind === 'plugin' || sourceKind === 'skill-catalog' || sourceKind === 'agent-instructions') return { events: [] };
    if (sourceKind !== 'user') {
      return {
        events: [this.error(`Unsupported DSH user/message source ${sourceKind ?? 'without a kind'}.`, turnId)],
      };
    }
    if (!messageId) return { events: [this.error('Malformed DSH user/message event.')] };
    const read = readDshContent(data.content);
    this.rememberImages(read.images);
    const events: AgentStreamEvent[] = [];
    if (read.text) events.push(this.timeline({ type: 'user_message', messageId, text: read.text }, turnId));
    events.push(...read.diagnostics.map((message) => this.error(message, turnId)));
    return { events };
  }

  private assistantChunk(data: NativeRecord): Projection {
    const turnId = dshIdentifier(data.turn);
    const stepId = dshIdentifier(data.step);
    const chunk = isRecord(data.chunk) ? data.chunk : undefined;
    const chunkType = nonEmptyString(chunk?.type);
    if (!turnId || !stepId || !chunk || !chunkType) {
      return { events: [this.error('Malformed DSH assistant/chunk event.', turnId)] };
    }
    if (chunkType === 'usage') return this.usage(chunk.usage, turnId);
    if (chunkType === 'finish' || chunkType === 'block-start' || chunkType === 'tool-call-delta') {
      return { events: [] };
    }
    if (chunkType === 'block-end') return this.assistantBlockEnd(chunk.block, turnId, stepId);
    if (chunkType !== 'text-delta' && chunkType !== 'reasoning-delta') {
      return {
        events: [this.error(`Unsupported DSH assistant chunk ${chunkType}.`, turnId)],
      };
    }
    if (typeof chunk.text !== 'string') {
      return { events: [this.error('Malformed DSH assistant text delta.', turnId)] };
    }
    if (!chunk.text) return { events: [] };
    const key = `${turnId}:${stepId}`;
    const current = this.state.assistants.get(key) ?? { text: '', reasoning: '' };
    if (chunkType === 'reasoning-delta') current.reasoning += chunk.text;
    else current.text += chunk.text;
    this.state.assistants.set(key, current);
    const item = chunkType === 'reasoning-delta'
      ? { type: 'reasoning' as const, text: chunk.text }
      : { type: 'assistant_message' as const, messageId: `assistant:${key}`, text: chunk.text };
    return { events: [this.timeline(item, turnId)] };
  }

  private assistantBlockEnd(block: unknown, turnId: string, stepId: string): Projection {
    if (isRecord(block) && block.type === 'tool-call') return { events: [] };
    const read = readDshContent([block]);
    this.rememberImages(read.images);
    const key = `${turnId}:${stepId}`;
    const current = this.state.assistants.get(key) ?? { text: '', reasoning: '' };
    const events: AgentStreamEvent[] = [];
    for (const reasoning of read.reasoning) {
      if (reasoning !== current.reasoning) events.push(this.error('DSH reasoning block changed after streaming.', turnId));
    }
    if (read.text && read.text !== current.text) {
      const suffix = read.text.startsWith(current.text) ? read.text.slice(current.text.length) : read.text;
      if (!read.text.startsWith(current.text) && current.text) {
        events.push(this.error('DSH assistant block changed after streaming; the final block is shown again.', turnId));
      }
      if (suffix) events.push(this.timeline({ type: 'assistant_message', messageId: `assistant:${key}`, text: suffix }, turnId));
      current.text = read.text;
      this.state.assistants.set(key, current);
    }
    events.push(...read.diagnostics.map((message) => this.error(message, turnId)));
    return { events };
  }

  private assistantMessage(data: NativeRecord, correction: boolean): Projection {
    const turnId = dshIdentifier(data.turn);
    const stepId = dshIdentifier(data.step);
    if (!turnId || !stepId) {
      return { events: [this.error('Malformed DSH assistant message.')] };
    }
    const message = isRecord(data.message) ? data.message : data;
    const read = readDshContent(message.content);
    this.rememberImages(read.images);
    const key = `${turnId}:${stepId}`;
    const current = this.state.assistants.get(key) ?? { text: '', reasoning: '' };
    const events: AgentStreamEvent[] = [];
    if (correction) {
      const revision = safeNonNegativeInteger(data.revision) ?? 1;
      events.push(this.error('DSH corrected assistant output; the correction is shown as a new message.', turnId));
      if (read.text) {
        events.push(this.timeline({
          type: 'assistant_message', messageId: `assistant:${key}:correction:${revision}`, text: read.text,
        }, turnId));
      }
    } else {
      for (const reasoning of read.reasoning) {
        const suffix = reasoning.startsWith(current.reasoning) ? reasoning.slice(current.reasoning.length) : reasoning;
        if (suffix) events.push(this.timeline({ type: 'reasoning', text: suffix }, turnId));
      }
      if (read.text !== current.text) {
        const suffix = read.text.startsWith(current.text) ? read.text.slice(current.text.length) : read.text;
        if (!read.text.startsWith(current.text) && current.text) {
          events.push(this.error('DSH assistant output changed after streaming; the final message is shown again.', turnId));
        }
        if (suffix) events.push(this.timeline({ type: 'assistant_message', messageId: `assistant:${key}`, text: suffix }, turnId));
      }
      this.state.assistants.set(key, { text: read.text, reasoning: read.reasoning.join('') });
    }
    events.push(...read.diagnostics.map((message) => this.error(message, turnId)));
    const usage = data.usage ?? message.usage;
    if (usage !== undefined) events.push(...this.usage(usage, turnId).events);
    return { events };
  }

  private usage(input: unknown, turnId: string): Projection {
    if (!isRecord(input)) return { events: [this.error('Malformed DSH usage record.', turnId)] };
    const inputTokens = safeNonNegativeInteger(input.inputTokens);
    const outputTokens = safeNonNegativeInteger(input.outputTokens);
    const cachedInputTokens = safeNonNegativeInteger(input.cacheReadTokens);
    const usage = {
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    };
    if (Object.keys(usage).length === 0) return { events: [this.error('Unsupported DSH usage record.', turnId)] };
    return { events: [{ type: 'usage_updated', provider: PROVIDER_ID, turnId, usage }] };
  }

  private toolCall(data: NativeRecord): Projection {
    const callId = nonEmptyString(data.callId);
    const name = nonEmptyString(data.name);
    const turnId = dshIdentifier(data.turn);
    if (!callId || !name) return { events: [this.error('Malformed DSH tool/call event.', turnId)] };
    const parsed = parseJson(data.arguments);
    const item: AgentToolCallTimelineItem = {
      type: 'tool_call',
      callId,
      name,
      detail: projectDshToolDetails(name, parsed.value),
      status: 'running',
      error: null,
    };
    this.state.tools.set(callId, item);
    if (name === 'write' && isRecord(parsed.value)) {
      const locator = normalizeGeneratedResourceLocator(item.detail.type === 'write' ? item.detail.filePath : '');
      if (locator && typeof parsed.value.content === 'string') {
        this.state.pendingWrites.set(callId, { locator });
      }
    }
    const events = [this.timeline(item, turnId)];
    if (parsed.error) events.push(this.error(parsed.error, turnId));
    return { events };
  }

  private toolResult(data: NativeRecord, revisionKey: string): Projection {
    const message = isRecord(data.message) ? data.message : undefined;
    const source = isRecord(message?.source) ? message.source : undefined;
    const callId = nonEmptyString(data.callId) ?? nonEmptyString(source?.callId);
    const turnId = dshIdentifier(data.turn);
    if (!callId) return { events: [this.error('Malformed DSH tool/result event.', turnId)] };
    const opened = this.state.tools.get(callId);
    if (!opened) {
      return {
        events: [this.error(`DSH tool result ${callId} has no matching tool call.`, turnId)],
      };
    }
    const first = Array.isArray(message?.content) && isRecord(message.content[0]) ? message.content[0] : undefined;
    const failed = first?.isError === true || data.isError === true || data.error !== undefined;
    const pendingWrite = this.state.pendingWrites.get(callId);
    this.state.pendingWrites.delete(callId);
    const result = dshToolResult(data);
    const completed = { ...opened, ...(result ? { result } : {}) };
    const item: AgentToolCallTimelineItem = failed
      ? { ...completed, status: 'failed', error: readError(data.error) }
      : { ...completed, status: 'completed', error: null };
    this.state.tools.set(callId, item);
    const readLocator = !failed && pendingWrite
      ? this.options.referenceGeneratedResource?.(pendingWrite.locator, revisionKey)
      : undefined;
    return {
      events: [this.timeline(item, turnId)],
      ...(readLocator && pendingWrite
        ? { resourceReferences: [{ locator: pendingWrite.locator, readLocator }] }
        : {}),
    };
  }

  private todo(data: NativeRecord): Projection {
    const turnId = dshIdentifier(data.turn);
    const values = Array.isArray(data.todos) ? data.todos : Array.isArray(data.items) ? data.items : undefined;
    if (!values) return { events: [this.error('Malformed DSH todo/write event.', turnId)] };
    const items: AgentTaskItem[] = [];
    const diagnostics: AgentStreamEvent[] = [];
    for (const value of values) {
      if (!isRecord(value)) {
        diagnostics.push(this.error('Malformed DSH todo item.', turnId));
        continue;
      }
      const text = nonEmptyString(value.content) ?? nonEmptyString(value.label);
      const nativeStatus = nonEmptyString(value.status);
      if (!text || !nativeStatus) {
        diagnostics.push(this.error('Malformed DSH todo item.', turnId));
        continue;
      }
      const status = nativeStatus === 'in_progress'
        ? 'in_progress'
        : nativeStatus === 'completed' ? 'completed' : 'pending';
      if (nativeStatus === 'cancelled') diagnostics.push(this.error(`DSH todo item "${text}" was cancelled.`, turnId));
      const id = dshIdentifier(value.id);
      const activeForm = nonEmptyString(value.activeForm);
      items.push({
        text,
        completed: status === 'completed',
        status,
        ...(id ? { id } : {}),
        ...(activeForm ? { activeForm } : {}),
      });
    }
    return { events: [this.timeline({ type: 'todo', items }, turnId), ...diagnostics] };
  }

  private projectInteraction(input: DshNativeObservation): ProviderObservation[] {
    if (!isRecord(input.payload)) return this.emit(input, [this.error(`Malformed DSH ${input.kind} observation.`)]);
    if (input.kind === 'interaction_requested' && isInteractionRequest(input.payload.request)) {
      const request = input.payload.request;
      const turnId = dshIdentifier(input.payload.turnId);
      return this.emit(input, [{ type: 'interaction_requested', provider: PROVIDER_ID, request, ...(turnId ? { turnId } : {}) }]);
    }
    const requestId = nonEmptyString(input.payload.requestId);
    if (input.kind === 'interaction_resolved' && requestId && isInteractionResponse(input.payload.response)) {
      const turnId = dshIdentifier(input.payload.turnId);
      return this.emit(input, [{
        type: 'interaction_resolved', provider: PROVIDER_ID,
        requestId, response: input.payload.response,
        ...(turnId ? { turnId } : {}),
      }]);
    }
    return this.emit(input, [this.error(`Unsupported DSH observation ${input.kind}.`)]);
  }

  private timeline(item: Extract<AgentStreamEvent, { type: 'timeline' }>['item'], turnId?: string): AgentStreamEvent {
    return { type: 'timeline', provider: PROVIDER_ID, item, ...(turnId ? { turnId } : {}) };
  }

  private error(message: string, turnId?: string): AgentStreamEvent {
    return this.timeline({ type: 'error', message }, turnId);
  }

  private rememberImages(images: DshContentReadImages): void {
    for (const image of images) this.state.images.set(image.locator, image.reference);
  }

  private emit(
    input: DshNativeObservation,
    events: AgentStreamEvent[],
    resourceReferences?: ProviderResourceReference[],
  ): ProviderObservation[] {
    const occurredAt = safeNonNegativeInteger(input.occurredAt) ?? 0;
    const source = dshProviderSourceKey(this.sessionId, input);
    const nativeRevision = input.kind === 'session_event' && isRecord(input.payload)
      ? safeNonNegativeInteger(input.payload.seq)
      : undefined;
    return events.map((event, index) => ({
      type: 'observation',
      sourceKey: index === 0 ? source : `${source}:event:${index + 1}`,
      occurredAt,
      delivery: 'live',
      event,
      ...(nativeRevision === undefined ? {} : { nativeRevision }),
      ...(index === 0 && resourceReferences ? { resourceReferences } : {}),
    }));
  }
}

type DshContentReadImages = ReturnType<typeof readDshContent>['images'];

function parseJson(input: unknown): { value: unknown; error?: string } {
  if (typeof input !== 'string') return { value: null, error: 'DSH tool arguments are not a JSON string.' };
  try {
    return { value: JSON.parse(input) };
  } catch {
    return { value: null, error: 'DSH tool arguments are not valid JSON.' };
  }
}

function readError(value: unknown): string {
  if (isRecord(value)) return nonEmptyString(value.message) ?? nonEmptyString(value.name) ?? 'DSH operation failed.';
  return nonEmptyString(value) ?? 'DSH operation failed.';
}

function isInteractionRequest(value: unknown): value is AgentInteractionRequest {
  if (!isRecord(value) || !nonEmptyString(value.requestId)) return false;
  if (value.kind === 'question') {
    return hasOnlyKeys(value, ['kind', 'requestId', 'questions'])
      && isDenseArray(value.questions)
      && value.questions.length > 0
      && value.questions.every(isQuestion);
  }
  if (value.kind === 'plan_approval') {
    return hasOnlyKeys(value, ['kind', 'requestId', 'plan', 'allowedActions'])
      && typeof value.plan === 'string'
      && isUniqueEnumArray(value.allowedActions, ['approve', 'approve_and_resume', 'reject'], 1);
  }
  if (value.kind === 'tool_approval') {
    return hasOnlyKeys(value, [
      'kind', 'requestId', 'toolCallId', 'toolName', 'summary', 'detail', 'allowedDecisions', 'allowScopes',
    ])
      && Boolean(nonEmptyString(value.toolCallId))
      && Boolean(nonEmptyString(value.toolName))
      && typeof value.summary === 'string'
      && isToolDetail(value.detail)
      && isUniqueEnumArray(value.allowedDecisions, ['allow', 'deny'], 1)
      && isUniqueEnumArray(value.allowScopes, ['once', 'session']);
  }
  return false;
}

function isInteractionResponse(value: unknown): value is AgentInteractionResponse {
  if (!isRecord(value)) return false;
  if (value.kind === 'question') {
    return hasOnlyKeys(value, ['kind', 'answers', 'dismissed'])
      && isDenseArray(value.answers)
      && value.answers.every(isQuestionAnswer)
      && optionalBoolean(value, 'dismissed');
  }
  if (value.kind === 'plan_approval') {
    return hasOnlyKeys(value, ['kind', 'action', 'feedback'])
      && isEnum(value.action, ['approve', 'approve_and_resume', 'reject'])
      && optionalString(value, 'feedback')
      && (value.feedback === undefined || value.action === 'reject');
  }
  if (value.kind !== 'tool_approval') return false;
  if (value.decision === 'allow') {
    return hasOnlyKeys(value, ['kind', 'decision', 'scope']) && isEnum(value.scope, ['once', 'session']);
  }
  if (value.decision === 'deny') {
    return hasOnlyKeys(value, ['kind', 'decision', 'message']) && optionalString(value, 'message');
  }
  return false;
}

function isQuestion(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, [
      'questionId', 'header', 'prompt', 'description', 'required', 'selection', 'options',
      'allowCustomText', 'allowDismiss',
    ])
    && Boolean(nonEmptyString(value.questionId))
    && Boolean(nonEmptyString(value.header))
    && Boolean(nonEmptyString(value.prompt))
    && optionalString(value, 'description')
    && typeof value.required === 'boolean'
    && isEnum(value.selection, ['single', 'multiple'])
    && isDenseArray(value.options)
    && value.options.every(isQuestionOption)
    && typeof value.allowCustomText === 'boolean'
    && typeof value.allowDismiss === 'boolean';
}

function isQuestionOption(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ['value', 'label', 'description'])
    && Boolean(nonEmptyString(value.value))
    && Boolean(nonEmptyString(value.label))
    && optionalString(value, 'description');
}

function isQuestionAnswer(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ['questionId', 'selectedValues', 'customText'])
    && Boolean(nonEmptyString(value.questionId))
    && isUniqueNonEmptyStringArray(value.selectedValues)
    && optionalString(value, 'customText');
}

function isToolDetail(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'shell':
      return hasOnlyKeys(value, ['type', 'command', 'cwd'])
        && Boolean(nonEmptyString(value.command))
        && (!Object.hasOwn(value, 'cwd') || Boolean(nonEmptyString(value.cwd)));
    case 'read':
    case 'edit':
    case 'write':
      return hasOnlyKeys(value, ['type', 'filePath']) && Boolean(nonEmptyString(value.filePath));
    case 'search':
      return hasOnlyKeys(value, ['type', 'query']) && Boolean(nonEmptyString(value.query));
    case 'fetch':
      return hasOnlyKeys(value, ['type', 'url']) && Boolean(nonEmptyString(value.url));
    case 'other':
      return hasOnlyKeys(value, ['type', 'description']) && Boolean(nonEmptyString(value.description));
    default:
      return false;
  }
}

function hasOnlyKeys(value: NativeRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function optionalString(value: NativeRecord, key: string): boolean {
  return !Object.hasOwn(value, key) || typeof value[key] === 'string';
}

function optionalBoolean(value: NativeRecord, key: string): boolean {
  return !Object.hasOwn(value, key) || typeof value[key] === 'boolean';
}

function isEnum(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === 'string' && allowed.includes(value);
}

function isUniqueEnumArray(value: unknown, allowed: readonly string[], minItems = 0): boolean {
  return isDenseArray(value)
    && value.length >= minItems
    && new Set(value).size === value.length
    && value.every((item) => isEnum(item, allowed));
}

function isUniqueNonEmptyStringArray(value: unknown): boolean {
  return isDenseArray(value)
    && new Set(value).size === value.length
    && value.every((item) => Boolean(nonEmptyString(item)));
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

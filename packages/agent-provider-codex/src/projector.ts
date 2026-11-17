import { projectResourceInputText } from '@orchardworks/agent-provider-sdk';
import { createHash, randomUUID } from 'node:crypto';

import { codexToolResult } from './tool-result.js';
import { CodexImageRegistry } from './images.js';
import { codexImagePlaceholderLabel } from './message-content.js';
import { codexUsage } from './usage.js';
import type {
  AgentStreamEvent,
  AgentUserMessagePart,
  ProviderResourceReference,
  AgentTaskItem,
  AgentTimelineItem,
  AgentToolCallTimelineItem,
  ProviderItemIdentity,
  ProviderObservation,
} from '@orchardworks/agent-provider-sdk';

import {
  isRecord,
  normalizeStatus,
  readErrorMessage,
  readItem,
  readItemId,
  readNumber,
  readString,
  readThreadId,
  readTurnId,
  stringifyJson,
  type JsonObject,
} from './native.js';

const PROVIDER_ID = 'codex';
const MAX_UNSUPPORTED_MESSAGE_LENGTH = 640;
const NON_TIMELINE_NOTIFICATION_METHODS = new Set([
  'account/rateLimits/updated',
  'rawResponseItem/completed',
  'rawResponse/completed',
  'thread/goal/cleared',
  'thread/goal/updated',
  'thread/queue/changed',
  'skills/changed',
  'item/mcpToolCall/progress',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/patchUpdated',
  'item/reasoning/textDelta',
  'remoteControl/status/changed',
  'serverRequest/resolved',
  'thread/settings/updated',
  'thread/name/updated',
  'thread/status/changed',
  'turn/diff/updated',
  'warning',
  // The thread's read position moves after every turn.
  'thread/readState/changed',
  // Superseded by the `contextCompaction` item, which carries the compaction and its end.
  'thread/compacted',
]);

const TURN_END = new Set(['turn_completed', 'turn_failed', 'turn_canceled']);

export interface CodexEventProjectorOptions {
  now?: () => number;
  delivery?: 'history' | 'live';
  images?: CodexImageRegistry;
  cwd?: string;
  /** Receives one JSON line for a native notice that is not part of the conversation, such as a failing MCP server at start-up. */
  diagnostic?: (line: string) => void;
}

export class CodexEventProjector {
  private readonly assistantText = new Map<string, string>();
  private readonly reasoningText = new Map<string, string>();
  private readonly completedTextItems = new Set<string>();
  private readonly emittedUserItems = new Set<string>();
  private readonly loadingCompactions = new Set<string>();
  /** Observations a notification adds after its own, taken by the call that read it. */
  private readonly trailing: ProviderObservation[] = [];
  private readonly now: () => number;
  private readonly delivery: 'history' | 'live';
  private readonly images: CodexImageRegistry;
  private readonly cwd: string | undefined;
  private readonly diagnostic: ((line: string) => void) | undefined;

  constructor(
    private readonly threadId: string,
    options: CodexEventProjectorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.delivery = options.delivery ?? 'live';
    this.images = options.images ?? new CodexImageRegistry(threadId);
    this.cwd = options.cwd;
    this.diagnostic = options.diagnostic;
  }

  snapshotText(): ReadonlyMap<string, string> {
    return new Map([...this.assistantText, ...this.reasoningText]);
  }

  seedHistoryItem(item: unknown): void {
    if (!isRecord(item)) return;
    const itemId = readString(item.id);
    if (!itemId) return;
    if (item.type === 'agentMessage' || item.type === 'plan') {
      this.assistantText.set(itemId, readString(item.text) ?? '');
    } else if (item.type === 'reasoning') {
      this.reasoningText.set(itemId, this.readReasoningText(item));
    }
  }

  /** The history read says these items are complete; only items still streaming keep their text. */
  forgetCompleted(historyItems: ReadonlyMap<string, unknown>): void {
    for (const [id, item] of historyItems) {
      if (isRecord(item) && item.completedAtMs !== null && item.completedAtMs !== undefined) { this.assistantText.delete(id); this.reasoningText.delete(id); }
    }
  }

  /** What one native notification adds to the timeline: at a turn's end, first the completion of every item that streamed and never finished. */
  projectNotifications(method: string, params: unknown): ProviderObservation[] {
    const observation = this.projectOne(method, params);
    const trailing = this.trailing.splice(0);
    if (!observation) return [];
    const finished = TURN_END.has(observation.event.type) ? this.finishOpenItems(observation.event, observation.occurredAt) : [];
    return [...finished, observation, ...trailing];
  }

  /** The observation the notification is about, without the completions and corrections that come with it. */
  projectNotification(method: string, params: unknown): ProviderObservation | null {
    const observation = this.projectOne(method, params);
    this.trailing.length = 0;
    return observation;
  }

  /**
   * The turn ended with these items open: a text or reasoning that never received its final message ends with an empty body,
   * and a compaction that never ended is failed. Native history keeps none of them, so the next replacement may drop them.
   */
  private finishOpenItems(end: AgentStreamEvent, occurredAt: number): ProviderObservation[] {
    const turnId = 'turnId' in end ? end.turnId : undefined;
    const finished: ProviderObservation[] = [];
    for (const id of this.assistantText.keys()) {
      finished.push(this.observation(`item:${id}:abandoned`, { type: 'timeline', provider: PROVIDER_ID, turnId, item: { type: 'assistant_message', messageId: id, text: '' } }, occurredAt, identity(`assistant:${id}`, true)));
    }
    for (const id of this.reasoningText.keys()) {
      finished.push(this.observation(`item:${id}:abandoned`, { type: 'timeline', provider: PROVIDER_ID, turnId, item: { type: 'reasoning', text: '' } }, occurredAt, identity(`reasoning:${id}`, true)));
    }
    for (const id of this.loadingCompactions) {
      finished.push(this.observation(`item:${id}:abandoned`, { type: 'timeline', provider: PROVIDER_ID, turnId, item: { type: 'compaction', status: 'failed' } }, occurredAt, identity(`compaction:${id}`, true)));
    }
    this.assistantText.clear(); this.reasoningText.clear(); this.loadingCompactions.clear();
    return finished;
  }

  private projectOne(method: string, params: unknown): ProviderObservation | null {
    if (method.startsWith('codex/event/')) return null;
    if (NON_TIMELINE_NOTIFICATION_METHODS.has(method)) return null;
    if (method === 'thread/started') {
      if (!isRecord(params) || !isRecord(params.thread) || !readString(params.thread.id)) {
        return this.invalidNotification(method, params);
      }
      const startedThreadId = readString(params.thread.id);
      if (startedThreadId !== this.threadId) return null;
      return this.observation(`thread:${this.threadId}:started`, {
        type: 'thread_started', provider: PROVIDER_ID, sessionId: this.threadId,
      });
    }
    const nativeThreadId = readThreadId(params);
    if (nativeThreadId && nativeThreadId !== this.threadId) return null;
    const turnId = readTurnId(params);

    if (method === 'mcpServer/startupStatus/updated' || method === 'hook/started' || method === 'hook/completed') {
      if (!isRecord(params)) return this.invalidNotification(method, params, turnId);
      const status = method === 'mcpServer/startupStatus/updated' ? params.status : isRecord(params.run) ? params.run.status : undefined;
      if (typeof status !== 'string') return this.invalidNotification(method, params, turnId);
      // The native runtime announces its start-up again for every thread it loads and history never holds it, so it is not conversation.
      if (status === 'failed') {
        const name = readString(params.name) ?? (isRecord(params.run) ? readString(params.run.eventName) : undefined) ?? method;
        const detail = readErrorMessage(params.error) ?? readString(params.failureReason) ?? (isRecord(params.run) ? readString(params.run.statusMessage) : undefined);
        this.diagnostic?.(JSON.stringify({ event: 'codex_startup_notice', method, name, status, ...(detail ? { message: detail.slice(0, 200) } : {}) }));
      }
      return null;
    }
    if (method === 'item/reasoning/summaryPartAdded') {
      // History joins the summary parts with a blank line; the stream marks where each part after the first begins.
      const index = isRecord(params) ? readNumber(params.summaryIndex) : undefined;
      return index !== undefined && index > 0 ? this.projectTextDelta('item/reasoning/summaryTextDelta', { ...(params as JsonObject), delta: '\n\n' }, turnId) : null;
    }

    if (
      method === 'item/agentMessage/delta'
      || method === 'item/reasoning/summaryTextDelta'
      || method === 'item/plan/delta'
    ) {
      return this.projectTextDelta(method, params, turnId)
        ?? this.invalidNotification(method, params, turnId);
    }
    if (method === 'item/started' || method === 'item/completed') {
      if (!readItem(params) || !readItemId(params)) return this.invalidNotification(method, params, turnId);
      return this.projectItemLifecycle(method, params, turnId);
    }
    if (method === 'turn/started') {
      const id = turnId;
      const nativeStart = isRecord(params) && isRecord(params.turn) ? readNumber(params.turn.startedAt) : undefined;
      const startedAt = nativeStart !== undefined && nativeStart >= 0 && nativeStart <= 8_640_000_000_000
        ? nativeStart * 1_000 : undefined;
      return id ? this.observation(`turn:${id}:started`, {
        type: 'turn_started', provider: PROVIDER_ID, turnId: id,
      }, startedAt) : this.invalidNotification(method, params, turnId);
    }
    if (method === 'turn/completed') {
      return this.projectTurnCompleted(params, turnId)
        ?? this.invalidNotification(method, params, turnId);
    }
    if (method === 'turn/plan/updated') {
      return this.projectPlan(params, turnId)
        ?? this.invalidNotification(method, params, turnId);
    }
    if (method === 'thread/tokenUsage/updated') {
      return this.projectUsage(params, turnId)
        ?? this.invalidNotification(method, params, turnId);
    }
    if (method === 'error' && isRecord(params)) {
      const message = readErrorMessage(params.error) ?? readString(params.message);
      if (!message) return this.invalidNotification(method, params, turnId);
      if (turnId && params.willRetry === false) return this.projectTurnFailure(message, turnId);
      return this.errorItem(`error:${turnId ?? this.threadId}:${message}`, message, turnId);
    }
    return this.errorItem(`unsupported:notification:${method}:${nativeFingerprint(params)}`, unsupportedMessage(`Unsupported Codex notification ${method}`, params), turnId);
  }

  projectHistoryItem(item: unknown, turnId?: string, occurredAt?: number): ProviderObservation | null {
    if (!isRecord(item)) return null;
    const id = readString(item.id);
    if (id && (item.type === 'imageView' || item.type === 'imageGeneration')) {
      return this.projectImage(item, id, turnId, occurredAt);
    }
    if (id && item.type === 'userMessage') return this.projectUserMessage(item, id, `item:${id}:completed`, turnId, occurredAt);
    const timelineItem = this.mapItem(item, 'completed');
    if (!timelineItem || !id) return null;
    return this.observation(`item:${id}:completed`, {
      type: 'timeline', provider: PROVIDER_ID, turnId, item: timelineItem,
    }, occurredAt, this.itemIdentity(item, id, 'completed', timelineItem));
  }

  private projectTextDelta(
    method: string,
    params: unknown,
    turnId: string | undefined,
  ): ProviderObservation | null {
    if (!isRecord(params)) return null;
    const itemId = readString(params.itemId);
    const delta = readString(params.delta);
    if (!itemId || delta === undefined) return null;
    const reasoning = method === 'item/reasoning/summaryTextDelta';
    const values = reasoning ? this.reasoningText : this.assistantText;
    // Native deltas have no occurrence ID or offset; equal payloads still append.
    // A fresh identity also avoids collisions when a history refresh rebuilds the projector.
    const sourceKey = `item:${itemId}:${reasoning ? 'reasoning' : 'assistant'}:delta:${randomUUID()}`;
    const prior = values.get(itemId) ?? '';
    values.set(itemId, prior + delta);
    const item: AgentTimelineItem = reasoning
      ? { type: 'reasoning', text: delta }
      : { type: 'assistant_message', messageId: itemId, text: delta };
    return this.observation(sourceKey, {
      type: 'timeline', provider: PROVIDER_ID, turnId, item,
    }, undefined, identity(`${reasoning ? 'reasoning' : 'assistant'}:${itemId}`));
  }

  private projectItemLifecycle(
    method: 'item/started' | 'item/completed',
    params: unknown,
    turnId: string | undefined,
  ): ProviderObservation | null {
    const item = readItem(params);
    const itemId = readItemId(params);
    if (!item || !itemId) return null;
    const lifecycle = method === 'item/started' ? 'started' : 'completed';
    const itemType = readString(item.type);
    if (itemType === 'imageView' || itemType === 'imageGeneration') {
      return lifecycle === 'completed' ? this.projectImage(item, itemId, turnId) : null;
    }
    if (itemType === 'agentMessage' || itemType === 'reasoning' || itemType === 'plan') {
      if (lifecycle === 'started') return null;
      return this.projectCompletedTextItem(item, itemId, turnId);
    }
    if (itemType === 'agentCommunication' && lifecycle === 'started') return null;
    if (itemType === 'userMessage') {
      if (this.emittedUserItems.has(itemId)) return null;
      const projected = this.projectUserMessage(item, itemId, `item:${itemId}:user`, turnId);
      if (projected) this.emittedUserItems.add(itemId);
      return projected;
    }
    const mapped = this.mapItem(item, lifecycle);
    if (!mapped) return null;
    // An item type this adapter does not know is reported once, when it completes, as history reports it.
    if (mapped.type === 'error' && lifecycle === 'started') return null;
    if (itemType === 'contextCompaction') {
      if (lifecycle === 'started') this.loadingCompactions.add(itemId); else this.loadingCompactions.delete(itemId);
    }
    return this.observation(`item:${itemId}:${lifecycle}`, {
      type: 'timeline', provider: PROVIDER_ID, turnId, item: mapped,
    }, undefined, this.itemIdentity(item, itemId, lifecycle, mapped));
  }

  /** The key of the item a native item becomes, and whether this observation finishes it. The same in a notification and in history. */
  private itemIdentity(item: JsonObject, id: string, lifecycle: 'started' | 'completed', mapped: AgentTimelineItem): ProviderItemIdentity {
    switch (mapped.type) {
      case 'tool_call': return identity(`tool:${id}`, mapped.status !== 'running');
      case 'agent_communication': return identity(`comm:${id}`, true);
      case 'compaction': return identity(`compaction:${id}`, lifecycle === 'completed');
      case 'error': return identity(`error:unsupported-item:${id}`, true);
      case 'reasoning': return identity(`reasoning:${id}`, true);
      case 'assistant_message': return identity(`assistant:${id}`, true);
      default: throw new Error(`Codex item ${readString(item.type)} has no timeline identity`);
    }
  }

  private projectImage(item: JsonObject, itemId: string, turnId?: string, occurredAt?: number): ProviderObservation | null {
    const projected = this.images.project(item, this.cwd);
    if (!projected) return null;
    return {
      ...this.observation(`item:${itemId}:completed`, {
        type: 'timeline', provider: PROVIDER_ID, turnId, item: projected.item,
      }, occurredAt, identity(`image:${itemId}`, true)),
      resourceReferences: projected.resourceReferences,
    };
  }

  private projectCompletedTextItem(
    item: JsonObject,
    itemId: string,
    turnId: string | undefined,
  ): ProviderObservation | null {
    const completionKey = JSON.stringify([turnId, itemId, item.type]);
    if (this.completedTextItems.has(completionKey)) return null;
    // Completion is terminal even when it emits no text or emits a correction.
    this.completedTextItems.add(completionKey);
    const reasoning = item.type === 'reasoning';
    const finalText = reasoning
      ? this.readReasoningText(item)
      : readString(item.text) ?? '';
    const streamedText = reasoning ? this.reasoningText : this.assistantText;
    const streamed = streamedText.get(itemId);
    const key = `${reasoning ? 'reasoning' : 'assistant'}:${itemId}`;
    const timelineOf = (text: string, messageId = itemId): AgentTimelineItem => reasoning
      ? { type: 'reasoning', text }
      : { type: 'assistant_message', messageId, text };
    // What finishes a streamed item differs from the history row of the same item, which a reread would otherwise drop as already known.
    const complete = (text: string, sourceKey = `item:${itemId}:completed-suffix`) => this.observation(sourceKey, { type: 'timeline', provider: PROVIDER_ID, turnId, item: timelineOf(text) }, undefined, identity(key, true));
    if (streamed === undefined) return finalText ? complete(finalText, `item:${itemId}:completed`) : null;
    streamedText.delete(itemId);
    // The final message finishes what streamed: nothing more when it equals it, the rest when it continues it.
    if (finalText.startsWith(streamed)) return complete(finalText.slice(streamed.length));
    // A final that does not continue the stream cannot rewrite it: the item ends as streamed, and a corrected message stands beside it.
    if (!reasoning && finalText) {
      this.trailing.push(this.observation(`item:${itemId}:completed-correction`, { type: 'timeline', provider: PROVIDER_ID, turnId, item: timelineOf(finalText, `${itemId}:correction`) }, undefined, identity(`${key}:correction`, true)));
    }
    return complete('');
  }

  projectTurnFailure(message: string, turnId: string, occurredAt?: number): ProviderObservation {
    return this.observation(`turn:${turnId}:error`, {
      type: 'timeline', provider: PROVIDER_ID, turnId, item: { type: 'error', message: message.trim() || 'Codex turn failed without an error detail.' },
    }, occurredAt, identity(`turn-error:${turnId}`, true));
  }

  private projectTurnCompleted(
    params: unknown,
    turnId: string | undefined,
  ): ProviderObservation | null {
    if (!isRecord(params) || !isRecord(params.turn)) return null;
    const id = readString(params.turn.id) ?? turnId;
    if (!id) return null;
    const status = readString(params.turn.status);
    if (status === 'failed') {
      return this.observation(`turn:${id}:failed`, {
        type: 'turn_failed', provider: PROVIDER_ID, turnId: id,
        error: readErrorMessage(params.turn.error)?.trim() || 'Codex turn failed without an error detail.',
      });
    }
    if (status === 'interrupted') {
      return this.observation(`turn:${id}:canceled`, {
        type: 'turn_canceled', provider: PROVIDER_ID, turnId: id, reason: 'interrupted',
      });
    }
    return this.observation(`turn:${id}:completed`, {
      type: 'turn_completed', provider: PROVIDER_ID, turnId: id,
    });
  }

  private projectPlan(
    params: unknown,
    turnId: string | undefined,
  ): ProviderObservation | null {
    if (!isRecord(params) || !Array.isArray(params.plan)) return null;
    const items = params.plan.flatMap((value): AgentTaskItem[] => {
      if (!isRecord(value)) return [];
      const text = readString(value.step);
      if (!text) return [];
      const nativeStatus = readString(value.status);
      const status = nativeStatus === 'inProgress'
        ? 'in_progress'
        : nativeStatus === 'completed' ? 'completed' : 'pending';
      return [{ text, completed: status === 'completed', status }];
    });
    // Native history holds no plan update, so the journal keeps the only copy; a later update replaces the board.
    return this.observation(`turn:${turnId ?? 'unknown'}:plan:${stringifyJson(items)}`, {
      type: 'timeline', provider: PROVIDER_ID, turnId, item: { type: 'todo', items },
    }, undefined, identity('todo', true, true));
  }

  private projectUsage(
    params: unknown,
    turnId: string | undefined,
  ): ProviderObservation | null {
    const usage = isRecord(params) ? codexUsage(params.tokenUsage) : null;
    if (!usage) return null;
    return this.observation(`turn:${turnId ?? 'unknown'}:usage:${stringifyJson(usage)}`, {
      type: 'usage_updated', provider: PROVIDER_ID, turnId, usage,
    });
  }

  private mapItem(item: JsonObject, lifecycle: 'started' | 'completed'): AgentTimelineItem | null {
    const type = readString(item.type);
    const id = readString(item.id);
    if (!type || !id) return null;
    if (type === 'agentMessage') {
      const text = readString(item.text);
      return text ? { type: 'assistant_message', text, messageId: id } : null;
    }
    if (type === 'agentCommunication') {
      const sender = readString(item.sender), recipient = readString(item.recipient), text = readString(item.text);
      return sender && recipient && text !== undefined ? { type: 'agent_communication', messageId: id, sender, recipient, text } : null;
    }
    if (type === 'reasoning') {
      const text = this.readReasoningText(item);
      return text ? { type: 'reasoning', text } : null;
    }
    if (type === 'contextCompaction') {
      return { type: 'compaction', status: lifecycle === 'started' ? 'loading' : 'completed' };
    }
    if (type === 'sleep') {
      const duration = item.durationMs;
      const seconds = typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration / 1000 : undefined;
      // Sleep can end on new input; the requested duration is not elapsed time.
      return this.toolItem(id, 'clock.sleep', lifecycle === 'started' ? 'running' : 'completed', {
        type: 'other', description: seconds === undefined ? 'Wait' : `Wait up to ${seconds} ${seconds === 1 ? 'second' : 'seconds'} (requested)`,
      });
    }
    if (type === 'commandExecution') return this.mapCommand(item, lifecycle);
    if (type === 'fileChange') return this.mapFileChange(item, lifecycle);
    if (type === 'dynamicToolCall') {
      const result = codexToolResult(item);
      const status = item.success === false ? 'failed' : normalizeStatus(item.status, lifecycle);
      const name = readString(item.tool) ?? 'session_tool';
      const error = status === 'failed' ? result?.content.find(part => part.type === 'text') : undefined;
      return this.toolItem(id, name, status, { type: 'other', description: `Session tool ${name}` },
        error?.type === 'text' ? error.text : undefined, result);
    }
    if (type === 'mcpToolCall') return this.mapMcpTool(item, lifecycle);
    if (type === 'webSearch') return this.mapWebSearch(item, lifecycle);
    if (type === 'collabAgentToolCall' || type === 'subAgentActivity') return this.mapAgentActivity(item, lifecycle);
    if (type === 'plan') {
      const text = readString(item.text);
      return text ? { type: 'assistant_message', text, messageId: id } : null;
    }
    return {
      type: 'error',
      message: unsupportedMessage(`Unsupported Codex item type ${type}`, item),
    };
  }

  private mapCommand(item: JsonObject, lifecycle: 'started' | 'completed'): AgentToolCallTimelineItem {
    const callId = readString(item.id) ?? 'command';
    const status = normalizeStatus(item.status, lifecycle);
    const command = readString(item.command);
    const cwd = readString(item.cwd);
    return this.toolItem(callId, 'command', status,
      command
        ? { type: 'shell', command, ...(cwd ? { cwd } : {}) }
        : { type: 'other', description: 'Run a command' },
      readErrorMessage(item.error) ?? (status === 'failed' ? readString(item.aggregatedOutput) : undefined), codexToolResult(item));
  }

  private mapFileChange(item: JsonObject, lifecycle: 'started' | 'completed'): AgentToolCallTimelineItem {
    const callId = readString(item.id) ?? 'file-change';
    const status = normalizeStatus(item.status, lifecycle);
    const change = Array.isArray(item.changes) ? item.changes.find(isRecord) : undefined;
    const filePath = change ? readString(change.path) : undefined;
    return this.toolItem(callId, 'file_change', status,
      filePath ? { type: 'edit', filePath } : { type: 'other', description: 'File changes' },
      readErrorMessage(item.error), lifecycle === 'completed' ? codexToolResult(item) : undefined);
  }

  private mapMcpTool(item: JsonObject, lifecycle: 'started' | 'completed'): AgentToolCallTimelineItem {
    const callId = readString(item.id) ?? 'mcp-tool';
    const server = readString(item.server) ?? 'mcp';
    const tool = readString(item.tool) ?? 'tool';
    const status = normalizeStatus(item.status, lifecycle);
    return this.toolItem(callId, `${server}.${tool}`, status, {
      type: 'other', description: `MCP tool ${server}.${tool}`,
    }, readErrorMessage(item.error), codexToolResult(item));
  }

  private mapAgentActivity(item: JsonObject, lifecycle: 'started' | 'completed'): AgentToolCallTimelineItem {
    if (item.type === 'collabAgentToolCall' && item.tool === 'wait') {
      const status = normalizeStatus(item.status, lifecycle);
      const verb = status === 'running' ? 'Waiting' : 'Waited';
      const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : undefined;
      const targets = [...new Set((receivers ?? []).flatMap(value => readString(value) ? [readString(value)!] : []))];
      const description = targets.length ? `${verb} for agent updates:`
        : receivers?.length === 0 ? `${verb} for updates from any sub-agent`
        : `${verb} for agent updates (target unavailable)`;
      return this.toolItem(readString(item.id)!, 'agent.wait', status, {
        type: 'other', description,
        ...(targets.length ? { sessionReferences: targets.map(nativeSessionId => ({ nativeSessionId, title: nativeSessionId })) } : {}),
      }, readErrorMessage(item.error), lifecycle === 'completed' ? codexToolResult(item) : undefined);
    }
    const activity = item.type === 'subAgentActivity';
    const name = activity ? 'agent.activity' : `agent.${readString(item.tool) || 'collaboration'}`;
    const description = activity
      ? `Agent ${readString(item.agentPath) || readString(item.agentThreadId) || 'activity'}: ${readString(item.kind) || 'activity'}`
      : readString(item.prompt) || `Agent ${readString(item.tool) || 'collaboration'}`;
    const nativeSessionId = activity ? readString(item.agentThreadId) : undefined;
    const sessionReference = nativeSessionId ? { nativeSessionId, title: readString(item.agentPath) || nativeSessionId } : undefined;
    return this.toolItem(readString(item.id)!, name, normalizeStatus(item.status, lifecycle),
      { type: 'other', description, ...(sessionReference ? { sessionReference } : {}) }, readErrorMessage(item.error),
      lifecycle === 'completed' ? codexToolResult(item) : undefined);
  }

  private mapWebSearch(item: JsonObject, lifecycle: 'started' | 'completed'): AgentToolCallTimelineItem {
    const callId = readString(item.id) ?? 'web-search';
    const query = readString(item.query);
    return this.toolItem(callId, 'web_search', normalizeStatus(item.status, lifecycle),
      query ? { type: 'search', query } : { type: 'other', description: 'Web search' }, undefined,
      lifecycle === 'completed' ? codexToolResult(item) : undefined);
  }

  private toolItem(
    callId: string,
    name: string,
    status: 'running' | 'completed' | 'failed' | 'canceled',
    detail: AgentToolCallTimelineItem['detail'],
    error?: string,
    result?: import('@orchardworks/agent-provider-sdk').AgentToolResult,
  ): AgentToolCallTimelineItem {
    if (status === 'failed') return { type: 'tool_call', callId, name, detail, status, error: error ?? 'Tool failed', ...(result ? { result } : {}) };
    return { type: 'tool_call', callId, name, detail, status, error: null, ...(result ? { result } : {}) };
  }

  private projectUserMessage(item: JsonObject, id: string, key: string, turnId?: string, occurredAt?: number): ProviderObservation | null {
    if (!Array.isArray(item.content)) return null;
    const content: AgentUserMessagePart[] = [];
    const resourceReferences: ProviderResourceReference[] = [];
    let imageIndex = 0;
    for (const [index, entry] of item.content.entries()) {
      if (!isRecord(entry)) continue;
      if (entry.type === 'text' && typeof entry.text === 'string') {
        if (codexImagePlaceholderLabel(entry, item.content[index + 1]) === undefined) content.push(...projectResourceInputText(entry.text));
      }
      else if (entry.type === 'image' || entry.type === 'localImage') {
        const label = codexImagePlaceholderLabel(item.content[index - 1], entry);
        const image = this.images.projectUser(id, index, entry, label ?? `image #${imageIndex + 1}`, this.cwd);
        imageIndex++;
        content.push(image.part);
        resourceReferences.push(...image.resourceReferences);
      }
    }
    const text = content.map(part => part.type === 'text' ? part.text : `[${part.label}]`).join('');
    if (!text) return null;
    return { ...this.observation(key, { type: 'timeline', provider: PROVIDER_ID, turnId,
      item: { type: 'user_message', text, messageId: id, ...(content.some(part=>part.type!=='text') ? { content } : {}),
        ...(readString(item.clientId) ? { clientMessageId: readString(item.clientId) } : {}) } }, occurredAt, identity(`user:${id}`, true)),
      ...(imageIndex ? { resourceReferences } : {}) };
  }

  private readReasoningText(item: JsonObject): string {
    const summary = Array.isArray(item.summary) ? item.summary.filter((value): value is string => typeof value === 'string') : [];
    if (summary.length > 0) return summary.join('\n\n');
    return Array.isArray(item.content)
      ? item.content.filter((value): value is string => typeof value === 'string').join('\n\n')
      : '';
  }

  private observation(
    sourceKey: string,
    event: AgentStreamEvent,
    occurredAt = this.now(),
    itemIdentity?: ProviderItemIdentity,
  ): ProviderObservation {
    return {
      type: 'observation', sourceKey, occurredAt, delivery: this.delivery,
      event, ...(itemIdentity ? { itemIdentity } : {}),
    };
  }

  /** An error the native history never holds. The message names the item, so the same message is one item however often it arrives. */
  private errorItem(sourceKey: string, message: string, turnId: string | undefined): ProviderObservation {
    return this.observation(sourceKey, { type: 'timeline', provider: PROVIDER_ID, turnId, item: { type: 'error', message } }, undefined, errorIdentity(message));
  }

  private invalidNotification(
    method: string,
    params: unknown,
    turnId?: string,
  ): ProviderObservation {
    return this.errorItem(`invalid:notification:${method}:${nativeFingerprint(params)}`, unsupportedMessage(`Invalid Codex notification ${method}`, params), turnId);
  }
}

/** One item of a journal: its key, whether this observation finishes it, and whether native history cannot rebuild it. */
function identity(key: string, completes = false, liveOnly = false): ProviderItemIdentity {
  return { key, ...(completes ? { completes: true as const } : {}), ...(liveOnly ? { liveOnly: true as const } : {}) };
}

/** An error that native history does not hold: live-only, keyed by its message. */
export function errorIdentity(message: string): ProviderItemIdentity {
  return identity(`error:${createHash('sha256').update(message).digest('hex').slice(0, 16)}`, true, true);
}

function unsupportedMessage(prefix: string, details: unknown): string {
  const message = `${prefix}: ${stringifyJson(details)}`;
  if (message.length <= MAX_UNSUPPORTED_MESSAGE_LENGTH) return message;
  return `${message.slice(0, MAX_UNSUPPORTED_MESSAGE_LENGTH - 1)}…`;
}

function nativeFingerprint(value: unknown): string {
  const text = stringifyJson(value);
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

import { codexToolResult } from './tool-result.js';
import { CodexImageRegistry } from './images.js';
import type {
  AgentStreamEvent,
  AgentTaskItem,
  AgentTimelineItem,
  AgentToolCallTimelineItem,
  ProviderObservation,
} from '@borgee/agent-provider-sdk';

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
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'remoteControl/status/changed',
  'serverRequest/resolved',
  'thread/settings/updated',
  'thread/name/updated',
  'thread/status/changed',
  'turn/diff/updated',
  'warning',
]);

export interface CodexEventProjectorOptions {
  now?: () => number;
  delivery?: 'history' | 'live';
  images?: CodexImageRegistry;
  cwd?: string;
}

export class CodexEventProjector {
  private readonly assistantText = new Map<string, string>();
  private readonly reasoningText = new Map<string, string>();
  private readonly seenDeltaKeys = new Set<string>();
  private readonly emittedUserItems = new Set<string>();
  private readonly now: () => number;
  private readonly delivery: 'history' | 'live';
  private readonly images: CodexImageRegistry;
  private readonly cwd: string | undefined;

  constructor(
    private readonly threadId: string,
    options: CodexEventProjectorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.delivery = options.delivery ?? 'live';
    this.images = options.images ?? new CodexImageRegistry(threadId);
    this.cwd = options.cwd;
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

  projectNotification(method: string, params: unknown): ProviderObservation | null {
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
      if (status !== 'failed') return null;
      const name = readString(params.name) ?? (isRecord(params.run) ? readString(params.run.eventName) : undefined) ?? method;
      const detail = readErrorMessage(params.error) ?? readString(params.failureReason) ?? (isRecord(params.run) ? readString(params.run.statusMessage) : undefined);
      return this.observation(`runtime:${method}:${name}:failed`, {
        type: 'timeline', provider: PROVIDER_ID, turnId,
        item: { type: 'error', message: `${name} failed${detail ? `: ${detail}` : '.'}` },
      });
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
    if (method === 'thread/compacted') {
      return this.observation(`thread:${this.threadId}:compacted:${turnId ?? 'unknown'}`, {
        type: 'timeline', provider: PROVIDER_ID, turnId,
        item: { type: 'compaction', status: 'completed' },
      });
    }
    if (method === 'error' && isRecord(params)) {
      const message = readErrorMessage(params.error) ?? readString(params.message);
      if (!message) return this.invalidNotification(method, params, turnId);
      return this.observation(`error:${turnId ?? this.threadId}:${message}`, {
        type: 'timeline', provider: PROVIDER_ID, turnId,
        item: { type: 'error', message },
      });
    }
    return this.observation(
      `unsupported:notification:${method}:${nativeFingerprint(params)}`,
      {
        type: 'timeline', provider: PROVIDER_ID, turnId,
        item: { type: 'error', message: unsupportedMessage(`Unsupported Codex notification ${method}`, params) },
      },
    );
  }

  projectHistoryItem(item: unknown, turnId?: string, occurredAt?: number): ProviderObservation | null {
    if (!isRecord(item)) return null;
    const id = readString(item.id);
    if (id && (item.type === 'imageView' || item.type === 'imageGeneration')) {
      return this.projectImage(item, id, turnId, occurredAt);
    }
    const timelineItem = this.mapItem(item, 'completed');
    if (!timelineItem || !id) return null;
    return this.observation(`item:${id}:completed`, {
      type: 'timeline', provider: PROVIDER_ID, turnId, item: timelineItem,
    }, occurredAt);
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
    const sourceKey = `item:${itemId}:${reasoning ? 'reasoning' : 'assistant'}:delta:${nativeFingerprint(params)}`;
    const prior = values.get(itemId) ?? '';
    if (!this.seenDeltaKeys.has(sourceKey)) {
      values.set(itemId, prior + delta);
      this.seenDeltaKeys.add(sourceKey);
    }
    const item: AgentTimelineItem = reasoning
      ? { type: 'reasoning', text: delta }
      : { type: 'assistant_message', messageId: itemId, text: delta };
    return this.observation(sourceKey, {
      type: 'timeline', provider: PROVIDER_ID, turnId, item,
    });
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
    if (itemType === 'userMessage') {
      if (this.emittedUserItems.has(itemId)) return null;
      const mapped = this.mapItem(item, lifecycle);
      if (!mapped) return null;
      this.emittedUserItems.add(itemId);
      return this.observation(`item:${itemId}:user`, {
        type: 'timeline', provider: PROVIDER_ID, turnId, item: mapped,
      });
    }
    const mapped = this.mapItem(item, lifecycle);
    if (!mapped) return null;
    return this.observation(`item:${itemId}:${lifecycle}`, {
      type: 'timeline', provider: PROVIDER_ID, turnId, item: mapped,
    });
  }

  private projectImage(item: JsonObject, itemId: string, turnId?: string, occurredAt?: number): ProviderObservation | null {
    const projected = this.images.project(item, this.cwd);
    if (!projected) return null;
    return {
      ...this.observation(`item:${itemId}:completed`, {
        type: 'timeline', provider: PROVIDER_ID, turnId, item: projected.item,
      }, occurredAt),
      resourceReferences: projected.resourceReferences,
    };
  }

  private projectCompletedTextItem(
    item: JsonObject,
    itemId: string,
    turnId: string | undefined,
  ): ProviderObservation | null {
    const reasoning = item.type === 'reasoning';
    const finalText = reasoning
      ? this.readReasoningText(item)
      : readString(item.text) ?? '';
    const streamedText = reasoning ? this.reasoningText : this.assistantText;
    const streamed = streamedText.get(itemId);
    if (streamed !== undefined) {
      streamedText.delete(itemId);
      if (finalText === streamed) {
        return null;
      }
      if (!finalText.startsWith(streamed)) {
        const fingerprint = nativeFingerprint(item);
        if (!reasoning && finalText) {
          return this.observation(`item:${itemId}:completed-correction:${fingerprint}`, {
            type: 'timeline', provider: PROVIDER_ID, turnId,
            item: {
              type: 'assistant_message',
              messageId: `${itemId}:correction:${fingerprint}`,
              text: finalText,
            },
          });
        }
        return this.observation(`item:${itemId}:completed-correction:${nativeFingerprint(item)}`, {
          type: 'timeline', provider: PROVIDER_ID, turnId,
          item: {
            type: 'error',
            message: unsupportedMessage(`Codex final text corrected streamed item ${itemId}`, {
              streamed,
              final: finalText,
            }),
          },
        });
      }
      const suffix = finalText.slice(streamed.length);
      if (!suffix) return null;
      const timelineItem: AgentTimelineItem = reasoning
        ? { type: 'reasoning', text: suffix }
        : { type: 'assistant_message', messageId: itemId, text: suffix };
      return this.observation(`item:${itemId}:completed-suffix`, {
        type: 'timeline', provider: PROVIDER_ID, turnId, item: timelineItem,
      });
    }
    const timelineItem: AgentTimelineItem = reasoning
      ? { type: 'reasoning', text: finalText }
      : { type: 'assistant_message', messageId: itemId, text: finalText };
    if (!finalText) return null;
    return this.observation(`item:${itemId}:completed`, {
      type: 'timeline', provider: PROVIDER_ID, turnId, item: timelineItem,
    });
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
        error: readErrorMessage(params.turn.error) ?? 'Codex turn failed',
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
    return this.observation(`turn:${turnId ?? 'unknown'}:plan:${stringifyJson(items)}`, {
      type: 'timeline', provider: PROVIDER_ID, turnId, item: { type: 'todo', items },
    });
  }

  private projectUsage(
    params: unknown,
    turnId: string | undefined,
  ): ProviderObservation | null {
    if (!isRecord(params) || !isRecord(params.tokenUsage) || !isRecord(params.tokenUsage.total)) {
      return null;
    }
    const total = params.tokenUsage.total;
    const usage = {
      inputTokens: readNumber(total.inputTokens),
      cachedInputTokens: readNumber(total.cachedInputTokens),
      outputTokens: readNumber(total.outputTokens),
      contextWindowMaxTokens: readNumber(params.tokenUsage.modelContextWindow),
      contextWindowUsedTokens: readNumber(total.totalTokens),
    };
    return this.observation(`turn:${turnId ?? 'unknown'}:usage:${stringifyJson(usage)}`, {
      type: 'usage_updated', provider: PROVIDER_ID, turnId, usage,
    });
  }

  private mapItem(item: JsonObject, lifecycle: 'started' | 'completed'): AgentTimelineItem | null {
    const type = readString(item.type);
    const id = readString(item.id);
    if (!type || !id) return null;
    if (type === 'userMessage') {
      const text = this.readUserMessageText(item);
      return text ? {
        type: 'user_message', text, messageId: id,
        ...(readString(item.clientId) ? { clientMessageId: readString(item.clientId) } : {}),
      } : null;
    }
    if (type === 'agentMessage') {
      const text = readString(item.text);
      return text ? { type: 'assistant_message', text, messageId: id } : null;
    }
    if (type === 'reasoning') {
      const text = this.readReasoningText(item);
      return text ? { type: 'reasoning', text } : null;
    }
    if (type === 'contextCompaction') {
      return { type: 'compaction', status: lifecycle === 'started' ? 'loading' : 'completed' };
    }
    if (type === 'commandExecution') return this.mapCommand(item, lifecycle);
    if (type === 'fileChange') return this.mapFileChange(item, lifecycle);
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
    const activity = item.type === 'subAgentActivity';
    const name = activity ? 'agent.activity' : `agent.${readString(item.tool) || 'collaboration'}`;
    const description = activity
      ? `Agent ${readString(item.agentPath) || readString(item.agentThreadId) || 'activity'}: ${readString(item.kind) || 'activity'}`
      : readString(item.prompt) || `Agent ${readString(item.tool) || 'collaboration'}`;
    return this.toolItem(readString(item.id)!, name, normalizeStatus(item.status, lifecycle),
      { type: 'other', description }, readErrorMessage(item.error),
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
    result?: import('@borgee/agent-provider-sdk').AgentToolResult,
  ): AgentToolCallTimelineItem {
    if (status === 'failed') return { type: 'tool_call', callId, name, detail, status, error: error ?? 'Tool failed', ...(result ? { result } : {}) };
    return { type: 'tool_call', callId, name, detail, status, error: null, ...(result ? { result } : {}) };
  }

  private readUserMessageText(item: JsonObject): string {
    if (!Array.isArray(item.content)) return '';
    return item.content.flatMap((entry) => {
      if (!isRecord(entry) || entry.type !== 'text') return [];
      const text = readString(entry.text);
      return text ? [text] : [];
    }).join('');
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
  ): ProviderObservation {
    return {
      type: 'observation', sourceKey, occurredAt, delivery: this.delivery,
      event,
    };
  }

  private invalidNotification(
    method: string,
    params: unknown,
    turnId?: string,
  ): ProviderObservation {
    return this.observation(`invalid:notification:${method}:${nativeFingerprint(params)}`, {
      type: 'timeline', provider: PROVIDER_ID, turnId,
      item: { type: 'error', message: unsupportedMessage(`Invalid Codex notification ${method}`, params) },
    });
  }
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

import { createHash } from 'node:crypto';
import { boundToolResult, fileChangesResult, type AgentFileChange, type AgentToolResult, type AgentToolResultContent, type AgentToolResultJson, type AgentTimelineItem, type AgentToolDetail, type AgentUsage, type ProviderObservation } from '@orchardworks/agent-provider-sdk';
import type { OpenCodeImages } from './images.js';
import { turnIds, type NativeAssistant, type NativeError, type NativeMessage, type NativeSession, type NativeTokenUsage, type NativeTool } from './v2-native.js';
export type { NativeMessage } from './v2-native.js';
export { turnIds } from './v2-native.js';
export const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
export function toolDetail(name: string, input: Record<string, unknown>): AgentToolDetail {
  const value = (key: string) => typeof input[key] === 'string' ? input[key] as string : '';
  if ((name === 'bash' || name === 'shell') && value('command')) return { type: 'shell', command: value('command'), ...(value('workdir') ? { cwd: value('workdir') } : {}) };
  if (name === 'read' && value('path')) return { type: 'read', filePath: value('path') };
  if (name === 'edit' && value('path')) return { type: 'edit', filePath: value('path') };
  if (name === 'write' && value('path')) return { type: 'write', filePath: value('path') };
  if ((name === 'grep' || name === 'glob' || name === 'websearch') && (value('pattern') || value('query'))) return { type: 'search', query: value('pattern') || value('query') };
  if (name === 'webfetch' && value('url')) return { type: 'fetch', url: value('url') };
  return { type: 'other', description: name };
}
export interface OpenCodeUsageContext {
  session?: Partial<Pick<NativeSession, 'cost' | 'tokens'>>;
  contextWindows?: ReadonlyMap<string, number>;
}
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const tokenCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function sumTokens(values: unknown[]): number | undefined {
  if (!values.every(tokenCount)) return undefined;
  const sum = values.reduce((total, value) => total + value, 0);
  return tokenCount(sum) ? sum : undefined;
}
function tokenBuckets(tokens: NativeTokenUsage | undefined): unknown[] {
  // Native input, cache read/write, output, and reasoning are disjoint buckets.
  return [tokens?.input, tokens?.output, tokens?.reasoning, tokens?.cache?.read, tokens?.cache?.write];
}
function snapshotTotal(tokens: NativeTokenUsage | undefined): number | undefined {
  return sumTokens(tokenBuckets(tokens));
}
export function usage(messages: readonly NativeMessage[], context: OpenCodeUsageContext = {}): AgentUsage {
  const assistants = messages.filter((info): info is NativeAssistant => info.type === 'assistant');
  const latest = [...assistants].reverse().find(info => tokenBuckets(info.tokens).some(value => tokenCount(value) && value > 0)) ?? assistants.at(-1);
  // Session counters are native aggregates. History pages alone never establish a session total.
  const tokens = context.session?.tokens ?? latest?.tokens;
  const result: AgentUsage = {};
  if (tokenCount(tokens?.input)) result.inputTokens = tokens.input;
  if (tokenCount(tokens?.cache?.read)) result.cachedInputTokens = tokens.cache.read;
  if (tokenCount(tokens?.cache?.write)) result.cacheCreationInputTokens = tokens.cache.write;
  const output = sumTokens([tokens?.output, tokens?.reasoning]);
  const total = snapshotTotal(tokens);
  if (output !== undefined) result.outputTokens = output;
  if (total !== undefined) result.totalTokens = total;
  if (Object.keys(result).length) result.tokenScope = context.session?.tokens ? 'session' : 'call';
  if (nonnegative(context.session?.cost)) result.totalCostUsd = context.session.cost;
  if (latest) {
    const used = snapshotTotal(latest.tokens);
    const capacity = context.contextWindows?.get(`${latest.model.providerID}/${latest.model.id}`);
    if (used !== undefined) result.contextWindowUsedTokens = used;
    if (tokenCount(capacity) && capacity > 0) result.contextWindowMaxTokens = capacity;
    if (result.contextWindowUsedTokens !== undefined || result.contextWindowMaxTokens !== undefined) result.contextScope = 'current';
  }
  return result;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function fileChanges(part: NativeTool, metadata: Record<string, unknown>): AgentFileChange[] {
  if (['edit', 'patch', 'write'].includes(part.name) && Array.isArray(metadata.files)) return metadata.files.flatMap(value => {
    const file = record(value);
    if (!file || typeof file.file !== 'string' || typeof file.patch !== 'string') return [];
    const kind = file.status === 'added' || file.status === 'deleted' || file.status === 'modified' ? file.status : 'unknown';
    return [{ path: file.file, kind, diff: file.patch }];
  });
  return [];
}
function toolResult(part: NativeTool): AgentToolResult | undefined {
  const state = part.state;
  if (state.status !== 'completed' && state.status !== 'error') return;
  const metadata = state.metadata ?? {};
  const shell = part.name === 'shell';
  const files = state.status === 'completed' ? fileChanges(part, metadata) : [];
  const changes = files.length ? fileChangesResult(files) : undefined;
  const content: AgentToolResultContent[] = changes?.content ?? [];
  for (const block of state.content ?? []) if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text, ...(shell ? { stream: 'combined' as const } : {}) });
  if (metadata.structuredContent !== undefined) content.push({ type: 'json', value: metadata.structuredContent as AgentToolResultJson });
  const durationMs = part.time.completed !== undefined && part.time.ran !== undefined ? part.time.completed - part.time.ran : undefined;
  return boundToolResult({ content, ...(nonnegative(durationMs) ? { durationMs } : {}),
    ...(shell && Number.isSafeInteger(metadata.exit) ? { exitCode: metadata.exit as number } : {}),
    ...(metadata.truncated === true || changes?.truncated ? { truncated: true } : {}) });
}
export function todoItem(todos: readonly { content: string; status: string }[]): AgentTimelineItem {
  return { type: 'todo', items: todos.map(todo => ({ text: todo.content, completed: todo.status === 'completed', status: todo.status === 'in_progress' ? 'in_progress' : todo.status === 'completed' ? 'completed' : 'pending' })) };
}
export function normalize(messages: readonly NativeMessage[], images: OpenCodeImages, options: { startsAtBeginning?: boolean; sessionId?: string } = {}): ProviderObservation[] {
  const observations: ProviderObservation[] = [];
  const turns = turnIds(messages, options);
  for (const info of messages) {
    const turnId = turns.get(info.id);
    const add = (key: string, item: AgentTimelineItem, references?: ProviderObservation['resourceReferences'], occurredAt = info.time.created) => observations.push({ type: 'observation', sourceKey: key, occurredAt, delivery: 'history', event: { type: 'timeline', provider: 'opencode', ...(turnId ? { turnId } : {}), item }, ...(references?.length ? { resourceReferences: references } : {}) });
    if (info.type === 'user') {
      const attachments = images.project(info.id, (info.files ?? []).map((file, index) => ({ key: `file:${index}`, mime: file.mime, data: file.data, name: file.name })));
      const text = info.text;
      if (text || attachments.content.length) add(`message:${info.id}`, { type: 'user_message', text, messageId: info.id, ...(attachments.content.length ? { content: [...(text ? [{ type: 'text' as const, text }] : []), ...attachments.content] } : {}) }, attachments.references);
      continue;
    }
    if (info.type === 'synthetic') {
      if (info.text) add(`message:${info.id}`, { type: 'user_message', text: `[Injected context]\n${info.text}` });
      continue;
    }
    if (info.type === 'compaction') {
      add(`message:${info.id}`, info.status === 'failed' ? { type: 'error', message: `OpenCode compaction failed: ${nativeError(info.error)}` }
        : { type: 'compaction', status: info.status === 'completed' ? 'completed' : 'loading', trigger: info.reason });
      continue;
    }
    if (info.type === 'shell') {
      const durationMs = info.time.completed !== undefined ? info.time.completed - info.time.created : undefined;
      const result = boundToolResult({ content: info.output?.output ? [{ type: 'text', text: info.output.output, stream: 'combined' }] : [],
        ...(Number.isSafeInteger(info.exit) ? { exitCode: info.exit as number } : {}), ...(nonnegative(durationMs) ? { durationMs } : {}), ...(info.output?.truncated ? { truncated: true } : {}) });
      const base = { type: 'tool_call' as const, callId: info.shellID, name: 'shell', detail: { type: 'shell' as const, command: info.command }, result };
      add(`message:${info.id}`, info.status === 'killed' ? { ...base, status: 'canceled', error: null }
        : info.status === 'timeout' ? { ...base, status: 'failed', error: 'OpenCode shell command timed out.' }
        : { ...base, status: info.status === 'running' ? 'running' : 'completed', error: null });
      continue;
    }
    // System instructions, skill bodies and selection records are native configuration, not chat.
    if (info.type !== 'assistant') continue;
    for (const [index, part] of info.content.entries()) {
      const key = `part:${info.id}:${part.type === 'tool' ? `tool:${part.id}` : index}`;
      if (part.type === 'text' && part.text) add(key, { type: 'assistant_message', text: part.text, messageId: info.id });
      if (part.type === 'reasoning' && part.text) add(key, { type: 'reasoning', text: part.text }, undefined, part.time?.created ?? info.time.created);
      if (part.type !== 'tool') continue;
      const state = part.state;
      const result = toolResult(part);
      const input = state.status === 'streaming' ? {} : state.input;
      const base = { type: 'tool_call' as const, callId: part.id, name: part.name, detail: toolDetail(part.name, input), ...(result ? { result } : {}) };
      add(key, state.status === 'error' ? { ...base, status: 'failed', error: nativeError(state.error) } : { ...base, status: state.status === 'completed' ? 'completed' : 'running', error: null }, undefined, part.time.created);
      if (state.status === 'completed' || state.status === 'error') for (const [fileIndex, file] of (state.content ?? []).entries()) {
        if (file.type !== 'file') continue;
        const attachment = images.project(info.id, [{ key: `tool:${part.id}:file:${fileIndex}`, mime: file.mime, uri: file.uri, name: file.name }]);
        for (const content of attachment.content) add(`${key}:attachment:${fileIndex}`, { type: 'assistant_message', text: content.type === 'image' ? `![Image](${content.locator})` : content.text, messageId: `${info.id}:${part.id}:${fileIndex}` }, attachment.references, part.time.completed ?? part.time.created);
      }
      const metadata = state.status === 'streaming' ? undefined : state.metadata;
      const childId = typeof metadata?.sessionID === 'string' ? metadata.sessionID : undefined;
      if (part.name === 'subagent' && options.sessionId && childId) {
        if (typeof input.prompt === 'string' && input.prompt) add(`${key}:request`, { type: 'agent_communication', messageId: `${info.id}:${part.id}:request`, sender: options.sessionId, recipient: childId, text: input.prompt }, undefined, part.time.ran ?? part.time.created);
        if (state.status === 'completed' && metadata?.status === 'completed') {
          const output = state.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
          const prefix = `<subagent sessionID="${childId}" state="completed">\n`;
          const suffix = '\n</subagent>';
          if (output.startsWith(prefix) && output.endsWith(suffix)) add(`${key}:reply`, { type: 'agent_communication', messageId: `${info.id}:${part.id}:reply`, sender: childId, recipient: options.sessionId, text: output.slice(prefix.length, -suffix.length) }, undefined, part.time.completed ?? info.time.completed ?? info.time.created);
        }
      }
    }
    if (info.error) add(`error:${info.id}`, { type: 'error', message: nativeError(info.error) }, undefined, info.time.completed ?? info.time.created);
  }
  return observations;
}
export function nativeError(error: NativeError): string {
  return error.message.trim() || `OpenCode operation failed (${error.type || 'native error'}).`;
}

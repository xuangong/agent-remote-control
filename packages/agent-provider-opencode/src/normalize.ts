import { createHash } from 'node:crypto';
import { boundToolResult, fileChangesResult, type AgentFileChange, type AgentToolResult, type AgentToolResultContent, type AgentToolResultJson, type AgentTimelineItem, type AgentToolDetail, type AgentUsage, type ProviderObservation } from '@orchardworks/agent-provider-sdk';
import type { AssistantMessage, Message, Part, Session, Todo, ToolPart } from '@opencode-ai/sdk/v2/client';
import type { OpenCodeImages } from './images.js';
export type NativeMessage = { info: Message; parts: Part[] };
export const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
export function toolDetail(name: string, input: Record<string, unknown>): AgentToolDetail {
  const value = (key: string) => typeof input[key] === 'string' ? input[key] as string : '';
  if ((name === 'bash' || name === 'shell') && value('command')) return { type: 'shell', command: value('command'), ...(value('workdir') ? { cwd: value('workdir') } : {}) };
  if (name === 'read' && value('filePath')) return { type: 'read', filePath: value('filePath') };
  if ((name === 'edit' || name === 'multiedit') && value('filePath')) return { type: 'edit', filePath: value('filePath') };
  if (name === 'write' && value('filePath')) return { type: 'write', filePath: value('filePath') };
  if ((name === 'grep' || name === 'glob' || name === 'websearch') && (value('pattern') || value('query'))) return { type: 'search', query: value('pattern') || value('query') };
  if (name === 'webfetch' && value('url')) return { type: 'fetch', url: value('url') };
  return { type: 'other', description: name };
}
export interface OpenCodeUsageContext {
  session?: Pick<Session, 'cost' | 'tokens'>;
  contextWindows?: ReadonlyMap<string, number>;
}
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function contextTokens(info: AssistantMessage): number | undefined {
  // Match the native context UI, including cache creation and reasoning exactly once.
  const values = [info.tokens?.input, info.tokens?.output, info.tokens?.reasoning, info.tokens?.cache?.read, info.tokens?.cache?.write];
  return values.every(nonnegative) ? values.reduce((sum, value) => sum + value, 0) : undefined;
}
export function usage(messages: NativeMessage[], context: OpenCodeUsageContext = {}): AgentUsage {
  const assistants = messages.flatMap(({ info }) => info.role === 'assistant' ? [info] : []);
  const latest = [...assistants].reverse().find(info => (contextTokens(info) ?? 0) > 0) ?? assistants.at(-1);
  // Session counters are native aggregates. History pages alone never establish a session total.
  const tokens = context.session?.tokens ?? latest?.tokens;
  const result: AgentUsage = {};
  if (nonnegative(tokens?.input)) result.inputTokens = tokens.input;
  if (nonnegative(tokens?.cache?.read)) result.cachedInputTokens = tokens.cache.read;
  if (nonnegative(tokens?.output) && nonnegative(tokens?.reasoning)) result.outputTokens = tokens.output + tokens.reasoning;
  if (nonnegative(context.session?.cost)) result.totalCostUsd = context.session.cost;
  if (latest) {
    const used = contextTokens(latest);
    const capacity = context.contextWindows?.get(`${latest.providerID}/${latest.modelID}`);
    if (used !== undefined) result.contextWindowUsedTokens = used;
    if (nonnegative(capacity) && capacity > 0) result.contextWindowMaxTokens = capacity;
  }
  return result;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function fileChanges(part: ToolPart, metadata: Record<string, unknown>): AgentFileChange[] {
  if (part.tool === 'apply_patch' && Array.isArray(metadata.files)) return metadata.files.flatMap(value => {
    const file = record(value);
    if (!file || typeof file.filePath !== 'string' || typeof file.patch !== 'string') return [];
    const moved = typeof file.movePath === 'string' && file.movePath.length > 0;
    const kind = moved ? 'renamed' : file.type === 'add' ? 'added' : file.type === 'delete' ? 'deleted' : file.type === 'update' ? 'modified' : 'unknown';
    return [{ path: moved ? file.movePath as string : file.filePath, kind, diff: file.patch, ...(moved ? { previousPath: file.filePath } : {}) }];
  });
  if (part.tool === 'edit' || part.tool === 'multiedit') {
    const file = record(metadata.filediff);
    const path = typeof file?.file === 'string' ? file.file : part.state.input.filePath;
    const diff = typeof file?.patch === 'string' ? file.patch : metadata.diff;
    if (typeof path === 'string' && typeof diff === 'string') return [{ path, kind: 'modified', diff }];
  }
  if (part.tool === 'write' && typeof metadata.filepath === 'string') return [{
    path: metadata.filepath, kind: metadata.exists === false ? 'added' : metadata.exists === true ? 'modified' : 'unknown',
    // Native write metadata has no final diff after formatting; requested content is not that diff.
    diff: typeof metadata.diff === 'string' ? metadata.diff : '',
  }];
  return [];
}
function toolResult(part: ToolPart): AgentToolResult | undefined {
  const state = part.state;
  if (state.status !== 'completed' && state.status !== 'error') return;
  const metadata = state.metadata ?? {};
  const shell = part.tool === 'bash' || part.tool === 'shell';
  const files = state.status === 'completed' ? fileChanges(part, metadata) : [];
  const changes = files.length ? fileChangesResult(files) : undefined;
  const content: AgentToolResultContent[] = changes?.content ?? [];
  const output = state.status === 'completed' ? state.output : typeof metadata.output === 'string' ? metadata.output : undefined;
  if (output) content.push({ type: 'text', text: output, ...(shell ? { stream: 'combined' as const } : {}) });
  if (metadata.structuredContent !== undefined) content.push({ type: 'json', value: metadata.structuredContent as AgentToolResultJson });
  const durationMs = state.time.end - state.time.start;
  return boundToolResult({ content, ...(nonnegative(durationMs) ? { durationMs } : {}),
    ...(shell && Number.isSafeInteger(metadata.exit) ? { exitCode: metadata.exit as number } : {}),
    ...(metadata.truncated === true || changes?.truncated ? { truncated: true } : {}) });
}
export function todoItem(todos: Todo[]): AgentTimelineItem {
  return { type: 'todo', items: todos.map(todo => ({ text: todo.content, completed: todo.status === 'completed', status: todo.status === 'in_progress' ? 'in_progress' : todo.status === 'completed' ? 'completed' : 'pending' })) };
}
export function normalize(messages: NativeMessage[], images: OpenCodeImages): ProviderObservation[] {
  const observations: ProviderObservation[] = [];
  const completedCompactions = new Set(messages.flatMap(({ info }) => info.role === 'assistant' && info.summary && info.time.completed ? [info.parentID] : []));
  for (const { info, parts } of messages) {
    const turnId = info.role === 'assistant' ? info.parentID : info.id;
    const add = (key: string, item: AgentTimelineItem, references?: ProviderObservation['resourceReferences']) => observations.push({ type: 'observation', sourceKey: key, occurredAt: info.time.created, delivery: 'history', event: { type: 'timeline', provider: 'opencode', turnId, item }, ...(references?.length ? { resourceReferences: references } : {}) });
    if (info.role === 'user') {
      const text = parts.filter(p => p.type === 'text' && !p.ignored).map(p => p.type === 'text' ? p.text : '').join('\n');
      const attachments = images.project(info.id, parts);
      if (text || attachments.content.length) add(`message:${info.id}`, { type: 'user_message', text, messageId: info.id, ...(attachments.content.length ? { content: [...(text ? [{ type: 'text' as const, text }] : []), ...attachments.content] } : {}) }, attachments.references);
      for (const part of parts) if (part.type === 'compaction') add(`part:${info.id}:${part.id}`, { type: 'compaction', status: completedCompactions.has(info.id) ? 'completed' : 'loading', trigger: part.auto ? 'auto' : 'manual' });
      continue;
    }
    for (const part of parts) {
      const key = `part:${info.id}:${part.id}`;
      if (part.type === 'text' && !part.ignored && part.text) add(key, { type: 'assistant_message', text: part.text, messageId: info.id });
      if (part.type === 'file') {
        const attachment = images.project(info.id, [part]);
        for (const image of attachment.content) if (image.type === 'image') add(key, { type: 'assistant_message', text: `![Image](${image.locator})`, messageId: `${info.id}:${part.id}` }, attachment.references);
      }
      if (part.type === 'reasoning' && part.text) add(key, { type: 'reasoning', text: part.text });
      if (part.type === 'compaction') add(key, { type: 'compaction', status: info.time.completed ? 'completed' : 'loading', trigger: part.auto ? 'auto' : 'manual' });
      if (part.type === 'tool') {
        const state = part.state;
        const result = toolResult(part);
        const base = { type: 'tool_call' as const, callId: part.callID, name: part.tool, detail: toolDetail(part.tool, state.input), ...(result ? { result } : {}) };
        add(key, state.status === 'error' ? { ...base, status: 'failed', error: state.error } : { ...base, status: state.status === 'completed' ? 'completed' : 'running', error: null });
        if (state.status === 'completed') for (const file of state.attachments ?? []) {
          const attachment = images.project(info.id, [file]);
          for (const image of attachment.content) if (image.type === 'image') add(`${key}:attachment:${file.id}`, { type: 'assistant_message', text: `![Image](${image.locator})`, messageId: `${info.id}:${file.id}` }, attachment.references);
        }
      }
    }
    if (info.error) add(`error:${info.id}`, { type: 'error', message: nativeError(info.error) });
  }
  return observations;
}
export function nativeError(error: { name: string }): string {
  if (error.name === 'MessageAbortedError') return 'OpenCode turn canceled.';
  if (error.name === 'ProviderAuthError') return 'OpenCode model authentication failed. Check the native server credentials.';
  if (error.name === 'ContextOverflowError') return 'OpenCode model context limit exceeded.';
  return `OpenCode turn failed (${/^[A-Za-z]+Error$/.test(error.name) ? error.name : 'native error'}).`;
}

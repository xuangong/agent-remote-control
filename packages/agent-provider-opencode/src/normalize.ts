import { createHash } from 'node:crypto';
import { boundToolResult, type AgentTimelineItem, type AgentToolDetail, type AgentUsage, type ProviderObservation } from '@orchardworks/agent-provider-sdk';
import type { Message, Part, Todo } from '@opencode-ai/sdk/v2/client';
import type { OpenCodeImages } from './images.js';
export type NativeMessage = { info: Message; parts: Part[] };
export const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
export function toolDetail(name: string, input: Record<string, unknown>): AgentToolDetail {
  const value = (key: string) => typeof input[key] === 'string' ? input[key] as string : '';
  if (name === 'bash') return { type: 'shell', command: value('command'), ...(value('workdir') ? { cwd: value('workdir') } : {}) };
  if (name === 'read') return { type: 'read', filePath: value('filePath') };
  if (name === 'edit' || name === 'multiedit') return { type: 'edit', filePath: value('filePath') };
  if (name === 'write') return { type: 'write', filePath: value('filePath') };
  if (name === 'grep' || name === 'glob' || name === 'websearch') return { type: 'search', query: value('pattern') || value('query') };
  if (name === 'webfetch') return { type: 'fetch', url: value('url') };
  return { type: 'other', description: name };
}
export function usage(messages: NativeMessage[]): AgentUsage {
  const latest = [...messages].reverse().find(({ info }) => info.role === 'assistant')?.info;
  if (latest?.role !== 'assistant') return {};
  // Native token counts describe one model step. A bounded history window cannot establish session cost.
  return { inputTokens: latest.tokens?.input ?? 0, cachedInputTokens: latest.tokens?.cache?.read ?? 0, outputTokens: (latest.tokens?.output ?? 0) + (latest.tokens?.reasoning ?? 0) };
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
      if (part.type === 'reasoning' && part.text) add(key, { type: 'reasoning', text: part.text });
      if (part.type === 'compaction') add(key, { type: 'compaction', status: info.time.completed ? 'completed' : 'loading', trigger: part.auto ? 'auto' : 'manual' });
      if (part.type === 'tool') {
        const state = part.state;
        const base = { type: 'tool_call' as const, callId: part.callID, name: part.tool, detail: toolDetail(part.tool, state.input), ...('output' in state ? { result: boundToolResult({ content: [{ type: 'text', text: state.output }], durationMs: state.time.end - state.time.start }) } : {}) };
        add(key, state.status === 'error' ? { ...base, status: 'failed', error: state.error } : { ...base, status: state.status === 'completed' ? 'completed' : 'running', error: null });
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

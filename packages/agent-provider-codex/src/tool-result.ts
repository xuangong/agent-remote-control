import { boundToolResult, fileChangesResult, type AgentFileChange, type AgentToolResult, type AgentToolResultContent, type AgentToolResultJson } from '@borgee/agent-provider-sdk';
import { isRecord, type JsonObject } from './native.js';

export function codexToolResult(item: JsonObject): AgentToolResult | undefined {
  if (item.type === 'commandExecution') {
    const content: AgentToolResultContent[] = typeof item.aggregatedOutput === 'string'
      ? [{ type: 'text', stream: 'combined', text: item.aggregatedOutput }] : [];
    const exitCode = typeof item.exitCode === 'number' && Number.isSafeInteger(item.exitCode) ? item.exitCode : undefined;
    const durationMs = typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) && item.durationMs >= 0 ? item.durationMs : undefined;
    if (!content.length && exitCode === undefined && durationMs === undefined) return undefined;
    return boundToolResult({ content, ...(exitCode === undefined ? {} : { exitCode }), ...(durationMs === undefined ? {} : { durationMs }) });
  }
  if (item.type === 'fileChange' && Array.isArray(item.changes)) {
    const changes = item.changes.map(normalizeFileChange);
    if (changes.every((change): change is AgentFileChange => change !== undefined)) return fileChangesResult(changes);
    return boundToolResult({ content: [{ type: 'json', value: item.changes as AgentToolResultJson }] });
  }
  if (item.type === 'mcpToolCall') {
    const result = item.result;
    const content: AgentToolResultContent[] = [];
    if (isRecord(result)) {
      if (Array.isArray(result.content)) content.push(...result.content.map(contentBlock));
      if (result.structuredContent !== undefined) content.push({ type: 'json', value: result.structuredContent as AgentToolResultJson });
      if (!content.length) content.push({ type: 'json', value: result as AgentToolResultJson });
    } else if (result !== undefined && result !== null) content.push(contentBlock(result));
    if (item.error !== undefined && item.error !== null) content.push({ type: 'json', value: item.error as AgentToolResultJson });
    return content.length ? boundToolResult({ content }) : undefined;
  }
  if (item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity') {
    const names = item.type === 'collabAgentToolCall' ? ['receiverThreadIds', 'agentsStates'] : ['kind', 'agentThreadId', 'agentPath'];
    const value = Object.fromEntries(names.filter((key) => item[key] !== undefined).map((key) => [key, item[key]])) as AgentToolResultJson;
    return boundToolResult({ content: [{ type: 'json', value }] });
  }
  if (item.type === 'webSearch') {
    const value: Record<string, AgentToolResultJson> = {};
    if (item.action !== undefined && item.action !== null) value.action = item.action as AgentToolResultJson;
    if (item.results !== undefined && item.results !== null) value.results = item.results as AgentToolResultJson;
    return Object.keys(value).length ? boundToolResult({ content: [{ type: 'json', value }] }) : undefined;
  }
  return undefined;
}

function normalizeFileChange(value: unknown): AgentFileChange | undefined {
  if (!isRecord(value) || typeof value.path !== 'string' || !value.path || typeof value.diff !== 'string') return undefined;
  const nativeKind = isRecord(value.kind) ? value.kind.type : value.kind;
  const destination = isRecord(value.kind) && typeof value.kind.move_path === 'string' && value.kind.move_path
    ? value.kind.move_path : undefined;
  if (nativeKind === 'update' && destination) return { path: destination, previousPath: value.path, kind: 'renamed', diff: value.diff };
  return { path: value.path, diff: value.diff, kind: nativeKind === 'add' ? 'added'
    : nativeKind === 'delete' ? 'deleted' : nativeKind === 'update' ? 'modified' : 'unknown' };
}

function contentBlock(value: unknown): AgentToolResultContent {
  if (isRecord(value) && value.type === 'text' && typeof value.text === 'string') return { type: 'text', text: value.text };
  return { type: 'json', value: value as AgentToolResultJson };
}

import { boundToolResult, type AgentToolResult, type AgentToolResultContent, type AgentToolResultJson } from '@orchardworks/agent-provider-sdk';
import { isRecord, type NativeRecord } from './native.js';

export function dshToolResult(data: NativeRecord): AgentToolResult | undefined {
  const message = isRecord(data.message) ? data.message : undefined;
  const content: AgentToolResultContent[] = [];
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    const values = isRecord(block) && Array.isArray(block.content) ? block.content : [block];
    for (const value of values) {
      if (isRecord(value) && value.type === 'text' && typeof value.text === 'string') content.push({ type: 'text', text: value.text });
      else if (isRecord(value) && value.type === 'json' && value.value !== undefined) content.push({ type: 'json', value: value.value as AgentToolResultJson });
      else content.push({ type: 'json', value: value as AgentToolResultJson });
    }
  }
  if (data.meta !== undefined) content.push({ type: 'json', value: data.meta as AgentToolResultJson });
  return message && Array.isArray(message.content) || content.length ? boundToolResult({ content }) : undefined;
}

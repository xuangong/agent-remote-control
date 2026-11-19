import type { ProviderObservation } from '@orchardworks/agent-provider-sdk';
import type { HistoryEntry } from '../../stack/scripted-provider.js';

/** What a real provider's tool output is bounded to (`TOOL_RESULT_MAX_CHARS`): a scenario that wants megabytes writes many of them. */
export const TOOL_OUTPUT_CHARS = 64 * 1024;

/** A finished shell tool call whose output is `chars` characters of 100-column text, as a history row or a live row. */
export function toolCall(providerId: string, key: string, { command, chars = TOOL_OUTPUT_CHARS, running = false }: { command: string; chars?: number; running?: boolean }): ProviderObservation {
  const line = 'q'.repeat(99) + '\n';
  const text = line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
  return {
    type: 'observation', sourceKey: `tool:${key}:${running ? 'running' : 'done'}`, occurredAt: 1_725_000_000_000, delivery: 'live',
    event: { type: 'timeline', provider: providerId, turnId: 'turn-1', item: running
      ? { type: 'tool_call', callId: key, name: 'bash', detail: { type: 'shell', command }, status: 'running', error: null }
      : { type: 'tool_call', callId: key, name: 'bash', detail: { type: 'shell', command }, status: 'completed', error: null, result: { content: [{ type: 'text', text }], exitCode: 0 } } },
    itemIdentity: running ? { key } : { key, completes: true },
  } as ProviderObservation;
}

/** A history of one question, `calls` finished tool calls with `chars` of output each, and the closing answer. */
export function heavyHistory(providerId: string, id: string, { calls, chars = TOOL_OUTPUT_CHARS, answer }: { calls: number; chars?: number; answer: string }): HistoryEntry[] {
  return [
    { role: 'user', text: `Print ${calls} large outputs.`, key: `${id}:q` },
    ...Array.from({ length: calls }, (_, at) => ({ observation: toolCall(providerId, `${id}:t${at + 1}`, { command: `print-${at + 1}`, chars }) })),
    { role: 'assistant', text: answer, key: `${id}:a` },
  ];
}

import { Value } from '@sinclair/typebox/value';
import { expect, it } from 'vitest';
import { AgentToolCallTimelineItem } from './timeline.js';

const call = { type: 'tool_call', callId: 'command-1', name: 'command', detail: { type: 'shell', command: 'echo hello' }, status: 'completed', error: null };
it('accepts typed command and structured results without weakening the tool contract', () => {
  expect(Value.Check(AgentToolCallTimelineItem, { ...call, result: { content: [{ type: 'text', stream: 'combined', text: 'hello\n' }, { type: 'json', value: { files: ['a.ts'], success: true } }], exitCode: 0, durationMs: 12 } })).toBe(true);
  for (const result of [{ content: [], exitCode: '0' }, { content: [], durationMs: -1 }, { content: [{ type: 'html', text: '<b>x</b>' }] }, { content: [], extra: true }]) {
    expect(Value.Check(AgentToolCallTimelineItem, { ...call, result })).toBe(false);
  }
  expect(Value.Check(AgentToolCallTimelineItem, call)).toBe(true);
});

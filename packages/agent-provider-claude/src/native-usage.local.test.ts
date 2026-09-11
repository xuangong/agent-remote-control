import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { expect, it } from 'vitest';
import { ClaudeAgentSession } from './session.js';
import { nativeFixture, nativeReply } from './test-utils/native-fixture.js';

it('normalizes real structured tool output, cumulative cost, and inline context data', async () => {
  let calls = 0;
  const fixture = await nativeFixture((_body, response) => nativeReply(response, ++calls === 1
    ? [{ type: 'tool_use', id: 'structured-write', name: 'Write', input: { file_path: join(fixture.cwd, 'result.txt'), content: 'NATIVE_RESULT' } }]
    : [{ type: 'text', text: 'USAGE_OK' }]));
  const frames: any[] = [];
  const session = await ClaudeAgentSession.open({ sessionId: randomUUID(), cwd: fixture.cwd, model: 'claude-sonnet-4-5-20250929' }, {
    ...fixture.options, query: (args) => {
      const native = query(args);
      return new Proxy(native, { get(target, key) {
        if (key === Symbol.asyncIterator) return async function* () { for await (const frame of target) { frames.push(frame); yield frame; } };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
  });
  const events: any[] = [];
  const pump = (async () => { for await (const item of session.observe()) if (item.type === 'observation') events.push(item.event); })();
  try {
    await session.setSessionSetting('permissions', 'acceptEdits');
    await session.sendMessage('WRITE_NATIVE_RESULT');
    await expect.poll(() => events.filter((event) => event.type === 'turn_completed').length).toBe(1);
    const nativeTool = frames.find((frame) => frame.type === 'user' && frame.tool_use_result !== undefined);
    expect(nativeTool).toBeDefined();
    expect(events).toContainEqual(expect.objectContaining({ type: 'timeline', item: expect.objectContaining({ callId: 'structured-write',
      result: expect.objectContaining({ content: expect.arrayContaining([{ type: 'json', value: nativeTool.tool_use_result }]) }) }) }));
    await session.sendMessage('SECOND_TURN');
    await expect.poll(() => events.filter((event) => event.type === 'turn_completed').length).toBe(2);
    const results = frames.filter((frame) => frame.type === 'result');
    const completions = events.filter((event) => event.type === 'turn_completed');
    expect(results[1].total_cost_usd).toBeGreaterThan(results[0].total_cost_usd);
    expect(completions[0].usage.totalCostUsd).toBeCloseTo(results[0].total_cost_usd, 10);
    expect(completions[1].usage.totalCostUsd).toBeCloseTo(results[1].total_cost_usd - results[0].total_cost_usd, 10);
    expect(completions[1].usage).toMatchObject({ inputTokens: results[1].usage.input_tokens, outputTokens: results[1].usage.output_tokens });
    expect(completions[1].usage.contextWindowUsedTokens).toBeUndefined();
    await session.sendMessage('/context');
    await expect.poll(() => events.filter((event) => event.type === 'turn_completed').length).toBe(3);
    const nativeContext = frames.find((frame) => frame.context_usage)?.context_usage;
    expect(nativeContext).toBeDefined();
    expect(events.filter((event) => event.type === 'turn_completed')[2].usage).toMatchObject({
      contextWindowUsedTokens: nativeContext.total_tokens, contextWindowMaxTokens: nativeContext.raw_max_tokens,
    });
  } finally { await session.dispose(); await pump; await fixture.close(); }
}, 10000);

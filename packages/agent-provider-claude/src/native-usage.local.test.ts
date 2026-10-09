import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { expect, it } from 'vitest';
import { createClaudeCatalog } from '../dist/catalog.js';
import { ClaudeAgentSession, type ClaudeSessionOptions } from './session.js';
import { nativeFixture, nativeReply } from './test-utils/native-fixture.js';

function recordingQuery(frames: any[]): NonNullable<ClaudeSessionOptions['query']> {
  return (args) => {
    const native = query(args);
    return new Proxy(native, { get(target, key) {
      if (key === Symbol.asyncIterator) return async function* () { for await (const frame of target) { frames.push(frame); yield frame; } };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
}

it('normalizes real structured tool output, cumulative cost, and inline context data', async () => {
  let calls = 0;
  const fixture = await nativeFixture((_body, response) => nativeReply(response, ++calls === 1
    ? [{ type: 'tool_use', id: 'structured-write', name: 'Write', input: { file_path: join(fixture.cwd, 'result.txt'), content: 'NATIVE_RESULT' } }]
    : [{ type: 'text', text: 'USAGE_OK' }]));
  const frames: any[] = [];
  const session = await ClaudeAgentSession.open({ sessionId: randomUUID(), cwd: fixture.cwd, model: 'claude-sonnet-4-5-20250929' }, {
    ...fixture.options, query: recordingQuery(frames),
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
      result: expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ type: 'json', value: expect.objectContaining({format:'file_changes',files:[expect.objectContaining({path:nativeTool.tool_use_result.filePath,kind:'added',diff:expect.stringContaining('+NATIVE_RESULT')})]}) })]) }) }) }));
    await session.sendMessage('SECOND_TURN');
    await expect.poll(() => events.filter((event) => event.type === 'turn_completed').length).toBe(2);
    const results = frames.filter((frame) => frame.type === 'result');
    const completions = events.filter((event) => event.type === 'turn_completed');
    expect(results[1].total_cost_usd).toBeGreaterThan(results[0].total_cost_usd);
    expect(completions[0].usage.totalCostUsd).toBeCloseTo(results[0].total_cost_usd, 10);
    expect(completions[1].usage.totalCostUsd).toBeCloseTo(results[1].total_cost_usd, 10);
    const totals = Object.values(results[1].modelUsage).reduce((sum: any, value: any) => ({
      inputTokens: sum.inputTokens + value.inputTokens, outputTokens: sum.outputTokens + value.outputTokens,
      cachedInputTokens: sum.cachedInputTokens + value.cacheReadInputTokens,
      cacheCreationInputTokens: sum.cacheCreationInputTokens + value.cacheCreationInputTokens,
    }), { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0 });
    expect(completions[1].usage).toMatchObject({ tokenScope: 'runtime', ...totals });
    expect(completions[1].usage.totalTokens).toBe(Object.values(totals).reduce((sum: number, value: any) => sum + value, 0));
    expect(completions[1].usage.inputTokens).toBeGreaterThan(results[1].usage.input_tokens);
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

it('starts real resumed query accounting fresh and preserves its cumulative totals on an API error', async () => {
  let failRequest = false;
  const fixture = await nativeFixture((_body, response) => {
    if (!failRequest) { nativeReply(response, [{ type: 'text', text: 'RESUME_OK' }]); return; }
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'NATIVE_USAGE_FAILURE' } }));
  });
  const frames: any[] = [], events: any[] = [];
  const config = { sessionId: randomUUID(), cwd: fixture.cwd, model: 'claude-sonnet-4-5-20250929' };
  const options = { ...fixture.options, query: recordingQuery(frames), catalog: createClaudeCatalog(fixture.options.env, 5000) };
  let session = await ClaudeAgentSession.open({ ...config }, options);
  const observe = async () => { for await (const item of session.observe()) if (item.type === 'observation') events.push(item.event); };
  let pump = observe();
  try {
    await session.sendMessage('FIRST');
    await expect.poll(() => events.filter((event) => event.type === 'turn_completed').length).toBe(1);
    await session.sendMessage('SECOND');
    await expect.poll(() => events.filter((event) => event.type === 'turn_completed').length).toBe(2);
    expect(events.filter((event) => event.type === 'turn_completed').at(-1).usage).toMatchObject({ tokenScope: 'runtime', totalTokens: 30 });
    await session.dispose(); await pump;
    frames.length = 0; events.length = 0;
    session = await ClaudeAgentSession.open({ ...config }, options, [], true);
    pump = observe();
    expect(events.some((event) => event.type === 'usage_updated')).toBe(false);
    await session.sendMessage('RESUMED_QUERY');
    await expect.poll(() => events.filter((event) => event.type === 'turn_completed').length).toBe(1);
    const resumed = events.find((event) => event.type === 'turn_completed').usage;
    expect(resumed).toMatchObject({ tokenScope: 'runtime', inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(resumed.totalCostUsd).toBe(frames.find((frame) => frame.type === 'result').total_cost_usd);
    failRequest = true;
    await session.sendMessage('FAIL_WITHOUT_USAGE');
    await expect.poll(() => events.some((event) => event.type === 'turn_failed')).toBe(true);
    expect(frames.filter((frame) => frame.type === 'result').at(-1)).toMatchObject({ is_error: true, total_cost_usd: resumed.totalCostUsd });
    expect(events.filter((event) => event.type === 'usage_updated').at(-1).usage).toMatchObject(resumed);
  } finally { await session.dispose(); await pump; await fixture.close(); }
}, 15000);

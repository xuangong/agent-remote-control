import { randomUUID } from 'node:crypto';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { expect, it } from 'vitest';
import { Channel } from './channel.js';
import { nativeFixture, nativeReply } from './test-utils/native-fixture.js';
import { ClaudeUsage } from './usage.js';

it('uses the native clear boundary for fresh query totals', async () => {
  const fixture = await nativeFixture((_body, response) => nativeReply(response, [{ type: 'text', text: 'RESET_OK' }]));
  const input = new Channel<SDKUserMessage>();
  let sessionId = randomUUID();
  const frames: any[] = [];
  const native = query({ prompt: input, options: { sessionId, cwd: fixture.cwd, model: 'claude-sonnet-4-5-20250929',
    pathToClaudeCodeExecutable: fixture.options.executable, env: { ...process.env, ...fixture.options.env },
    persistSession: true, settingSources: [], systemPrompt: 'Respond briefly.', permissionMode: 'dontAsk' } });
  const pump = (async () => { for await (const frame of native) frames.push(frame); })();
  const send = async (content: string) => {
    const count = frames.filter((frame) => frame.type === 'result').length;
    input.push({ type: 'user', uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null, message: { role: 'user', content } });
    await expect.poll(() => frames.filter((frame) => frame.type === 'result').length, { timeout: 5000 }).toBe(count + 1);
    return frames.filter((frame) => frame.type === 'result').at(-1);
  };
  try {
    await native.initializationResult();
    await send('FIRST');
    const second = await send('SECOND');
    const cleared = await send('/clear');
    const reset = frames.find((frame) => frame.type === 'conversation_reset');
    expect(reset).toMatchObject({ session_id: sessionId });
    expect(cleared.session_id).not.toBe(sessionId);
    sessionId = cleared.session_id;
    const after = await send('AFTER_CLEAR');
    expect(cleared.modelUsage).toEqual({});
    expect(cleared.total_cost_usd).toBe(0);
    expect(after.total_cost_usd).toBeLessThan(second.total_cost_usd);
    const usage = new ClaudeUsage();
    expect(usage.result(second, undefined)).toMatchObject({ tokenScope: 'runtime', totalTokens: 30 });
    expect(usage.result(cleared, undefined)).toMatchObject({ tokenScope: 'runtime', totalTokens: 0, totalCostUsd: 0 });
    expect(usage.result(after, undefined)).toMatchObject({ tokenScope: 'runtime', totalTokens: 15 });
  } finally { input.close(); native.close(); await pump; await fixture.close(); }
}, 15000);

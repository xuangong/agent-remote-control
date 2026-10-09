import {expect, it} from 'vitest';
import type {ServerResponse} from 'node:http';
import {join} from 'node:path';
import {CopilotAgentProvider} from '../src/provider.js';
import {fixture, observe, waitFor, type ModelRequest} from './native-fixture.js';

function replyWithUsage(body: ModelRequest, res: ServerResponse, index: number) {
  const chunk = (delta: unknown, finish_reason: string | null = null) => ({id: `usage-${index}`, object: 'chat.completion.chunk', model: body.model, choices: [{index: 0, delta, finish_reason}]});
  const usage = index === 1
    ? {prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, prompt_tokens_details: {cached_tokens: 8}}
    : {prompt_tokens: 20, completion_tokens: 7, total_tokens: 27, prompt_tokens_details: {cached_tokens: 9}};
  res.writeHead(200, {'content-type': 'text/event-stream'});
  res.end([chunk({role: 'assistant', content: `USAGE_REPLY_${index}`}), {...chunk({}, 'stop'), usage}].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n');
}

it('reads native session totals across turns and saved resume without counting cache tokens twice', async () => {
  const f = await fixture(replyWithUsage);
  try {
    const session = await f.provider.createSession({sessionId: 'usage', cwd: f.cwd, model: 'gpt-4.1'});
    const seen = observe(session);
    await session.sendMessage('FIRST_USAGE');
    await waitFor(() => seen.events().some(event => event.type === 'turn_completed' || event.type === 'turn_failed'));
    expect(seen.events().filter(event => event.type === 'turn_completed')).toHaveLength(1);
    await session.sendMessage('SECOND_USAGE');
    await waitFor(() => seen.events().filter(event => event.type === 'turn_completed').length === 2);
    const native = await session.rpc.usage.getMetrics();
    expect(native.modelMetrics['gpt-4.1']?.usage).toMatchObject({inputTokens: 32, outputTokens: 12, cacheReadTokens: 17, cacheWriteTokens: 0});
    const context = await session.rpc.metadata.contextInfo({promptTokenLimit: 0, outputTokenLimit: 0});
    expect(context.contextInfo?.totalTokens).toBeGreaterThan(0);
    expect(context.contextInfo?.promptTokenLimit).toBeGreaterThan(0);
    await waitFor(() => seen.events().some(event => event.type === 'usage_updated' && event.usage.tokenScope === 'session' && event.usage.totalTokens === 44));
    expect(seen.events().filter(event => event.type === 'usage_updated' && event.usage.tokenScope === 'session').at(-1)).toMatchObject({
      usage: {tokenScope: 'session', inputTokens: 15, outputTokens: 12, cachedInputTokens: 17, cacheCreationInputTokens: 0, totalTokens: 44},
    });
    const handle = (await session.runtimeInfo()).persistence!;
    await session.dispose(); await seen.done;
    const resumed = await f.provider.resumeSession(handle);
    const history = observe(resumed);
    await waitFor(() => history.events().some(event => event.type === 'usage_updated' && event.usage.tokenScope === 'session' && event.usage.totalTokens === 44));
    expect(f.requests).toHaveLength(2);
    await resumed.dispose(); await history.done;
    await f.provider.dispose();
    const restarted = new CopilotAgentProvider({useLoggedInUser: false, requestTimeoutMs: 5000, env: {COPILOT_HOME: join(f.home, 'profile'), GITHUB_TOKEN: undefined, GH_TOKEN: undefined, COPILOT_GITHUB_TOKEN: undefined}, nativeSessionConfig: {provider: {type: 'openai', baseUrl: f.baseUrl, wireApi: 'completions'}}});
    try {
      const restored = await restarted.resumeSession(handle); const restoredHistory = observe(restored);
      await waitFor(() => restoredHistory.events().some(event => event.type === 'usage_updated' && event.usage.tokenScope === 'session' && event.usage.totalTokens === 44));
      expect(f.requests).toHaveLength(2);
      await restored.dispose(); await restoredHistory.done;
    } finally {await restarted.dispose();}
  } finally {await f.close();}
}, 45000);

it('normalizes native cache writes without adding them twice to the session total', async () => {
  const f = await fixture((body, res) => {
    const events = [
      {type: 'message_start', message: {id: 'usage-message', type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: {input_tokens: 2, cache_read_input_tokens: 8, cache_creation_input_tokens: 2, output_tokens: 0}}},
      {type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}},
      {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'CACHE_REPLY'}},
      {type: 'content_block_stop', index: 0},
      {type: 'message_delta', delta: {stop_reason: 'end_turn', stop_sequence: null}, usage: {output_tokens: 5}},
      {type: 'message_stop'},
    ];
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  }, undefined, 'anthropic');
  try {
    const session = await f.provider.createSession({sessionId: 'usage-cache-write', cwd: f.cwd, model: 'claude-sonnet-4.5'}); const seen = observe(session);
    await session.sendMessage('CACHE_USAGE');
    await waitFor(() => seen.events().some(event => event.type === 'turn_completed'));
    expect((await session.rpc.usage.getMetrics()).modelMetrics['claude-sonnet-4.5']?.usage).toMatchObject({inputTokens: 12, outputTokens: 5, cacheReadTokens: 8, cacheWriteTokens: 2});
    await waitFor(() => seen.events().some(event => event.type === 'usage_updated' && event.usage.tokenScope === 'session' && event.usage.totalTokens === 17));
    expect(seen.events().filter(event => event.type === 'usage_updated' && event.usage.tokenScope === 'session').at(-1)).toMatchObject({usage: {inputTokens: 2, outputTokens: 5, cachedInputTokens: 8, cacheCreationInputTokens: 2, totalTokens: 17}});
    expect(f.errors).toEqual([]);
    await session.dispose(); await seen.done;
  } finally {await f.close();}
}, 45000);

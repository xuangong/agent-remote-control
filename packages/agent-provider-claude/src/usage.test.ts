import { expect, it } from 'vitest';
import { ClaudeUsage } from './usage.js';

it('differences cumulative Query cost while preserving per-turn main-loop token usage', () => {
  const usage = new ClaudeUsage();
  expect(usage.result({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 }, total_cost_usd: 0.25 }, 'root')).toEqual({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, totalCostUsd: 0.25 });
  expect(usage.result({ usage: { input_tokens: 3, output_tokens: 1 }, total_cost_usd: 0.5,
    modelUsage: { root: { inputTokens: 500, outputTokens: 200, contextWindow: 200000 }, child: { contextWindow: 1000000 } } }, 'root')).toEqual({ inputTokens: 3, outputTokens: 1, totalCostUsd: 0.25, contextWindowMaxTokens: 200000 });
});

it('handles cost resets and gaps without charging another turn or a zeroed error twice', () => {
  const usage = new ClaudeUsage();
  usage.result({ total_cost_usd: 2 }, 'root');
  expect(usage.result({ is_error: true, total_cost_usd: 0 }, 'root')).toEqual({});
  expect(usage.result({ total_cost_usd: 3 }, 'root')).toEqual({ totalCostUsd: 1 });
  expect(usage.result({ total_cost_usd: 0.5 }, 'root')).toEqual({ totalCostUsd: 0.5 });
  expect(usage.result({}, 'root')).toEqual({});
  expect(usage.result({ total_cost_usd: 1 }, 'root')).toEqual({});
  expect(usage.result({ total_cost_usd: 1.5 }, 'root')).toEqual({ totalCostUsd: 0.5 });
});

it('uses only exact model context capacity and never infers used context from cumulative model usage', () => {
  const usage = new ClaudeUsage();
  expect(usage.result({ modelUsage: { child: { contextWindow: 1000000, inputTokens: 90 } } }, 'root')).toEqual({});
  expect(usage.result({ modelUsage: { child: { contextWindow: 1000000 } } }, undefined)).toEqual({});
  expect(usage.result({ usage: { input_tokens: -1, output_tokens: Infinity, cache_read_input_tokens: 0.5 }, total_cost_usd: NaN,
    modelUsage: { root: { contextWindow: 0 } } }, 'root')).toEqual({});
});

it('preserves native inline context estimates only within their matching root turn', () => {
  const usage = new ClaudeUsage();
  expect(usage.observe({ type: 'assistant', uuid: 'context', context_usage: { model: 'root', total_tokens: 210000, raw_max_tokens: 200000 } }, 'root')).toEqual({ contextWindowUsedTokens: 210000, contextWindowMaxTokens: 200000 });
  expect(usage.observe({ type: 'assistant', uuid: 'context', context_usage: { model: 'root', total_tokens: 210000, raw_max_tokens: 200000 } }, 'root')).toBeUndefined();
  expect(usage.result({ usage: { input_tokens: 5 } }, 'root')).toEqual({ inputTokens: 5, contextWindowUsedTokens: 210000, contextWindowMaxTokens: 200000 });
  usage.startTurn();
  expect(usage.result({}, 'root')).toEqual({});
  expect(usage.observe({ type: 'assistant', context_usage: { model: 'child', total_tokens: 1, raw_max_tokens: 100 } }, 'root')).toBeUndefined();
});

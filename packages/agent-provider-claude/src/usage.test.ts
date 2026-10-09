import { expect, it } from 'vitest';
import { ClaudeUsage } from './usage.js';

const model = (inputTokens: number, outputTokens: number, cacheReadInputTokens = 0, cacheCreationInputTokens = 0) =>
  ({ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens });

it('replaces cumulative query accounting with the latest totals across every model', () => {
  const usage = new ClaudeUsage();
  expect(usage.result({ usage: { input_tokens: 900, output_tokens: 800 }, total_cost_usd: 0.25,
    modelUsage: { root: model(10, 5, 2, 3), child: model(4, 2, 1, 2) } }, 'root')).toEqual({
    tokenScope: 'runtime', inputTokens: 14, outputTokens: 7, cachedInputTokens: 3, cacheCreationInputTokens: 5, totalTokens: 29, totalCostUsd: 0.25,
  });
  usage.startTurn();
  const latest = { usage: { input_tokens: 3, output_tokens: 1 }, total_cost_usd: 0.5,
    modelUsage: { root: model(30, 12, 8, 4), child: model(9, 3, 2, 5) } };
  const expected = { tokenScope: 'runtime', inputTokens: 39, outputTokens: 15, cachedInputTokens: 10, cacheCreationInputTokens: 9, totalTokens: 73, totalCostUsd: 0.5 };
  expect(usage.result(latest, 'root')).toEqual(expected);
  expect(usage.result(latest, 'root')).toEqual(expected);
});

it('does not mistake failed zeroed or regressed accounting for a runtime reset', () => {
  const usage = new ClaudeUsage();
  expect(usage.result({ is_error: true, modelUsage: { root: model(0, 0) }, total_cost_usd: 0 }, 'root')).toEqual({});
  usage.result({ modelUsage: { root: model(10, 5) }, total_cost_usd: 2 }, 'root');
  expect(usage.result({ is_error: true, modelUsage: {}, total_cost_usd: 0 }, 'root')).toEqual({});
  expect(usage.result({ subtype: 'error_during_execution', modelUsage: { root: model(1, 1) }, total_cost_usd: 0.5 }, 'root')).toEqual({});
  expect(usage.result({ is_error: true, modelUsage: { root: model(15, 6) }, total_cost_usd: 3 }, 'root')).toMatchObject({ totalTokens: 21, totalCostUsd: 3 });
  expect(usage.result({ modelUsage: { root: model(2, 1) }, total_cost_usd: 0.5 }, 'root')).toMatchObject({ totalTokens: 3, totalCostUsd: 0.5 });
});

it('does not infer runtime totals from per-turn usage or context metadata', () => {
  const usage = new ClaudeUsage();
  expect(usage.result({ usage: { input_tokens: 10, output_tokens: 5 } }, 'root')).toEqual({});
  expect(usage.result({ modelUsage: { root: { contextWindow: 200000 } } }, 'root')).toEqual({});
  expect(usage.result({ modelUsage: { child: { contextWindow: 1000000 } } }, undefined)).toEqual({});
  expect(usage.result({ modelUsage: null }, 'root')).toEqual({});
});

it('uses each native cumulative cost directly even after missing or invalid cost snapshots', () => {
  const usage = new ClaudeUsage();
  expect(usage.result({ total_cost_usd: 2 }, 'root')).toEqual({ totalCostUsd: 2 });
  expect(usage.result({ total_cost_usd: NaN }, 'root')).toEqual({});
  expect(usage.result({}, 'root')).toEqual({});
  expect(usage.result({ is_error: true, total_cost_usd: 0 }, 'root')).toEqual({});
  expect(usage.result({ total_cost_usd: 3 }, 'root')).toEqual({ totalCostUsd: 3 });
  expect(usage.result({ total_cost_usd: 0.5 }, 'root')).toEqual({ totalCostUsd: 0.5 });
});

it('preserves native inline context estimates only within their matching root turn', () => {
  const usage = new ClaudeUsage();
  expect(usage.observe({ type: 'assistant', uuid: 'context', context_usage: { model: 'root', total_tokens: 210000, raw_max_tokens: 200000 } }, 'root')).toEqual({ contextScope: 'current', contextWindowUsedTokens: 210000, contextWindowMaxTokens: 200000 });
  expect(usage.observe({ type: 'assistant', uuid: 'context', context_usage: { model: 'root', total_tokens: 210000, raw_max_tokens: 200000 } }, 'root')).toBeUndefined();
  expect(usage.result({ usage: { input_tokens: 5 } }, 'root')).toEqual({ contextScope: 'current', contextWindowUsedTokens: 210000, contextWindowMaxTokens: 200000 });
  usage.startTurn();
  expect(usage.result({}, 'root')).toEqual({});
  expect(usage.observe({ type: 'assistant', context_usage: { model: 'child', total_tokens: 1, raw_max_tokens: 100 } }, 'root')).toBeUndefined();
});

it('marks a native current-context snapshot independently of token usage and rejects invalid context', () => {
  const usage = new ClaudeUsage();
  for (const context of [
    { model: 'root', total_tokens: -1, raw_max_tokens: 100 },
    { model: 'root', total_tokens: 0, raw_max_tokens: 0 },
    { model: 'root', total_tokens: Number.MAX_SAFE_INTEGER + 1, raw_max_tokens: 100 },
    { model: 'root', raw_max_tokens: 100 },
  ]) {
    expect(usage.observe({ type: 'assistant', context_usage: context }, 'root')).toBeUndefined();
  }
  expect(usage.result({}, 'root')).not.toHaveProperty('contextScope');
  expect(usage.observe({ type: 'assistant', context_usage: { model: 'root', total_tokens: 0, raw_max_tokens: 100 } }, 'root')).toEqual({
    contextScope: 'current', contextWindowUsedTokens: 0, contextWindowMaxTokens: 100,
  });
});

it('keeps each incomplete model bucket unknown and totals only complete non-overlapping buckets', () => {
  const usage = new ClaudeUsage();
  expect(usage.result({ modelUsage: { root: model(3, 2, 7), child: { inputTokens: 1, outputTokens: 4, cacheReadInputTokens: 2 } } }, 'root')).toEqual({
    tokenScope: 'runtime', inputTokens: 4, outputTokens: 6, cachedInputTokens: 9,
  });
  expect(usage.result({ modelUsage: { root: model(3, 2, 7), child: model(1, 4, 2, -1) } }, 'root')).toEqual({
    tokenScope: 'runtime', inputTokens: 4, outputTokens: 6, cachedInputTokens: 9,
  });
  expect(usage.result({ modelUsage: { root: model(Number.MAX_SAFE_INTEGER, 2), child: model(1, 3) } }, 'root')).toEqual({
    tokenScope: 'runtime', outputTokens: 5, cachedInputTokens: 0, cacheCreationInputTokens: 0,
  });
  expect(usage.result({ modelUsage: { root: model(Number.MAX_SAFE_INTEGER, 2) } }, 'root')).not.toHaveProperty('totalTokens');
  expect(usage.result({ modelUsage: { root: model(3, 2), child: null } }, 'root')).toEqual({});
});

it('preserves zero snapshots and starts resumed query accounting from its own native totals', () => {
  const beforeResume = new ClaudeUsage();
  beforeResume.result({ modelUsage: { root: model(100, 50) }, total_cost_usd: 2 }, 'root');
  const resumed = new ClaudeUsage();
  expect(resumed.result({}, 'root')).toEqual({});
  expect(resumed.result({ modelUsage: { root: model(10, 5) }, total_cost_usd: 0.2 }, 'root')).toEqual({
    tokenScope: 'runtime', inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 15, totalCostUsd: 0.2,
  });
  expect(resumed.result({ modelUsage: { root: model(0, 0) }, total_cost_usd: 0 }, 'root')).toEqual({
    tokenScope: 'runtime', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0, totalCostUsd: 0,
  });
});

it('accepts a successful empty native model ledger as a clear reset, without inventing an initial zero', () => {
  const usage = new ClaudeUsage();
  expect(usage.result({}, 'root')).toEqual({});
  expect(usage.result({ modelUsage: {} }, 'root')).toEqual({});
  usage.result({ modelUsage: { root: model(10, 5) }, total_cost_usd: 2 }, 'root');
  expect(usage.result({ subtype: 'success', is_error: false, modelUsage: {}, total_cost_usd: 0 }, 'root')).toEqual({
    tokenScope: 'runtime', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0, totalCostUsd: 0,
  });
  expect(usage.result({ modelUsage: { root: model(2, 1) }, total_cost_usd: 0.5 }, 'root')).toMatchObject({ totalTokens: 3, totalCostUsd: 0.5 });
});

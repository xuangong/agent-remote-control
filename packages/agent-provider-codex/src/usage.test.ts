import { expect, test } from 'vitest';

import { CodexEventProjector } from './projector.js';
import { codexUsage } from './usage.js';

test('normalizes native session counters independently from the latest context snapshot', () => {
  expect(codexUsage({
    total: { inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 10, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 },
    last: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    modelContextWindow: 200_000,
  })).toEqual({
    tokenScope: 'session', inputTokens: 50, cachedInputTokens: 40, cacheCreationInputTokens: 10, outputTokens: 20, totalTokens: 120,
    contextScope: 'current', contextWindowUsedTokens: 12, contextWindowMaxTokens: 200_000,
  });
});

test('accepts zero usage and the native default for older cache write counters', () => {
  expect(codexUsage({ total: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 }, last: { totalTokens: 0 } })).toEqual({
    tokenScope: 'session', inputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0, totalTokens: 0, contextScope: 'current', contextWindowUsedTokens: 0,
  });
});

test('does not infer missing cache reads, totals, or context from other measurements', () => {
  expect(codexUsage({ total: { inputTokens: 100, outputTokens: 20 }, modelContextWindow: 200_000 })).toEqual({
    tokenScope: 'session', cacheCreationInputTokens: 0, outputTokens: 20, contextScope: 'current', contextWindowMaxTokens: 200_000,
  });
  expect(codexUsage({ last: { totalTokens: 10 } })).toEqual({ contextScope: 'current', contextWindowUsedTokens: 10 });
  expect(codexUsage({ modelContextWindow: 200_000 })).toEqual({ contextScope: 'current', contextWindowMaxTokens: 200_000 });
  expect(codexUsage({ last: { totalTokens: -1 }, modelContextWindow: 0 })).toBeNull();
  expect(codexUsage({ total: {} })).toBeNull();
});

test('omits invalid and inconsistent counters instead of clamping or inventing token amounts', () => {
  expect(codexUsage({
    total: { inputTokens: 3, cachedInputTokens: 4, cacheWriteInputTokens: 1, outputTokens: 1.5, totalTokens: Number.MAX_SAFE_INTEGER + 1 },
    last: { totalTokens: Number.NaN }, modelContextWindow: -100,
  })).toEqual({ tokenScope: 'session', cachedInputTokens: 4, cacheCreationInputTokens: 1 });
  expect(codexUsage({ total: { inputTokens: 10, cachedInputTokens: -1, cacheWriteInputTokens: null, outputTokens: Infinity }, modelContextWindow: 0 })).toBeNull();
});

test('projects repeated native notifications as replacement snapshots without accumulating them', () => {
  const projector = new CodexEventProjector('thread-1');
  const params = { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: {
    total: { inputTokens: 7, cachedInputTokens: 2, outputTokens: 3, totalTokens: 10 }, last: { totalTokens: 4 },
  } };
  const first = projector.projectNotification('thread/tokenUsage/updated', params);
  const repeated = projector.projectNotification('thread/tokenUsage/updated', params);
  expect(repeated).toMatchObject({ sourceKey: first?.sourceKey, event: { type: 'usage_updated', usage: {
    tokenScope: 'session', inputTokens: 5, cachedInputTokens: 2, cacheCreationInputTokens: 0, outputTokens: 3, totalTokens: 10, contextScope: 'current', contextWindowUsedTokens: 4,
  } } });
  expect(projector.projectNotification('thread/tokenUsage/updated', {
    ...params, tokenUsage: { ...params.tokenUsage, last: { totalTokens: 2 } },
  })).toMatchObject({ event: { type: 'usage_updated', usage: { totalTokens: 10, contextScope: 'current', contextWindowUsedTokens: 2 } } });
});

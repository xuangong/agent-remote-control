import {expect, it} from 'vitest';
import {copilotSessionUsage} from './usage.js';

it('keeps unknown model categories unknown instead of treating missing values as zero', () => {
  expect(copilotSessionUsage({modelMetrics: {
    a: {usage: {inputTokens: 12, outputTokens: 5, cacheReadTokens: 8, cacheWriteTokens: 2}},
    b: {usage: {inputTokens: 4, outputTokens: 2, cacheReadTokens: 1}},
  }})).toEqual({tokenScope: 'session', outputTokens: 7, cachedInputTokens: 9, totalTokens: 23});
  expect(copilotSessionUsage({modelMetrics: {}, totalUserRequests: 0})).toEqual({tokenScope: 'session', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0});
  expect(copilotSessionUsage({})).toBeUndefined();
  expect(copilotSessionUsage({modelMetrics: {}, totalUserRequests: 3})).toBeUndefined();
}, 10000);

it('rejects unsafe aggregates and does not derive negative uncached input', () => {
  expect(copilotSessionUsage({modelMetrics: {
    a: {usage: {inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 5, cacheReadTokens: 8, cacheWriteTokens: 2}},
    b: {usage: {inputTokens: 4, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0}},
  }})).toEqual({tokenScope: 'session', outputTokens: 7, cachedInputTokens: 9, cacheCreationInputTokens: 2});
  expect(copilotSessionUsage({modelMetrics: {a: {usage: {inputTokens: 2, outputTokens: Infinity, cacheReadTokens: 3, cacheWriteTokens: -1}}}})).toEqual({tokenScope: 'session', cachedInputTokens: 3});
  expect(copilotSessionUsage({modelMetrics: {a: {usage: {inputTokens: -1, outputTokens: Infinity}}}})).toBeUndefined();
}, 10000);

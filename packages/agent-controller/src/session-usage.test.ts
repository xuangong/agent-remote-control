import { expect, it } from 'vitest';
import { accountUsage, type SessionUsage } from './session-usage.js';

it('counts the increase of session totals and starts a new runtime from zero', () => {
  const codex: SessionUsage = { tokens: 0 };
  expect(accountUsage(codex, { tokenScope: 'session', totalTokens: 100 }, false)).toBe(true);
  expect(accountUsage(codex, { tokenScope: 'session', totalTokens: 100 }, true)).toBe(false);
  accountUsage(codex, { tokenScope: 'session', inputTokens: 200, outputTokens: 50 }, false);
  expect(codex).toMatchObject({ tokens: 250 });

  const claude: SessionUsage = { tokens: 0 };
  accountUsage(claude, { tokenScope: 'runtime', totalTokens: 300, totalCostUsd: 0.3 }, false);
  accountUsage(claude, { tokenScope: 'runtime', totalTokens: 500, totalCostUsd: 0.5 }, true);
  // The runtime was released and resumed: its counter started again.
  accountUsage(claude, { tokenScope: 'runtime', totalTokens: 40, totalCostUsd: 0.04 }, false);
  expect(claude.tokens).toBe(540);
  expect(claude.costUsd).toBeCloseTo(0.54);
});

it('adds turn totals on completion and call totals as reported, and ignores context-only reports', () => {
  const turns: SessionUsage = { tokens: 0 };
  expect(accountUsage(turns, { tokenScope: 'turn', totalTokens: 10 }, false)).toBe(false);
  accountUsage(turns, { tokenScope: 'turn', totalTokens: 10 }, true);
  accountUsage(turns, { tokenScope: 'turn', totalTokens: 15 }, true);
  expect(turns.tokens).toBe(25);
  const calls: SessionUsage = { tokens: 0 };
  accountUsage(calls, { tokenScope: 'call', totalTokens: 7 }, false); accountUsage(calls, { tokenScope: 'call', totalTokens: 8 }, false);
  expect(calls.tokens).toBe(15);
  expect(accountUsage(calls, { contextScope: 'current', contextWindowUsedTokens: 1000 }, false)).toBe(false);
});

it('continues from its saved last report after a restart', () => {
  const saved: SessionUsage = JSON.parse(JSON.stringify({ tokens: 500, last: { scope: 'session', tokens: 500 } }));
  accountUsage(saved, { tokenScope: 'session', totalTokens: 650 }, true);
  expect(saved.tokens).toBe(650);
});

it('counts the four parts like the total: the increase of a session report, a runtime restart from zero, and turn totals as they come', () => {
  const session: SessionUsage = { tokens: 0 };
  accountUsage(session, { tokenScope: 'session', inputTokens: 100, cachedInputTokens: 1000, cacheCreationInputTokens: 50, outputTokens: 20, totalTokens: 1170 }, true);
  accountUsage(session, { tokenScope: 'session', inputTokens: 130, cachedInputTokens: 3000, cacheCreationInputTokens: 50, outputTokens: 45, totalTokens: 3225 }, true);
  expect(session.parts).toEqual({ input: 130, cachedInput: 3000, cacheCreation: 50, output: 45 });
  const runtime: SessionUsage = { tokens: 0 };
  accountUsage(runtime, { tokenScope: 'runtime', inputTokens: 100, outputTokens: 10, totalTokens: 110 }, true);
  accountUsage(runtime, { tokenScope: 'runtime', inputTokens: 20, outputTokens: 5, totalTokens: 25 }, true);
  expect(runtime.parts).toEqual({ input: 120, output: 15 });
  const turns: SessionUsage = { tokens: 0 };
  accountUsage(turns, { tokenScope: 'turn', inputTokens: 10, cachedInputTokens: 5, outputTokens: 2 }, true); accountUsage(turns, { tokenScope: 'turn', inputTokens: 10, outputTokens: 3 }, true);
  expect(turns.parts).toEqual({ input: 20, cachedInput: 5, output: 5 });
});

import { expect, it } from 'vitest';
import { accountUsage, type SupportUsage } from './call-for-support-usage.js';

it('counts the increase of session totals and starts a new runtime from zero', () => {
  const codex: SupportUsage = { tokens: 0 };
  expect(accountUsage(codex, { tokenScope: 'session', totalTokens: 100 }, false)).toBe(true);
  expect(accountUsage(codex, { tokenScope: 'session', totalTokens: 100 }, true)).toBe(false);
  accountUsage(codex, { tokenScope: 'session', inputTokens: 200, outputTokens: 50 }, false);
  expect(codex).toMatchObject({ tokens: 250 });

  const claude: SupportUsage = { tokens: 0 };
  accountUsage(claude, { tokenScope: 'runtime', totalTokens: 300, totalCostUsd: 0.3 }, false);
  accountUsage(claude, { tokenScope: 'runtime', totalTokens: 500, totalCostUsd: 0.5 }, true);
  // The runtime was released and resumed: its counter started again.
  accountUsage(claude, { tokenScope: 'runtime', totalTokens: 40, totalCostUsd: 0.04 }, false);
  expect(claude.tokens).toBe(540);
  expect(claude.costUsd).toBeCloseTo(0.54);
});

it('adds turn totals on completion and call totals as reported, and ignores context-only reports', () => {
  const turns: SupportUsage = { tokens: 0 };
  expect(accountUsage(turns, { tokenScope: 'turn', totalTokens: 10 }, false)).toBe(false);
  accountUsage(turns, { tokenScope: 'turn', totalTokens: 10 }, true);
  accountUsage(turns, { tokenScope: 'turn', totalTokens: 15 }, true);
  expect(turns.tokens).toBe(25);
  const calls: SupportUsage = { tokens: 0 };
  accountUsage(calls, { tokenScope: 'call', totalTokens: 7 }, false); accountUsage(calls, { tokenScope: 'call', totalTokens: 8 }, false);
  expect(calls.tokens).toBe(15);
  expect(accountUsage(calls, { contextScope: 'current', contextWindowUsedTokens: 1000 }, false)).toBe(false);
});

it('continues from its saved last report after a restart', () => {
  const saved: SupportUsage = JSON.parse(JSON.stringify({ tokens: 500, last: { scope: 'session', tokens: 500 } }));
  accountUsage(saved, { tokenScope: 'session', totalTokens: 650 }, true);
  expect(saved.tokens).toBe(650);
});

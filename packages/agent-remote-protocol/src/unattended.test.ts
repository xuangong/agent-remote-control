import { describe, expect, it } from 'vitest';
import { dayKey, estimateCost, isUnattendedState, priceOf, SHIPPED_DEFAULT_PRICE } from './unattended.js';

describe('the price of a model', () => {
  it('finds the shipped row by the model id, the dearer Opus generation apart from the cheaper', () => {
    expect(priceOf('claude-opus-4-5').rates).toMatchObject({ input: 5, output: 25 });
    expect(priceOf('claude-opus-4-1').rates).toMatchObject({ input: 15, output: 75 });
    expect(priceOf('sonnet').rates).toMatchObject({ input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 });
    expect(priceOf('claude-haiku-4-5').rates).toMatchObject({ input: 1, output: 5 });
    expect(priceOf('gpt-5.1-codex-mini').rates).toMatchObject({ input: 0.25 });
    expect(priceOf('gpt-5.1-codex').rates).toMatchObject({ input: 1.25, cacheWrite: 1.25 });
  });
  it('lets the person\'s row for the exact id win, and prices an unknown model at the default, flagged', () => {
    const prices = { 'claude-sonnet-4-5': { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 } };
    expect(priceOf('claude-sonnet-4-5', { prices })).toEqual({ rates: prices['claude-sonnet-4-5'], source: 'person' });
    expect(priceOf('my-local-model')).toEqual({ rates: SHIPPED_DEFAULT_PRICE, source: 'default' });
    expect(priceOf(undefined).source).toBe('default');
    expect(priceOf('my-local-model', { defaultPrice: { input: 2, cacheWrite: 2, cacheRead: 2, output: 2 } }).rates.input).toBe(2);
  });
});

describe('the estimated cost of a turn', () => {
  it('prices the four parts each at its own rate', () => {
    // Sonnet: 1M input at 3, 1M cache writes at 3.75, 1M cache reads at 0.30, 1M output at 15.
    expect(estimateCost({ model: 'sonnet', input: 1e6, cacheCreation: 1e6, cachedInput: 1e6, output: 1e6 }, undefined)).toEqual({ usd: 3 + 3.75 + 0.3 + 15, tokens: 4e6, flags: [] });
    expect(estimateCost({ model: 'sonnet', input: 1000, cachedInput: 200_000, cacheCreation: 0, output: 500 }, undefined).usd).toBeCloseTo((1000 * 3 + 200_000 * 0.3 + 500 * 15) / 1e6, 10);
  });
  it('prices a write as input and flags it when the provider reports none for a model that charges more for them', () => {
    expect(estimateCost({ model: 'sonnet', input: 1e6, cachedInput: 0, output: 0 }, undefined).flags).toEqual(['cache writes not reported']);
    // A model without a write premium has nothing to flag.
    expect(estimateCost({ model: 'gpt-5-codex', input: 1e6, cachedInput: 1e6, output: 0 }, undefined).flags).toEqual([]);
  });
  it('prices a total alone as input, and a turn with no usage as nothing, each flagged', () => {
    expect(estimateCost({ model: 'sonnet' }, 2e6)).toEqual({ usd: 6, tokens: 2e6, flags: ['no breakdown'] });
    expect(estimateCost(undefined, 0)).toEqual({ usd: 15 * 0, tokens: 0, flags: ['price unknown', 'no usage reported'] });
    expect(estimateCost({ model: 'mystery', input: 1e6 }, undefined).flags).toEqual(['price unknown', 'cache writes not reported']);
  });
});

describe('the ledger day', () => {
  it('is the local date of the zone, which moves with the zone and not with UTC', () => {
    const instant = Date.parse('2026-11-30T20:00:00Z');
    expect(dayKey(instant, 'UTC')).toBe('2026-11-30');
    expect(dayKey(instant, 'Asia/Tokyo')).toBe('2026-12-01');
    expect(dayKey(instant, 'America/Los_Angeles')).toBe('2026-11-30');
  });
  it('validates the state the Relay saves', () => {
    expect(isUnattendedState({ settings: { timeZone: 'UTC', budget: { perDay: 5 } }, ledger: { '2026-11-30': { b_1: { usd: 1, tokens: 10, turns: 1, runs: 1 } } }, limits: { 'h/claude': { at: 1, resetsAt: 2 } } })).toBe(true);
    expect(isUnattendedState({ settings: {}, ledger: { today: {} }, limits: {} })).toBe(false);
    expect(isUnattendedState({ settings: { budget: { perDay: -1 } }, ledger: {}, limits: {} })).toBe(false);
  });
});

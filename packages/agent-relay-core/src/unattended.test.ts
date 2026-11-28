import { describe, expect, it } from 'vitest';
import type { Routine } from '@orchardworks/agent-remote-protocol';
import { Unattended, memoryUnattended, RUNS_PER_DAY_BOUND } from './unattended.js';

// The account's unattended work with an injected clock and an in-memory store.
const routine = { id: 'r', name: 'Check', schedule: { kind: 'every', minutes: 10 }, by: 'bot', anchor: 0, runCount: 0, runs: [] } as Routine;
const turn = (usd: number) => ({ usd, tokens: 1000, flags: [] as string[] });
const DAY = 24 * 3_600_000;
const T0 = Date.parse('2026-11-30T10:00:00Z');
function fixture(start = T0) {
  let now = start;
  const store = memoryUnattended(), account = new Unattended(store, () => now);
  return { account, store, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe('the check before an unattended start', () => {
  it('allows a start with nothing set, and refuses in the documented order: account pause, bot pause, absence, provider limit, cost, runs', async () => {
    const f = fixture(), bot = 'b_1', provider = 'mac/claude';
    expect(f.account.refuse(bot, provider, routine, f.now())).toBeUndefined();
    await f.account.setLimit(provider);
    await f.account.patch({ budget: { perDay: 1 }, bots: { [bot]: { paused: true } }, paused: true });
    await f.account.record(bot, turn(2));
    expect(f.account.refuse(bot, provider, routine, f.now())).toBe('paused');
    await f.account.patch({ paused: false });
    expect(f.account.refuse(bot, provider, routine, f.now())).toBe('bot paused');
    await f.account.patch({ bots: { [bot]: { paused: false } } });
    expect(f.account.refuse(bot, provider, routine, f.now())).toBe('provider limit');
    await f.account.setLimit(provider, f.now() - 1);
    expect(f.account.refuse(bot, provider, routine, f.now())).toBe('budget');
  });
  it('pauses by itself after the person has been away longer than the absence days, and not before', async () => {
    const f = fixture();
    await f.account.patch({ absenceDays: 2 }); await f.account.touch();
    f.advance(2 * DAY);
    expect(f.account.refuse('b_1', 'mac/claude', routine, f.now())).toBeUndefined();
    f.advance(1000);
    expect(f.account.refuse('b_1', 'mac/claude', routine, f.now())).toBe('absence');
    expect(f.account.view().absent).toBe(true);
    await f.account.patch({ absenceDays: 0 });
    expect(f.account.refuse('b_1', 'mac/claude', routine, f.now())).toBeUndefined();
  });
  it('counts runs against the system bound and a bot\'s own limit', async () => {
    const f = fixture();
    for (let run = 0; run < RUNS_PER_DAY_BOUND; run++) await f.account.countRun('b_1');
    expect(f.account.refuse('b_2', 'mac/claude', routine, f.now())).toBe('daily limit');
    const g = fixture();
    await g.account.patch({ bots: { b_1: { budget: { runsPerDay: 2 } } } });
    await g.account.countRun('b_1'); await g.account.countRun('b_1');
    expect(g.account.refuse('b_1', 'mac/claude', routine, g.now())).toBe('daily limit');
    expect(g.account.refuse('b_2', 'mac/claude', routine, g.now())).toBeUndefined();
  });
});

describe('the budget in estimated cost', () => {
  it('trips a bot\'s cap with that bot\'s usage and the account\'s with everyone\'s, and the day ends it while the month keeps it', async () => {
    const f = fixture(Date.parse('2026-11-15T10:00:00Z'));
    await f.account.patch({ budget: { perDay: 5, perMonth: 8 }, bots: { b_1: { budget: { perDay: 1 } } } });
    await f.account.record('b_1', turn(0.6)); await f.account.record('b_2', turn(2));
    expect(f.account.tripped()).toEqual([]);
    await f.account.record('b_1', turn(0.5));
    expect(f.account.tripped()).toEqual([{ scope: 'b_1', period: 'day' }]);
    expect(f.account.refuse('b_1', 'mac/claude', routine, f.now())).toBe('budget');
    expect(f.account.refuse('b_2', 'mac/claude', routine, f.now())).toBeUndefined();
    await f.account.record('b_2', turn(3));
    expect(f.account.tripped()).toContainEqual({ scope: 'account', period: 'day' });
    // The next local day starts clean; the month still holds what was spent.
    f.advance(DAY);
    expect(f.account.tripped()).toEqual([]);
    await f.account.record('b_2', turn(2));
    expect(f.account.tripped()).toEqual([{ scope: 'account', period: 'month' }]);
  });
  it('reads the day in the person\'s zone: late evening UTC is the next morning in Tokyo', async () => {
    const f = fixture();
    await f.account.patch({ timeZone: 'Asia/Tokyo', budget: { perDay: 1 } });
    f.advance(11 * 3_600_000);
    await f.account.record('b_1', turn(2));
    expect(f.account.view().day).toBe('2026-12-01');
    f.advance(2 * 3_600_000);
    expect(f.account.view().day).toBe('2026-12-01');
    expect(f.account.tripped()).toEqual([{ scope: 'account', period: 'day' }]);
    f.advance(17 * 3_600_000);
    expect(f.account.view().day).toBe('2026-12-02');
    expect(f.account.tripped()).toEqual([]);
  });
  it('raises today\'s cap by what the person allows and keeps the month\'s; keeps 62 days of usage; lists models priced by the default', async () => {
    const f = fixture();
    await f.account.patch({ budget: { perDay: 1 } });
    await f.account.record('b_1', { usd: 1, tokens: 10, flags: ['price unknown'] }, 'mystery-model');
    expect(f.account.refuse('b_1', 'mac/claude', routine, f.now())).toBe('budget');
    await f.account.patch({ allowMoreToday: 2 });
    expect(f.account.refuse('b_1', 'mac/claude', routine, f.now())).toBeUndefined();
    expect(f.account.view().unpriced).toEqual(['mystery-model']);
    for (let day = 0; day < 70; day++) { f.advance(DAY); await f.account.countRun('b_1'); }
    expect(Object.keys(f.store.read().ledger)).toHaveLength(62);
  });
  it('lets the person edit a model\'s rates and remove them again, and a null budget clears a cap', async () => {
    const f = fixture(), rates = { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 };
    await f.account.patch({ prices: { 'my-model': rates }, budget: { perDay: 3 } });
    expect(f.account.settings().prices).toEqual({ 'my-model': rates });
    await f.account.patch({ prices: { 'my-model': null }, budget: null });
    expect(f.account.settings()).toEqual({});
  });
  it('holds a provider limit until it resets, or for an hour when the CLI gave no reset', async () => {
    const f = fixture();
    await f.account.setLimit('mac/claude', f.now() + 5 * 3_600_000);
    await f.account.setLimit('mac/codex');
    expect(f.account.limited('mac/claude')).toEqual({ resetsAt: f.now() + 5 * 3_600_000 });
    f.advance(3_600_000 + 1);
    expect(f.account.limited('mac/codex')).toBeUndefined();
    expect(f.account.limited('mac/claude')).toBeDefined();
    expect(f.account.view().limits).toEqual([{ provider: 'mac/claude', resetsAt: T0 + 5 * 3_600_000 }]);
  });
});

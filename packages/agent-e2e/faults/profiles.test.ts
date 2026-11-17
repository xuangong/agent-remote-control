import { describe, expect, it } from 'vitest';
import { planManySessions } from './many-sessions.mjs';
import { bigToolOutputPrompt, QUOTA_PROFILES } from './quota.mjs';

describe('quota profiles', () => {
  it('keeps the tiny profiles under the default so they trim, and asks for an exact output size', () => {
    expect(QUOTA_PROFILES.tinySession.sessionBytes).toBeLessThan(QUOTA_PROFILES.default.sessionBytes);
    expect(bigToolOutputPrompt(3)).toContain(`head -c ${3 * 1024 * 1024}`);
    expect(() => bigToolOutputPrompt(0)).toThrow(/positive/);
  });
});

describe('the many-sessions plan', () => {
  it('replays from its seed and gives each provider its share', () => {
    const first = planManySessions({ seed: 9, sessionCount: 30, groupSize: 10, actions: 60 });
    expect(planManySessions({ seed: 9, sessionCount: 30, groupSize: 10, actions: 60 })).toEqual(first);
    expect(planManySessions({ seed: 10, sessionCount: 30, groupSize: 10, actions: 60 }).plan).not.toEqual(first.plan);
    expect(first.sessions.filter(session => session.provider === 'codex')).toHaveLength(10);
    expect(first.group).toHaveLength(10);
  });
  it('only wakes a session that slept and only folds one that is open', () => {
    const { plan } = planManySessions({ seed: 4, sessionCount: 12, groupSize: 5, actions: 300 });
    const state = new Map<string, string>();
    for (const { action, session } of plan) {
      const current = state.get(session) ?? 'closed';
      if (action === 'wake') expect(current).toBe('asleep');
      if (action === 'fold') expect(current).toBe('open');
      state.set(session, action === 'fold' ? 'folded' : action === 'sleep' ? 'asleep' : 'open');
    }
  });
  it('refuses a group larger than the sessions', () => {
    expect(() => planManySessions({ sessionCount: 5, groupSize: 6 })).toThrow(/group/);
  });
});

import { describe, expect, it } from 'vitest';
import type { Routine, RoutineRun } from '@orchardworks/agent-remote-protocol';
import { translator } from './messages.js';
import { costWords, nextRunWords, runWords, scheduleWords, weekdayName } from './routine-words.js';

const en = translator('en'), zh = translator('zh');
const routine = (extra: Partial<Routine> = {}): Routine => ({ id: 'r', name: 'Check', schedule: { kind: 'every', minutes: 15 }, by: 'person', anchor: 0, runCount: 0, runs: [], ...extra });

describe('a schedule in words', () => {
  it('names each form in English and Chinese', () => {
    expect(scheduleWords({ kind: 'quiet', minutes: 30 }, 'UTC', 'en', en)).toBe('After 30 min of quiet');
    expect(scheduleWords({ kind: 'every', minutes: 15 }, 'UTC', 'en', en)).toBe('Every 15 min');
    expect(scheduleWords({ kind: 'every', minutes: 120 }, 'UTC', 'en', en)).toBe('Every 2 h');
    expect(scheduleWords({ kind: 'daily', time: '08:30' }, 'UTC', 'en', en)).toBe('Every day at 08:30');
    expect(scheduleWords({ kind: 'weekdays', days: [5, 1, 2, 3, 4], time: '09:00' }, 'UTC', 'en', en)).toBe('Weekdays at 09:00');
    expect(scheduleWords({ kind: 'weekdays', days: [1, 3], time: '09:00' }, 'UTC', 'en', en)).toBe('Mon, Wed at 09:00');
    expect(scheduleWords({ kind: 'weekdays', days: [1, 3], time: '09:00' }, 'UTC', 'zh', zh)).toBe('周一, 周三 09:00');
    expect(scheduleWords({ kind: 'daily', time: '08:30' }, 'UTC', 'zh', zh)).toBe('每天 08:30');
    expect(scheduleWords({ kind: 'once', at: Date.parse('2026-12-04T09:00:00Z') }, 'Asia/Tokyo', 'en', en)).toContain('Dec 4, 2026');
    expect(scheduleWords({ kind: 'event' }, 'UTC', 'en', en)).toBe('When its webhook is called');
    expect(weekdayName(7, 'en')).toBe('Sun');
  });
});

describe('the next run and the runs in words', () => {
  const now = Date.parse('2026-11-30T10:00:00Z');
  it('shows the time in the person\'s zone, with the day when it is not today, and why there is none when there is none', () => {
    expect(nextRunWords(routine({ dueAt: Date.parse('2026-11-30T10:15:00Z') }), now, 'UTC', 'en', en)).toBe('Next: 10:15');
    expect(nextRunWords(routine({ dueAt: Date.parse('2026-12-01T00:30:00Z') }), now, 'Asia/Tokyo', 'en', en)).toMatch(/^Next: \w+ 09:30$/);
    expect(nextRunWords(routine({ paused: true, dueAt: now }), now, 'UTC', 'en', en)).toBe('Paused');
    expect(nextRunWords(routine({ finished: true }), now, 'UTC', 'en', en)).toBe('Finished');
    expect(nextRunWords(routine({ schedule: { kind: 'event' } }), now, 'UTC', 'en', en)).toBe('Waits for an event');
    expect(nextRunWords(routine({ dueAt: now }), now, 'UTC', 'en', en, 'budget')).toBe('Over budget until the period ends');
    expect(nextRunWords(routine({ dueAt: now }), now, 'UTC', 'en', en, 'provider_limit')).toBe('Waiting for the provider\'s usage limit');
  });
  it('says how a run went, what was skipped and why, how many missed runs it stands for, and what it cost', () => {
    const run = (extra: Partial<RoutineRun>): RoutineRun => ({ n: 3, trigger: 'schedule', dueAt: Date.parse('2026-11-30T10:00:00Z'), state: 'done', ...extra });
    expect(runWords(run({ usd: 0.0421 }), 'UTC', 'en', en)).toBe('Run 3 · Mon 10:00 · done · ≈ $0.042');
    expect(runWords(run({ state: 'skipped', reason: 'budget' }), 'UTC', 'en', en)).toBe('Run 3 · Mon 10:00 · skipped: over budget');
    expect(runWords(run({ state: 'skipped', reason: 'provider limit' }), 'UTC', 'en', en)).toContain('provider usage limit');
    expect(runWords(run({ trigger: 'test', missed: 2, state: 'running' }), 'UTC', 'en', en)).toBe('Run 3 · Mon 10:00 · working · test · 2 missed runs included');
    expect(costWords(18, 'en')).toBe('≈ $18');
    expect(costWords(0.5, 'en')).toBe('≈ $0.50');
    expect(costWords(0, 'en')).toBe('≈ $0.00');
  });
});

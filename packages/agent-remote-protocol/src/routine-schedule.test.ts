import { describe, expect, it } from 'vitest';
import { isRoutineSchedule, isTimeZone, localTime, nextRun, type RoutineSchedule } from './routine-schedule.js';

const at = (iso: string) => Date.parse(iso);
const iso = (instant: number | undefined) => instant === undefined ? undefined : new Date(instant).toISOString();

describe('the next time a routine is due', () => {
  it('counts a quiet routine from the last message and an every routine from its anchor', () => {
    expect(nextRun({ kind: 'quiet', minutes: 30 }, at('2026-11-30T10:00:00Z'), 'UTC')).toBe(at('2026-11-30T10:30:00Z'));
    const every: RoutineSchedule = { kind: 'every', minutes: 15 }, anchor = at('2026-11-30T10:00:00Z');
    expect(iso(nextRun(every, at('2026-11-30T10:00:00Z'), 'UTC', anchor))).toBe('2026-11-30T10:15:00.000Z');
    expect(iso(nextRun(every, at('2026-11-30T10:14:59Z'), 'UTC', anchor))).toBe('2026-11-30T10:15:00.000Z');
    expect(iso(nextRun(every, at('2026-11-30T10:15:00Z'), 'UTC', anchor))).toBe('2026-11-30T10:30:00.000Z');
    expect(iso(nextRun(every, at('2026-11-30T09:00:00Z'), 'UTC', anchor))).toBe('2026-11-30T10:15:00.000Z');
  });
  it('runs a once routine one time and an event routine never by the clock', () => {
    expect(nextRun({ kind: 'once', at: 5000 }, 4999, 'UTC')).toBe(5000);
    expect(nextRun({ kind: 'once', at: 5000 }, 5000, 'UTC')).toBeUndefined();
    expect(nextRun({ kind: 'event' }, 0, 'UTC')).toBeUndefined();
  });
  it('runs a daily routine at the local time of its zone, today if it has not passed and tomorrow if it has', () => {
    const daily: RoutineSchedule = { kind: 'daily', time: '08:30' };
    // Shanghai is UTC+8: 08:30 there is 00:30 UTC.
    expect(iso(nextRun(daily, at('2026-11-30T00:00:00Z'), 'Asia/Shanghai'))).toBe('2026-11-30T00:30:00.000Z');
    expect(iso(nextRun(daily, at('2026-11-30T00:30:00Z'), 'Asia/Shanghai'))).toBe('2026-12-01T00:30:00.000Z');
    // New York is UTC-5 in winter.
    expect(iso(nextRun(daily, at('2026-11-30T12:00:00Z'), 'America/New_York'))).toBe('2026-11-30T13:30:00.000Z');
  });
  it('runs a weekdays routine on the listed days only, across a month end and a leap day', () => {
    const monToFri: RoutineSchedule = { kind: 'weekdays', days: [1, 2, 3, 4, 5], time: '09:00' };
    // Friday 2026-11-27 after 09:00: the next is Monday 2026-11-30.
    expect(iso(nextRun(monToFri, at('2026-11-27T10:00:00Z'), 'UTC'))).toBe('2026-11-30T09:00:00.000Z');
    // Sunday 2028-02-27 reaches Monday the 28th, then Tuesday the 29th is the leap day.
    expect(iso(nextRun(monToFri, at('2028-02-28T09:00:00Z'), 'UTC'))).toBe('2028-02-29T09:00:00.000Z');
    expect(iso(nextRun({ kind: 'weekdays', days: [3], time: '09:00' }, at('2026-12-30T09:00:00Z'), 'UTC'))).toBe('2027-01-06T09:00:00.000Z');
  });
  it('follows the wall clock over a daylight saving change: a gap shifts the run forward, a repeated hour runs once', () => {
    // New York springs forward on 2027-03-14: 02:30 does not exist that day.
    const early: RoutineSchedule = { kind: 'daily', time: '02:30' };
    expect(iso(nextRun(early, at('2027-03-13T12:00:00Z'), 'America/New_York'))).toBe('2027-03-14T07:30:00.000Z');
    expect(iso(nextRun(early, at('2027-03-14T12:00:00Z'), 'America/New_York'))).toBe('2027-03-15T06:30:00.000Z');
    // It falls back on 2027-11-07: 01:30 happens twice, and the routine runs at the first.
    const repeated: RoutineSchedule = { kind: 'daily', time: '01:30' };
    expect(iso(nextRun(repeated, at('2027-11-06T12:00:00Z'), 'America/New_York'))).toBe('2027-11-07T05:30:00.000Z');
    expect(iso(nextRun(repeated, at('2027-11-07T05:30:00Z'), 'America/New_York'))).toBe('2027-11-08T06:30:00.000Z');
  });
  it('gives different answers in two zones at the same instant', () => {
    const daily: RoutineSchedule = { kind: 'daily', time: '09:00' }, now = at('2026-11-30T20:00:00Z');
    expect(iso(nextRun(daily, now, 'Asia/Tokyo'))).toBe('2026-12-01T00:00:00.000Z');
    expect(iso(nextRun(daily, now, 'America/Los_Angeles'))).toBe('2026-12-01T17:00:00.000Z');
  });
  it('reads the wall clock of an instant and knows real zone names', () => {
    expect(localTime(at('2026-11-30T20:00:00Z'), 'Asia/Tokyo')).toMatchObject({ day: 1, month: 12, hour: 5, weekday: 2 });
    expect(isTimeZone('Europe/Paris')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('the schedule schema', () => {
  it('takes the forms and refuses what a routine may not do', () => {
    for (const schedule of [{ kind: 'quiet', minutes: 10 }, { kind: 'once', at: 1 }, { kind: 'every', minutes: 5 }, { kind: 'daily', time: '08:30' }, { kind: 'weekdays', days: [1, 5], time: '23:59' }, { kind: 'event' }])
      expect(isRoutineSchedule(schedule)).toBe(true);
    for (const schedule of [{ kind: 'every', minutes: 4 }, { kind: 'every', minutes: 1441 }, { kind: 'daily', time: '24:00' }, { kind: 'weekdays', days: [], time: '08:00' }, { kind: 'weekdays', days: [1, 1], time: '08:00' }, { kind: 'cron', expression: '* * * * *' }])
      expect(isRoutineSchedule(schedule)).toBe(false);
  });
});

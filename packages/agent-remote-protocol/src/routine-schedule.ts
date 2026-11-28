/**
 * The calendar of a routine (routines design 4): when its schedule is next due. This is the one place wall-clock time is computed; the
 * Relay stores the answer as the routine's due time and the client shows it. Time zones are IANA names read with `Intl`, so a daylight
 * saving change follows the wall clock: a time that does not exist that day runs shifted forward by the gap, a repeated hour runs once
 * (at its first occurrence).
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const strict = { additionalProperties: false } as const;
const time = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const clock = Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' });
export const ROUTINE_MIN_EVERY_MINUTES = 5;
export const ROUTINE_MAX_EVERY_MINUTES = 1440;
export const ROUTINE_MAX_QUIET_MINUTES = 7 * 24 * 60;

/**
 * When a routine is due. quiet: after this many minutes with nothing sent to the bot (every message pushes it back). once: at that
 * instant. every: each N minutes from the routine's anchor. daily and weekdays: at a local time, on every day or on the listed days
 * (1 is Monday, 7 is Sunday). event: when its webhook is called; it has no time.
 */
export const RoutineSchedule = Type.Union([
  Type.Object({ kind: Type.Literal('quiet'), minutes: Type.Integer({ minimum: 1, maximum: ROUTINE_MAX_QUIET_MINUTES }) }, strict),
  Type.Object({ kind: Type.Literal('once'), at: time }, strict),
  Type.Object({ kind: Type.Literal('every'), minutes: Type.Integer({ minimum: ROUTINE_MIN_EVERY_MINUTES, maximum: ROUTINE_MAX_EVERY_MINUTES }) }, strict),
  Type.Object({ kind: Type.Literal('daily'), time: clock }, strict),
  Type.Object({ kind: Type.Literal('weekdays'), days: Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), { minItems: 1, maxItems: 7, uniqueItems: true }), time: clock }, strict),
  Type.Object({ kind: Type.Literal('event') }, strict),
]);
export type RoutineSchedule = Static<typeof RoutineSchedule>;
export const isRoutineSchedule = (value: unknown): value is RoutineSchedule => Value.Check(RoutineSchedule, value);

export const isTimeZone = (name: string): boolean => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: name }); return true; } catch { return false; }
};
const formats = new Map<string, Intl.DateTimeFormat>();
const formatOf = (timeZone: string) => {
  let format = formats.get(timeZone);
  if (!format) { format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' }); formats.set(timeZone, format); }
  return format;
};
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export interface LocalTime { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }
/** The wall-clock reading of an instant in a zone; `weekday` is 1 for Monday to 7 for Sunday. */
export function localTime(instant: number, timeZone: string): LocalTime {
  const parts = Object.fromEntries(formatOf(timeZone).formatToParts(instant).map(part => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second), weekday: WEEKDAYS.indexOf(parts.weekday!) + 1 };
}
/** How far the zone's wall clock is ahead of UTC at an instant, in milliseconds. */
const offsetAt = (instant: number, timeZone: string): number => {
  const local = localTime(instant, timeZone);
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - Math.floor(instant / 1000) * 1000;
};
/** The instant a wall-clock reading happens in a zone: the first one when the hour repeats, shifted forward by the gap when it does not exist. */
export function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number { return instantOf(year, month, day, hour, minute, timeZone); }
function instantOf(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const candidates = [wall - offsetAt(wall - 86_400_000, timeZone), wall - offsetAt(wall + 86_400_000, timeZone)];
  const exact = candidates.filter(candidate => { const local = localTime(candidate, timeZone); return local.year === year && local.month === month && local.day === day && local.hour === hour && local.minute === minute; });
  return exact.length ? Math.min(...exact) : Math.max(...candidates);
}
const DAY = 86_400_000;
/**
 * The next time a schedule is due after an instant, or undefined when it never is again (a `once` in the past, an `event`). `anchor` is when an
 * `every` routine began counting; `quiet` counts from `after`, the moment of the last message.
 */
export function nextRun(schedule: RoutineSchedule, after: number, timeZone: string, anchor = after): number | undefined {
  switch (schedule.kind) {
    case 'event': return undefined;
    case 'once': return schedule.at > after ? schedule.at : undefined;
    case 'quiet': return after + schedule.minutes * 60_000;
    case 'every': { const step = schedule.minutes * 60_000; return after < anchor ? anchor + step : anchor + (Math.floor((after - anchor) / step) + 1) * step; }
    case 'daily': case 'weekdays': {
      const [hour, minute] = schedule.time.split(':').map(Number) as [number, number], days = schedule.kind === 'daily' ? [1, 2, 3, 4, 5, 6, 7] : schedule.days;
      const today = localTime(after, timeZone);
      // A calendar day is walked on its UTC date, which carries no daylight saving.
      const start = Date.UTC(today.year, today.month - 1, today.day);
      for (let ahead = 0; ahead <= 8; ahead++) {
        const date = new Date(start + ahead * DAY), weekday = ((date.getUTCDay() + 6) % 7) + 1;
        if (!days.includes(weekday)) continue;
        const candidate = instantOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, timeZone);
        if (candidate > after) return candidate;
      }
      return undefined;
    }
  }
}

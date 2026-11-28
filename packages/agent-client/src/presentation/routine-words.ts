/**
 * What a routine says in words (routines design 10): its schedule, its next run, a run's result and cost. The calendar is the protocol's; this
 * only names it, in the person's language and time zone.
 */
import type { Routine, RoutineRun, RoutineSchedule } from '@orchardworks/agent-remote-protocol';
import type { Locale, Translate } from './messages.js';

const tag = (locale: Locale) => locale === 'zh' ? 'zh-CN' : 'en';
/** A weekday number (1 is Monday) as its short name in a language. */
export const weekdayName = (day: number, locale: Locale): string => new Intl.DateTimeFormat(tag(locale), { weekday: 'short', timeZone: 'UTC' }).format(Date.UTC(2024, 0, day));
const clock = (instant: number, zone: string, locale: Locale, withDay: boolean) =>
  new Intl.DateTimeFormat(tag(locale), { ...(withDay ? { weekday: 'short' as const } : {}), hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone }).format(instant);
/** When the schedule fires, as a short phrase: "Weekdays at 08:30", "Every 15 min", "After 30 min of quiet". */
export function scheduleWords(schedule: RoutineSchedule, zone: string, locale: Locale, t: Translate): string {
  switch (schedule.kind) {
    case 'quiet': return t('routines.when.quiet', { minutes: schedule.minutes });
    case 'every': return schedule.minutes % 60 === 0 ? t('routines.when.everyHours', { hours: schedule.minutes / 60 }) : t('routines.when.every', { minutes: schedule.minutes });
    case 'daily': return t('routines.when.daily', { time: schedule.time });
    case 'weekdays': {
      const days = [...schedule.days].sort((a, b) => a - b);
      return days.join() === '1,2,3,4,5' ? t('routines.when.workdays', { time: schedule.time }) : t('routines.when.days', { days: days.map(day => weekdayName(day, locale)).join(', '), time: schedule.time });
    }
    case 'once': return t('routines.when.once', { when: new Intl.DateTimeFormat(tag(locale), { dateStyle: 'medium', timeStyle: 'short', timeZone: zone }).format(schedule.at) });
    case 'event': return t('routines.when.event');
  }
}
/** The next run of a routine as the list shows it: the time, or why there is none. */
export function nextRunWords(routine: Routine, now: number, zone: string, locale: Locale, t: Translate, hold?: string): string {
  if (routine.paused) return t('routines.next.paused');
  if (routine.finished) return t('routines.next.finished');
  if (hold) return t(`routines.next.hold.${hold}` as never);
  if (routine.dueAt === undefined) return t('routines.next.event');
  const days = Math.floor((routine.dueAt - now) / 86_400_000);
  return t('routines.next', { when: clock(routine.dueAt, zone, locale, days >= 1 || new Date(routine.dueAt).getUTCDate() !== new Date(now).getUTCDate()) });
}
/** A run's line: its number and time, how it ended, how many runs it stands for, and what it cost. */
export function runWords(run: RoutineRun, zone: string, locale: Locale, t: Translate): string {
  const parts = [t('routines.run', { n: run.n, time: clock(run.dueAt, zone, locale, true) }),
    run.state === 'skipped' ? t('routines.skipped', { reason: reasonWords(run.reason, t) }) : t(`routines.state.${run.state}` as never),
    ...(run.trigger === 'test' ? [t('routines.test.mark')] : []),
    ...(run.missed ? [t('routines.missed', { count: run.missed })] : []),
    ...(run.usd !== undefined ? [costWords(run.usd, locale)] : [])];
  return parts.join(' · ');
}
const REASONS = new Set(['overlap', 'paused', 'bot paused', 'budget', 'provider limit', 'absence', 'daily limit']);
const reasonWords = (reason: string | undefined, t: Translate) => reason && REASONS.has(reason) ? t(`routines.reason.${reason.replace(' ', '_')}` as never) : reason ?? '';
/** An estimated cost: "≈ $0.42"; small amounts keep their first significant digits. */
export function costWords(usd: number, locale: Locale): string {
  const digits = usd >= 10 ? 0 : usd >= 0.1 ? 2 : usd > 0 ? 3 : 2;
  return `≈ $${new Intl.NumberFormat(tag(locale), { minimumFractionDigits: digits === 0 ? 0 : 2, maximumFractionDigits: digits }).format(usd)}`;
}

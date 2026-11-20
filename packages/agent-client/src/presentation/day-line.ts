import type { Locale, Translate } from './messages.js';

/**
 * The day lines of a conversation ("Today 18:57"): one before the first turn, and one before a turn that starts on another
 * day or half an hour after the turn before it ended. Pure: the time zone and "now" are inputs.
 */

const GAP_MS = 30 * 60 * 1000;

const formatters = new Map<string, Intl.DateTimeFormat>();
/** One formatter per language, options and zone: making one costs about fifty times more than formatting with it. */
function formatter(tag: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify([tag, options]);
  let format = formatters.get(key);
  if (!format) formatters.set(key, format = new Intl.DateTimeFormat(tag, options));
  return format;
}

function localDay(time: number, timeZone?: string): string {
  return formatter('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(timeZone ? { timeZone } : {}) }).format(time);
}

/** Whether a day line goes before a turn that starts at `current`, after one that ended at `previous` (none for the first turn). */
export function startsDayLine(previous: string | undefined, current: string, timeZone?: string): boolean {
  const start = Date.parse(current);
  if (!Number.isFinite(start)) return false;
  if (previous === undefined) return true;
  const end = Date.parse(previous);
  return !Number.isFinite(end) || start - end >= GAP_MS || localDay(start, timeZone) !== localDay(end, timeZone);
}

/** The words of a day line: today and yesterday by name, other days by their date, each with the time. */
export function dayLineLabel(timestamp: string, now: number, locale: Locale, t: Translate, timeZone?: string): string {
  const time = Date.parse(timestamp);
  const zone = timeZone ? { timeZone } : {};
  const tag = locale === 'zh' ? 'zh-CN' : 'en-US';
  const clock = formatter(tag, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...zone }).format(time);
  const day = localDay(time, timeZone);
  if (day === localDay(now, timeZone)) return t('conversation.today', { time: clock });
  if (day === localDay(now - 24 * 60 * 60 * 1000, timeZone)) return t('conversation.yesterday', { time: clock });
  const date = formatter(tag, { month: 'short', day: 'numeric', ...(new Date(now).getUTCFullYear() !== new Date(time).getUTCFullYear() ? { year: 'numeric' } : {}), ...zone }).format(time);
  return `${date} ${clock}`;
}

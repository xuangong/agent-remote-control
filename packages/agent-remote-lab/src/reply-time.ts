import { translator, type Locale, type Translate } from '@orchardworks/agent-client';

/** The language tag of the page's locale, for the browser's date and time words. */
export const dateLocale = (locale: Locale) => locale === 'zh' ? 'zh-CN' : 'en';

/** A reply's time as a chat list shows it: the time today, Yesterday, the weekday within the week, otherwise the date. */
export function replyTime(replyAt: number, now = Date.now(), locale?: string, t: Translate = translator('en')): string {
  const reply = new Date(replyAt), today = new Date(now);
  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(reply)) / 86_400_000);
  if (days <= 0) return reply.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return t('navigation.time.yesterday');
  if (days < 7) return reply.toLocaleDateString(locale, { weekday: 'short' });
  return reply.toLocaleDateString(locale, { year: '2-digit', month: 'numeric', day: 'numeric' });
}

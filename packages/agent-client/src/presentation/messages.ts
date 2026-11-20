/**
 * The message catalogue: every word the product says, in English and Chinese. The tables live in `messages/areas`, one English
 * and one Chinese file per area, merged in `messages/en.ts` and `messages/zh.ts`. The locale is the device's language choice,
 * or the browser's language when it has none (`effectiveLocale`); English is the fallback. Pure: no DOM, clock or storage; a
 * host reads the stored choice and the browser's languages and passes them in.
 *
 * A message is a string with `{name}` placeholders, or plural forms keyed by the locale's plural category of `count`.
 * English has `one` and `other`; Chinese has only `other`. The Chinese words are the design's voice, not a translation
 * of the English sentence by sentence.
 */
import { en, englishAreas, type MessageKey } from './messages/en.js';
import { chineseAreas, zh } from './messages/zh.js';
import type { Locale, Message, MessageParams, PluralCategory } from './messages/types.js';
export { chooseLocale, effectiveLocale, readLanguageChoice, LANGUAGE_CHOICES, LANGUAGE_STORAGE_KEY, type LanguageChoice } from './locale-choice.js';

export type { Locale, Message, MessageParams, PluralCategory } from './messages/types.js';
export type { MessageKey } from './messages/en.js';
export const LOCALES: readonly Locale[] = ['en', 'zh'];

/** The plural category of a count in a locale (CLDR rules for integers). */
export function pluralCategory(locale: Locale, count: number): PluralCategory {
  return locale === 'en' && count === 1 ? 'one' : 'other';
}

const catalogues: Readonly<Record<Locale, Readonly<Record<MessageKey, Message>>>> = { en, zh };

/** Every message of a locale, for the catalogue's own checks. */
export function messageCatalogue(locale: Locale): Readonly<Record<MessageKey, Message>> {
  return catalogues[locale];
}

/** Each locale's areas by name, for the catalogue's own checks (no key in two areas). */
export function messageAreas(locale: Locale): Readonly<Record<string, Readonly<Record<string, Message>>>> {
  return locale === 'en' ? englishAreas : chineseAreas;
}

export type Translate = (key: MessageKey, params?: MessageParams) => string;

/** The words of a locale: `t(key, params)` fills the placeholders and picks the plural form of `params.count`. */
export function translator(locale: Locale): Translate {
  const catalogue = catalogues[locale];
  return (key, params = {}) => {
    const message = catalogue[key] ?? en[key];
    const count = typeof params.count === 'number' ? params.count : undefined;
    const text = typeof message === 'string' ? message : (count !== undefined && message[pluralCategory(locale, count)]) || message.other;
    return text.replace(/\{(\w+)\}/g, (whole, name: string) => name in params ? String(params[name]) : whole);
  };
}

/** The placeholders a message uses in any of its forms, for the catalogue's own checks. */
export function messagePlaceholders(message: Message): readonly string[] {
  const forms = typeof message === 'string' ? [message] : Object.values(message);
  return [...new Set(forms.flatMap(form => [...(form ?? '').matchAll(/\{(\w+)\}/g)].map(match => match[1]!)))].sort();
}

/** Elapsed time in the locale's short words: "12s", "1m 05s", "1h 02m 05s". */
export function elapsedWords(seconds: number, t: Translate): string {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return t('time.seconds', { seconds: whole });
  const minutes = Math.floor(whole / 60), rest = String(whole % 60).padStart(2, '0');
  if (minutes < 60) return t('time.minutes', { minutes, seconds: rest });
  return t('time.hours', { hours: Math.floor(minutes / 60), minutes: String(minutes % 60).padStart(2, '0'), seconds: rest });
}

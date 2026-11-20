/**
 * Which language a reader sees: the device's choice when it names one, else the first of the browser's languages the catalogue
 * speaks, else English. Pure and free of the message tables, so the sign-in entry can decide the locale without loading them.
 */
import type { Locale } from './messages/types.js';

/** The first of the reader's languages (most preferred first) that the catalogue speaks; English otherwise. */
export function chooseLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const primary = language.trim().toLowerCase().split(/[-_]/)[0];
    if (primary === 'zh') return 'zh';
    if (primary === 'en') return 'en';
  }
  return 'en';
}

/** The device's language choice: the browser's (absent or anything unknown), or one the catalogue speaks. */
export type LanguageChoice = 'browser' | Locale;
/** The localStorage key of the choice, per device; it is a display choice, so clearing conversations keeps it. */
export const LANGUAGE_STORAGE_KEY = 'agent-remote:language';
export const LANGUAGE_CHOICES: readonly LanguageChoice[] = ['browser', 'zh', 'en'];

export function readLanguageChoice(stored: string | null | undefined): LanguageChoice {
  return stored === 'zh' || stored === 'en' ? stored : 'browser';
}

/** The locale a reader sees: the device's choice when it names one, else the first of the browser's languages it speaks. */
export function effectiveLocale(choice: LanguageChoice, languages: readonly string[]): Locale {
  return choice === 'browser' ? chooseLocale(languages) : choice;
}

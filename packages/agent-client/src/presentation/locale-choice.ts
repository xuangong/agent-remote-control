/**
 * Which language a reader sees: the device's choice when it names one, else the first of the browser's languages the catalogue
 * speaks, else English; and the key an error carries for the words it is shown in. Pure and free of the message tables, so the
 * sign-in entry and the browser storage modules use them without loading the tables (`@orchardworks/agent-client/locale`).
 */
import type { Locale, MessageParams } from './messages/types.js';
import type { MessageKey } from './messages/en.js';

export type { Locale } from './messages/types.js';

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

/** An error made for a person: its English `message` stays for logs and tests; `messageKey` (and params) give its words in the reader's language. */
export interface MessageKeyed {
  readonly messageKey?: MessageKey;
  readonly messageParams?: MessageParams;
}

/** Marks an error with the catalogue key of its message; the error is returned so a throw site stays one expression. */
export function withMessageKey<E extends Error>(error: E, key: MessageKey, params?: MessageParams): E & MessageKeyed {
  return Object.assign(error, params === undefined ? { messageKey: key } : { messageKey: key, messageParams: params });
}


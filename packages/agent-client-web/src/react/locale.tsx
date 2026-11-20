import { createContext, useContext, useMemo } from 'react';
import { chooseLocale, translator, type Locale, type Translate } from '@orchardworks/agent-client';

/**
 * The reader's locale for the conversation's words. A host provides it once, from the browser (`browserLocale`); without a
 * provider the words are English.
 */
export const LocaleContext = createContext<Locale>('en');

/** The locale the browser's languages choose: Chinese for a Chinese browser, English otherwise. */
export function browserLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en';
  return chooseLocale(navigator.languages?.length ? navigator.languages : [navigator.language ?? 'en']);
}

/** The conversation's words in the reader's locale. */
export function useTranslate(): Translate {
  const locale = useContext(LocaleContext);
  return useMemo(() => translator(locale), [locale]);
}

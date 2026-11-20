import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { chooseLocale, translator, type LanguageChoice, type Locale, type Translate } from '@orchardworks/agent-client';

/**
 * The reader's locale for every word. A host provides it once (`LocaleProvider` over the device's language choice, or a fixed
 * value); without a provider the words are English.
 */
export const LocaleContext = createContext<Locale>('en');

/** The locale the browser's languages choose: Chinese for a Chinese browser, English otherwise. */
export function browserLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en';
  return chooseLocale(navigator.languages?.length ? navigator.languages : [navigator.language ?? 'en']);
}

/** The device's language choice as `bindLanguage` (browser.ts) keeps it: the choice, the locale it shows, and its changes. */
export interface LanguageSource { readonly value: LanguageChoice; readonly locale: Locale; set(next: LanguageChoice): void; subscribe(listener: () => void): () => void }
const LanguageContext = createContext<LanguageSource | undefined>(undefined);

/** Provides the locale of the device's language choice, and renders again in the new language when it changes, here or in another tab. */
export function LocaleProvider({ language, children }: { language: LanguageSource; children: ReactNode }) {
  const locale = useSyncExternalStore(language.subscribe, () => language.locale, () => language.locale);
  return <LanguageContext.Provider value={language}><LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider></LanguageContext.Provider>;
}

/** The device's language choice, for the control that changes it (Settings > General); undefined without a `LocaleProvider`. */
export function useLanguageChoice(): LanguageSource | undefined {
  const language = useContext(LanguageContext);
  useSyncExternalStore(language?.subscribe ?? noSubscription, () => language?.value, () => language?.value);
  return language;
}
const noSubscription = () => () => {};

/** The words in the reader's locale. */
export function useTranslate(): Translate {
  const locale = useContext(LocaleContext);
  return useMemo(() => translator(locale), [locale]);
}

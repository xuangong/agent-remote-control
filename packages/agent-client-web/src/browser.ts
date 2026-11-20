/** Browser storage helpers that do not load a Remote session client. Importing this entry connects the headless client to this page. */
import './page/browser-environment.js';
import { APPEARANCE_STORAGE_KEY, applyAppearance, readAppearance, type Appearance, type AppearancePort } from './theme/appearance.js';
import { MOTION_STORAGE_KEY, readMotionChoice, reducesMotion, type MotionChoice } from './theme/motion.js';
import { effectiveLocale, LANGUAGE_STORAGE_KEY, readLanguageChoice, type LanguageChoice, type Locale } from '@orchardworks/agent-client';
export { clearImageDraftScope, configureImageDraftPersistence, clearPersistedImageDrafts } from './image-drafts.js';
export type { ImageDraftBinding, ImageDraftRecipient } from './image-drafts.js';
export { inspectImageDraft, readImageDraft, writeImageDraft, releaseImageDraft } from './image-drafts.js';
export type { ImageDraft, ImageDraftStorageHandle, ImageDraftStorageSnapshot, ImageDraftApplication, ImageDraftReplacement } from './image-drafts.js';

export type { Appearance } from './theme/appearance.js';
export type { MotionChoice } from './theme/motion.js';

/** A choice this device keeps: its value, how to change it, and how to hear a change made here or in another tab. */
export interface DeviceChoice<T> { readonly value: T; set(next: T): void; subscribe(listener: () => void): () => void }

type ChoiceStorage = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>;
/** One stored choice: read once, shown by `apply`, written by `set` (the default value is removed), and followed across tabs. */
function storedChoice<T extends string>(storage: ChoiceStorage, view: Pick<Window, 'addEventListener'> | undefined, key: string, read: (stored: string | null) => T,
  fallback: T, apply: (value: T) => void): DeviceChoice<T> & { notify(): void } {
  const listeners = new Set<() => void>();
  const load = () => { try { return read(storage.getItem(key)); } catch { return fallback; } };
  let value = load();
  apply(value);
  const notify = () => { for (const listener of [...listeners]) listener(); };
  view?.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    const next = load();
    if (next === value) return;
    value = next; apply(value); notify();
  });
  return {
    get value() { return value; },
    set(next) {
      if (next === value) return;
      value = next;
      try { if (next === fallback && storage.removeItem) storage.removeItem(key); else storage.setItem(key, next); } catch { /* This page keeps the choice. */ }
      apply(value); notify();
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    notify,
  };
}

export interface AppearanceBinding extends DeviceChoice<Appearance> { readonly appearance: Appearance }

/**
 * Shows this device's stored appearance and returns the way to change it. The only code that sets the root's
 * `data-theme` and the `theme-color` metas; storage that throws (a private window) only loses persistence.
 */
export function bindAppearance(document: Document, storage: ChoiceStorage, view?: Pick<Window, 'addEventListener'>): AppearanceBinding {
  const port: AppearancePort = {
    setTheme: theme => { if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme; },
    setChromeColor: (color, media) => {
      document.querySelector<HTMLMetaElement>(`meta[name="theme-color"][media="(prefers-color-scheme: ${media})"]`)?.setAttribute('content', color);
    },
  };
  const choice = storedChoice(storage, view, APPEARANCE_STORAGE_KEY, readAppearance, 'system', value => applyAppearance(port, value));
  return {
    get appearance() { return choice.value; },
    get value() { return choice.value; },
    set: choice.set,
    subscribe: choice.subscribe,
  };
}

export interface LanguageBinding extends DeviceChoice<LanguageChoice> {
  /** The locale the reader sees: the choice, or the browser's languages. */
  readonly locale: Locale;
}

/**
 * This device's language (Settings > General): the stored choice, or the browser's languages. Sets `<html lang>`; a choice made
 * in another tab, or a change of the browser's languages, arrives too.
 */
export function bindLanguage(document: Document, storage: ChoiceStorage, view?: Pick<Window, 'addEventListener' | 'navigator'>): LanguageBinding {
  const languages = () => { const navigator = view?.navigator; return navigator?.languages?.length ? navigator.languages : [navigator?.language ?? 'en']; };
  const locale = (choice: LanguageChoice) => effectiveLocale(choice, languages());
  const choice = storedChoice(storage, view, LANGUAGE_STORAGE_KEY, readLanguageChoice, 'browser', value => {
    document.documentElement.lang = locale(value) === 'zh' ? 'zh-CN' : 'en';
  });
  view?.addEventListener('languagechange', () => { document.documentElement.lang = locale(choice.value) === 'zh' ? 'zh-CN' : 'en'; choice.notify(); });
  return {
    get value() { return choice.value; },
    get locale() { return locale(choice.value); },
    set: choice.set,
    subscribe: choice.subscribe,
  };
}

export interface MotionBinding extends DeviceChoice<MotionChoice> {
  /** Whether motion is reduced now: the system asks for it, or the choice does. */
  readonly reduced: boolean;
  /** Whether the system itself reduces motion, which no choice can undo. */
  readonly systemReduced: boolean;
}

/** This device's motion choice (Settings > General): sets `data-motion` on the root while motion is reduced by the choice or the system. */
export function bindMotion(document: Document, storage: ChoiceStorage, view?: Pick<Window, 'addEventListener' | 'matchMedia'>): MotionBinding {
  const query = view?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const system = () => query?.matches === true;
  const show = (value: MotionChoice) => { if (reducesMotion(value, system())) document.documentElement.dataset.motion = 'reduce'; else delete document.documentElement.dataset.motion; };
  const choice = storedChoice(storage, view, MOTION_STORAGE_KEY, readMotionChoice, 'system', show);
  query?.addEventListener?.('change', () => { show(choice.value); choice.notify(); });
  return {
    get value() { return choice.value; },
    get reduced() { return reducesMotion(choice.value, system()); },
    get systemReduced() { return system(); },
    set: choice.set,
    subscribe: choice.subscribe,
  };
}

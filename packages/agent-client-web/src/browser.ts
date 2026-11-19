/** Browser storage helpers that do not load a Remote session client. Importing this entry connects the headless client to this page. */
import './page/browser-environment.js';
import { APPEARANCE_STORAGE_KEY, applyAppearance, chooseAppearance, readAppearance, type Appearance, type AppearancePort } from './theme/appearance.js';
export { clearImageDraftScope, configureImageDraftPersistence, clearPersistedImageDrafts } from './image-drafts.js';
export type { ImageDraftBinding, ImageDraftRecipient } from './image-drafts.js';
export { inspectImageDraft, readImageDraft, writeImageDraft, releaseImageDraft } from './image-drafts.js';
export type { ImageDraft, ImageDraftStorageHandle, ImageDraftStorageSnapshot, ImageDraftApplication, ImageDraftReplacement } from './image-drafts.js';

export type { Appearance } from './theme/appearance.js';

export interface AppearanceBinding { readonly appearance: Appearance; set(next: Appearance): void }

/**
 * Shows this device's stored appearance and returns the way to change it. The only code that sets the root's
 * `data-theme` and the `theme-color` metas; storage that throws (a private window) only loses persistence.
 */
export function bindAppearance(document: Document, storage: Pick<Storage, 'getItem' | 'setItem'>): AppearanceBinding {
  const port: AppearancePort = {
    read: () => { try { return storage.getItem(APPEARANCE_STORAGE_KEY); } catch { return null; } },
    write: value => { try { storage.setItem(APPEARANCE_STORAGE_KEY, value); } catch { /* not persisted */ } },
    setTheme: theme => { if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme; },
    setChromeColor: (color, media) => {
      document.querySelector<HTMLMetaElement>(`meta[name="theme-color"][media="(prefers-color-scheme: ${media})"]`)?.setAttribute('content', color);
    },
  };
  let appearance = readAppearance(port.read());
  applyAppearance(port, appearance);
  return {
    get appearance() { return appearance; },
    set(next) { appearance = next; chooseAppearance(port, next); },
  };
}

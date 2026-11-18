/** Browser storage helpers that do not load a Remote session client. Importing this entry connects the headless client to this page. */
import './page/browser-environment.js';
export { clearImageDraftScope, configureImageDraftPersistence, clearPersistedImageDrafts } from './image-drafts.js';
export type { ImageDraftBinding, ImageDraftRecipient } from './image-drafts.js';
export { inspectImageDraft, readImageDraft, writeImageDraft, releaseImageDraft } from './image-drafts.js';
export type { ImageDraft, ImageDraftStorageHandle, ImageDraftStorageSnapshot, ImageDraftApplication, ImageDraftReplacement } from './image-drafts.js';

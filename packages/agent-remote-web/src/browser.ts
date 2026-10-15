/** Browser lifecycle and recovery helpers without loading a Remote session client. */
export { watchPageResume } from './client/page-resume.js';
export { watchPagePolling } from './client/page-polling.js';
export { clearImageDraftScope, configureImageDraftPersistence, clearPersistedImageDrafts } from './image-drafts.js';
export type { ImageDraftBinding, ImageDraftRecipient } from './image-drafts.js';
export { inspectImageDraft, readImageDraft, writeImageDraft, releaseImageDraft } from './image-drafts.js';
export type { ImageDraft, ImageDraftStorageHandle, ImageDraftStorageSnapshot, ImageDraftApplication, ImageDraftReplacement } from './image-drafts.js';

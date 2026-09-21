import { useEffect, useRef, useState } from 'react';
import type { ImageUploadReceipt, MessagePart } from '@orchardworks/agent-remote-protocol';
import { readImageDraft, writeImageDraft, imageDraftScopeGeneration, cacheDraftImage, lookupDraftImage, retainDraftImages, restoreCachedDraftImage, type ImageDraft } from '../image-drafts.js';
import { draftText, normalizeDraftParts, snapshotContent, type DraftPart } from './composer-document.js';

export type UploadImage = (file: Blob, uploadId: string, options?: { signal?: AbortSignal; onProgress?(loaded: number, total: number): void }) => Promise<NonNullable<ImageUploadReceipt['attachment']>>;
interface DraftEntry { draft: ImageDraft; inputText: string; revision: number; hydrated: boolean; restoring?: boolean; readFailed?: boolean; storageError?: string; error?: string; saving?: Promise<void>; dirty: boolean; timer?: ReturnType<typeof setTimeout>; generation: number; wake?: () => void }
export function useImageDraft({ scope, sessionKey, text, enabled, active, upload, onTextChange }: {
  scope?: string; sessionKey: string; text: string; enabled: boolean; active: boolean; upload?: UploadImage; onTextChange(text: string): void;
}) {
  const entries = useRef(new Map<string, DraftEntry>());
  const key = JSON.stringify([scope ?? 'memory', sessionKey]);
  let entry = entries.current.get(key);
  if (!entry) {
    entry = { draft: { version: 1, key, scope: scope ?? '', parts: text ? [{ type: 'text', text }] : [], images: {}, nextLabel: 1 }, inputText: text, revision: 0, hydrated: !scope, dirty: false, generation: imageDraftScopeGeneration(scope ?? '') };
    entries.current.set(key, entry);
  }
  const current = entry;
  const [, refresh] = useState(0);
  const currentKey = useRef(key); currentKey.current = key;
  const callbacks = useRef({ upload, onTextChange }); callbacks.current = { upload, onTextChange };
  const imageOwner = useRef({});
  useEffect(() => {
    retainDraftImages(imageOwner.current, scope ?? '', Object.keys(current.draft.images));
  }, [key, Object.keys(current.draft.images).join(',')]);
  useEffect(() => () => retainDraftImages(imageOwner.current, scope ?? '', []), []);
  useEffect(() => {
    entries.current.delete(key); entries.current.set(key, current);
    let bytes = 0;
    const inactive = [...entries.current].filter(([entryKey, entry]) => entryKey !== key && entry.hydrated && !entry.dirty && !entry.saving && !entry.readFailed && !entry.storageError && !!entry.draft.scope);
    for (const [, entry] of inactive) for (const image of Object.values(entry.draft.images)) bytes += image.blob?.size ?? 0;
    let count = inactive.length;
    for (const [entryKey, entry] of inactive) {
      if (count <= 6 && bytes <= 32 * 1024 * 1024) break;
      for (const image of Object.values(entry.draft.images)) bytes -= image.blob?.size ?? 0;
      entries.current.delete(entryKey); count--;
    }
  }, [key]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function notify(): void { if (mounted.current && currentKey.current === key) refresh(value => value + 1); }
  function flush(): void {
    clearTimeout(current.timer); current.timer = undefined;
    if (!current.dirty || current.saving || current.readFailed || !current.hydrated) return;
    current.dirty = false;
    const snapshot: ImageDraft = { ...current.draft, parts: current.draft.parts.map(part => ({ ...part })),
      images: Object.fromEntries(Object.entries(current.draft.images).map(([id, image]) => [id, { ...image }])) };
    let failed = false;
    current.saving = writeImageDraft(snapshot, current.generation)
      .then(() => { current.storageError = undefined; })
      .catch(() => { failed = true; current.dirty = true; current.storageError = 'Images are not saved on this device. Keep this page open.'; })
      .finally(() => { current.saving = undefined; if (current.dirty && !failed) flush(); notify(); });
  }
  function persist(immediate = false): void {
    if (!scope || !enabled) return;
    current.dirty = true;
    if (!current.hydrated || current.readFailed) return;
    if (immediate) flush();
    else if (current.timer === undefined && !current.saving) current.timer = setTimeout(flush, 250);
  }
  function changed(document = false, immediate = false): void {
    if (document) { current.revision++; if (mounted.current && currentKey.current === key) callbacks.current.onTextChange(draftText(current.draft.parts)); }
    persist(immediate || !document); notify(); current.wake?.();
  }
  useEffect(() => {
    if (current.inputText === text) return;
    current.inputText = text;
    if (current.draft.parts.some(part => part.type === 'image') || draftText(current.draft.parts) === text) return;
    current.draft.parts = text ? [{ type: 'text', text }] : [];
    current.revision++;
    changed();
  }, [key, text]);
  function restore(): void {
    if (!scope || current.restoring) return;
    current.restoring = true;
    const revision = current.revision;
    let savedDraftChanged = false;
    void readImageDraft(key).then(saved => {
      current.readFailed = false;
      if (saved && revision === 0 && revision === current.revision) {
        savedDraftChanged = true;
        current.draft = saved;
        for (const image of Object.values(saved.images)) {
          if (!image.blob) { image.status = 'unavailable'; image.error = 'Local image bytes are missing. Replace or remove this image.'; image.attachment = undefined; }
          else { cacheDraftImage(scope ?? '', image.imageId, image.blob, current.generation); if (image.status === 'uploading' || image.status === 'ready') image.status = 'pending'; }
        }
        if (mounted.current && currentKey.current === key) callbacks.current.onTextChange(draftText(saved.parts));
      }
    }).catch(() => { current.readFailed = true; }).finally(() => {
      current.hydrated = true;
      current.restoring = false;
      // A failed read must not replace a potentially recoverable saved draft.
      if (!current.readFailed) { if (current.dirty || savedDraftChanged) persist(true); current.wake?.(); }
      notify();
    });
  }
  function retryStorage(): void {
    if (current.restoring || current.saving) return;
    if (current.readFailed || !current.hydrated) restore();
    else if (current.storageError) persist(true);
    else return;
    notify();
  }
  useEffect(() => {
    if (!enabled || current.hydrated) return;
    restore();
  }, [key, enabled]);
  useEffect(() => {
    if (!enabled || !scope) return;
    const retry = () => { if (document.visibilityState !== 'hidden') retryStorage(); else if (!current.storageError) flush(); };
    const flushBeforeLeave = () => { if (!current.storageError) flush(); };
    window.addEventListener('pagehide', flushBeforeLeave);
    if (active) retry();
    document.addEventListener('visibilitychange', retry);
    window.addEventListener('pageshow', retry);
    window.addEventListener('focus', retry);
    return () => {
      window.removeEventListener('pagehide', flushBeforeLeave);
      flushBeforeLeave();
      document.removeEventListener('visibilitychange', retry);
      window.removeEventListener('pageshow', retry);
      window.removeEventListener('focus', retry);
    };
  }, [key, enabled, active]);
  useEffect(() => {
    if (!enabled || !active || !upload || !current.hydrated) return;
    const abort = new AbortController();
    for (const part of current.draft.parts) {
      if (part.type !== 'image') continue;
      const image = current.draft.images[part.imageId];
      if (image?.status === 'ready' && image.blob) image.status = 'pending';
    }
    let pumping = false;
    const pump = async () => {
      if (pumping || abort.signal.aborted) return;
      pumping = true;
      try { for (;;) {
        const ids = new Set(current.draft.parts.flatMap(part => part.type === 'image' ? [part.imageId] : []));
        const image = Object.values(current.draft.images).find(value => ids.has(value.imageId) && value.status === 'pending' && value.blob);
        if (!image || abort.signal.aborted) return;
        image.status = 'uploading'; image.error = undefined; notify();
        try {
          const attachment = await callbacks.current.upload!(image.blob!, image.uploadId, { signal: abort.signal, onProgress: (loaded, total) => { if (!abort.signal.aborted) { image.progress = total ? loaded / total : 0; notify(); } } });
          if (abort.signal.aborted) return;
          image.attachment = attachment; image.status = 'ready'; image.progress = 1;
        } catch (error) {
          if (abort.signal.aborted) return;
          image.status = 'failed'; image.error = error instanceof Error ? error.message : 'Image upload failed.';
        }
        changed();
      }
      } finally { pumping = false; }
    };
    current.wake = () => { void pump(); };
    void pump();
    return () => { current.wake = undefined; abort.abort(); for (const image of Object.values(current.draft.images)) if (image.status === 'uploading') image.status = 'pending'; };
  }, [key, enabled, active, Boolean(upload), current.hydrated]);
  function addFiles(files: readonly Blob[], replacingImageId?: string): DraftPart[] {
    const remainingImages = current.draft.parts.filter(part => part.type === 'image');
    const replacedIndex = remainingImages.findIndex(part => part.imageId === replacingImageId);
    if (replacedIndex !== -1) remainingImages.splice(replacedIndex, 1);
    const count = remainingImages.length;
    const uniqueIds = new Set(remainingImages.map(part => part.imageId));
    let bytes = [...uniqueIds].reduce((sum, id) => sum + (current.draft.images[id]?.blob?.size ?? 0), 0);
    const parts: DraftPart[] = [];
    current.error = undefined;
    for (const blob of files) {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) { current.error = 'Unsupported image format. Choose PNG, JPEG, or WebP.'; break; }
      if (blob.size > 10 * 1024 * 1024 || bytes + blob.size > 20 * 1024 * 1024 || count + parts.length >= 8) { current.error = 'Images exceed the limit: 8 images, 10 MiB each, 20 MiB total.'; break; }
      const imageId = crypto.randomUUID();
      cacheDraftImage(scope ?? '', imageId, blob, current.generation);
      current.draft.images[imageId] = { imageId, blob, uploadId: crypto.randomUUID(), status: 'pending', progress: 0 };
      parts.push({ type: 'image', imageId, label: `image #${current.draft.nextLabel++}` }); bytes += blob.size;
    }
    notify(); return parts;
  }
  const images = current.draft.images;
  const hasImages = current.draft.parts.some(part => part.type === 'image');
  return {
    parts: current.draft.parts, images, error: current.error,
    storageError: current.readFailed ? 'Saved draft could not be restored.' : hasImages ? current.storageError : undefined,
    storageBusy: Boolean(current.restoring || current.saving), retryStorage,
    ready: current.draft.parts.every(part => part.type === 'text' || images[part.imageId]?.status === 'ready'),
    hasImages,
    setParts(parts: readonly DraftPart[]) {
      const imageIds = (parts: readonly DraftPart[]) => parts.flatMap(part => part.type === 'image' ? [part.imageId] : []).join(',');
      const immediate = imageIds(parts) !== imageIds(current.draft.parts) || parts.length === 0;
      current.draft.parts = normalizeDraftParts(parts); changed(true, immediate);
    },
    setText(value: string) { current.draft.parts = value ? [{ type: 'text', text: value }] : []; changed(true, !value || hasImages); },
    addFiles,
    retry(imageId: string) { const image = images[imageId]; if (image?.blob) { image.status = 'pending'; image.error = undefined; changed(true); } },
    rejectAttachments(content: readonly MessagePart[], message: string) {
      const rejected = new Set(content.flatMap(part => part.type === 'image' ? [part.attachmentId] : []));
      for (const image of Object.values(images)) {
        if (!image.attachment || !rejected.has(image.attachment.attachmentId)) continue;
        image.status = image.blob ? 'failed' : 'unavailable'; image.error = message;
        image.attachment = undefined; image.progress = 0; image.uploadId = crypto.randomUUID();
      }
      changed();
    },
    importParts(parts: readonly DraftPart[]): DraftPart[] | Promise<DraftPart[]> {
      const missing = parts.flatMap(part => part.type === 'image' && !images[part.imageId]?.blob && !lookupDraftImage(scope ?? '', part.imageId) ? [part.imageId] : []);
      if (!scope || !missing.length) return importParts(parts);
      return Promise.all(missing.map(id => restoreCachedDraftImage(scope, id).catch(() => undefined))).then(() =>
        mounted.current && currentKey.current === key && current.generation === imageDraftScopeGeneration(scope) ? importParts(parts) : []);
    },
    snapshot() { return snapshotContent(current.draft.parts, Object.fromEntries(Object.entries(images).map(([id, image]) => [id, image.status === 'ready' ? image.attachment : undefined]))); },
  };
  function importParts(parts: readonly DraftPart[]): DraftPart[] {
      const result: DraftPart[] = [];
      const referencedIds = new Set(current.draft.parts.flatMap(part => part.type === 'image' ? [part.imageId] : []));
      let bytes = [...referencedIds].reduce((sum, id) => sum + (images[id]?.blob?.size ?? 0), 0);
      const imported = new Map<string, DraftPart>();
      current.error = undefined;
      for (const part of parts) {
        if (part.type === 'text') { result.push(part); continue; }
        if (current.draft.parts.filter(value => value.type === 'image').length + result.filter(value => value.type === 'image').length >= 8) { current.error = 'A message can contain at most 8 images.'; notify(); break; }
        const blob = images[part.imageId]?.blob ?? lookupDraftImage(scope ?? '', part.imageId);
        const extraBytes = referencedIds.has(part.imageId) ? 0 : blob?.size ?? 0;
        if (bytes + extraBytes > 20 * 1024 * 1024) { current.error = 'Images exceed the limit: 8 images, 10 MiB each, 20 MiB total.'; notify(); break; }
        if (images[part.imageId]) result.push(part);
        else if (imported.has(part.imageId)) result.push(imported.get(part.imageId)!);
        else if (blob) {
          const added = addFiles([blob]);
          if (!added.length) break;
          imported.set(part.imageId, added[0]!); result.push(...added);
        } else { current.error = 'Copied image bytes are unavailable. Select the original file again.'; notify(); continue; }
        referencedIds.add(part.imageId); bytes += extraBytes;
      }
      return result;
  }
}

import 'fake-indexeddb/auto';
import { Blob as NativeBlob } from 'node:buffer';
import { expect, it, vi } from 'vitest';
import { cacheDraftImage, clearImageDraftScope, imageDraftScopeGeneration, lookupDraftImage, readImageDraft, writeImageDraft, type ImageDraft } from './image-drafts.js';

function draft(scope: string): ImageDraft {
  return { version: 1, key: JSON.stringify([scope, 'native-session']), scope, parts: [{ type: 'text', text: 'before ' }, { type: 'image', imageId: scope, label: 'image #4' }, { type: 'text', text: ' after' }],
    images: { [scope]: { imageId: scope, blob: new NativeBlob(['image bytes'], { type: 'image/png' }) as Blob, uploadId: 'upload', status: 'pending', progress: 0 } }, nextLabel: 5 };
}
it('round-trips ordered draft metadata and blobs through IndexedDB', async () => {
  const saved = draft('roundtrip');
  await writeImageDraft(saved);
  const restored = await readImageDraft(saved.key);
  expect(restored?.parts).toEqual(saved.parts);
  expect(restored?.nextLabel).toBe(5);
  expect(await restored?.images.roundtrip?.blob?.text()).toBe('image bytes');
});
it('signout revokes old writes and local clipboard blobs only for the selected scope', async () => {
  const first = draft('account-one'); const second = draft('account-two');
  const generation = imageDraftScopeGeneration(first.scope);
  cacheDraftImage(first.scope, first.scope, first.images[first.scope]!.blob!, generation);
  cacheDraftImage(second.scope, second.scope, second.images[second.scope]!.blob!, imageDraftScopeGeneration(second.scope));
  await writeImageDraft(first); await writeImageDraft(second);
  const clear = clearImageDraftScope(first.scope);
  await writeImageDraft(first, generation);
  await clear;
  expect(await readImageDraft(first.key)).toBeUndefined();
  expect((await readImageDraft(second.key))?.parts).toEqual(second.parts);
  expect(lookupDraftImage(first.scope, first.scope)).toBeUndefined();
  expect(lookupDraftImage(second.scope, second.scope)).toBeDefined();
  expect(lookupDraftImage(first.scope, second.scope)).toBeUndefined();
  await writeImageDraft(first, generation);
  expect(await readImageDraft(first.key)).toBeUndefined();
});

 it('recovers binary images when a WebKit storage backend rejects Blob records', async () => {
  const original = IDBObjectStore.prototype.put;
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: ImageDraft, key?: IDBValidKey) {
    if (Object.values(value.images ?? {}).some(image => image.blob)) throw new DOMException('Error preparing Blob/File data to be stored in object store', 'UnknownError');
    return key === undefined ? original.call(this, value) : original.call(this, value, key);
  });
  try {
    const saved = draft('webkit-binary');
    await writeImageDraft(saved);
    const restored = await readImageDraft(saved.key);
    expect(restored?.parts).toEqual(saved.parts);
    expect(restored?.images['webkit-binary']?.blob?.type).toBe('image/png');
    expect(restored?.images['webkit-binary']?.blob?.size).toBe(11);
  } finally { put.mockRestore(); }
});

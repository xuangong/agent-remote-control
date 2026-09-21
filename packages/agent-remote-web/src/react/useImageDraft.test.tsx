import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ImageDraft } from '../image-drafts.js';
import { readImageDraft, writeImageDraft } from '../image-drafts.js';
import { render, rerender } from '../test/setup.js';
import { useImageDraft, type UploadImage } from './useImageDraft.js';
vi.mock('../image-drafts.js', async importOriginal => ({ ...await importOriginal<typeof import('../image-drafts.js')>(), readImageDraft: vi.fn(), writeImageDraft: vi.fn(async () => {}) }));
let draft!: ReturnType<typeof useImageDraft>;
function Harness({ session = 'a', active = true, scope, upload, text = '', enabled = true }: { session?: string; active?: boolean; scope?: string; upload?: UploadImage; text?: string; enabled?: boolean }) {
  draft = useImageDraft({ sessionKey: session, scope, text, enabled, active, upload, onTextChange: () => {} });
  return <span>{draft.storageError}</span>;
}
const attachment = { attachmentId: 'a', sha256: 'a'.repeat(64), mediaType: 'image/png' as const, byteLength: 1, imageDimensions: { width: 1, height: 1 } };
beforeEach(() => { vi.mocked(readImageDraft).mockReset().mockResolvedValue(undefined); vi.mocked(writeImageDraft).mockReset().mockResolvedValue(undefined); });
afterEach(() => vi.restoreAllMocks());

it('does not overwrite a new edit when saved draft hydration finishes late', async () => {
  let resolve!: (value: ImageDraft) => void;
  vi.mocked(readImageDraft).mockImplementation(() => new Promise(done => { resolve = done; }));
  await render(<Harness scope="account" />);
  await act(async () => draft.setText('Newer edit'));
  await act(async () => resolve({ version: 1, key: '["account","a"]', scope: 'account', parts: [{ type: 'text', text: 'Old saved edit' }], images: {}, nextLabel: 1 }));
  expect(draft.parts).toEqual([{ type: 'text', text: 'Newer edit' }]);
  expect(writeImageDraft).toHaveBeenLastCalledWith(expect.objectContaining({ parts: [{ type: 'text', text: 'Newer edit' }] }), 0);
});

it('aborts the captured session upload and rejects late completion after switching', async () => {
  let resolve!: (value: typeof attachment) => void;
  let signal: AbortSignal | undefined;
  const upload = vi.fn<UploadImage>((_blob, _id, options) => { signal = options?.signal; return new Promise(done => { resolve = done; }); });
  const container = await render(<Harness upload={upload} />);
  await act(async () => draft.setParts(draft.addFiles([new Blob(['x'], { type: 'image/png' })])));
  expect(upload).toHaveBeenCalledTimes(1);
  await act(async () => draft.setParts([...draft.parts, { type: 'text', text: 'while uploading' }]));
  expect(upload).toHaveBeenCalledTimes(1);
  expect(signal?.aborted).toBe(false);
  await rerender(container, <Harness session="b" upload={upload} />);
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve(attachment));
  expect(draft.parts).toEqual([]);
  expect(Object.keys(draft.images)).toEqual([]);
  await rerender(container, <Harness session="a" active={false} upload={upload} />);
  expect(draft.hasImages).toBe(true);
  expect(draft.ready).toBe(false);
});

it('keeps editable unavailable tags and reports storage failure without sending substitutes', async () => {
  vi.mocked(readImageDraft).mockResolvedValue({ version: 1, key: 'saved', scope: 'account', parts: [{ type: 'image', imageId: 'lost', label: 'image #7' }], images: { lost: { imageId: 'lost', uploadId: 'u', status: 'ready', progress: 1, attachment } }, nextLabel: 8 });
  const upload = vi.fn<UploadImage>();
  await render(<Harness scope="account" upload={upload} />);
  expect(draft.images.lost?.status).toBe('unavailable');
  expect(draft.ready).toBe(false);
  expect(() => draft.snapshot()).toThrow('not ready');
  expect(upload).not.toHaveBeenCalled();
  vi.mocked(readImageDraft).mockRejectedValue(new Error('denied'));
  const second = await render(<Harness session="denied" scope="account" />);
  expect(second.textContent).toContain('Saved draft could not be restored');
  await act(async () => draft.setText('Still editable'));
  expect(draft.parts).toEqual([{ type: 'text', text: 'Still editable' }]);
});

it('queues image-only uploads while hidden and preserves stable labels after removal', async () => {
  const upload = vi.fn<UploadImage>(async () => attachment);
  const container = await render(<Harness active={false} upload={upload} />);
  await act(async () => draft.setParts(draft.addFiles([new Blob(['x'], { type: 'image/png' })])));
  expect(upload).not.toHaveBeenCalled();
  await act(async () => draft.setParts([]));
  await act(async () => draft.setParts(draft.addFiles([new Blob(['y'], { type: 'image/png' })])));
  expect(draft.parts[0]).toMatchObject({ type: 'image', label: 'image #2' });
  await rerender(container, <Harness upload={upload} />);
  expect(draft.ready).toBe(true);
  expect(draft.snapshot()).toEqual([{ type: 'image', attachmentId: 'a', label: 'image #2' }]);
});

it('counts all newly imported image bytes before accepting a clipboard range', async () => {
  const blob = new Blob([new Uint8Array(8 * 1024 * 1024)], { type: 'image/png' });
  const container = await render(<Harness active={false} />);
  await act(async () => draft.setParts(draft.addFiles([blob, blob])));
  const copied = draft.parts;
  await rerender(container, <Harness session="b" active={false} />);
  await act(async () => draft.setParts(draft.addFiles([blob])));
  await act(async () => draft.setParts([...draft.parts, ...draft.importParts(copied)]));
  expect(draft.parts.filter(part => part.type === 'image')).toHaveLength(2);
  expect(draft.error).toContain('20 MiB');
});

it('checks retained image bytes when pasting an earlier deleted atom', async () => {
  const blob = new Blob([new Uint8Array(8 * 1024 * 1024)], { type: 'image/png' });
  await render(<Harness active={false} />);
  await act(async () => draft.setParts(draft.addFiles([blob])));
  const copied = draft.parts;
  await act(async () => draft.setParts([]));
  await act(async () => draft.setParts(draft.addFiles([blob, blob])));
  await act(async () => draft.setParts([...draft.parts, ...draft.importParts(copied)]));
  expect(draft.parts.filter(part => part.type === 'image')).toHaveLength(2);
  expect(draft.error).toContain('20 MiB');
});

it('migrates updated text when capability becomes available and preserves existing image edits', async () => {
  const container = await render(<Harness enabled={false} text="Old draft" />);
  await rerender(container, <Harness enabled={false} text="Edited during reconnect" />);
  await rerender(container, <Harness text="Edited during reconnect" />);
  expect(draft.parts).toEqual([{ type: 'text', text: 'Edited during reconnect' }]);
  await act(async () => draft.setParts([...draft.parts, ...draft.addFiles([new Blob(['x'], { type: 'image/png' })])]));
  const edited = draft.parts;
  await rerender(container, <Harness text="Late text-only recovery" />);
  expect(draft.parts).toEqual(edited);
});

it('revalidates restored ready attachments and rechecks them after reconnect', async () => {
  const blob = new Blob(['x'], { type: 'image/png' });
  vi.mocked(readImageDraft).mockResolvedValue({ version: 1, key: '["account","a"]', scope: 'account', parts: [{ type: 'image', imageId: 'restored', label: 'image #1' }], images: { restored: { imageId: 'restored', blob, uploadId: 'existing-upload', status: 'ready', progress: 1, attachment } }, nextLabel: 2 });
  const upload = vi.fn<UploadImage>(async () => ({ ...attachment, attachmentId: 'refreshed' }));
  const container = await render(<Harness scope="account" upload={upload} />);
  expect(draft.snapshot()[0]).toMatchObject({ attachmentId: 'refreshed' });
  expect(upload).toHaveBeenCalledTimes(1);
  await rerender(container, <Harness scope="account" active={false} upload={upload} />);
  upload.mockResolvedValue({ ...attachment, attachmentId: 'after-reconnect' });
  await rerender(container, <Harness scope="account" upload={upload} />);
  expect(draft.snapshot()[0]).toMatchObject({ attachmentId: 'after-reconnect' });
});

it('counts an image still referenced elsewhere when replacing one repeated atom', async () => {
  const blob = new Blob([new Uint8Array(8 * 1024 * 1024)], { type: 'image/png' });
  await render(<Harness active={false} />);
  let first!: Extract<ReturnType<typeof useImageDraft>['parts'][number], { type: 'image' }>;
  await act(async () => {
    const parts = draft.addFiles([blob, blob]);
    first = parts[0] as typeof first;
    draft.setParts([first, first, parts[1]!]);
  });
  let replacement: ReturnType<typeof draft.addFiles> = [];
  await act(async () => { replacement = draft.addFiles([blob], first.imageId); });
  expect(replacement).toEqual([]);
  expect(draft.error).toContain('20 MiB');
});

it('starts saving immediately and coalesces edits made while storage is busy', async () => {
  vi.mocked(readImageDraft).mockResolvedValue(undefined);
  await render(<Harness scope="batched-draft" />);
  let finish!: () => void;
  vi.mocked(writeImageDraft).mockClear();
  vi.mocked(writeImageDraft).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  for (let i = 0; i < 10; i++) await act(async () => draft.setText(`Edit ${i}`));
  expect(writeImageDraft).toHaveBeenCalledTimes(1);
  expect(writeImageDraft).toHaveBeenLastCalledWith(expect.objectContaining({ parts: [{ type: 'text', text: 'Edit 0' }] }), 0);
  await act(async () => finish());
  expect(writeImageDraft).toHaveBeenCalledTimes(2);
  expect(writeImageDraft).toHaveBeenLastCalledWith(expect.objectContaining({ parts: [{ type: 'text', text: 'Edit 9' }] }), 0);
});


it('clears the image storage warning after a later successful save', async () => {
  await render(<Harness scope="recover-save" active={false} />);
  vi.mocked(writeImageDraft).mockRejectedValueOnce(new Error('temporary storage failure'));
  await act(async () => draft.setParts(draft.addFiles([new Blob(['x'], { type: 'image/png' })])));
  expect(draft.storageError).toContain('Images are not saved');
  await act(async () => draft.setParts([...draft.parts, { type: 'text', text: 'caption' }]));
  expect(draft.storageError).toBeUndefined();
  expect(draft.hasImages).toBe(true);
});

it('does not warn about preserving images in a text-only or cleared draft', async () => {
  await render(<Harness scope="empty-storage" active={false} />);
  vi.mocked(writeImageDraft).mockRejectedValue(new Error('storage denied'));
  await act(async () => draft.setText('Text only'));
  expect(draft.storageError).toBeUndefined();
  await act(async () => draft.setParts(draft.addFiles([new Blob(['x'], { type: 'image/png' })])));
  expect(draft.storageError).toBeDefined();
  await act(async () => draft.setText(''));
  expect(draft.storageError).toBeUndefined();
});

it('retries failed persistence on foreground return without requiring another edit', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  await render(<Harness scope="foreground-save" active={false} />);
  vi.mocked(writeImageDraft).mockRejectedValueOnce(new Error('storage interrupted'));
  await act(async () => draft.setParts(draft.addFiles([new Blob(['x'], { type: 'image/png' })])));
  expect(draft.storageError).toBeDefined();
  const calls = vi.mocked(writeImageDraft).mock.calls.length;
  await act(async () => { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')); });
  expect(writeImageDraft).toHaveBeenCalledTimes(calls);
  await act(async () => { visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')); });
  expect(writeImageDraft).toHaveBeenCalledTimes(calls + 1);
  expect(draft.storageError).toBeUndefined();
});

it('preserves saved data after a failed read and restores it on explicit retry', async () => {
  const saved: ImageDraft = { version: 1, key: '["restore-read","a"]', scope: 'restore-read', parts: [{ type: 'text', text: 'Saved content' }], images: {}, nextLabel: 1 };
  vi.mocked(readImageDraft).mockRejectedValueOnce(new Error('temporarily unavailable')).mockResolvedValue(saved);
  await render(<Harness scope="restore-read" active={false} />);
  expect(draft.storageError).toContain('Saved draft could not be restored');
  expect(writeImageDraft).not.toHaveBeenCalled();
  await act(async () => draft.retryStorage());
  expect(draft.parts).toEqual(saved.parts);
  expect(draft.storageError).toBeUndefined();
});

it('keeps edits made after a failed read when recovery succeeds', async () => {
  vi.mocked(readImageDraft).mockRejectedValueOnce(new Error('temporarily unavailable')).mockResolvedValue({ version: 1, key: 'saved', scope: 'retry-edit', parts: [{ type: 'text', text: 'Old content' }], images: {}, nextLabel: 1 });
  await render(<Harness scope="retry-edit" active={false} />);
  await act(async () => draft.setText('New content'));
  await act(async () => draft.retryStorage());
  expect(draft.parts).toEqual([{ type: 'text', text: 'New content' }]);
  expect(draft.storageError).toBeUndefined();
});


it('uploads images recovered by a later successful read', async () => {
  const blob = new Blob(['x'], { type: 'image/png' });
  vi.mocked(readImageDraft).mockRejectedValueOnce(new Error('interrupted')).mockResolvedValue({ version: 1, key: 'saved', scope: 'later-restore', parts: [{ type: 'image', imageId: 'restored', label: 'image #1' }], images: { restored: { imageId: 'restored', blob, uploadId: 'u', status: 'ready', progress: 1, attachment } }, nextLabel: 2 });
  const upload = vi.fn<UploadImage>(async () => attachment);
  await render(<Harness scope="later-restore" upload={upload} />);
  expect(upload).not.toHaveBeenCalled();
  await act(async () => draft.retryStorage());
  expect(upload).toHaveBeenCalledTimes(1);
  expect(draft.ready).toBe(true);
  expect(draft.storageError).toBeUndefined();
});

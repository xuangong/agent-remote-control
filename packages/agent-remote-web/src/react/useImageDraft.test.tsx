import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ImageDraft } from '../image-drafts.js';
import { readImageDraft, writeImageDraft, inspectImageDraft, configureImageDraftPersistence } from '../image-drafts.js';
import { render, rerender, unmount } from '../test/setup.js';
import { useImageDraft, type UploadImage } from './useImageDraft.js';
vi.mock('../image-drafts.js', async importOriginal => ({ ...await importOriginal<typeof import('../image-drafts.js')>(), readImageDraft: vi.fn(), writeImageDraft: vi.fn(async () => ({ status: 'saved', retention: 'local' })) }));
let draft!: ReturnType<typeof useImageDraft>;
function Harness({ session = 'a', active = true, scope, upload, text = '', enabled = true, binding, recipient, onRender }: { session?: string; active?: boolean; scope?: string; upload?: UploadImage; text?: string; enabled?: boolean; binding?: { scope: string; key: string }; recipient?: { identity: string; lifetime: object; isCurrent(): boolean }; onRender?(): void }) {
  draft = useImageDraft({ sessionKey: session, scope, text, enabled, active, upload, binding, recipient, onTextChange: () => {} });
  onRender?.();
  return <span>{draft.storageError}</span>;
}
const attachment = { attachmentId: 'a', sha256: 'a'.repeat(64), mediaType: 'image/png' as const, byteLength: 1, imageDimensions: { width: 1, height: 1 } };
beforeEach(() => { vi.mocked(readImageDraft).mockReset().mockResolvedValue(undefined); vi.mocked(writeImageDraft).mockReset().mockResolvedValue({ status: 'saved', retention: 'local' }); });
afterEach(() => { configureImageDraftPersistence(() => true); vi.restoreAllMocks(); });

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
  await act(async () => draft.setParts([...draft.parts, ...await draft.importParts(copied)]));
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
  await act(async () => draft.setParts([...draft.parts, ...await draft.importParts(copied)]));
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

it('does not claim an image storage owner for a text-only preview and restores it when enabled', async () => {
  configureImageDraftPersistence(() => false);
  const binding = { scope: 'preview-draft', key: 'preview-draft-key' };
  const container = await render(<Harness binding={binding} enabled={false} text="Old text" />);
  await rerender(container, <Harness binding={binding} enabled={false} text="Edited during recovery" />);
  expect(writeImageDraft).not.toHaveBeenCalled();
  const handle = await inspectImageDraft(binding);
  expect(handle.snapshot()).toMatchObject({ status: 'ready', revision: 0, savedRevision: 0 });
  await rerender(container, <Harness binding={binding} active={false} text="Edited during recovery" />);
  expect(draft.parts).toEqual([{ type: 'text', text: 'Edited during recovery' }]);
  const restored = await inspectImageDraft(binding);
  await act(async () => {
    const snapshot = restored.snapshot(), saved = await restored.flush(snapshot.revision, () => true);
    expect(saved).toMatchObject({ status: 'ready', savedRevision: snapshot.revision, draft: { parts: [{ type: 'text', text: 'Edited during recovery' }] } });
  });
});

it('finishes an existing image draft write when disabled and retains the image while inactive', async () => {
  const binding = { scope: 'disabled-draft', key: 'disabled-image-key' };
  const upload = vi.fn<UploadImage>();
  const container = await render(<Harness binding={binding} active={false} upload={upload} />);
  let finish!: () => void;
  vi.mocked(writeImageDraft).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ status: 'saved', retention: 'local' }); }));
  await act(async () => draft.setParts(draft.addFiles([new Blob(['x'], { type: 'image/png' })])));
  const expected = draft.parts;
  await act(async () => { window.dispatchEvent(new Event('pagehide')); });
  await rerender(container, <Harness binding={binding} active={false} enabled={false} upload={upload} />);
  expect(draft.parts).toEqual(expected);
  await act(async () => finish());
  await rerender(container, <Harness binding={binding} active={false} upload={upload} />);
  expect(draft.parts).toEqual(expected);
  expect(draft.hasImages).toBe(true);
  expect(upload).not.toHaveBeenCalled();
  const restored = await inspectImageDraft(binding), snapshot = restored.snapshot();
  await act(async () => expect(await restored.flush(snapshot.revision, () => true)).toMatchObject({ status: 'ready', savedRevision: snapshot.revision }));
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

it('coalesces edits while storage is busy after the first write window', async () => {
  vi.useFakeTimers();
  vi.mocked(readImageDraft).mockResolvedValue(undefined);
  await render(<Harness scope="batched-draft" />);
  let finish!: () => void;
  vi.mocked(writeImageDraft).mockClear();
  vi.mocked(writeImageDraft).mockImplementationOnce(() => new Promise<Awaited<ReturnType<typeof writeImageDraft>>>(resolve => { finish = () => resolve({ status: 'saved', retention: 'local' }); }));
  await act(async () => draft.setText('Edit 0'));
  await act(async () => vi.advanceTimersByTimeAsync(250));
  for (let i = 1; i < 10; i++) await act(async () => draft.setText(`Edit ${i}`));
  expect(writeImageDraft).toHaveBeenCalledTimes(1);
  expect(writeImageDraft).toHaveBeenLastCalledWith(expect.objectContaining({ parts: [{ type: 'text', text: 'Edit 0' }] }), 0);
  await act(async () => finish());
  expect(writeImageDraft).toHaveBeenCalledTimes(2);
  expect(writeImageDraft).toHaveBeenLastCalledWith(expect.objectContaining({ parts: [{ type: 'text', text: 'Edit 9' }] }), 0);
  vi.useRealTimers();
});


it('clears the image storage warning after a later successful save', async () => {
  await render(<Harness scope="recover-save" active={false} />);
  vi.mocked(writeImageDraft).mockRejectedValueOnce(new Error('temporary storage failure'));
  await act(async () => draft.setParts(draft.addFiles([new Blob(['x'], { type: 'image/png' })])));
  expect(draft.storageError).toContain('Images are not saved');
  vi.useFakeTimers();
  await act(async () => draft.setParts([...draft.parts, { type: 'text', text: 'caption' }]));
  await act(async () => vi.advanceTimersByTimeAsync(250));
  vi.useRealTimers();
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

it('batches normal typing in fixed windows and flushes the latest text on pagehide', async () => {
  vi.useFakeTimers();
  try {
    await render(<Harness scope="typing-window" />);
    vi.mocked(writeImageDraft).mockClear();
    for (let i = 0; i < 3; i++) {
      await act(async () => draft.setText(`Edit ${i}`));
      await act(async () => vi.advanceTimersByTimeAsync(70));
    }
    expect(writeImageDraft).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(40));
    expect(writeImageDraft).toHaveBeenCalledTimes(1);
    expect(writeImageDraft).toHaveBeenLastCalledWith(expect.objectContaining({ parts: [{ type: 'text', text: 'Edit 2' }] }), 0);
    await act(async () => draft.setText('Last edit'));
    await act(async () => window.dispatchEvent(new Event('pagehide')));
    expect(writeImageDraft).toHaveBeenLastCalledWith(expect.objectContaining({ parts: [{ type: 'text', text: 'Last edit' }] }), 0);
  } finally { vi.useRealTimers(); }
});

const retainedBinding = { scope: '', key: 'opaque-retained-owner' };
const recipient = (identity: string) => ({ identity, lifetime: {}, isCurrent: () => true });

it('rejects a ready receipt synchronously when the same storage owner selects another recipient', async () => {
  const a = recipient('host/provider/A'), b = recipient('host/provider/B');
  const uploadA = vi.fn<UploadImage>(async () => attachment);
  let finishB!: (value: typeof attachment) => void;
  const uploadB = vi.fn<UploadImage>(() => new Promise(resolve => { finishB = resolve; }));
  const container = await render(<Harness binding={retainedBinding} recipient={a} upload={uploadA} />);
  await act(async () => draft.setParts(draft.addFiles([new Blob(['x'], { type: 'image/png' })])));
  expect(draft.ready).toBe(true);
  const parts = draft.parts;
  let firstRender = true, renderedReady = true, snapshotRejected = false;
  await rerender(container, <Harness binding={retainedBinding} recipient={b} upload={uploadB} onRender={() => {
    if (!firstRender) return; firstRender = false;
    renderedReady = draft.ready;
    try { draft.snapshot(); } catch { snapshotRejected = true; }
  }} />);
  expect(renderedReady).toBe(false);
  expect(snapshotRejected).toBe(true);
  expect(draft.parts).toEqual(parts);
  await act(async () => finishB({ ...attachment, attachmentId: 'B' }));
  expect(draft.snapshot()[0]).toMatchObject({ attachmentId: 'B' });
});

it('retires held A and B uploads without corrupting C or borrowing a newer uploader', async () => {
  const a = recipient('A'), b = recipient('B'), c = recipient('C');
  const held: Array<{ finish(value: typeof attachment): void; signal?: AbortSignal; progress?: (loaded: number, total: number) => void }> = [];
  const uploadHeld = vi.fn<UploadImage>((_blob, _id, options) => new Promise(finish => held.push({ finish, signal: options?.signal, progress: options?.onProgress })));
  const container = await render(<Harness binding={retainedBinding} recipient={a} upload={uploadHeld} />);
  await act(async () => draft.setParts(draft.addFiles([new Blob(['x'], { type: 'image/png' }), new Blob(['y'], { type: 'image/png' })])));
  await rerender(container, <Harness binding={retainedBinding} recipient={b} upload={uploadHeld} />);
  expect(held[0]?.signal?.aborted).toBe(true);
  const uploadC = vi.fn<UploadImage>(async () => ({ ...attachment, attachmentId: 'C' }));
  await rerender(container, <Harness binding={retainedBinding} recipient={c} upload={uploadC} />);
  expect(held[1]?.signal?.aborted).toBe(true);
  await act(async () => { held[1]?.progress?.(1, 2); held[1]?.finish(attachment); held[0]?.finish(attachment); });
  expect(uploadHeld).toHaveBeenCalledTimes(2);
  expect(uploadC).toHaveBeenCalledTimes(2);
  expect(draft.snapshot().every(part => part.type === 'image' && part.attachmentId === 'C')).toBe(true);
});

it('requires explicit recipient authority for decoupled storage and keeps inactive projection native-free', async () => {
  const upload = vi.fn<UploadImage>(async () => attachment);
  const container = await render(<Harness binding={retainedBinding} upload={upload} />);
  await act(async () => draft.setParts(draft.addFiles([new Blob(['x'], { type: 'image/png' })])));
  expect(upload).not.toHaveBeenCalled();
  expect(draft.ready).toBe(false);
  const b = recipient('B');
  await rerender(container, <Harness binding={retainedBinding} recipient={b} active={false} upload={upload} />);
  expect(upload).not.toHaveBeenCalled();
  expect(draft.hasImages).toBe(true);
  await rerender(container, <Harness binding={retainedBinding} recipient={b} upload={upload} />);
  expect(draft.ready).toBe(true);
});

it('retires equal native identity with a replacement lifetime but ignores wrapper churn', async () => {
  const a = recipient('A');
  const upload = vi.fn<UploadImage>(async () => attachment);
  const container = await render(<Harness binding={retainedBinding} recipient={a} upload={upload} />);
  await act(async () => draft.setParts(draft.addFiles([new Blob(['x'], { type: 'image/png' })])));
  await rerender(container, <Harness binding={retainedBinding} recipient={{ ...a }} upload={(...args) => upload(...args)} />);
  expect(upload).toHaveBeenCalledTimes(1);
  await rerender(container, <Harness binding={retainedBinding} recipient={recipient('A')} upload={upload} />);
  expect(upload).toHaveBeenCalledTimes(2);
  a.isCurrent = () => false;
});

it('does not expose bytes when the same opaque disk key is requested under another scope', async () => {
  const a = recipient('A');
  const container = await render(<Harness binding={{ scope: 'scope-A', key: 'shared-K' }} recipient={a} active={false} />);
  await act(async () => draft.setParts(draft.addFiles([new Blob(['private'], { type: 'image/png' })])));
  const saved = { version: 1 as const, key: 'shared-K', scope: 'scope-A', parts: draft.parts, images: draft.images, nextLabel: 2 };
  vi.mocked(readImageDraft).mockResolvedValue(saved);
  await rerender(container, <Harness binding={{ scope: 'scope-B', key: 'shared-K' }} recipient={recipient('B')} active={false} />);
  expect(draft.parts).toEqual([]);
  expect(draft.storageError).toContain('Saved draft could not be restored');
});
it('inspects the current writer and waits for queued storage without uploading', async () => {
  const binding = { scope: 'writer-evidence', key: 'opaque-writer' };
  const upload = vi.fn<UploadImage>();
  await render(<Harness binding={binding} active={false} upload={upload} />);
  await act(async () => draft.setText('Unflushed edit'));
  let inspection = await inspectImageDraft(binding);
  expect(inspection.snapshot().draft?.parts).toEqual([{ type: 'text', text: 'Unflushed edit' }]);
  const revision = inspection.snapshot().revision;
  await act(async () => { expect(await inspection.flush(revision, () => true)).toMatchObject({ status: 'ready', savedRevision: revision, retention: 'local' }); });
  expect(upload).not.toHaveBeenCalled();
  await act(async () => draft.setText('New edit'));
  expect(await inspection.flush(revision, () => true)).toMatchObject({ status: 'cancelled' });
});

it('retries a released failed writer and restores its exact content in a replacement editor', async () => {
  const binding = { scope: 'released-writer', key: 'released-K' };
  let disk: ImageDraft | undefined;
  let full = true;
  vi.mocked(readImageDraft).mockImplementation(async () => disk);
  vi.mocked(writeImageDraft).mockImplementation(async value => {
    if (full) throw new Error('Full');
    disk = value; return { status: 'saved', retention: 'local' };
  });
  const container = await render(<Harness binding={binding} active={false} />);
  await act(async () => draft.setParts(draft.addFiles([new Blob(['keep'], { type: 'image/png' })])));
  const parts = draft.parts;
  await unmount(container);
  const handle = await inspectImageDraft(binding);
  expect(handle.snapshot()).toMatchObject({ status: 'failed', draft: { parts } });
  expect((await handle.flush(handle.snapshot().revision, () => false)).status).toBe('cancelled');
  expect((await inspectImageDraft(binding)).snapshot()).toMatchObject({ status: 'failed', draft: { parts } });
  full = false;
  await act(async () => { const saved = await handle.flush(handle.snapshot().revision, () => true); expect(saved.status).toBe('ready'); expect(saved.savedRevision).toBe(saved.revision); });
  await render(<Harness binding={binding} active={false} />);
  expect(draft.parts).toEqual(parts);
  expect(Object.values(draft.images)[0]?.blob?.size).toBe(4);
  expect((await inspectImageDraft(binding)).snapshot().status).toBe('ready');
});

it('retries an unmounted failed read through checked retention before certifying saved images', async () => {
  const binding = { scope: 'released-read', key: 'read-K' };
  vi.mocked(readImageDraft).mockRejectedValue(new Error('Unavailable'));
  const container = await render(<Harness binding={binding} active={false} />);
  await unmount(container);
  const original = { version: 1 as const, ...binding, parts: [{ type: 'text' as const, text: 'Original' }], images: {}, nextLabel: 1 };
  vi.mocked(readImageDraft).mockResolvedValue(original);
  const handle = await inspectImageDraft(binding);
  await act(async () => { expect(await handle.flush(handle.snapshot().revision, () => true)).toMatchObject({ status: 'ready', draft: { parts: original.parts } }); });
});

it('fences same-key A and B held receipts before sending C through a real WebSocket', async () => {
  const { randomUUID, webcrypto } = await import('node:crypto');
  const { Blob: NodeBlob } = await import('node:buffer');
  const { URL: NodeURL } = await import('node:url');
  const { uploadImage } = await import('../client/image-upload.js');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { once } = await import('node:events');
  const { default: WebSocket } = await import('ws');
  const { PROTOCOL_VERSION } = await import('@orchardworks/agent-remote-protocol');
  const { IMAGE_INPUT_CAPABILITIES } = await import('../../../agent-provider-sdk/src/index.js');
  const { InputImageStore } = await import('../../../agent-remote-relay/src/resources/input-image-store.js');
  const { createAgentRemoteRelay } = await import('../../../agent-remote-relay/src/relay.js');
  const { createAgentRemoteHttpServer } = await import('../../../agent-remote-relay/src/transport/http-server.js');
  type ServerMessage = import('@orchardworks/agent-remote-protocol').ServerMessage;
  type InputPart = import('../../../agent-provider-sdk/src/index.js').AgentInputPart;
  const directory = await mkdtemp(join(tmpdir(), 'draft-binding-wire-'));
  const sent: Array<{ native: string; parts: readonly InputPart[] }> = [];
  const provider: import('../../../agent-provider-sdk/src/index.js').AgentProviderAdapter = {
    descriptor: { providerId: 'vision', displayName: 'Vision fixture' },
    async createSession(config) {
      let finish!: () => void; const ended = new Promise<void>(resolve => { finish = resolve; });
      return { capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, imageInput: IMAGE_INPUT_CAPABILITIES,
        interactions: { question: false, planApproval: false, toolApproval: false } },
        async *observe() { yield { type: 'history_boundary' as const }; await ended; },
        async sendMessage() {}, async sendMessageContent(parts) { sent.push({ native: String(config.sessionId), parts }); },
        async respondToInteraction() {}, async runtimeInfo() { return { providerId: 'vision', sessionId: config.sessionId, status: 'idle' as const }; },
        async dispose() { finish(); } };
    }, async resumeSession() { throw new Error('Unused'); },
  };
  const relay = createAgentRemoteRelay({ providers: [provider], inputImageStore: new InputImageStore({ directory }) });
  const server = createAgentRemoteHttpServer(relay, { websocketAuthorizer: { authenticate: () => ({ subject: 'fixture-owner' }), authorize: () => true } });
  const sockets: import('ws').WebSocket[] = [];
  let container: HTMLDivElement | undefined;
  const release: Array<() => void> = [];
  vi.stubGlobal('crypto', webcrypto);
  try {
    const { url } = await server.listen(0, '127.0.0.1');
    async function connect(agentId: string) {
      await relay.createAgent({ protocolVersion: PROTOCOL_VERSION, type: 'create_agent', payload: { requestId: randomUUID(), operationId: randomUUID(), agentId, providerId: 'vision', config: { sessionId: agentId } } });
      const socket = new WebSocket(`${url.replace('http', 'ws')}/v1/sessions/${agentId}/events`); sockets.push(socket);
      const messages: ServerMessage[] = []; const listeners = new Set<() => void>();
      socket.on('message', data => { messages.push(JSON.parse(String(data))); for (const listener of listeners) listener(); });
      await once(socket, 'open');
      let phase = 'negotiate';
      const next = (predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Wire deadline during ${phase}.`)); }, 2000);
        function check() { const index = messages.findIndex(predicate); if (index >= 0) { clearTimeout(timer); listeners.delete(check); resolve(messages.splice(index, 1)[0]!); } }
        listeners.add(check); check();
      });
      socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' }));
      await next(message => message.type === 'negotiated');
      const state = await next(message => message.type === 'session_control');
      if (state.type !== 'session_control') throw new Error('Missing control');
      phase = 'control';
      socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'session_control_request', payload: { agentId, requestId: 'control', action: 'take_over', revision: state.payload.revision } }));
      const control = await next(message => message.type === 'session_control' && message.payload.requestId === 'control');
      if (control.type !== 'session_control') throw new Error('Missing control receipt');
      return async (type: string, payload: Record<string, unknown>) => {
        const requestId = randomUUID(); phase = type;
        socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type, controlToken: control.payload.token, payload: { ...payload, agentId, requestId } }));
        return next(message => 'payload' in message && 'requestId' in message.payload && message.payload.requestId === requestId);
      };
    }
    const bytes = await readFile(new NodeURL('../../../agent-remote-relay/src/resources/fixtures/dimensions.png', import.meta.url));
    const file = new NodeBlob([new Uint8Array(bytes)], { type: 'image/png' });
    const requests = { A: await connect('A'), B: await connect('B'), C: await connect('C') };
    const receipts: Partial<Record<'A' | 'B' | 'C', typeof attachment>> = {};
    const signals: Partial<Record<'A' | 'B' | 'C', AbortSignal | undefined>> = {};
    const progress: Partial<Record<'A' | 'B' | 'C', ((loaded: number, total: number) => void) | undefined>> = {};
    const uploaded: string[] = [];
    const holdA = new Promise<void>(resolve => release.push(resolve));
    const holdB = new Promise<void>(resolve => release.push(resolve));
    let holdAReceipt = false;
    const uploader = (native: 'A' | 'B' | 'C'): UploadImage => async (blob, uploadId, options) => {
      signals[native] = options?.signal; progress[native] = options?.onProgress;
      const receipt = await uploadImage(blob, uploadId, async message => {
        const { type, ...payload } = message;
        const response = await requests[native](type, { uploadId, ...payload });
        if (response.type !== 'image_upload_result') throw new Error(`Upload failed: ${response.type}`);
        return response.payload;
      }, options);
      receipts[native] = receipt; uploaded.push(native);
      if (native === 'A' && holdAReceipt) await holdA;
      if (native === 'B') await holdB;
      return receipt;
    };
    const uploadA = uploader('A'), uploadB = uploader('B'), uploadC = uploader('C');
    const a = recipient('vision/A'), b = recipient('vision/B'), c = recipient('vision/C');
    const binding = { scope: '', key: 'real-shared-K' };
    container = await render(<Harness binding={binding} recipient={a} upload={uploadA} />);
    await act(async () => draft.setParts(draft.addFiles([file])));
    await act(async () => { await vi.waitFor(() => expect(uploaded).toEqual(['A'])); });
    expect(draft.ready).toBe(true);
    expect(draft.snapshot()[0]).toMatchObject({ attachmentId: receipts.A!.attachmentId });
    const retainedParts = draft.parts, oldSnapshot = draft.snapshot;
    let firstRender = true, inactiveReady = true, inactiveSnapshotRejected = false;
    await rerender(container, <Harness binding={binding} recipient={a} active={false} upload={uploadA} onRender={() => {
      if (!firstRender) return; firstRender = false; inactiveReady = draft.ready;
      try { draft.snapshot(); } catch { inactiveSnapshotRejected = true; }
    }} />);
    expect(inactiveReady).toBe(false);
    expect(inactiveSnapshotRejected).toBe(true);
    expect(draft.digests()).toEqual({});
    expect(() => oldSnapshot()).toThrow('not ready');
    expect(uploaded).toEqual(['A']);
    holdAReceipt = true;
    await rerender(container, <Harness binding={binding} recipient={a} upload={uploadA} />);
    await act(async () => { await vi.waitFor(() => expect(uploaded).toEqual(['A', 'A'])); });
    expect(draft.ready).toBe(false);
    await rerender(container, <Harness binding={binding} recipient={b} upload={uploadB} />);
    expect(signals.A?.aborted).toBe(true);
    expect(() => draft.snapshot()).toThrow('not ready');
    await act(async () => { await vi.waitFor(() => expect(uploaded).toEqual(['A', 'A', 'B'])); });
    expect(() => draft.snapshot()).toThrow('not ready');
    expect(draft.digests()).toEqual({});
    firstRender = true; let cSnapshotRejected = false;
    await rerender(container, <Harness binding={binding} recipient={c} upload={uploadC} onRender={() => {
      if (!firstRender) return; firstRender = false;
      try { draft.snapshot(); } catch { cSnapshotRejected = true; }
    }} />);
    expect(cSnapshotRejected).toBe(true);
    expect(signals.B?.aborted).toBe(true);
    await act(async () => { await vi.waitFor(() => expect(uploaded).toEqual(['A', 'A', 'B', 'C'])); });
    expect(draft.ready).toBe(true);
    const content = draft.snapshot(), digests = draft.digests();
    expect(content).toEqual([{ type: 'image', attachmentId: receipts.C!.attachmentId, label: 'image #1' }]);
    expect(receipts.C!.attachmentId).not.toBe(receipts.A!.attachmentId);
    expect(receipts.C!.attachmentId).not.toBe(receipts.B!.attachmentId);
    await act(async () => { progress.B?.(1, 100); release[1]!(); progress.A?.(1, 100); release[0]!(); });
    expect(draft.snapshot()).toEqual(content);
    expect(draft.digests()).toEqual(digests);
    expect(draft.parts).toEqual(retainedParts);
    expect(Object.values(draft.images)[0]).toMatchObject({ progress: 1, status: 'ready', attachment: receipts.C });
    expect(sent).toEqual([]);
    expect(await requests.C('send_message', { operationId: randomUUID(), content: draft.snapshot() })).toMatchObject({ type: 'command_acknowledged' });
    expect(sent.map(value => value.native)).toEqual(['C']);
    const image = sent[0]!.parts[0]!;
    if (image.type !== 'image') throw new Error('Missing native image');
    expect(await readFile(image.path)).toEqual(bytes);
  } finally {
    for (const finish of release) finish();
    if (container) await unmount(container);
    for (const socket of sockets) socket.terminate();
    await server.close(); await relay.close(); await rm(directory, { recursive: true, force: true });
    vi.unstubAllGlobals();
  }
});

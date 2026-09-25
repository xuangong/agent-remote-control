// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { ImageUploadReceipt } from '@orchardworks/agent-remote-protocol';
import { uploadImage } from './image-upload.js';

const attachment = { attachmentId: 'image-one', sha256: '', mediaType: 'image/png' as const, byteLength: 70000, imageDimensions: { width: 1, height: 1 } };
describe('image upload', () => {
  it('resumes from the acknowledged offset', async () => {
    const file = new Blob([new Uint8Array(70000)], { type: 'image/png' });
    const offsets: number[] = [];
    let digest = '';
    const result = await uploadImage(file, 'upload-one', async request => {
      await Promise.resolve();
      if (request.type === 'image_upload_begin') { digest = request.sha256; return { uploadId: 'upload-one', offset: 123 }; }
      if (request.type === 'image_upload_chunk') {
        offsets.push(request.offset);
        const length = atob(request.contentBase64).length;
        expect(length).toBeLessThanOrEqual(32768);
        return { uploadId: 'upload-one', offset: request.offset + length };
      }
      return { uploadId: 'upload-one', offset: 70000, attachment: { ...attachment, sha256: digest } };
    });
    expect(offsets).toEqual([123, 32891, 65659]);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  function controlledUpload(signal?: AbortSignal) {
    const size = 10 * 32768 + 17;
    const chunks: { offset: number; accept(): void; reject(error: Error): void }[] = [];
    const progress: number[] = [];
    let finishes = 0;
    let digest = '';
    const result = uploadImage(new Blob([new Uint8Array(size)], { type: 'image/png' }), 'u', async request => {
      if (request.type === 'image_upload_begin') { digest = request.sha256; return { uploadId: 'u', offset: 123 }; }
      if (request.type === 'image_upload_finish') {
        finishes++;
        return { uploadId: 'u', offset: size, attachment: { ...attachment, sha256: digest, byteLength: size } };
      }
      return new Promise<ImageUploadReceipt>((resolve, reject) => {
        chunks.push({ offset: request.offset, reject,
          accept: () => resolve({ uploadId: 'u', offset: request.offset + atob(request.contentBase64).length }) });
      });
    }, { signal, onProgress: loaded => progress.push(loaded) });
    // Observe rejection immediately, including failures in non-head requests.
    let settled = false;
    const outcome = result.then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    return { chunks, progress, result, outcome, finishes: () => finishes, settled: () => settled };
  }

  it('fills eight ordered slots, refills after acknowledgement, and finishes only after all receipts', async () => {
    const upload = controlledUpload();
    await vi.waitFor(() => expect(upload.chunks).toHaveLength(8), { timeout: 1000, interval: 5 });
    expect(upload.chunks.map(chunk => chunk.offset)).toEqual(Array.from({ length: 8 }, (_, i) => 123 + i * 32768));
    expect(upload.progress).toEqual([123]);
    expect(upload.finishes()).toBe(0);
    upload.chunks[1]!.accept();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(upload.progress).toEqual([123]);
    expect(upload.chunks).toHaveLength(8);
    upload.chunks[0]!.accept();
    await vi.waitFor(() => expect(upload.chunks).toHaveLength(10), { timeout: 1000, interval: 5 });
    expect(upload.progress).toEqual([123, 32891, 65659]);
    for (const chunk of upload.chunks.slice(2, 9)) chunk.accept();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(upload.finishes()).toBe(0);
    upload.chunks[9]!.accept();
    await expect(upload.result).resolves.toMatchObject({ byteLength: 10 * 32768 + 17 });
    expect(upload.finishes()).toBe(1);
    expect(upload.progress.at(-1)).toBe(10 * 32768 + 17);
  });

  it.each(['failure', 'abort'] as const)('stops scheduling and drains in-flight chunks on %s', async mode => {
    const abort = new AbortController();
    const upload = controlledUpload(abort.signal);
    await vi.waitFor(() => expect(upload.chunks).toHaveLength(8), { timeout: 1000, interval: 5 });
    if (mode === 'abort') abort.abort();
    else upload.chunks[7]!.reject(new Error('Host disconnected'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(upload.settled()).toBe(false);
    for (const chunk of upload.chunks) chunk.accept();
    const outcome = await upload.outcome;
    expect(outcome).toHaveProperty('error');
    if ('error' in outcome) expect(outcome.error).toMatchObject(mode === 'abort' ? { name: 'AbortError' } : { message: 'Host disconnected' });
    expect(upload.chunks).toHaveLength(8);
    expect(upload.finishes()).toBe(0);
  });

  it('rejects an abort while awaiting a receipt without sending more chunks', async () => {
    const abort = new AbortController();
    let requests = 0;
    const pending = uploadImage(new Blob(['abc'], { type: 'image/png' }), 'u', async () => {
      requests++;
      abort.abort();
      return { uploadId: 'u', offset: 0 };
    }, { signal: abort.signal });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toBe(1);
  });

  it('rejects a receipt that does not advance the accepted offset', async () => {
    await expect(uploadImage(new Blob(['abc'], { type: 'image/png' }), 'u', async () => ({ uploadId: 'u', offset: 0 }))).rejects.toThrow(/offset/i);
  });
});

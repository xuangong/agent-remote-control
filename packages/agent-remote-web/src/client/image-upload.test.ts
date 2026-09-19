// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { uploadImage } from './image-upload.js';

const attachment = { attachmentId: 'image-one', sha256: '', mediaType: 'image/png' as const, byteLength: 70000, imageDimensions: { width: 1, height: 1 } };
describe('image upload', () => {
  it('resumes from the acknowledged offset and keeps only one chunk in flight', async () => {
    const file = new Blob([new Uint8Array(70000)], { type: 'image/png' });
    const offsets: number[] = [];
    let inFlight = 0;
    let digest = '';
    const result = await uploadImage(file, 'upload-one', async request => {
      expect(++inFlight).toBe(1);
      await Promise.resolve();
      inFlight--;
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

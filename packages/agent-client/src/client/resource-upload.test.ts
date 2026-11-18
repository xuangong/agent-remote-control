// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { uploadResource, downloadResource } from './resource-upload.js';

describe('resource transfer', () => {
  it('uploads generic binary bytes and verifies the final receipt', async () => {
    const file = new Blob([new Uint8Array([0, 255, 1, 2])]);
    let digest = ''; const bytes: number[] = [];
    const result = await uploadResource(file, 'fixture.zip', 'upload', async request => {
      if (request.type === 'resource_upload_begin') { digest = request.sha256; expect(request.name).toBe('fixture.zip'); return { uploadId: 'upload', offset: 0 }; }
      if (request.type === 'resource_upload_chunk') { bytes.push(...Uint8Array.from(atob(request.contentBase64), x => x.charCodeAt(0))); return { uploadId: 'upload', offset: bytes.length }; }
      return { uploadId: 'upload', offset: bytes.length, resource: { resourceId: 'resource-one', name: 'fixture.zip', mediaType: 'application/octet-stream', byteLength: 4, sha256: digest } };
    });
    expect(bytes).toEqual([0, 255, 1, 2]); expect(result.resourceId).toBe('resource-one');
  });
  it('rejects a corrupt receipt and cancellation before transfer', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(uploadResource(new Blob(['x']), 'x', 'u', async () => { throw new Error('must not call'); }, { signal: controller.signal })).rejects.toThrow();
    await expect(uploadResource(new Blob(['x']), 'x', 'u', async () => ({ uploadId: 'u', offset: 1, resource: { resourceId: 'r', name: 'x', byteLength: 1, mediaType: 'application/octet-stream', sha256: '0'.repeat(64) } }))).rejects.toThrow(/verify/);
  });
  it('downloads chunks and verifies their complete digest before exposing a blob', async () => {
    const bytes = new TextEncoder().encode('hello');
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    const result = await downloadResource('r', async offset => ({ resourceId: 'r', offset, byteLength: 5, sha256, name: 'log.txt', mediaType: 'text/plain', contentBase64: btoa(offset === 0 ? 'he' : 'llo') }));
    expect(await result.blob.text()).toBe('hello');
    await expect(downloadResource('r', async offset => ({ resourceId: 'r', offset, byteLength: 5, sha256, name: 'log.txt', mediaType: 'text/plain', contentBase64: btoa('wrong') }))).rejects.toThrow(/integrity/);
  });
});
it('resumes from a verified Host offset and accepts an empty file', async () => {
  for (const text of ['abcdef', '']) {
    const blob = new Blob([text]); let sha256 = ''; const offsets: number[] = [];
    const result = await uploadResource(blob, 'file', 'u', async message => {
      if (message.type === 'resource_upload_begin') { sha256 = message.sha256; return { uploadId: 'u', offset: text ? 3 : 0 }; }
      if (message.type === 'resource_upload_chunk') { offsets.push(message.offset); expect(atob(message.contentBase64)).toBe('def'); return { uploadId: 'u', offset: blob.size }; }
      return { uploadId: 'u', offset: blob.size, resource: { resourceId: 'r', name: 'file', byteLength: blob.size, sha256, mediaType: 'application/octet-stream' } };
    });
    expect(offsets).toEqual(text ? [3] : []); expect(result.byteLength).toBe(blob.size);
  }
});

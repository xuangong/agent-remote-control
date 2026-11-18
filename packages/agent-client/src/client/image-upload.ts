import type { ImageMediaType, ImageUploadReceipt } from '@orchardworks/agent-remote-protocol';

export type ImageUploadRequest =
  | { type: 'image_upload_begin'; sha256: string; byteLength: number; mediaType: ImageMediaType }
  | { type: 'image_upload_chunk'; offset: number; contentBase64: string }
  | { type: 'image_upload_finish' };
export interface ImageUploadOptions {
  signal?: AbortSignal;
  onProgress?(loaded: number, total: number): void;
}
const digests = new WeakMap<Blob, Promise<string>>();
const CHUNK_BYTES = 32768;
const UPLOAD_WINDOW = 8;
export function checkUploadAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Image upload paused.', 'AbortError');
}

/** The Host receipt, rather than a local counter, determines the next byte. */
export async function uploadImage(file: Blob, uploadId: string,
  request: (message: ImageUploadRequest) => Promise<ImageUploadReceipt>,
  options: ImageUploadOptions = {},
): Promise<NonNullable<ImageUploadReceipt['attachment']>> {
  checkUploadAborted(options.signal);
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image.');
  if (!file.size || file.size > 10 * 1024 * 1024) throw new Error('Each image must be between 1 byte and 10 MiB.');
  let digest = digests.get(file);
  if (!digest) {
    digest = file.arrayBuffer().then(bytes => crypto.subtle.digest('SHA-256', bytes)).then(hash =>
      Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join(''));
    digests.set(file, digest);
  }
  const sha256 = await digest;
  checkUploadAborted(options.signal);
  const receive = async (message: ImageUploadRequest) => {
    checkUploadAborted(options.signal);
    const receipt = await request(message);
    checkUploadAborted(options.signal);
    if (receipt.uploadId !== uploadId || !Number.isSafeInteger(receipt.offset) || receipt.offset < 0 || receipt.offset > file.size) throw new Error('The Host returned an invalid image upload offset.');
    return receipt;
  };
  let receipt = await receive({ type: 'image_upload_begin', sha256, byteLength: file.size, mediaType: file.type as ImageMediaType });
  options.onProgress?.(receipt.offset, file.size);
  if (!receipt.attachment) {
    type ChunkResult = { receipt: ImageUploadReceipt } | { error: unknown };
    const pending: Promise<ChunkResult>[] = [];
    let failure: { error: unknown } | undefined;
    let nextOffset = receipt.offset;
    const assertUploading = () => {
      checkUploadAborted(options.signal);
      if (failure) throw failure.error;
    };
    try {
      while (nextOffset < file.size || pending.length) {
        assertUploading();
        while (nextOffset < file.size && pending.length < UPLOAD_WINDOW) {
          const offset = nextOffset;
          // Read and send in order: the Host accepts only contiguous bytes.
          const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
          assertUploading();
          pending.push(receive({ type: 'image_upload_chunk', offset, contentBase64: btoa(String.fromCharCode(...bytes)) })
            .then<ChunkResult>(received => {
              if (received.offset !== offset + bytes.length) throw new Error('The Host returned an unexpected image upload offset. Retry to resume.');
              return { receipt: received };
            }).catch((error: unknown) => {
              failure ??= { error };
              return { error };
            }));
          nextOffset += bytes.length;
        }
        const result = await pending.shift()!;
        if ('error' in result) throw result.error;
        assertUploading();
        receipt = result.receipt;
        options.onProgress?.(receipt.offset, file.size);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    } finally {
      // Settle the old window before a queued retry starts with a fresh Host offset.
      await Promise.all(pending);
    }
  }
  if (!receipt.attachment) receipt = await receive({ type: 'image_upload_finish' });
  const attachment = receipt.attachment;
  if (!attachment || receipt.offset !== file.size || attachment.sha256 !== sha256 || attachment.byteLength !== file.size || attachment.mediaType !== file.type) throw new Error('The Host could not verify the uploaded image.');
  return attachment;
}

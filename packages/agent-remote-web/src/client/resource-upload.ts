import type { ResourceUploadReceipt } from '@orchardworks/agent-remote-protocol';

export interface ResourceTransferOptions { signal?: AbortSignal; onProgress?(loaded: number, total: number): void }
export type ResourceUploadRequest =
  | { type: 'resource_upload_begin'; name: string; mediaType: string; byteLength: number; sha256: string }
  | { type: 'resource_upload_chunk'; offset: number; contentBase64: string }
  | { type: 'resource_upload_finish' };
export interface ResourceDownloadChunk { resourceId: string; offset: number; contentBase64: string; byteLength: number; sha256: string; name: string; mediaType: string }
const MAX_BYTES = 50 * 1024 * 1024;
const CHUNK_BYTES = 32768;
export function checkResourceAborted(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('Resource transfer paused.', 'AbortError'); }
async function digest(blob: Blob): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function uploadResource(file: Blob, name: string, uploadId: string,
  request: (message: ResourceUploadRequest) => Promise<ResourceUploadReceipt>, options: ResourceTransferOptions = {},
): Promise<NonNullable<ResourceUploadReceipt['resource']>> {
  checkResourceAborted(options.signal);
  if (file.size > MAX_BYTES) throw new Error('Each resource must be at most 50 MiB.');
  const sha256 = await digest(file); const mediaType = file.type || 'application/octet-stream';
  const receive = async (message: ResourceUploadRequest) => {
    checkResourceAborted(options.signal); const receipt = await request(message); checkResourceAborted(options.signal);
    if (receipt.uploadId !== uploadId || !Number.isSafeInteger(receipt.offset) || receipt.offset < 0 || receipt.offset > file.size) throw new Error('The Host returned an invalid resource upload offset.');
    return receipt;
  };
  let receipt = await receive({ type: 'resource_upload_begin', name, mediaType, byteLength: file.size, sha256 });
  options.onProgress?.(receipt.offset, file.size);
  while (!receipt.resource && receipt.offset < file.size) {
    const offset = receipt.offset;
    const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
    receipt = await receive({ type: 'resource_upload_chunk', offset, contentBase64: btoa(String.fromCharCode(...bytes)) });
    if (receipt.offset !== offset + bytes.length) throw new Error('The Host returned an unexpected resource offset. Retry to resume.');
    options.onProgress?.(receipt.offset, file.size);
  }
  if (!receipt.resource) receipt = await receive({ type: 'resource_upload_finish' });
  const resource = receipt.resource;
  if (!resource || receipt.offset !== file.size || resource.sha256 !== sha256 || resource.byteLength !== file.size || resource.mediaType !== mediaType || resource.name !== name) throw new Error('The Host could not verify the uploaded resource.');
  return resource;
}

export async function downloadResource(resourceId: string, request: (offset: number) => Promise<ResourceDownloadChunk>, options: ResourceTransferOptions = {}) {
  const chunks: Uint8Array<ArrayBuffer>[] = []; let offset = 0; let metadata: ResourceDownloadChunk | undefined;
  do {
    checkResourceAborted(options.signal); const chunk = await request(offset); checkResourceAborted(options.signal);
    if (chunk.resourceId !== resourceId || chunk.offset !== offset || !Number.isSafeInteger(chunk.byteLength) || chunk.byteLength < 0 || chunk.byteLength > MAX_BYTES || !/^[a-f0-9]{64}$/.test(chunk.sha256)) throw new Error('Invalid resource download metadata.');
    if (metadata && ['sha256', 'name', 'mediaType', 'byteLength'].some(key => chunk[key as keyof ResourceDownloadChunk] !== metadata![key as keyof ResourceDownloadChunk])) throw new Error('The resource changed while downloading.');
    metadata = chunk;
    const bytes = Uint8Array.from(atob(chunk.contentBase64), char => char.charCodeAt(0));
    if (bytes.length > CHUNK_BYTES || offset + bytes.length > chunk.byteLength || (!bytes.length && offset < chunk.byteLength)) throw new Error('Invalid resource download chunk.');
    chunks.push(bytes); offset += bytes.length; options.onProgress?.(offset, chunk.byteLength);
  } while (offset < metadata.byteLength);
  const blob = new Blob(chunks, { type: metadata.mediaType });
  if (await digest(blob) !== metadata.sha256) throw new Error('Resource integrity check failed.');
  checkResourceAborted(options.signal);
  return { blob, name: metadata.name, sha256: metadata.sha256 };
}

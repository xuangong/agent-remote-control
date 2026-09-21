import { crc32 } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, open, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { IMAGE_INPUT_CAPABILITIES, type AgentInputPart, type AgentResourceReadResult } from '@orchardworks/agent-provider-sdk';
import type { ImageMediaType, ImageUploadReceipt, MessagePart } from '@orchardworks/agent-remote-protocol';
import { readImageDimensions } from './image-dimensions.js';

export interface InputImageStoreOptions {
  directory: string;
  quotaBytes?: number;
  draftTtlMs?: number;
  now?: () => number;
}
export interface ImageUploadDeclaration { uploadId: string; sha256: string; byteLength: number; mediaType: ImageMediaType }
export interface ImageUploadChunk { uploadId: string; offset: number; contentBase64: string }
interface Manifest extends ImageUploadDeclaration {
  version: 1;
  key: string;
  scopeHash: string;
  attachmentId: string;
  offset: number;
  touchedAt: number;
  pinned: boolean;
  attachment?: NonNullable<ImageUploadReceipt['attachment']>;
}

export class InputImageError extends Error {
  constructor(message: string) { super(message); this.name = 'InputImageError'; }
}

/** Durable, session-scoped incoming images. All disk paths are generated internally. */
export class InputImageStore {
  private readonly manifests = new Map<string, Manifest>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly ready: Promise<void>;
  private readonly now: () => number;
  private readonly quotaBytes: number;
  private readonly draftTtlMs: number;

  constructor(private readonly options: InputImageStoreOptions) {
    this.now = options.now ?? Date.now;
    this.quotaBytes = options.quotaBytes ?? 1024 * 1024 * 1024;
    this.draftTtlMs = options.draftTtlMs ?? 24 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(this.quotaBytes) || this.quotaBytes < 1 || !Number.isFinite(this.draftTtlMs) || this.draftTtlMs <= 0) throw new InputImageError('Invalid image storage limits.');
    this.ready = this.restore();
    void this.ready.catch(() => undefined);
  }

  begin(scope: string, declaration: ImageUploadDeclaration): Promise<ImageUploadReceipt> {
    return this.serial(async () => {
      await this.expire();
      if (!scope || !declaration.uploadId || declaration.uploadId.length > 256 || !/^[a-f0-9]{64}$/.test(declaration.sha256)
        || !Number.isSafeInteger(declaration.byteLength) || declaration.byteLength <= 0 || declaration.byteLength > IMAGE_INPUT_CAPABILITIES.maxImageBytes
        || !IMAGE_INPUT_CAPABILITIES.mediaTypes.includes(declaration.mediaType)) throw new InputImageError('Invalid or unsupported image upload declaration. Accepted formats: PNG, JPEG, WebP; maximum size: 10 MiB.');
      const key = digest(JSON.stringify([scope, declaration.uploadId]));
      const existing = this.manifests.get(key);
      if (existing) {
        if (existing.sha256 !== declaration.sha256 || existing.byteLength !== declaration.byteLength || existing.mediaType !== declaration.mediaType) throw new InputImageError('Upload identity conflicts with previously accepted image.');
        await this.touch(existing);
        return receipt(existing);
      }
      const reserved = [...this.manifests.values()].reduce((total, item) => total + item.byteLength, 0);
      if (reserved + declaration.byteLength > this.quotaBytes) throw new InputImageError('Image storage quota exceeded. Retained history images will not be deleted.');
      const manifest: Manifest = { ...declaration, version: 1, key, scopeHash: digest(scope), attachmentId: randomUUID(), offset: 0, touchedAt: this.now(), pinned: false };
      await writeFile(this.path(key, 'part'), new Uint8Array(), { mode: 0o600 });
      await this.persist(manifest);
      this.manifests.set(key, manifest);
      return receipt(manifest);
    });
  }

  chunk(scope: string, chunk: ImageUploadChunk): Promise<ImageUploadReceipt> {
    return this.serial(async () => {
      await this.expire();
      const manifest = this.requireUpload(scope, chunk.uploadId);
      if (!Number.isSafeInteger(chunk.offset) || chunk.offset < 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.contentBase64)) throw new InputImageError('Invalid image chunk encoding or offset.');
      const bytes = Buffer.from(chunk.contentBase64, 'base64');
      if (bytes.length < 1 || bytes.length > 32 * 1024 || bytes.toString('base64') !== chunk.contentBase64 || chunk.offset + bytes.length > manifest.byteLength) throw new InputImageError('Image chunks must contain at most 32 KiB within the declared image length.');
      if (chunk.offset < manifest.offset || manifest.attachment) {
        const accepted = await readFile(this.path(manifest.key, manifest.attachment ? 'image' : 'part'));
        if (chunk.offset + bytes.length > manifest.offset || !accepted.subarray(chunk.offset, chunk.offset + bytes.length).equals(bytes)) throw new InputImageError('Image chunk conflicts with accepted bytes.');
      } else {
        if (chunk.offset !== manifest.offset) throw new InputImageError(`Image chunk must resume at offset ${manifest.offset}.`);
        const file = await open(this.path(manifest.key, 'part'), 'r+');
        try { await file.write(bytes, 0, bytes.length, manifest.offset); await file.sync(); } finally { await file.close(); }
        manifest.offset += bytes.length;
      }
      await this.touch(manifest);
      return receipt(manifest);
    });
  }

  finish(scope: string, uploadId: string): Promise<ImageUploadReceipt> {
    return this.serial(async () => {
      await this.expire();
      const manifest = this.requireUpload(scope, uploadId);
      if (manifest.attachment) { await this.touch(manifest); return receipt(manifest); }
      if (manifest.offset !== manifest.byteLength) throw new InputImageError('Image upload is incomplete.');
      let bytes: Buffer;
      try { bytes = await readFile(this.path(manifest.key, 'part')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; bytes = await readFile(this.path(manifest.key, 'image')); }
      if (bytes.length !== manifest.byteLength || digest(bytes) !== manifest.sha256) throw new InputImageError('Image bytes do not match their declared length or SHA-256 digest.');
      const mediaType = detectImageType(bytes);
      const dimensions = mediaType ? readImageDimensions(bytes, mediaType) : undefined;
      if (!mediaType || mediaType !== manifest.mediaType || !dimensions) throw new InputImageError('Invalid image data or declared MIME type. Accepted formats: PNG, JPEG, WebP.');
      try { await rename(this.path(manifest.key, 'part'), this.path(manifest.key, 'image')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await chmod(this.path(manifest.key, 'image'), 0o400);
      manifest.attachment = { attachmentId: manifest.attachmentId, sha256: manifest.sha256, byteLength: manifest.byteLength, mediaType, imageDimensions: dimensions };
      await this.touch(manifest);
      return receipt(manifest);
    });
  }

  /** Pin before native dispatch: an error may still mean the native runtime accepted input. */
  resolveAndPin(scope: string, parts: readonly MessagePart[]): Promise<AgentInputPart[]> {
    return this.serial(async () => {
      await this.expire();
      if (!parts.length) throw new InputImageError('Message content must not be empty.');
      const images = parts.filter(part => part.type === 'image');
      if (images.length > IMAGE_INPUT_CAPABILITIES.maxImages) throw new InputImageError('A message may contain at most 8 images.');
      const resolved = images.map(part => this.requireAttachment(scope, part.attachmentId));
      const unique = new Map(resolved.map(item => [item.sha256, item]));
      if ([...unique.values()].reduce((sum, item) => sum + item.byteLength, 0) > IMAGE_INPUT_CAPABILITIES.maxMessageBytes) throw new InputImageError('Combined image content exceeds 20 MiB.');
      for (const item of unique.values()) {
        const bytes = await readFile(this.path(item.key, 'image'));
        if (bytes.length !== item.byteLength || digest(bytes) !== item.sha256) throw new InputImageError('Stored image integrity verification failed.');
      }
      for (const item of new Set(resolved)) { item.pinned = true; await this.touch(item); }
      return parts.map(part => {
        if (part.type === 'text') return { ...part };
        const item = this.requireAttachment(scope, part.attachmentId);
        return { type: 'image', path: this.path(item.key, 'image'), mediaType: item.mediaType, sha256: item.sha256, label: part.label };
      });
    });
  }

  read(scope: string, locator: string): Promise<AgentResourceReadResult> {
    return this.serial(async () => {
      await this.expire();
      const prefix = 'input-image:';
      if (!locator.startsWith(prefix)) return { status: 'unavailable', reason: 'Image attachment was not found in this session.' };
      const item = [...this.manifests.values()].find(record => record.scopeHash === digest(scope) && record.attachmentId === locator.slice(prefix.length) && record.attachment);
      if (!item) return { status: 'unavailable', reason: 'Image attachment was not found in this session.' };
      const bytes = await readFile(this.path(item.key, 'image'));
      if (digest(bytes) !== item.sha256) return { status: 'unavailable', reason: 'Stored image integrity verification failed.' };
      await this.touch(item);
      return { status: 'available', bytes, mediaType: item.mediaType };
    });
  }

  private path(key: string, extension: string): string { return join(this.options.directory, `${key}.${extension}`); }
  private async restore(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.options.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const item = JSON.parse(await readFile(join(this.options.directory, name), 'utf8')) as Manifest;
      if (item.version !== 1 || `${item.key}.json` !== name || !/^[a-f0-9]{64}$/.test(item.scopeHash)) throw new InputImageError('Image storage manifest is invalid.');
      this.manifests.set(item.key, item);
    }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => { await this.ready; return work(); });
    this.tail = next.catch(() => undefined);
    return next;
  }
  private requireUpload(scope: string, uploadId: string): Manifest {
    const item = this.manifests.get(digest(JSON.stringify([scope, uploadId])));
    if (!item) throw new InputImageError('Image upload was not found or has expired in this session.');
    return item;
  }
  private requireAttachment(scope: string, attachmentId: string): Manifest {
    const item = [...this.manifests.values()].find(record => record.scopeHash === digest(scope) && record.attachmentId === attachmentId && record.attachment);
    if (!item) throw new InputImageError('Image attachment was not found, is incomplete, or belongs to another session.');
    return item;
  }
  private async touch(item: Manifest): Promise<void> { item.touchedAt = this.now(); await this.persist(item); }
  private async persist(item: Manifest): Promise<void> {
    const temporary = this.path(item.key, 'json.tmp');
    const file = await open(temporary, 'w', 0o600);
    try { await file.writeFile(JSON.stringify(item)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, this.path(item.key, 'json'));
    const directory = await open(this.options.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  private async expire(): Promise<void> {
    for (const item of this.manifests.values()) {
      if (item.pinned || this.now() - item.touchedAt < this.draftTtlMs) continue;
      await Promise.all(['part', 'image', 'json', 'json.tmp'].map(extension => rm(this.path(item.key, extension), { force: true })));
      this.manifests.delete(item.key);
    }
  }
}
function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function receipt(item: Manifest): ImageUploadReceipt { return { uploadId: item.uploadId, offset: item.offset, ...(item.attachment ? { attachment: structuredClone(item.attachment) } : {}) }; }
function detectImageType(bytes: Buffer): ImageMediaType | undefined {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && validPngChunks(bytes)) return 'image/png';
  if (validJpegSegments(bytes)) return 'image/jpeg';
  if (validWebpChunks(bytes)) return 'image/webp';
  return undefined;
}

/** Validate the primary JPEG framing; entropy decoding remains native. */
function validJpegSegments(bytes: Buffer): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  let hasFrame = false;
  let hasScan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    // HDR gain maps and multi-picture JPEGs can follow the primary EOI. Keep
    // those bytes intact; the primary image does not have to end the container.
    if (marker === 0xd9) return hasFrame && hasScan;
    if (marker === undefined || marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return false;
    if (marker === 0x01) continue;
    if (offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8 || bytes[offset + 7] === 0 || length !== 8 + 3 * bytes[offset + 7]!) return false;
      hasFrame = true;
    }
    if (marker === 0xda) {
      const components = bytes[offset + 2];
      if (!hasFrame || !components || components > 4 || length !== 6 + 2 * components) return false;
      offset += length;
      let entropyBytes = 0;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; entropyBytes++; continue; }
        const markerStart = offset;
        while (bytes[offset] === 0xff) offset++;
        const next = bytes[offset];
        if (next === 0) { offset++; entropyBytes++; continue; }
        if (next !== undefined && next >= 0xd0 && next <= 0xd7) { offset++; continue; }
        offset = markerStart;
        break;
      }
      if (entropyBytes === 0) return false;
      hasScan = true;
    } else offset += length;
  }
  return false;
}

/** Require actual bounded image chunks, including frames in animated WebP. */
function validWebpChunks(bytes: Buffer): boolean {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  return webpImageChunks(bytes, 12, bytes.length, true);
}

function webpImageChunks(bytes: Buffer, start: number, end: number, allowAnimation: boolean): boolean {
  let offset = start;
  let hasImage = false;
  while (offset + 8 <= end) {
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const data = offset + 8;
    const next = data + length + (length % 2);
    if (next > end || (length % 2 && bytes[next - 1] !== 0)) return false;
    if (type === 'VP8 ') {
      if (length <= 10 || (bytes[data]! & 1) !== 0
        || bytes.toString('hex', data + 3, data + 6) !== '9d012a'
        || (bytes.readUInt16LE(data + 6) & 0x3fff) === 0 || (bytes.readUInt16LE(data + 8) & 0x3fff) === 0) return false;
      const partitionLength = bytes.readUIntLE(data, 3) >>> 5;
      if (partitionLength === 0 || partitionLength > length - 10) return false;
      hasImage = true;
    } else if (type === 'VP8L') {
      if (length <= 5 || bytes[data] !== 0x2f || (bytes[data + 4]! & 0xe0) !== 0) return false;
      hasImage = true;
    } else if (type === 'VP8X') {
      if (!allowAnimation || offset !== start || length !== 10 || (bytes[data]! & 0xc1) !== 0
        || bytes[data + 1] !== 0 || bytes[data + 2] !== 0 || bytes[data + 3] !== 0) return false;
    } else if (type === 'ANMF') {
      if (!allowAnimation || length < 16 || !webpImageChunks(bytes, data + 16, data + length, false)) return false;
      hasImage = true;
    } else if (type === 'ANIM' && (!allowAnimation || length !== 6)) return false;
    offset = next;
  }
  return hasImage && offset === end;
}

function validPngChunks(bytes: Buffer): boolean {
  let offset = 8;
  let hasData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset === 8 && (type !== 'IHDR' || length !== 13)) return false;
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return false;
    if (type === 'IDAT' && length > 0) hasData = true;
    if (type === 'IEND') return hasData && length === 0 && end === bytes.length;
    offset = end;
  }
  return false;
}

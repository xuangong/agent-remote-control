import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InputImageStore } from './input-image-store.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture(options: { quotaBytes?: number; draftTtlMs?: number; now?: () => number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'remote-input-images-')); directories.push(directory);
  return { directory, store: new InputImageStore({ directory, ...options }) };
}
const image = (name = 'dimensions.png') => readFile(new URL(`./fixtures/${name}`, import.meta.url));
function declaration(bytes: Uint8Array, uploadId = 'upload', mediaType: 'image/png' | 'image/jpeg' | 'image/webp' = 'image/png') {
  return { uploadId, mediaType, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
async function upload(store: InputImageStore, scope: string, bytes: Buffer, id = 'upload', mediaType: 'image/png' | 'image/jpeg' | 'image/webp' = 'image/png') {
  await store.begin(scope, declaration(bytes, id, mediaType));
  for (let offset = 0; offset < bytes.length; offset += 32768) await store.chunk(scope, { uploadId: id, offset, contentBase64: bytes.subarray(offset, offset + 32768).toString('base64') });
  return (await store.finish(scope, id)).attachment!;
}
describe('durable scoped input image storage', () => {
  it('resumes persisted offsets, accepts exact repeats, and completes after restart', async () => {
    const { store, directory } = await fixture(); const bytes = await image(); const input = declaration(bytes);
    await store.begin('session', input);
    const chunk = { uploadId: input.uploadId, offset: 0, contentBase64: bytes.subarray(0, 20).toString('base64') };
    const accepted = await store.chunk('session', chunk);
    expect(await store.chunk('session', chunk)).toEqual(accepted);
    const restored = new InputImageStore({ directory });
    expect((await restored.begin('session', input)).offset).toBe(20);
    await restored.chunk('session', { uploadId: input.uploadId, offset: 20, contentBase64: bytes.subarray(20).toString('base64') });
    const completed = await restored.finish('session', input.uploadId);
    expect(completed.attachment?.sha256).toBe(input.sha256);
    expect(await new InputImageStore({ directory }).finish('session', input.uploadId)).toEqual(completed);
    await expect(restored.finish('other-session', input.uploadId)).rejects.toThrow('not found');
    expect((await restored.read('other-session', `input-image:${completed.attachment!.attachmentId}`)).status).toBe('unavailable');
  });
  it('rejects offset gaps, conflicting chunks, invalid data, MIME mismatch, and digest mismatch', async () => {
    const { store } = await fixture(); const bytes = await image();
    await store.begin('s', declaration(bytes));
    await expect(store.chunk('s', { uploadId: 'upload', offset: 1, contentBase64: bytes.toString('base64') })).rejects.toThrow();
    await store.chunk('s', { uploadId: 'upload', offset: 0, contentBase64: bytes.toString('base64') });
    const conflict = Buffer.from(bytes); conflict[0] = 0;
    await expect(store.chunk('s', { uploadId: 'upload', offset: 0, contentBase64: conflict.toString('base64') })).rejects.toThrow('conflicts');
    await expect(upload(store, 's', bytes, 'wrong-mime', 'image/jpeg')).rejects.toThrow('MIME');
    await expect(upload(store, 's', Buffer.from('not an image'), 'invalid')).rejects.toThrow('Invalid image');
    const corrupted = Buffer.from(bytes); corrupted[40] = corrupted[40]! ^ 1;
    await expect(upload(store, 's', corrupted, 'corrupted')).rejects.toThrow('Invalid image');
    await store.begin('s', { ...declaration(bytes, 'digest'), sha256: 'a'.repeat(64) });
    await store.chunk('s', { uploadId: 'digest', offset: 0, contentBase64: bytes.toString('base64') });
    await expect(store.finish('s', 'digest')).rejects.toThrow('digest');
  });
  it.each([['dimensions.png', 'image/png'], ['rotated.jpg', 'image/jpeg'], ['dimensions.webp', 'image/webp']] as const)('detects %s and records dimensions', async (file, mediaType) => {
    const { store } = await fixture(); const attachment = await upload(store, 's', await image(file), 'u', mediaType);
    expect(attachment.mediaType).toBe(mediaType); expect(attachment.imageDimensions.width).toBeGreaterThan(0);
  });
  it('rejects JPEG headers without a scan and truncated JPEG entropy data', async () => {
    const { store } = await fixture();
    const headerOnly = Buffer.from('ffd8ffe00002ffc00011080001000103011100021100031100ffd9', 'hex');
    await expect(upload(store, 's', headerOnly, 'headers', 'image/jpeg')).rejects.toThrow('Invalid image');
    const bytes = await image('rotated.jpg');
    const scan = bytes.indexOf(Buffer.from([0xff, 0xda]));
    expect(scan).toBeGreaterThan(0);
    const truncated = Buffer.concat([bytes.subarray(0, scan + 2 + bytes.readUInt16BE(scan + 2)), Buffer.from([0xff, 0xd9])]);
    await expect(upload(store, 's', truncated, 'empty-scan', 'image/jpeg')).rejects.toThrow('Invalid image');
  });
  it('rejects WebP canvas-only and truncated image chunks', async () => {
    const { store } = await fixture();
    const headerOnly = Buffer.alloc(30);
    headerOnly.write('RIFF'); headerOnly.writeUInt32LE(22, 4); headerOnly.write('WEBPVP8X', 8); headerOnly.writeUInt32LE(10, 16);
    await expect(upload(store, 's', headerOnly, 'headers', 'image/webp')).rejects.toThrow('Invalid image');
    const bytes = await image('dimensions.webp');
    const truncated = Buffer.from(bytes.subarray(0, bytes.length - 4));
    truncated.writeUInt32LE(truncated.length - 8, 4);
    await expect(upload(store, 's', truncated, 'truncated', 'image/webp')).rejects.toThrow('Invalid image');
  });
  it('expires unused drafts, enforces reservations, and retains dispatched images over restart', async () => {
    let now = 0; const bytes = await image(); const { store, directory } = await fixture({ quotaBytes: bytes.length, draftTtlMs: 100, now: () => now });
    const discarded = await upload(store, 's', bytes);
    await expect(store.begin('other', declaration(bytes))).rejects.toThrow('quota');
    now = 101;
    const retained = await upload(store, 's', bytes, 'retained');
    await expect(store.resolveAndPin('s', [{ type: 'image', attachmentId: discarded.attachmentId, label: 'old' }])).rejects.toThrow('not found');
    const content = [{ type: 'text' as const, text: 'before' }, { type: 'image' as const, attachmentId: retained.attachmentId, label: 'image #2' }];
    const resolved = await store.resolveAndPin('s', content);
    expect(resolved.map(part => part.type)).toEqual(['text', 'image']);
    now = 1000;
    const restored = new InputImageStore({ directory, quotaBytes: bytes.length, draftTtlMs: 100, now: () => now });
    expect((await restored.read('s', `input-image:${retained.attachmentId}`)).status).toBe('available');
    await expect(restored.begin('other', declaration(bytes))).rejects.toThrow('quota');
    await expect(restored.resolveAndPin('s', Array.from({ length: 9 }, () => content[1]!))).rejects.toThrow('8 images');
  });
});

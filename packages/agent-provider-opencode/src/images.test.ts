import { mkdtemp, writeFile, rm, symlink, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import type { NativeAttachment } from './v2-native.js';
import { IMAGE_INPUT_CAPABILITIES } from '@orchardworks/agent-provider-sdk';
import { OpenCodeImages } from './images.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYZcAAAAASUVORK5CYII=', 'base64');
const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function directory() { const folder = await mkdtemp(join(tmpdir(), 'opencode-images-')); folders.push(folder); return folder; }
function file(uri: string, key = 'file:0'): NativeAttachment { return { key, mime: 'image/png', uri }; }
function register(images: OpenCodeImages, part: NativeAttachment) { return images.project('msg_1', [part]).references[0]!.readLocator; }

test('reads only registered local native file URLs and returns stable defensive snapshots', async () => {
  const path = join(await directory(), 'result.png'); await writeFile(path, png);
  const images = new OpenCodeImages('ses_1', { allowLocalFiles: true });
  expect(await images.read(path)).toMatchObject({ status: 'unavailable' });
  const locator = register(images, file(pathToFileURL(path).href));
  const result = await images.read(locator);
  expect(result).toMatchObject({ status: 'available', bytes: Uint8Array.from(png), mediaType: 'image/png' });
  if (result.status === 'available') result.bytes[0] = 0;
  await writeFile(path, 'changed');
  expect(await images.read(locator)).toMatchObject({ status: 'available', bytes: Uint8Array.from(png) });
  images.close(); expect(await images.read(locator)).toMatchObject({ status: 'unavailable' });
  expect(images.project('msg_1', [file(pathToFileURL(path).href)]).content).toEqual([]);
});

test('rejects remote URLs, foreign resource identities, remote-server local files and unsafe files', async () => {
  const folder = await directory(); const path = join(folder, 'result.png'); await writeFile(path, png);
  const remote = new OpenCodeImages('ses_1');
  expect(await remote.read(register(remote, file(pathToFileURL(path).href)))).toMatchObject({ status: 'unavailable' });
  const images = new OpenCodeImages('ses_1', { allowLocalFiles: true });
  const other = new OpenCodeImages('ses_other', { allowLocalFiles: true });
  const own = register(images, file(pathToFileURL(path).href));
  expect(register(other, file(pathToFileURL(path).href))).not.toBe(own);
  expect(await other.read(own)).toMatchObject({ status: 'unavailable' });
  expect(images.project('msg_other', [file(pathToFileURL(path).href)]).references[0]!.locator).not.toBe(own);
  await symlink(path, join(folder, 'link.png'));
  const oversized = join(folder, 'large.png'); await writeFile(oversized, png); await truncate(oversized, IMAGE_INPUT_CAPABILITIES.maxImageBytes + 1);
  const invalid = join(folder, 'invalid.png'); await writeFile(invalid, 'not an image');
  for (const [index, url] of ['https://example.org/image.png', 'file://remote/image.png', pathToFileURL(folder).href, pathToFileURL(join(folder, 'link.png')).href, pathToFileURL(oversized).href, pathToFileURL(invalid).href].entries()) {
    expect(await images.read(register(images, file(url, `prt_${index}`)))).toMatchObject({ status: 'unavailable' });
  }
});

test('rejects malformed inline encodings and MIME spoofing and supports native GIF output', async () => {
  const images = new OpenCodeImages('ses_1');
  const bad = file(`data:image/jpeg;base64,${png.toString('base64')}`);
  expect(await images.read(register(images, bad))).toMatchObject({ status: 'unavailable' });
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const locator = register(images, { ...file(`data:image/gif;base64,${gif.toString('base64')}`, 'prt_gif'), mime: 'image/gif' });
  expect(await images.read(locator)).toMatchObject({ status: 'available', bytes: Uint8Array.from(gif), mediaType: 'image/gif' });
});

test('enforces one session byte budget across concurrent native local image reads', async () => {
  const path = join(await directory(), 'large.png');
  const bytes = Buffer.alloc(IMAGE_INPUT_CAPABILITIES.maxImageBytes); png.copy(bytes);
  await writeFile(path, bytes);
  const images = new OpenCodeImages('ses_1', { allowLocalFiles: true });
  const locators = Array.from({ length: 7 }, (_, index) => register(images, file(pathToFileURL(path).href, `prt_${index}`)));
  const results = await Promise.all(locators.map(locator => images.read(locator)));
  expect(results.filter(result => result.status === 'available')).toHaveLength(6);
  expect(results.filter(result => result.status === 'unavailable')).toHaveLength(1);
  images.close();
});

test('prefers the embedded v2 user attachment bytes over their original source URI', async () => {
  const path = join(await directory(), 'changed.png'); await writeFile(path, 'replaced since the prompt');
  const images = new OpenCodeImages('ses_1', { allowLocalFiles: true });
  const locator = register(images, { ...file(pathToFileURL(path).href), data: png.toString('base64') });
  expect(await images.read(locator)).toMatchObject({ status: 'available', bytes: Uint8Array.from(png) });
  expect(await images.read(register(images, { ...file(pathToFileURL(path).href), data: 'invalid' }))).toMatchObject({ status: 'unavailable' });
});

test('encodes validated image input as v2 prompt text and URI files', async () => {
  const path = join(await directory(), 'input.png'); await writeFile(path, png);
  const images = new OpenCodeImages('ses_1');
  const input = { type: 'image' as const, path, label: 'Pixel', mediaType: 'image/png' as const, sha256: createHash('sha256').update(png).digest('hex') };
  expect(await images.input([{ type: 'text', text: 'Inspect' }, input])).toEqual({ text: 'Inspect', files: [{ name: 'Pixel', uri: `data:image/png;base64,${png.toString('base64')}` }] });
  expect(await images.input([{ type: 'text', text: 'One' }, { type: 'text', text: 'Two' }])).toEqual({ text: 'One\nTwo' });
  await expect(images.input([{ ...input, sha256: '0'.repeat(64) }])).rejects.toThrow('validation');
  await expect(images.input([{ ...input, mediaType: 'image/jpeg' }])).rejects.toThrow('validation');
});

test('keeps changed attachment bytes distinct and registers bounded non-image resources', async () => {
  const images = new OpenCodeImages('ses_1');
  const first = images.project('msg_1', [{ key: 'file:0', mime: 'text/plain', data: Buffer.from('before').toString('base64'), name: 'report](https://bad)' }]);
  const next = images.project('msg_1', [{ key: 'file:0', mime: 'text/plain', data: Buffer.from('after').toString('base64') }]);
  expect(first.references[0]!.locator).not.toBe(next.references[0]!.locator);
  expect(first.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('opencode-resource:') });
  expect(await images.read(first.references[0]!.readLocator)).toMatchObject({ status: 'available', bytes: Uint8Array.from(Buffer.from('before')), mediaType: 'text/plain' });
  expect(await images.read(next.references[0]!.readLocator)).toMatchObject({ status: 'available', bytes: Uint8Array.from(Buffer.from('after')) });
});

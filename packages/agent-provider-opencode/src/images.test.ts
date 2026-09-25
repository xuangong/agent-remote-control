import { mkdtemp, writeFile, rm, symlink, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import type { FilePart } from '@opencode-ai/sdk/v2/client';
import { IMAGE_INPUT_CAPABILITIES } from '@orchardworks/agent-provider-sdk';
import { OpenCodeImages } from './images.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYZcAAAAASUVORK5CYII=', 'base64');
const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function directory() { const folder = await mkdtemp(join(tmpdir(), 'opencode-images-')); folders.push(folder); return folder; }
function file(url: string, id = 'prt_1'): FilePart { return { type: 'file', id, messageID: 'msg_1', sessionID: 'ses_1', mime: 'image/png', url }; }
function register(images: OpenCodeImages, part: FilePart) { return images.project('msg_1', [part]).references[0]!.readLocator; }

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

test('rejects remote URLs, foreign identities, local files on remote servers and unsafe native files', async () => {
  const folder = await directory(); const path = join(folder, 'result.png'); await writeFile(path, png);
  const remote = new OpenCodeImages('ses_1');
  expect(await remote.read(register(remote, file(pathToFileURL(path).href)))).toMatchObject({ status: 'unavailable' });
  const images = new OpenCodeImages('ses_1', { allowLocalFiles: true });
  expect(images.project('msg_1', [{ ...file(pathToFileURL(path).href), sessionID: 'ses_other' }]).content).toEqual([]);
  expect(images.project('msg_wrong', [file(pathToFileURL(path).href)]).content).toEqual([]);
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

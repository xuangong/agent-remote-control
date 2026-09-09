import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CodexImageRegistry } from './images.js';
import { projectCodexThreadHistory } from './history.js';
import { CodexEventProjector } from './projector.js';
import { CodexAppServerProvider } from './provider.js';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=', 'base64');
const directories: string[] = [];
async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'codex-images-'));
  directories.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('CodexImageRegistry', () => {
  it('maps a native viewed file to an opaque Markdown resource and reads raster bytes', async () => {
    const cwd = await directory();
    await writeFile(join(cwd, 'view.png'), png);
    const images = new CodexImageRegistry('thread-one');
    const projection = images.project({ type: 'imageView', id: 'view-one', path: 'view.png' }, cwd)!;
    const reference = projection.resourceReferences[0]!;
    expect(projection.item).toEqual({
      type: 'assistant_message', messageId: 'view-one', text: `![Viewed image](${reference.locator})`,
    });
    expect(reference.locator).toMatch(/^codex-image:[a-f0-9]{64}$/);
    expect(reference.readLocator).not.toContain('view.png');
    expect(await images.readResource(reference.readLocator)).toEqual({ status: 'available', bytes: png, mediaType: 'image/png' });
    expect((await images.readResource(join(cwd, 'view.png'))).status).toBe('unavailable');
    expect((await images.readResource('codex-image:unregistered')).status).toBe('unavailable');
  });

  it('decodes native generated base64 and data URLs without trusting a claimed media type', async () => {
    const images = new CodexImageRegistry('thread-one');
    for (const [id, result] of [
      ['base64', png.toString('base64')],
      ['data-url', `data:image/png;base64,${png.toString('base64')}`],
    ]) {
      const projection = images.project({ type: 'imageGeneration', id, status: 'completed', result })!;
      expect(projection.item.text).toContain('![Generated image](');
      expect(await images.readResource(projection.resourceReferences[0]!.readLocator))
        .toEqual({ status: 'available', bytes: png, mediaType: 'image/png' });
    }
  });

  it('recognizes short raster base64 and JPEG base64 with a leading slash', async () => {
    const images = new CodexImageRegistry('thread-one');
    const fixtures = [
      { mediaType: 'image/gif', bytes: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') },
      { mediaType: 'image/jpeg', bytes: Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 255, 217]) },
    ];
    for (const { mediaType, bytes } of fixtures) {
      const projection = images.project({ type: 'imageGeneration', id: mediaType, result: bytes.toString('base64') })!;
      expect(projection.resourceReferences).toHaveLength(1);
      expect(await images.readResource(projection.resourceReferences[0]!.readLocator)).toEqual({ status: 'available', bytes, mediaType });
    }
  });

  it('preserves native savedPath and result file paths', async () => {
    const cwd = await directory();
    const path = join(cwd, 'generated.png');
    const extensionlessDirectory = await mkdtemp('/tmp/codeximages');
    directories.push(extensionlessDirectory);
    const extensionless = join(extensionlessDirectory, 'generated'.repeat(12));
    await writeFile(path, png);
    await writeFile(extensionless, png);
    const images = new CodexImageRegistry('thread-one');
    for (const item of [
      { type: 'imageGeneration', id: 'saved', status: 'completed', savedPath: path, result: '' },
      { type: 'imageGeneration', id: 'result-path', status: 'completed', result: path },
      { type: 'imageGeneration', id: 'object-path', status: 'completed', result: { path: 'generated.png' } },
      { type: 'imageGeneration', id: 'extensionless-path', status: 'completed', result: extensionless },
    ]) {
      const projection = images.project(item, cwd)!;
      expect((await images.readResource(projection.resourceReferences[0]!.readLocator)).status).toBe('available');
    }
  });

  it('keeps materialized bytes and locators stable across file changes and replay', async () => {
    const cwd = await directory();
    const path = join(cwd, 'view.png');
    await writeFile(path, png);
    const images = new CodexImageRegistry('thread-one');
    const item = { type: 'imageView', id: 'view-one', path };
    const projection = images.project(item)!;
    const readLocator = projection.resourceReferences[0]!.readLocator;
    const first = await images.readResource(readLocator);
    if (first.status !== 'available') throw new Error('Expected image');
    first.bytes.fill(0);
    await writeFile(path, '<html>changed</html>');
    expect(images.project(item)).toEqual(projection);
    expect(await images.readResource(readLocator)).toEqual({ status: 'available', bytes: png, mediaType: 'image/png' });
    const other = new CodexImageRegistry('thread-two').project(item)!;
    expect(other.resourceReferences[0]!.readLocator).not.toBe(readLocator);
  });

  it('rejects HTML, SVG, malformed base64 and excessive embedded payloads', async () => {
    const images = new CodexImageRegistry('thread-one');
    const cwd = await directory();
    await writeFile(join(cwd, 'fake.png'), '<html>not a raster image</html>');
    const items = [
      { type: 'imageView', id: 'html', path: 'fake.png' },
      { type: 'imageGeneration', id: 'svg', result: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}` },
      { type: 'imageGeneration', id: 'malformed', result: 'data:image/png;base64,invalid!' },
      { type: 'imageGeneration', id: 'too-large', result: Buffer.alloc(16 * 1024 * 1024 + 1).toString('base64') },
    ];
    for (const item of items) {
      const projection = images.project(item, cwd)!;
      const reference = projection.resourceReferences[0];
      if (reference) expect((await images.readResource(reference.readLocator)).status).toBe('unavailable');
      else expect(projection.item.text).toMatch(/unavailable/i);
    }
  });

  it('reports remote URLs, incomplete results and unscoped relative paths honestly', () => {
    const images = new CodexImageRegistry('thread-one');
    for (const item of [
      { type: 'imageGeneration', id: 'remote', result: 'https://example.invalid/image.png' },
      { type: 'imageGeneration', id: 'empty', result: '' },
      { type: 'imageGeneration', id: 'failed', status: 'failed', result: png.toString('base64') },
      { type: 'imageView', id: 'relative', path: 'image.png' },
    ]) {
      const projection = images.project(item)!;
      expect(projection.resourceReferences).toEqual([]);
      expect(projection.item.text).toMatch(/unavailable/i);
    }
    expect(images.project({ type: 'agentMessage', id: 'text', text: 'hello' })).toBeNull();
  });

  it('bounds file reads and does not block on native special files', async () => {
    const cwd = await directory();
    await writeFile(join(cwd, 'large.png'), Buffer.alloc(16 * 1024 * 1024 + 1));
    const images = new CodexImageRegistry('thread-one');
    for (const [id, path] of [['large', join(cwd, 'large.png')], ['device', '/dev/zero']]) {
      const projection = images.project({ type: 'imageView', id, path })!;
      expect((await images.readResource(projection.resourceReferences[0]!.readLocator)).status).toBe('unavailable');
    }
  });

  it('stops serving registered images after session disposal', async () => {
    const images = new CodexImageRegistry('thread-one');
    const item = { type: 'imageGeneration', id: 'generated', result: png.toString('base64') };
    const projection = images.project(item)!;
    images.stop();
    expect((await images.readResource(projection.resourceReferences[0]!.readLocator)).status).toBe('unavailable');
    expect(images.project(item)).toBeNull();
  });

  it('preserves an unavailable read result when a missing native file appears later', async () => {
    const path = join(await directory(), 'missing.png');
    const images = new CodexImageRegistry('thread-one');
    const projected = images.project({ type: 'imageView', id: 'missing', path })!;
    const locator = projected.resourceReferences[0]!.readLocator;
    const first = await images.readResource(locator);
    expect(first.status).toBe('unavailable');
    await writeFile(path, png);
    expect(await images.readResource(locator)).toEqual(first);
  });

  it('bounds embedded image data retained before resource reads', () => {
    const images = new CodexImageRegistry('thread-one');
    const result = Buffer.alloc(8 * 1024 * 1024).toString('base64');
    const projections = Array.from({ length: 7 }, (_, index) => images.project({ type: 'imageGeneration', id: `image-${index}`, result })!);
    expect(projections[0]!.resourceReferences).toHaveLength(1);
    expect(projections[6]!.resourceReferences).toEqual([]);
    expect(projections[6]!.item.text).toMatch(/unavailable/i);
  });

  it('shares resource identity between live completion and history without registering started placeholders', async () => {
    const images = new CodexImageRegistry('thread-one');
    const projector = new CodexEventProjector('thread-one', { images });
    expect(projector.projectNotification('item/started', {
      threadId: 'thread-one', turnId: 'turn-one', item: { type: 'imageGeneration', id: 'generated', status: 'inProgress', result: '' },
    })).toBeNull();
    const item = { type: 'imageGeneration', id: 'generated', status: 'completed', result: png.toString('base64') };
    const live = projector.projectNotification('item/completed', { threadId: 'thread-one', turnId: 'turn-one', item })!;
    const [history] = projectCodexThreadHistory({ thread: { id: 'thread-one', turns: [{ id: 'turn-one', items: [item] }] } }, 'thread-one', { images });
    expect(live.event).toEqual(history!.event);
    expect(live.resourceReferences).toHaveLength(1);
    expect(live.resourceReferences).toEqual(history!.resourceReferences);
    expect(await images.readResource(live.resourceReferences![0]!.readLocator)).toEqual({ status: 'available', bytes: png, mediaType: 'image/png' });
  });

  it('serves native history and live images through the resumed session resource reader', async () => {
    const cwd = await directory();
    await writeFile(join(cwd, 'history.png'), png);
    const appServer = createScriptedAppServer({
      'thread/resume': () => ({ thread: { id: 'thread-one', cwd } }),
      'thread/read': () => ({ thread: { id: 'thread-one', turns: [{ id: 'turn-one', items: [
        { type: 'imageView', id: 'history-image', path: 'history.png' },
      ] }] } }),
    });
    const provider = new CodexAppServerProvider({ spawn: () => appServer.child });
    const session = await provider.resumeSession({ providerId: 'codex', sessionId: 'thread-one', opaque: '{}' });
    try {
      const iterator = session.observe()[Symbol.asyncIterator]();
      const historical = (await iterator.next()).value;
      if (historical?.type !== 'observation') throw new Error('Expected historical image observation');
      expect(await session.readResource!(historical.resourceReferences![0]!.readLocator)).toEqual({ status: 'available', bytes: png, mediaType: 'image/png' });
      await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'history_boundary' } });
      appServer.child.stdout.write(`${JSON.stringify({ method: 'item/completed', params: {
        threadId: 'thread-one', turnId: 'turn-two', item: { type: 'imageGeneration', id: 'live-image', status: 'completed', result: png.toString('base64') },
      } })}\n`);
      const live = (await iterator.next()).value;
      if (live?.type !== 'observation') throw new Error('Expected live image observation');
      expect(await session.readResource!(live.resourceReferences![0]!.readLocator)).toEqual({ status: 'available', bytes: png, mediaType: 'image/png' });
    } finally {
      await session.dispose();
    }
  });
});

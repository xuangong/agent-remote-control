import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { createLocalFileResourceReader } from './local-file-reader.js';

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local file resource reader', () => {
  test('reads a permitted raster image and resolves relative to its source document', async () => {
    const root = await workspace();
    const document = join(root, 'docs', 'report.md');
    const image = join(root, 'docs', 'images', 'result.png');
    await mkdir(dirname(image), { recursive: true });
    await writeFile(document, '# Report');
    await writeFile(image, PNG);
    const reader = await createLocalFileResourceReader({ roots: [root] });

    await expect(reader.read('./images/result.png', document)).resolves.toEqual({
      status: 'available',
      mediaType: 'image/png',
      bytes: PNG,
    });
    await expect(reader.read(image)).resolves.toMatchObject({ status: 'available', mediaType: 'image/png' });
    await expect(reader.read(`file://${image}`)).resolves.toMatchObject({ status: 'available', mediaType: 'image/png' });
    await writeFile(join(root, 'docs', 'my image.png'), PNG);
    await expect(reader.read('./my%20image.png', document)).resolves.toMatchObject({ status: 'available', mediaType: 'image/png' });
  });

  test('denies paths outside the authorized roots including traversal and symlink escapes', async () => {
    const root = await workspace();
    const outsideRoot = await workspace();
    const outside = join(outsideRoot, 'secret.png');
    await writeFile(outside, PNG);
    await symlink(outside, join(root, 'linked.png'));
    const reader = await createLocalFileResourceReader({ roots: [root] });

    await expect(reader.read(outside)).resolves.toMatchObject({ status: 'unavailable' });
    await expect(reader.read(`../${basename(outsideRoot)}/secret.png`)).resolves.toMatchObject({ status: 'unavailable' });
    await expect(reader.read('linked.png')).resolves.toMatchObject({ status: 'unavailable' });
  });

  test('denies unsupported, empty, non-regular, and oversized files before returning bytes', async () => {
    const root = await workspace();
    await writeFile(join(root, 'text.png'), 'not really png');
    await writeFile(join(root, 'empty.png'), '');
    await writeFile(join(root, 'large.png'), Uint8Array.from([...PNG, ...new Uint8Array(32)]));
    await mkdir(join(root, 'directory.png'));
    const reader = await createLocalFileResourceReader({ roots: [root], maxBytes: 16 });

    await expect(reader.read('text.png')).resolves.toMatchObject({ status: 'unavailable' });
    await expect(reader.read('empty.png')).resolves.toMatchObject({ status: 'unavailable' });
    await expect(reader.read('large.png')).resolves.toMatchObject({ status: 'unavailable' });
    await expect(reader.read('directory.png')).resolves.toMatchObject({ status: 'unavailable' });
  });

  test('keeps the default raster payload within the single-frame transport budget', async () => {
    const root = await workspace();
    const bytes = new Uint8Array(4 * 1024 * 1024 + 1);
    bytes.set(PNG);
    await writeFile(join(root, 'transport-oversized.png'), bytes);
    const reader = await createLocalFileResourceReader({ roots: [root] });

    await expect(reader.read('transport-oversized.png')).resolves.toMatchObject({ status: 'unavailable' });
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-remote-resource-'));
  roots.push(root);
  return root;
}

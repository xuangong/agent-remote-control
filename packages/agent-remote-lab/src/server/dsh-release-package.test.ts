// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { prepareDshRelease } from '../../scripts/prepare-dsh-release.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DSH release installation manifest', () => {
  it('pins transitive native dependencies and peers without installing another release family', async () => {
    const root = await mkdtemp(join(tmpdir(), 'borgee-dsh-release-'));
    roots.push(root);
    const readMetadata = vi.fn(async (name: string, version: string) => ({
      name, version,
      ...(name === '@deepseek-ai/dsh' ? { dependencies: { '@deepseek-ai/dsh-web-app': '^0.1.2-rc.1', '@deepseek-ai/cordis': '^4.0.1' } } : {}),
      ...(name === '@deepseek-ai/dsh-web-app' ? { peerDependencies: { '@deepseek-ai/dsh-agent': '^0.1.2-rc.1' } } : {}),
      ...(name === '@deepseek-ai/dsh-agent' ? { optionalDependencies: { '@deepseek-ai/dsh-web-app': '^0.1.2-rc.1' } } : {}),
    }));
    const path = await prepareDshRelease(root, readMetadata);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      dependencies: { '@deepseek-ai/dsh': '0.1.2-rc.1' },
      overrides: {
        '@deepseek-ai/dsh': '0.1.2-rc.1',
        '@deepseek-ai/dsh-agent': '0.1.2-rc.1',
        '@deepseek-ai/dsh-web-app': '0.1.2-rc.1',
      },
    });
    expect(readMetadata).toHaveBeenCalledTimes(3);
    const saved = await readFile(path, 'utf8');
    await expect(prepareDshRelease(root, readMetadata)).rejects.toThrow('EEXIST');
    expect(await readFile(path, 'utf8')).toBe(saved);
  });

  it('rejects metadata from another native version before writing an install manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'borgee-dsh-release-'));
    roots.push(root);
    await expect(prepareDshRelease(root, async (name) => ({ name, version: '0.2.0' }))).rejects.toThrow('Unexpected published DSH metadata');
    await expect(readFile(join(root, 'package.json'))).rejects.toThrow('ENOENT');
  });
});

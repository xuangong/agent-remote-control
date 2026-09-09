// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildDshPlugin } from '../../scripts/build-dsh-plugin.js';
import { loadCompatibilityManifest } from './compatibility.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('installable DSH Lab plugin', () => {
  it('packs an independently verifiable profile bundle with native host peers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'borgee-dsh-package-'));
    roots.push(root);
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'compatibility.json'), 'utf8'));
    manifest.borgee.implementation = {
      algorithm: 'sha256', root: '.', scope: ['implementation.txt'],
      digest: 'sha256:d8fdc7cc1b3b4a412e46aaacede0afa478eee509c99e48f2d684e2ede8ee5a15',
    };
    await writeFile(join(root, 'implementation.txt'), 'implementation\n');
    await writeFile(join(root, 'compatibility.json'), JSON.stringify(manifest));
    const archive = await buildDshPlugin({ outputRoot: root, manifestPath: join(root, 'compatibility.json') });
    execFileSync('tar', ['-xzf', archive, '-C', root], { timeout: 10_000 });
    const packedRoot = join(root, 'package');
    const metadata = JSON.parse(await readFile(join(packedRoot, 'package.json'), 'utf8'));
    expect(metadata.name).toBe('@borgee/agent-remote-lab-dsh');
    expect(metadata.dsh.bundle.patch).toBe('./cordis.patch.yml');
    expect(metadata.dependencies).toBeUndefined();
    expect(metadata.peerDependencies).toEqual({
      '@deepseek-ai/dsh-agent': '0.1.2-rc.1',
      '@deepseek-ai/dsh-llm': '0.1.2-rc.1',
      '@deepseek-ai/dsh-session': '0.1.2-rc.1',
    });
    const packedManifestPath = join(packedRoot, 'compatibility.json');
    const packed = loadCompatibilityManifest(packedManifestPath);
    expect(packed.borgee.implementation.root).toBe('.');
    expect(packed.borgee.implementation.scope).toEqual(['cordis.patch.yml', 'lib/index.js', 'package.json']);
    await writeFile(join(packedRoot, 'lib/index.js'), 'export function apply() {}\n');
    expect(() => loadCompatibilityManifest(packedManifestPath)).toThrow('implementation digest mismatch');
  });
});

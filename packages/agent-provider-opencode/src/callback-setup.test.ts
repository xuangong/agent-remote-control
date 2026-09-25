import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { setupOpenCodeCallbacks } from './callback-setup.js';
it('installs an explicit plugin config and refuses to overwrite an existing setup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-callback-setup-')); const directory = join(root, 'private callbacks');
  try {
    const paths = await setupOpenCodeCallbacks(directory);
    const config = JSON.parse(await readFile(paths.nativeConfigPath, 'utf8'));
    expect(config.plugin[0][1]).toEqual({ configPath: paths.configPath });
    const asset = fileURLToPath(config.plugin[0][0]); expect((await readFile(asset, 'utf8')).length).toBeGreaterThan(1000);
    await writeFile(asset, 'USER-MODIFIED');
    await expect(setupOpenCodeCallbacks(directory)).rejects.toThrow();
    expect(await readFile(asset, 'utf8')).toBe('USER-MODIFIED');
    expect(JSON.parse(await readFile(paths.nativeConfigPath, 'utf8'))).toEqual(config);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);

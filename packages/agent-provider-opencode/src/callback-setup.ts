import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Creates an explicit per-server config; never edits native global or project configuration. */
export async function setupOpenCodeCallbacks(directory: string): Promise<{ configPath: string; nativeConfigPath: string }> {
  const root = resolve(directory);
  const artifact = await readFile(new URL('./bridge-plugin.mjs', import.meta.url));
  await mkdir(dirname(root), { recursive: true, mode: 0o700 });
  await mkdir(root, { mode: 0o700 });
  const pluginPath = join(root, 'arc-bridge-plugin.mjs');
  const configPath = join(root, 'callback.json');
  const nativeConfigPath = join(root, 'opencode-arc.json');
  try {
    await writeFile(pluginPath, artifact, { mode: 0o600, flag: 'wx' });
    await writeFile(nativeConfigPath, JSON.stringify({ plugin: [[pathToFileURL(pluginPath).href, { configPath }]] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  } catch (error) {
    await Promise.allSettled([unlink(pluginPath), unlink(nativeConfigPath)]); await rmdir(root).catch(() => undefined); throw error;
  }
  return { configPath, nativeConfigPath };
}

import { mkdir, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Creates an explicit per-server config; never edits native global or project configuration. */
export async function setupOpenCodeCallbacks(directory: string, serverUrl = 'http://127.0.0.1:4096'): Promise<{ configPath: string; nativeConfigPath: string }> {
  const url = new URL(serverUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('OpenCode callbacks require a trusted local HTTP server.');
  serverUrl = url.toString().replace(/\/$/, '');
  const root = resolve(directory);
  const artifact = await readFile(new URL('./bridge-plugin.mjs', import.meta.url));
  await mkdir(dirname(root), { recursive: true, mode: 0o700 });
  await mkdir(root, { mode: 0o700 });
  const pluginDirectory = join(root, 'arc-plugin');
  const pluginPath = join(pluginDirectory, 'server.js');
  const configPath = join(root, 'callback.json');
  const nativeConfigPath = join(root, 'opencode-arc.json');
  try {
    await mkdir(pluginDirectory, { mode: 0o700 });
    await writeFile(join(pluginDirectory, 'package.json'), JSON.stringify({ name: 'arc-host-callbacks', private: true, type: 'module' }) + '\n', { mode: 0o600, flag: 'wx' });
    await writeFile(pluginPath, artifact, { mode: 0o600, flag: 'wx' });
    await writeFile(nativeConfigPath, JSON.stringify({ plugins: [{ package: pathToFileURL(pluginDirectory).href, options: { configPath, serverUrl } }] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  } catch (error) {
    await Promise.allSettled([rm(pluginDirectory, { recursive: true, force: true }), unlink(nativeConfigPath)]); await rmdir(root).catch(() => undefined); throw error;
  }
  return { configPath, nativeConfigPath };
}

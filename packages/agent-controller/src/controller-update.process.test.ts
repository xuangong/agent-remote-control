// A real `npm pack` and offline install: it starts child processes, so it runs in the process tier.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { controllerNpm, installControllerRelease } from './controller-update.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
async function directory() { const root = await mkdtemp(join(tmpdir(), 'controller-update-')); roots.push(root); return root; }
const release = { protocolVersion: '1.8.0', version: '0.2.0', revision: 'b'.repeat(40), asset: 'orchardworks-agent-remote-controller-0.2.0.tgz', sha256: 'c'.repeat(64), nodeMajor: 22, platforms: ['darwin-arm64'] };
it('installs a verified package without lifecycle scripts and preserves the active version', async () => {
  const root = await directory();
  const source = join(root, 'source');
  await mkdir(join(source, 'dist'), { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({
    name: '@orchardworks/agent-remote-controller', version: release.version,
    scripts: { preinstall: 'node -e "process.exit(99)"', postinstall: 'node -e "process.exit(99)"' },
  }));
  await writeFile(join(source, 'build-info.json'), JSON.stringify({ version: release.version, revision: release.revision, dirty: false }));
  await writeFile(join(source, 'dist/cli.js'), "console.log('0.2.0');");
  const npm = await controllerNpm();
  await promisify(execFile)(process.execPath, [npm, 'pack', '--offline', '--ignore-scripts', '--pack-destination', root],
    { cwd: source, timeout: 10000 });
  const bytes = await readFile(join(root, release.asset));
  const verified = { ...release, sha256: createHash('sha256').update(bytes).digest('hex') };
  await mkdir(join(root, 'controller-updates'));
  await writeFile(join(root, 'controller-updates/current.json'), '{"version":"0.1.0"}');
  const fetcher = vi.fn(async () => new Response(bytes));
  await installControllerRelease(root, verified, fetcher as typeof fetch);
  const installed = join(root, 'controller-updates/packages', release.version, 'node_modules/@orchardworks/agent-remote-controller');
  expect(JSON.parse(await readFile(join(installed, 'build-info.json'), 'utf8'))).toMatchObject({ revision: release.revision, dirty: false });
  expect(await readFile(join(root, 'controller-updates/current.json'), 'utf8')).toBe('{"version":"0.1.0"}');
  await installControllerRelease(root, verified, fetcher as typeof fetch);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await writeFile(join(installed,'old-marker'),'old runtime');
  await installControllerRelease(root,verified,fetcher as typeof fetch,true);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(await readFile(join(installed,'old-marker'),'utf8')).toBe('old runtime');
  const clean=join(root,'controller-updates/packages',release.version+'.reinstall','node_modules/@orchardworks/agent-remote-controller');
  expect(JSON.parse(await readFile(join(clean,'build-info.json'),'utf8')).revision).toBe(release.revision);
  await expect(readFile(join(clean,'old-marker'))).rejects.toMatchObject({code:'ENOENT'});
}, 15000);

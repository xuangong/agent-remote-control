import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { controllerNpm, createControllerUpdater, installControllerRelease } from './controller-update.js';
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function directory() { const root = await mkdtemp(join(tmpdir(), 'controller-update-')); roots.push(root); return root; }
const identity = { version: '0.1.0', revision: 'a'.repeat(40), platform: 'darwin', arch: 'arm64', nodeMajor: 22, remoteUpdate: true };
const release = { protocolVersion: '1.5.0', version: '0.2.0', revision: 'b'.repeat(40), asset: 'orchardworks-agent-remote-controller-0.2.0.tgz', sha256: 'c'.repeat(64), nodeMajor: 22, platforms: ['darwin-arm64'] };
it.each(['darwin-arm64', 'win32-x64', 'linux-x64', 'linux-arm64'])('stages %s once and waits for safe restart across retries', async platform => {
  const [os, arch] = platform.split('-');
  const identity = { version: '0.1.0', revision: 'a'.repeat(40), platform: os!, arch: arch!, nodeMajor: 22, remoteUpdate: true };
  const supportedRelease = { ...release, platforms: [platform] };
  const stateDir = await directory(); let safe = false; let installations = 0; const restarted: string[] = [];
  const updater = createControllerUpdater({ stateDir, identity, release: async () => supportedRelease,
    install: async () => { installations++; }, beginRestart: () => safe, restart: version => { restarted.push(version); } });
  try {
    await updater.request('0.2.0', 'operation-one');
    await expect.poll(() => updater.status()).toMatchObject({ phase: 'waiting' });
    await updater.request('0.2.0', 'operation-one');
    await expect(updater.request('0.2.0', 'operation-two')).rejects.toThrow('already pending');
    expect(installations).toBe(1); expect(restarted).toEqual([]);
    safe = true;
    await expect.poll(() => restarted, { timeout: 4000 }).toEqual(['0.2.0']);
    expect(JSON.parse(await readFile(join(stateDir, 'controller-updates/status.json'), 'utf8'))).toMatchObject({ phase: 'restarting', operationId: 'operation-one' });
  } finally { await updater.close(); }
});
it('reports a failed download without stopping the running Controller and allows explicit retry', async () => {
  const stateDir = await directory(); let attempts = 0; const restart = vi.fn();
  const updater = createControllerUpdater({ stateDir, identity, release: async () => release,
    install: async () => { attempts++; throw new Error('Network unavailable'); }, beginRestart: () => true, restart });
  try {
    await updater.request('0.2.0', 'operation-one');
    await expect.poll(async () => (await updater.status()).phase).toBe('failed');
    expect(restart).not.toHaveBeenCalled();
    await updater.request('0.2.0', 'operation-one');
    await expect.poll(() => attempts).toBe(2);
    await expect(updater.request('0.1.0', 'operation-old')).rejects.toThrow();
  } finally { await updater.close(); }
});
it('rejects tampered packages before npm or any current installation is changed', async () => {
  const root = await directory(); await mkdir(join(root, 'controller-updates')); await writeFile(join(root, 'controller-updates/current.json'), '{"version":"0.1.0"}');
  await expect(installControllerRelease(root, release, (async () => new Response('not-the-package')) as typeof fetch)).rejects.toThrow('checksum');
  expect(await readFile(join(root, 'controller-updates/current.json'), 'utf8')).toBe('{"version":"0.1.0"}');
});
it('reopens admission when launcher activation fails', async () => {
  const stateDir = await directory(); let draining = false;
  const updater = createControllerUpdater({ stateDir, identity, release: async () => release, install: async () => {},
    beginRestart: () => { draining = true; return true; }, cancelRestart: () => { draining = false; },
    restart: async () => { throw new Error('Launcher disconnected'); } });
  try {
    await updater.request('0.2.0', 'operation-one');
    await expect.poll(async () => (await updater.status()).phase).toBe('failed');
    expect(draining).toBe(false);
  } finally { await updater.close(); }
});
it('keeps the Controller running when a failed update cannot persist its status', async () => {
  const stateDir = await directory(); const restart = vi.fn();
  const updater = createControllerUpdater({ stateDir, identity, release: async () => release,
    install: async () => {
      const path = join(stateDir, 'controller-updates/status.json');
      await rm(path); await mkdir(path);
      throw new Error('Installation failed');
    }, beginRestart: () => true, restart });
  try {
    await updater.request('0.2.0', 'operation-one');
    await expect.poll(() => updater.status(), { timeout: 3000 }).toMatchObject({ phase: 'failed', message: expect.stringContaining('could not be saved') });
    expect(restart).not.toHaveBeenCalled();
  } finally { await updater.close(); }
});
it('accepts a later version after the launcher settles a candidate observed while restarting', async () => {
  const stateDir = await directory(); const path = join(stateDir, 'controller-updates/status.json');
  await mkdir(join(stateDir, 'controller-updates'));
  const prior = { phase: 'restarting', version: '0.2.0', operationId: 'previous-update', updatedAt: Date.now() };
  await writeFile(path, JSON.stringify(prior));
  const updater = createControllerUpdater({ stateDir, identity: { ...identity, version: '0.2.0' },
    release: async () => ({ ...release, version: '0.3.0' }), install: async () => {}, beginRestart: () => false, restart: () => {} });
  try {
    expect((await updater.status()).phase).toBe('restarting');
    await writeFile(path, JSON.stringify({ ...prior, phase: 'succeeded' }));
    expect((await updater.status()).phase).toBe('succeeded');
    expect((await updater.request('0.3.0', 'next-update')).version).toBe('0.3.0');
    await expect.poll(async () => (await updater.status()).phase).toBe('waiting');
  } finally { await updater.close(); }
});

it.each(['bin/node_modules/npm', 'lib/node_modules/npm', 'share/nodejs/npm', 'share/npm'])(
  'finds npm in the %s installation layout without relying on PATH', async layout => {
    const root = await directory();
    const npm = join(root, layout, 'bin/npm-cli.js');
    await mkdir(join(root, layout, 'bin'), { recursive: true });
    await writeFile(npm, '');
    expect(await controllerNpm(join(root, 'bin/node'))).toBe(npm);
  });
it('fails explicitly when the Node installation has no npm', async () => {
  await expect(controllerNpm(join(await directory(), 'bin/node'))).rejects.toThrow('Install npm');
});

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
it('clean install stages fresh files even for the current version and keeps safe restart gating', async () => {
  const root = await directory(); let safe = false;
  const install = vi.fn(async () => {}), restart = vi.fn();
  const updater = createControllerUpdater({ stateDir:root, identity:{...identity,version:release.version},
    release:async()=>release, install, beginRestart:()=>safe, restart });
  try {
    await updater.request(release.version,'clean-install-intent',true);
    await expect.poll(async()=>(await updater.status()).phase).toBe('waiting');
    expect(install).toHaveBeenCalledWith(release,true);expect(restart).not.toHaveBeenCalled();
    safe=true;
    await expect.poll(()=>restart.mock.calls.length,{timeout:4000}).toBe(1);
    expect(restart).toHaveBeenCalledWith(release.version,true);
  } finally {await updater.close();}
});

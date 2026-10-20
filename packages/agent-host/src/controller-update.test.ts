import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { controllerNpm, createControllerUpdater, installControllerRelease, pruneControllerPackages, refreshInstalledLauncher, removeUnusedClaudeRuntime } from './controller-update.js';
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function directory() { const root = await mkdtemp(join(tmpdir(), 'controller-update-')); roots.push(root); return root; }
const identity = { version: '0.1.0', revision: 'a'.repeat(40), platform: 'darwin', arch: 'arm64', nodeMajor: 22, remoteUpdate: true };
const release = { protocolVersion: '1.8.0', version: '0.2.0', revision: 'b'.repeat(40), asset: 'orchardworks-agent-remote-controller-0.2.0.tgz', sha256: 'c'.repeat(64), nodeMajor: 22, platforms: ['darwin-arm64'] };
it.each(['darwin-arm64', 'win32-x64', 'linux-x64', 'linux-arm64'])('activates a verified %s update immediately and deduplicates retries', async platform => {
  const [os, arch] = platform.split('-');
  const stateDir = await directory(); let installations = 0;
  const beginRestart = vi.fn(() => true), restart = vi.fn();
  const updater = createControllerUpdater({ stateDir, identity: { ...identity, platform: os!, arch: arch! },
    release: async () => ({ ...release, platforms: [platform] }),
    install: async () => { installations++; }, beginRestart, restart });
  try {
    await updater.request('0.2.0', 'operation-one');
    await expect.poll(() => restart.mock.calls.length).toBe(1);
    expect(restart).toHaveBeenCalledWith('0.2.0');
    expect(beginRestart).toHaveBeenCalledTimes(1);
    await updater.request('0.2.0', 'operation-one');
    await expect(updater.request('0.2.0', 'operation-two')).rejects.toThrow('already pending');
    expect(installations).toBe(1); expect(restart).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(stateDir, 'controller-updates/status.json'), 'utf8'))).toMatchObject({ phase: 'restarting', operationId: 'operation-one' });
  } finally { await updater.close(); }
});
it('fails explicitly when restart admission is unavailable instead of polling indefinitely', async () => {
  const beginRestart = vi.fn(() => false), restart = vi.fn();
  const updater = createControllerUpdater({ stateDir: await directory(), identity,
    release: async () => release, install: async () => {}, beginRestart, restart });
  try {
    await updater.request('0.2.0', 'operation-one');
    await expect.poll(() => updater.status()).toMatchObject({ phase: 'failed', message: expect.stringContaining('already stopping') });
    expect(beginRestart).toHaveBeenCalledTimes(1);
    expect(restart).not.toHaveBeenCalled();
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
    release: async () => ({ ...release, version: '0.3.0' }), install: async () => {}, beginRestart: () => true, restart: () => {} });
  try {
    expect((await updater.status()).phase).toBe('restarting');
    await writeFile(path, JSON.stringify({ ...prior, phase: 'succeeded' }));
    expect((await updater.status()).phase).toBe('succeeded');
    expect((await updater.request('0.3.0', 'next-update')).version).toBe('0.3.0');
    await expect.poll(async () => (await updater.status()).phase).toBe('restarting');
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
it('clean install activates fresh files immediately even for the current version', async () => {
  const root = await directory();
  const install = vi.fn(async () => {}), restart = vi.fn();
  const updater = createControllerUpdater({ stateDir: root, identity: { ...identity, version: release.version },
    release: async () => release, install, beginRestart: () => true, restart });
  try {
    await updater.request(release.version, 'clean-install-intent', true);
    await expect.poll(() => restart.mock.calls.length).toBe(1);
    expect(install).toHaveBeenCalledWith(release, true);
    expect(restart).toHaveBeenCalledWith(release.version, true);
    expect((await updater.status()).phase).toBe('restarting');
  } finally { await updater.close(); }
});

it('installs across a session protocol change while retaining platform checks', async () => {
  const stateDir = await directory();
  const restart = vi.fn();
  const updater = createControllerUpdater({ stateDir, identity,
    release: async () => ({ ...release, protocolVersion: '1.8.0' }),
    install: async () => {}, beginRestart: () => true, restart });
  try {
    await updater.request(release.version, 'protocol-upgrade');
    await expect.poll(async () => (await updater.status()).phase).toBe('restarting');
    await expect.poll(() => restart.mock.calls.length).toBe(1);
    expect(restart).toHaveBeenCalledWith(release.version);
  } finally { await updater.close(); }
});

async function installed(stateDir: string, names: string[], saved?: string, status?: string) {
  for (const name of names) await mkdir(join(stateDir, 'controller-updates/packages', name, 'node_modules'), { recursive: true });
  if (saved) await writeFile(join(stateDir, 'controller-updates/current.json'), JSON.stringify({ version: saved }));
  if (status) await writeFile(join(stateDir, 'controller-updates/status.json'), JSON.stringify({ phase: status }));
  return async () => (await readdir(join(stateDir, 'controller-updates/packages'))).sort();
}
it('prunes releases older than the newest previous one once the running release is committed', async () => {
  const stateDir = await directory();
  const names = ['0.2.9', '0.2.10', '0.2.53', '0.2.54', '0.2.55', '0.2.56', '0.2.52.local-72e55b16', '0.2.57.staging-abc', '0.2.55.clean-backup'];
  const remaining = await installed(stateDir, names, '0.2.55', 'succeeded');
  expect((await pruneControllerPackages(stateDir, '0.2.55')).sort()).toEqual(['0.2.10', '0.2.53', '0.2.9']);
  expect(await remaining()).toEqual(['0.2.52.local-72e55b16', '0.2.54', '0.2.55', '0.2.55.clean-backup', '0.2.56', '0.2.57.staging-abc']);
  expect(await pruneControllerPackages(stateDir, '0.2.55')).toEqual([]);
});
it.each([
  ['the launcher has not committed the running release', '0.2.54', 'succeeded'],
  ['an update is in progress', '0.2.55', 'downloading'],
  ['an activation is in progress', '0.2.55', 'restarting'],
])('keeps every release while %s', async (_case, saved, status) => {
  const stateDir = await directory();
  const remaining = await installed(stateDir, ['0.2.53', '0.2.54', '0.2.55'], saved, status);
  expect(await pruneControllerPackages(stateDir, '0.2.55')).toEqual([]);
  expect(await remaining()).toEqual(['0.2.53', '0.2.54', '0.2.55']);
});
it('keeps every release while a clean reinstall journal awaits recovery', async () => {
  const stateDir = await directory();
  const remaining = await installed(stateDir, ['0.2.53', '0.2.54', '0.2.55'], '0.2.55', 'succeeded');
  await writeFile(join(stateDir, 'controller-updates/reinstall.json'), JSON.stringify({ version: '0.2.55' }));
  expect(await pruneControllerPackages(stateDir, '0.2.55')).toEqual([]);
  expect(await remaining()).toEqual(['0.2.53', '0.2.54', '0.2.55']);
});

async function launchers(saved = '0.2.57') {
  const stateDir = await directory();
  const bootstrap = join(stateDir, 'bootstrap/dist'), release = join(stateDir, 'controller-updates/packages/0.2.57/dist');
  await mkdir(bootstrap, { recursive: true }); await mkdir(release, { recursive: true });
  await writeFile(join(bootstrap, 'cli.js'), 'bootstrap cli'); await writeFile(join(bootstrap, 'launcher.js'), 'old launcher');
  await writeFile(join(release, 'launcher.js'), 'new launcher');
  await writeFile(join(stateDir, 'controller-updates/current.json'), JSON.stringify({ version: saved }));
  return { stateDir, installed: join(bootstrap, 'launcher.js'), release: join(release, 'launcher.js') };
}
it('replaces the installed launcher with a checked release launcher and keeps the previous one', async () => {
  const f = await launchers(); const checked: string[] = [];
  const check = async (launcher: string) => { checked.push(launcher); return '{"ok":true}\n'; };
  expect(await refreshInstalledLauncher({ ...f, runningVersion: '0.2.57', check })).toBe('replaced');
  expect(checked).toEqual([f.release]);
  expect(await readFile(f.installed, 'utf8')).toBe('new launcher');
  expect(await readFile(f.installed + '.previous', 'utf8')).toBe('old launcher');
  expect(await refreshInstalledLauncher({ ...f, runningVersion: '0.2.57', check })).toBe('current');
  expect(checked).toHaveLength(1);
});
it('leaves the installed launcher alone unless the running release is committed and its launcher passes the check', async () => {
  const uncommitted = await launchers('0.2.56');
  expect(await refreshInstalledLauncher({ ...uncommitted, runningVersion: '0.2.57', check: async () => '{"ok":true}' })).toBe('skipped');
  const f = await launchers();
  expect(await refreshInstalledLauncher({ ...f, installed: undefined, runningVersion: '0.2.57' })).toBe('skipped');
  expect(await refreshInstalledLauncher({ ...f, installed: f.release, runningVersion: '0.2.57' })).toBe('skipped');
  await expect(refreshInstalledLauncher({ ...f, runningVersion: '0.2.57', check: async () => { throw new Error('crashed'); } })).rejects.toThrow('crashed');
  await expect(refreshInstalledLauncher({ ...f, runningVersion: '0.2.57', check: async () => '{"ok":false}' })).rejects.toThrow('could not read');
  expect(await readFile(f.installed, 'utf8')).toBe('old launcher');
  await expect(readFile(f.installed + '.previous')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('removes only the Claude SDK platform runtime from an installed release', async () => {
  const nodeModules = join(await directory(), 'node_modules');
  for (const name of ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk-darwin-arm64', '@anthropic-ai/claude-agent-sdk-linux-x64-musl', '@anthropic-ai/sdk', '@github/copilot-darwin-arm64'])
    await mkdir(join(nodeModules, name), { recursive: true });
  await removeUnusedClaudeRuntime(nodeModules);
  expect((await readdir(join(nodeModules, '@anthropic-ai'))).sort()).toEqual(['claude-agent-sdk', 'sdk']);
  expect(await readdir(join(nodeModules, '@github'))).toEqual(['copilot-darwin-arm64']);
  await removeUnusedClaudeRuntime(join(nodeModules, 'missing'));
});

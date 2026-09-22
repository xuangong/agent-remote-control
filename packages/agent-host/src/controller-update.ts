import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareControllerVersions, releaseCoversHost, type ControllerIdentity, type ControllerRelease, type ControllerUpdateStatus } from '@orchardworks/agent-remote-protocol';
import { controllerAssetUrl, controllerReleases } from '@orchardworks/agent-remote-hosted';
import { atomicPrivate } from './autostart-state.js';
const exec = promisify(execFile);
export async function controllerIdentity(moduleUrl: string): Promise<ControllerIdentity | undefined> {
  try {
    const info = JSON.parse(await readFile(join(dirname(fileURLToPath(moduleUrl)), '../build-info.json'), 'utf8'));
    if (!info.version || !/^[a-f0-9]{40}$/.test(info.revision)) return undefined;
    return { version: info.version, revision: info.revision, platform: process.platform, arch: process.arch,
      nodeMajor: Number(process.versions.node.split('.')[0]), remoteUpdate: !info.dirty && process.env.AGENT_HOST_MANAGED_UPDATES === '1' && !!process.send };
  } catch { return undefined; }
}
/** Resolve npm from the Node installation, including distribution-managed Linux layouts. */
export async function controllerNpm(nodePath = process.execPath): Promise<string> {
  const bin = dirname(nodePath);
  const candidates = [join(bin, 'node_modules/npm/bin/npm-cli.js'),
    resolve(bin, '../lib/node_modules/npm/bin/npm-cli.js'),
    resolve(bin, '../share/nodejs/npm/bin/npm-cli.js'),
    resolve(bin, '../share/npm/bin/npm-cli.js')];
  for (const path of candidates) {
    try { await access(path); return path; } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  throw new Error('npm is unavailable in this Node installation. Install npm before updating this Controller.');
}
export async function installControllerRelease(stateDir: string, release: ControllerRelease, fetcher: typeof fetch = fetch): Promise<void> {
  const root = join(stateDir, 'controller-updates/packages'); await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, release.version);
  try {
    const info = JSON.parse(await readFile(join(target, 'node_modules/@orchardworks/agent-remote-controller/build-info.json'), 'utf8'));
    if (info.revision === release.revision && info.version === release.version && info.dirty === false) return;
    throw new Error('An existing update directory does not match this release.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const stage = join(root, `${release.version}.staging-${process.pid}`);
  await mkdir(stage, { recursive: true, mode: 0o700 });
  try {
    const response = await fetcher(controllerAssetUrl(release.version, release.asset), { signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body) throw new Error('Controller download failed. The running version is unchanged.');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > 128 * 1024 * 1024) { await reader.cancel(); throw new Error('Controller package exceeds the download limit.'); }
      chunks.push(part.value);
    } } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    if (createHash('sha256').update(bytes).digest('hex') !== release.sha256) throw new Error('Controller package checksum verification failed.');
    const archive = join(stage, release.asset); await writeFile(archive, bytes, { mode: 0o600 });
    const npm = await controllerNpm();
    try { await exec(process.execPath, [npm, 'install', '--prefix', stage, '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', archive],
      { timeout: 240000, maxBuffer: 1024 * 1024, windowsHide: true }); }
    catch { throw new Error('Controller package installation failed. Check Host network and npm access, then retry.'); }
    const packageRoot = join(stage, 'node_modules/@orchardworks/agent-remote-controller');
    const info = JSON.parse(await readFile(join(packageRoot, 'build-info.json'), 'utf8'));
    if (info.version !== release.version || info.revision !== release.revision || info.dirty !== false) throw new Error('Installed Controller identity does not match the release.');
    await exec(process.execPath, [join(packageRoot, 'dist/cli.js'), '--version'], { timeout: 15000, maxBuffer: 65536, windowsHide: true });
    await rm(archive); await rename(stage, target);
  } finally { await rm(stage, { recursive: true, force: true }); }
}
export function createControllerUpdater(options: {
  stateDir: string; identity: ControllerIdentity; release?: (version: string) => Promise<ControllerRelease>;
  install?: (release: ControllerRelease) => Promise<void>; beginRestart(): boolean; cancelRestart?(): void; restart(version: string): void | Promise<void>;
}) {
  const path = join(options.stateDir, 'controller-updates/status.json');
  let status: ControllerUpdateStatus = { phase: 'idle', updatedAt: Date.now() };
  let initialized: Promise<void> | undefined, work: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined, closed = false, accepting = false;
  async function init() { return initialized ??= (async () => {
    try { status = JSON.parse(await readFile(path, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (status.phase === 'waiting' || status.phase === 'downloading') await save({ ...status, phase: 'failed', message: 'The previous update was interrupted. Retry to continue.' });
  })(); }
  async function refreshLauncherResult() {
    if (status.phase !== 'restarting' || work || accepting) return;
    const saved = JSON.parse(await readFile(path, 'utf8')) as ControllerUpdateStatus;
    if (status.phase === 'restarting' && !work && !accepting && saved.operationId === status.operationId
      && saved.version === status.version && ['succeeded', 'failed'].includes(saved.phase)) status = saved;
  }
  async function save(value: ControllerUpdateStatus) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); status = { ...value, updatedAt: Date.now() }; await atomicPrivate(path, JSON.stringify(status)); }
  async function activate() {
    if (closed) return;
    if (!options.beginRestart()) { timer = setTimeout(() => { void activate().catch(fail); }, 2000); timer.unref(); return; }
    try {
      await save({ ...status, phase: 'restarting', message: undefined }); await options.restart(status.version!);
    } catch (error) { options.cancelRestart?.(); throw error; }
  }
  async function fail(error: unknown) {
    try { await save({ ...status, phase: 'failed', message: error instanceof Error ? error.message.slice(0, 300) : 'Controller update failed.' }); }
    catch { status = { ...status, phase: 'failed', message: 'Controller update failed and its status could not be saved. Check the Controller state directory before retrying.', updatedAt: Date.now() }; }
  }
  return {
    async status() { await init(); if (status.phase === 'failed') return { ...status }; try { return JSON.parse(await readFile(path, 'utf8')) as ControllerUpdateStatus; } catch { return { ...status }; } },
    async request(version: string, operationId: string) {
      await init(); await refreshLauncherResult();
      if (!options.identity.remoteUpdate) throw new Error('Install the release launcher locally before using remote updates.');
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(operationId)) throw new Error('Invalid Controller update operation.');
      if (accepting || work || ['waiting', 'restarting'].includes(status.phase)) {
        if (status.version === version && status.operationId === operationId) return { ...status };
        throw new Error('Another Controller update is already pending.');
      }
      if (status.operationId === operationId && status.version === version && status.phase === 'succeeded') return { ...status };
      if (compareControllerVersions(version, options.identity.version) <= 0) throw new Error('Only a newer Controller version can be installed.');
      accepting = true;
      try { await save({ phase: 'downloading', version, operationId, updatedAt: Date.now() }); } finally { accepting = false; }
      work = (async () => {
        const release = await (options.release ?? controllerReleases.version)(version);
        if (!releaseCoversHost(release, options.identity)) throw new Error('This release does not support this Host platform or Node version.');
        await (options.install ?? (r => installControllerRelease(options.stateDir, r)))(release);
        if (closed) return;
        await save({ ...status, phase: 'waiting', message: 'Waiting for a safe restart window.' });
        await activate();
      })().catch(fail).finally(() => { work = undefined; });
      return { ...status };
    },
    async close() { closed = true; clearTimeout(timer); await work; },
  };
}

/** Let the supervisor acknowledge activation before keeping admission closed. */
export async function requestLauncherRestart(version: string): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 250));
  await new Promise<void>((resolve, reject) => {
    if (!process.send || !process.connected) return reject(new Error('Controller launcher is disconnected.'));
    const finish = (error?: Error) => { clearTimeout(timer); process.off('message', message); process.off('disconnect', disconnected); error ? reject(error) : resolve(); };
    const message = (value: unknown) => {
      const reply = value as { type?: string; version?: string } | null;
      if (reply?.version !== version) return;
      if (reply.type === 'controller-update-accepted') finish();
      if (reply.type === 'controller-update-rejected') finish(new Error('Controller launcher could not activate the installed release.'));
    };
    const disconnected = () => finish(new Error('Controller launcher disconnected before accepting the update.'));
    const timer = setTimeout(() => finish(new Error('Controller launcher did not acknowledge the update.')), 10000);
    process.on('message', message); process.once('disconnect', disconnected);
    process.send({ type: 'controller-update', version }, error => { if (error) finish(error); });
  });
}

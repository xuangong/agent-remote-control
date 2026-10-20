import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, readdir, rename, writeFile, rm, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareControllerVersions, releaseCoversHost, type ControllerIdentity, type ControllerRelease, type ControllerUpdateStatus } from '@orchardworks/agent-remote-protocol';
import { controllerAssetUrl, controllerReleases } from '@orchardworks/agent-remote-hosted';
import { atomicPrivate } from './autostart-state.js';
import { publishControllerPackage } from './controller-package.js';
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
  if (nodePath === process.execPath) {
    for (const directory of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)) {
      try { const path = await realpath(join(directory, 'npm')); if (path.endsWith('/bin/npm-cli.js')) return path; } catch { /* Continue through PATH. */ }
    }
  }
  throw new Error('npm is unavailable in this Node installation. Install npm before updating this Controller.');
}
/**
 * The Claude provider always runs the Claude Code installed on this computer, never the copy the Claude SDK
 * installs as a platform package, which is several hundred megabytes per release.
 */
export async function removeUnusedClaudeRuntime(nodeModules: string): Promise<void> {
  const scope = join(nodeModules, '@anthropic-ai');
  let names: string[];
  try { names = await readdir(scope); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const name of names) if (/^claude-agent-sdk-[a-z0-9-]+$/.test(name)) await rm(join(scope, name), { recursive: true, force: true });
}
export async function installControllerRelease(stateDir: string, release: ControllerRelease, fetcher: typeof fetch = fetch, clean = false): Promise<void> {
  const root = join(stateDir, 'controller-updates/packages'); await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, release.version + (clean ? '.reinstall' : ''));
  if (clean) await rm(target, { recursive: true, force: true });
  try {
    const info = JSON.parse(await readFile(join(target, 'node_modules/@orchardworks/agent-remote-controller/build-info.json'), 'utf8'));
    if (info.revision === release.revision && info.version === release.version && info.dirty === false) return;
    throw new Error('An existing update directory does not match this release.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const stage = await mkdtemp(join(root, `${release.version}.staging-`));
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
    await removeUnusedClaudeRuntime(join(stage, 'node_modules'));
    const packageRoot = join(stage, 'node_modules/@orchardworks/agent-remote-controller');
    const info = JSON.parse(await readFile(join(packageRoot, 'build-info.json'), 'utf8'));
    if (info.version !== release.version || info.revision !== release.revision || info.dirty !== false) throw new Error('Installed Controller identity does not match the release.');
    await exec(process.execPath, [join(packageRoot, 'dist/cli.js'), '--version'], { timeout: 15000, maxBuffer: 65536, windowsHide: true });
    await rm(archive); await publishControllerPackage(stage, target);
  } catch (error) {
    // Preserve the installation error if a lingering Windows handle also prevents cleanup.
    try { await rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* A retry uses a fresh staging directory. */ }
    throw error;
  }
}
const releaseDirectory = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
/**
 * Each installed release holds several hundred megabytes of native runtimes. Once the launcher has committed the
 * running release, keep it, any newer installation, and the newest older release; remove the older ones.
 */
export async function pruneControllerPackages(stateDir: string, runningVersion: string): Promise<string[]> {
  const updates = join(stateDir, 'controller-updates');
  const read = async (name: string) => {
    try { return JSON.parse(await readFile(join(updates, name), 'utf8')) as { version?: unknown; phase?: unknown }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  };
  if ((await read('current.json'))?.version !== runningVersion || await read('reinstall.json')) return [];
  if (['downloading', 'waiting', 'restarting'].includes((await read('status.json'))?.phase as string)) return [];
  const older = (await readdir(join(updates, 'packages'))).filter(name => releaseDirectory.test(name) && compareControllerVersions(name, runningVersion) < 0)
    .sort(compareControllerVersions);
  const removed: string[] = [];
  for (const version of older.slice(0, -1)) {
    try { await rm(join(updates, 'packages', version), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); removed.push(version); }
    catch { /* A locked file keeps that release until the next start. */ }
  }
  return removed;
}
/**
 * The service runs the launcher from the first installed package, and updates never replace that package. Once the
 * launcher has committed the running release, put this release's launcher in its place after it proves it can read
 * this installation. The running launcher keeps its code until the service next restarts; the replaced file stays
 * beside it as launcher.js.previous.
 */
export async function refreshInstalledLauncher(options: { stateDir: string; runningVersion: string; installed: string | undefined; release: string;
  check?: (launcher: string) => Promise<string> }): Promise<'current' | 'replaced' | 'skipped'> {
  const { installed, release } = options;
  if (!installed || !isAbsolute(installed) || basename(installed) !== 'launcher.js' || resolve(installed) === resolve(release)) return 'skipped';
  try {
    const saved = JSON.parse(await readFile(join(options.stateDir, 'controller-updates/current.json'), 'utf8')) as { version?: unknown };
    if (saved.version !== options.runningVersion) return 'skipped';
    await access(join(dirname(installed), 'cli.js'));
  } catch { return 'skipped'; }
  const [current, next] = await Promise.all([readFile(installed), readFile(release)]);
  if (current.equals(next)) return 'current';
  const check = options.check ?? (async (launcher: string) => (await exec(process.execPath, [launcher, '_launcher-check'],
    { env: { ...process.env, AGENT_HOST_STATE_DIR: options.stateDir }, timeout: 15000, maxBuffer: 65536, windowsHide: true })).stdout);
  const output = (await check(release)).trim().split('\n').at(-1) ?? '';
  if ((JSON.parse(output) as { ok?: unknown }).ok !== true) throw new Error('The release launcher could not read this installation.');
  await writeFile(installed + '.previous', current, { mode: 0o755 });
  await writeFile(installed + '.next', next, { mode: 0o755 });
  await rename(installed + '.next', installed);
  return 'replaced';
}
export function createControllerUpdater(options: {
  stateDir: string; identity: ControllerIdentity; release?: (version: string) => Promise<ControllerRelease>;
  install?: (release: ControllerRelease, clean?: boolean) => Promise<void>; beginRestart(): boolean; cancelRestart?(): void; restart(version: string, clean?: boolean): void | Promise<void>;
}) {
  const path = join(options.stateDir, 'controller-updates/status.json');
  let cleanInstall = false;
  let status: ControllerUpdateStatus = { phase: 'idle', updatedAt: Date.now() };
  let initialized: Promise<void> | undefined, work: Promise<void> | undefined, closed = false, accepting = false;
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
    if (!options.beginRestart()) throw new Error('Controller is already stopping. Retry the update after it reconnects.');
    try {
      await save({ ...status, phase: 'restarting', message: undefined }); await options.restart(status.version!, ...(cleanInstall ? [true] as const : []));
    } catch (error) { options.cancelRestart?.(); throw error; }
  }
  async function fail(error: unknown) {
    try { await save({ ...status, phase: 'failed', message: error instanceof Error ? error.message.slice(0, 300) : 'Controller update failed.' }); }
    catch { status = { ...status, phase: 'failed', message: 'Controller update failed and its status could not be saved. Check the Controller state directory before retrying.', updatedAt: Date.now() }; }
  }
  return {
    async status() { await init(); if (status.phase === 'failed') return { ...status }; try { return JSON.parse(await readFile(path, 'utf8')) as ControllerUpdateStatus; } catch { return { ...status }; } },
    async request(version: string, operationId: string, clean = false) {
      await init(); await refreshLauncherResult();
      if (!options.identity.remoteUpdate) throw new Error('Install the release launcher locally before using remote updates.');
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(operationId)) throw new Error('Invalid Controller update operation.');
      if (accepting || work || ['waiting', 'restarting'].includes(status.phase)) {
        if (status.version === version && status.operationId === operationId) return { ...status };
        throw new Error('Another Controller update is already pending.');
      }
      if (status.operationId === operationId && status.version === version && status.phase === 'succeeded') return { ...status };
      if (compareControllerVersions(version, options.identity.version) < (clean ? 0 : 1)) throw new Error('Only a newer Controller version can be installed.');
      cleanInstall = clean;
      accepting = true;
      try { await save({ phase: 'downloading', version, operationId, updatedAt: Date.now() }); } finally { accepting = false; }
      work = (async () => {
        const release = await (options.release ?? controllerReleases.version)(version);
        if (!releaseCoversHost(release, options.identity)) throw new Error('This release does not support this Host platform or Node version.');
        await (options.install ?? ((r, reinstall) => installControllerRelease(options.stateDir, r, fetch, reinstall)))(release, ...(clean ? [true] as const : []));
        if (closed) return;
        await activate();
      })().catch(fail).finally(() => { work = undefined; });
      return { ...status };
    },
    async close() { closed = true; await work; },
  };
}

/** Let the supervisor acknowledge activation before keeping admission closed. */
export async function requestLauncherRestart(version: string, clean = false): Promise<void> {
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
    process.send({ type: 'controller-update', version, ...(clean ? { clean: true } : {}) }, error => { if (error) finish(error); });
  });
}

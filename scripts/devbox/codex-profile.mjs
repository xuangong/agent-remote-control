import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

export async function prepareCodexProfile(home) {
  const directory = join(home, 'app-server-daemon');
  const settingsPath = join(directory, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(await readFile(settingsPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read valid Codex daemon settings at ${settingsPath}. Repair the file before starting the devbox.`);
  }
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(settings) || (settings.updater !== undefined && !object(settings.updater)))
    throw new Error(`Cannot read valid Codex daemon settings at ${settingsPath}. Repair the file before starting the devbox.`);
  if (settings.updater?.autoUpdateEnabled === false) return;
  const temporary = join(directory, `.settings-${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, `${JSON.stringify({ ...settings, updater: { ...settings.updater, autoUpdateEnabled: false } }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, settingsPath);
  } finally { await rm(temporary, { force: true }); }
}

async function metadata(path, follow = false) {
  try { return await (follow ? stat : lstat)(path); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`Cannot inspect the managed Codex runtime at ${path}. Repair its profile before starting the devbox.`);
  }
}

// Match Codex 0.162.0's managed_install.rs selection, including stopped legacy installs.
async function managedBinary(home) {
  const dedicated = join(home, 'packages/app-server-daemon');
  let root = dedicated;
  let installed = Boolean(await metadata(join(dedicated, 'current')));
  if (!installed) {
    for (const [name, artifacts] of [
      ['app-server-daemon', ['daemon.pid', 'daemon.stderr.log', 'daemon-updater.pid', 'daemon-updater.stderr.log']],
      ['standalone', ['app-server.pid', 'app-server.stderr.log', 'app-server-updater.pid', 'app-server-updater.stderr.log']],
    ]) {
      if ((await Promise.all(artifacts.map(name => metadata(join(home, 'app-server-daemon', name))))).some(Boolean)) {
        root = join(home, 'packages', name); installed = true; break;
      }
    }
  }
  if (!installed) return undefined;
  for (const relative of ['bin/codex', 'codex']) {
    const path = join(root, 'current', relative);
    if ((await metadata(path, true))?.isFile()) return path;
  }
  throw new Error(`The managed Codex runtime at ${root} is incomplete. Repair its profile before starting the devbox.`);
}

/** Align an existing package before any devbox service can start native work. */
export async function alignCodexRuntime(home, environment, workspace) {
  const managed = await managedBinary(home);
  if (!managed) return;
  const executable = environment.AGENT_HOST_CODEX ?? environment.AGENT_REMOTE_CODEX_EXECUTABLE ?? 'codex';
  const options = { env: { ...environment, CODEX_HOME: home }, cwd: workspace, timeout: 5000, maxBuffer: 65536 };
  const run = promisify(execFile);
  const version = async (command, description) => {
    try {
      const { stdout } = await run(command, ['--version'], options);
      const match = /^codex-cli (\S+)(?:\s|$)/.exec(stdout.trim());
      if (match) return match[1];
    } catch {}
    throw new Error(`Cannot read the Codex ${description} version. Use a supported CLI and repair its profile before starting the devbox.`);
  };
  const target = await version(executable, 'CLI');
  if (await version(managed, 'managed runtime') === target) return;
  try {
    await run(executable, ['app-server', 'daemon', 'update', '--from-cli', '--yes'], { ...options, timeout: 60000 });
  } catch {
    throw new Error('Codex daemon update --from-cli --yes failed. Use a supported CLI and repair its profile before starting the devbox.');
  }
  const updated = await managedBinary(home);
  if (!updated || await version(updated, 'managed runtime') !== target)
    throw new Error(`The managed Codex runtime version did not match the installed CLI ${target} after update. The devbox was not started.`);
}

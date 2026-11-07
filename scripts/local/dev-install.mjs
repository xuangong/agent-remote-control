import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { localRoot, readJson, writeJson } from './instance.mjs';

export const DEV_COMMAND = 'agent-remote-controller-dev';
const MARKER = '# Installed by pnpm local (agent-remote-control local development).';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function writeAtomically(path, content, mode) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

/** Where agent-remote-controller-dev goes: beside the installed agent-remote-controller unless ARC_LOCAL_BIN_DIR says otherwise. */
export function devCommandDirectory(environment = process.env) {
  return environment.ARC_LOCAL_BIN_DIR ? resolve(environment.ARC_LOCAL_BIN_DIR) : join(homedir(), '.local', 'bin');
}

/**
 * Installs agent-remote-controller-dev and the instance's session command directory, whose agent-remote-controller
 * runs agent-remote-controller-dev for this instance. A command file pnpm local did not write is left alone.
 */
export async function installDevCommand({ source, instance, environment = process.env, node = process.execPath }) {
  const root = localRoot(environment);
  const launcher = join(root, 'bin', 'dev-launcher.mjs');
  await mkdir(join(root, 'bin'), { recursive: true, mode: 0o700 });
  await writeAtomically(launcher, await readFile(join(source, 'scripts/local/dev-launcher.mjs'), 'utf8'), 0o644);
  await writeJson(join(root, 'default.json'), { directory: instance.directory });
  await mkdir(instance.bin, { recursive: true, mode: 0o700 });
  await writeAtomically(join(instance.bin, 'agent-remote-controller'), `#!/bin/sh\n${MARKER}\n`
    + `# In this instance's sessions, agent-remote-controller is ${DEV_COMMAND} for this instance.\n`
    + `ARC_LOCAL_ROOT=${quote(root)} ARC_LOCAL_INSTANCE=${quote(instance.directory)} exec ${quote(node)} ${quote(launcher)} "$@"\n`, 0o755);
  const directory = devCommandDirectory(environment);
  const command = join(directory, DEV_COMMAND);
  const existing = await readFile(command, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (existing !== undefined && !existing.includes(MARKER)) {
    return { command, installed: false, reason: `${command} exists and was not installed by pnpm local, so it was left alone.` };
  }
  await mkdir(directory, { recursive: true });
  await writeAtomically(command, `#!/bin/sh\n${MARKER}\n`
    + '# The Controller command line of a local development instance, chosen by the current directory.\n'
    + `ARC_LOCAL_ROOT=${quote(root)} exec ${quote(node)} ${quote(launcher)} "$@"\n`, 0o755);
  return { command, installed: true, onPath: (environment.PATH ?? '').split(delimiter).includes(directory) };
}

/** Forgets the instance as the default of agent-remote-controller-dev when it is removed. */
export async function forgetDefaultInstance(instance, environment = process.env) {
  const file = join(localRoot(environment), 'default.json');
  if ((await readJson(file).catch(() => undefined))?.directory === instance.directory) await rm(file, { force: true });
}

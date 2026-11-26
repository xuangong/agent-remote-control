import { accessSync, constants, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/** The oldest pi the adapter was checked against; the RPC protocol of a pre-1.0 CLI changes between releases. */
export const MIN_PI_VERSION = '0.73.1';

/** Reads the version out of `pi --version` output; undefined when the text names none. */
export function parsePiVersion(output: string): string | undefined {
  return /^v?(\d+\.\d+\.\d+)\s*$/m.exec(output.trim())?.[1];
}

const compare = (left: string, right: string): number => {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  return 0;
};

/** Why an installed pi cannot be used, or undefined when it can. */
export function piVersionIssue(output: string): { message: string } | undefined {
  const version = parsePiVersion(output);
  if (!version) return { message: `The executable did not report a pi version: ${output.trim().slice(0, 120) || 'no output'}.` };
  if (compare(version, MIN_PI_VERSION) < 0) return { message: `pi ${MIN_PI_VERSION} or newer is required; found ${version}.` };
  return undefined;
}

const isExecutableFile = (path: string): boolean => {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
};

/** Installer-managed Node versions, newest first: `pi` is an npm global and a login service does not inherit the shell's PATH. */
function nodeManagerDirectories(home: string, env: NodeJS.ProcessEnv): string[] {
  const directories: string[] = [];
  const versions = join(env.NVM_DIR ?? join(home, '.nvm'), 'versions', 'node');
  try {
    const numeric = (name: string) => name.replace(/^v/, '').split('.').map(Number);
    const names = readdirSync(versions).filter(name => /^v\d+\.\d+\.\d+$/.test(name)).sort((a, b) => {
      const x = numeric(a), y = numeric(b);
      for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return y[index]! - x[index]!;
      return 0;
    });
    for (const name of names) directories.push(join(versions, name, 'bin'));
  } catch { /* no nvm */ }
  directories.push(join(home, '.volta', 'bin'), join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'), join(home, '.bun', 'bin'));
  return directories;
}

/**
 * The pi executable to run: `command` when it is a path, otherwise the first `command` found on PATH, then in the places
 * npm and Node managers install global commands. The result is absolute and its symbolic links are resolved, so the
 * adapter can start the JavaScript entry with its own Node when the command's `#!/usr/bin/env node` finds none.
 */
export function resolvePiExecutable(command: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const name = command?.trim() || 'pi';
  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    const path = resolve(name);
    if (!isExecutableFile(path)) throw new Error(`The pi executable ${path} is not an executable file.`);
    return realpathSync(path);
  }
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const directories = [...(env.PATH ?? '').split(delimiter).filter(Boolean), join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', ...nodeManagerDirectories(home, env)];
  for (const directory of directories) {
    const path = resolve(directory, name);
    if (isExecutableFile(path)) return realpathSync(path);
  }
  throw new Error(`The pi executable was not found. Install @mariozechner/pi-coding-agent or set AGENT_HOST_PI to its path.`);
}

/** The command and arguments that start a resolved pi: a JavaScript entry runs under the current Node, anything else runs itself. */
export function piInvocation(executable: string, args: readonly string[]): { command: string; args: string[] } {
  return /\.(?:[cm]?js)$/i.test(executable) ? { command: process.execPath, args: [executable, ...args] } : { command: executable, args: [...args] };
}

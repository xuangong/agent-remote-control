import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

/** Run package-manager JavaScript directly on Windows, preserving literal arguments. */
export function packageManager(name, args) {
  if (process.platform !== 'win32') return [name, args];
  const inherited = process.env.npm_execpath;
  if (inherited && name === 'pnpm' && /pnpm\.(?:c?js)$/i.test(inherited)) return [process.execPath, [inherited, ...args]];
  const entry = name === 'npm' ? 'npm/bin/npm-cli.js' : 'pnpm/bin/pnpm.cjs';
  const path = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const directory of [dirname(process.execPath), ...path.split(delimiter)]) {
    const candidate = join(directory.replace(/^"|"$/g, ''), 'node_modules', entry);
    if (existsSync(candidate)) return [process.execPath, [candidate, ...args]];
  }
  throw new Error(`Cannot locate ${name}'s JavaScript entry point. Install ${name} on PATH.`);
}

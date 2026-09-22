import { existsSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';

/** Resolve npm-installed native tools without passing arguments through cmd.exe. */
export function resolveWindowsNativeExecutable(command: string, npmEntry: string, env: NodeJS.ProcessEnv): string {
  const path = env[Object.keys(env).sort().find(key => key.toUpperCase() === 'PATH') ?? 'PATH'] ?? '';
  const explicit = isAbsolute(command) || /[/\\]/.test(command);
  const directories = explicit ? [''] : path.split(delimiter).filter(Boolean).map(value => value.replace(/^"|"$/g, ''));
  for (const directory of directories) {
    const base = explicit ? resolve(command) : resolve(directory, command);
    const candidates = extname(base) ? [base] : [`${base}.exe`, `${base}.com`, `${base}.cmd`, base];
    for (const candidate of candidates) {
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
      if (/\.(cmd|bat)$/i.test(candidate) || !extname(candidate)) {
        const parent = dirname(candidate);
        const entry = basename(parent).toLowerCase() === '.bin' ? join(parent, '..', npmEntry) : join(parent, 'node_modules', npmEntry);
        if (existsSync(entry) && statSync(entry).isFile()) return entry;
        throw new Error(`Cannot launch Windows command shim ${candidate}. Configure the native .exe or JavaScript entry point.`);
      }
      return candidate;
    }
  }
  throw new Error(`Native executable not found: ${command}. Install it on PATH or configure an absolute executable path.`);
}


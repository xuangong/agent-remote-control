import { existsSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

export function resolveWindowsVscodeExecutable(command: string, environment: NodeJS.ProcessEnv = process.env): string {
  const path = environment[Object.keys(environment).sort().find(key => key.toUpperCase() === 'PATH') ?? 'PATH'] ?? '';
  const explicit = isAbsolute(command) || /[/\\]/.test(command);
  for (const directory of explicit ? [''] : path.split(delimiter).filter(Boolean)) {
    const candidate = explicit ? resolve(command) : resolve(directory.replace(/^"|"$/g, ''), command);
    if (/\.exe$/i.test(candidate) && existsSync(candidate)) return candidate;
    const tunnel = join(dirname(candidate), 'code-tunnel.exe');
    if (existsSync(tunnel)) return tunnel;
    if (existsSync(`${candidate}.exe`)) return `${candidate}.exe`;
  }
  throw new Error('VS Code tunnel executable was not found. Install VS Code or set AGENT_HOST_VSCODE to code-tunnel.exe.');
}

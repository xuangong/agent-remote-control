import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The Controller's skills, in the Claude Code plugin layout: next to the bundle when packaged, in the package otherwise. */
export async function controllerSkills(): Promise<string | undefined> {
  for (const candidate of ['./skills/agent-remote/', '../skills/agent-remote/']) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    try { await access(join(path, '.claude-plugin', 'plugin.json')); return path; }
    catch { /* Try the next layout. */ }
  }
  return undefined;
}

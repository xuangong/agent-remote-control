// Registers the repository's merge driver in the local git configuration, which git does not version; .gitattributes names it
// for packages/agent-relay-node/compatibility.json. `pnpm install` (prepare) and `pnpm task:start` run this; outside a git work
// tree, or without git (a container build), it does nothing. A checkout older than the driver merges the file as plain text.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeDriver } from './lib/compatibility.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
if (git(['rev-parse', '--is-inside-work-tree']).stdout?.trim() === 'true') {
  for (const [key, value] of Object.entries(mergeDriver)) {
    if (git(['config', '--get', key]).stdout?.trim() !== value && git(['config', key, value]).status !== 0) {
      console.warn(`git-setup: could not set ${key}; merges of compatibility.json fall back to plain text.`);
    }
  }
}

// pnpm open-items prints the index of docs/superpowers/open-items generated from the item files, on any branch, and writes
// nothing. --write writes it into the directory's README.md, which pnpm postmerge does on main after a merge; task branches
// never commit the index (scripts/lib/open-items.mjs).
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readItems, renderIndex, writeIndex } from './lib/open-items.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.includes('--write')) console.log(writeIndex(root) ? 'Open-items index written.' : 'Open-items index already current.');
else console.log(renderIndex(readItems(root)));

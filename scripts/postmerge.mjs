// pnpm postmerge, on main after a merge (and after the merge commit): regenerates the files that task branches never commit,
// commits them alone, and checks them (scripts/lib/postmerge.mjs). Run it before pushing main, and before a release or a
// deploy from main. Nothing changed is nothing committed, so it can run again at any time.
//   - The index of docs/superpowers/open-items, from the item files (scripts/lib/open-items.mjs).
//   - The compatibility digest of packages/agent-relay-node/compatibility.json (scripts/lib/compatibility.mjs).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { implementationOf, isCurrent, manifestPath, serialize, withImplementation } from './lib/compatibility.mjs';
import { directory as openItems, indexIsCurrent, writeIndex } from './lib/open-items.mjs';
import { postmerge } from './lib/postmerge.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Writes `text` to the file at `path` under the root when it differs, and says whether it did. */
function update(path, text) {
  const target = resolve(root, path);
  const changed = readFileSync(target, 'utf8') !== text;
  if (changed) writeFileSync(target, text);
  return changed;
}

// The digest comes last: the files the regenerations before it write can be inside its scope.
const regenerations = [
  {
    label: 'open-items index',
    paths: [`${openItems}/README.md`],
    write: () => writeIndex(root),
    check: () => indexIsCurrent(root) ? { verified: 'open-items index current' } : { failure: 'the open-items index differs from the item files' },
  },
  {
    label: 'compatibility metadata',
    paths: [manifestPath],
    write: () => update(manifestPath, serialize(withImplementation(JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8')), implementationOf(root)))),
    check() {
      const implementation = implementationOf(root);
      return isCurrent(JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8')), implementation)
        ? { verified: `compatibility ${implementation.digest}` } : { failure: 'the compatibility digest differs from the committed tree' };
    },
  },
];
process.exitCode = postmerge({ root, regenerations });

// pnpm compatibility:update writes the implementation digest of packages/agent-relay-node/compatibility.json; on main, run
// pnpm postmerge instead, which also commits it. pnpm compatibility:check compares the digest with the source tree: a stale
// digest fails on main, on a detached HEAD, in GitHub Actions and with --strict, and is only reported on a task branch, which
// never updates it (scripts/lib/compatibility.mjs).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentBranch, implementationOf, isCurrent, manifestPath, serialize, staleDigestFails, untrackedInScope, withImplementation } from './lib/compatibility.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(root, manifestPath);
const manifest = JSON.parse(readFileSync(path, 'utf8'));
const implementation = implementationOf(root);
if (process.argv.includes('--check')) {
  const branch = currentBranch(root);
  if (isCurrent(manifest, implementation)) {
    console.log(`Compatibility verified: ${implementation.digest}`);
  } else if (staleDigestFails({ branch, strict: process.argv.includes('--strict'), env: process.env })) {
    console.error(`Compatibility manifest differs from this source tree${branch ? ` on ${branch}` : ''}. On main, run pnpm postmerge after a merge;`
      + ' for a release, run pnpm compatibility:update after the version change and commit it with the version.');
    process.exitCode = 1;
  } else {
    console.log(`Compatibility digest not checked on task branch ${branch}: it is stale, as task branches never update it.`
      + ' After the merge into main, pnpm postmerge regenerates and checks it; main, a detached HEAD and --strict fail on a stale digest.');
  }
} else {
  const untracked = untrackedInScope(root);
  if (untracked.length > 0) console.warn(`Warning: ${untracked.length} untracked file(s) in the compatibility scope are not part of the digest; git add them first:\n${untracked.map(name => `  ${name}`).join('\n')}`);
  writeFileSync(path, serialize(withImplementation(manifest, implementation)));
  console.log(`Compatibility updated: ${implementation.digest}`);
}

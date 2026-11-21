// The git merge driver of packages/agent-relay-node/compatibility.json, named in .gitattributes and registered by
// scripts/git-setup.mjs: node scripts/compatibility-merge.mjs %O %A %B %P. The implementation digest is never merged: this
// side's block is kept and pnpm postmerge regenerates it on main. The hand-written parts merge like text, so a merge, rebase
// or cherry-pick stops on this file only for a real conflict there.
import { readFileSync, writeFileSync } from 'node:fs';
import { mergeManifests } from './lib/compatibility.mjs';

const [base, ours, theirs, pathname = 'compatibility.json'] = process.argv.slice(2);
const read = path => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
const { text, conflicts, keptImplementation } = mergeManifests({ base: read(base), ours: read(ours), theirs: read(theirs) });
writeFileSync(ours, text);
if (keptImplementation) console.error(`${pathname}: kept this side's implementation digest; pnpm postmerge regenerates it on main.`);
process.exitCode = conflicts > 0 ? 1 : 0;

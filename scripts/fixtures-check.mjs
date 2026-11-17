// Verifies the committed fixtures: transcript headers and protocol version, numbered frames, consumers that exist, and golden rows for every
// provider recording. A protocol change fails this until the transcripts are recorded again and the diff is reviewed in the same commit.
// Usage: pnpm fixtures:check [--root <repository>]
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFixtures } from './lib/fixtures-check.mjs';

const at = process.argv.indexOf('--root');
const root = resolve(at === -1 ? join(dirname(fileURLToPath(import.meta.url)), '..') : process.argv[at + 1]);
const problems = checkFixtures({ root });
for (const problem of problems) console.error(problem);
if (problems.length > 0) {
  console.error(`${problems.length} fixture problem(s).`);
  process.exit(1);
}
console.log('The fixtures are consistent.');

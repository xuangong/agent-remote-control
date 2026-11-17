// Checks the code against the layer rules (section 1.2 of the target architecture) and the module map in architecture/modules.json.
// `pnpm arch:check` fails on any violation that architecture/exceptions.json does not document, and on any exception that no longer
// matches a violation. `pnpm arch:report` prints the same counts and always exits 0.
// Usage: node scripts/arch-check.mjs [--report] [--root <repository>] [--modules <modules.json>] [--exceptions <exceptions.json>] [--json <output>]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, evaluate, readModuleMap } from './lib/arch-check.mjs';

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; };
const root = resolve(option('--root') ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const exceptionsPath = resolve(option('--exceptions') ?? join(root, 'architecture/exceptions.json'));
const report = analyze({ root, config: readModuleMap(resolve(option('--modules') ?? join(root, 'architecture/modules.json'))) });
const exceptions = existsSync(exceptionsPath) ? JSON.parse(readFileSync(exceptionsPath, 'utf8')).exceptions ?? [] : [];
const verdict = evaluate(report, exceptions);

console.log(`${report.files} files scanned; ${report.unassigned.length} outside every module, ${report.overlapping.length} in two modules.`);
for (const [kind, count] of Object.entries(report.violationCounts).sort()) console.log(`  ${kind}: ${count}`);
console.log(`${verdict.allowed} violations are documented exceptions; ${verdict.failures.length} findings fail the check.`);
console.log(`Inline wire messages in tests: ${report.wireLiterals.occurrences} in ${report.wireLiterals.files} files.`);
for (const failure of verdict.failures.slice(0, 40)) console.log(`  ${failure.kind}: ${failure.detail}`);
if (verdict.failures.length > 40) console.log(`  ... and ${verdict.failures.length - 40} more`);
if (option('--json')) writeFileSync(resolve(option('--json')), `${JSON.stringify({ ...report, failures: verdict.failures }, null, 1)}\n`);
if (!args.includes('--report') && verdict.failures.length > 0) process.exitCode = 1;

// Reports how the code follows the layer rules and the module map in architecture/modules.json. Report-only: it exits 0
// unless --strict is given, so it can be read before the rules become blocking.
// Usage: pnpm arch:report [--root <repository>] [--modules <modules.json>] [--json <output>] [--strict]
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, readModuleMap } from './lib/arch-check.mjs';

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; };
const root = resolve(option('--root') ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const report = analyze({ root, config: readModuleMap(resolve(option('--modules') ?? join(root, 'architecture/modules.json'))) });

console.log(`${report.files} files scanned; ${report.unassigned.length} outside every module, ${report.overlapping.length} in two modules.`);
for (const [kind, count] of Object.entries(report.violationCounts).sort()) console.log(`  ${kind}: ${count}`);
console.log(`Inline wire messages in tests: ${report.wireLiterals.occurrences} in ${report.wireLiterals.files} files.`);
for (const file of report.unassigned.slice(0, 10)) console.log(`  unassigned ${file}`);
for (const violation of report.violations.filter(entry => entry.kind !== 'layer').slice(0, 20)) console.log(`  ${violation.kind}: ${violation.file} -> ${violation.imported}`);
if (option('--json')) writeFileSync(resolve(option('--json')), `${JSON.stringify(report, null, 1)}\n`);
const findings = report.unassigned.length + report.overlapping.length + report.violations.length;
if (args.includes('--strict') && findings > 0) process.exitCode = 1;

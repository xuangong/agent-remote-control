// The ratchet on the legacy --ui-*, --obs-* and --agent-* variables: each stylesheet of the Workbench, and the shared Session
// View stylesheet, uses at most its budget, and a stylesheet without one uses none, since new rules use --orchard-*. The budgets
// only fall: a task that removes uses leaves them as they are, and pnpm postmerge lowers them to the counts on main.
// agent-remote-lab/src/ui/stylesheets.test.ts holds the ceiling.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const budgetPath = 'packages/agent-remote-lab/src/ui/legacy-token-budget.json';
const lab = 'packages/agent-remote-lab/src';
const shared = 'packages/agent-client-web/src/styles.css';
// ui/tokens.css defines the legacy variables, so its uses are not counted.
const tokens = 'packages/agent-remote-lab/src/ui/tokens.css';
const legacyUse = /var\(\s*--(?:ui|obs|agent)-/g;

function stylesheets(directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? stylesheets(path) : name.endsWith('.css') ? [path] : [];
  });
}
/** The text with every comment blanked out, so a variable named in a comment is not a use. */
const uncommented = text => text.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '));

/** Each counted stylesheet of the repository at `root`, as its path under packages/, with its uses of legacy variables. */
export function legacyCounts(root) {
  const files = [...stylesheets(join(root, lab)).filter(path => path !== join(root, tokens)), join(root, shared)];
  return Object.fromEntries(files
    .map(path => [relative(join(root, 'packages'), path).split(sep).join('/'), uncommented(readFileSync(path, 'utf8')).match(legacyUse)?.length ?? 0])
    .sort(([a], [b]) => a.localeCompare(b)));
}

/** A message for each stylesheet that uses more legacy variables than its budget; a stylesheet without a budget has 0. */
export function overBudget(counts, budget) {
  return Object.entries(counts).filter(([path, count]) => count > (budget[path] ?? 0))
    .map(([path, count]) => `${path} uses ${count} legacy variables, over its budget of ${budget[path] ?? 0}; use --orchard-* instead`);
}

/** The budgets lowered to the counts: none rises, and one whose stylesheet uses none, or no longer exists, is dropped. */
export function lowered(counts, budget) {
  return Object.fromEntries(Object.entries(budget).map(([path, limit]) => [path, Math.min(limit, counts[path] ?? 0)]).filter(([, limit]) => limit > 0));
}

/** Writes the lowered budgets of the repository at `root` when they differ, and says whether it did. */
export function lowerBudgets(root) {
  const path = join(root, budgetPath);
  const before = readFileSync(path, 'utf8');
  const file = JSON.parse(before);
  const after = `${JSON.stringify({ ...file, budget: lowered(legacyCounts(root), file.budget) }, null, 2)}\n`;
  if (after !== before) writeFileSync(path, after);
  return after !== before;
}

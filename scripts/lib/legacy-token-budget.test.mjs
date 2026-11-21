import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { budgetPath, legacyCounts, lowerBudgets, lowered, overBudget } from './legacy-token-budget.mjs';

/** A repository root with the Workbench's and the shared stylesheets given, and the budget file. */
function repository(stylesheets, budget) {
  const root = mkdtempSync(join(tmpdir(), 'arc-legacy-budget-'));
  const files = { 'packages/agent-client-web/src/styles.css': '', ...stylesheets, [budgetPath]: `${JSON.stringify({ description: 'kept', budget }, null, 2)}\n` };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test('counts the legacy variables a stylesheet uses, not those it defines in ui/tokens.css or names in a comment', () => {
  const root = repository({
    'packages/agent-remote-lab/src/app.css': '.a { color: var(--ui-label); /* var(--obs-text) */ border: var( --agent-line); }\n',
    'packages/agent-remote-lab/src/ui/tokens.css': ':root { --ui-label: var(--obs-text); }\n',
    'packages/agent-remote-lab/src/settings/settings.css': '.b { color: var(--orchard-text); }\n',
  }, {});
  try {
    assert.deepEqual(legacyCounts(root), { 'agent-client-web/src/styles.css': 0, 'agent-remote-lab/src/app.css': 2, 'agent-remote-lab/src/settings/settings.css': 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a count above its budget fails, one below passes, and a stylesheet without a budget may use none', () => {
  assert.deepEqual(overBudget({ 'a.css': 3, 'b.css': 1, 'c.css': 0 }, { 'a.css': 3, 'b.css': 2 }), []);
  assert.deepEqual(overBudget({ 'a.css': 4, 'new.css': 1 }, { 'a.css': 3 }), [
    'a.css uses 4 legacy variables, over its budget of 3; use --orchard-* instead',
    'new.css uses 1 legacy variables, over its budget of 0; use --orchard-* instead',
  ]);
});

test('lowering takes each budget down to its count, never up, and drops a budget at 0 or of a stylesheet that is gone', () => {
  assert.deepEqual(lowered({ 'a.css': 2, 'b.css': 9, 'c.css': 0 }, { 'a.css': 5, 'b.css': 3, 'c.css': 4, 'gone.css': 7 }), { 'a.css': 2, 'b.css': 3 });
});

test('writing the lowered budgets keeps the description and the order, and has nothing to write a second time', () => {
  const root = repository({ 'packages/agent-remote-lab/src/app.css': '.a { color: var(--ui-label); }\n' },
    { 'agent-remote-lab/src/app.css': 4, 'agent-client-web/src/styles.css': 2 });
  try {
    assert.equal(lowerBudgets(root), true);
    assert.equal(readFileSync(join(root, budgetPath), 'utf8'), `${JSON.stringify({ description: 'kept', budget: { 'agent-remote-lab/src/app.css': 1 } }, null, 2)}\n`);
    assert.equal(lowerBudgets(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

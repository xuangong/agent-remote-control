import assert from 'node:assert/strict';
import test from 'node:test';
import { describePlan, planTests } from './test-selection.mjs';

const packages = {
  'packages/app': { name: '@sample/app', script: 'test' },
  'packages/client': { name: '@sample/client', script: 'test' },
  'packages/agent-remote-seams': { name: '@sample/seams', script: 'test:unit' },
  'packages/fixtures': { name: '@sample/fixtures', script: 'test' },
};
const modules = [
  { name: 'shell', layer: 4, paths: ['packages/app/src/**'], seams: ['S6'] },
  { name: 'settings', layer: 4, paths: ['packages/app/src/features/settings/**'], seams: ['S6'], flows: ['E11', 'E2'] },
  { name: 'chats', layer: 4, paths: ['packages/app/src/features/chats/**'], seams: ['S6'] },
  { name: 'app-test-support', layer: 5, paths: ['packages/app/src/test/**'], seams: ['S6'] },
  { name: 'client', layer: 2, paths: ['packages/client/src/**'], seams: ['S3', 'S6'] },
  { name: 'client-rules', layer: 1, paths: ['packages/client/src/rules/**'], seams: ['S3'] },
  { name: 'fixtures', layer: 5, paths: ['packages/fixtures/**'], seams: ['S1'] },
  { name: 'seams', layer: 5, paths: ['packages/agent-remote-seams/**'], seams: [] },
  { name: 'e2e', layer: 5, paths: ['packages/app/e2e/**'], seams: [] },
];
const files = [
  'packages/app/package.json',
  'packages/app/src/App.tsx', 'packages/app/src/App.test.tsx', 'packages/app/src/App.local.test.tsx',
  'packages/app/src/features/settings/Settings.tsx', 'packages/app/src/features/settings/Settings.test.tsx', 'packages/app/src/features/settings/rows.test.ts',
  'packages/app/src/features/chats/Roster.tsx', 'packages/app/src/features/chats/Roster.test.tsx',
  'packages/app/src/test/setup.ts',
  'packages/app/e2e/pages/roster.tsx', 'packages/app/e2e/roster.spec.ts',
  'packages/client/src/index.ts', 'packages/client/src/index.test.ts', 'packages/client/src/rules/rule.ts', 'packages/client/src/rules/rule.test.ts',
  'packages/fixtures/src/transcripts.ts', 'packages/fixtures/src/transcripts.test.ts',
  'packages/agent-remote-seams/tests/S3/wire.integration.test.ts', 'packages/agent-remote-seams/tests/S6/render.integration.test.tsx', 'packages/agent-remote-seams/tests/index.ts',
];
const plan = changed => planTests({ changed, files, modules, packages });
const run = (result, directory) => result.runs.find(entry => entry.directory === directory);

test('a feature file runs its own module tests and its seams, not the shell or a sibling feature', () => {
  const result = plan(['packages/app/src/features/settings/Settings.tsx']);
  assert.deepEqual(result.modules, ['settings']);
  assert.deepEqual(run(result, 'packages/app').files, ['src/features/settings/Settings.test.tsx', 'src/features/settings/rows.test.ts']);
  assert.deepEqual(run(result, 'packages/agent-remote-seams').files, ['tests/S6/']);
  assert.equal(result.runs.length, 2);
});

test('a shell file runs the shell tests only, which leave out the feature modules and native tests', () => {
  assert.deepEqual(run(plan(['packages/app/src/App.tsx']), 'packages/app').files, ['src/App.test.tsx']);
});

test('a domain module inside a package runs its tests alone and names its own seams', () => {
  const result = plan(['packages/client/src/rules/rule.ts']);
  assert.deepEqual(run(result, 'packages/client').files, ['src/rules/rule.test.ts']);
  assert.deepEqual(result.seams, ['S3']);
});

test('modules that changed together run together, each seam once', () => {
  const result = plan(['packages/app/src/features/settings/Settings.tsx', 'packages/app/src/features/chats/Roster.tsx', 'packages/client/src/index.ts']);
  assert.deepEqual(run(result, 'packages/app').files, ['src/features/chats/Roster.test.tsx', 'src/features/settings/Settings.test.tsx', 'src/features/settings/rows.test.ts']);
  assert.deepEqual(run(result, 'packages/client').files, ['src/index.test.ts']);
  assert.deepEqual(run(result, 'packages/agent-remote-seams').files, ['tests/S3/', 'tests/S6/']);
});

test('test support inside a source tree runs its whole package; e2e pages run no unit suite of the package', () => {
  assert.equal(run(plan(['packages/app/src/test/setup.ts']), 'packages/app').all, true);
  const pages = plan(['packages/app/e2e/pages/roster.tsx']);
  assert.equal(run(pages, 'packages/app'), undefined);
  assert.equal(pages.runs.length, 0);
});

test('a fixture package outside a source tree runs its own tests and the seams it feeds', () => {
  const result = plan(['packages/fixtures/src/transcripts.ts']);
  assert.equal(run(result, 'packages/fixtures').all, true);
  assert.deepEqual(run(result, 'packages/agent-remote-seams').files, ['tests/S1/']);
});

test('a changed seam test runs its seam suite; other seam files run every seam', () => {
  assert.deepEqual(run(plan(['packages/agent-remote-seams/tests/S3/wire.integration.test.ts']), 'packages/agent-remote-seams').files, ['tests/S3/']);
  assert.equal(run(plan(['packages/agent-remote-seams/tests/index.ts']), 'packages/agent-remote-seams').all, true);
});

test('a manifest outside every module runs its whole package; documents and files outside packages run nothing', () => {
  assert.equal(run(plan(['packages/app/package.json']), 'packages/app').all, true);
  assert.deepEqual(plan(['packages/app/README.md', 'scripts/tool.mjs', 'docs/note.md']).runs, []);
});

test('the plan reads as one line per package, then the flows to run at the step\'s end', () => {
  assert.match(describePlan(plan(['packages/app/src/features/settings/Settings.tsx'])), /settings; seams: S6\.\n {2}@sample\/app: 2 test paths\n {2}@sample\/seams: 1 test path\nFlows these modules take part in, for the step's end: E2, E11\./);
  assert.equal(describePlan(plan([])), 'No module test changed, so no unit test runs.');
});

// A mock graph: the app's shell imports the client's index, which imports its rules; the settings feature imports only the shell kernel (not the client).
const graph = new Map([
  ['packages/app/src/App.tsx', ['packages/client/src/index.ts']],
  ['packages/app/src/App.test.tsx', ['packages/app/src/App.tsx']],
  ['packages/app/src/features/chats/Roster.tsx', ['packages/client/src/index.ts']],
  ['packages/app/src/features/chats/Roster.test.tsx', ['packages/app/src/features/chats/Roster.tsx']],
  ['packages/app/src/features/settings/Settings.tsx', []],
  ['packages/app/src/features/settings/Settings.test.tsx', ['packages/app/src/features/settings/Settings.tsx']],
  ['packages/client/src/index.ts', ['packages/client/src/rules/rule.ts']],
  ['packages/client/src/index.test.ts', ['packages/client/src/index.ts']],
  ['packages/client/src/rules/rule.ts', []],
  ['packages/client/src/rules/rule.test.ts', ['packages/client/src/rules/rule.ts']],
  ['packages/app/src/test/setup.ts', ['packages/client/src/index.ts']],
]);
const planWith = (changed, extra = {}) => planTests({ changed, files, modules, packages, graph, ...extra });

test('a change runs the tests of the modules that import it, when those tests reach the changed file', () => {
  const result = planWith(['packages/client/src/index.ts']);
  assert.deepEqual(run(result, 'packages/client').files, ['src/index.test.ts']);
  assert.deepEqual(run(result, 'packages/app').files, ['src/App.test.tsx', 'src/features/chats/Roster.test.tsx']);
  assert.deepEqual(result.dependents, { count: 2, reached: 2, capped: false });
});

test('a dependent whose tests do not reach the changed file does not run', () => {
  assert.equal(run(planWith(['packages/client/src/index.ts']), 'packages/app').files.some(file => file.includes('settings')), false);
});

test('only direct dependents run: the app does not import the client rules, so a rule change leaves its tests out', () => {
  const result = planWith(['packages/client/src/rules/rule.ts']);
  assert.deepEqual(run(result, 'packages/client').files, ['src/index.test.ts', 'src/rules/rule.test.ts']);
  assert.equal(run(result, 'packages/app'), undefined);
});

test('a test file, test support and a document change run no dependent', () => {
  assert.equal(planWith(['packages/client/src/rules/rule.test.ts']).dependents.count, 0);
  assert.equal(planWith(['packages/app/src/test/setup.ts']).dependents.count, 0);
  assert.equal(planWith(['packages/client/README.md']).dependents.count, 0);
});

test('a module that imports nothing of the changed module runs only its own tests', () => {
  const result = planWith(['packages/app/src/App.tsx']);
  assert.deepEqual(run(result, 'packages/app').files, ['src/App.test.tsx']);
  assert.equal(result.dependents.count, 0);
});

test('past the limit the tests nearest to the changed file run, and the plan says it was cut', () => {
  const result = planWith(['packages/client/src/index.ts'], { dependentLimit: 1 });
  assert.deepEqual(result.dependents, { count: 1, reached: 2, capped: true });
  assert.deepEqual(run(result, 'packages/client').files, ['src/index.test.ts']);
  assert.deepEqual(run(result, 'packages/app').files, ['src/App.test.tsx']);
  assert.match(describePlan(result), /Dependent modules: 1 test files reach the changed files \(the 1 nearest of 2;/);
});

test('without a graph no dependent runs', () => {
  assert.equal(plan(['packages/client/src/index.ts']).dependents.count, 0);
});

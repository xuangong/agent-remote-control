import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { analyze, assignModules, globToRegExp, importsOf } from './arch-check.mjs';

/** A small repository: a contract package, a domain package and an application package. */
function sampleRepository(files) {
  const root = mkdtempSync(join(tmpdir(), 'arc-arch-sample-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const config = {
  scan: ['packages/*/src/**'],
  wireModules: ['wire'],
  wireTestExempt: ['wire'],
  packages: {
    '@sample/wire': { dir: 'packages/wire', entry: 'src/index.ts' },
    '@sample/domain': { dir: 'packages/domain', entry: 'src/index.ts' },
    '@sample/app': { dir: 'packages/app', entry: 'src/index.ts' },
    '@sample/fixtures': { dir: 'packages/fixtures', entry: 'src/index.ts' },
  },
  modules: [
    { name: 'wire', layer: 0, paths: ['packages/wire/src/**'] },
    { name: 'domain', layer: 1, paths: ['packages/domain/src/**'] },
    { name: 'app', layer: 2, paths: ['packages/app/src/**'] },
    { name: 'fixtures', layer: 5, paths: ['packages/fixtures/src/**'] },
  ],
};

const withRepository = (files, check) => {
  const root = sampleRepository(files);
  try { check(analyze({ root, config })); } finally { rmSync(root, { recursive: true, force: true }); }
};

test('a path pattern keeps one star inside a directory and two stars across directories', () => {
  assert.ok(globToRegExp('packages/a/src/*.ts').test('packages/a/src/x.ts'));
  assert.ok(!globToRegExp('packages/a/src/*.ts').test('packages/a/src/deep/x.ts'));
  assert.ok(globToRegExp('packages/a/src/**').test('packages/a/src/deep/x.ts'));
});

test('the most specific pattern decides the module, and an equal match is an overlap', () => {
  const modules = [
    { name: 'all', layer: 2, paths: ['packages/a/src/**'] },
    { name: 'edge', layer: 3, paths: ['packages/a/src/gateway*.ts'] },
    { name: 'also-edge', layer: 3, paths: ['packages/a/src/gateway*.ts'] },
  ];
  const { assigned, unassigned, overlapping } = assignModules(['packages/a/src/x.ts', 'packages/a/src/gateway.ts', 'packages/b/src/y.ts'], modules);
  assert.equal(assigned.get('packages/a/src/x.ts').name, 'all');
  assert.equal(assigned.get('packages/a/src/gateway.ts').name, 'edge');
  assert.deepEqual(unassigned, ['packages/b/src/y.ts']);
  assert.deepEqual(overlapping, [{ file: 'packages/a/src/gateway.ts', modules: ['edge', 'also-edge'] }]);
});

test('imports, re-exports and dynamic imports are all found', () => {
  const text = `import a from './a.js';\nimport type { B } from "@sample/wire";\nexport * from './c.js';\nimport './side.js';\nconst d = await import('./d.js');`;
  assert.deepEqual(importsOf(text), ['./a.js', '@sample/wire', './c.js', './side.js', './d.js']);
});

test('a module that imports a lower layer is clean', () => {
  withRepository({
    'packages/wire/src/index.ts': 'export const wire = 1;\n',
    'packages/domain/src/index.ts': "import { wire } from '@sample/wire';\nexport const domain = wire;\n",
    'packages/app/src/index.ts': "import { domain } from '@sample/domain';\nexport const app = domain;\n",
  }, report => {
    assert.deepEqual(report.violations, []);
    assert.deepEqual(report.unassigned, []);
  });
});

test('imports that run up the layers, across packages by path, or into build output are reported', () => {
  withRepository({
    'packages/wire/src/index.ts': "import { app } from '@sample/app';\nexport const wire = app;\n",
    'packages/domain/src/index.ts': "import { app } from '../../app/src/index.js';\nimport { built } from '../../app/dist/index.js';\nexport const domain = [app, built];\n",
    'packages/app/src/index.ts': 'export const app = 1;\n',
  }, report => {
    assert.deepEqual(report.violationCounts, { layer: 2, 'cross-package-relative': 2, 'dist-import': 1 });
    assert.match(report.violations.find(entry => entry.kind === 'layer' && entry.file.includes('wire')).detail, /wire \(layer 0\) imports app \(layer 2\)/);
  });
});

test('production code that imports test support, and a domain that imports a Node built-in, are reported', () => {
  withRepository({
    'packages/fixtures/src/index.ts': 'export const fixture = 1;\n',
    'packages/domain/src/index.ts': "import { readFileSync } from 'node:fs';\nimport { fixture } from '@sample/fixtures';\nexport const domain = [readFileSync, fixture];\n",
    'packages/app/src/index.ts': "import { readFileSync } from 'node:fs';\nexport const app = readFileSync;\n",
  }, report => {
    assert.deepEqual(report.violationCounts, { 'domain-impurity': 1, 'test-support-in-production': 1 });
  });
});

test('a test file may import any layer, and a wire message written inline in a test is counted', () => {
  withRepository({
    'packages/wire/src/index.ts': "import { Type } from 'typebox';\nexport const open = { type: Type.Literal('journal_open') };\n",
    'packages/app/src/index.ts': 'export const app = 1;\n',
    'packages/app/src/index.test.ts': "import { open } from '../../wire/src/index.js';\nimport { app } from './index.js';\nconst message = { type: 'journal_open', app, open };\nconst other = { type: 'unrelated' };\n",
  }, report => {
    assert.deepEqual(report.violationCounts, { 'cross-package-relative': 1 });
    assert.deepEqual(report.wireLiterals, { files: 1, occurrences: 1, byPackage: { app: 1 } });
  });
});

test('files outside every module are listed', () => {
  withRepository({ 'packages/stray/src/index.ts': 'export const stray = 1;\n' }, report => {
    assert.deepEqual(report.unassigned, ['packages/stray/src/index.ts']);
  });
});

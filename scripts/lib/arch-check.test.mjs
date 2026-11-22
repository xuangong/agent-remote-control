import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { analyze, assignModules, evaluate, globToRegExp, importsOf } from './arch-check.mjs';

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
    assert.deepEqual(report.violationCounts, { layer: 2, 'cross-package-relative': 2, 'dist-import': 1, 'contract-imports-workspace': 1 });
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

/** A Workbench-like package: a shell, a kernel and two features, each feature reaching its siblings only through `uses`. */
const featureConfig = {
  ...config,
  packages: { ...config.packages, '@sample/workbench': { dir: 'packages/workbench', entry: 'src/main.ts' } },
  modules: [...config.modules,
    { name: 'shell', layer: 4, paths: ['packages/workbench/src/**'] },
    { name: 'kernel', layer: 4, paths: ['packages/workbench/src/kernel/**'], uses: [] },
    { name: 'chats', layer: 4, paths: ['packages/workbench/src/features/chats/**'], uses: ['kernel'] },
    { name: 'settings', layer: 4, paths: ['packages/workbench/src/features/settings/**'], uses: ['kernel', 'chats'] },
  ],
};
const featureKinds = files => {
  const root = sampleRepository({
    'packages/domain/src/index.ts': 'export const domain = 1;\n',
    'packages/workbench/src/kernel/keys.ts': 'export const key = 1;\n',
    'packages/workbench/src/features/chats/Roster.tsx': "import { key } from '../../kernel/keys.js';\nexport const Roster = key;\n",
    'packages/workbench/src/features/settings/Settings.tsx': "import { Roster } from '../chats/Roster.js';\nimport { domain } from '@sample/domain';\nexport const Settings = [Roster, domain];\n",
    'packages/workbench/src/main.ts': "import { Settings } from './features/settings/Settings.js';\nexport const main = Settings;\n",
    ...files,
  });
  try { return analyze({ root, config: featureConfig }).violations.map(violation => `${violation.kind}: ${violation.module} -> ${violation.targetModule}`); }
  finally { rmSync(root, { recursive: true, force: true }); }
};

test('uses: a feature imports the kernel, the siblings it lists and other packages; the shell imports every feature', () => {
  assert.deepEqual(featureKinds({}), []);
});

test('uses: a module of the same package that the list leaves out is a sibling violation, the kernel included', () => {
  assert.deepEqual(featureKinds({
    'packages/workbench/src/features/chats/Roster.tsx': "import { Settings } from '../settings/Settings.js';\nexport const Roster = Settings;\n",
    'packages/workbench/src/kernel/keys.ts': "import { main } from '../main.js';\nexport const key = main;\n",
  }), ['sibling: chats -> settings', 'sibling: kernel -> shell']);
});

test('uses: a type-only import counts, and a test file may import any sibling', () => {
  assert.deepEqual(featureKinds({
    'packages/workbench/src/features/chats/types.ts': "import type { Settings } from '../settings/Settings.js';\nexport type Shown = typeof Settings;\n",
    'packages/workbench/src/features/chats/Roster.test.tsx': "import { Settings } from '../settings/Settings.js';\nimport { main } from '../../main.js';\nexport const checked = [Settings, main];\n",
  }), ['sibling: chats -> settings']);
});

/** The rules of section 1.2 as a module map over two Relay-side packages, a Controller, a client and two adapters. */
const ruleConfig = {
  scan: ['packages/*/src/**'],
  wireModules: ['wire'],
  wireTestExempt: ['wire'],
  packages: Object.fromEntries(['wire', 'domain', 'relay', 'relay-edge', 'controller', 'client', 'provider-a', 'provider-b', 'sdk', 'fixtures']
    .map(name => [`@sample/${name}`, { dir: `packages/${name}`, entry: 'src/index.ts' }])),
  modules: [
    { name: 'wire', layer: 0, paths: ['packages/wire/src/**'] },
    { name: 'sdk', layer: 0, paths: ['packages/sdk/src/**'] },
    { name: 'domain', layer: 1, paths: ['packages/domain/src/**'] },
    { name: 'relay-core', layer: 2, paths: ['packages/relay/src/**'] },
    { name: 'controller', layer: 2, paths: ['packages/controller/src/**'] },
    { name: 'client', layer: 2, paths: ['packages/client/src/**'] },
    { name: 'provider-a', layer: 3, paths: ['packages/provider-a/src/**'] },
    { name: 'provider-b', layer: 3, paths: ['packages/provider-b/src/**'] },
    { name: 'relay-host', layer: 4, paths: ['packages/relay-edge/src/**'] },
    { name: 'fixtures', layer: 5, paths: ['packages/fixtures/src/**'] },
  ],
  edges: [
    { id: 'relay-knows-controller', rule: 6, from: ['relay-*'], to: ['controller', 'client', 'provider-*'] },
    { id: 'controller-knows-relay', rule: 7, from: ['controller'], to: ['relay-*'] },
    { id: 'controller-concrete-provider', rule: 7, from: ['controller'], to: ['provider-*'], exceptFiles: ['packages/controller/src/providers.ts'] },
    { id: 'client-knows-server', rule: 8, from: ['client'], to: ['relay-*', 'controller'] },
    { id: 'provider-imports', rule: 5, from: ['provider-*'], to: ['relay-*', 'controller', 'client', 'domain'] },
  ],
  bans: [
    { id: 'domain-impure', rule: 3, modules: ['domain'], imports: ['node:*'], code: ['Date\\.now\\(', 'Math\\.random\\(', '\\bsetTimeout\\('] },
    { id: 'client-ui', rule: 8, modules: ['client'], imports: ['react', 'react-dom'], code: ['\\bdocument\\.', '\\bindexedDB\\b'] },
  ],
  roots: [{ file: 'packages/controller/src/controller.ts', maxLines: 5 }],
};

const kindsOf = files => {
  const root = sampleRepository(files);
  try { return analyze({ root, config: ruleConfig }).violationCounts; } finally { rmSync(root, { recursive: true, force: true }); }
};
const one = (path, text) => ({ 'packages/wire/src/index.ts': 'export const wire = 1;\n', 'packages/sdk/src/index.ts': 'export const sdk = 1;\n', 'packages/domain/src/index.ts': 'export const domain = 1;\n',
  'packages/relay/src/index.ts': 'export const relay = 1;\n', 'packages/controller/src/index.ts': 'export const controller = 1;\n', 'packages/client/src/index.ts': 'export const client = 1;\n',
  'packages/provider-a/src/index.ts': 'export const providerA = 1;\n', 'packages/provider-b/src/index.ts': 'export const providerB = 1;\n', 'packages/relay-edge/src/index.ts': 'export const edge = 1;\n',
  'packages/fixtures/src/index.ts': 'export const fixture = 1;\n', [path]: text });

test('rule 2: a contract that imports anything from the workspace is reported', () => {
  assert.deepEqual(kindsOf(one('packages/sdk/src/index.ts', "import { wire } from '@sample/wire';\nexport const sdk = wire;\n")), { 'contract-imports-workspace': 1 });
  assert.deepEqual(kindsOf(one('packages/sdk/src/index.ts', "import { sdk } from './other.js';\nexport { sdk };\n")), {});
});

test('rule 3: the domain may not use a Node built-in, the clock, random numbers or timers', () => {
  assert.deepEqual(kindsOf(one('packages/domain/src/index.ts', "import { randomUUID } from 'node:crypto';\nexport const id = randomUUID;\n")), { 'domain-impurity': 1, 'domain-impure': 1 });
  assert.deepEqual(kindsOf(one('packages/domain/src/index.ts', 'export const at = () => Date.now() + Math.random();\nexport const later = () => setTimeout(() => {}, 1);\n')), { 'domain-impure': 3 });
  assert.deepEqual(kindsOf(one('packages/domain/src/index.ts', '// Date.now() is injected\nexport const at = (now: number) => now;\n')), {});
});

test('rule 1: imports run down the layers, never by path or into build output, and wildcard exports are not public', () => {
  assert.deepEqual(kindsOf(one('packages/domain/src/index.ts', "import { relay } from '@sample/relay';\nexport const domain = relay;\n")), { layer: 1 });
  assert.deepEqual(kindsOf(one('packages/client/src/index.ts', "import { wire } from '../../wire/src/index.js';\nexport const client = wire;\n")), { 'cross-package-relative': 1 });
  assert.deepEqual(kindsOf(one('packages/client/src/index.ts', "import { wire } from '../../wire/dist/index.js';\nexport const client = wire;\n")), { 'cross-package-relative': 1, 'dist-import': 1 });
  const wildcard = one('packages/client/src/index.ts', "import { inner } from '@sample/wire/inner';\nexport const client = inner;\n");
  wildcard['packages/wire/package.json'] = JSON.stringify({ exports: { '.': './dist/index.js', './*': './dist/*.js' } });
  wildcard['packages/wire/src/inner.ts'] = 'export const inner = 1;\n';
  assert.deepEqual(kindsOf(wildcard), { 'deep-import': 1 });
  const declared = { ...wildcard, 'packages/wire/package.json': JSON.stringify({ exports: { '.': './dist/index.js', './inner': './dist/inner.js' } }) };
  assert.deepEqual(kindsOf(declared), {});
});

test('rule 5: adapters never import each other and import no application code', () => {
  assert.deepEqual(kindsOf(one('packages/provider-a/src/index.ts', "import { providerB } from '@sample/provider-b';\nexport const providerA = providerB;\n")), { 'adapter-imports-adapter': 1 });
  assert.deepEqual(kindsOf(one('packages/provider-a/src/index.ts', "import { relay } from '@sample/relay';\nexport const providerA = relay;\n")), { 'provider-imports': 1 });
  assert.deepEqual(kindsOf(one('packages/provider-a/src/index.ts', "import { sdk } from '@sample/sdk';\nexport const providerA = sdk;\n")), {});
});

test('rule 6: the Relay does not know the Controller, the client or a provider', () => {
  for (const target of ['controller', 'client', 'provider-a']) {
    assert.deepEqual(kindsOf(one('packages/relay/src/index.ts', `import { x } from '@sample/${target}';\nexport const relay = x;\n`)), { 'relay-knows-controller': 1 }, target);
  }
});

test('rule 7: the Controller does not know the Relay, and names a concrete provider only in providers.ts', () => {
  assert.deepEqual(kindsOf(one('packages/controller/src/index.ts', "import { relay } from '@sample/relay';\nexport const controller = relay;\n")), { 'controller-knows-relay': 1 });
  const stray = one('packages/controller/src/index.ts', "import { providerA } from '@sample/provider-a';\nexport const controller = providerA;\n");
  assert.deepEqual(kindsOf(stray), { 'controller-concrete-provider': 1 });
  const root = one('packages/controller/src/providers.ts', "import { providerA } from '@sample/provider-a';\nexport const providers = [providerA];\n");
  assert.deepEqual(kindsOf(root), { layer: 1 });
  // Layer 3 may not be imported from layer 2 even in the one file allowed to name a provider; the exception is the edge, not the layer table.
});

test('rule 8: the client does not know the Relay or the Controller and imports no React, DOM or IndexedDB', () => {
  assert.deepEqual(kindsOf(one('packages/client/src/index.ts', "import { relay } from '@sample/relay';\nexport const client = relay;\n")), { 'client-knows-server': 1 });
  assert.deepEqual(kindsOf(one('packages/client/src/index.ts', "import { useState } from 'react';\nexport const client = useState;\n")), { 'client-ui': 1 });
  assert.deepEqual(kindsOf(one('packages/client/src/index.ts', 'export const client = () => document.title;\n')), { 'client-ui': 1 });
  assert.deepEqual(kindsOf(one('packages/client/src/index.ts', "import { wire } from '@sample/wire';\nexport const client = wire;\n")), {});
});

test('rule 10: a composition root over its line budget is reported', () => {
  assert.deepEqual(kindsOf(one('packages/controller/src/controller.ts', 'export const a = 1;\n'.repeat(6))), { 'root-too-large': 1 });
  assert.deepEqual(kindsOf(one('packages/controller/src/controller.ts', 'export const a = 1;\n'.repeat(3))), {});
});

test('rule 11: production code that imports test support is reported, and a test that reads another package by path is too', () => {
  assert.deepEqual(kindsOf(one('packages/relay/src/index.ts', "import { fixture } from '@sample/fixtures';\nexport const relay = fixture;\n")), { 'test-support-in-production': 1 });
  assert.deepEqual(kindsOf(one('packages/relay/src/index.test.ts', "import { wire } from '../../wire/src/index.js';\nexport const t = wire;\n")), { 'cross-package-relative': 1 });
});

const sampleReport = violations => ({ unassigned: [], overlapping: [], violations: violations.map(([kind, file, targetModule]) => ({ kind, file, imported: 'x', detail: `${file} breaks ${kind}`, targetModule })) });
const exception = extra => ({ rule: 'layer', from: ['packages/app/src/**'], to: ['edge'], max: 2, owner: 'M10', reason: 'The process shell is split out in M10.', ...extra });

test('a documented exception allows its violations and nothing beyond its maximum', () => {
  const two = sampleReport([['layer', 'packages/app/src/a.ts', 'edge'], ['layer', 'packages/app/src/b.ts', 'edge']]);
  assert.deepEqual(evaluate(two, [exception()]).failures, []);
  const three = sampleReport([...two.violations.map(entry => [entry.kind, entry.file, entry.targetModule]), ['layer', 'packages/app/src/c.ts', 'edge']]);
  const verdict = evaluate(three, [exception()]);
  assert.equal(verdict.failures.length, 1);
  assert.match(verdict.failures[0].detail, /packages\/app\/src\/c\.ts/);
});

test('a violation outside every exception fails, whichever rule, importer or target it has', () => {
  assert.equal(evaluate(sampleReport([['layer', 'packages/other/src/a.ts', 'edge']]), [exception()]).failures.length, 2);
  assert.equal(evaluate(sampleReport([['layer', 'packages/app/src/a.ts', 'wire']]), [exception()]).failures.length, 2);
  assert.equal(evaluate(sampleReport([['dist-import', 'packages/app/src/a.ts', undefined]]), [exception()]).failures.length, 2);
});

test('an exception that allows more than occurs fails until it is lowered', () => {
  const verdict = evaluate(sampleReport([['layer', 'packages/app/src/a.ts', 'edge']]), [exception()]);
  assert.equal(verdict.failures.length, 1);
  assert.match(verdict.failures[0].detail, /lower max to 1/);
});

test('an exception needs an owner step, a reason and a positive maximum', () => {
  for (const bad of [{ owner: undefined }, { owner: 'M2' }, { owner: 'later' }, { reason: '' }, { max: 0 }]) {
    assert.ok(evaluate(sampleReport([]), [exception(bad)]).failures.some(entry => entry.kind === 'invalid-exception'), JSON.stringify(bad));
  }
});

test('an exception can match by import specifier, and unassigned or overlapping files always fail', () => {
  const report = { ...sampleReport([['dist-import', 'packages/app/src/a.test.ts', undefined]]), unassigned: ['packages/x/src/y.ts'], overlapping: [{ file: 'packages/z/src/w.ts', modules: ['a', 'b'] }] };
  report.violations[0].imported = '../../p/dist/index.js';
  const verdict = evaluate(report, [exception({ rule: 'dist-import', to: undefined, toImport: ['../../p/dist/*'], max: 1 })]);
  assert.deepEqual(verdict.failures.map(entry => entry.kind), ['unassigned', 'overlapping']);
});

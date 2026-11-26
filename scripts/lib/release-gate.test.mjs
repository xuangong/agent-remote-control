import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { describeGate, flowIdOf, planGate, relayDeployNeeded } from './release-gate.mjs';
import { readModules } from './test-selection.mjs';

const root = join(import.meta.dirname, '../..');
const modules = [
  { name: 'controller', layer: 2, paths: ['packages/agent-controller/src/**'], flows: ['E1', 'E5'] },
  { name: 'provider-pi', layer: 3, paths: ['packages/agent-provider-pi/src/**'], flows: [] },
  { name: 'client', layer: 2, paths: ['packages/agent-client/src/**'], flows: ['E2'] },
  { name: 'e2e', layer: 5, paths: ['packages/agent-e2e/**'], flows: ['E1', 'E2'] },
];
const packages = { 'packages/agent-controller': { name: 'c', script: 'test' }, 'packages/agent-provider-pi': { name: 'p', script: 'test' }, 'packages/agent-client': { name: 'k', script: 'test' } };
const flowFiles = ['e1-pair.e2e.ts', 'e2-send.e2e.ts', 'e2-multi.e2e.ts', 'e5-succession.e2e.ts', 'e14b-push.e2e.ts', 'page.ts'];
const plan = (changed, force) => planGate({ changed, files: changed, modules, packages, flowFiles, force });
const ids = result => result.tiers.map(tier => tier.id);
const commands = (result, id) => result.tiers.find(tier => tier.id === id).steps.map(step => step.command.join(' '));

test('a documentation or script change runs only verify', () => {
  assert.deepEqual(ids(plan(['docs/a.md', 'scripts/x.mjs', 'packages/agent-client/README.md'])), ['verify']);
});

test('the regenerated compatibility digest alone changes nothing', () => {
  assert.deepEqual(ids(plan(['packages/agent-relay-node/compatibility.json', 'packages/agent-controller/package.json'])), ['verify']);
});

test('a client change runs every tier, with smoke', () => {
  const result = plan(['packages/agent-client/src/a.ts']);
  assert.deepEqual(ids(result), ['verify', 'components', 'preview-browser', 'e2e-chromium', 'e2e-webkit', 'smoke']);
  assert.deepEqual(commands(result, 'e2e-chromium'), ['pnpm test:e2e:flows']);
  assert.equal(result.tiers.find(tier => tier.id === 'e2e-webkit').steps[0].env.E2E_BROWSER, 'webkit');
});

test('smoke sets the journals variable itself on every step', () => {
  const smoke = plan(['packages/agent-client/src/a.ts']).tiers.find(tier => tier.id === 'smoke');
  assert.deepEqual(smoke.steps.map(step => step.command.join(' ')), ['pnpm local up', 'pnpm smoke:quick']);
  for (const step of smoke.steps) assert.equal(step.env.ARC_LOCAL_JOURNALS, '1');
});

test('a Relay change runs every tier; a protocol change runs the browser tiers without smoke', () => {
  assert.ok(ids(plan(['packages/agent-relay-core/src/a.ts'])).includes('smoke'));
  const protocol = ids(plan(['packages/agent-remote-protocol/src/a.ts']));
  assert.deepEqual(protocol, ['verify', 'components', 'preview-browser', 'e2e-chromium', 'e2e-webkit']);
});

test('a Controller-only change runs no component or preview tier, and only the flows of its modules', () => {
  const result = plan(['packages/agent-controller/src/a.ts']);
  assert.deepEqual(ids(result), ['verify', 'e2e-chromium', 'e2e-webkit']);
  assert.deepEqual(commands(result, 'e2e-chromium'), ['pnpm test:e2e:flows flows/e1- flows/e5-']);
});

test('a Controller change that no flow exercises skips the flow tiers', () => {
  const result = plan(['packages/agent-provider-pi/src/a.ts']);
  assert.deepEqual(ids(result), ['verify']);
  assert.match(describeGate(result, { base: 'b', head: 'h' }), /skip e2e-chromium +no flow exercises/);
});

test('a changed flow file runs itself; flow support code runs every flow', () => {
  assert.deepEqual(commands(plan(['packages/agent-e2e/flows/e14b-push.e2e.ts']), 'e2e-chromium'), ['pnpm test:e2e:flows flows/e14b-']);
  assert.deepEqual(commands(plan(['packages/agent-e2e/flows/page.ts']), 'e2e-chromium'), ['pnpm test:e2e:flows']);
  assert.deepEqual(commands(plan(['packages/agent-e2e/stack/a.ts']), 'e2e-webkit'), ['pnpm test:e2e:flows']);
});

test('a root manifest change and --full run everything', () => {
  assert.deepEqual(ids(plan(['pnpm-lock.yaml'])), ['verify', 'components', 'preview-browser', 'e2e-chromium', 'e2e-webkit']);
  assert.deepEqual(ids(plan([], true)), ['verify', 'components', 'preview-browser', 'e2e-chromium', 'e2e-webkit', 'smoke']);
});

test('every plan starts with verify and says why each tier runs', () => {
  const result = plan(['packages/agent-controller/src/a.ts']);
  assert.equal(ids(result)[0], 'verify');
  assert.match(describeGate(result, { base: 'v1', head: 'h' }), /run {2}e2e-chromium .*Controller changed: flows E1, E5/);
});

test('the Relay redeploys with the website, the Relay or the protocol, not with the Controller', () => {
  assert.equal(relayDeployNeeded(['packages/agent-remote-lab/src/a.tsx']), true);
  assert.equal(relayDeployNeeded(['packages/agent-relay-cloudflare/src/worker.ts']), true);
  assert.equal(relayDeployNeeded(['packages/agent-controller/src/a.ts', 'packages/agent-provider-pi/src/a.ts', 'docs/a.md']), false);
});

test('every flow file is named by a module in modules.json, and every named flow has a file', () => {
  const files = readdirSync(join(root, 'packages/agent-e2e/flows')).filter(name => flowIdOf(name));
  const fileIds = new Set(files.map(flowIdOf));
  const named = new Set(readModules(root).filter(module => module.name !== 'e2e').flatMap(module => module.flows ?? []));
  assert.deepEqual([...fileIds].filter(id => !named.has(id)), [], 'add the new flow to the flows of the modules it exercises');
  assert.deepEqual([...named].filter(id => !fileIds.has(id)), [], 'a module names a flow that has no file');
  assert.ok(readFileSync(join(root, 'packages/agent-e2e/vitest.e2e.config.ts'), 'utf8').includes('flows/**/*.e2e.ts'));
});

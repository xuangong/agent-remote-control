import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { describeGate, flowIdOf, planGate, relayDeployNeeded, releasedBase, selectTiers } from './release-gate.mjs';
import { readModules } from './test-selection.mjs';

const root = join(import.meta.dirname, '../..');
const modules = [
  { name: 'controller', layer: 2, paths: ['packages/agent-controller/src/**'], flows: ['E1', 'E5'] },
  { name: 'provider-pi', layer: 3, paths: ['packages/agent-provider-pi/src/**'], flows: [] },
  { name: 'relay-core', layer: 2, paths: ['packages/agent-relay-core/src/**'], flows: ['E2'] },
  { name: 'client', layer: 2, paths: ['packages/agent-client/src/**'], flows: ['E2'] },
  { name: 'e2e', layer: 5, paths: ['packages/agent-e2e/**'], flows: ['E1', 'E2'] },
];
const packages = { 'packages/agent-relay-core': { name: 'r', script: 'test' }, 'packages/agent-controller': { name: 'c', script: 'test' }, 'packages/agent-provider-pi': { name: 'p', script: 'test' }, 'packages/agent-client': { name: 'k', script: 'test' } };
const flowFiles = ['e1-pair.e2e.ts', 'e2-send.e2e.ts', 'e2-multi.e2e.ts', 'e5-succession.e2e.ts', 'e14b-push.e2e.ts', 'e15-bots.e2e.ts', 'e15b-bot-thresholds.e2e.ts', 'page.ts'];
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

test('a Relay change runs the flows of its modules and smoke, no component or preview tier; a protocol change runs the browser tiers without smoke', () => {
  const relay = plan(['packages/agent-relay-core/src/a.ts']);
  assert.deepEqual(ids(relay), ['verify', 'e2e-chromium', 'e2e-webkit', 'smoke']);
  assert.deepEqual(commands(relay, 'e2e-chromium'), ['pnpm test:e2e:flows flows/e2-']);
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

const wideChange = () => planGate({ changed: ['packages/agent-client/src/a.ts'], files: [], modules, packages: [], flowFiles: [], force: false });
const tierIds = tiers => tiers.map(tier => tier.id);

test('--from runs the plan from that tier on and lists the earlier tiers as skipped', () => {
  const plan = wideChange();
  const { run, skipped } = selectTiers(plan, { from: 'preview-browser' });
  assert.deepEqual(tierIds(run), tierIds(plan.tiers).slice(tierIds(plan.tiers).indexOf('preview-browser')));
  assert.deepEqual(skipped, [{ tier: 'verify', why: '--from' }, { tier: 'components', why: '--from' }]);
});

test('--from a tier the plan lacks still skips what precedes it in the tier order', () => {
  const plan = wideChange();
  const { run } = selectTiers({ tiers: plan.tiers.filter(tier => tier.id !== 'e2e-chromium') }, { from: 'e2e-chromium' });
  assert.deepEqual(tierIds(run), ['e2e-webkit', 'smoke'].filter(id => tierIds(plan.tiers).includes(id)));
});

test('--only runs just the named tiers; no option runs the whole plan', () => {
  const plan = wideChange();
  assert.deepEqual(tierIds(selectTiers(plan, { only: 'verify, e2e-webkit' }).run), ['verify', 'e2e-webkit']);
  assert.equal(selectTiers(plan, {}).run, plan.tiers);
  assert.deepEqual(selectTiers(plan, {}).skipped, []);
});

test('unknown tier names and --from with --only are refused', () => {
  const plan = wideChange();
  assert.throws(() => selectTiers(plan, { from: 'e2e' }), /Unknown tier "e2e"/);
  assert.throws(() => selectTiers(plan, { only: 'verify,nope' }), /Unknown tier "nope"/);
  assert.throws(() => selectTiers(plan, { from: 'verify', only: 'verify' }), /not both/);
});

/** A git stub over tags per pattern and commit times per tag. */
const gitStub = ({ controller = '', relay = '', times = {} }) => (...args) => {
  if (args[0] === 'tag') return args[2] === 'controller-v*' ? controller : relay;
  if (args[0] === 'log') return String(times[args[3].replace('^{commit}', '')] ?? 0);
  return null;
};

test('the base is the newer of the newest relay-deployed tag and the newest controller tag', () => {
  const tags = { controller: 'controller-v0.3.9\ncontroller-v0.3.8', relay: 'relay-deployed-20261126\nrelay-deployed-20261120' };
  assert.equal(releasedBase(gitStub({ ...tags, times: { 'controller-v0.3.9': 10, 'relay-deployed-20261126': 20 } })), 'relay-deployed-20261126');
  assert.equal(releasedBase(gitStub({ ...tags, times: { 'controller-v0.3.9': 30, 'relay-deployed-20261126': 20 } })), 'controller-v0.3.9');
});

test('the base is whichever kind of tag exists, or nothing', () => {
  assert.equal(releasedBase(gitStub({ controller: 'controller-v0.3.9' })), 'controller-v0.3.9');
  assert.equal(releasedBase(gitStub({ relay: 'relay-deployed-1' })), 'relay-deployed-1');
  assert.equal(releasedBase(gitStub({})), undefined);
  assert.equal(releasedBase(gitStub({ controller: 'controller-v0.3.9' }), { exclude: 'controller-v0.3.9' }), undefined);
});

test('the bot flows run in Chromium only: WebKit drops them from a selection and has no tier when nothing else is selected', () => {
  const bots = (changed) => planGate({ changed, files: changed, modules: [...modules, { name: 'bots', layer: 2, paths: ['packages/agent-bots/**'], flows: ['E15', 'E15b'] }, { name: 'mixed', layer: 2, paths: ['packages/agent-mixed/**'], flows: ['E2', 'E15'] }], packages: { ...packages, 'packages/agent-bots': { name: 'b', script: 'test' }, 'packages/agent-mixed': { name: 'm', script: 'test' } }, flowFiles });
  const only = bots(['packages/agent-bots/a.ts']);
  assert.deepEqual(ids(only), ['verify', 'e2e-chromium']);
  assert.deepEqual(commands(only, 'e2e-chromium'), ['pnpm test:e2e:flows flows/e15- flows/e15b-']);
  const mixed = bots(['packages/agent-mixed/a.ts']);
  assert.deepEqual(commands(mixed, 'e2e-chromium'), ['pnpm test:e2e:flows flows/e15- flows/e2-']);
  assert.deepEqual(commands(mixed, 'e2e-webkit'), ['pnpm test:e2e:flows flows/e2-']);
});

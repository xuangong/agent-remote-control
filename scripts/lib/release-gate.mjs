// The scoped release gate: which tiers a release runs, decided from what changed since the last released commit.
// The plan is a pure function of the changed files and architecture/modules.json; scripts/release-gate.mjs runs it.
import { planTests } from './test-selection.mjs';

const PACKAGE_DIRECTORY = /^packages\/([^/]+)\//;
/** The packages that build the website. */
const CLIENT = /^(agent-client|agent-client-web|agent-remote-lab|agent-timeline)$/;
/** The Relay: the Worker, the shared Relay core and the standalone server. */
const RELAY = /^(agent-relay-core|agent-relay-cloudflare|agent-relay-node)$/;
const PROTOCOL = /^agent-remote-protocol$/;
/** What the Controller package bundles: its session runtime, the providers, the journals and the platform layers. */
const CONTROLLER = /^(agent-controller|agent-session-runtime|agent-provider-[^/]+|codex-daemon-client|agent-remote-journal[^/]*|agent-platform|agent-remote-tunnel)$/;
const ROOT_MANIFESTS = /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/;
/** Files every release regenerates; they say nothing about what changed. */
const GENERATED = /^packages\/agent-relay-node\/compatibility\.json$/;
const FLOW_FILE = /^packages\/agent-e2e\/flows\/(e\d+[a-z]?)-[^/]*\.e2e\.ts$/;
const E2E_SUPPORT = /^packages\/agent-e2e\/(flows|stack)\//;

/** The flow id of a flow file name, as modules.json writes it: `e14b-push.e2e.ts` is `E14b`. */
export const flowIdOf = name => { const match = /^e(\d+[a-z]?)-/.exec(name); return match && `E${match[1]}`; };

/** Which parts of the product a change touches: client, relay, protocol, controller, and the root manifests. */
export function categorize(changed) {
  const touched = { client: false, relay: false, protocol: false, controller: false, manifests: false };
  for (const file of changed) {
    if (ROOT_MANIFESTS.test(file)) touched.manifests = true;
    const name = PACKAGE_DIRECTORY.exec(file)?.[1];
    if (!name || file.endsWith('.md') || GENERATED.test(file)) continue;
    if (CLIENT.test(name)) touched.client = true;
    else if (RELAY.test(name)) touched.relay = true;
    else if (PROTOCOL.test(name)) touched.protocol = true;
    else if (CONTROLLER.test(name)) touched.controller = true;
  }
  return touched;
}

/** Whether a release of these changes redeploys the Relay Worker, which serves the website. */
export const relayDeployNeeded = changed => { const { client, relay, protocol, manifests } = categorize(changed); return client || relay || protocol || manifests; };

const pnpm = (...args) => ['pnpm', ...args];
/** The smoke run needs the local instance with journals on; the script sets that itself and restores the instance afterwards. */
const SMOKE_ENVIRONMENT = { ARC_LOCAL_JOURNALS: '1' };

/**
 * The plan for a change: `{ touched, full, tiers }`; each tier has an id, the reason it runs, its commands (`steps`, argv arrays
 * with an optional `env`) and a `deadlineMs`.
 * - `verify` always runs.
 * - A client or protocol change (or a root manifest) runs every tier: components, preview, all flows in both browsers.
 *   The component and preview tiers render the client on builder states without a Relay or Controller, so only these changes reach them.
 * - A Relay or Controller change runs only the flow files whose id a changed module names in modules.json, and none if no flow does.
 *   Smoke runs for a client or Relay change.
 * - A changed flow file runs itself; other changes under agent-e2e/flows or stack run every flow.
 * `files` are all files under `packages/`; `flowFiles` are the file names in packages/agent-e2e/flows; `force` is `--full`.
 */
export function planGate({ changed, files, modules, packages, flowFiles, force = false }) {
  const touched = categorize(changed);
  const wide = force || touched.client || touched.protocol || touched.manifests;
  const named = flowFiles.filter(name => flowIdOf(name));
  const tiers = [{ id: 'verify', why: 'always: the base gate', steps: [pnpm('verify')], deadlineMs: 40 * 60_000 }];
  const cause = force ? '--full' : [touched.client && 'client', touched.protocol && 'protocol', touched.manifests && 'root manifests'].filter(Boolean).join(', ');
  if (wide) {
    tiers.push({ id: 'components', why: `${cause} changed: every tier runs`, steps: [pnpm('test:components')], deadlineMs: 30 * 60_000 });
    tiers.push({ id: 'preview-browser', why: `${cause} changed: every tier runs`, steps: [pnpm('test:preview-browser')], deadlineMs: 15 * 60_000 });
  }
  const e2eChanged = changed.filter(file => file.startsWith('packages/agent-e2e/'));
  let selection = null; // null runs every flow
  let flowWhy = `${cause} changed: every flow`;
  if (!wide) {
    const modulesPlan = planTests({ changed: changed.filter(file => !file.startsWith('packages/agent-e2e/') && !GENERATED.test(file)), files, modules, packages });
    const ids = new Set(modulesPlan.flows);
    for (const file of e2eChanged) { const id = FLOW_FILE.exec(file) ? flowIdOf(file.split('/').pop()) : null; if (id) ids.add(id); else if (E2E_SUPPORT.test(file)) ids.add('*'); }
    if (ids.has('*')) { flowWhy = 'flow support code changed: every flow'; }
    else if (ids.size) { selection = named.filter(name => ids.has(flowIdOf(name))); flowWhy = `${[touched.relay && 'Relay', touched.controller && 'Controller'].filter(Boolean).join(' and ') || 'flows'} changed: flows ${[...ids].join(', ')}`; }
    else selection = [];
  }
  if (selection === null || selection.length) {
    const filters = selection ? selection.map(name => `flows/${name.split('-')[0]}-`) : [];
    const flowsCommand = [...pnpm('test:e2e:flows'), ...[...new Set(filters)].sort()];
    tiers.push({ id: 'e2e-chromium', why: flowWhy, steps: [flowsCommand], deadlineMs: 10 * 60_000 });
    tiers.push({ id: 'e2e-webkit', why: flowWhy, steps: [flowsCommand], env: { E2E_BROWSER: 'webkit' }, deadlineMs: 10 * 60_000 });
  }
  if (force || touched.client || touched.relay) {
    tiers.push({
      id: 'smoke', why: `${force ? '--full' : touched.client ? 'client' : 'Relay'} changed: the local instance with journals on`, deadlineMs: 30 * 60_000,
      steps: [{ command: pnpm('local', 'up'), env: SMOKE_ENVIRONMENT }, { command: pnpm('smoke:quick'), env: SMOKE_ENVIRONMENT }],
    });
  }
  return { touched, full: force, wide, tiers: tiers.map(tier => ({ ...tier, steps: tier.steps.map(step => Array.isArray(step) ? { command: step, env: tier.env } : step) })) };
}

/** The plan in words, before anything runs. */
export function describeGate(plan, { base, head }) {
  const lines = [`Release gate: ${base} .. ${head}${plan.full ? ' (--full)' : ''}`];
  const touched = Object.entries(plan.touched).filter(([, on]) => on).map(([name]) => name);
  lines.push(`Changed: ${touched.join(', ') || 'nothing that ships to the website, Relay or Controller'}`);
  const names = new Set(plan.tiers.map(tier => tier.id));
  for (const tier of plan.tiers) {
    const commands = tier.steps.map(step => `${Object.entries(step.env ?? {}).map(([key, value]) => `${key}=${value} `).join('')}${step.command.join(' ')}`).join('; ');
    lines.push(`  run  ${tier.id.padEnd(16)} ${commands}  (${tier.why})`);
  }
  for (const id of ['components', 'preview-browser', 'e2e-chromium', 'smoke']) {
    if (!names.has(id)) lines.push(`  skip ${id.padEnd(16)} ${id === 'e2e-chromium' ? 'no flow exercises the changed modules (e2e-webkit too)' : 'nothing it covers changed'}`);
  }
  return lines.join('\n');
}

/** Every tier id in run order; `--from` and `--only` name these. */
export const TIER_ORDER = ['verify', 'components', 'preview-browser', 'e2e-chromium', 'e2e-webkit', 'smoke'];

/**
 * Which tiers of a plan run: `--from <tier>` starts at that tier (earlier ones are skipped), `--only <tier>[,<tier>]` runs just those.
 * Returns `{ run, skipped }` (each skipped entry has the tier and why); throws on an unknown tier name or on both options together.
 */
export function selectTiers(plan, { from, only } = {}) {
  const names = only ? only.split(',').map(name => name.trim()).filter(Boolean) : from ? [from] : [];
  const unknown = names.filter(name => !TIER_ORDER.includes(name));
  if (unknown.length) throw new Error(`Unknown tier ${unknown.map(name => JSON.stringify(name)).join(', ')}; the tiers are ${TIER_ORDER.join(', ')}.`);
  if (from && only) throw new Error('Pass --from or --only, not both.');
  if (!names.length) return { run: plan.tiers, skipped: [] };
  const start = from ? TIER_ORDER.indexOf(from) : 0;
  const keeps = tier => only ? names.includes(tier.id) : TIER_ORDER.indexOf(tier.id) >= start;
  return {
    run: plan.tiers.filter(keeps),
    skipped: plan.tiers.filter(tier => !keeps(tier)).map(tier => ({ tier: tier.id, why: from ? '--from' : '--only' })),
  };
}

/**
 * The newest ref of what production runs: the newer, by commit date, of the newest `relay-deployed-*` tag (a Relay deploy without a
 * Controller release) and the newest `controller-v*` tag. `git(...args)` returns trimmed stdout or null; `exclude` is a tag to ignore.
 */
export function releasedBase(git, { exclude } = {}) {
  const newest = (pattern, sort) => git('tag', '--list', pattern, `--sort=${sort}`)?.split('\n').find(name => name && name !== exclude);
  return [newest('controller-v*', '-v:refname'), newest('relay-deployed-*', '-refname')].filter(Boolean)
    .map(name => ({ name, time: Number(git('log', '-1', '--format=%ct', `${name}^{commit}`)) || 0 }))
    .sort((a, b) => b.time - a.time)[0]?.name;
}

// The Controller release as resumable explicit steps (docs/controller-npm-release.md). Every step checks its precondition, does one
// thing, prints what it did, and is recorded in the release state, so a rerun skips what is done and continues at the failed step.
// Commands go through injected ports, so the steps run in tests against stubs and under --dry-run print instead of running.
import { relayDeployNeeded } from './release-gate.mjs';

export const STEPS = ['preconditions', 'bump', 'gate', 'push', 'deploy', 'release', 'report'];
const VERSION = /^\d+\.\d+\.\d+$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
export const RELEASED_FILES = ['packages/agent-controller/package.json', 'pnpm-lock.yaml', 'packages/agent-relay-node/compatibility.json'];
const WORKER = ['--filter', '@orchardworks/agent-relay-cloudflare'];

export const releaseSubject = (version, summary) => `release: Controller ${version} (${summary})`;
export const assetsOf = version => ['controller-release.json', 'install.ps1', 'install.sh', `orchardworks-agent-remote-controller-${version}.tgz`];
/** The version a `wrangler deployments list` output ends with: the newest deployment lists its versions last. */
export const lastWorkerVersion = text => [...text.matchAll(new RegExp(`\\(\\d+%\\)\\s+(${UUID.source})`, 'g'))].map(match => match[1]).at(-1);
/** The id `wrangler deploy` prints for the version it created. */
export const deployedWorkerVersion = text => new RegExp(`Version ID:\\s*(${UUID.source})`).exec(text)?.[1];

export class Refusal extends Error {}
const refuse = message => { throw new Refusal(message); };

/**
 * ctx ports: `read(argv)` runs a read-only command and returns `{ status, stdout }`; `exec(argv, { env })` runs a command with effects
 * (under --dry-run it only prints, and `ctx.dry` is true); `capture(argv)` is `exec` with the output returned; `confirm(what)` returns
 * whether an external effect may go ahead; `state` is `{ get(), set(patch) }`; `log(line)`; `exists(path)`; `now()`;
 * `readVersion()` and `writeVersion(version)` of packages/agent-controller/package.json.
 * options: `version`, `summary`, `gatePassed` (a log path), `dry`.
 */
export async function runRelease(ctx, options, { only } = {}) {
  const { version, summary } = options;
  if (!VERSION.test(version ?? '')) refuse(`The version must look like 1.2.3; got ${JSON.stringify(version)}.`);
  const tag = `controller-v${version}`;
  const git = (...args) => ctx.read(['git', ...args]);
  const out = (...args) => { const result = git(...args); return result.status === 0 ? result.stdout.trim() : null; };
  const lastTag = () => out('tag', '--list', 'controller-v*', '--sort=-v:refname')?.split('\n').find(name => name && name !== tag);
  const headIsRelease = () => out('log', '-1', '--format=%s')?.startsWith(`release: Controller ${version} (`);
  const pushed = () => out('rev-parse', 'HEAD') === out('rev-parse', 'origin/main');
  const remember = patch => { if (!ctx.dry) ctx.state.set(patch); };
  const steps = {
    preconditions: {
      check() {
        if (out('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') refuse('A release runs on main.');
        if (out('status', '--porcelain', '--untracked-files=no')) refuse('The working tree has uncommitted changes.');
        git('fetch', 'origin', 'main');
        if (out('rev-parse', 'HEAD') !== out('rev-parse', 'origin/main')) refuse('main is not at origin/main; pull or push first.');
      },
      run: () => ctx.log('On main, clean, and at origin/main.'),
    },
    bump: {
      check() {
        if (!summary) refuse('--summary "<what changed>" is required for the release commit and notes.');
        if (ctx.readVersion() === version) refuse(`The package is already at ${version} but the release commit is missing; commit it by hand or reset the package version.`);
        if (out('status', '--porcelain', '--untracked-files=no')) refuse('The working tree has uncommitted changes.');
      },
      run() {
        ctx.writeVersion(version);
        ctx.exec(['pnpm', 'install', '--lockfile-only']);
        ctx.exec(['pnpm', 'compatibility:update']);
        ctx.exec(['pnpm', 'compatibility:check']);
        ctx.exec(['git', 'commit', '--message', releaseSubject(version, summary), '--', ...RELEASED_FILES]);
        ctx.log(`Committed ${RELEASED_FILES.join(', ')} as "${releaseSubject(version, summary)}".`);
      },
    },
    gate: {
      check() { if (!ctx.dry && !headIsRelease()) refuse(`HEAD is not the release commit of ${version}.`); if (options.gatePassed && !ctx.exists(options.gatePassed)) refuse(`The gate log ${options.gatePassed} does not exist.`); },
      run() {
        if (options.gatePassed) { ctx.log(`Gate skipped: passed earlier, log ${options.gatePassed}.`); remember({ gateLog: options.gatePassed }); return; }
        ctx.exec(['pnpm', 'gate:release']);
        ctx.log('pnpm gate:release passed.');
      },
    },
    push: {
      external: 'git push origin main',
      check() { if (!ctx.dry && !headIsRelease()) refuse(`HEAD is not the release commit of ${version}.`); },
      run() { ctx.exec(['git', 'push', 'origin', 'main']); ctx.log('Pushed main.'); },
    },
    deploy: {
      external: 'deploy the Relay Worker to Cloudflare',
      check() { if (!ctx.dry && !pushed()) refuse('HEAD is not on origin/main; push first.'); },
      run() {
        const previous = lastTag();
        const changed = previous ? (out('diff', '--name-only', previous, 'HEAD') ?? '').split('\n').filter(Boolean) : null;
        if (changed && !relayDeployNeeded(changed)) { ctx.log(`Relay deploy skipped: nothing the Relay or the website ships changed since ${previous}.`); remember({ rollback: null }); return; }
        const listing = ctx.capture(['pnpm', ...WORKER, 'exec', 'wrangler', 'deployments', 'list']);
        const rollback = lastWorkerVersion(listing) ?? (ctx.dry ? '<current Worker version>' : refuse('No current Worker version found in `wrangler deployments list`; deploy by hand.'));
        remember({ rollback });
        ctx.log(`Rollback target: Worker version ${rollback}.`);
        ctx.exec(['pnpm', 'build:relay']);
        ctx.exec(['pnpm', ...WORKER, 'run', 'build']);
        const deployedAt = ctx.now().toISOString();
        const output = ctx.capture(['pnpm', ...WORKER, 'exec', 'wrangler', 'deploy']);
        const deployed = deployedWorkerVersion(output) ?? (ctx.dry ? '<new Version ID>' : refuse('Could not read the new Version ID from `wrangler deploy`; check the deployment and run readiness by hand.'));
        remember({ deployed });
        ctx.log(`Deployed Worker version ${deployed}.`);
        ctx.exec(['node', 'scripts/deploy-readiness.mjs', '--version', deployed, '--deployed-at', deployedAt, '--deadline-seconds', '480', '--interval-seconds', '15']);
        ctx.log('The Relay reports the new version.');
      },
    },
    release: {
      external: `create the GitHub release ${tag}`,
      check() {
        if (!ctx.dry && !pushed()) refuse('HEAD is not on origin/main; push first.');
        if (!ctx.dry && ctx.read(['gh', 'release', 'view', tag]).status === 0) refuse(`${tag} already exists on GitHub.`);
      },
      run() {
        const notes = summary ?? ctx.state.get().summary;
        ctx.exec(['pnpm', 'build:agent-remote-controller']);
        ctx.exec(['node', 'scripts/controller-release.mjs']);
        const missing = assetsOf(version).filter(name => !ctx.exists(`dist/agent-remote-controller/${name}`));
        if (!ctx.dry && missing.length) refuse(`The build did not produce: ${missing.join(', ')}.`);
        const sha = out('rev-parse', 'HEAD') ?? '<HEAD>';
        ctx.exec(['gh', 'release', 'create', tag, ...assetsOf(version).map(name => `dist/agent-remote-controller/${name}`), '--target', sha, '--title', `Controller ${version}`, '--notes', notes]);
        ctx.log(`Created ${tag} at ${sha.slice(0, 8)}.`);
      },
    },
    report: {
      check() {},
      run() {
        const { rollback, deployed } = ctx.state.get();
        ctx.log(deployed ? `Relay deployed as ${deployed}; roll back to Worker version ${rollback} with wrangler rollback if needed.` : 'The Relay was not redeployed; there is no Worker rollback target.');
        ctx.log('Done. The owner updates each Controller from Settings -> Computers.');
      },
    },
  };
  const letter = id => String.fromCharCode(97 + STEPS.indexOf(id));
  for (const id of only ? [only] : STEPS) {
    const step = steps[id];
    const done = ctx.state.get().done ?? [];
    if (done.includes(id) && !ctx.dry) { ctx.log(`${letter(id)}. ${id}: already done, skipped.`); continue; }
    ctx.log(`${letter(id)}. ${id}`);
    try { step.check(); } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      if (!ctx.dry) throw new Refusal(`${letter(id)}. ${id} refused: ${error.message}`);
      ctx.log(`   (dry run) would refuse: ${error.message}`);
    }
    if (step.external && ctx.dry) ctx.log(`   (dry run) would ask to ${step.external} (${tag})`);
    else if (step.external && !(await ctx.confirm(`${step.external} (${tag})`))) throw new Refusal(`${letter(id)}. ${id} needs confirmation: pass --yes or answer yes.`);
    await step.run();
    remember({ done: [...done, id], summary: summary ?? ctx.state.get().summary });
  }
}

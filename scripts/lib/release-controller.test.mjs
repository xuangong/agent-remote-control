import assert from 'node:assert/strict';
import test from 'node:test';
import { assetsOf, deployedWorkerVersion, lastWorkerVersion, RELEASED_FILES, Refusal, runRelease, STEPS } from './release-controller.mjs';

const OLD = '11111111-1111-4111-8111-111111111111';
const NEW = '22222222-2222-4222-8222-222222222222';
const LISTING = `Created: x\nVersion(s):  (100%) ${OLD}\n`;

/** A repository stub: git answers from `repo`, every effect is recorded in `calls`. */
function harness({ repo = {}, yes = true, dry = false, changed = ['packages/agent-controller/src/a.ts'], listing = LISTING, deployOutput = `Current Version ID: ${NEW}`, missing = [], releaseExists = false } = {}) {
  const facts = { branch: 'main', dirty: '', head: 'aaa', origin: 'aaa', subject: 'feat: x', tags: 'controller-v0.3.8\ncontroller-v0.3.7', ...repo };
  const calls = []; const lines = []; let state = {}; let version = '0.3.8';
  const ctx = {
    dry, log: line => lines.push(line),
    read(argv) {
      const key = argv.join(' ');
      if (key === 'git rev-parse --abbrev-ref HEAD') return { status: 0, stdout: facts.branch };
      if (key.startsWith('git status')) return { status: 0, stdout: facts.dirty };
      if (key === 'git fetch origin main') return { status: 0, stdout: '' };
      if (key === 'git rev-parse HEAD') return { status: 0, stdout: facts.head };
      if (key === 'git rev-parse origin/main') return { status: 0, stdout: facts.origin };
      if (key.startsWith('git log')) return { status: 0, stdout: facts.subject };
      if (key.startsWith('git tag')) return { status: 0, stdout: facts.tags };
      if (key.startsWith('git diff')) return { status: 0, stdout: changed.join('\n') };
      if (key.startsWith('gh release view')) return { status: releaseExists ? 0 : 1, stdout: '' };
      throw new Error(`unexpected read ${key}`);
    },
    exec(argv, extra) { calls.push({ argv: argv.join(' '), env: extra?.env }); if (argv[1] === 'commit') { facts.subject = argv[3]; facts.head = 'bbb'; } if (argv[1] === 'push') facts.origin = facts.head; },
    capture(argv) { calls.push({ argv: argv.join(' ') }); return argv.includes('list') ? listing : deployOutput; },
    confirm: async () => yes,
    state: { get: () => state, set: patch => { state = { ...state, ...patch }; } },
    exists: path => !missing.some(name => path.endsWith(name)),
    now: () => new Date('2026-11-26T10:00:00Z'),
    readVersion: () => version, writeVersion: next => { version = next; calls.push({ argv: `write version ${next}` }); },
  };
  return { ctx, calls, lines, facts, commands: () => calls.map(call => call.argv), get state() { return state; } };
}
const options = { version: '0.3.9', summary: 'bots get tools' };

test('parses the Worker version from deployment listings and deploy output', () => {
  assert.equal(lastWorkerVersion(`Version(s):  (100%) ${OLD}\nVersion(s):  (100%) ${NEW}`), NEW);
  assert.equal(lastWorkerVersion('nothing'), undefined);
  assert.equal(deployedWorkerVersion(`Uploaded\nCurrent Version ID: ${NEW}\n`), NEW);
});

test('a full release runs the steps in order and takes the rollback target before the deploy', async () => {
  const h = harness({ changed: ['packages/agent-remote-lab/src/a.tsx'] });
  await runRelease(h.ctx, options);
  const commands = h.commands();
  const order = ['write version 0.3.9', 'pnpm install --lockfile-only', 'pnpm compatibility:update', 'pnpm compatibility:check', 'git commit', 'pnpm gate:release', 'git push origin main',
    'wrangler deployments list', 'pnpm build:relay', 'run build', 'wrangler deploy', 'scripts/deploy-readiness.mjs', 'pnpm build:agent-remote-controller', 'scripts/controller-release.mjs', 'gh release create'];
  let at = -1;
  for (const part of order) { const next = commands.findIndex((command, index) => index > at && command.includes(part)); assert.ok(next > at, `${part} after ${commands[at]}`); at = next; }
  assert.ok(commands.includes(`git commit --message release: Controller 0.3.9 (bots get tools) -- ${RELEASED_FILES.join(' ')}`));
  assert.match(commands.find(command => command.includes('deploy-readiness')), new RegExp(`--version ${NEW} --deployed-at 2026-11-26T10:00:00.000Z --deadline-seconds 480 --interval-seconds 15`));
  const release = commands.find(command => command.startsWith('gh release create'));
  for (const name of assetsOf('0.3.9')) assert.ok(release.includes(`dist/agent-remote-controller/${name}`));
  assert.match(release, /controller-v0\.3\.9 .*--target bbb --title Controller 0\.3\.9 --notes bots get tools$/);
  assert.equal(h.state.rollback, OLD);
  assert.deepEqual(h.state.done, STEPS);
  assert.match(h.lines.join('\n'), new RegExp(`roll back to Worker version ${OLD}[^]*Settings -> Computers`));
});

test('the Relay deploy is skipped, and said so, when only the Controller changed', async () => {
  const h = harness();
  await runRelease(h.ctx, options);
  assert.ok(!h.commands().some(command => command.includes('wrangler') || command.includes('build:relay')));
  assert.match(h.lines.join('\n'), /Relay deploy skipped: nothing the Relay or the website ships changed since controller-v0\.3\.8/);
  assert.ok(h.commands().some(command => command.startsWith('gh release create')));
});

test('refuses off main, with a dirty tree, or behind origin, before changing anything', async () => {
  for (const repo of [{ branch: 'feat/x' }, { dirty: ' M a.ts' }, { origin: 'zzz' }]) {
    const h = harness({ repo });
    await assert.rejects(runRelease(h.ctx, options), error => error instanceof Refusal && /^a\. preconditions refused/.test(error.message));
    assert.deepEqual(h.calls, []);
  }
});

test('refuses a bad version and a missing summary', async () => {
  await assert.rejects(runRelease(harness().ctx, { version: 'v1' }), /must look like 1\.2\.3/);
  const h = harness();
  await assert.rejects(runRelease(h.ctx, { version: '0.3.9' }), /--summary/);
  assert.deepEqual(h.calls, []);
});

test('each external effect needs confirmation; without it nothing is pushed, deployed or released', async () => {
  const h = harness({ yes: false });
  await assert.rejects(runRelease(h.ctx, options), /d\. push needs confirmation: pass --yes/);
  assert.ok(!h.commands().some(command => command.startsWith('git push')));
  assert.deepEqual(h.state.done, ['preconditions', 'bump', 'gate']);
});

test('--gate-passed skips the gate run and a missing log is refused', async () => {
  const h = harness();
  await runRelease(h.ctx, { ...options, gatePassed: 'gate.log' });
  assert.ok(!h.commands().includes('pnpm gate:release'));
  const missing = harness({ missing: ['gate.log'] });
  await assert.rejects(runRelease(missing.ctx, { ...options, gatePassed: 'gate.log' }), /gate log gate\.log does not exist/);
});

test('a rerun skips finished steps and continues where it stopped', async () => {
  const h = harness({ yes: false });
  await assert.rejects(runRelease(h.ctx, options));
  const before = h.calls.length;
  const again = { ...h.ctx, confirm: async () => true };
  await runRelease(again, options);
  const rerun = h.commands().slice(before);
  assert.ok(!rerun.some(command => command.includes('write version') || command === 'pnpm gate:release'));
  assert.ok(rerun.includes('git push origin main') && rerun.some(command => command.startsWith('gh release create')));
  assert.match(h.lines.join('\n'), /b\. bump: already done, skipped/);
});

test('refuses the release step when the tag exists or the assets are missing', async () => {
  const exists = harness({ releaseExists: true });
  await assert.rejects(runRelease(exists.ctx, options), /controller-v0\.3\.9 already exists/);
  const missing = harness({ missing: ['install.sh'] });
  await assert.rejects(runRelease(missing.ctx, options), /did not produce: install\.sh/);
  assert.ok(!missing.commands().some(command => command.startsWith('gh release create')));
});

test('a deploy whose version cannot be read stops before readiness', async () => {
  const h = harness({ changed: ['packages/agent-relay-core/src/a.ts'], deployOutput: 'no id here' });
  await assert.rejects(runRelease(h.ctx, options), /Could not read the new Version ID/);
  assert.ok(!h.commands().some(command => command.includes('deploy-readiness')));
});

test('--dry-run prints the effects, runs none, and does not record progress', async () => {
  const h = harness({ dry: true, repo: { branch: 'feat/x' }, yes: false, changed: ['packages/agent-relay-core/src/a.ts'] });
  await runRelease(h.ctx, options);
  assert.match(h.lines.join('\n'), /would refuse: A release runs on main/);
  assert.deepEqual(h.state, {});
  assert.ok(h.commands().includes('git push origin main'));
});

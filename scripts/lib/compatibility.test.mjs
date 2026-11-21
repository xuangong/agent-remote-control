import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { implementationOf, isCurrent, manifestPath, mergeDriver, mergeManifests, serialize, staleDigestFails, withImplementation } from './compatibility.mjs';

const scripts = fileURLToPath(new URL('..', import.meta.url));
// Tests run git in temporary repositories, which must not inherit this repository's GIT_DIR (set in hooks and worktrees).
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));

/** A repository on main whose scripts are this checkout's compatibility scripts, with the given files committed. */
function repository(files) {
  const root = mkdtempSync(join(tmpdir(), 'arc-compatibility-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: environment });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };
  git('init', '--quiet', '--initial-branch=main');
  for (const [key, value] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.com', 'commit.gpgsign': 'false', ...mergeDriver })) git('config', key, value);
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  for (const file of ['compatibility.mjs', 'compatibility-merge.mjs', 'lib/compatibility.mjs']) copyFileSync(join(scripts, file), join(root, 'scripts', file));
  write(root, files);
  git('add', '--all');
  git('commit', '--quiet', '--message', 'base');
  return { root, git, read: path => readFileSync(join(root, path), 'utf8'), write: more => write(root, more), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}
const provider = (providerId, version, reason = 'Kept as a diagnostic.') => ({ providerId, native: { name: providerId, version, revision: null },
  degradations: [{ capability: 'events.usage', status: 'degraded', reason }] });
const manifest = (digest, providers = [provider('codex', '0.162.0'), provider('claude', '2.1.247')]) => serialize({
  schemaVersion: 1, protocolVersion: '1.8.0',
  borgee: { release: 'unreleased', sourceState: 'working_tree', baseRevision: '65143a95db212538461d5eafc49dea15988aa4e2',
    implementation: { algorithm: 'sha256', root: '../..', scope: ['package.json', 'scripts'], digest } },
  providers,
});
const digest = character => `sha256:${character.repeat(64)}`;

test('a stale digest fails on main, on a detached HEAD, in GitHub Actions and with --strict, and passes on a task branch', () => {
  assert.equal(staleDigestFails({ branch: 'main' }), true);
  assert.equal(staleDigestFails({ branch: null }), true);
  assert.equal(staleDigestFails({ branch: 'feat/phone-and-platform', env: { GITHUB_ACTIONS: 'true' } }), true);
  assert.equal(staleDigestFails({ branch: 'feat/phone-and-platform', strict: true }), true);
  assert.equal(staleDigestFails({ branch: 'feat/phone-and-platform', env: { CI: '1' } }), false);
  assert.equal(staleDigestFails({ branch: 'design/im-session-service' }), false);
});

test('the digest covers the tracked files of the scope as they are in the working tree, and no untracked file', () => {
  const repo = repository({ 'package.json': '{}\n', 'packages/a/src/index.ts': 'export {};\n', 'packages/a/node_modules/x.js': '', [manifestPath]: manifest(digest('0')) });
  try {
    const first = implementationOf(repo.root);
    assert.deepEqual(first.scope, ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts', 'packages/a/src']);
    repo.write({ 'packages/a/src/draft.ts': 'export const draft = 1;\n' });
    assert.equal(implementationOf(repo.root).digest, first.digest, 'an untracked file');
    repo.write({ 'packages/a/src/index.ts': 'export const changed = 1;\n' });
    assert.notEqual(implementationOf(repo.root).digest, first.digest, 'an edit of a tracked file');
    assert.equal(isCurrent(withImplementation(JSON.parse(repo.read(manifestPath)), first), first), true);
  } finally {
    repo.cleanup();
  }
});

test('the check reports a stale digest on a task branch and passes, and fails on main, detached and with --strict', () => {
  const repo = repository({ 'package.json': '{}\n', [manifestPath]: manifest(digest('0')) });
  const check = (...flags) => spawnSync(process.execPath, ['scripts/compatibility.mjs', '--check', ...flags], { cwd: repo.root, encoding: 'utf8', env: { ...environment, GITHUB_ACTIONS: '' } });
  try {
    const onMain = check();
    assert.equal(onMain.status, 1);
    assert.match(onMain.stderr, /differs from this source tree on main\. On main, run pnpm postmerge/);
    repo.git('switch', '--quiet', '--create', 'feat/task');
    const onTask = check();
    assert.equal(onTask.status, 0, onTask.stderr);
    assert.match(onTask.stdout, /not checked on task branch feat\/task: it is stale, as task branches never update it/);
    assert.equal(check('--strict').status, 1);
    repo.git('switch', '--quiet', '--detach');
    assert.equal(check().status, 1, 'a detached HEAD, as a release tag is checked out');
    repo.git('switch', '--quiet', 'feat/task');
    assert.equal(spawnSync(process.execPath, ['scripts/compatibility.mjs'], { cwd: repo.root, env: environment }).status, 0);
    const verified = check('--strict');
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /^Compatibility verified: sha256:[0-9a-f]{64}$/m);
  } finally {
    repo.cleanup();
  }
});

/** A repository whose main and feat/task changed compatibility.json from the same base, ready to merge. */
function divergedManifests({ main, task, driver = true }) {
  const repo = repository({ '.gitattributes': `* text=auto eol=lf\n${manifestPath} merge=arc-compatibility\n`, 'package.json': '{}\n', [manifestPath]: manifest(digest('0')) });
  if (!driver) repo.git('rm', '--quiet', 'scripts/compatibility-merge.mjs');
  repo.git('commit', '--quiet', '--allow-empty', '--message', 'scripts');
  repo.git('switch', '--quiet', '--create', 'feat/task');
  repo.write({ [manifestPath]: task, 'packages/a/src/task.ts': 'export {};\n' });
  repo.git('add', '--all');
  repo.git('commit', '--quiet', '--message', 'task');
  repo.git('switch', '--quiet', 'main');
  repo.write({ [manifestPath]: main, 'packages/b/src/main.ts': 'export {};\n' });
  repo.git('add', '--all');
  repo.git('commit', '--quiet', '--message', 'main');
  return repo;
}

test('the merge driver merges two branches that both updated the digest, keeping this side\'s block and both hand-written edits', () => {
  const repo = divergedManifests({
    main: manifest(digest('1'), [provider('codex', '0.162.0'), provider('claude', '2.1.300')]),
    task: manifest(digest('2'), [provider('codex', '0.162.0', 'Read again on a later release.'), provider('claude', '2.1.247')]),
  });
  try {
    const merge = repo.git('merge', '--no-edit', 'feat/task');
    assert.equal(merge.status, 0, merge.output);
    assert.match(merge.output, /kept this side's implementation digest; pnpm postmerge regenerates it on main/);
    const merged = JSON.parse(repo.read(manifestPath));
    assert.equal(merged.borgee.implementation.digest, digest('1'));
    assert.deepEqual(merged.providers, [provider('codex', '0.162.0', 'Read again on a later release.'), provider('claude', '2.1.300')]);
  } finally {
    repo.cleanup();
  }
});

test('the merge driver stops on a real conflict in a hand-written part, and marks only that part', () => {
  const repo = divergedManifests({
    main: manifest(digest('1'), [provider('codex', '0.170.0'), provider('claude', '2.1.247')]),
    task: manifest(digest('2'), [provider('codex', '0.171.0'), provider('claude', '2.1.247')]),
  });
  try {
    assert.notEqual(repo.git('merge', '--no-edit', 'feat/task').status, 0);
    const text = repo.read(manifestPath);
    assert.match(text, /<<<<<<< ours\n {8}"version": "0\.170\.0",\n=======\n {8}"version": "0\.171\.0",\n>>>>>>> theirs/);
    assert.equal(text.match(/<<<<<<</g).length, 1, 'the digest line is not a conflict');
  } finally {
    repo.cleanup();
  }
});

test('a checkout without the driver script merges the file as plain text, as before the driver', () => {
  const repo = divergedManifests({ main: manifest(digest('1')), task: manifest(digest('2')), driver: false });
  try {
    assert.notEqual(repo.git('merge', '--no-edit', 'feat/task').status, 0);
    assert.match(repo.read(manifestPath), /<<<<<<< ours\n {6}"digest": "sha256:1{64}"\n=======\n {6}"digest": "sha256:2{64}"\n>>>>>>> theirs/);
  } finally {
    repo.cleanup();
  }
});

test('a side that is not JSON, such as an earlier unresolved conflict, merges as plain text', () => {
  const base = manifest(digest('0'));
  const { text, conflicts, keptImplementation } = mergeManifests({ base, ours: `<<<<<<< ours\n${base}`, theirs: manifest(digest('2')) });
  assert.equal(conflicts, 0);
  assert.equal(keptImplementation, false);
  assert.equal(text, `<<<<<<< ours\n${manifest(digest('2'))}`, 'the other side\'s digest line is merged in as text');
});

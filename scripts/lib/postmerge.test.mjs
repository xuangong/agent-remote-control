import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { postmerge, refusal } from './postmerge.mjs';

// Tests run git in temporary repositories, which must not inherit this repository's GIT_DIR (set in hooks and worktrees).
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));

/** A repository on main with `source.txt` and `generated.txt`, and one regeneration that copies the first into the second. */
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'arc-postmerge-'));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: environment });
  git('init', '--quiet', '--initial-branch=main');
  for (const [key, value] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.com', 'commit.gpgsign': 'false' })) git('config', key, value);
  const path = name => join(root, name);
  writeFileSync(path('source.txt'), 'one\n');
  writeFileSync(path('generated.txt'), 'one\n');
  git('add', '--all');
  git('commit', '--quiet', '--message', 'base');
  const lines = [];
  const regeneration = {
    label: 'generated copy',
    paths: ['generated.txt'],
    write() {
      const changed = readFileSync(path('generated.txt'), 'utf8') !== readFileSync(path('source.txt'), 'utf8');
      if (changed) writeFileSync(path('generated.txt'), readFileSync(path('source.txt'), 'utf8'));
      return changed;
    },
    check: () => readFileSync(path('generated.txt'), 'utf8') === readFileSync(path('source.txt'), 'utf8') ? { verified: 'copy current' } : { failure: 'the copy is stale' },
  };
  const run = (regenerations = [regeneration]) => postmerge({ root, regenerations, log: line => lines.push(line), error: line => lines.push(line) });
  return { git, path, lines, run, commits: () => git('rev-list', '--count', 'HEAD').stdout.trim(), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
/** Commits a change of `source.txt` on a task branch and merges it into main with a merge commit. */
function mergeTask(repo, text) {
  repo.git('switch', '--quiet', '--create', 'feat/task');
  writeFileSync(repo.path('source.txt'), text);
  repo.git('commit', '--quiet', '--all', '--message', 'task');
  repo.git('switch', '--quiet', 'main');
  repo.git('merge', '--quiet', '--no-ff', '--no-edit', 'feat/task');
}

test('refuses outside main, during a git operation, and with changes it would not commit', () => {
  assert.match(refusal({ branch: 'feat/task', changed: [] }), /runs on main after a merge; this is feat\/task\. A task branch leaves the generated files alone/);
  assert.match(refusal({ branch: null, changed: [] }), /HEAD is detached/);
  assert.match(refusal({ branch: 'main', operation: 'merge', changed: [] }), /^Finish the merge first/);
  assert.match(refusal({ branch: 'main', changed: ['packages/a/src/x.ts'] }), /Commit or set aside these changes first[^]*\n {2}packages\/a\/src\/x\.ts$/);
  assert.equal(refusal({ branch: 'main', changed: [] }), null);
});

test('after a merge into main, commits only the regenerated files, then has nothing to do', () => {
  const repo = repository();
  try {
    mergeTask(repo, 'two\n');
    writeFileSync(repo.path('notes.txt'), 'untracked material stays untracked\n');
    assert.equal(repo.run(), 0, repo.lines.join('\n'));
    assert.equal(repo.git('show', '--name-only', '--format=%s', 'HEAD').stdout.trim(), 'chore: generated copy\n\ngenerated.txt');
    assert.equal(repo.git('status', '--porcelain').stdout, '?? notes.txt\n');
    assert.match(repo.lines.at(-1), /^Verified on main: copy current\.$/);
    const commits = repo.commits();
    assert.equal(repo.run(), 0);
    assert.equal(repo.commits(), commits);
    assert.ok(repo.lines.includes('Nothing to regenerate: the generated files match the tree.'));
  } finally {
    repo.cleanup();
  }
});

test('changes nothing on a task branch, on a tree with other changes and during an unfinished merge', () => {
  const repo = repository();
  try {
    repo.git('switch', '--quiet', '--create', 'feat/task');
    writeFileSync(repo.path('source.txt'), 'two\n');
    repo.git('commit', '--quiet', '--all', '--message', 'task');
    assert.equal(repo.run(), 1);
    assert.equal(readFileSync(repo.path('generated.txt'), 'utf8'), 'one\n');

    repo.git('switch', '--quiet', 'main');
    writeFileSync(repo.path('source.txt'), 'three\n');
    assert.equal(repo.run(), 1);
    assert.match(repo.lines.at(-1), /\n {2}source\.txt$/);

    repo.git('commit', '--quiet', '--all', '--message', 'main');
    assert.notEqual(repo.git('merge', '--no-edit', 'feat/task').status, 0, 'both changed source.txt');
    assert.equal(repo.run(), 1);
    assert.match(repo.lines.at(-1), /^Finish the merge first/);
    assert.equal(readFileSync(repo.path('generated.txt'), 'utf8'), 'one\n');
  } finally {
    repo.cleanup();
  }
});

test('fails when a check still finds a stale file after the commit', () => {
  const repo = repository();
  try {
    mergeTask(repo, 'two\n');
    const stale = { label: 'never current', paths: ['never.txt'], write: () => false, check: () => ({ failure: 'never current' }) };
    assert.equal(repo.run([stale]), 1);
    assert.equal(repo.lines.at(-1), 'postmerge: never current.');
  } finally {
    repo.cleanup();
  }
});

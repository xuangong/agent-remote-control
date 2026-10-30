import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { collectPatch, createBundle, fetchBundle, prepareWorktree, removeWorktree, worktreePath } from './call-for-support-workspaces.js';

const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
async function repository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cfs-repo-'))); cleanup.push(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); await mkdir(join(root, 'src')); await writeFile(join(root, 'src', 'a.ts'), 'one\n'); git('add', '.'); git('commit', '-qm', 'one');
  const first = git('rev-parse', 'HEAD');
  await writeFile(join(root, 'src', 'a.ts'), 'two\n'); git('commit', '-qam', 'two');
  return { root, git, first, second: git('rev-parse', 'HEAD') };
}

it('creates a detached worktree at the commit inside the repository and excludes it once', async () => {
  const repo = await repository();
  const prepared = await prepareWorktree(join(repo.root, 'src'), 'team-1', 'member-1', repo.first);
  expect(prepared).toEqual({ root: repo.root, worktree: worktreePath(repo.root, 'team-1', 'member-1'), cwd: join(worktreePath(repo.root, 'team-1', 'member-1'), 'src') });
  expect(await readFile(join(prepared.cwd, 'a.ts'), 'utf8')).toBe('one\n');
  expect(repo.git('status', '--porcelain')).toBe('');
  await prepareWorktree(repo.root, 'team-1', 'member-2', repo.second);
  expect((await readFile(join(repo.root, '.git', 'info', 'exclude'), 'utf8')).split('\n').filter(line => line === '.agent-remote/')).toHaveLength(1);
  expect(await prepareWorktree(repo.root, 'team-1', 'member-1', repo.first.slice(0, 12))).toMatchObject({ worktree: prepared.worktree });
  await expect(prepareWorktree(repo.root, 'team-1', 'member-1', repo.second)).rejects.toThrow('another commit');
});

it('refuses a directory at a worktree path that is not its own worktree, and never stages the worker\'s changes from it', async () => {
  const repo = await repository();
  const stray = worktreePath(repo.root, 'team', 'stray');
  await mkdir(stray, { recursive: true });
  await expect(prepareWorktree(repo.root, 'team', 'stray', repo.second)).rejects.toThrow('is not a support worktree');
  await writeFile(join(repo.root, 'src', 'a.ts'), 'worker edit\n');
  await expect(collectPatch(stray, repo.second)).rejects.toThrow('is not a support worktree');
  expect(repo.git('diff', '--cached', '--name-only')).toBe('');
  expect(repo.git('status', '--porcelain')).toContain('src/a.ts');
});

it('works on the repository of its directory when the environment names another, as a git hook\'s does', async () => {
  const repo = await repository(), other = await repository();
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = join(other.root, '.git');
  try {
    const prepared = await prepareWorktree(join(repo.root, 'src'), 'team', 'member', repo.second);
    expect(prepared.root).toBe(repo.root);
    await removeWorktree(repo.root, prepared.worktree);
  } finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
  expect(other.git('worktree', 'list')).not.toContain('member');
  expect(await readFile(join(other.root, '.git', 'info', 'exclude'), 'utf8')).not.toContain('.agent-remote/');
  expect(await readFile(join(repo.root, '.git', 'info', 'exclude'), 'utf8')).toContain('.agent-remote/');
});

it('explains a missing commit and refuses unsafe identities', async () => {
  const repo = await repository();
  await expect(prepareWorktree(repo.root, 'team', 'member', 'abcdef1234567')).rejects.toThrow('Commit abcdef1234567 is not in the repository');
  expect(() => worktreePath(repo.root, '../escape', 'member')).toThrow('Invalid');
  await expect(prepareWorktree(repo.root, 'team', 'member', 'HEAD')).rejects.toThrow('Invalid commit');
});

it('removes a worktree and prunes it, and refuses directories outside the support worktrees', async () => {
  const repo = await repository();
  const { worktree } = await prepareWorktree(repo.root, 'team', 'member', repo.second);
  await writeFile(join(worktree, 'scratch.txt'), 'uncommitted');
  await removeWorktree(repo.root, worktree);
  expect(existsSync(worktree)).toBe(false);
  expect(repo.git('worktree', 'list')).not.toContain('member');
  await removeWorktree(repo.root, worktree);
  await expect(removeWorktree(repo.root, join(repo.root, 'src'))).rejects.toThrow('outside the support worktrees');
});

it('finishes a removal that deleted a worktree\'s files but not its directory', async () => {
  const repo = await repository();
  const { worktree } = await prepareWorktree(repo.root, 'team', 'member', repo.second);
  await chmod(dirname(worktree), 0o500);
  try { await expect(removeWorktree(repo.root, worktree)).rejects.toThrow(); } finally { await chmod(dirname(worktree), 0o700); }
  expect(existsSync(worktree)).toBe(true);
  await removeWorktree(repo.root, worktree);
  expect(existsSync(worktree)).toBe(false);
});

it('deletes a supporter\'s support ref even when its directory is not a worktree it can remove', async () => {
  const repo = await repository();
  const stray = worktreePath(repo.root, 'team', 'member');
  await mkdir(stray, { recursive: true }); await writeFile(join(stray, 'notes.txt'), 'not ours');
  repo.git('update-ref', 'refs/agent-remote/support/team/member', repo.first);
  await expect(removeWorktree(repo.root, stray)).rejects.toThrow('git worktree failed');
  expect(repo.git('for-each-ref', 'refs/agent-remote')).toBe('');
  expect(existsSync(stray)).toBe(true);
});

it('bundles the commit with and without a base and fetches it into a clone that lacks it', async () => {
  const repo = await repository();
  const clone = await realpath(await mkdtemp(join(tmpdir(), 'cfs-clone-'))); cleanup.push(clone);
  execFileSync('git', ['clone', '-q', repo.root, clone]);
  execFileSync('git', ['-C', clone, 'reset', '-q', '--hard', repo.first]);
  execFileSync('git', ['-C', repo.root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'three']);
  const third = repo.git('rev-parse', 'HEAD');
  expect(() => execFileSync('git', ['-C', clone, 'cat-file', '-e', `${third}^{commit}`], { stdio: 'ignore' })).toThrow();
  for (const base of [repo.second, undefined]) {
    const bundle = await createBundle(repo.root, third, base); cleanup.push(bundle.directory);
    await fetchBundle(clone, bundle.file, 'team', base ? 'incremental' : 'full');
    const { worktree } = await prepareWorktree(clone, 'team', base ? 'incremental' : 'full', third);
    expect(execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(third);
  }
  expect(repo.git('for-each-ref', 'refs/agent-remote')).toBe('');
  const same = await createBundle(repo.root, third, third); cleanup.push(same.directory);
  await expect(createBundle(repo.root, 'abcdef1234567')).rejects.toThrow('not in the repository');
});

it('explains a bundle whose base the remote repository lacks', async () => {
  const repo = await repository();
  const empty = await realpath(await mkdtemp(join(tmpdir(), 'cfs-empty-'))); cleanup.push(empty);
  execFileSync('git', ['-C', empty, 'init', '-q']);
  const bundle = await createBundle(repo.root, repo.second, repo.first); cleanup.push(bundle.directory);
  await expect(fetchBundle(empty, bundle.file, 'team', 'member')).rejects.toThrow('call again without a base');
});

it('collects committed, uncommitted and new files as one patch that applies at the commit', async () => {
  const repo = await repository();
  const { worktree } = await prepareWorktree(repo.root, 'team', 'fixer', repo.second);
  expect(await collectPatch(worktree, repo.second)).toBe('');
  await writeFile(join(worktree, 'src', 'a.ts'), 'three\n');
  execFileSync('git', ['-C', worktree, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'three']);
  await writeFile(join(worktree, 'src', 'a.ts'), 'four\n');
  await writeFile(join(worktree, 'src', 'b.bin'), Buffer.from([0, 1, 2, 255]));
  const patch = await collectPatch(worktree, repo.second);
  expect(patch).toContain('diff --git a/src/a.ts b/src/a.ts');
  expect(patch).toContain('GIT binary patch');
  const { worktree: fresh } = await prepareWorktree(repo.root, 'team', 'check', repo.second);
  const file = join(fresh, '..', 'fix.patch'); await writeFile(file, patch);
  execFileSync('git', ['-C', fresh, 'apply', '--check', file]);
  execFileSync('git', ['-C', fresh, 'apply', file]);
  expect(await readFile(join(fresh, 'src', 'a.ts'), 'utf8')).toBe('four\n');
  expect(await readFile(join(fresh, 'src', 'b.bin'))).toEqual(Buffer.from([0, 1, 2, 255]));
});

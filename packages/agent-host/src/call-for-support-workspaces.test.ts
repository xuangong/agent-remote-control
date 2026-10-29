import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createBundle, fetchBundle, prepareWorktree, removeWorktree, worktreePath } from './call-for-support-workspaces.js';

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

import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browseWorkspaceFolders } from './workspace-folders.js';
import type { HostExecutionPolicy } from './execution-policy.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'workspace-folders-'))); temporary.push(base);
  const root = join(base, 'allowed'); await mkdir(root);
  const policy: HostExecutionPolicy = { allowedWorkspaceRoots: [root], defaultWorkspace: root, lockPermissions: true };
  return { base, root, policy };
}
it('lists only folders, handles empty directories, and stops parent navigation at allowed roots', async () => {
  const f = await fixture();
  await mkdir(join(f.root, 'project')); await mkdir(join(f.root, '.hidden')); await writeFile(join(f.root, 'file.txt'), 'text');
  await symlink(f.base, join(f.root, 'escape'));
  const page = await browseWorkspaceFolders(new URLSearchParams(), f.policy);
  expect(page).toEqual({ path: f.root, parentPath: null, roots: [f.root], folders: [{ name: 'project', path: join(f.root, 'project') }], nextOffset: null });
  expect((await browseWorkspaceFolders(new URLSearchParams({ path: join(f.root, 'project') }), f.policy))).toMatchObject({ parentPath: f.root, folders: [] });
  expect((await browseWorkspaceFolders(new URLSearchParams({ hidden: '1', search: 'HIDDEN' }), f.policy)).folders.map(folder => folder.name)).toEqual(['.hidden']);
});
it('rejects traversal, symlink escapes, files, and malformed pagination', async () => {
  const f = await fixture(); await symlink(f.base, join(f.root, 'escape')); await writeFile(join(f.root, 'file'), 'text');
  for (const path of [f.base, join(f.root, '..'), join(f.root, 'escape'), join(f.root, 'file')]) {
    await expect(browseWorkspaceFolders(new URLSearchParams({ path }), f.policy)).rejects.toThrow();
  }
  await expect(browseWorkspaceFolders(new URLSearchParams({ path: 'relative' }), f.policy)).rejects.toMatchObject({ status: 400 });
  await expect(browseWorkspaceFolders(new URLSearchParams({ offset: '-1' }), f.policy)).rejects.toMatchObject({ status: 400 });
});
it('paginates sorted folder names without omitting later matches', async () => {
  const f = await fixture();
  await Promise.all(Array.from({ length: 105 }, (_, i) => mkdir(join(f.root, `project-${i}`))));
  const first = await browseWorkspaceFolders(new URLSearchParams(), f.policy);
  const second = await browseWorkspaceFolders(new URLSearchParams({ offset: String(first.nextOffset) }), f.policy);
  expect(first.folders).toHaveLength(100); expect(second.folders).toHaveLength(5); expect(second.nextOffset).toBeNull();
  expect(new Set([...first.folders, ...second.folders].map(folder => folder.path)).size).toBe(105);
  expect(first.folders[2]?.name).toBe('project-2');
});

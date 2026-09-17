import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path';
import { allowedWorkspace, HostExecutionPolicyError, type HostExecutionPolicy } from './execution-policy.js';

export interface WorkspaceFolderPage {
  path: string;
  parentPath: string | null;
  roots: string[];
  folders: Array<{ name: string; path: string }>;
  nextOffset: number | null;
}
export class WorkspaceFolderError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** Lists directory names only; selection still goes through session creation policy. */
export async function browseWorkspaceFolders(query: URLSearchParams, policy?: HostExecutionPolicy, defaultPath = process.cwd()): Promise<WorkspaceFolderPage> {
  const requested = query.get('path') || policy?.defaultWorkspace || defaultPath;
  const offset = Number(query.get('offset') ?? 0);
  if (!isAbsolute(requested) || requested.length > 4096 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) {
    throw new WorkspaceFolderError(400, 'invalid_folder_request', 'Use an absolute folder path and a valid page offset.');
  }
  try {
    const path = policy ? await allowedWorkspace(policy, requested) : await realpath(requested);
    if (!(await stat(path)).isDirectory()) throw new Error();
    const roots = policy ? [...policy.allowedWorkspaceRoots] : [parse(path).root];
    const parent = dirname(path);
    const withinRoots = (candidate: string) => roots.some(root => {
      const child = relative(root, candidate);
      return child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
    });
    const search = (query.get('search') ?? '').toLocaleLowerCase();
    const folders = (await readdir(path, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && (query.get('hidden') === '1' || !entry.name.startsWith('.')) && entry.name.toLocaleLowerCase().includes(search))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const page = folders.slice(offset, offset + 100).map(entry => ({ name: entry.name, path: join(path, entry.name) }));
    return { path, parentPath: parent !== path && withinRoots(parent) ? parent : null, roots, folders: page,
      nextOffset: offset + page.length < folders.length ? offset + page.length : null };
  } catch (error) {
    if (error instanceof HostExecutionPolicyError) throw error;
    throw new WorkspaceFolderError(403, 'folder_unavailable', 'This folder cannot be opened. Check its path and local read permissions.');
  }
}

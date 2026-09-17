import { mkdir, readdir, realpath, stat } from 'node:fs/promises';
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

export async function createWorkspaceFolder(parentPath: unknown, name: unknown, policy?: HostExecutionPolicy): Promise<{ path: string }> {
  if (typeof parentPath !== 'string' || !isAbsolute(parentPath) || parentPath.length > 4096
    || typeof name !== 'string' || !name.trim() || name !== name.trim() || name === '.' || name === '..'
    || /[/\\\u0000-\u001f\u007f]/.test(name) || Buffer.byteLength(name, 'utf8') > 255) {
    throw new WorkspaceFolderError(400, 'invalid_folder_request', 'Choose an absolute parent folder and a single folder name without slashes or surrounding spaces.');
  }
  try {
    const parent = policy ? await allowedWorkspace(policy, parentPath) : await realpath(parentPath);
    if (!(await stat(parent)).isDirectory()) throw new WorkspaceFolderError(403, 'folder_unavailable', 'The parent folder is unavailable.');
    const path = join(parent, name);
    // A non-recursive mkdir never reuses an existing file, directory, or symbolic link.
    await mkdir(path);
    return { path };
  } catch (error) {
    if (error instanceof HostExecutionPolicyError || error instanceof WorkspaceFolderError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new WorkspaceFolderError(409, 'folder_exists', 'A file or folder with this name already exists. Choose another name.');
    if (['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOTDIR'].includes(code ?? '')) {
      throw new WorkspaceFolderError(403, 'folder_unavailable', 'Cannot create a folder here. Check the parent path and local write permissions.');
    }
    throw new WorkspaceFolderError(503, 'folder_creation_failed', 'The folder could not be created. Check local disk space and refresh before retrying.');
  }
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

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CodexAppServerProvider } from './provider.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it('identifies a missing session directory instead of blaming the executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-workspace-')); roots.push(root);
  const cwd = join(root, 'removed-worktree');
  const provider = new CodexAppServerProvider({ executable: process.execPath });
  await expect(provider.createSession({ sessionId: 'missing-workspace', cwd })).rejects.toThrow(`Codex working directory does not exist: ${cwd}`);
});

it('rejects a file used as a working directory before launching Codex', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-workspace-')); roots.push(root);
  const cwd = join(root, 'file'); await writeFile(cwd, '');
  const provider = new CodexAppServerProvider({ executable: process.execPath });
  await expect(provider.createSession({ sessionId: 'file-workspace', cwd })).rejects.toThrow(`Codex working directory is not a directory: ${cwd}`);
});

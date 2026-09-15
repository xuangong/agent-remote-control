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

it('requires explicit shared mode, an absolute socket and a compatible local policy', () => {
  expect(() => new CodexAppServerProvider({ connectionMode: 'invalid' as 'shared' })).toThrow('connection mode');
  expect(() => new CodexAppServerProvider({ socketPath: '/tmp/socket' })).toThrow('shared mode');
  expect(() => new CodexAppServerProvider({ connectionMode: 'shared', socketPath: 'relative' })).toThrow('absolute');
  expect(() => new CodexAppServerProvider({ connectionMode: 'shared', restrictedNative: true })).toThrow('permissions');
});

it('reports an unavailable shared socket without starting a private writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-shared-missing-')); roots.push(root);
  const provider = new CodexAppServerProvider({ connectionMode: 'shared', socketPath: join(root, 'missing.sock'), executable: '/must-not-execute', requestTimeoutMs: 500 });
  await expect(provider.listSessions()).rejects.toThrow('Could not connect to the shared Codex');
});

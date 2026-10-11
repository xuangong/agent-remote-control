import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { resolveOpenCodeExecutable } from './opencode-executable.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it.skipIf(process.platform === 'win32')('discovers a native user installation outside the login service PATH without overriding PATH or explicit configuration', async () => {
  const home = await mkdtemp(join(tmpdir(), 'arc-opencode-path-')); roots.push(home);
  const directory = join(home, '.opencode', 'bin');
  await mkdir(directory, { recursive: true });
  const installed = join(directory, 'opencode');
  await writeFile(installed, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  expect(resolveOpenCodeExecutable({ HOME: home, PATH: '' })).toBe(installed);
  const preferred = join(home, 'preferred');
  await mkdir(preferred);
  await writeFile(join(preferred, 'opencode'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  expect(resolveOpenCodeExecutable({ HOME: home, PATH: preferred })).toBe(join(preferred, 'opencode'));
  await chmod(join(preferred, 'opencode'), 0o644);
  expect(resolveOpenCodeExecutable({ HOME: home, PATH: preferred })).toBe(installed);
  expect(resolveOpenCodeExecutable({ HOME: home, PATH: preferred, AGENT_HOST_OPENCODE: '/explicit/opencode' })).toBe('/explicit/opencode');
}, 10_000);

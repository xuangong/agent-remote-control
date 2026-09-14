import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
test('the installed bin symlink invokes CLI help outside the repository', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent host cli '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'agent-remote-controller');
  await symlink(fileURLToPath(new URL('../packages/agent-host/dist/cli.js', import.meta.url)), bin);
  const { stdout } = await exec(process.execPath, [bin, '--help'], { cwd: directory, timeout: 10000 });
  assert.match(stdout, /Usage: agent-remote-controller/);
});

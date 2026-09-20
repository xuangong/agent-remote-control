import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(saved: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'arc-codex-cli-')); roots.push(root);
  const executable = join(root, 'native codex');
  await writeFile(executable, `#!${process.execPath}\nconst value = { args: process.argv.slice(2), locale: process.env.LC_ALL, home: process.env.CODEX_HOME, key: process.env.AGENT_HOST_REMOTE_KEY }; console.log(JSON.stringify(value)); process.exit(Number(process.env.NATIVE_TEST_EXIT ?? 0));\n`, { mode: 0o700 });
  await writeFile(join(root, 'connection.json'), JSON.stringify({ serverUrl: 'https://relay.invalid', remoteKey: 'private-key', environment: { AGENT_HOST_CODEX: executable, AGENT_REMOTE_CODEX_HOME: join(root, 'codex home'), ...saved } }));
  const run = (args: string[], environment: NodeJS.ProcessEnv = {}) => execute(process.execPath, ['dist/cli.js', 'codex', ...args], {
    cwd: process.cwd(), timeout: 5000, env: { PATH: process.env.PATH, HOME: process.env.HOME, AGENT_HOST_STATE_DIR: root, ...environment },
  });
  return { root, run };
}
it('uses saved native identity and preserves every argument without passing Relay credentials', async () => {
  const f = await fixture();
  const result = JSON.parse((await f.run(['resume', 'session-id', '--', 'literal $(touch nope)', '--help'])).stdout);
  expect(result).toEqual({ args: ['--remote', `unix://${f.root}/codex home/app-server-control/app-server-control.sock`, 'resume', 'session-id', '--', 'literal $(touch nope)', '--help'], locale: 'C', home: `${f.root}/codex home` });
});
it('maps daemon lifecycle separately and reports status through the native daemon version command', async () => {
  const f = await fixture();
  for (const command of ['start', 'restart', 'stop', 'status']) {
    const result = JSON.parse((await f.run(['daemon', command])).stdout);
    expect(result.args).toEqual(['app-server', 'daemon', command === 'status' ? 'version' : command]);
    expect(result.locale).toBe('C');
  }
});
it('uses explicit socket overrides and refuses to manage an unrelated custom daemon', async () => {
  const f = await fixture({ AGENT_HOST_CODEX_SOCKET: '/tmp/custom.sock' });
  expect(JSON.parse((await f.run([])).stdout).args).toEqual(['--remote', 'unix:///tmp/custom.sock']);
  await expect(f.run(['daemon', 'restart'])).rejects.toMatchObject({ stderr: expect.stringMatching(/custom socket/i) });
  expect(JSON.parse((await f.run(['--help'])).stdout).args).toEqual(['--help']);
  await expect(f.run(['app-server', 'daemon', 'restart'])).rejects.toMatchObject({ stderr: expect.stringMatching(/custom socket/i) });
});
it('preserves native exit status and supports an explicit inherited file descriptor limit', async () => {
  const f = await fixture();
  await expect(f.run([], { NATIVE_TEST_EXIT: '23' })).rejects.toMatchObject({ code: 23 });
  const limitProbe = join(f.root, 'limit probe');
  // Node raises its own soft limit at startup; a shell probe observes the inherited value directly.
  await writeFile(limitProbe, '#!/bin/sh\nulimit -Sn\n', { mode: 0o700 });
  const result = await f.run(['daemon', 'start'], { AGENT_HOST_CODEX: limitProbe, AGENT_HOST_CODEX_NOFILE: '8192' });
  expect(result.stdout.trim()).toBe('8192');
});

it('honors explicit native home overrides and runs without Relay pairing', async () => {
  const f = await fixture();
  const overridden = JSON.parse((await f.run(['resume', '--last'], { CODEX_HOME: join(f.root, 'override') })).stdout);
  expect(overridden.home).toBe(join(f.root, 'override'));
  expect(overridden.args).toEqual(['--remote', `unix://${f.root}/override/app-server-control/app-server-control.sock`, 'resume', '--last']);
  await rm(join(f.root, 'connection.json'));
  const local = JSON.parse((await f.run([], { AGENT_HOST_CODEX: join(f.root, 'native codex'), AGENT_REMOTE_CODEX_HOME: join(f.root, 'local') })).stdout);
  expect(local.args).toEqual(['--remote', `unix://${f.root}/local/app-server-control/app-server-control.sock`]);
});

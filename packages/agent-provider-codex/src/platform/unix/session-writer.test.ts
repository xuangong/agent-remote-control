import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({holders: 'p12345\n', uid: 0, args: 'codex app-server', binary: '/opt/codex', files: ''}));
vi.mock('node:child_process', () => ({execFile: (_file: string, args: string[], _options: unknown, callback: Function) => {
  const result = args.includes('-Fp') ? mock.holders : args.includes('uid=') ? `${mock.uid} Sat Sep 26 01:00:00 2026\n`
    : args.includes('comm=') ? mock.binary : args.includes('args=') ? mock.args : mock.files;
  callback(null, {stdout: result, stderr: ''});
}}));
import { inspectUnixCodexWriter } from './session-writer.js';
const test = it.skipIf(process.platform === 'win32');
let root: string, lock: string;
beforeEach(async () => {
  const {mkdir} = await import('node:fs/promises');
  root = await realpath(await mkdtemp(join(tmpdir(), 'arc-writer-inspect-')));
  await mkdir(join(root, 'thread-writer-locks'));
  lock = join(root, 'thread-writer-locks', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.lock');
  await writeFile(lock, '');
  Object.assign(mock, {holders: 'p12345\n', uid: process.getuid?.() ?? -1, args: 'codex app-server', binary: '/opt/codex', files: `f5\ntREG\nn${lock}\n`});
});
afterEach(async () => {await rm(root, {recursive: true, force: true});});
test('recognizes one same-user native writer by its exact lock file', async () => {
  expect(await inspectUnixCodexWriter(lock)).toMatchObject({pid: 12345, identity: expect.any(String)});
});
test.each(['codex app-server --listen unix:///tmp/shared.sock', 'codex app-server --listen=ws://127.0.0.1:9999', 'codex --remote unix:///tmp/shared.sock', 'codex app-server daemon start'])('does not offer takeover for %s', async args => {
  mock.args = args; expect(await inspectUnixCodexWriter(lock)).toBeUndefined();
});
test('rejects multiple session owners, non-Codex processes and other users', async () => {
  mock.files += `f6\ntREG\nn${root}/thread-writer-locks/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.lock\n`;
  expect(await inspectUnixCodexWriter(lock)).toBeUndefined();
  mock.files = `f5\ntREG\nn${lock}\n`; mock.binary = '/bin/node';
  expect(await inspectUnixCodexWriter(lock)).toBeUndefined();
  mock.binary = '/opt/codex'; mock.uid++;
  expect(await inspectUnixCodexWriter(lock)).toBeUndefined();
});

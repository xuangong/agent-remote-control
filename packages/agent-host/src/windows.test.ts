import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { nativeInvocation, resolveNativeExecutable } from './platform/executables/index.js';
import { createCodexHostRegistration } from './codex.js';
import { spawnCodexAppServer } from '../../agent-provider-codex/src/native.js';
import { CodexAppServerTransport } from '../../codex-daemon-client/src/app-server-transport.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'controller native & spaces '));
  directories.push(path); return path;
}

it.runIf(process.platform === 'win32')('resolves npm shims using case-insensitive PATH and runs literal arguments without a shell', async () => {
  const bin = await directory();
  const entry = join(bin, 'node_modules/@openai/codex/bin/codex.js');
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(join(bin, 'codex.cmd'), '@echo off\r\nexit /b 99\r\n');
  await writeFile(entry, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const executable = resolveNativeExecutable('codex', '@openai/codex/bin/codex.js', { Path: bin });
  expect(executable).toBe(entry);
  expect(resolveNativeExecutable(join(bin, 'codex.cmd'), '@openai/codex/bin/codex.js', {})).toBe(entry);
  const localBin = join(bin, 'node_modules/.bin');
  await mkdir(localBin);
  await writeFile(join(localBin, 'codex.cmd'), '@echo off\r\nexit /b 99\r\n');
  expect(resolveNativeExecutable('codex', '@openai/codex/bin/codex.js', { PATH: localBin, Path: 'unavailable' })).toBe(entry);
  const args = ['space in argument', '& echo injected', '%PATH%', '"quoted"', '中文目录'];
  const result = await promisify(execFile)(...nativeInvocation(executable, args), { timeout: 5000 });
  expect(JSON.parse(result.stdout)).toEqual(args);
  await writeFile(join(bin, 'custom.cmd'), '@echo off');
  expect(() => resolveNativeExecutable(join(bin, 'custom.cmd'), 'missing/cli.js', {})).toThrow(/JavaScript entry/);
  expect(() => resolveNativeExecutable('missing', 'missing/cli.js', { Path: bin })).toThrow(/not found/);
});

it('runs a Codex JavaScript entry over real stdio from a path containing spaces', async () => {
  const bin = await directory();
  const entry = join(bin, 'codex.cjs');
  await writeFile(entry, `require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    console.log(JSON.stringify({ request: JSON.parse(line), args: process.argv.slice(2) }));
  });`);
  const child = spawnCodexAppServer({ executable: entry, cwd: bin });
  try {
    const output = new Promise<string>((done, reject) => { child.stdout.once('data', data => done(String(data))); child.once('error', reject); });
    child.stdin.write(JSON.stringify({ id: 1, method: 'initialize' }) + '\n');
    expect(JSON.parse(await output)).toEqual({ request: { id: 1, method: 'initialize' }, args: ['app-server'] });
  } finally {
    child.stdin.end();
    await new Promise<void>(done => { child.once('close', () => done()); child.kill(); });
  }
});

it.runIf(process.platform === 'win32')('uses a configured npm shim for the native version probe', async () => {
  const bin = await directory();
  const entry = join(bin, 'node_modules/@openai/codex/bin/codex.js');
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(join(bin, 'codex.cmd'), '@echo off\r\nexit /b 99\r\n');
  await writeFile(entry, "console.log('codex-cli 0.148.0');");
  const registration = await createCodexHostRegistration({ executable: join(bin, 'codex.cmd') });
  expect(registration.directory.providerId).toBe('codex');
  await registration.directory.close();
});

it.runIf(process.platform === 'win32')('stops the owned Codex process tree, including a native child behind a JavaScript wrapper', async () => {
  const bin = await directory();
  const entry = join(bin, 'wrapper.cjs');
  await writeFile(entry, `const child = require('node:child_process').spawn(process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    console.log(child.pid); setInterval(() => {}, 1000);`);
  const child = spawnCodexAppServer({ executable: entry });
  let nativePid: number | undefined;
  try {
    nativePid = await new Promise<number>((done, reject) => { child.stdout.once('data', data => done(Number(String(data).trim()))); child.once('error', reject); });
    process.kill(nativePid, 0);
    await new CodexAppServerTransport(child).dispose();
    expect(() => process.kill(nativePid!, 0)).toThrow();
    expect(() => process.kill(child.pid!, 0)).toThrow();
  } finally {
    try { child.kill(); } catch {}
    if (nativePid) { try { process.kill(nativePid); } catch {} }
  }
});

it.runIf(process.platform === 'win32')('proxies private Codex literally on Windows and rejects Unix file-limit settings', async () => {
  const bin = await directory();
  const entry = join(bin, 'codex.cjs');
  const capture = join(bin, 'arguments.json');
  await writeFile(entry, "require('node:fs').writeFileSync(process.env.NATIVE_CAPTURE, JSON.stringify(process.argv.slice(2)));");
  const env = { ...process.env, AGENT_HOST_STATE_DIR: bin, AGENT_HOST_CODEX: entry, NATIVE_CAPTURE: capture,
    AGENT_HOST_CODEX_CONNECTION: 'private' };
  const cli = resolve('dist/cli.js');
  await promisify(execFile)(process.execPath, [cli, 'codex', 'hello & goodbye'], { env, timeout: 5000 });
  expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual(['hello & goodbye']);
  await expect(promisify(execFile)(process.execPath, [cli, 'codex', 'daemon', 'start'], { env: { ...env, AGENT_HOST_CODEX_NOFILE: '8192' }, timeout: 5000 }))
    .rejects.toMatchObject({ stderr: expect.stringContaining('only supported on Unix') });
});

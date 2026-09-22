import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { publishControllerPackage } from './controller-package.js';

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, rename: vi.fn(fs.rename) };
});
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.mocked(rename).mockReset();
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(rename).mockImplementation(fs.rename);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function installation() {
  const root = await mkdtemp(join(tmpdir(), 'controller-package-')); roots.push(root);
  const stage = join(root, 'stage'), target = join(root, 'candidate');
  await mkdir(stage); await writeFile(join(stage, 'verified'), 'verified package');
  await writeFile(join(root, 'current.json'), 'previous installation');
  return { root, stage, target };
}
it.each(['EPERM', 'EACCES', 'EBUSY'])('publishes verified files after a temporary Windows %s', async code => {
  const { stage, target, root } = await installation();
  vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('locked'), { code }));
  await publishControllerPackage(stage, target, 'win32');
  expect(await readFile(join(target, 'verified'), 'utf8')).toBe('verified package');
  expect(await readFile(join(root, 'current.json'), 'utf8')).toBe('previous installation');
  await expect(readFile(join(stage, 'verified'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('stops retrying a permanent lock without publishing or changing the active installation', async () => {
  const { stage, target, root } = await installation();
  vi.useFakeTimers();
  const locked = Object.assign(new Error('locked'), { code: 'EPERM' });
  vi.mocked(rename).mockRejectedValue(locked);
  const result = expect(publishControllerPackage(stage, target, 'win32')).rejects.toMatchObject({ message: expect.stringContaining('still locked'), cause: locked });
  await vi.runAllTimersAsync(); await result;
  expect(await readFile(join(stage, 'verified'), 'utf8')).toBe('verified package');
  expect(await readFile(join(root, 'current.json'), 'utf8')).toBe('previous installation');
  await expect(readFile(join(target, 'verified'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each([['linux', 'EPERM'], ['win32', 'ENOENT'], ['win32', 'ENOTEMPTY']] as const)('does not retry %s %s', async (platform, code) => {
  const { stage, target } = await installation();
  const failure = Object.assign(new Error('not retryable'), { code });
  vi.mocked(rename).mockRejectedValueOnce(failure);
  await expect(publishControllerPackage(stage, target, platform)).rejects.toBe(failure);
  expect(rename).toHaveBeenCalledTimes(1);
});
it.runIf(process.platform === 'win32')('waits for a real Windows process to release its working directory', async () => {
  const { stage, target } = await installation();
  const child = spawn(process.execPath, ['-e', "process.send('ready'); process.on('message', () => process.exit(0));"],
    { cwd: stage, windowsHide: true, timeout: 5000, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    await once(child, 'message');
    await expect(rename(stage, target)).rejects.toMatchObject({ code: expect.stringMatching(/EPERM|EACCES|EBUSY/) });
    const pending = publishControllerPackage(stage, target, 'win32');
    setTimeout(() => child.send('release'), 300);
    await pending;
    expect(await readFile(join(target, 'verified'), 'utf8')).toBe('verified package');
  } finally { child.kill(); await exited; }
});

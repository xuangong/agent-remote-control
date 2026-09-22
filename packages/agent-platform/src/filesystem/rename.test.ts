import { rename } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { filesystemFor } from './index.js';

vi.mock('node:fs/promises', async load => ({ ...await load<typeof import('node:fs/promises')>(), rename: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.mocked(rename).mockReset(); });
const policy = { retries: 2, delayMs: 25, maxDelayMs: 50 };

it.each(['EPERM', 'EACCES', 'EBUSY'])('retries Windows sharing error %s within its bound', async code => {
  vi.useFakeTimers();
  vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('sharing violation'), { code })).mockResolvedValue(undefined);
  const result = filesystemFor('win32').rename('stage', 'destination', policy);
  await vi.runAllTimersAsync(); await result;
  expect(rename).toHaveBeenCalledTimes(2);
});

it('propagates the original error when the Windows retry budget is exhausted', async () => {
  vi.useFakeTimers();
  const error = Object.assign(new Error('held open'), { code: 'EPERM' });
  vi.mocked(rename).mockRejectedValue(error);
  const result = expect(filesystemFor('win32').rename('stage', 'destination', policy)).rejects.toBe(error);
  await vi.runAllTimersAsync(); await result;
  expect(rename).toHaveBeenCalledTimes(3);
});

it.each([['linux', 'EPERM'], ['darwin', 'EBUSY'], ['win32', 'ENOENT']] as const)('does not retry %s %s', async (platform, code) => {
  const error = Object.assign(new Error('unrelated error'), { code }); vi.mocked(rename).mockRejectedValue(error);
  await expect(filesystemFor(platform).rename('stage', 'destination', policy)).rejects.toBe(error);
  expect(rename).toHaveBeenCalledTimes(1);
});

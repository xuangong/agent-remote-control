import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { finalizeOperatingSample } from './operating-sample-finalizer.js';

async function temporarySample(operation: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'arc-operating-finalizer-'));
  try { await operation(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function sample(primary?: Error) {
  return { id: 'finalizer', outcome: primary ? 'failed' : 'passed',
    failures: primary ? [{ error: String(primary), stack: primary.stack }] : [],
    phases: [{ name: 'operation', milliseconds: 12, success: !primary }],
    responses: [{ status: primary ? 503 : 200 }], fileInventories: [{ point: 'live', apparentBytes: 42 }] };
}

async function persisted(path: string, original: ReturnType<typeof sample>, outcome: string) {
  const saved = JSON.parse(await readFile(path, 'utf8'));
  expect(saved.outcome).toBe(outcome);
  expect(saved.phases).toEqual(original.phases);
  expect(saved.responses).toEqual(original.responses);
  expect(saved.fileInventories).toEqual(original.fileInventories);
  expect(Number.isNaN(Date.parse(saved.finishedAt))).toBe(false);
  return saved;
}

test('persists successful observations after owned cleanup', () => temporarySample(async directory => {
  const path = join(directory, 'sample.json'), observed = sample();
  const owned = await mkdtemp(join(directory, 'owned-'));
  await finalizeOperatingSample(observed, path, () => rm(owned, { recursive: true }));
  expect((await persisted(path, observed, 'passed')).failures).toEqual([]);
  await expect(access(owned)).rejects.toMatchObject({ code: 'ENOENT' });
}), 15000);

test('persists primary failure and rejects with the original cause', () => temporarySample(async directory => {
  const primary = new Error('operation failed'), observed = sample(primary), path = join(directory, 'sample.json');
  await expect(finalizeOperatingSample(observed, path, undefined, { error: primary })).rejects.toBe(primary);
  expect((await persisted(path, observed, 'failed')).failures).toEqual([{ error: String(primary), stack: primary.stack }]);
}), 15000);

test('persists failed observations when cleanup alone rejects', () => temporarySample(async directory => {
  const cleanup = new Error('owned cleanup failed'), observed = sample(), path = join(directory, 'sample.json');
  await expect(finalizeOperatingSample(observed, path, async () => { throw cleanup; })).rejects.toBe(cleanup);
  expect((await persisted(path, observed, 'failed')).failures).toEqual([{ cleanupError: String(cleanup) }]);
}), 15000);

test('persists both primary and cleanup failures before rejecting', () => temporarySample(async directory => {
  const primary = new Error('operation failed'), cleanup = new Error('owned cleanup failed');
  const observed = sample(primary), path = join(directory, 'sample.json');
  const rejected = await finalizeOperatingSample(observed, path, async () => { throw cleanup; }, { error: primary }).catch(error => error);
  expect(rejected).toBeInstanceOf(AggregateError);
  expect(rejected.errors).toEqual([primary, cleanup]); expect(rejected.cause).toBe(primary);
  expect((await persisted(path, observed, 'failed')).failures).toEqual([
    { error: String(primary), stack: primary.stack }, { cleanupError: String(cleanup) },
  ]);
}), 15000);

test('surfaces a real evidence-write failure while retaining earlier causes', () => temporarySample(async directory => {
  const primary = new Error('operation failed'), cleanup = new Error('owned cleanup failed'), observed = sample(primary);
  const rejected = await finalizeOperatingSample(observed, directory, async () => { throw cleanup; }, { error: primary }).catch(error => error);
  expect(rejected).toBeInstanceOf(AggregateError);
  expect(rejected.cause).toBe(primary); expect(rejected.errors.slice(0, 2)).toEqual([primary, cleanup]);
  expect(rejected.errors[2]).toMatchObject({ code: 'EISDIR' });
  expect(observed.outcome).toBe('failed');
  expect(observed.failures).toEqual(expect.arrayContaining([{ error: String(primary), stack: primary.stack },
    { cleanupError: String(cleanup) }, { evidenceWriteError: String(rejected.errors[2]) }]));
}), 15000);

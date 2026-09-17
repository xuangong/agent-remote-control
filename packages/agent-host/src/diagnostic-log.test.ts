import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDiagnosticLog } from './diagnostic-log.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function temporaryLog(): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-diagnostic-'));
  roots.push(root);
  return { root, path: join(root, 'agent-host.log') };
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for diagnostic cleanup.');
}

describe('bounded daemon diagnostics', () => {
  it('allows one bounded line of overshoot and rotates before the following owned diagnostic', async () => {
    const { path } = await temporaryLog();
    await writeFile(path, 'prior-diagnostic-content');
    const log = createDiagnosticLog({
      path,
      maxBytes: 32,
      archiveCount: 2,
      cleanupIntervalMs: 60_000,
      sink: line => appendFileSync(path, line),
    });
    try {
      log.write('next-diagnostic-line');
      expect((await stat(path)).size).toBe(45);
      await expect(readFile(`${path}.1`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      log.write('following-line');
      expect(await readFile(path, 'utf8')).toBe('following-line\n');
      expect(await readFile(`${path}.1`, 'utf8')).toBe('tic-contentnext-diagnostic-line\n');
    } finally {
      log.dispose();
    }
  });

  it('keeps one append descriptor on the active inode across repeated rotations', async () => {
    const { path } = await temporaryLog();
    const writer = await open(path, 'a', 0o600);
    const log = createDiagnosticLog({ path, maxBytes: 48, archiveCount: 2, cleanupIntervalMs: 60_000 });
    try {
      await writer.write(`${'a'.repeat(48)}first-end`);
      log.cleanupNow();
      expect((await stat(path)).size).toBe(0);
      expect(await readFile(`${path}.1`, 'utf8')).toContain('first-end');

      await writer.write(`${'b'.repeat(48)}second-end`);
      log.cleanupNow();
      expect(await readFile(`${path}.1`, 'utf8')).toContain('second-end');
      expect(await readFile(`${path}.2`, 'utf8')).toContain('first-end');

      await writer.write('still-active');
      expect(await readFile(path, 'utf8')).toBe('still-active');
      expect((await stat(path)).blocks).toBeLessThanOrEqual(8);
    } finally {
      log.dispose();
      await writer.close();
    }
  });

  it('bounds oversized active and archived files during startup', async () => {
    const { root, path } = await temporaryLog();
    await writeFile(path, `${'a'.repeat(80)}active-tail`);
    await writeFile(`${path}.1`, `${'b'.repeat(80)}archive-tail`);
    await writeFile(`${path}.4`, 'expired-archive');

    const log = createDiagnosticLog({ path, maxBytes: 32, archiveCount: 3, cleanupIntervalMs: 60_000 });
    try {
      expect((await stat(path)).size).toBe(0);
      expect(await readFile(`${path}.1`, 'utf8')).toContain('active-tail');
      expect(await readFile(`${path}.2`, 'utf8')).toContain('archive-tail');
      const archives = (await readdir(root)).filter(name => /^agent-host\.log\.\d+$/.test(name));
      expect(archives.sort()).toEqual(['agent-host.log.1', 'agent-host.log.2']);
      for (const archive of archives) {
        const metadata = await stat(join(root, archive));
        expect(metadata.size).toBeLessThanOrEqual(32);
        expect(metadata.mode & 0o777).toBe(0o600);
      }
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      log.dispose();
    }
  });

  it('truncates the active inode when retaining an archive fails', async () => {
    const { path } = await temporaryLog();
    const writer = await open(path, 'a', 0o600);
    const log = createDiagnosticLog({ path, maxBytes: 32, archiveCount: 2, cleanupIntervalMs: 60_000 });
    try {
      await mkdir(`${path}.1`);
      await writer.write('x'.repeat(64));
      expect(() => log.cleanupNow()).not.toThrow();
      expect((await stat(path)).size).toBe(0);
      await writer.write('writer-survived');
      expect(await readFile(path, 'utf8')).toBe('writer-survived');
    } finally {
      log.dispose();
      await writer.close();
    }
  });

  it('cancels runtime cleanup when disposed', async () => {
    const { path } = await temporaryLog();
    const writer = await open(path, 'a', 0o600);
    const log = createDiagnosticLog({ path, maxBytes: 32, archiveCount: 2, cleanupIntervalMs: 10 });
    try {
      await writer.write('x'.repeat(64));
      await waitFor(async () => (await stat(path)).size === 0);
      log.dispose();
      await writer.write('y'.repeat(64));
      await new Promise(resolve => setTimeout(resolve, 40));
      expect((await stat(path)).size).toBe(64);
    } finally {
      log.dispose();
      await writer.close();
    }
  });
});

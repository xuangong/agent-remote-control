import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireStartupLock, authenticateSavedDaemon, daemonDiagnosticLine, within } from './cli.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('Agent Host daemon lifecycle', () => {
  it('preserves stale and active locks until explicit manual recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-host-lock-')); temporary.push(root);
    const stale = join(root, 'stale'); await mkdir(stale);
    await writeFile(join(stale, 'owner.json'), JSON.stringify({ pid: 2_147_483_647 }));
    const recoverers = [acquireStartupLock(stale), acquireStartupLock(stale)];
    await Promise.all(recoverers.map((operation) => expect(operation).rejects.toThrow(/remove this private stale lock/i)));
    expect(JSON.parse(await readFile(join(stale, 'owner.json'), 'utf8')).pid).toBe(2_147_483_647);
    const active = join(root, 'active'); await mkdir(active);
    await writeFile(join(active, 'owner.json'), JSON.stringify({ pid: process.pid }));
    await expect(acquireStartupLock(active)).rejects.toThrow(/remove this private stale lock/i);
  });

  it('requires authenticated local management before trusting a live saved PID', async () => {
    const state = { pid: process.pid, token: 'saved', socket: '/unused', startedAt: new Date().toISOString() };
    await expect(authenticateSavedDaemon(state, async () => { throw new Error('wrong daemon'); })).resolves.toBe(false);
    await expect(authenticateSavedDaemon(state, async () => ({ running: true }))).resolves.toBe(true);
  });

  it('returns at the shutdown deadline when cleanup is blocked', async () => {
    const started = Date.now();
    await within(new Promise<void>(() => undefined), 25);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('removes pairing and management credentials from retained native diagnostics', () => {
    expect(daemonDiagnosticLine('native failed key-pair token-local', ['key-pair', 'token-local']))
      .toBe('native failed [redacted] [redacted]\n');
  });
});

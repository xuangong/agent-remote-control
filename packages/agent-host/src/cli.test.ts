import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireStartupLock, authenticateSavedDaemon, daemonDiagnosticLine, removeOwnedDaemonState, uplinkDiagnosticLine, withDaemonLifecycleLock, within } from './cli.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('Agent Host daemon lifecycle', () => {
  it('formats timestamped uplink diagnostics as one JSON line using only safe fields', () => {
    const before = Date.now();
    const line = uplinkDiagnosticLine({ event: 'disconnected', uplinkGeneration: 2, connectionId: 3, registered: true,
      reason: 'heartbeat_timeout', closeCode: 1006, heartbeatTimeoutMs: 40000, lastHeartbeatAgeMs: 40005,
      peerReason: 'heartbeat_timeout',
      message: 'remote-key\nmanagement-token', payload: { credential: 'remote-key' }, url: 'wss://user:secret@example.test',
    } as Parameters<typeof uplinkDiagnosticLine>[0]);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trim().split('\n')).toHaveLength(1);
    const record = JSON.parse(line);
    expect(record).toEqual({ timestamp: expect.any(String), pid: process.pid, event: 'uplink_disconnected',
      uplinkGeneration: 2, connectionId: 3, registered: true, reason: 'heartbeat_timeout', closeCode: 1006,
      peerReason: 'heartbeat_timeout', heartbeatTimeoutMs: 40000, lastHeartbeatAgeMs: 40005 });
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(record.timestamp)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(record.timestamp)).toBeLessThanOrEqual(Date.now());
  });

  it('does not remove another daemon generation state during shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-host-owner-')); temporary.push(root);
    const path = join(root, 'daemon.json');
    await writeFile(path, JSON.stringify({ pid: 222, token: 'replacement' }));
    await removeOwnedDaemonState(path, { pid: 111, token: 'original' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ pid: 222, token: 'replacement' });
    await removeOwnedDaemonState(path, { pid: 222, token: 'original' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ pid: 222, token: 'replacement' });
    await removeOwnedDaemonState(path, { pid: 222, token: 'replacement' });
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('excludes concurrent lifecycle mutations and releases ownership after failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-host-lifecycle-')); temporary.push(root);
    let release!: () => void, entered!: () => void;
    const acquired = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = withDaemonLifecycleLock(root, async () => { entered(); await gate; });
    await acquired;
    try {
      await expect(withDaemonLifecycleLock(root, () => writeFile(join(root, 'unexpected'), 'conflict'))).rejects.toThrow(/lifecycle command owns/);
      await expect(readFile(join(root, 'unexpected'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { release(); await first; }
    await expect(withDaemonLifecycleLock(root, async () => { throw new Error('operation failed'); })).rejects.toThrow('operation failed');
    await withDaemonLifecycleLock(root, () => writeFile(join(root, 'completed'), 'ok'));
    expect(await readFile(join(root, 'completed'), 'utf8')).toBe('ok');
  });
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

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireStartupLock, authenticateSavedDaemon, createControllerDiagnosticLog, daemonDiagnosticLine, removeOwnedDaemonState, uplinkDiagnosticLine, withDaemonLifecycleLock, within } from './cli.js';

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

  it('redacts a complete credential before applying the diagnostic line byte limit', () => {
    const secret = 'credential-that-crosses-the-limit';
    const line = daemonDiagnosticLine(`prefix:${secret}:${'tail'.repeat(12)}`, [secret], 24);
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(24);
    expect(line).toContain('[redacted]');
    expect(line).not.toContain('credential');
    expect(line.endsWith('\n')).toBe(true);
  });

  it('bounds the daemon log before reporting an initialization failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-host-startup-log-'));
    temporary.push(root);
    const path = join(root, 'agent-host.log');
    const maxBytes = 5 * 1024 * 1024;
    await writeFile(path, Buffer.alloc(maxBytes + 128, 'x'), { mode: 0o600 });
    const writer = await open(path, 'a', 0o600);
    try {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), '_serve'], {
        env: { HOME: root, PATH: process.env.PATH, AGENT_HOST_STATE_DIR: root },
        stdio: ['ignore', writer.fd, writer.fd],
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      expect(code).toBe(1);
      expect((await stat(path)).size).toBeLessThan(maxBytes);
      expect((await stat(`${path}.1`)).size).toBe(maxBytes);
    } finally {
      await writer.close();
    }
  });
});

it('persists foreground diagnostics privately without losing redaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foreground-diagnostics-')); temporary.push(root);
  const path = join(root, 'agent-host.log');
  const log = createControllerDiagnosticLog(false, path);
  try {
    log.write('foreground event credential-secret', ['credential-secret']);
    expect(JSON.parse((await readFile(path, 'utf8')).trim())).toEqual({ source: 'controller', timestamp: expect.any(String), message: 'foreground event [redacted]' });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally { log.dispose(); }
});

it('preserves the occurrence timestamp of structured Controller records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'controller-diagnostics-')); temporary.push(root);
  const path = join(root, 'agent-host.log');
  const log = createControllerDiagnosticLog(false, path);
  try {
    log.write(JSON.stringify({ event: 'uplink_registered', timestamp: '2026-09-20T00:00:00.000Z' }));
    expect(JSON.parse((await readFile(path, 'utf8')).trim())).toEqual({ source: 'controller', timestamp: '2026-09-20T00:00:00.000Z', event: 'uplink_registered' });
  } finally { log.dispose(); }
});

it('keeps oversized Controller messages as timestamped JSON records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'controller-large-diagnostics-')); temporary.push(root);
  const path = join(root, 'agent-host.log');
  const log = createControllerDiagnosticLog(false, path);
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    log.write('x'.repeat(70_000));
    const contents = await readFile(path, 'utf8');
    expect(Buffer.byteLength(contents)).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.parse(contents)).toMatchObject({ source: 'controller', timestamp: expect.any(String) });
  } finally { log.dispose(); output.mockRestore(); }
});

import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

const exec = promisify(execFile);

it('runs the Linux CLI without systemd, reconnects, and persists the manual startup preference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-linux-cli-'));
  const state = join(directory, 'state');
  const bin = join(directory, 'bin'); await mkdir(bin);
  // Exercise Linux CLI branches on macOS too; this does not emulate the Linux kernel or service manager.
  const platform = join(directory, 'platform.mjs');
  await writeFile(platform, "Object.defineProperty(process, 'platform', { value: 'linux' });\n");
  await writeFile(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const codex = join(bin, 'codex');
  await writeFile(codex, '#!/bin/sh\necho codex-cli 0.148.0\n', { mode: 0o755 });
  const env = { HOME: directory, PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: `--import=${platform}`,
    AGENT_HOST_STATE_DIR: state, AGENT_HOST_PROVIDERS: 'codex', AGENT_HOST_CODEX: codex, AGENT_HOST_WORKSPACE: directory };
  const run = (args: string[], extra: Record<string, string> = {}) => exec(process.execPath,
    [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), ...args], { cwd: directory, env: { ...env, ...extra }, timeout: 15000 });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let registrations = 0;
  server.on('connection', socket => {
    let timer: ReturnType<typeof setInterval>;
    socket.on('close', () => clearInterval(timer));
    socket.on('message', data => {
      if (JSON.parse(String(data)).type !== 'register') return;
      registrations++;
      socket.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'linux-test-host', heartbeat: { intervalMs: 1000, timeoutMs: 500 } }));
      timer = setInterval(() => { if (socket.readyState === 1) socket.send(JSON.stringify({ uplinkVersion: 2, type: 'heartbeat', nonce: String(Date.now()) })); }, 500);
    });
  });
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing relay port');
    const connection = { AGENT_HOST_SERVER: `http://127.0.0.1:${address.port}`, AGENT_HOST_REMOTE_KEY: 'linux-cli-test-key' };
    const started = await run(['start'], connection);
    expect(started.stderr).toContain('manual background daemon');
    await expect.poll(async () => (await run(['status'])).stdout).toContain('uplink: registered; supervisor: manual');
    expect((await run(['autostart', 'status'])).stdout).toContain('systemd user manager unavailable');
    await expect(run(['autostart', 'enable'])).rejects.toThrow(/systemd user manager is unavailable/);
    const before = registrations;
    for (const socket of server.clients) socket.close(1012);
    await expect.poll(() => registrations, { timeout: 5000 }).toBeGreaterThan(before);
    await run(['autostart', 'disable']);
    expect((await run(['status'])).stdout).toContain('supervisor: manual');
    await run(['stop']);
    await expect(run(['status'])).rejects.toMatchObject({ code: 3 });
    expect((await run(['start'])).stderr).not.toContain('unavailable');
    expect((await run(['autostart', 'status'])).stdout).toContain('disabled');
    await expect.poll(async () => (await run(['status'])).stdout).toContain('uplink: registered');
  } finally {
    try { await run(['stop']); } catch {
      const saved = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8').catch(() => 'null'));
      if (saved) { try { process.kill(saved.pid, 'SIGTERM'); } catch {} }
    }
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

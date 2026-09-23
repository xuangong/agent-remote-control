import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { restartCodexDaemon, supportsCodexDaemonControl } from './codex-daemon-runner.js';

it('runs restart then checks readiness with the selected Controller environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-daemon-runner-'));
  try {
    const cli = join(root, 'cli.cjs'), capture = join(root, 'calls.jsonl');
    await writeFile(cli, `require('fs').appendFileSync(process.env.CAPTURE, JSON.stringify({args:process.argv.slice(2),state:process.env.AGENT_HOST_STATE_DIR,home:process.env.CODEX_HOME})+'\\n');`);
    await restartCodexDaemon({ stateDir: root, environment: { CODEX_HOME: join(root, 'home'), CAPTURE: capture }, cli });
    expect((await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual([
      { args: ['codex', 'daemon', 'restart'], state: root, home: join(root, 'home') },
      { args: ['codex', 'daemon', 'status'], state: root, home: join(root, 'home') },
    ]);
    await writeFile(cli, 'process.exit(1);');
    await expect(restartCodexDaemon({ stateDir: root, environment: {}, cli })).rejects.toThrow();
    await writeFile(cli, "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);");
    await expect(restartCodexDaemon({ stateDir: root, environment: {}, cli, timeoutMs: 250 })).rejects.toThrow(/unknown/);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);
it('only allows lifecycle management for the configured shared default daemon', () => {
  expect(supportsCodexDaemonControl({})).toBe(true);
  expect(supportsCodexDaemonControl({ AGENT_HOST_CODEX_CONNECTION: 'private' })).toBe(false);
  expect(supportsCodexDaemonControl({ CODEX_HOME: '/codex', AGENT_HOST_CODEX_SOCKET: '/unrelated.sock' })).toBe(false);
  expect(supportsCodexDaemonControl({ CODEX_HOME: '/codex', AGENT_HOST_CODEX_SOCKET: '/codex/app-server-control/app-server-control.sock' }, 'linux')).toBe(true);
  expect(supportsCodexDaemonControl({ AGENT_HOST_CODEX_SOCKET: '/custom.sock' }, 'win32')).toBe(false);
  expect(supportsCodexDaemonControl({ AGENT_HOST_CODEX_NOFILE: '8192' }, 'win32')).toBe(false);
  expect(supportsCodexDaemonControl({}, 'win32')).toBe(true);
}, 10000);

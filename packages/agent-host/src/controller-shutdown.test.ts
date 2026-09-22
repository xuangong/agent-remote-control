import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { expect, it } from 'vitest';

it.each([
  ['foreground', 'request'], ['_serve', 'request'], ['foreground', 'disconnect'], ['_serve', 'disconnect'],
])('cleans up a managed %s Controller after launcher %s', async (command, action) => {
  const root = await mkdtemp(join(tmpdir(), 'controller shutdown '));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address === 'string') throw new Error('Expected local test port.');
  server.on('connection', socket => socket.on('message', raw => {
    if (JSON.parse(String(raw)).type === 'register') socket.send(JSON.stringify({
      uplinkVersion: 2, type: 'registered', hostId: 'shutdown-fixture', pairingPurpose: 'host-only',
      heartbeat: { intervalMs: 30000, timeoutMs: 10000 },
    }));
  }));
  const executable = join(root, 'codex.cjs');
  await writeFile(executable, "console.log('codex-cli 0.155.0');");
  const child = spawn(process.execPath, [resolve('dist/cli.js'), command], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, AGENT_HOST_STATE_DIR: root, AGENT_HOST_WORKSPACE: root,
      AGENT_HOST_SERVER: `http://127.0.0.1:${address.port}`, AGENT_HOST_REMOTE_KEY: 'shutdown-fixture-key',
      AGENT_HOST_PROVIDERS: 'codex', AGENT_HOST_CODEX: executable, AGENT_HOST_CODEX_CONNECTION: 'private',
      AGENT_HOST_MANAGED_UPDATES: '1', AGENT_HOST_SUPERVISOR: undefined, AGENT_HOST_LAUNCHD: undefined },
  });
  let ready = false, output = '';
  child.on('message', message => { if ((message as { type: string }).type === 'controller-ready') ready = true; });
  child.stdout!.on('data', data => { output += data; });
  child.stderr!.on('data', data => { output += data; });
  const exited = once(child, 'exit');
  try {
    await expect.poll(() => ready, { timeout: 8000 }).toBe(true);
    const configuration = await readFile(join(root, 'connection.json'), 'utf8');
    if (command === '_serve') await readFile(join(root, 'daemon.json'));
    if (action === 'disconnect') child.disconnect();
    else child.send({ type: 'controller-shutdown' });
    await expect.poll(() => child.exitCode, { timeout: 5000 }).toBe(0);
    await expect.poll(() => server.clients.size).toBe(0);
    await expect(readFile(join(root, 'daemon.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(root, 'connection.json'), 'utf8')).toBe(configuration);
    expect(output).not.toContain('shutdown-fixture-key');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(done => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

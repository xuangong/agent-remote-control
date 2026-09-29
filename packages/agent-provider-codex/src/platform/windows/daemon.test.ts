import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CodexTransportUnavailableError } from '../../app-server-transport.js';
import { windowsCodexDaemonDirectory, windowsCodexSharedEndpoint } from './daemon.js';

it.each(['missing', 'stale', 'malformed'])('classifies %s Windows daemon state as a transport failure', async kind => {
  const home = await mkdtemp(join(tmpdir(), 'arc-win-endpoint-'));
  try {
    const directory = windowsCodexDaemonDirectory(home);
    await mkdir(directory);
    if (kind !== 'missing') await writeFile(join(directory, 'daemon.json'), kind === 'malformed' ? '{' : JSON.stringify({
      pid: 999999, token: 'private-token', pipe: join(home, 'missing.sock'), url: 'ws://127.0.0.1:1',
    }));
    await expect(windowsCodexSharedEndpoint(home)).rejects.toBeInstanceOf(CodexTransportUnavailableError);
    await expect(windowsCodexSharedEndpoint(home)).rejects.toThrow(/codex daemon start/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

it.each([true, false])('checks Windows daemon identity over the management transport (matching: %s)', async matching => {
  const home = await mkdtemp(join(tmpdir(), 'arc-win-endpoint-'));
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\arc-endpoint-${randomUUID()}` : join(home, 'manager.sock');
  const state = { pid: process.pid, nativePid: process.pid, token: 'private-token', pipe, url: 'ws://127.0.0.1:1', version: 'test' };
  const requests: unknown[] = [];
  const server = createServer(socket => socket.once('data', data => {
    requests.push(JSON.parse(String(data)));
    socket.end(JSON.stringify({ pid: matching ? state.pid : state.pid + 1, url: state.url }) + '\n');
  }));
  try {
    server.listen(pipe); await once(server, 'listening');
    await mkdir(windowsCodexDaemonDirectory(home));
    await writeFile(join(windowsCodexDaemonDirectory(home), 'daemon.json'), JSON.stringify(state));
    if (matching) await expect(windowsCodexSharedEndpoint(home)).resolves.toEqual({ url: state.url, token: state.token });
    else await expect(windowsCodexSharedEndpoint(home)).rejects.toBeInstanceOf(CodexTransportUnavailableError);
    expect(requests).toEqual([{ token: state.token, action: 'status' }]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { CodexAppServerProvider } from './provider.js';

it.each([
  ['thread/resume', 'native_resume_timeout', 'resume'],
  ['thread/read', 'native_history_timeout', 'history'],
  ['initialize', 'native_request_timeout', 'initialize'],
  ['disconnect', 'native_runtime_unavailable', 'resume'],
])('classifies %s failures over a real shared Unix socket', async (blocked, code, phase) => {
  const root = await mkdtemp('/tmp/arc-native-errors-');
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', socket => socket.on('message', raw => {
    const request = JSON.parse(raw.toString());
    if (request.id === undefined) return;
    if (request.method === blocked) return;
    if (blocked === 'disconnect' && request.method === 'thread/resume') { socket.close(); return; }
    socket.send(JSON.stringify({ id: request.id, result: request.method === 'thread/resume'
      ? { thread: { id: 'native-private-session' }, model: 'model' } : {} }));
  }));
  const socketPath = join(root, 'native.sock');
  server.listen(socketPath); await once(server, 'listening');
  const diagnostics: string[] = [];
  const provider = new CodexAppServerProvider({ connectionMode: 'shared', socketPath, requestTimeoutMs: 100,
    onDiagnostic: line => { diagnostics.push(line); } });
  try {
    await expect(provider.resumeSession({ providerId: 'codex', sessionId: 'native-private-session', opaque: '{}' })).rejects.toMatchObject({ code });
    expect(diagnostics.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: 'codex_request', phase,
      outcome: blocked === 'disconnect' ? 'unavailable' : 'timeout', elapsedMs: expect.any(Number) }));
    expect(diagnostics.join('')).not.toContain('native-private-session');
    expect(diagnostics.join('')).not.toContain(socketPath);
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

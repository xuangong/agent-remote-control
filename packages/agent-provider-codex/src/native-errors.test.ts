import { createScriptedAppServer } from './test-utils/scripted-app-server.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { CodexAppServerProvider } from './provider.js';

it.each([
  ['thread/resume', 'native_resume_timeout', 'resume'],
  ['thread/turns/list', 'native_history_timeout', 'history'],
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

it.each(['thread/start', 'thread/resume'])('identifies shared daemon file exhaustion from %s', async method => {
  const root = await mkdtemp('/tmp/arc-native-files-');
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', socket => socket.on('message', raw => {
    const request = JSON.parse(raw.toString());
    if (request.id === undefined) return;
    socket.send(JSON.stringify(request.method === method
      ? { id: request.id, error: { code: -32603, message: 'Failed to open rollout: Too many open files (os error 24)' } }
      : { id: request.id, result: {} }));
  }));
  const socketPath = join(root, 'native.sock');
  server.listen(socketPath); await once(server, 'listening');
  const provider = new CodexAppServerProvider({ connectionMode: 'shared', socketPath, requestTimeoutMs: 1000 });
  try {
    const result = method === 'thread/start' ? provider.createSession({ sessionId: 'new' })
      : provider.resumeSession({ providerId: 'codex', sessionId: 'existing', opaque: '{}' });
    await expect(result).rejects.toMatchObject({ code: 'native_file_limit', message: expect.stringContaining('file descriptor') });
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 10000);


it('does not recommend shared daemon recovery for private native file exhaustion', async () => {
  const app = createScriptedAppServer({ 'thread/start': () => { throw new Error('Too many open files (os error 24)'); } });
  const provider = new CodexAppServerProvider({ spawn: () => app.child });
  await expect(provider.createSession({ sessionId: 'private' })).rejects.not.toMatchObject({ code: 'native_file_limit' });
});

it('does not mistake local Controller file exhaustion for a daemon RPC failure', async () => {
  const provider = new CodexAppServerProvider({ spawn: () => { throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' }); } });
  await expect(provider.createSession({ sessionId: 'private' })).rejects.toMatchObject({ code: 'EMFILE' });
});

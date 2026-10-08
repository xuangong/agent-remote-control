import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntimeError, type AgentSession } from '@orchardworks/agent-provider-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { CodexAppServerRpcError } from './app-server-transport.js';
import { CodexAppServerProvider } from './provider.js';

const sessionId = '00000000-0000-4000-8000-000000000031';
const notLoaded = `thread not loaded: ${sessionId}`;
const noRollout = `no rollout found for thread id ${sessionId}`;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

type RpcError = { code: number | string; message: string };
type Lookup = 'workspace' | 'title' | 'resume';
async function nativeServer(failure: { method: string; error?: RpcError; timeout?: boolean }) {
  const directory = await mkdtemp(join(tmpdir(), 'arc-unavailable-'));
  const socketPath = join(directory, 'native.sock');
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const sessions: AgentSession[] = [];
  cleanups.push(async () => {
    await Promise.all(sessions.map(session => session.dispose()));
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  sockets.on('connection', socket => socket.on('message', data => {
    const request = JSON.parse(data.toString());
    if (typeof request.id !== 'number' || typeof request.method !== 'string') return;
    requests.push({ method: request.method, params: request.params ?? {} });
    if (request.method === failure.method) {
      if (!failure.timeout) socket.send(JSON.stringify({ id: request.id, error: failure.error }));
      return;
    }
    if (request.method === 'thread/turns/list') {
      socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: 'Method not found' } }));
      return;
    }
    const result = request.method === 'model/list' ? { data: [] }
      : request.method.startsWith('thread/') ? { thread: { id: sessionId, cwd: directory, status: { type: 'idle' }, turns: [], canAcceptDirectInput: true }, cwd: directory, model: 'model' }
      : {};
    socket.send(JSON.stringify({ id: request.id, result }));
  }));
  server.listen(socketPath);
  await once(server, 'listening');
  const provider = new CodexAppServerProvider({ connectionMode: 'shared', socketPath, requestTimeoutMs: 100 });
  return { provider, requests, async lookup(kind: Lookup) {
    if (kind === 'workspace') return provider.readSessionWorkspace(sessionId);
    if (kind === 'title') return provider.readSessionTitle(sessionId);
    const session = await provider.resumeSession({ providerId: 'codex', sessionId, opaque: '{}' });
    sessions.push(session);
    return session;
  } };
}

describe.skipIf(process.platform === 'win32')('native session lookup over a Unix WebSocket', () => {
  it.each([
    { lookup: 'workspace', method: 'thread/read', message: notLoaded },
    { lookup: 'title', method: 'thread/read', message: notLoaded },
    { lookup: 'resume', method: 'thread/resume', message: noRollout },
  ] as const)('reports confirmed unavailability while performing $lookup', async ({ lookup, method, message }) => {
    const native = await nativeServer({ method, error: { code: -32600, message } });
    const result = native.lookup(lookup);
    await expect(result).rejects.toBeInstanceOf(AgentRuntimeError);
    await expect(result).rejects.toMatchObject({ code: 'native_session_unavailable', message: expect.stringContaining('could not find this session') });
    expect(native.requests.some(request => request.method === 'turn/start' || request.method === 'thread/start')).toBe(false);
    if (lookup !== 'resume') {
      expect(native.requests.at(-1)).toEqual({ method, params: { threadId: sessionId, includeTurns: false } });
      expect(native.requests.some(request => request.method === 'thread/resume')).toBe(false);
    }
  }, 10_000);

  it.each([
    { lookup: 'workspace', method: 'thread/read', code: -32603, message: notLoaded },
    { lookup: 'workspace', method: 'thread/read', code: '-32600', message: notLoaded },
    { lookup: 'workspace', method: 'thread/read', code: -32600, message: 'thread not loaded: other-session' },
    { lookup: 'workspace', method: 'thread/read', code: -32600, message: `${notLoaded}; permission denied` },
    { lookup: 'workspace', method: 'thread/read', code: -32600, message: noRollout },
    { lookup: 'workspace', method: 'initialize', code: -32600, message: notLoaded },
    { lookup: 'resume', method: 'thread/resume', code: -32603, message: noRollout },
    { lookup: 'resume', method: 'thread/resume', code: -32600, message: 'no rollout found for thread id other-session' },
    { lookup: 'resume', method: 'thread/resume', code: -32600, message: notLoaded },
    { lookup: 'resume', method: 'initialize', code: -32600, message: noRollout },
    { lookup: 'resume', method: 'thread/turns/list', code: -32600, message: noRollout },
    { lookup: 'resume', method: 'thread/read', code: -32600, message: notLoaded },
  ] as const)('does not infer session loss from $lookup / $method / $code / $message', async ({ lookup, method, code, message }) => {
    const native = await nativeServer({ method, error: { code, message } });
    const result = native.lookup(lookup);
    await expect(result).rejects.toBeInstanceOf(CodexAppServerRpcError);
    await expect(result).rejects.toMatchObject({ code, message });
  }, 10_000);

  it('retains the metadata deadline classification without claiming session loss', async () => {
    const native = await nativeServer({ method: 'thread/read', timeout: true });
    await expect(native.lookup('workspace')).rejects.toMatchObject({ code: 'native_history_timeout' });
  }, 10_000);
});

it('does not classify a local error with native-looking text or fields as session loss', async () => {
  const failure = Object.assign(new Error(notLoaded), { name: 'CodexAppServerRpcError', code: -32600 });
  const provider = new CodexAppServerProvider({ spawn: async () => { throw failure; } });
  await expect(provider.readSessionWorkspace(sessionId)).rejects.toBe(failure);
}, 10_000);

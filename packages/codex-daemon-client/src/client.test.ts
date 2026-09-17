import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { CodexAppServerTransport, CodexDaemonClient } from '@agent-remote-controller/codex-daemon-client';
// The same application consumer runs against the packed artifact outside the workspace.
import { createNotebook } from '../examples/notebook.mjs';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0; });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'codex-client-'));
  const path = join(directory, 'daemon.sock');
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const sockets: WebSocket[] = [];
  const requests: Array<{ method: string; params: any; connection: number }> = [];
  const responses: unknown[] = [];
  let reads = 0;
  wss.on('connection', socket => {
    const connection = sockets.push(socket);
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.method === undefined) { responses.push(message); return; }
      if (message.id === undefined) return;
      requests.push({ ...message, connection });
      let result: unknown = {};
      if (message.method === 'thread/resume') result = { thread: { id: 'original' } };
      if (message.method === 'thread/read') {
        reads++;
        if (reads === 1) socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'original', itemId: 'item', delta: 'included' } }));
        result = { thread: { id: 'original', turns: [{ id: 'turn', items: [{ id: 'item', type: 'agentMessage', text: 'authoritative' }] }] } };
      }
      socket.send(JSON.stringify({ id: message.id, result }));
      if (message.method === 'thread/read' && reads === 2) socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'original', itemId: 'next', delta: '+tail' } }));
    });
  });
  server.listen(path);
  await once(server, 'listening');
  cleanups.push(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const connect = () => CodexAppServerTransport.connectShared(path, { requestTimeoutMs: 500 });
  return { connect, sockets, requests, responses };
}

it('recovers an independent application document using authoritative snapshots and ordered native deltas', async () => {
  const native = await fixture();
  const { client, notebook } = createNotebook(await native.connect(), native.connect, { initialDelayMs: 5, maximumDelayMs: 5 });
  cleanups.push(() => client.dispose());
  await client.initialize();
  client.registerRoot('original');
  await client.request('turn/start', { threadId: 'original', input: [] });
  native.sockets[0]!.terminate();
  await expect.poll(() => notebook.documents.get('original')).toBe('authoritative+tail');
  expect(notebook.messages).toEqual([
    { action: 'replace', document: 'original', text: 'authoritative' },
    { action: 'append', document: 'original', text: '+tail' },
  ]);
  expect(native.requests.filter(request => request.method === 'thread/resume').map(request => request.params.threadId)).toEqual(['original']);
  expect(native.requests.filter(request => request.method === 'thread/start')).toHaveLength(0);
  expect(native.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
  expect(native.requests.filter(request => request.method === 'initialize').map(request => request.params.clientInfo.name)).toEqual(['notebook', 'notebook']);
});

it('invalidates native requests itself and never delivers late answers on a replacement connection', async () => {
  const native = await fixture();
  const pending: Array<{ signal: AbortSignal; answer(value: unknown): void }> = [];
  const client = new CodexDaemonClient({
    transport: await native.connect(),
    initialization: { clientInfo: { name: 'independent', version: '1' } },
    recovery: { connect: native.connect, settings: { initialDelayMs: 5, maximumDelayMs: 5 } },
    callbacks: { onRequest: (_method, _params, _id, context) => new Promise(resolve => pending.push({ signal: context.signal, answer: resolve })) },
  });
  cleanups.push(() => client.dispose());
  await client.initialize();
  client.registerRoot('original');
  const ask = (socket: WebSocket, id: string) => socket.send(JSON.stringify({ id, method: 'item/tool/requestUserInput', params: { threadId: 'original' } }));
  ask(native.sockets[0]!, 'repeated');
  await expect.poll(() => pending.length).toBe(1);
  native.sockets[0]!.terminate();
  await expect.poll(() => native.sockets.length).toBe(2);
  await expect.poll(() => client.connectionInfo()?.state).toBe('connected');
  expect(pending[0]!.signal.aborted).toBe(true);
  ask(native.sockets[1]!, 'repeated');
  await expect.poll(() => pending.length).toBe(2);
  pending[0]!.answer({ old: true });
  pending[1]!.answer({ current: true });
  await expect.poll(() => native.responses.length).toBe(1);
  expect(native.responses).toEqual([{ id: 'repeated', result: { current: true } }]);
  ask(native.sockets[1]!, 'resolved');
  await expect.poll(() => pending.length).toBe(3);
  native.sockets[1]!.send(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 'original', requestId: 'resolved' } }));
  await expect.poll(() => pending[2]!.signal.aborted).toBe(true);
  pending[2]!.answer({ late: true });
  await client.request('thread/read', { threadId: 'original', includeTurns: false });
  expect(native.responses).toHaveLength(1);
});

it('cancels reconnect on disposal and closes a connection that completes after disposal', async () => {
  const native = await fixture();
  let finish!: (transport: CodexAppServerTransport) => void;
  let attempts = 0;
  const client = new CodexDaemonClient({
    transport: await native.connect(), initialization: { clientInfo: { name: 'disposal', version: '1' } },
    recovery: { connect: () => { attempts++; return new Promise(resolve => { finish = resolve; }); }, settings: { initialDelayMs: 5 } },
  });
  cleanups.push(() => client.dispose());
  client.registerRoot('original');
  native.sockets[0]!.terminate();
  await expect.poll(() => attempts).toBe(1);
  await client.dispose();
  const lateTransport = await native.connect();
  finish(lateTransport);
  await expect.poll(() => native.sockets[1]!.readyState).toBe(WebSocket.CLOSED);
  expect(attempts).toBe(1);
  expect(native.requests).toHaveLength(0);
  expect(() => client.request('thread/start')).toThrow('closed');
});

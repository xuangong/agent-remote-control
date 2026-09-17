import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { CodexAppServerTransport } from '@agent-remote-controller/codex-daemon-client';
import { createNotebook } from '../../examples/notebook.mjs';

test('packed client recovers an independent notebook over a Unix socket', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'packed-codex-socket-'));
  const path = join(directory, 'native.sock');
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const sockets = [];
  const requests = [];
  let client;
  let resolveRecovered;
  const recovered = new Promise(resolve => { resolveRecovered = resolve; });
  wss.on('connection', socket => {
    sockets.push(socket);
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.id === undefined || message.method === undefined) return;
      requests.push(message);
      let result = {};
      if (message.method === 'thread/resume') result = { thread: { id: 'saved' } };
      if (message.method === 'thread/read') result = { thread: { id: 'saved', turns: [{ items: [{ id: 'saved-item', text: 'restored' }] }] } };
      socket.send(JSON.stringify({ id: message.id, result }));
      if (message.method === 'thread/read') {
        socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'saved', itemId: 'tail', delta: ' and live' } }));
        resolveRecovered();
      }
    });
  });
  try {
    server.listen(path);
    await once(server, 'listening');
    const connect = () => CodexAppServerTransport.connectShared(path, { requestTimeoutMs: 500 });
    const consumer = createNotebook(await connect(), connect, { initialDelayMs: 5, maximumDelayMs: 5 });
    client = consumer.client;
    await client.initialize();
    client.registerRoot('saved');
    await client.request('turn/start', { threadId: 'saved', input: [] });
    sockets[0].terminate();
    await recovered;
    const deadline = Date.now() + 2000;
    while (consumer.notebook.documents.get('saved') !== 'restored and live') {
      if (Date.now() > deadline) throw new Error('Native recovery handoff was not applied');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.deepEqual(consumer.notebook.messages, [
      { action: 'replace', document: 'saved', text: 'restored' },
      { action: 'append', document: 'saved', text: ' and live' },
    ]);
    assert.equal(requests.filter(request => request.method === 'turn/start').length, 1);
    assert.equal(requests.filter(request => request.method === 'thread/start').length, 0);
    assert.deepEqual(requests.filter(request => request.method === 'thread/resume').map(request => request.params.threadId), ['saved']);
  } finally {
    await client?.dispose();
    for (const socket of sockets) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

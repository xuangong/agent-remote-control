import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { createHostBroker, memoryAttachmentStorage, PortableAttachmentStore, type RemoteHostBrokerState } from '@orchardworks/agent-relay-core';
import { createAgentRemoteRelay, createRemoteHostUplinkClient } from '@orchardworks/agent-session-runtime';
import { ATTACHMENT_CHUNK_BYTES, parseTaskInputs, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { botFiles } from './bot-files.js';
import { BotTools } from './bot-tools.js';

// The Controller's own uplink client, over a real loopback WebSocket, to the Relay's host broker with its file store: the bots' tools
// upload a file in chunks, a message carries it to another bot, and that bot downloads and verifies it.
const close: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); }, 5000);
const origin = 'https://relay.example';
const botId = (digit: string) => 'b_' + digit.repeat(32);
const groups = [{ window: { id: 'g', title: 'g', revision: 1, views: [['v1', 'chief'], ['v2', 'tracker']].map(([id, nativeSessionId]) => ({ id, placement: 'primary',
  binding: { hostId: 'host', providerId: 'codex', nativeSessionId, title: nativeSessionId } })) },
  bots: { rank: 'm', members: { v1: { botId: botId('1'), name: 'Chief' }, v2: { botId: botId('2'), name: 'Tracker' } } } }] as unknown as WindowGroup[];

/** A ws server socket as the Relay's socket port. */
function relaySocket(socket: WebSocket) {
  socket.on('error', () => undefined);
  return { get readyState() { return socket.readyState; }, get bufferedAmount() { return socket.bufferedAmount; }, send: (data: string) => socket.send(data), close: (code?: number, reason?: string) => socket.close(code, reason),
    onMessage: (listener: (data: string, binary: boolean) => void | Promise<void>) => { const receive = (data: import('ws').RawData, binary: boolean) => { void Promise.resolve(listener(data.toString(), binary)).catch(() => socket.close(1011)); }; socket.on('message', receive); return () => { socket.off('message', receive); }; },
    onClose: (listener: (details?: { code?: number }) => void) => { const closed = (code: number) => listener({ code }); socket.on('close', closed); return () => { socket.off('close', closed); }; },
    onError: (listener: (error: unknown) => void) => { socket.on('error', listener); return () => { socket.off('error', listener); }; } };
}

async function relayAndController() {
  let saved: RemoteHostBrokerState = { keys: [[createHash('sha256').update('key').digest('hex'), { kind: 'device', installationId: 'controller', expires: Number.MAX_SAFE_INTEGER }]],
    hosts: [{ id: 'host', installationId: 'controller', name: 'Host', legacyDsh: false, teamManagement: true, providers: [{ providerId: 'codex', displayName: 'Codex' }] }], bindings: [], creations: [], teams: [] };
  const broker = createHostBroker({ origin, assistantGroups: () => groups, initialState: saved, attachments: new PortableAttachmentStore(memoryAttachmentStorage()), heartbeatIntervalMs: 200, heartbeatTimeoutMs: 100,
    onStateChange: state => { saved = structuredClone(state); } });
  close.push(() => broker.close());
  const http = createServer((incoming, response) => { void (async () => {
    let body = ''; for await (const chunk of incoming) body += chunk;
    const result = await broker.handleRequest(new Request(origin + incoming.url, { method: incoming.method, headers: incoming.headers as Record<string, string>, ...(body ? { body } : {}) }));
    response.writeHead(result!.status, Object.fromEntries(result!.headers)); response.end(await result!.text());
  })().catch(error => { response.writeHead(500); response.end(String(error)); }); });
  http.listen(0, '127.0.0.1'); await once(http, 'listening', { signal: AbortSignal.timeout(3000) });
  const server = new WebSocketServer({ server: http });
  server.on('connection', async (socket, incoming) => {
    const upgrade = await broker.prepareUpgrade(new Request(origin + incoming.url, { headers: { authorization: 'Bearer key' } }));
    if (!upgrade || upgrade instanceof Response) { socket.close(); return; }
    upgrade.accept(relaySocket(socket));
  });
  close.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(done => server.close(() => done())); http.closeAllConnections(); await new Promise<void>(done => http.close(() => done())); });
  const relay = createAgentRemoteRelay({ providers: [] }); close.push(() => relay.close());
  const host = createRemoteHostUplinkClient({ relay, url: `ws://127.0.0.1:${(http.address() as { port: number }).port}/ws/remote-host`, installationId: 'controller', name: 'Host', remoteKey: 'key',
    teamManagement: true, tasks: true, coordinatorProviders: ['codex'], providers: [], resolveSession: () => undefined, control: () => ({ status: 200, body: '{}' }) });
  close.push(() => host.close()); await host.ready;
  return { host, state: () => saved };
}

it('moves a file between two bots through the Relay: uploaded in chunks, listed in the message, downloaded and verified', async () => {
  const { host, state } = await relayAndController();
  const directory = await mkdtemp(join(tmpdir(), 'bot-attachments-'));
  close.push(() => rm(directory, { recursive: true, force: true }));
  const bots = new BotTools({ request: call => host.teamRequest(call), tasks: () => host.tasks, files: botFiles(async () => directory, join(directory, 'downloads')) });
  const as = (nativeSessionId: string) => bots.namespace(() => ({ controllerId: 'controller', providerId: 'codex', nativeSessionId }), false).tools;
  const run = async (tools: ReturnType<typeof as>, name: string, args: object) => JSON.parse(await tools.find(tool => tool.name === name)!.execute(args) as string);
  const bytes = Buffer.alloc(ATTACHMENT_CHUNK_BYTES * 3 + 5);
  for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 7) % 251;
  await writeFile(join(directory, 'feature.bundle'), bytes);
  const sent = await run(as('chief'), 'message', { to: 'Tracker', text: 'The branch as a bundle.', attachments: [{ path: 'feature.bundle' }] });
  // Tracker's session is not connected, so the inbox holds the message for it; the file is in the Relay all the same.
  expect(sent).toMatchObject({ outcome: expect.stringMatching(/^(delivered|held)$/) });
  const inbox = state().teams!.find(team => team.inbox?.botId === botId('2'))!;
  const [message] = parseTaskInputs(inbox.messages.at(-1)!.text)!;
  const id = /^- (a_[0-9a-f]{32}) · feature\.bundle · application\/x-git-bundle/m.exec((message as { body: string }).body)![1]!;
  const got = await run(as('tracker'), 'download_attachment', { attachment: id });
  expect(got).toMatchObject({ byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), verified: true });
  expect(await readFile(got.path)).toEqual(bytes);
  // A file that was never uploaded is refused by the Relay, and a Relay without the file's bytes cannot be made to return another's.
  await expect(run(as('tracker'), 'download_attachment', { attachment: 'a_' + '0'.repeat(32) })).rejects.toThrow('no longer stored');
}, 10000);

import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { AgentProviderAdapter } from '@orchardworks/agent-provider-sdk';
import { createHostBroker, type HostBroker, type RelaySocket } from '@orchardworks/agent-relay-core';
import { MemoryJournalStore } from '@orchardworks/agent-remote-journal';
import { WebSocket, WebSocketServer } from 'ws';

import { createAgentHost, type AgentHostDirectory } from '../host.js';
import { NativeSessionOwnerError, type NativeOwnerIdentity } from '../native-session-owner.js';
import { boundary, item, ScriptedSession } from './journal-scripted-session.js';

export type Wire = Record<string, any>;
/** Polls on the wall clock until the read returns something; a deadline of four seconds, so a failure names what never happened. */
export async function until<T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 800; attempt++) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
export const SESSION = 'thread-1';
export const TERMINAL = '11111111-1111-4111-8111-111111111111';

/** One browser page of a session, over a real WebSocket to the Relay. */
export interface Page {
  frames: Wire[];
  send(fields: Wire): void;
  /** The next frame of the kind, removed from the page's queue. */
  take(match: (frame: Wire) => boolean, label: string): Promise<Wire>;
  closes: Array<{ code: number; reason: string }>;
  /** Negotiates and acquires control, as the client does; resolves with the token. */
  controlled(): Promise<string>;
  /** Sends a message with the token; the acknowledgement or refusal for the request. */
  sendText(token: string | undefined, requestId: string, text?: string): Promise<Wire>;
  close(): void;
}

/** A Relay (the hosted broker on a real HTTP server), a Controller (a real Host with a scripted provider) and the pages of one session. */
export async function startRelayAndController(options: { journalServed: boolean; /** Start no Controller; the test connects its own. */ withoutController?: true; /** Serves a page from the Relay's own origin, for a browser. */ page?: Record<string, { type: string; body: string | (() => string) }> }) {
  const closers: Array<() => Promise<void> | void> = [];
  const store = new MemoryJournalStore();
  const http: Server = createServer();
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const port = (http.address() as AddressInfo).port;
  const ORIGIN = `http://127.0.0.1:${port}`;
  const broker: HostBroker = createHostBroker({ origin: ORIGIN, rpcTimeoutMs: 1000, journals: store });
  closers.push(() => broker.close());
  const pairing = await broker.handleRequest(new Request(`${ORIGIN}/v1/remote/pairings`, { method: 'POST', body: '{}' }));
  const { key } = await pairing!.json() as { key: string };
  /** What the Relay wrote to Controllers, in order: the stream openings are counted from it. */
  const toController: Wire[] = [];
  const sockets = new WebSocketServer({ noServer: true });
  http.on('request', async (request, response) => {
    const served = options.page?.[(request.url ?? '').split('?')[0]!];
    if (served) { response.setHeader('content-type', served.type); response.end(typeof served.body === 'function' ? served.body() : served.body); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const result = await broker.handleRequest(new Request(`${ORIGIN}${request.url}`, { method: request.method, headers: { origin: ORIGIN, ...(request.headers['content-type'] ? { 'content-type': request.headers['content-type'] } : {}) }, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
    if (!result) { response.statusCode = 404; response.end(); return; }
    response.statusCode = result.status;
    result.headers.forEach((value, name) => response.setHeader(name, value));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  const refusals: number[] = [];
  http.on('upgrade', async (request, socket, head) => {
    const prepared = await broker.prepareUpgrade(new Request(`${ORIGIN}${request.url}`, { headers: { ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}), origin: ORIGIN } }));
    if (!prepared || prepared instanceof Response) {
      refusals.push(prepared instanceof Response ? prepared.status : 404);
      socket.write(`HTTP/1.1 ${prepared instanceof Response ? prepared.status : 404} Refused\r\ncontent-length: 0\r\n\r\n`);
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, ws => {
      const hostSide = request.url!.startsWith('/ws/remote-host');
      const relaySocket: RelaySocket = {
        get readyState() { return ws.readyState; }, get bufferedAmount() { return ws.bufferedAmount; },
        send: data => { if (hostSide) toController.push(JSON.parse(data)); ws.send(data); }, close: (code, reason) => ws.close(code, reason),
        onMessage(listener) { const receive = (data: import('ws').RawData, binary: boolean) => { void listener(data.toString(), binary); }; ws.on('message', receive); return () => { ws.off('message', receive); }; },
        onClose(listener) { ws.on('close', listener); return () => { ws.off('close', listener); }; },
        onError(listener) { ws.on('error', listener); return () => { ws.off('error', listener); }; },
      };
      prepared.accept(relaySocket);
    });
  });
  closers.push(async () => { for (const client of sockets.clients) client.terminate(); sockets.close(); http.close(); });

  /** What a terminal does to the session: it holds it natively, and the Controller is told to let go. */
  let terminalOwner: NativeOwnerIdentity | undefined;
  let handoff: ((nativeSessionId: string, next: NativeOwnerIdentity) => Promise<void>) | undefined;
  const sessions: ScriptedSession[] = [];
  const adapter: AgentProviderAdapter = {
    descriptor: { providerId: 'fake', displayName: 'Fake' },
    ...(options.journalServed ? { journal: { itemIdentity: 1 as const } } : {}),
    async createSession() { throw new Error('The Host supplies directory sessions.'); },
    async resumeSession() { throw new Error('The Host supplies directory sessions.'); },
  };
  const directory: AgentHostDirectory = {
    providerId: 'fake', list: async () => [], workspaces: async () => [], create: async () => SESSION,
    canReleaseSession: () => true,
    setSessionHandoffHandler(handler) { handoff = handler; },
    async open(nativeSessionId, openOptions) {
      if (terminalOwner) {
        if (openOptions?.takeOver === undefined) throw new NativeSessionOwnerError('native_session_owned', 'A terminal holds this session.', terminalOwner);
        if (openOptions.takeOver !== terminalOwner.generation) throw new NativeSessionOwnerError('native_owner_changed', 'The owner changed.', terminalOwner);
        terminalOwner = undefined;
      }
      const session = new ScriptedSession('fake', nativeSessionId, [item('history', 'm1', 'Hello'), boundary()]);
      sessions.push(session);
      return session;
    },
    async close() { await Promise.all(sessions.map(session => session.dispose())); },
  };
  let host: ReturnType<typeof createAgentHost> | undefined;
  /** Starts (or restarts) the Controller. */
  async function startController() {
    host = createAgentHost({ registrations: [{ adapter, directory }], installationId: 'relay-session-control', name: 'Host',
      uplink: { url: `ws://127.0.0.1:${port}/ws/remote-host`, remoteKey: key } });
    closers.push(() => host?.close());
    return (await host.ready).hostId;
  }
  const hostId = options.withoutController ? '' : await startController();

  const attach = async (takeOver?: string) => {
    const response = await broker.handleRequest(new Request(`${ORIGIN}/v1/remote/hosts/${hostId}/attach`, { method: 'POST', body: JSON.stringify({ providerId: 'fake', nativeSessionId: SESSION, ...(takeOver === undefined ? {} : { takeOver }) }) }));
    return { status: response!.status, body: await response!.json() as Wire };
  };
  const first = options.withoutController ? { status: 200, body: {} as Wire } : await attach();
  if (first.status !== 200) throw new Error(`The session did not attach: ${JSON.stringify(first.body)}`);
  const agentId = first.body.agentId as string;
  if (options.journalServed) {
    const enabled = await broker.handleRequest(new Request(`${ORIGIN}/v1/remote/hosts/${hostId}/smart-reading`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ providerId: 'fake', enabled: true }) }));
    if (enabled?.status !== 200) throw new Error('Smart reading did not turn on.');
    await until(async () => (await store.load(`${hostId}:fake:${SESSION}`))?.meta !== undefined, 'the journal');
    await new Promise(resolve => setTimeout(resolve, 150));
  }

  const hostsOnline = async (): Promise<boolean> => (await (await broker.handleRequest(new Request(`${ORIGIN}/v1/remote/hosts`)))!.json() as Wire).hosts[0].online;

  /** Opens a page: a real WebSocket to the session's event stream. */
  let operations = 0;
  function openPage(): Promise<Page> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/sessions/${agentId}/events`, { headers: { origin: ORIGIN } });
      const frames: Wire[] = [];
      const pending: Wire[] = [];
      const closes: Array<{ code: number; reason: string }> = [];
      ws.on('message', data => { const frame = JSON.parse(data.toString()); frames.push(frame); pending.push(frame); });
      ws.on('close', (code, reason) => closes.push({ code, reason: reason.toString() }));
      ws.on('unexpected-response', (_request, response) => reject(new Error(`Session stream rejected: ${response.statusCode}`)));
      ws.on('error', () => undefined);
      closers.push(() => ws.terminate());
      const send = (fields: Wire) => ws.send(JSON.stringify({ protocolVersion: '1.8.0', ...fields }));
      const take = (match: (frame: Wire) => boolean, label: string) => until(() => { const at = pending.findIndex(match); return at < 0 ? undefined : pending.splice(at, 1)[0]; }, label);
      const page: Page = {
        frames, send, take, closes,
        async controlled() {
          send({ type: 'negotiate' });
          const announced = await take(frame => frame.type === 'session_control', 'the control state');
          send({ type: 'session_control_request', payload: { agentId, requestId: 'acquire', revision: announced.payload.revision, action: 'acquire' } });
          const granted = await take(frame => frame.type === 'session_control' && frame.payload.requestId === 'acquire', 'control');
          return granted.payload.token as string;
        },
        async sendText(token, requestId, text = 'Hi') {
          send({ type: 'send_message', ...(token === undefined ? {} : { controlToken: token }), payload: { agentId, requestId, operationId: `00000000-0000-4000-8000-${String(++operations).padStart(12, '0')}`, text } });
          return take(frame => frame.payload?.requestId === requestId && (frame.type === 'command_acknowledged' || frame.type === 'protocol_error'), `the answer to ${requestId}`);
        },
        close: () => ws.close(),
      };
      ws.on('open', () => resolve(page));
    });
  }

  return {
    /** The Relay's request handler: what a test sends to the Relay beside its pages. */
    broker: broker as { handleRequest(request: Request): Promise<Response | undefined> }, hostId, agentId, port, origin: ORIGIN, pairingKey: key as string, sessions, openPage, attach, toController, refusals, directory,
    /** How many Controller streams the Relay opened for sessions, so far. */
    streamOpens: () => toController.filter(message => message.type === 'stream_open').length,
    /** A terminal takes the session: the Controller records the owner and lets the session go. */
    async terminalTakes(generation = TERMINAL) {
      terminalOwner = { kind: 'native_cli', generation };
      await handoff!(SESSION, terminalOwner);
    },
    /** The terminal exits without telling anyone. */
    terminalExits() { terminalOwner = undefined; },
    /** Stops the Controller and waits until the Relay knows the Host is offline. */
    async stopController() {
      await host?.close(); host = undefined;
      await until(async () => (await hostsOnline()) === false ? true : undefined, 'the Host to be offline');
    },
    hostsOnline,
    startController,
    async dispose() { for (const close of closers.splice(0).reverse()) await close(); },
  };
}
export type Relay = Awaited<ReturnType<typeof startRelayAndController>>;

/**
 * A Controller from before session control moved to the Relay, as the Relay sees it: it registers without offering `control`,
 * answers heartbeats and the management requests of the Relay, and speaks the older session wire when it is given a stream.
 */
export async function connectLegacyController(relay: Relay) {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/ws/remote-host`, { headers: { authorization: `Bearer ${relay.pairingKey}` } });
  const received: Wire[] = [];
  const requests: string[] = [];
  const registered = new Promise<Wire>(resolve => {
    ws.on('message', data => {
      const message = JSON.parse(data.toString());
      received.push(message);
      if (message.type === 'registered') resolve(message);
      if (message.type === 'heartbeat') ws.send(JSON.stringify({ uplinkVersion: 2, type: 'heartbeat_ack', nonce: message.nonce }));
      if (message.type === 'rpc_request') {
        requests.push(`${message.method} ${message.path}`);
        const body = message.path === '/remote/controller-update' ? { status: 'idle', current: '0.2.80' }
          : message.path === '/remote/attach' ? { agentId: message.sessionId, nativeSessionId: JSON.parse(message.body).nativeSessionId } : {};
        ws.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: 200, body: JSON.stringify(body) }));
      }
    });
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'legacy-controller', name: 'Legacy Host',
    controller: { version: '0.2.80', revision: 'a'.repeat(40), platform: 'darwin', arch: 'arm64', nodeMajor: 22, remoteUpdate: true },
    providers: [{ providerId: 'fake', displayName: 'Fake' }] }));
  const reply = await registered;
  return { reply, received, requests, close: () => ws.terminate() };
}

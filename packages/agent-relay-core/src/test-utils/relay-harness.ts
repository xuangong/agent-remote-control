import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterEach, expect, vi } from 'vitest';

import { createHostedRelay } from '../gateway.js';
import type { RelaySocket } from '../transport.js';
import { MemoryRelayStateStore } from '../testing.js';
import type { RelayScheduler } from '../scheduler.js';

export const origin = 'https://relay.example';
export const issuer = 'https://gateway.example';
export const secret = 'relay-harness-secret-01234567890123456789';

const sign = (type: string, claims: Record<string, unknown>) => {
  const input = [{ alg: 'HS256', typ: type }, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return input + '.' + createHmac('sha256', secret).update(input).digest('base64url');
};

/** A socket as a browser or Controller sees it: `addEventListener('message')` gets `{ data }`, and `send` takes the frame as text. */
class PeerSocket {
  readyState = 1;
  readonly messages: any[] = [];
  closeEvent?: { code: number; reason: string };
  private readonly listeners = new Map<string, Set<(event: any) => void>>();
  constructor(private readonly toRelay: (data: string) => void, private readonly closePeer: (code?: number, reason?: string) => void) {}
  /** Frames that arrived while no `message` listener was attached; a listener added later receives them in order, so a test never misses a frame sent as the socket opened. */
  private pending: string[] = [];
  addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean }) {
    const wrapped = options?.once ? (event: any) => { this.removeEventListener(type, wrapped); listener(event); } : listener;
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(wrapped);
    if (type === 'message' && this.pending.length > 0) queueMicrotask(() => this.flush());
  }
  removeEventListener(type: string, listener: (event: any) => void) { this.listeners.get(type)?.delete(listener); }
  private flush() {
    while (this.pending.length > 0 && (this.listeners.get('message')?.size ?? 0) > 0) {
      const data = this.pending.shift()!;
      for (const listener of [...this.listeners.get('message')!]) listener({ data });
    }
  }
  send(data: string) { if (this.readyState !== 1) throw new Error('Socket is closed'); this.toRelay(data); }
  close(code = 1000, reason = '') { if (this.readyState !== 1) return; this.readyState = 3; this.closePeer(code, reason); this.deliverClose(code, reason); }
  deliver(data: string) { if (this.readyState !== 1) return; this.messages.push(JSON.parse(data)); this.pending.push(data); this.flush(); }
  deliverClose(code: number, reason: string) { this.readyState = 3; this.closeEvent = { code, reason }; for (const listener of [...(this.listeners.get('close') ?? [])]) listener({ code, reason }); }
}

/** The Relay's end of a socket pair, with the peer's end. Frames cross in a microtask, as they do between runtimes. */
function socketPair() {
  const messages = new Set<(data: string, binary: boolean) => void | Promise<void>>();
  const closes = new Set<(details?: { code: number; wasClean?: boolean }) => void>();
  const server: RelaySocket & { drop(): void } = {
    readyState: 1, bufferedAmount: 0,
    send(data: string) { if (server.readyState !== 1) throw new Error('Socket is closed'); queueMicrotask(() => peer.deliver(data)); },
    close(code?: number, reason?: string) { if (server.readyState !== 1) return; server.readyState = 3; for (const listener of closes) listener(); peer.deliverClose(code ?? 1000, reason ?? ''); },
    onMessage(listener) { messages.add(listener); return () => { messages.delete(listener); }; },
    onClose(listener) { closes.add(listener); return () => { closes.delete(listener); }; },
    onError() { return () => {}; },
    drop() { if (server.readyState !== 1) return; server.readyState = 3; for (const listener of closes) listener(); },
  };
  const peer = new PeerSocket(
    data => queueMicrotask(() => { for (const listener of messages) void listener(data, false); }),
    (code) => { if (server.readyState !== 1) return; server.readyState = 3; for (const listener of closes) listener({ code, wasClean: true }); });
  return { server, peer };
}

export const send = (socket: PeerSocket, data: object) => socket.send(JSON.stringify({ uplinkVersion: 2, ...data }));
const nextMessage = (socket: PeerSocket): Promise<any> => new Promise(resolve => socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true }));
/** The next `message` frame, parsed, or the next `close` event of a socket. */
export const event = (socket: PeerSocket, type: 'message' | 'close'): Promise<any> => type === 'message' ? nextMessage(socket)
  : new Promise(resolve => socket.addEventListener('close', value => resolve(value), { once: true }));

/** Waits, in steps of a millisecond, until `read` returns something other than undefined or false; names `label` when it never does. */
export async function until<T>(read: () => T | undefined | false, label: string, deadlineMs = 2000): Promise<T> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

/**
 * The hosted Relay with its real routes, session channels and Host uplink, over a memory state store and in-memory sockets,
 * with the sign-in authority stubbed. It offers what a test of a Relay rule through HTTP and sockets needs: `login`, `json`,
 * `upgrade`, `host`, `control` and `restart`, which starts the Relay again over the state it committed.
 */
export async function startRelayHarness(options: { store?: MemoryRelayStateStore; configure?: Partial<Parameters<typeof createHostedRelay>[0]> } = {}) {
  const store = options.store ?? new MemoryRelayStateStore();
  const scheduler: RelayScheduler = { schedule() {}, cancel() {} };
  const sockets: Array<{ peer: PeerSocket; server: RelaySocket }> = [];
  let relay = createHostedRelay({ origin, issuer, secret, scheduler, storage: store.reopen(), ...options.configure });
  // The sign-in authority: it confirms every renewal.
  const authorityFetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(issuer + '/api/agent-remote/')) return new Response('Unexpected request', { status: 400 });
    const body = JSON.parse(String(init?.body ?? '{}'));
    const subject = body.subject ?? body.continuation;
    return Response.json({ active: true, subject, authenticatedAt: Date.now(), expiresAt: Date.now() + 3_600_000, validUntil: Date.now() + 120_000 });
  });
  vi.stubGlobal('fetch', authorityFetch);

  const request = async (path: string, init: RequestInit = {}) => (await relay.fetch(new Request(origin + path, { ...init, redirect: 'manual' }))) ?? new Response(null, { status: 404 });
  const json = (path: string, cookie: string, body?: object, method = body ? 'POST' : 'GET') => request(path, {
    method, headers: { origin, cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

  async function login(subject: string, browserCookie = '') {
    const begin = await request('/auth/login');
    expect(begin.status).toBe(303);
    const loginCookie = begin.headers.get('set-cookie')!.split(';')[0]!;
    const nonce = new URL(begin.headers.get('location')!).searchParams.get('challenge');
    const iat = Math.floor(Date.now() / 1000);
    const ticket = sign('arc-relay+jwt', { iss: issuer, aud: origin, sub: subject, nonce, iat, exp: iat + 900, jti: randomUUID(), continuation: subject, sessionExpiresAt: Date.now() + 3_600_000 });
    const response = await json('/auth/session', [loginCookie, browserCookie].filter(Boolean).join('; '), { ticket });
    expect(response.status, await response.clone().text()).toBe(200);
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('__Host-arc_session='))!.split(';')[0]!;
    return { cookie, ...await response.json() as { basePath: string } };
  }
  type Account = Awaited<ReturnType<typeof login>>;

  async function upgrade(path: string, headers: Record<string, string>) {
    if (path.startsWith('/ws/remote-host') && !path.includes('control=1')) path += `${path.includes('?') ? '&' : '?'}control=1`;
    const prepared = await relay.prepareUpgrade(new Request(origin + path, { headers: { ...headers, upgrade: 'websocket' } }));
    if (!prepared || prepared instanceof Response) throw new Error(`The upgrade of ${path} was refused with ${prepared instanceof Response ? prepared.status : 'no answer'}.`, { cause: prepared });
    const { server, peer } = socketPair();
    prepared.accept(server);
    sockets.push({ peer, server });
    return peer;
  }
  /** Listens on a session channel of the account and keeps every frame it receives. */
  async function listen(account: Account, query: string) {
    const socket = await upgrade(account.basePath + `v1/session-channel?${query}`, { cookie: account.cookie, origin });
    return { socket, messages: socket.messages, of: (type: string) => socket.messages.filter(message => message.type === type) };
  }

  /** A Controller connected for the account: it registers with the features it names, rotates its pairing key and answers heartbeats. */
  async function host(key: string, promptEditing = false, controller?: Record<string, unknown>, sessionRename = false, daemonControl = false, providerId = 'codex', installationId = 'harness-host',
    tpmManagement = false, teamManagement = false, teamResources = false, teamRecipients = false) {
    const socket = await upgrade(teamManagement ? `/ws/remote-host?team=1${teamResources ? '&teamResources=1' : ''}${teamRecipients ? '&teamRecipients=1' : ''}` : '/ws/remote-host', { authorization: `Bearer ${key}` });
    const registered = nextMessage(socket);
    send(socket, { type: 'register', ...(controller ? { controller } : {}), ...(tpmManagement ? { tpmManagement: true } : {}), credentialRotation: true, installationId, name: 'Harness Host',
      providers: [{ providerId, displayName: providerId, ...(promptEditing ? { promptEditing: true } : {}), ...(sessionRename ? { sessionRename: true } : {}), ...(daemonControl ? { daemonControl: true } : {}) }] });
    let message = await registered;
    if (message.type === 'credential_issued') {
      key = message.credential;
      const saved = nextMessage(socket);
      send(socket, { type: 'credential_saved' });
      message = await saved;
    }
    expect(message.type).toBe('registered');
    socket.addEventListener('message', event => { const frame = JSON.parse(String(event.data)); if (frame.type === 'heartbeat') send(socket, { type: 'heartbeat_ack', nonce: frame.nonce }); });
    return { socket, hostId: message.hostId as string, key, registered: message as Record<string, any> };
  }
  function control(body: Record<string, unknown>) {
    const serialized = JSON.stringify(body); const iat = Math.floor(Date.now() / 1000);
    const token = sign('arc-gateway-service+jwt', { iss: issuer, aud: origin, op: 'control', bodyHash: createHash('sha256').update(serialized).digest('base64url'), iat, exp: iat + 60, jti: randomUUID() });
    return () => request('/gateway/control', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: serialized });
  }
  /** The few `inspect` calls the Worker fixture offers that a memory store can answer: failing and restoring the store's writes. */
  async function inspect(path: string) {
    if (path.startsWith('fail-commit')) store.breakStorage();
    else if (path === 'restore-commit') store.repairStorage();
    else return new Response('missing', { status: 404 });
    return new Response('ok');
  }
  /** `expect.poll` with a one millisecond interval: frames cross in microtasks, so a condition holds at once or within a few. */
  const poll = <T>(read: () => T) => expect.poll(read, { interval: 1, timeout: 2000 });
  async function restart() {
    for (const { server } of sockets.splice(0)) (server as RelaySocket & { drop(): void }).drop();
    await relay.close();
    relay = createHostedRelay({ origin, issuer, secret, scheduler, storage: store.reopen(), ...options.configure });
  }
  async function close() {
    for (const { server } of sockets.splice(0)) (server as RelaySocket & { drop(): void }).drop();
    await relay.close();
    vi.unstubAllGlobals();
  }
  return {
    store, request, json, login, upgrade, listen, host, control, inspect, poll, restart, close
  };
}
export type RelayHarness = Awaited<ReturnType<typeof startRelayHarness>>;
const started: RelayHarness[] = [];
afterEach(async () => { for (const harness of started.splice(0).reverse()) await harness.close(); });
/** A started harness that closes after the test, under the name the Worker fixture used, so a rule test reads the same at either end. */
export async function fixture(options: Parameters<typeof startRelayHarness>[0] = {}) {
  const harness = await startRelayHarness(options);
  started.push(harness);
  return harness;
}

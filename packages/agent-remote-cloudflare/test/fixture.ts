import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, type WebSocket } from 'miniflare';
import { afterEach, expect } from 'vitest';

export const origin = 'https://relay.example';
export const previewOrigin = origin;
export const issuer = 'https://gateway.example';
export const secret = 'workers-fixture-secret-01234567890123456789';
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
export function sign(type: string, claims: Record<string, unknown>) {
  const input = [{ alg: 'HS256', typ: type }, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return input + '.' + createHmac('sha256', secret).update(input).digest('base64url');
}
export function event(socket: WebSocket, type: 'message' | 'close'): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener(type, listener); reject(new Error(`Socket ${type} deadline exceeded`)); }, 5000);
    const listener = (event: any) => { clearTimeout(timer); resolve(type === 'message' ? JSON.parse(String(event.data)) : event); };
    socket.addEventListener(type, listener, { once: true });
  });
}
export const send = (socket: WebSocket, data: object) => socket.send(JSON.stringify({ uplinkVersion: 2, ...data }));

export async function fixture(options: { previewOrigin?: string; previewDomain?: string; controllerRelease?: Record<string, unknown> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'arc-workers-'));
  closers.push(() => rm(directory, { recursive: true, force: true }));
    const result = await build({ stdin: { contents: `
      import worker, { RelayObject } from './src/worker.ts';
      export class TestRelayObject extends RelayObject {
        constructor(ctx, env) { super(ctx, env); this.fixtureContext = ctx; }
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === '/_fixture/alarm') { await this.alarm(); return new Response('ok'); }
          if (path === '/_fixture/storage') return Response.json({ alarm: await this.fixtureContext.storage.getAlarm(),
            rows: this.fixtureContext.storage.sql.exec('SELECT kind, count(*) AS count FROM relay_records GROUP BY kind').toArray() });
          if (path === '/_fixture/alarm-set') { await this.fixtureContext.storage.setAlarm(Number(new URL(request.url).searchParams.get('at'))); return new Response('ok'); }
          if (path === '/_fixture/fail-commit') { const kind = new URL(request.url).searchParams.get("kind"); const table = kind === "favorites" ? "relay_favorites_trees" : "relay_records"; const condition = kind === "host" ? " WHEN NEW.kind = 'host'" : ""; this.fixtureContext.storage.sql.exec("CREATE TRIGGER fail_records BEFORE INSERT ON " + table + condition + " BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END"); return new Response('ok'); }
          if (path === '/_fixture/restore-commit') { this.fixtureContext.storage.sql.exec('DROP TRIGGER IF EXISTS fail_records'); return new Response('ok'); }
          return super.fetch(request);
        }
      }
      export default worker;
    `, resolveDir: process.cwd(), sourcefile: 'test-entry.ts', loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser',
      conditions: ['workerd', 'worker', 'import'], mainFields: ['browser', 'module', 'main'], external: ['node:*', 'cloudflare:*'], alias: { '@orchardworks/agent-remote-hosted': resolve('../agent-remote-hosted/src/index.ts') } });
  const script = result.outputFiles[0]!.text;
  let authenticatedAt = Date.now(); let authorityStatus = 200; let leaseMs = 120_000; let authorityCalls = 0;
  let ownerFailures = 0;
  let renewalDelayMs = 0, activeRenewals = 0, peakRenewals = 0;
  const authorityOperations: string[] = [];
  const sockets: WebSocket[] = [];
  let mf: Miniflare;
  let envSecret = secret;
  async function start() {
    mf = new Miniflare({ modules: true, script, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
      durableObjects: { RELAY: { className: 'TestRelayObject', useSQLite: true } }, durableObjectsPersist: join(directory, 'state'),
      bindings: { AGENT_REMOTE_RELAY_URL: origin, ...(options.previewDomain ? { AGENT_REMOTE_PREVIEW_DOMAIN: options.previewDomain } : {}), ...(options.previewOrigin ? { AGENT_REMOTE_PREVIEW_URL: options.previewOrigin } : {}), AGENT_REMOTE_ISSUER: issuer, AGENT_REMOTE_SIGNING_SECRET: envSecret },
      serviceBindings: { ASSETS: async request => new Response(new URL(request.url).pathname === '/index.html'
        ? '<!doctype html><html><head><title>Controller</title></head><body><script src="/assets/main.js"></script></body></html>' : 'asset',
      { headers: { 'content-type': new URL(request.url).pathname === '/index.html' ? 'text/html' : 'text/javascript' } }) },
      outboundService: async request => {
        if (options.controllerRelease && ['api.github.com', 'github.com'].includes(new URL(request.url).hostname)) {
          const manifest = options.controllerRelease;
          return Response.json(new URL(request.url).pathname.endsWith('controller-release.json') ? manifest : [{ tag_name: `controller-v${manifest.version}`, draft: false, prerelease: false, published_at: '2026-09-22', assets: [{ name: 'controller-release.json' }, { name: manifest.asset }] }]);
        }
        authorityCalls++;
        const operation = new URL(request.url).pathname.split('/').at(-1)!;
        authorityOperations.push(operation);
        if (operation === 'renew' && renewalDelayMs) {
          peakRenewals = Math.max(peakRenewals, ++activeRenewals);
          await new Promise(resolve => setTimeout(resolve, renewalDelayMs));
          activeRenewals--;
        }
        const body = await request.text(); const token = request.headers.get('authorization')?.slice(7) ?? '';
        const parts = token.split('.'); const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
        const valid = sign('arc-relay-service+jwt', claims) === token && claims.iss === origin && claims.aud === issuer &&
          claims.bodyHash === createHash('sha256').update(body).digest('base64url');
        if (!valid) return new Response('Invalid proof', { status: 401 });
        if (new URL(request.url).pathname.endsWith('/user-status') && ownerFailures > 0) {
          ownerFailures--; return new Response('Temporary authority failure', { status: 503 });
        }
        if (authorityStatus !== 200) return new Response('Unavailable', { status: authorityStatus });
        const value = JSON.parse(body); const subject = value.subject ?? value.continuation;
        return Response.json({ active: true, subject, authenticatedAt, expiresAt: Date.now() + 3_600_000, validUntil: Date.now() + leaseMs });
      },
    });
    await mf.ready;
  }
  await start();
  closers.push(async () => { for (const socket of sockets) { try { socket.close(); } catch { /* Socket was already closed during restart. */ } } await mf.dispose(); });
  const requestAt = (requestOrigin: string, path: string, init: RequestInit = {}) => mf.dispatchFetch(requestOrigin + path, { ...init, redirect: 'manual', signal: AbortSignal.timeout(5000) } as any);
  const request = (path: string, init: RequestInit = {}) => requestAt(origin, path, init);
  const previewRequest = (path: string, init: RequestInit = {}) => requestAt(options.previewOrigin ?? previewOrigin, path, init);
  const json = (path: string, cookie: string, body?: object, method = body ? 'POST' : 'GET') => request(path, {
    method, headers: { origin, cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  async function beginLogin(subject: string) {
    const begin = await request('/auth/login'); expect(begin.status).toBe(303);
    const loginCookie = begin.headers.get('set-cookie')!.split(';')[0]!;
    const nonce = new URL(begin.headers.get('location')!).searchParams.get('challenge');
    const iat = Math.floor(Date.now() / 1000);
    const ticket = sign('arc-relay+jwt', { iss: issuer, aud: origin, sub: subject, nonce, iat, exp: iat + 900, jti: randomUUID(), continuation: subject, sessionExpiresAt: Date.now() + 3_600_000 });
    return { ticket, loginCookie };
  }
  async function login(subject: string) {
    const { ticket, loginCookie } = await beginLogin(subject);
    const response = await json('/auth/session', loginCookie, { ticket }); expect(response.status, await response.clone().text()).toBe(200);
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('__Host-arc_session='))!.split(';')[0]!;
    return { cookie, ticket, loginCookie, ...await response.json() as { basePath: string } };
  }
  async function upgradeResponse(path: string, headers: Record<string, string>, requestOrigin = origin) {
    const response = await requestAt(requestOrigin, path, { headers: { ...headers, upgrade: 'websocket' } });
    expect(response.status).toBe(101); const socket = response.webSocket!; socket.accept(); sockets.push(socket); return { response, socket };
  }
  async function upgrade(path: string, headers: Record<string, string>, requestOrigin = origin) {
    return (await upgradeResponse(path, headers, requestOrigin)).socket;
  }
  async function host(key: string, promptEditing = false, controller?: Record<string, unknown>) {
    const socket = await upgrade('/ws/remote-host', { authorization: `Bearer ${key}` });
    const registered = event(socket, 'message'); send(socket, { type: 'register', ...(controller ? { controller } : {}), credentialRotation: true, installationId: 'workers-host', name: 'Workers Host', providers: [{ providerId: 'codex', displayName: 'Codex', ...(promptEditing ? { promptEditing: true } : {}) }] });
    let message = await registered;
    if (message.type === 'credential_issued') {
      key = message.credential; const saved = event(socket, 'message');
      send(socket, { type: 'credential_saved' }); message = await saved;
    }
    expect(message.type).toBe('registered');
    socket.addEventListener('message', event => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === 'heartbeat') send(socket, { type: 'heartbeat_ack', nonce: frame.nonce });
    });
    return { socket, hostId: message.hostId as string, tunnelToken: message.tunnelToken as string, key };
  }
  function control(body: Record<string, unknown>) {
    const serialized = JSON.stringify(body); const iat = Math.floor(Date.now() / 1000);
    const token = sign('arc-gateway-service+jwt', { iss: issuer, aud: origin, op: 'control', bodyHash: createHash('sha256').update(serialized).digest('base64url'), iat, exp: iat + 60, jti: randomUUID() });
    return () => request('/gateway/control', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: serialized });
  }
  return { requestAt, request, previewRequest, json, beginLogin, login, upgrade, upgradeResponse, host, control, directory,
    setAuthority(status: number, duration = 120_000) { authorityStatus = status; leaseMs = duration; },
    failOwnerChecks(count: number) { ownerFailures = count; },
    delayRenewals(ms: number) { renewalDelayMs = ms; peakRenewals = 0; authorityOperations.length = 0; },
    get peakRenewals() { return peakRenewals; },
    get authorityOperations() { return [...authorityOperations]; },
    setAuthenticatedAt(value: number) { authenticatedAt = value; },
    get authorityCalls() { return authorityCalls; },
    async inspect(path: string) { const namespace = await mf.getDurableObjectNamespace('RELAY'); return namespace.getByName('primary').fetch(origin + '/_fixture/' + path); },
    async restart(replacementSecret = secret) { await mf.dispose(); envSecret = replacementSecret; await start(); },
  };
}

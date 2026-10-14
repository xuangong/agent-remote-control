import { createHash, createHmac, generateKeyPairSync, randomUUID, sign as rsaSign } from 'node:crypto';
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
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); }, 30000);
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

export async function fixture(options: { actualEntry?: true; completeCodec?: true; authProvider?: 'google'; previewOrigin?: string; previewDomain?: string; controllerRelease?: Record<string, unknown>; controllerBridge?: Record<string, unknown>; controllerBridges?: Record<string, unknown>[]; workerVersionId?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'arc-workers-'));
  closers.push(() => rm(directory, { recursive: true, force: true }));
    const result = await build({ stdin: { contents: options.actualEntry ? `export { default, RelayObject } from './src/worker.ts';` : `
      import { createHash } from 'node:crypto';
      import worker, { RelayObject } from './src/worker.ts';
      import { SqliteRelayStore } from './src/storage.ts';
      import { createHostedRelay } from '@orchardworks/agent-remote-hosted';
      import { WorkerRelaySocket } from './src/socket.ts';
      export class TestRelayObject extends RelayObject {
        constructor(ctx, env) { super(ctx, env); this.fixtureContext = ctx; this.fixtureEnv = env;
          this.completeCodec = ${options.completeCodec === true};
          if (this.completeCodec) this.fixtureReady = ctx.blockConcurrencyWhile(async () => this.reopenCodec());
        }
        reopenCodec() {
          const auth = { origin: this.fixtureEnv.AGENT_REMOTE_RELAY_URL, issuer: this.fixtureEnv.AGENT_REMOTE_ISSUER, secret: this.fixtureEnv.AGENT_REMOTE_SIGNING_SECRET };
          this.fixtureCodec = new SqliteRelayStore(this.fixtureContext.storage, auth);
          this.fixtureCore = createHostedRelay({ ...auth, storage: this.fixtureCodec, successionEnrollment: true, scheduler: { schedule() {}, cancel() {} } });
        }
        async fetch(request) {
          await this.fixtureReady;
          const path = new URL(request.url).pathname;
          if (this.completeCodec && path === '/_fixture/codec/seed') {
            try { await this.fixtureCodec.commit(await request.json()); await this.fixtureCore.close(); this.reopenCodec(); return new Response('ok'); }
            catch (error) { return new Response(String(error), { status: 500 }); }
          }
          if (this.completeCodec && path === '/_fixture/codec/snapshot') {
            const auth = { origin: this.fixtureEnv.AGENT_REMOTE_RELAY_URL, issuer: this.fixtureEnv.AGENT_REMOTE_ISSUER, secret: this.fixtureEnv.AGENT_REMOTE_SIGNING_SECRET };
            return Response.json(new SqliteRelayStore(this.fixtureContext.storage, auth).initial);
          }
          if (path === '/_fixture/codec/physical') return Response.json({
            metadata: this.fixtureContext.storage.sql.exec('SELECT * FROM relay_metadata').toArray(),
            manifests: this.fixtureContext.storage.sql.exec('SELECT * FROM relay_snapshot_manifests ORDER BY kind, identity').toArray(),
            chunks: this.fixtureContext.storage.sql.exec('SELECT kind, identity, ordinal, typeof(bytes) AS type, length(bytes) AS size FROM relay_snapshot_chunks ORDER BY kind, identity, ordinal').toArray(),
            chunkDigests: this.fixtureContext.storage.sql.exec('SELECT kind, identity, ordinal, bytes FROM relay_snapshot_chunks ORDER BY kind, identity, ordinal').toArray()
              .map(row => ({ kind: row.kind, identity: row.identity, ordinal: row.ordinal, digest: createHash('sha256').update(new Uint8Array(row.bytes)).digest('hex') })),
            blob: this.fixtureContext.storage.sql.exec('SELECT bytes FROM relay_snapshot_chunks LIMIT 1').toArray().map(row => ({ arrayBuffer: row.bytes instanceof ArrayBuffer, size: row.bytes.byteLength, prefix: Array.from(new Uint8Array(row.bytes).slice(0, 16)) }))
          });
          if (path === '/_fixture/alarm') { await this.alarm(); return new Response('ok'); }
          if (path === '/_fixture/storage') return Response.json({ alarm: await this.fixtureContext.storage.getAlarm(),
            rows: this.fixtureContext.storage.sql.exec('SELECT kind, count(*) AS count FROM (SELECT kind FROM relay_records UNION ALL SELECT kind FROM relay_snapshot_manifests) GROUP BY kind ORDER BY kind').toArray() });
          if (path === '/_fixture/alarm-set') { await this.fixtureContext.storage.setAlarm(Number(new URL(request.url).searchParams.get('at'))); return new Response('ok'); }
          if (path === '/_fixture/fail-commit') { const kind = new URL(request.url).searchParams.get("kind");
            const condition = kind === 'favorites' ? " WHEN NEW.kind = 'favoritesTree'" : kind === 'host' ? " WHEN NEW.kind = 'host'" : kind === 'progress' ? " WHEN NEW.kind = 'favoritesReceipt'" : '';
            this.fixtureContext.storage.sql.exec("CREATE TRIGGER fail_records BEFORE INSERT ON relay_snapshot_manifests" + condition + " BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END"); return new Response('ok'); }
          if (path === '/_fixture/restore-commit') { this.fixtureContext.storage.sql.exec('DROP TRIGGER IF EXISTS fail_records'); return new Response('ok'); }
          if (this.completeCodec) {
            if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
              const prepared = await this.fixtureCore.prepareUpgrade(request);
              if (prepared instanceof Response) return prepared;
              if (!prepared) return new Response(null, { status: 404 });
              const pair = new WebSocketPair(); pair[1].accept(); prepared.accept(new WorkerRelaySocket(pair[1], this.fixtureContext));
              return new Response(null, { status: 101, webSocket: pair[0] });
            }
            return await this.fixtureCore.fetch(request) ?? new Response(null, { status: 404 });
          }
          return super.fetch(request);
        }
      }
      export default worker;
    `, resolveDir: process.cwd(), sourcefile: 'test-entry.ts', loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser',
      conditions: ['workerd', 'worker', 'import'], mainFields: ['browser', 'module', 'main'], external: ['node:*', 'cloudflare:*'], alias: {
        '@orchardworks/agent-remote-hosted/host-recovery': resolve('../agent-remote-hosted/src/host-recovery.ts'),
        '@orchardworks/agent-remote-hosted': resolve('../agent-remote-hosted/src/index.ts') } });
  const script = result.outputFiles[0]!.text;
  let authenticatedAt = Date.now(); let authorityStatus = 200; let leaseMs = 120_000; let authorityCalls = 0;
  let ownerFailures = 0;
  let renewalDelayMs = 0, activeRenewals = 0, peakRenewals = 0;
  const authorityOperations: string[] = [];
  const sockets: WebSocket[] = [];
  let mf: Miniflare;
  let envSecret = secret;
  let googleClientId = 'workers-client';
  let googleEmails = 'owner@example.com';
  const googleKeys = options.authProvider === 'google' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : undefined;
  const googleCodes = new Map<string, { nonce: string; challenge: string; redirect: string }>();
  async function start() {
    mf = new Miniflare({ modules: true, script, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
      durableObjects: { RELAY: { className: options.actualEntry ? 'RelayObject' : 'TestRelayObject', useSQLite: true } }, durableObjectsPersist: join(directory, 'state'),
      bindings: { ...(options.workerVersionId ? { CF_VERSION_METADATA: { id: options.workerVersionId } } : {}), AGENT_REMOTE_RELAY_URL: origin, ...(options.previewDomain ? { AGENT_REMOTE_PREVIEW_DOMAIN: options.previewDomain } : {}), ...(options.previewOrigin ? { AGENT_REMOTE_PREVIEW_URL: options.previewOrigin } : {}), ...(options.authProvider === 'google' ? {
        AGENT_REMOTE_AUTH_PROVIDER: 'google', AGENT_REMOTE_GOOGLE_CLIENT_ID: googleClientId, AGENT_REMOTE_GOOGLE_CLIENT_SECRET: 'workers-client-secret', AGENT_REMOTE_GOOGLE_ALLOWED_EMAILS: googleEmails,
      } : { AGENT_REMOTE_ISSUER: issuer }), AGENT_REMOTE_SIGNING_SECRET: envSecret },
      serviceBindings: { ASSETS: async request => new Response(new URL(request.url).pathname === '/index.html'
        ? '<!doctype html><html><head><title>Controller</title></head><body><script src="/assets/main.js"></script></body></html>' : 'asset',
      { headers: { 'content-type': new URL(request.url).pathname === '/index.html' ? 'text/html' : 'text/javascript' } }) },
      outboundService: async request => {
        if (googleKeys) {
          const url = new URL(request.url);
          if (url.href === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [{ ...googleKeys.publicKey.export({ format: 'jwk' }), kid: 'workers-fixture', alg: 'RS256', use: 'sig' }] });
          if (url.href !== 'https://oauth2.googleapis.com/token') return new Response('Unexpected Google endpoint', { status: 400 });
          const input = new URLSearchParams(await request.text()); const code = input.get('code')!, grant = googleCodes.get(code); googleCodes.delete(code);
          if (!grant || input.get('client_id') !== googleClientId || input.get('client_secret') !== 'workers-client-secret' || input.get('grant_type') !== 'authorization_code' || input.get('redirect_uri') !== grant.redirect || createHash('sha256').update(input.get('code_verifier') ?? '').digest('base64url') !== grant.challenge) return new Response('Invalid code exchange', { status: 400 });
          const now = Math.floor(Date.now() / 1000);
          const payload = [{ alg: 'RS256', kid: 'workers-fixture' }, { iss: 'https://accounts.google.com', aud: googleClientId, sub: 'owner', email: 'owner@example.com', email_verified: true, nonce: grant.nonce, iat: now, exp: now + 600 }]
            .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
          return Response.json({ id_token: payload + '.' + rsaSign('RSA-SHA256', Buffer.from(payload), googleKeys.privateKey).toString('base64url'), access_token: 'never-store-google-access-token' });
        }
        if (options.controllerRelease && ['api.github.com', 'github.com'].includes(new URL(request.url).hostname)) {
          const path = new URL(request.url).pathname;
          const candidates = [options.controllerRelease, ...(options.controllerBridge ? [options.controllerBridge] : []), ...(options.controllerBridges ?? [])];
          const entry = (manifest: Record<string, unknown>) => ({ tag_name: `controller-v${manifest.version}`, draft: false, prerelease: false, published_at: '2026-09-22', assets: [{ name: 'controller-release.json' }, { name: manifest.asset }] });
          const requested = /controller-v([^/]+)/.exec(path)?.[1];
          if (!requested) return Response.json(candidates.map(entry));
          const manifest = candidates.find(item => item.version === requested);
          if (!manifest) return new Response('Not found', { status: 404 });
          return Response.json(path.endsWith('controller-release.json') ? manifest : entry(manifest));
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
  async function beginGoogleLogin() {
    const response = await request('/auth/login?host=chosen-host'); expect(response.status).toBe(303);
    const destination = new URL(response.headers.get('location')!);
    expect(destination.origin).toBe('https://accounts.google.com');
    expect(destination.searchParams.get('client_id')).toBe(googleClientId);
    expect(destination.searchParams.get('code_challenge_method')).toBe('S256');
    const code = randomUUID(); googleCodes.set(code, { nonce: destination.searchParams.get('nonce')!, challenge: destination.searchParams.get('code_challenge')!, redirect: destination.searchParams.get('redirect_uri')! });
    const callback = new URL(destination.searchParams.get('redirect_uri')!); callback.searchParams.set('state', destination.searchParams.get('state')!); callback.searchParams.set('code', code);
    return { callback: callback.pathname + callback.search, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  }
  async function finishGoogleLogin(pending: Awaited<ReturnType<typeof beginGoogleLogin>>) {
    const callback = await request(pending.callback, { headers: { cookie: pending.cookie } }); expect(callback.status).toBe(303);
    const cookie = callback.headers.getSetCookie().filter(value => !value.includes('arc_login=')).map(value => value.split(';')[0]).join('; ');
    const status = await json('/auth/status', cookie); expect(status.status).toBe(200);
    return { cookie, ...await status.json() as { basePath: string; user: { id: string }; auth: object } };
  }
  async function beginLogin(subject: string) {
    const begin = await request('/auth/login'); expect(begin.status).toBe(303);
    const loginCookie = begin.headers.get('set-cookie')!.split(';')[0]!;
    const nonce = new URL(begin.headers.get('location')!).searchParams.get('challenge');
    const iat = Math.floor(Date.now() / 1000);
    const ticket = sign('arc-relay+jwt', { iss: issuer, aud: origin, sub: subject, nonce, iat, exp: iat + 900, jti: randomUUID(), continuation: subject, sessionExpiresAt: Date.now() + 3_600_000 });
    return { ticket, loginCookie };
  }
  async function login(subject: string, browserCookie = '') {
    const { ticket, loginCookie } = await beginLogin(subject);
    const response = await json('/auth/session', [loginCookie, browserCookie].filter(Boolean).join('; '), { ticket }); expect(response.status, await response.clone().text()).toBe(200);
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('__Host-arc_session='))!.split(';')[0]!;
    const browser = response.headers.getSetCookie().find(value => value.startsWith('__Host-arc_browser='))?.split(';')[0];
    return { cookie, browserCookie: browser, ticket, loginCookie, ...await response.json() as { basePath: string } };
  }
  async function upgradeResponse(path: string, headers: Record<string, string>, requestOrigin = origin) {
    const response = await requestAt(requestOrigin, path, { headers: { ...headers, upgrade: 'websocket' } });
    expect(response.status).toBe(101); const socket = response.webSocket!; socket.accept(); sockets.push(socket); return { response, socket };
  }
  async function upgrade(path: string, headers: Record<string, string>, requestOrigin = origin) {
    return (await upgradeResponse(path, headers, requestOrigin)).socket;
  }
  async function host(key: string, promptEditing = false, controller?: Record<string, unknown>, sessionRename = false, daemonControl = false, providerId = 'codex', installationId = 'workers-host', tpmManagement = false, teamManagement = false, teamResources = false) {
    const socket = await upgrade(teamManagement ? `/ws/remote-host?team=1${teamResources ? '&teamResources=1' : ''}` : '/ws/remote-host', { authorization: `Bearer ${key}` });
    const registered = event(socket, 'message'); send(socket, { type: 'register', ...(controller ? { controller } : {}), ...(tpmManagement ? { tpmManagement: true } : {}), credentialRotation: true, installationId, name: 'Workers Host', providers: [{ providerId, displayName: providerId, ...(promptEditing ? { promptEditing: true } : {}), ...(sessionRename ? { sessionRename: true } : {}), ...(daemonControl ? { daemonControl: true } : {}) }] });
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
    return { socket, hostId: message.hostId as string, tunnelToken: message.tunnelToken as string, key, teamResources: message.teamResources === true };
  }
  function control(body: Record<string, unknown>) {
    const serialized = JSON.stringify(body); const iat = Math.floor(Date.now() / 1000);
    const token = sign('arc-gateway-service+jwt', { iss: issuer, aud: origin, op: 'control', bodyHash: createHash('sha256').update(serialized).digest('base64url'), iat, exp: iat + 60, jti: randomUUID() });
    return () => request('/gateway/control', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: serialized });
  }
  return { requestAt, request, previewRequest, json, beginLogin, login, beginGoogleLogin, finishGoogleLogin, upgrade, upgradeResponse, host, control, directory,
    setGoogleConfig(clientId: string, allowedEmails = googleEmails) { googleClientId = clientId; googleEmails = allowedEmails; },
    setAuthority(status: number, duration = 120_000) { authorityStatus = status; leaseMs = duration; },
    failOwnerChecks(count: number) { ownerFailures = count; },
    delayRenewals(ms: number) { renewalDelayMs = ms; peakRenewals = 0; authorityOperations.length = 0; },
    get peakRenewals() { return peakRenewals; },
    get authorityOperations() { return [...authorityOperations]; },
    setAuthenticatedAt(value: number) { authenticatedAt = value; },
    get authorityCalls() { return authorityCalls; },
    async inspect(path: string, init?: RequestInit) { const namespace = await mf.getDurableObjectNamespace('RELAY'); return namespace.getByName('primary').fetch(origin + '/_fixture/' + path, { ...init, signal: AbortSignal.timeout(10000) } as any); },
    async restart(replacementSecret = secret) { await mf.dispose(); envSecret = replacementSecret; await start(); },
  };
}

import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, expect, vi } from 'vitest';
import { createGatewayRelay } from './gateway-relay.js';
import { createAgentHost } from '../../../agent-host/src/host.js';
import type { AgentSession, AgentProviderAdapter, ProviderStreamItem } from '@agent-remote-controller/agent-provider-sdk';

const secret = 'preview-test-only-secret-01234567890123456789';
const issuer = 'https://gateway.example';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function sign(aud: string, sub: string, nonce: string) {
  const iat = Math.floor(Date.now() / 1000);
  const content = [{ alg: 'HS256', typ: 'arc-relay+jwt' }, { iss: issuer, aud, sub, nonce, iat, exp: iat + 900, jti: crypto.randomUUID() }].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return content + '.' + createHmac('sha256', secret).update(content).digest('base64url');
}
class LocalSession implements AgentSession {
  constructor(private readonly cwd?: string) {}
  readonly providerId = 'fixture'; readonly nativeSessionId = 'native';
  readonly capabilities = { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
    interactions: { question: false, planApproval: false, toolApproval: false } };
  private release!: () => void;
  private readonly closed = new Promise<void>(resolve => { this.release = resolve; });
  async *observe(): AsyncIterable<ProviderStreamItem> { yield { type: 'history_boundary' }; await this.closed; }
  async runtimeInfo() { return { providerId: this.providerId, sessionId: this.nativeSessionId, status: 'idle' as const, cwd: this.cwd, persistence: { providerId: this.providerId, sessionId: this.nativeSessionId, opaque: '{}' } }; }
  async sendMessage() {} async respondToInteraction() {} async dispose() { this.release(); }
}
export async function previewFixture(options: { separateOrigin?: boolean; target?: string; pathMode?: 'strip' | 'preserve'; workspace?: string; servePage?: Parameters<typeof createGatewayRelay>[0]['servePage'] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'arc-preview-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const observed = { cancelledEvents: 0, cookies: [] as string[] };
  const local = createServer((request, response) => {
    observed.cookies.push(request.headers.cookie ?? '');
    if (request.url === '/static') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><img src="/bytes"></body></html>'); return; }
    if (request.url === '/style.css') { response.setHeader('content-type', 'text/css'); response.end('body{background:url(/bytes)}'); return; }
    if (request.url === '/redirect') { response.writeHead(302, { location: '/next?q=1', 'set-cookie': ['one=a; Path=/', 'two=b; Path=/; HttpOnly'] }); response.end(); return; }
    if (request.url === '/range') {
      if (request.headers['if-none-match'] === '"image-one"') { response.writeHead(304); response.end(); return; }
      response.writeHead(request.headers.range ? 206 : 200, { 'content-type': 'application/octet-stream', etag: '"image-one"', ...(request.headers.range ? { 'content-range': 'bytes 1-2/4' } : {}) }); response.end(request.headers.range ? Buffer.from([128, 255]) : Buffer.from([0,128,255,65])); return;
    }
    if (request.url === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: first\n\n');
      const timer = setTimeout(() => { response.end('data: second\n\n'); }, 400); response.once('close', () => { clearTimeout(timer); observed.cancelledEvents++; }); return;
    }
    if (request.url === '/echo') { request.pipe(response); return; }
    response.setHeader('content-type', 'application/octet-stream'); response.end(Buffer.from([0, 128, 255, 65]));
  });
  const appWs = new WebSocketServer({ server: local, handleProtocols: offered => offered.has('echo-v1') ? 'echo-v1' : false });
  appWs.on('connection', socket => socket.on('message', (data, binary) => socket.send(data, { binary })));
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { for (const socket of appWs.clients) socket.terminate(); await new Promise<void>(resolve => appWs.close(() => resolve())); local.closeAllConnections(); await new Promise<void>(resolve => local.close(() => resolve())); });
  const target = options.target ?? `http://127.0.0.1:${(local.address() as import('node:net').AddressInfo).port}`;
  const relay = createGatewayRelay({ origin: 'http://127.0.0.1:0', previewOrigin: options.separateOrigin ? 'http://localhost:0' : undefined, issuer, secret, servePage: options.servePage });
  const { url, port } = await relay.listen(0); cleanups.push(() => relay.close());
  const previewOrigin = options.separateOrigin ? `http://localhost:${port}` : url;
  async function login(subject: string) {
    const begin = await fetch(url + '/auth/login', { redirect: 'manual' });
    const cookie = begin.headers.getSetCookie()[0]!.split(';')[0]!;
    const nonce = new URL(begin.headers.get('location')!).searchParams.get('challenge')!;
    const response = await fetch(url + '/auth/session', { method: 'POST', headers: { cookie, origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: sign(url, subject, nonce) }) });
    expect(response.status).toBe(200);
    const sessionCookie = response.headers.getSetCookie()[0]!.split(';')[0]!;
    const { basePath } = await response.json() as { basePath: string };
    return { cookie: sessionCookie, basePath, request: (path: string, body?: unknown) => fetch(url + basePath + path, { headers: { cookie: sessionCookie, origin: url, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) }) };
  }
  const alice = await login('alice'); const bob = await login('bob');
  const { key } = await (await alice.request('v1/remote/pairings', {})).json() as { key: string };
  const session = new LocalSession(options.workspace);
  const adapter: AgentProviderAdapter = { descriptor: { providerId: 'fixture', displayName: 'Fixture' }, createSession: async () => session, resumeSession: async () => session };
  const host = createAgentHost({ installationId: 'preview-test', name: 'Preview host', preview: { stateDirectory: directory },
    registrations: [{ adapter, directory: { providerId: 'fixture', list: () => [], workspaces: () => [], create: async () => 'native', open: async () => session, close: () => session.dispose() } }],
    uplink: { url: url.replace('http:', 'ws:') + '/ws/remote-host', remoteKey: key } });
  cleanups.push(() => host.close());
  const { hostId } = await host.ready;
  const attached = await alice.request(`v1/remote/hosts/${hostId}/attach`, { providerId: 'fixture', nativeSessionId: 'native' });
  expect(attached.status).toBe(200);
  const { agentId } = await attached.json() as { agentId: string };
  const response = await alice.request(`v1/sessions/${agentId}/previews`, { target, itemId: 'message-1', pathMode: options.pathMode ?? 'strip' });
  expect(response.status).toBe(200);
  const { registration } = await response.json() as { registration: { id: string } };
  await vi.waitFor(async () => { const result = await (await alice.request(`v1/remote/hosts/${hostId}/previews`)).json(); expect(result.registrations[0].availability).toBe('online'); }, { timeout: 5000 });
  async function entryUrl(path: string) {
    const response = await alice.request(`v1/remote/hosts/${hostId}/previews/${registration.id}/open`, { url: target + path });
    expect(response.status).toBe(200);
    const { entryUrl } = await response.json() as { entryUrl: string };
    return entryUrl;
  }
  async function enter(path: string) {
    const link = await entryUrl(path);
    const redemption = await fetch(previewOrigin + '/_arc/enter', { method: 'POST', headers: { origin: previewOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ code: new URL(link).hash.slice(1) }) });
    expect(redemption.status).toBe(200);
    return redemption.headers.getSetCookie()[0]!.split(';')[0]!;
  }
  return { url, previewOrigin, target, registration, alice, bob, hostId, enter, entryUrl, host, port, agentId, observed };
}

export function onPreviewCleanup(close: () => Promise<unknown>): void { cleanups.push(close); }

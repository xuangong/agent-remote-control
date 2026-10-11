import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { PROTOCOL_VERSION, type ServerMessage } from '@orchardworks/agent-remote-protocol';
import type { BrowserContext } from '@playwright/test';
import type { AgentSession, AgentCapabilities, AgentSessionNativeEvidence, ProviderStreamItem, AgentInputAcceptance } from '@orchardworks/agent-provider-sdk';
import { serializeAgentPreparedTextInput, parseAgentPreparedTextInput } from '@orchardworks/agent-provider-sdk';
import { createHostedRelay, emptyRelayState, gatewayCookieName, type HostedRelayState } from '@orchardworks/agent-remote-hosted';
import { createRemoteHostUplinkClient } from '@orchardworks/agent-remote-relay';
import { createAgentHostRuntime } from '../../agent-host/src/host.js';
import { encodeSqlSnapshot, quoteSqlRecord, SQL_SNAPSHOT_FORMAT, SQL_RECORD_FORMAT, SQL_CHUNK_BYTES } from '../../agent-remote-cloudflare/src/storage-codec.js';
import { createGatewayStaticPages } from '../src/server/gateway-static.js';
import { relaySocket, webRequest, writeResponse } from '../src/server/remote-host-broker.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
class JoinedNative implements AgentSession {
  capabilities: AgentCapabilities = { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
    interactions: { question: false, toolApproval: false, planApproval: false } };
  sent: string[] = []; epoch = 0; preparations = 0; stop?: () => void;
  queue: ProviderStreamItem[] = []; closed = false; sequence = 0;
  constructor(readonly id: string, readonly cwd: string, private readonly omitDispatchAcceptance = false) {}
  async runtimeInfo() { return { providerId: 'fixture', sessionId: this.id, status: 'idle' as const, cwd: this.cwd, persistence: {providerId:'fixture',sessionId:this.id,opaque:'joined-fixture'} }; }
  async *observe(): AsyncIterable<ProviderStreamItem> {
    yield { type: 'observation', sourceKey: `history-${this.id}`, occurredAt: 1, delivery: 'history',
      event: { type: 'timeline', provider: 'fixture', item: { type: 'user_message', text: this.id === 'A' ? 'Original joined requirement' : `Native history ${this.id}` } } };
    yield { type: 'history_boundary' };
    while (!this.closed) {
      const item = this.queue.shift(); if (item) yield item;
      else await new Promise<void>(resolve => { this.stop = resolve; });
    }
  }
  emitInput(text: string) { this.queue.push({ type: 'observation', sourceKey: `live-${this.id}-${++this.sequence}`, occurredAt: Date.now(), delivery: 'live', event: { type: 'timeline', provider: 'fixture', item: { type: 'user_message', text } } }); this.stop?.(); }
  async sendMessage(text: string): Promise<AgentInputAcceptance> { this.sent.push(text); this.emitInput(text); return { disposition: 'started' }; }
  async respondToInteraction() {}
  async dispose() { this.closed = true; this.stop?.(); }
  nativeEvidence: AgentSessionNativeEvidence = {
    availability: () => ({ status: 'configured', version: 2 }),
    inspectReadiness: async () => ({ cwd: this.cwd, idle: true, pendingInputs: 0, pendingInteractions: 0, activeChildren: 0 }),
    captureValidity: () => ({ epoch: this.epoch }) as never,
    isCurrent: token => (token as unknown as { epoch: number }).epoch === this.epoch,
    prepareInput: async parts => {
      const text = (parts[0] as { text: string }).text;
      return parseAgentPreparedTextInput(serializeAgentPreparedTextInput({ version: 2, providerId: 'fixture', nativeSessionId: this.id,
        inputId: `${this.id}-U-${++this.preparations}`, cwd: this.cwd, authority: { kind: 'trusted-service', authorityId: 'joined', namespaceId: 'owned' },
        parts: [{ type: 'text', text }], content: { encoding: 'utf-8', bytes: Buffer.byteLength(text), sha256: hash(text) }, selections: { model: 'fixture/model' } }));
    },
    dispatchInput: async witness => {
      this.sent.push(witness.parts[0].text); this.emitInput(witness.parts[0].text); this.epoch++;
      if (!this.omitDispatchAcceptance) return { disposition: 'started' };
    },
    inspectInput: async witness => ({ status: 'materialized', execution: { disposition: 'started', nativeExecutionId: `${witness.inputId}-R` }, proof: { version: 2, providerId: 'fixture', nativeSessionId: this.id,
      inputId: witness.inputId, nativeInputId: witness.inputId, cwd: this.cwd, authority: witness.authority, witnessSha256: hash(serializeAgentPreparedTextInput(witness)),
      contentSha256: witness.content.sha256, nativeSelectionsSha256: hash(JSON.stringify(witness.selections)) } }),
  };
}

/** Real owned Host, enrollment/uplink, durable Gateway and App; native execution is fake. */
export async function joinedFixture(options: { omitDispatchAcceptance?: boolean; rejectFirstPreparation?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-joined-browser-')));
  const sessions = new Map(['A', 'S', 'T'].map(id => [id, new JoinedNative(id, root, options.omitDispatchAcceptance)]));
  const grants: Array<{ nativeSessionId: string; sourceNativeSessionId: string }> = [];
  let auxiliaryCreates = 0;
  let creates = 0, beforeCreate = async () => {}, dropCommit = false;
  let rejectProjection = options.rejectFirstPreparation === true;
  const makeHost = () => createAgentHostRuntime({ idleGraceMs: 20, executionPolicy: { defaultWorkspace: root, allowedWorkspaceRoots: [root], lockPermissions: false },
    succession: { controllerId: 'joined-controller', enrollment: true, stateDirectory: root },
    registrations: [{ adapter: { descriptor: { providerId: 'fixture', displayName: 'Joined provider', sessionExtensions: { instructions: true, tools: true } },
      nativeEvidence: { availability: () => ({ status: 'configured', version: 2 }), createEmpty: async () => {
        const id = String.fromCharCode(66 + creates++); await beforeCreate(); sessions.set(id, new JoinedNative(id, root, options.omitDispatchAcceptance));
        return { status: 'created' as const, handle: { providerId: 'fixture', sessionId: id, opaque: `joined-${id}` } };
      } }, createSession: async () => { throw new Error('Unexpected adapter create'); }, resumeSession: async () => { throw new Error('Unexpected adapter resume'); }, readSessionHistory: async () => ({ entries: [] }) },
      directory: { providerId: 'fixture', supportsSourceReferences: true, supportsBoundedSourceCreate: async () => true,
        list: () => [], workspaces: () => [], create: async config => {
          if (!config.sourceNativeSessionId) throw new Error('Unexpected directory create');
          const id = auxiliaryCreates++ === 0 ? 'S' : 'T';
          grants.push({ nativeSessionId: id, sourceNativeSessionId: config.sourceNativeSessionId }); return id;
        },
        open: async id => { const session = sessions.get(id); if (!session) throw new Error('Missing fixture native'); return session; },
        sessionWorkspace: async () => root, sourceReferences: async () => structuredClone(grants), setSourceBindingReader: () => {},
        close: async () => { for (const session of sessions.values()) await session.dispose(); } } }] });
  let host = makeHost();
  const authority = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += String(chunk);
    const input = JSON.parse(text), subject = input.subject ?? input.continuation;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ active: true, subject, authenticatedAt: Date.now(), validUntil: Date.now() + 60000, expiresAt: Date.now() + 600000 }));
  });
  await new Promise<void>(resolve => authority.listen(0, '127.0.0.1', resolve));
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const auth = { origin, issuer: `http://127.0.0.1:${(authority.address() as { port: number }).port}`, secret: 'joined-browser-fixture-secret-0123456789' };
  const namespace = hash(JSON.stringify([auth.issuer, 'owner'])), scope = `${origin}/u/${namespace}/`;
  const credential = 'arc_' + 'j'.repeat(43);
  const initial = emptyRelayState(auth);
  initial.sessions.push({ hash: hash('owner'), sessionExpiresAt: Date.now() + 600000,
    grant: { authenticatedAt: Date.now(), subject: 'owner', namespace, expiresAt: Date.now() + 60000, ticket: '', nonce: 'nonce', continuation: 'owner', sessionExpiresAt: Date.now() + 600000 } });
  initial.tenants.push({ subject: 'owner', namespace, broker: { keys: [[hash(credential), { expires: Date.now() + 600000, installationId: 'joined-controller', kind: 'device' }]],
    hosts: [], bindings: [], creations: [] } });
  let saved: HostedRelayState = initial;
  const makeGateway = () => createHostedRelay({ ...auth, successionEnrollment: true,
    ...(options.rejectFirstPreparation ? { successionProjectionAllowance: () => {
      if (rejectProjection) { rejectProjection = false; return 0; }
      return 2 * 1024 * 1024;
    } } : {}),
    successionEncodingCosts: { measureSnapshot(state) { return { snapshotFormat: SQL_SNAPSHOT_FORMAT, recordFormat: SQL_RECORD_FORMAT, chunkBytes: SQL_CHUNK_BYTES,
      costs: encodeSqlSnapshot(state as HostedRelayState, auth).costs }; }, quoteRecord: quoteSqlRecord },
    storage: { initial: saved, async commit(value) { saved = structuredClone(value); } }, scheduler: { schedule() {}, cancel() {} } });
  let gateway = makeGateway();
  const serve = await createGatewayStaticPages(resolve('dist'), { origin });
  const actions: Array<{ action: string; body: Record<string, unknown>; result?: unknown }> = [];
  const enrollmentActions: Array<{ action: string; operationId?: string }> = [];
  server.on('request', (incoming, outgoing) => { void (async () => {
    const request = webRequest(incoming, new URL(incoming.url!, origin));
    const action = /\/succession\/(\w+)/.exec(incoming.url!)?.[1];
    const observed = action ? { action, body: await request.clone().json() as Record<string, unknown>, result: undefined as unknown } : undefined;
    if (observed) actions.push(observed);
    const result = await gateway.fetch(request);
    if (result) {
      if (observed) observed.result = await result.clone().json();
      if (action === 'commit' && dropCommit) { outgoing.destroy(); return; }
      return writeResponse(outgoing, result);
    }
    if (await serve(incoming, outgoing)) return;
    outgoing.writeHead(404); outgoing.end();
  })().catch(error => { if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end(String(error)); }); });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (incoming, socket, head) => { void (async () => {
    const upgrade = await gateway.prepareUpgrade(webRequest(incoming, new URL(incoming.url!, origin), false));
    if (!upgrade || upgrade instanceof Response) { socket.end('HTTP/1.1 403 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    sockets.handleUpgrade(incoming, socket, head, client => upgrade.accept(relaySocket(client)));
  })(); });
  const connect = () => createRemoteHostUplinkClient({ relay: host.relay, url: origin.replace('http:', 'ws:') + '/ws/remote-host',
    remoteKey: credential, installationId: 'joined-controller', name: 'Joined Host', providers: [{ providerId: 'fixture', displayName: 'Joined provider' }],
    resolveSession: host.resolveSession, acquireSession: host.acquireSession,
    control: request => request.method === 'GET' && request.path === '/remote/vscode-tunnel'
      ? Promise.resolve({ status: 200, body: JSON.stringify({ status: 'unavailable', processAlive: false, revision: 0 }) }) : host.control(request),
    successionEnrollment: { control: (request, context) => {
      const input = JSON.parse(request.body ?? '{}');
      enrollmentActions.push({ action: input.action, operationId: input.freeze?.request?.operationId });
      return host.enrollFromRelay(request, context);
    } } });
  let uplink = connect(); const { hostId } = await uplink.ready;
  const action = async (context: BrowserContext, name: string, body: unknown) => context.request.post(`${scope}v1/remote/hosts/${hostId}/succession/${name}`, { headers: { origin }, data: body });
  return { root, origin, scope, hostId, sessions, actions, enrollmentActions, creates: () => creates, gatewayState: () => structuredClone(saved), action,
    gateCreate(hook: () => Promise<void>) { beforeCreate = hook; }, dropCommitResponse() { dropCommit = true; },
    async state() { return JSON.parse(await readFile(join(root, 'roles', 'state.json'), 'utf8')); },
    async contextState() { return JSON.parse(await readFile(join(root, 'contexts', 'context.json'), 'utf8')); },
    async lateSourceInput(context: BrowserContext) {
      const attached = await context.request.post(`${scope}v1/remote/hosts/${hostId}/attach`, { headers: { origin }, data: { providerId: 'fixture', nativeSessionId: 'A' } });
      const { agentId } = await attached.json();
      const socket = new WebSocket(`${scope.replace('http:', 'ws:')}v1/sessions/${agentId}/events`, { headers: { origin, cookie: `${gatewayCookieName(origin, 'session')}=owner` } });
      const messages: ServerMessage[] = [], listeners = new Set<() => void>();
      socket.on('message', data => { messages.push(JSON.parse(data.toString())); for (const listener of listeners) listener(); });
      const next = (predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(check); reject(new Error('Concrete stale source response deadline')); }, 5000);
        function check() { const index = messages.findIndex(predicate); if (index < 0) return; clearTimeout(timer); listeners.delete(check); resolve(messages.splice(index, 1)[0]!); }
        listeners.add(check); check();
      });
      try {
        await once(socket, 'open', { signal: AbortSignal.timeout(5000) });
        socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' }));
        const state = await next(message => message.type === 'session_control');
        if (state.type !== 'session_control') throw new Error('Missing concrete session control');
        socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'session_control_request', payload: { agentId, requestId: 'late-control', action: 'take_over', revision: state.payload.revision } }));
        const control = await next(message => message.type === 'session_control' && message.payload.requestId === 'late-control');
        if (control.type !== 'session_control') throw new Error('Missing concrete control grant');
        const requestId = '00000000-0000-4000-8000-000000000991';
        socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'send_message', controlToken: control.payload.token, payload: { agentId, requestId, operationId: requestId, text: 'Late concrete A must never dispatch' } }));
        return await next(message => (message.type === 'protocol_error' || message.type === 'command_acknowledged') && message.payload.requestId === requestId);
      } finally { socket.terminate(); }
    },
    async seed(context: BrowserContext) { await context.addCookies([{ name: gatewayCookieName(origin, 'session'), value: 'owner', url: origin, httpOnly: true, sameSite: 'Lax' }]); },
    async restart() {
      dropCommit = false;
      await uplink.close(); await gateway.close(); await host.close();
      for (const [id, old] of sessions) { const next = new JoinedNative(id, root, options.omitDispatchAcceptance); next.sent.push(...old.sent); sessions.set(id, next); }
      host = makeHost(); gateway = makeGateway(); uplink = connect(); await uplink.ready;
    },
    async close() {
      await uplink.close(); await host.close(); await gateway.close(); for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve())); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      authority.closeAllConnections(); await new Promise<void>(resolve => authority.close(() => resolve())); await rm(root, { recursive: true, force: true });
    } };
}

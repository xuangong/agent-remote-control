import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import type { BrowserContext } from '@playwright/test';
import { parseAgentPreparedTextInput, serializeAgentPreparedTextInput, type AgentCapabilities, type AgentInputAcceptance, type AgentSession, type AgentSessionNativeEvidence,
  type ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { createHostedRelay, emptyRelayState, gatewayCookieName, type HostedRelayState } from '@orchardworks/agent-remote-hosted';
import { createRemoteHostUplinkClient, type RemoteHostUplinkClient } from '@orchardworks/agent-remote-relay';
import { WindowWorkspaceClient } from '@orchardworks/agent-remote-web';
import { createAgentHostRuntime, type AgentHostProviderRegistration } from '../../agent-host/src/host.js';
import { encodeSqlSnapshot, quoteSqlRecord, SQL_SNAPSHOT_FORMAT, SQL_RECORD_FORMAT, SQL_CHUNK_BYTES } from '../../agent-remote-cloudflare/src/storage-codec.js';
import { createGatewayStaticPages } from '../src/server/gateway-static.js';
import { relaySocket, webRequest, writeResponse } from '../src/server/remote-host-broker.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * A native session that answers every message with "<Host>/<provider>: <message>", as an agent would reply, and that
 * takes part in a Handoff (its native evidence prepares and dispatches input). Nothing runs a model.
 */
export class EchoNative implements AgentSession {
  capabilities: AgentCapabilities = { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
    interactions: { question: false, toolApproval: false, planApproval: false } };
  /** The messages this session received, in order. */
  readonly received: string[] = [];
  private queue: ProviderStreamItem[] = [];
  private wake?: () => void;
  private closed = false;
  private sequence = 0;
  private epoch = 0;
  private preparations = 0;
  constructor(readonly host: string, readonly providerId: string, readonly id: string, readonly cwd: string, private readonly history: readonly string[] = []) {}
  async runtimeInfo() {
    return { providerId: this.providerId, sessionId: this.id, status: 'idle' as const, cwd: this.cwd, persistence: { providerId: this.providerId, sessionId: this.id, opaque: `cross-host-${this.id}` } };
  }
  async *observe(): AsyncIterable<ProviderStreamItem> {
    for (const [index, text] of this.history.entries()) yield { type: 'observation', sourceKey: `history-${this.id}-${index}`, occurredAt: 1_000 + index, delivery: 'history',
      event: { type: 'timeline', provider: this.providerId, item: index % 2 ? { type: 'assistant_message', text, messageId: `history-${this.id}-${index}` } : { type: 'user_message', text } } };
    yield { type: 'history_boundary' };
    while (!this.closed) {
      const item = this.queue.shift();
      if (item) yield item;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
  private push(item: ProviderStreamItem) { this.queue.push(item); this.wake?.(); }
  private receive(text: string) {
    this.received.push(text);
    const turnId = `turn-${this.id}-${++this.sequence}`;
    const live = (event: Extract<ProviderStreamItem, { type: 'observation' }>['event']) =>
      this.push({ type: 'observation', sourceKey: `live-${this.id}-${++this.sequence}`, occurredAt: Date.now(), delivery: 'live', event });
    live({ type: 'turn_started', provider: this.providerId, turnId });
    live({ type: 'timeline', provider: this.providerId, item: { type: 'user_message', text } });
    // A Handoff's first message carries the earlier conversation before it; the reply names the message itself.
    const message = text.split('\n').filter(Boolean).at(-1) ?? text;
    setTimeout(() => {
      live({ type: 'timeline', provider: this.providerId, item: { type: 'assistant_message', text: `${this.host}/${this.providerId}: ${message}`, messageId: `reply-${turnId}` } });
      live({ type: 'turn_completed', provider: this.providerId, turnId });
    }, 100);
  }
  async sendMessage(text: string): Promise<AgentInputAcceptance> { this.receive(text); return { disposition: 'started' }; }
  async respondToInteraction() {}
  async dispose() { this.closed = true; this.wake?.(); }
  nativeEvidence: AgentSessionNativeEvidence = {
    availability: () => ({ status: 'configured', version: 2 }),
    inspectReadiness: async () => ({ cwd: this.cwd, idle: true, pendingInputs: 0, pendingInteractions: 0, activeChildren: 0 }),
    captureValidity: () => ({ epoch: this.epoch }) as never,
    isCurrent: token => (token as unknown as { epoch: number }).epoch === this.epoch,
    prepareInput: async parts => {
      const text = (parts[0] as { text: string }).text;
      return parseAgentPreparedTextInput(serializeAgentPreparedTextInput({ version: 2, providerId: this.providerId, nativeSessionId: this.id,
        inputId: `${this.id}-U-${++this.preparations}`, cwd: this.cwd, authority: { kind: 'owned-runtime', authorityId: 'cross-host', namespaceId: this.providerId },
        parts: [{ type: 'text', text }], content: { encoding: 'utf-8', bytes: Buffer.byteLength(text), sha256: hash(text) }, selections: { model: `${this.providerId}-default` } }));
    },
    dispatchInput: async witness => { this.receive(witness.parts[0].text); this.epoch++; return { disposition: 'started' }; },
    inspectInput: async witness => ({ status: 'materialized', execution: { disposition: 'started', nativeExecutionId: `${witness.inputId}-R` }, proof: { version: 2, providerId: this.providerId,
      nativeSessionId: this.id, inputId: witness.inputId, nativeInputId: `native-${witness.inputId}`, cwd: this.cwd, authority: witness.authority,
      witnessSha256: hash(serializeAgentPreparedTextInput(witness)), contentSha256: witness.content.sha256, nativeSelectionsSha256: hash(JSON.stringify(witness.selections)) } }),
  };
}

export interface CrossHostSession { providerId: string; nativeSessionId: string; title: string; history?: readonly string[] }
interface HostSpec { name: string; providers: ReadonlyArray<{ providerId: string; displayName: string }>; sessions: readonly CrossHostSession[] }

/**
 * Two Controllers on one Relay, as an owner runs them on two computers: the real hosted Relay (in memory) behind the
 * built Lab, and for each Host a real Controller runtime with its own installation, state directory and outbox,
 * connected over the production uplink. Native sessions are EchoNative. Hosts can be taken offline and brought back.
 */
export async function crossHostFixture(hostSpecs: readonly HostSpec[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-cross-host-')));
  const authority = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += String(chunk);
    const input = JSON.parse(text), subject = input.subject ?? input.continuation;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ active: true, subject, authenticatedAt: Date.now(), validUntil: Date.now() + 60000, expiresAt: Date.now() + 600000 }));
  });
  await new Promise<void>(done => authority.listen(0, '127.0.0.1', done));
  const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const auth = { origin, issuer: `http://127.0.0.1:${(authority.address() as { port: number }).port}`, secret: 'cross-host-browser-fixture-secret-0123456' };
  const namespace = hash(JSON.stringify([auth.issuer, 'owner'])), scope = `${origin}/u/${namespace}/`;
  const credentials = hostSpecs.map((_spec, index) => 'arc_' + String.fromCharCode(107 + index).repeat(43));
  const installations = hostSpecs.map(spec => `${spec.name.toLowerCase()}-controller`);
  const initial = emptyRelayState(auth);
  initial.sessions.push({ hash: hash('owner'), sessionExpiresAt: Date.now() + 3_600_000,
    grant: { authenticatedAt: Date.now(), subject: 'owner', namespace, expiresAt: Date.now() + 60000, ticket: '', nonce: 'nonce', continuation: 'owner', sessionExpiresAt: Date.now() + 3_600_000 } });
  initial.tenants.push({ subject: 'owner', namespace, broker: { keys: credentials.map((credential, index) => [hash(credential), { expires: Date.now() + 3_600_000, installationId: installations[index]!, kind: 'device' }] as [string, { expires: number; installationId: string; kind: 'device' }]),
    hosts: [], bindings: [], creations: [] } });
  let saved: HostedRelayState = initial;
  const gateway = createHostedRelay({ ...auth, successionEnrollment: true,
    successionEncodingCosts: { measureSnapshot(state) { return { snapshotFormat: SQL_SNAPSHOT_FORMAT, recordFormat: SQL_RECORD_FORMAT, chunkBytes: SQL_CHUNK_BYTES,
      costs: encodeSqlSnapshot(state as HostedRelayState, auth).costs }; }, quoteRecord: quoteSqlRecord },
    storage: { initial: saved, async commit(value) { saved = structuredClone(value); } }, scheduler: { schedule() {}, cancel() {} } });
  const serve = await createGatewayStaticPages(resolve('dist'), { origin });
  server.on('request', (incoming, outgoing) => { void (async () => {
    const result = await gateway.fetch(webRequest(incoming, new URL(incoming.url!, origin)));
    if (result) return writeResponse(outgoing, result);
    if (await serve(incoming, outgoing)) return;
    outgoing.writeHead(404); outgoing.end();
  })().catch(error => { if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end(String(error)); }); });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (incoming, socket, head) => { void (async () => {
    const upgrade = await gateway.prepareUpgrade(webRequest(incoming, new URL(incoming.url!, origin), false));
    if (!upgrade || upgrade instanceof Response) { socket.end('HTTP/1.1 403 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    sockets.handleUpgrade(incoming, socket, head, client => upgrade.accept(relaySocket(client)));
  })(); });

  const hosts = await Promise.all(hostSpecs.map(async (spec, index) => {
    const directory = join(root, spec.name); await mkdir(directory, { recursive: true });
    const natives = new Map<string, EchoNative>(), key = (providerId: string, id: string) => `${providerId}:${id}`;
    const titles = new Map<string, string>();
    for (const session of spec.sessions) {
      natives.set(key(session.providerId, session.nativeSessionId), new EchoNative(spec.name, session.providerId, session.nativeSessionId, directory, session.history));
      titles.set(key(session.providerId, session.nativeSessionId), session.title);
    }
    let created = 0;
    const registrations: AgentHostProviderRegistration[] = spec.providers.map(({ providerId, displayName }) => ({
      adapter: { descriptor: { providerId, displayName, sessionExtensions: { instructions: true, tools: true } },
        createSession: async () => { throw new Error('Sessions here are opened, not created.'); },
        resumeSession: async () => { throw new Error('Sessions here are opened, not resumed.'); },
        readSessionHistory: async () => ({ entries: [] }),
        nativeEvidence: { availability: () => ({ status: 'configured', version: 2 }), createEmpty: async config => {
          const id = config.sessionId ?? `${spec.name.toLowerCase()}-${providerId}-${++created}`;
          const native = new EchoNative(spec.name, providerId, id, directory); natives.set(key(providerId, id), native);
          return { status: 'created' as const, handle: (await native.runtimeInfo()).persistence };
        } } },
      directory: { providerId, supportsSourceReferences: true, supportsBoundedSourceCreate: async () => true,
        list: () => [...natives.values()].filter(native => native.providerId === providerId).map(native => ({ nativeSessionId: native.id, providerId,
          title: titles.get(key(providerId, native.id)) ?? 'New session', createdAt: '2026-11-15T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z' })),
        workspaces: () => [], create: async () => { throw new Error('Sessions here are opened, not created.'); },
        open: async id => { const native = natives.get(key(providerId, id)); if (!native) throw new Error('The native session is unavailable.'); return native; },
        sessionWorkspace: async () => directory, sourceReferences: async () => [], setSourceBindingReader: () => {},
        close: async () => { for (const native of natives.values()) if (native.providerId === providerId) await native.dispose(); } },
    }));
    let uplink: RemoteHostUplinkClient | undefined;
    const runtime = createAgentHostRuntime({ idleGraceMs: 20, registrations, controllerId: installations[index]!,
      executionPolicy: { defaultWorkspace: directory, allowedWorkspaceRoots: [directory], lockPermissions: false },
      succession: { controllerId: installations[index]!, enrollment: true, stateDirectory: directory },
      sessionRepliesFile: join(directory, 'session-replies.json'),
      outbox: { file: join(directory, 'outbox-receipts.json'), request: call => uplink ? uplink.outboxRequest(call) : Promise.reject(new Error('Offline.')) } });
    const connect = () => createRemoteHostUplinkClient({ relay: runtime.relay, url: origin.replace('http:', 'ws:') + '/ws/remote-host', remoteKey: credentials[index]!,
      installationId: installations[index]!, name: spec.name, providers: spec.providers.map(provider => ({ ...provider, sessionCommands: true as const })),
      resolveSession: runtime.resolveSession, acquireSession: runtime.acquireSession, control: request => runtime.control(request),
      sessionStates: runtime.sessionStates,
      outbox: { onAvailable: available => runtime.outbox?.setAvailable(available), onReady: () => runtime.outbox?.wake() },
      successionEnrollment: { control: runtime.enrollFromRelay } });
    uplink = connect();
    const { hostId } = await uplink.ready;
    runtime.setRelayConnected(true);
    return { name: spec.name, hostId, natives, runtime,
      /** The native session the Host holds, by provider and id. */
      native: (providerId: string, id: string) => natives.get(key(providerId, id)),
      /** Takes the Host offline, as when its computer sleeps or loses its network. */
      async disconnect() { runtime.setRelayConnected(false); const closing = uplink; uplink = undefined; await closing?.close(); },
      /** Brings the Host back with the same installation. */
      async reconnect() { uplink = connect(); await uplink.ready; runtime.setRelayConnected(true); },
      async close() { await uplink?.close(); await runtime.close(); } };
  }));

  return { origin, scope, hosts, host: (name: string) => hosts.find(host => host.name === name)!,
    relayState: () => structuredClone(saved),
    async seed(context: BrowserContext) {
      await context.addCookies([{ name: gatewayCookieName(origin, 'session'), value: 'owner', url: origin, httpOnly: true, sameSite: 'Lax' }]);
    },
    /** The account's Windows, as a client of the owner's session. */
    windows(context: BrowserContext) {
      return new WindowWorkspaceClient(scope, async (input, init) => {
        const response = await context.request.fetch(String(input), { method: init?.method, headers: { origin, 'content-type': 'application/json' }, data: init?.body as string | undefined, timeout: 10000 });
        return new Response(await response.text(), { status: response.status(), headers: response.headers() });
      });
    },
    newOperationId: () => randomUUID(),
    async close() {
      for (const host of hosts) await host.close();
      await gateway.close(); for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(done => sockets.close(() => done())); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
      authority.closeAllConnections(); await new Promise<void>(done => authority.close(() => done())); await rm(root, { recursive: true, force: true });
    } };
}

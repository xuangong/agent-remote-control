import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import type { BrowserContext } from '@playwright/test';
import { parseAgentPreparedTextInput, serializeAgentPreparedTextInput, type AgentCapabilities, type AgentInputAcceptance, type AgentSession, type AgentSessionNativeEvidence,
  type ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { createHostedRelay, createTimerRelayScheduler, emptyRelayState, gatewayCookieName, type HostedRelayState } from '@orchardworks/agent-relay-core';
import { createRemoteHostUplinkClient, type RemoteHostUplinkClient } from '@orchardworks/agent-session-runtime';
import { WindowWorkspaceClient } from '@orchardworks/agent-client';
import { createAgentHostRuntime, type AgentHostProviderRegistration } from '@orchardworks/agent-remote-controller';
import { encodeHostedSnapshot as encodeSqlSnapshot, quoteHostedRecord as quoteSqlRecord, HOSTED_SNAPSHOT_FORMAT as SQL_SNAPSHOT_FORMAT, HOSTED_RECORD_FORMAT as SQL_RECORD_FORMAT, HOSTED_CHUNK_BYTES as SQL_CHUNK_BYTES } from '@orchardworks/agent-relay-core';
import { createGatewayStaticPages } from '@orchardworks/agent-relay-node/gateway-static';
import { relaySocket, webRequest, writeResponse } from '@orchardworks/agent-relay-node/remote-host-broker';
import { WORKBENCH_DIST } from './workbench-dist';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * A native session that answers every message with "<Host>/<provider>: <message>", as an agent would reply, and that
 * takes part in a Handoff (its native evidence prepares and dispatches input). Nothing runs a model.
 */
/** A native session's conversation, which outlives each opening of it as a native agent's files do. */
export interface EchoRecord { readonly received: string[]; readonly history: Array<{ role: 'user' | 'assistant'; text: string }> }
export class EchoNative implements AgentSession {
  capabilities: AgentCapabilities = { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
    interactions: { question: false, toolApproval: false, planApproval: false } };
  private queue: ProviderStreamItem[] = [];
  private wake?: () => void;
  private closed = false;
  private sequence = 0;
  private epoch = 0;
  private preparations = 0;
  constructor(readonly host: string, readonly providerId: string, readonly id: string, readonly cwd: string, readonly record: EchoRecord) {}
  async runtimeInfo() {
    return { providerId: this.providerId, sessionId: this.id, status: 'idle' as const, cwd: this.cwd, persistence: { providerId: this.providerId, sessionId: this.id, opaque: `cross-host-${this.id}` } };
  }
  async *observe(): AsyncIterable<ProviderStreamItem> {
    for (const [index, { role, text }] of [...this.record.history].entries()) yield { type: 'observation', sourceKey: `history-${this.id}-${index}`, occurredAt: 1_000 + index, delivery: 'history',
      event: { type: 'timeline', provider: this.providerId, item: role === 'assistant' ? { type: 'assistant_message', text, messageId: `history-${this.id}-${index}` } : { type: 'user_message', text } } };
    yield { type: 'history_boundary' };
    while (!this.closed) {
      const item = this.queue.shift();
      if (item) yield item;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
  private push(item: ProviderStreamItem) { this.queue.push(item); this.wake?.(); }
  private receive(text: string) {
    this.record.received.push(text); this.record.history.push({ role: 'user', text });
    const turnId = `turn-${this.id}-${++this.sequence}`;
    const live = (event: Extract<ProviderStreamItem, { type: 'observation' }>['event']) =>
      this.push({ type: 'observation', sourceKey: `live-${this.id}-${++this.sequence}`, occurredAt: Date.now(), delivery: 'live', event });
    live({ type: 'turn_started', provider: this.providerId, turnId });
    live({ type: 'timeline', provider: this.providerId, item: { type: 'user_message', text } });
    // A Handoff's first message carries the earlier conversation before it; the reply names the message itself.
    const message = text.split('\n').filter(Boolean).at(-1) ?? text;
    setTimeout(() => {
      const reply = `${this.host}/${this.providerId}: ${message}`;
      this.record.history.push({ role: 'assistant', text: reply });
      live({ type: 'timeline', provider: this.providerId, item: { type: 'assistant_message', text: reply, messageId: `reply-${turnId}` } });
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
  // The owner's sign-in and the Hosts' keys outlast the hour-long soak (soak.spec.ts) and its setup: they last a day.
  const day = 86_400_000;
  // The owner's identity authority. The Relay gives up on a request after 5 s and aborts it, which leaves a truncated
  // body here when the machine is busy: answer that with an error rather than throwing out of the server.
  const authority = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) text += String(chunk);
      const input = JSON.parse(text), subject = input.subject ?? input.continuation;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ active: true, subject, authenticatedAt: Date.now(), validUntil: Date.now() + 60000, expiresAt: Date.now() + day }));
    } catch { if (!response.headersSent) response.writeHead(400); response.end(); }
  });
  await new Promise<void>(done => authority.listen(0, '127.0.0.1', done));
  const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const auth = { origin, issuer: `http://127.0.0.1:${(authority.address() as { port: number }).port}`, secret: 'cross-host-browser-fixture-secret-0123456' };
  const namespace = hash(JSON.stringify([auth.issuer, 'owner'])), scope = `${origin}/u/${namespace}/`;
  const credentials = hostSpecs.map((_spec, index) => 'arc_' + String.fromCharCode(107 + index).repeat(43));
  const installations = hostSpecs.map(spec => `${spec.name.toLowerCase()}-controller`);
  const initial = emptyRelayState(auth);
  initial.sessions.push({ hash: hash('owner'), sessionExpiresAt: Date.now() + day,
    grant: { authenticatedAt: Date.now(), subject: 'owner', namespace, expiresAt: Date.now() + 60000, ticket: '', nonce: 'nonce', continuation: 'owner', sessionExpiresAt: Date.now() + day } });
  initial.tenants.push({ subject: 'owner', namespace, broker: { keys: credentials.map((credential, index) => [hash(credential), { expires: Date.now() + day, installationId: installations[index]!, kind: 'device' }] as [string, { expires: number; installationId: string; kind: 'device' }]),
    hosts: [], bindings: [], creations: [] } });
  let saved: HostedRelayState = initial;
  const gateway = createHostedRelay({ ...auth, successionEnrollment: true,
    successionEncodingCosts: { measureSnapshot(state) { return { snapshotFormat: SQL_SNAPSHOT_FORMAT, recordFormat: SQL_RECORD_FORMAT, chunkBytes: SQL_CHUNK_BYTES,
      costs: encodeSqlSnapshot(state as HostedRelayState, auth).costs }; }, quoteRecord: quoteSqlRecord },
    // A real timer, as production's alarm: the owner's access is renewed before its one-minute grant runs out, so the
    // fixture keeps its Hosts past a minute.
    storage: { initial: saved, async commit(value) { saved = structuredClone(value); } }, scheduler: createTimerRelayScheduler() });
  const serve = await createGatewayStaticPages(WORKBENCH_DIST, { origin });
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
    const records = new Map<string, EchoRecord & { providerId: string; id: string; title: string }>(), key = (providerId: string, id: string) => `${providerId}:${id}`;
    const natives = new Set<EchoNative>();
    const record = (providerId: string, id: string, title = 'New session', history: readonly string[] = []) => {
      const value = { providerId, id, title, received: [], history: history.map((text, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, text })) };
      records.set(key(providerId, id), value); return value;
    };
    for (const session of spec.sessions) record(session.providerId, session.nativeSessionId, session.title, session.history);
    let created = 0;
    const registrations: AgentHostProviderRegistration[] = spec.providers.map(({ providerId, displayName }) => ({
      adapter: { descriptor: { providerId, displayName, sessionExtensions: { instructions: true, tools: true } },
        createSession: async () => { throw new Error('Sessions here are opened, not created.'); },
        resumeSession: async () => { throw new Error('Sessions here are opened, not resumed.'); },
        readSessionHistory: async () => ({ entries: [] }),
        nativeEvidence: { availability: () => ({ status: 'configured', version: 2 }), createEmpty: async config => {
          const id = config.sessionId ?? `${spec.name.toLowerCase()}-${providerId}-${++created}`;
          const native = new EchoNative(spec.name, providerId, id, directory, record(providerId, id));
          return { status: 'created' as const, handle: (await native.runtimeInfo()).persistence };
        } } },
      directory: { providerId, supportsSourceReferences: true, supportsBoundedSourceCreate: async () => true,
        list: () => [...records.values()].filter(item => item.providerId === providerId).map(item => ({ nativeSessionId: item.id, providerId,
          title: item.title, createdAt: '2026-11-15T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z', state: 'idle' as const })),
        workspaces: () => [], create: async () => { throw new Error('Sessions here are opened, not created.'); },
        // Each opening is a new native agent over the same conversation, as a Controller resumes a released session.
        open: async id => {
          const saved = records.get(key(providerId, id));
          if (!saved) throw new Error('The native session is unavailable.');
          const native = new EchoNative(spec.name, providerId, id, directory, saved); natives.add(native); return native;
        },
        sessionWorkspace: async () => directory, sourceReferences: async () => [], setSourceBindingReader: () => {},
        close: async () => { for (const native of natives) if (native.providerId === providerId) await native.dispose(); } },
    }));
    let uplink: RemoteHostUplinkClient | undefined;
    const runtime = createAgentHostRuntime({ idleGraceMs: 2_000, registrations, controllerId: installations[index]!,
      executionPolicy: { defaultWorkspace: directory, allowedWorkspaceRoots: [directory], lockPermissions: false },
      succession: { controllerId: installations[index]!, enrollment: true, stateDirectory: directory },
      sessionRepliesFile: join(directory, 'session-replies.json'),
      outbox: { file: join(directory, 'outbox-receipts.json'), request: call => uplink ? uplink.outboxRequest(call) : Promise.reject(new Error('Offline.')) } });
    const connect = () => createRemoteHostUplinkClient({ relay: runtime.relay, url: origin.replace('http:', 'ws:') + '/ws/remote-host', remoteKey: credentials[index]!,
      installationId: installations[index]!, name: spec.name, providers: spec.providers.map(provider => ({ ...provider, sessionCommands: true as const })),
      resolveSession: runtime.resolveSession, acquireSession: runtime.acquireSession,
      // A Controller without a VS Code tunnel says so, as the real one does.
      control: request => request.method === 'GET' && request.path === '/remote/vscode-tunnel'
        ? Promise.resolve({ status: 200, body: JSON.stringify({ status: 'unavailable', processAlive: false, revision: 0 }) }) : runtime.control(request),
      sessionStates: runtime.sessionStates,
      outbox: { onAvailable: available => runtime.outbox?.setAvailable(available), onReady: () => runtime.outbox?.wake() },
      successionEnrollment: { control: runtime.enrollFromRelay } });
    uplink = connect();
    const { hostId } = await uplink.ready;
    runtime.setRelayConnected(true);
    return { name: spec.name, hostId, runtime,
      /** A native session's conversation on this Host, by provider and id. */
      native: (providerId: string, id: string) => records.get(key(providerId, id)),
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

import { resolveAgentNativePrefixCapability } from '@orchardworks/agent-provider-sdk';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { LocalSuccessionReplay, localSuccessionLocator } from './local-succession-replay.js';
import type { AgentPersistenceHandle, AgentProviderAdapter, AgentSession, AgentSessionConfig, AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
import { isNativePrefixSelection, isSuccessionRequest, nativePrefixSegmentAncestors, nativeSessionRefKey, PROTOCOL_VERSION, type NativeSessionRef, type PrimaryRole, type SuccessionRecord, type TimelineCursor } from '@orchardworks/agent-remote-protocol';
import { createOperationCache, type AgentRemoteRelay, type OperationLifecycle, type SessionWireAgent } from '@orchardworks/agent-remote-relay';
import { nativePrefixResumeHandle, SuccessionPreparationRejected } from './local-succession-preparation.js';
import { SessionSuccessionService } from './session-succession-service.js';
import { SessionSuccessionBoundary } from './session-succession-boundary.js';
import { SessionReferenceStore, sourceSessionExtensions } from './session-reference.js';
import { publishSuccessionState } from './succession-persistence.js';

/** Compatibility name for the provider-neutral SDK adapter contract. */
export type LocalSuccessionProvider = AgentProviderAdapter;
interface Attachment { ref: NativeSessionRef; handle?: AgentPersistenceHandle; cwd?: string; session: AgentSession; wrapped: AgentSession }
interface SavedAttachment { version: 1; ref: NativeSessionRef; handle: AgentPersistenceHandle; cwd: string }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: NativeSessionRef, b: NativeSessionRef) => nativeSessionRefKey(a) === nativeSessionRefKey(b);
const failure = (status: number, message: string) => Object.assign(new Error(message), { status });

/** Stable local ownership does not require enrolling a session for succession. */
export const localSessionRoleId = (source: NativeSessionRef): string => `local-${hash(nativeSessionRefKey(source))}`;

/** Explicit direct-Relay wiring over the existing durable Host service and admission boundary. */
export class LocalSessionSuccession {
  readonly service: SessionSuccessionService;
  readonly boundary: SessionSuccessionBoundary;
  readonly replay: LocalSuccessionReplay;
  readonly operationCache = createOperationCache();
  readonly operationLifecycle: OperationLifecycle;
  readonly providers: readonly AgentProviderAdapter[];
  private relay?: AgentRemoteRelay;
  private readonly native = new Map<string, Attachment>();
  private readonly agents = new Map<string, string>();
  private readonly openings = new Map<string, Promise<string>>();
  private readonly references = new Map<string, SessionReferenceStore>();
  private closed = false;
  constructor(readonly directory: string, readonly controllerId: string, private readonly adapters: readonly LocalSuccessionProvider[]) {
    this.service = new SessionSuccessionService(directory, controllerId, {
      supports: async () => false,
      supportsNativePrefix: async (source, selection) => {
        const adapter = this.adapter(source), attachment = await this.attachment(source);
        const capability = resolveAgentNativePrefixCapability(adapter);
        if (!capability || capability.createdSessionIdMaxLength > 512
          || attachment.session.promptEditEvidence?.version !== 1 || !attachment.handle) return false;
        nativePrefixResumeHandle(source.providerId, source.nativeSessionId, attachment.handle);
        await this.extensions(source, () => source.nativeSessionId);
        await capability.validate({ nativeSessionId: source.nativeSessionId, ...selection }); return true;
      },
      createNativePrefix: async (request, candidateKnown) => {
        const adapter = this.adapter(request.from), selection = request.preparation!;
        const capability = resolveAgentNativePrefixCapability(adapter);
        if (!capability || capability.createdSessionIdMaxLength > 512) throw new Error('Native prefix preparation is unavailable.');
        let actual: string | undefined;
        let checkpoint: AgentPersistenceHandle | undefined;
        const extensions = await this.extensions(request.from, () => actual);
        const session = await capability.create({ nativeSessionId: request.from.nativeSessionId, turnId: selection.turnId, messageId: selection.messageId }, extensions, async handle => {
          checkpoint = nativePrefixResumeHandle(request.from.providerId, handle.sessionId, handle);
          actual = checkpoint.sessionId;
          await candidateKnown({ target: this.ref(request.from.providerId, actual), handle: checkpoint });
        });
        if (!checkpoint) { await session.dispose(); throw new Error('Native prefix creation did not checkpoint its handle.'); }
        const saved = await this.retain(session, request.from.providerId, checkpoint); actual = saved.ref.nativeSessionId;
        if (!saved.handle) throw new Error('Native prefix has no exact persistence handle.');
        return { target: saved.ref, handle: nativePrefixResumeHandle(saved.ref.providerId, actual, saved.handle) };
      },
      verifyNativePrefix: async (prepared, handle) => {
        const capability = resolveAgentNativePrefixCapability(this.adapter(prepared.from));
        if (!capability || capability.createdSessionIdMaxLength > 512) throw new Error('Native prefix verification is unavailable.');
        await capability.verify({ nativeSessionId: prepared.from.nativeSessionId, turnId: prepared.preparation!.turnId, messageId: prepared.preparation!.messageId }, handle);
      },
      inspect: async source => this.inspect(source),
      retainVerification: async prepared => {
        const entries: Array<{ ref: NativeSessionRef; attachment: Attachment; evidence: NonNullable<AgentSession['promptEditEvidence']>; token: ReturnType<NonNullable<AgentSession['promptEditEvidence']>['captureValidity']> }> = [];
        for (const ref of [prepared.from, prepared.to]) {
          await this.inspect(ref);
          const attachment = await this.attachment(ref), evidence = attachment.session.promptEditEvidence;
          if (!evidence || evidence.version !== 1) throw new Error('Native prefix validity is unavailable.');
          entries.push({ ref, attachment, evidence, token: evidence.captureValidity() });
        }
        let released = false;
        const assertCurrent = () => {
          if (released || this.closed) throw new Error('Local verification is closed.');
          for (const row of entries) if (this.native.get(nativeSessionRefKey(row.ref)) !== row.attachment || !row.evidence.isCurrent(row.token)) throw new Error('Native prefix attachment changed.');
        };
        assertCurrent();
        return { assertCurrent, release() { released = true; }, inspect: async ref => { assertCurrent(); const result = await this.inspect(ref); assertCurrent(); return result; } };
      },
      createIdle: async () => { throw new Error('Generic succession is unavailable in this local entry point.'); },
      captureTimeline: async () => { throw new Error('Native prefixes preserve their native history.'); },
      authorizeRead: async (reader, source) => { await this.authorizeRead(reader); await this.authorizeRead(source); },
      readHistory: async (source, query) => {
        await this.authorizeRead(source);
        const adapter = this.adapter(source); if (!adapter.readSessionHistory) throw new Error('Native history is unavailable.');
        return adapter.readSessionHistory(source.nativeSessionId, query);
      },
      reconcileDelivery: async () => undefined,
    });
    this.replay = new LocalSuccessionReplay(this.service.store, controllerId);
    this.boundary = new SessionSuccessionBoundary(this.service.contexts, ref => this.assertAdmission(ref), ref => {
      const role = this.service.store.all().find(state => same(state.role.current, ref))?.role;
      return role && { roleId: role.id, roleRevision: role.revision };
    }, this.operationCache, (ref, cursor, allowMissing) => this.assertHostState(ref, cursor, allowMissing));
    this.service.coordinator.setAdmission(this.boundary);
    const target = (agent: SessionWireAgent) => this.refForAgent(agent);
    this.operationLifecycle = {
      target: agent => nativeSessionRefKey(target(agent)),
      settingIntent: (agent, accept) => this.boundary.settingIntent(target(agent), accept),
      beforeDispatch: agent => this.assertAdmission(target(agent)),
      mutationTargets: agent => [nativeSessionRefKey(target(agent))],
      admission: (agent, _operation, _scope, entry) => this.boundary.admit([target(agent)], entry.key),
      run: (_agent, operation, scope, entry, work) => this.boundary.run(operation, scope, work, entry),
      dispatch: async (agent, operation, scope, work) => this.boundary.inputResult(target(agent), operation, scope, await work()),
    };
    this.providers = adapters.map(adapter => new Proxy(adapter, { get: (target, key) => {
      // Durable creation belongs to this runtime's admission and retention path.
      if (key === 'nativePrefix') return undefined;
      if (key === 'createSession') return (config: AgentSessionConfig) => this.create(adapter, config);
      if (key === 'resumeSession') return (handle: AgentPersistenceHandle) => this.resume(handle);
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } }));
  }
  async ownSession(session: AgentSession, providerId: string): Promise<AgentSession> {
    const info = await session.runtimeInfo(), existing = info.sessionId && this.native.get(nativeSessionRefKey(this.ref(providerId, info.sessionId)));
    if (existing && (session === existing.wrapped || session === existing.session)) return existing.wrapped;
    return (await this.retain(session, providerId)).wrapped;
  }
  bindRelay(relay: AgentRemoteRelay): void { if (this.relay) throw new Error('Local Relay is already bound.'); this.relay = relay; }
  ref(providerId: string, nativeSessionId: string): NativeSessionRef { return { controllerId: this.controllerId, providerId, nativeSessionId }; }
  refForAgent(agent: SessionWireAgent): NativeSessionRef {
    const info = agent.snapshot().payload.runtimeInfo;
    if (!info.sessionId) throw new Error('Native session identity is unavailable.');
    const ref = this.ref(info.providerId, info.sessionId); this.adapter(ref);
    if (!this.native.has(nativeSessionRefKey(ref))) throw new Error('This runtime does not own the native attachment.');
    this.agents.set(nativeSessionRefKey(ref), agent.agentId); return ref;
  }
  agentRef(agentId: string): NativeSessionRef { return this.refForAgent(this.relay!.requireAgent(agentId)); }
  private adapter(ref: NativeSessionRef): LocalSuccessionProvider {
    if (this.closed || ref.controllerId !== this.controllerId) throw failure(403, 'Session is outside this local runtime.');
    const adapter = this.adapters.find(row => row.descriptor.providerId === ref.providerId);
    if (!adapter) throw failure(403, 'Provider is outside this local runtime.'); return adapter;
  }
  private assertAdmission(ref: NativeSessionRef): void { this.adapter(ref); this.service.coordinator.assertAdmission(ref); }
  private assertHostState(ref: NativeSessionRef, cursor?: TimelineCursor, allowMissing = false): void {
    const id = this.agents.get(nativeSessionRefKey(ref));
    if (!id && allowMissing) return;
    const agent = id && this.relay?.requireAgent(id), state = agent && agent.handoffAdmissionState?.();
    if (!agent || !state || !state.connected || !state.synchronized || state.closed || state.status !== 'idle' || state.activeTurn || state.pendingInteractions || state.commandWork || state.settingWork) throw new Error('Local session has unsettled runtime work.');
    const current = agent.timelineCursor?.();
    if (cursor && (current?.epoch !== cursor.epoch || current.seq !== cursor.seq)) throw new Error('Local source history changed.');
  }
  private async inspect(ref: NativeSessionRef) {
    const id = await this.attach(ref), attachment = await this.attachment(ref);
    if (attachment.session.promptEditEvidence?.version !== 1) throw new SuccessionPreparationRejected('succession_unsupported_provider', 'Native prefix readiness is unavailable.');
    await this.boundary.reconcileCoverage(ref);
    const native = await attachment.session.promptEditEvidence.inspectReadiness();
    this.assertHostState(ref);
    const boundary = this.relay!.requireAgent(id).timelineCursor();
    if (!boundary) throw new Error('Local timeline boundary is unavailable.');
    return { ...native, boundary, managed: this.service.contexts.coverageAvailable(ref), inFlightInputs: this.boundary.pending(ref) };
  }
  private metadata(ref: NativeSessionRef): string { return `${hash(nativeSessionRefKey(ref))}.json`; }
  private async saved(ref: NativeSessionRef): Promise<SavedAttachment> {
    this.adapter(ref);
    const saved = JSON.parse(await readFile(join(this.directory, 'attachments', this.metadata(ref)), 'utf8')) as SavedAttachment;
    if (saved.version !== 1 || !same(saved.ref, ref) || typeof saved.cwd !== 'string') throw new Error('Invalid local attachment identity.');
    nativePrefixResumeHandle(ref.providerId, ref.nativeSessionId, saved.handle); return saved;
  }
  private async authorizeRead(ref: NativeSessionRef): Promise<void> {
    const attachment = this.native.get(nativeSessionRefKey(ref)) ?? await this.saved(ref); this.adapter(ref);
    if (!attachment.cwd || await realpath(attachment.cwd) !== attachment.cwd) throw new Error('Local session workspace is unavailable.');
  }
  private async retain(session: AgentSession, providerId: string, checkpoint?: AgentPersistenceHandle): Promise<Attachment> {
    let disposed: Promise<void> | undefined;
    const dispose = () => disposed ??= Promise.resolve().then(() => session.dispose()).finally(() => { if (this.native.get(key) === attachment) this.native.delete(key); });
    let attachment: Attachment, key = '';
    try {
      const info = await session.runtimeInfo();
      if (this.closed || info.providerId !== providerId || !info.sessionId) throw new Error('Local native attachment identity changed.');
      const ref = this.ref(providerId, info.sessionId); key = nativeSessionRefKey(ref);
      if (this.native.has(key)) throw new Error('Local native identity is already attached.');
      const runtimeHandle = info.persistence && nativePrefixResumeHandle(providerId, info.sessionId, info.persistence);
      if (checkpoint && !runtimeHandle) throw new Error('Native prefix attachment has no persistence handle.');
      // Runtime settings may change after bootstrap; recovery keeps the original exact checkpoint.
      const handle = checkpoint ? nativePrefixResumeHandle(providerId, info.sessionId, checkpoint) : runtimeHandle;
      const cwd = info.cwd ? await realpath(info.cwd).catch(() => undefined) : undefined;
      const owned = new Proxy(session, { get(target, name) { if (name === 'dispose') return dispose; const value = Reflect.get(target, name, target); return typeof value === 'function' ? value.bind(target) : value; } });
      attachment = { ref, handle, cwd, session: owned, wrapped: this.boundary.wrap(ref, owned) };
      this.native.set(key, attachment);
      if (handle && cwd) {
        const directory = join(this.directory, 'attachments'); await mkdir(directory, { recursive: true, mode: 0o700 });
        await publishSuccessionState(directory, this.metadata(ref), { version: 1, ref, handle, cwd } satisfies SavedAttachment);
      }
      return attachment;
    } catch (error) { await dispose(); throw error; }
  }
  private grants(providerId: string): SessionReferenceStore {
    let store = this.references.get(providerId);
    if (!store) { store = new SessionReferenceStore(join(this.directory, 'sources', hash(providerId)), providerId); this.references.set(providerId, store); }
    return store;
  }
  private async extensions(source: NativeSessionRef, actual: () => string | undefined): Promise<AgentSessionExtensions> {
    await this.service.ready;
    const ancestors = nativePrefixSegmentAncestors(source, this.service.store.all().flatMap(state => state.operations.filter(row => row.phase === 'committed')));
    const grant = await this.grants(source.providerId).resolve(ancestors.map(ref => ref.nativeSessionId));
    if (!grant) return {};
    const adapter = this.adapter(source);
    if (!adapter.readSessionHistory || !adapter.descriptor.sessionExtensions?.tools) throw new Error('Native source tool reconstruction is unavailable.');
    const extensions = sourceSessionExtensions(grant.sourceNativeSessionId, adapter.readSessionHistory.bind(adapter), query => {
      const reader = actual(); if (!reader) throw new Error('Actual source reader is unavailable.');
      return this.service.bindings(source.providerId).read(reader, grant.sourceNativeSessionId, query, adapter.readSessionHistory!.bind(adapter), grant.handle.sessionId);
    });
    return { ...extensions, systemPrompt: grant.systemPrompt, ...(grant.instructions ? { instructions: grant.instructions } : {}) };
  }
  private async create(adapter: LocalSuccessionProvider, input: AgentSessionConfig): Promise<AgentSession> {
    await this.service.ready;
    const { sourceNativeSessionId, ...config } = input as AgentSessionConfig & { sourceNativeSessionId?: string };
    let actual: string | undefined;
    const source = sourceNativeSessionId && this.ref(adapter.descriptor.providerId, sourceNativeSessionId);
    if (source) await this.authorizeRead(source);
    if (source && (!adapter.readSessionHistory || !adapter.descriptor.sessionExtensions?.tools)) throw new Error('Native source tools are unavailable.');
    const extensions = source ? sourceSessionExtensions(source.nativeSessionId, adapter.readSessionHistory!.bind(adapter), query => {
      if (!actual) throw new Error('Actual source reader is unavailable.');
      return this.service.bindings(source.providerId).read(actual, source.nativeSessionId, query, adapter.readSessionHistory!.bind(adapter), actual);
    }) : {};
    const session = await adapter.createSession({ ...config, ...extensions });
    const attachment = await this.retain(session, adapter.descriptor.providerId); actual = attachment.ref.nativeSessionId;
    if (source) {
      if (!attachment.handle) { await attachment.session.dispose(); throw new Error('Source reader persistence is unavailable.'); }
      try { await this.grants(source.providerId).set({ sourceNativeSessionId: source.nativeSessionId, systemPrompt: extensions.systemPrompt ?? '', handle: attachment.handle }); }
      catch (error) { await attachment.session.dispose(); throw error; }
    }
    return attachment.wrapped;
  }
  private prefix(ref: NativeSessionRef) {
    const records = this.service.store.all().flatMap(state => state.operations).filter(row => row.preparation && row.to && same(row.to, ref));
    if (records.length > 1) throw new Error('Ambiguous original prefix handle.');
    const record = records[0];
    return record && { record, handle: this.service.store.nativePrefixHandle(record.operationId) };
  }
  private async resume(handle: AgentPersistenceHandle): Promise<AgentSession> {
    await this.service.ready;
    const ref = this.ref(handle.providerId, handle.sessionId), adapter = this.adapter(ref);
    const prefix = this.prefix(ref);
    if (prefix && (!prefix.handle || JSON.stringify(prefix.handle) !== JSON.stringify(handle))) throw new Error('Original native prefix handle mismatch.');
    const existing = this.native.get(nativeSessionRefKey(ref));
    if (existing) {
      if (JSON.stringify(existing.handle) !== JSON.stringify(handle)) throw new Error('Attached native handle mismatch.');
      return existing.wrapped;
    }
    const extensions = await this.extensions(prefix?.record.from ?? ref, () => ref.nativeSessionId);
    return (await this.retain(await adapter.resumeSession(handle, extensions), ref.providerId, prefix?.handle)).wrapped;
  }
  private async attachment(ref: NativeSessionRef, reopen?: () => Promise<AgentSession>): Promise<Attachment> {
    this.adapter(ref);
    const existing = this.native.get(nativeSessionRefKey(ref)); if (existing) return existing;
    const prefix = this.prefix(ref), handle = prefix ? prefix.handle : (await this.saved(ref)).handle;
    if (!handle) throw new Error('Original native prefix handle is unavailable.');
    if (reopen) {
      const session = await reopen();
      try {
        const info = await session.runtimeInfo();
        const expected = await this.saved(ref);
        if (info.providerId !== ref.providerId || info.sessionId !== ref.nativeSessionId || !isDeepStrictEqual(info.persistence, handle)
          || !info.cwd || await realpath(info.cwd) !== expected.cwd) throw new Error('Historical directory attachment changed its exact native identity.');
      } catch (error) { await session.dispose(); throw error; }
      return this.retain(session, ref.providerId);
    }
    await this.resume(handle); return this.native.get(nativeSessionRefKey(ref))!;
  }
  async attach(ref: NativeSessionRef, reopen?: () => Promise<AgentSession>): Promise<string> {
    await this.service.ready; this.adapter(ref);
    const key = nativeSessionRefKey(ref), current = this.agents.get(key);
    if (current) { try { this.relay!.requireAgent(current); return current; } catch { this.agents.delete(key); } }
    let opening = this.openings.get(key);
    if (!opening) {
      opening = (async () => {
        const attachment = await this.attachment(ref, reopen); if (!attachment.handle) throw new Error('Local session cannot be resumed.');
        const agentId = `local-${hash(key)}`;
        await this.relay!.resumeAgent({ protocolVersion: PROTOCOL_VERSION, type: 'resume_agent', payload: { requestId: randomUUID(), agentId, persistence: attachment.handle } });
        this.agents.set(key, agentId); return agentId;
      })();
      this.openings.set(key, opening); void opening.finally(() => this.openings.delete(key)).catch(() => undefined);
    }
    return opening;
  }
  async ensureRole(source: NativeSessionRef): Promise<PrimaryRole> {
    await this.service.ready; await this.authorizeRead(source);
    const existing = this.service.store.all().find(state => same(state.role.origin, source) || same(state.role.current, source) || state.operations.some(row => row.to && same(row.to, source)));
    if (existing) return existing.role;
    const attachment = await this.attachment(source);
    if (!attachment.cwd || !attachment.handle) throw new Error('Durable local session identity is unavailable.');
    const role: PrimaryRole = { id: localSessionRoleId(source), revision: 1, origin: source, current: source, workspace: { controllerId: this.controllerId, canonicalCwd: attachment.cwd } };
    await this.service.createRole(role); return role;
  }
  /** Validate a request against an already authorized local role; never accept foreign locators. */
  async action(action: string, body: Record<string, unknown>, role: PrimaryRole) {
    await this.service.ready;
    if (action === 'describe') {
      if (body.preparation !== undefined && !isNativePrefixSelection(body.preparation)) throw failure(400, 'Invalid native prefix selection.');
      return this.service.describe(role, role.current, this.adapters.map(({ descriptor }) => ({ providerId: descriptor.providerId, displayName: descriptor.displayName })), body.preparation);
    }
    let record: SuccessionRecord;
    if (action === 'prepare') {
      if (!isSuccessionRequest(body)) throw failure(400, 'Invalid succession request.');
      this.adapter(body.from);
      const saved = this.service.store.all().flatMap(state => state.operations).find(record => record.operationId === body.operationId);
      if (body.roleId !== role.id || saved && saved.roleId !== role.id || !saved && !same(body.from, role.current)) throw failure(403, 'Succession source is outside the current local role.');
      // The existing store validates a saved request's complete fingerprint before replaying it.
      record = await this.service.prepare(body);
    } else {
      if (typeof body.operationId !== 'string' || !Number.isSafeInteger(body.expectedRevision)) throw failure(400, 'Invalid succession operation identity.');
      const saved = this.service.store.operation(body.operationId);
      if (saved.roleId !== role.id || saved.expectedRevision !== body.expectedRevision) throw failure(403, 'Succession operation is outside the current local role.');
      if (action === 'status') record = saved;
      else if (action === 'commit') record = await this.service.commit(saved.operationId, saved.expectedRevision);
      else if (action === 'cancel') record = await this.service.coordinator.cancel(saved.operationId);
      else if (action === 'reconcile') record = await this.service.coordinator.reconcileReady(saved.operationId);
      else throw failure(404, 'Unknown local succession action.');
    }
    const current = this.service.store.read(role.id).role;
    return { record, role: current, locator: localSuccessionLocator(current.current) };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.boundary.close(); }
    finally { this.boundary.retireCoverageEvidence(); await Promise.all([...this.native.values()].map(row => row.session.dispose())); }
  }
}

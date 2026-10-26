import { randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentHistoryPage, AgentHistoryQuery, AgentPersistenceHandle } from '@orchardworks/agent-provider-sdk';
import { nativeSessionRefKey, resolveNativePrefix, type NativePrefixResolution, type SuccessionAssociationFreeze, serializeNormalizedHistory, type NativeSessionRef, type PreparedSuccession, type PrimaryRole, type ProjectedTimelineEntry, type SuccessionDescription, type SuccessionRequest, type TimelineCursor, type NativePrefixSelection } from '@orchardworks/agent-remote-protocol';
import { LocalSuccessionPreparation, SuccessionPreparationRejected, type NativePrefixCandidate, type NativePrefixCandidateKnown, type NativeSuccessionCreate, type RetainedSuccessionVerification, type SuccessionReadiness } from './local-succession-preparation.js';
import { isSuccessionDeliveryUnresolved, SessionSuccessionContextStore, type SuccessionContextDelivery, type SuccessionContextPreparation } from './session-succession-context.js';
import { SessionSuccessionStore } from './session-succession-store.js';
import { SessionSuccessionCoordinator } from './session-succession.js';
import { SessionSourceBindings } from './session-source-binding.js';
import { syncSuccessionDirectory, withSuccessionFile } from './succession-persistence.js';

export interface SessionSuccessionPorts {
  /** Certifies zero-turn creation, normalized capture, quiescence and routed source-binding support for both adapters. */
  supports(source: NativeSessionRef, targetProviderId: string): Promise<boolean>;
  /** Before effect, certifies valid public candidate/capture schemas: createIdle ref fields and captureTimeline/inspect epoch/capturedAt strings
   * are nonempty, at most 512 UTF-16 units, and capture seq is a nonnegative safe integer.
   * The certificate must come from the supported adapter mode, not post-create validation.
   * Missing/false keeps new v2 preparation disabled; legacy recovery uses supports alone. */
  supportsBoundedProjection?(source: NativeSessionRef, targetProviderId: string): Promise<boolean>;
  supportsNativePrefix?(source: NativeSessionRef, selection: NativePrefixSelection): Promise<boolean>;
  createNativePrefix?(request: SuccessionRequest, candidateKnown: NativePrefixCandidateKnown): Promise<NativePrefixCandidate>;
  verifyNativePrefix?(prepared: PreparedSuccession, handle: AgentPersistenceHandle): Promise<void>;
  inspect(source: NativeSessionRef, preparation?: NativePrefixSelection): Promise<SuccessionReadiness>;
  createIdle(source: NativeSessionRef, operationId: string, targetProviderId: string): Promise<NativeSessionRef>;
  selectNativeCreation?(source: NativeSessionRef, operationId: string, targetProviderId: string): Promise<NativeSuccessionCreate | undefined>;
  retainVerification?(prepared: PreparedSuccession): Promise<RetainedSuccessionVerification>;
  /** One complete normalized snapshot frozen at an authoritative boundary; reject incomplete pages. */
  captureTimeline(source: NativeSessionRef): Promise<{ entries: readonly ProjectedTimelineEntry[]; boundary: TimelineCursor; capturedAt: string }>;
  authorizeRead(reader: NativeSessionRef, source: NativeSessionRef): Promise<void>;
  readHistory(source: NativeSessionRef, query: AgentHistoryQuery): Promise<AgentHistoryPage>;
  /** Adapter-native durable history/dispatch evidence. Undefined leaves uncertainty unchanged. */
  reconcileDelivery(delivery: SuccessionContextDelivery): Promise<{ outcome: 'materialized' | 'not-dispatched'; nativeEvidence: string } | undefined>;
}

export interface SessionExecutionRouting {
  resolve(anchor: NativeSessionRef): NativePrefixResolution;
  assertCurrent(anchor: NativeSessionRef, actual: NativeSessionRef): void;
}

/** Stable Controller state plus explicit runtime ports; no implicit native idle or delivery inference. */
export class SessionSuccessionService {
  readonly ready: Promise<void>;
  readonly store: SessionSuccessionStore;
  readonly contexts: SessionSuccessionContextStore;
  readonly coordinator: SessionSuccessionCoordinator;
  readonly executionRouting: SessionExecutionRouting = {
    resolve: anchor => {
      if (!this.cursorKey || anchor.controllerId !== this.controllerId) throw new Error('Execution routing is unavailable for this Host.');
      return resolveNativePrefix(anchor, this.store.all().flatMap(state => state.operations.filter(record => record.phase === 'committed')));
    },
    assertCurrent: (anchor, actual) => {
      const { target } = this.executionRouting.resolve(anchor);
      if (target.controllerId !== this.controllerId || nativeSessionRefKey(target) !== nativeSessionRefKey(actual)) throw new Error('Execution recipient is no longer current.');
      this.coordinator.assertAdmission(actual);
    },
  };
  private readonly preparation: LocalSuccessionPreparation;
  private cursorKey?: Buffer;
  private readonly bindingReaders = new Map<string, SessionSourceBindings>();
  constructor(private readonly directory: string, private readonly controllerId: string, private readonly ports: SessionSuccessionPorts) {
    this.store = new SessionSuccessionStore(join(directory, 'roles'));
    this.contexts = new SessionSuccessionContextStore(join(directory, 'contexts'));
    const preparation = this.preparation = new LocalSuccessionPreparation(controllerId, '', {
      inspect: (source, preparation) => ports.inspect(source, preparation), supports: (source, targetProvider) => ports.supports(source, targetProvider),
      supportsBoundedProjection: (source, targetProvider) => ports.supportsBoundedProjection?.(source, targetProvider) ?? Promise.resolve(false),
      create: (source, operationId, targetProvider) => ports.createIdle(source, operationId, targetProvider),
      selectNativeCreation: (source, operationId, targetProvider) => ports.selectNativeCreation?.(source, operationId, targetProvider) ?? Promise.resolve(undefined),
      ...(ports.retainVerification ? { retainVerification: (prepared: PreparedSuccession) => ports.retainVerification!(prepared) } : {}),
      supportsNativePrefix: (source, selection) => ports.supportsNativePrefix?.(source, selection) ?? Promise.resolve(false),
      ...(ports.createNativePrefix ? { createNativePrefix: (request: SuccessionRequest, candidateKnown: NativePrefixCandidateKnown) => ports.createNativePrefix!(request, candidateKnown) } : {}),
      ...(ports.verifyNativePrefix ? { verifyNativePrefix: (prepared: PreparedSuccession) => {
        const handle = this.store.nativePrefixHandle(prepared.operationId);
        if (!handle) throw new Error('Original native prefix handle is unavailable.');
        return ports.verifyNativePrefix!(prepared, handle);
      } } : {}),
      capture: (source, operationId) => this.capture(source, operationId),
      saveContext: context => this.contexts.prepare(context),
      bind: async (operationId, target) => { await this.contexts.bind(operationId, target); },
      verifyAttachment: prepared => this.verifyAttachment(prepared),
    }, this.contexts);
    this.coordinator = new SessionSuccessionCoordinator(this.store, preparation);
    this.ready = this.initialize();
  }
  bindings(providerId: string): SessionSourceBindings {
    if (!this.cursorKey) throw new Error('Succession service is not ready.');
    let bindings = this.bindingReaders.get(providerId);
    if (!bindings) {
      bindings = new SessionSourceBindings(this.store, this.controllerId, providerId, this.cursorKey, { contexts: this.contexts, executionRouting: this.executionRouting,
        authorizeRead: (reader, source) => this.ports.authorizeRead(reader, source),
        readRouted: (source, query) => this.ports.readHistory(source, query) });
      this.bindingReaders.set(providerId, bindings);
    }
    return bindings;
  }
  async createRole(role: PrimaryRole) { await this.ready; if (role.workspace.controllerId !== this.controllerId || role.current.controllerId !== this.controllerId) throw new Error('Role is outside this Controller.'); return this.store.createRole(role); }
  async prepare(request: SuccessionRequest) { await this.ready; return this.coordinator.prepare(request); }
  async commit(operationId: string, revision: number) { await this.ready; return this.coordinator.commit(operationId, revision); }
  async releaseEnrollment(freeze: SuccessionAssociationFreeze): Promise<void> {
    await this.ready;
    await this.store.releaseEnrollment(freeze);
    this.coordinator.releaseCommitted(freeze.request.operationId);
  }
  async describe(role: PrimaryRole, source: NativeSessionRef, candidates: SuccessionDescription['targets'], preparation?: NativePrefixSelection): Promise<SuccessionDescription> {
    await this.ready;
    const targets: SuccessionDescription['targets'] = [];
    let refusal: unknown;
    for (const candidate of candidates) {
      try {
        await this.preparation.supports(role, candidate.providerId, preparation);
        await this.preparation.supportsBoundedProjection(role, candidate.providerId, preparation);
        targets.push(candidate);
      } catch (error) {
        // An unverified provider pair cannot be offered for new preparation.
        if (candidate.providerId === role.current.providerId) refusal = error;
      }
    }
    const unavailable = (code: string, reason: string): SuccessionDescription => ({ role, targets, eligibility: { status: 'unavailable', code, reason } });
    if (nativeSessionRefKey(role.current) !== nativeSessionRefKey(source)) return unavailable('session_superseded', 'Open the current primary session before handoff.');
    // A prompt edit stays with the current provider, so its refusal is the reason.
    if (!targets.length && preparation && refusal instanceof Error && refusal.message) {
      return unavailable(refusal instanceof SuccessionPreparationRejected ? refusal.code : 'succession_unsupported_provider', refusal.message.slice(0, 4096));
    }
    if (!targets.length) return unavailable('succession_unsupported_provider', 'No available provider pair supports safe handoff.');
    try {
      this.coordinator.assertAdmission(source);
      await this.preparation.check(role, role.current, undefined, preparation);
      return { role, targets, eligibility: { status: 'ready' } };
    } catch (error) {
      if (error instanceof SuccessionPreparationRejected) return { role, targets, eligibility: { status: 'blocked', code: error.code, reason: error.message } };
      return unavailable('succession_readiness_unavailable', error instanceof Error ? error.message : 'The current session state could not be verified.');
    }
  }
  async reconcileFirstInput(operationId: string): Promise<boolean> {
    await this.ready;
    if (this.store.operation(operationId).preparation) return true;
    const attachment = this.contexts.read(operationId);
    const delivery = attachment.deliveries.find(item => item.state !== 'dispatching' && isSuccessionDeliveryUnresolved(item));
    if (!delivery) return attachment.state === 'materialized';
    const evidence = await this.ports.reconcileDelivery(delivery);
    if (!evidence) return false;
    await this.contexts.reconcile(operationId, { ...evidence, operationId: delivery.operationId, target: delivery.target, roleRevision: delivery.roleRevision });
    return evidence.outcome === 'materialized';
  }
  private async capture(source: NativeSessionRef, contextOperationId: string): Promise<SuccessionContextPreparation> {
    if (!contextOperationId.endsWith(':context')) throw new Error('Invalid succession context operation identity.');
    const operationId = contextOperationId.slice(0, -':context'.length), operation = this.store.operation(operationId);
    if (nativeSessionRefKey(operation.from) !== nativeSessionRefKey(source)) throw new Error('Succession capture routing changed.');
    const pending = this.contexts.forTarget(source);
    if (pending?.deliveries.some(isSuccessionDeliveryUnresolved)) throw new Error('Reconcile unresolved source context before succession.');
    let capture: PreparedSuccession['capture'], history: { text: string; itemCount: number; shortenedToolCount?: number };
    if (pending?.state === 'pending') {
      const state = await this.ports.inspect(source);
      capture = { ...state.boundary, capturedAt: new Date().toISOString() };
      history = { text: pending.text, itemCount: pending.itemCount, shortenedToolCount: pending.shortenedToolCount };
    } else {
      const snapshot = await this.ports.captureTimeline(source);
      history = serializeNormalizedHistory(snapshot.entries);
      capture = { ...snapshot.boundary, capturedAt: snapshot.capturedAt };
    }
    return { operationId, roleId: operation.roleId, roleRevision: operation.expectedRevision + 1,
      source, capturedAt: capture.capturedAt, boundary: {epoch:capture.epoch,seq:capture.seq}, ...history,
      ...(pending?.state === 'pending' ? { inheritedFrom: { operationId: pending.operationId, source: pending.source, boundary: pending.boundary, capturedAt: pending.capturedAt } } : {}) };
  }
  private async verifyAttachment(prepared: PreparedSuccession): Promise<void> {
    const attachment = this.contexts.read(prepared.operationId);
    if (attachment.state !== 'pending' || attachment.roleId !== prepared.roleId || attachment.roleRevision !== prepared.expectedRevision + 1
      || nativeSessionRefKey(attachment.source) !== nativeSessionRefKey(prepared.from) || nativeSessionRefKey(attachment.target) !== nativeSessionRefKey(prepared.to)
      || attachment.boundary.epoch !== prepared.capture.epoch || attachment.boundary.seq !== prepared.capture.seq || attachment.capturedAt !== prepared.capture.capturedAt) throw new Error('Durable succession attachment does not match preparation.');
  }
  private async initialize(): Promise<void> {
    await Promise.all([this.store.ready, this.contexts.ready]);
    await mkdir(this.directory, {recursive:true,mode:0o700});
    const path = join(this.directory,'source-cursor.key');
    const readKey = async () => {
      const saved = await readFile(path);
      if (saved.length !== 32) throw new Error('Invalid durable source cursor signing key.');
      return saved;
    };
    let key: Buffer;
    try { key = await readKey(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const generated = randomBytes(32), temporary = `${path}.${randomUUID()}.tmp`;
      let failed = false, failure: unknown;
      try {
        const file = await open(temporary,'wx',0o600);
        await withSuccessionFile(file, async () => { await file.writeFile(generated); await file.sync(); });
        try { await link(temporary,path); }
        catch (linkError) { if ((linkError as NodeJS.ErrnoException).code !== 'EEXIST') throw linkError; }
        key = await readKey();
      } catch (initializationError) { failed = true; failure = initializationError; }
      try { await unlink(temporary); } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          if (failed) throw new AggregateError([failure, cleanupError], 'Source cursor initialization and cleanup failed.', { cause: failure });
          throw cleanupError;
        }
      }
      if (failed) throw failure;
    }
    await syncSuccessionDirectory(this.directory);
    this.cursorKey = key!;
  }
}

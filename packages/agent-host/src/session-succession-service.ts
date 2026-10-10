import { randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentHistoryPage, AgentHistoryQuery } from '@orchardworks/agent-provider-sdk';
import { nativeSessionRefKey, serializeNormalizedHistory, type NativeSessionRef, type PreparedSuccession, type PrimaryRole, type ProjectedTimelineEntry, type SuccessionRequest, type TimelineCursor } from '@orchardworks/agent-remote-protocol';
import { LocalSuccessionPreparation, type SuccessionReadiness } from './local-succession-preparation.js';
import { SessionSuccessionContextStore, type SuccessionContextDelivery, type SuccessionContextPreparation } from './session-succession-context.js';
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
  inspect(source: NativeSessionRef): Promise<SuccessionReadiness>;
  createIdle(source: NativeSessionRef, operationId: string, targetProviderId: string): Promise<NativeSessionRef>;
  /** One complete normalized snapshot frozen at an authoritative boundary; reject incomplete pages. */
  captureTimeline(source: NativeSessionRef): Promise<{ entries: readonly ProjectedTimelineEntry[]; boundary: TimelineCursor; capturedAt: string }>;
  authorizeRead(reader: NativeSessionRef, source: NativeSessionRef): Promise<void>;
  readHistory(source: NativeSessionRef, query: AgentHistoryQuery): Promise<AgentHistoryPage>;
  /** Adapter-native durable history/dispatch evidence. Undefined leaves uncertainty unchanged. */
  reconcileDelivery(delivery: SuccessionContextDelivery): Promise<{ outcome: 'materialized' | 'not-dispatched'; nativeEvidence: string } | undefined>;
}

/** Stable Controller state plus explicit runtime ports; no implicit native idle or delivery inference. */
export class SessionSuccessionService {
  readonly ready: Promise<void>;
  readonly store: SessionSuccessionStore;
  readonly contexts: SessionSuccessionContextStore;
  readonly coordinator: SessionSuccessionCoordinator;
  private cursorKey?: Buffer;
  private readonly bindingReaders = new Map<string, SessionSourceBindings>();
  constructor(private readonly directory: string, private readonly controllerId: string, private readonly ports: SessionSuccessionPorts) {
    this.store = new SessionSuccessionStore(join(directory, 'roles'));
    this.contexts = new SessionSuccessionContextStore(join(directory, 'contexts'));
    const preparation = new LocalSuccessionPreparation(controllerId, '', {
      inspect: source => ports.inspect(source), supports: (source, targetProvider) => ports.supports(source, targetProvider),
      supportsBoundedProjection: (source, targetProvider) => ports.supportsBoundedProjection?.(source, targetProvider) ?? Promise.resolve(false),
      create: (source, operationId, targetProvider) => ports.createIdle(source, operationId, targetProvider),
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
      bindings = new SessionSourceBindings(this.store, this.controllerId, providerId, this.cursorKey, { contexts: this.contexts,
        authorizeRead: (reader, source) => this.ports.authorizeRead(reader, source),
        readRouted: (source, query) => this.ports.readHistory(source, query) });
      this.bindingReaders.set(providerId, bindings);
    }
    return bindings;
  }
  async createRole(role: PrimaryRole) { await this.ready; if (role.workspace.controllerId !== this.controllerId || role.current.controllerId !== this.controllerId) throw new Error('Role is outside this Controller.'); return this.store.createRole(role); }
  async prepare(request: SuccessionRequest) { await this.ready; return this.coordinator.prepare(request); }
  async commit(operationId: string, revision: number) { await this.ready; return this.coordinator.commit(operationId, revision); }
  async reconcileFirstInput(operationId: string): Promise<boolean> {
    await this.ready;
    const attachment = this.contexts.read(operationId);
    const delivery = attachment.deliveries.find(item => ['accepted', 'unknown'].includes(item.state));
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
    if (pending && ['accepted', 'unknown', 'dispatching'].includes(pending.state)) throw new Error('Reconcile unresolved source context before succession.');
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

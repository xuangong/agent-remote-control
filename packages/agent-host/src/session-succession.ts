import { isNativeSessionRef, nativeSessionRefKey, successionFreezeKey, type NativeSessionRef, type SuccessionRecord, type SuccessionRequest, type SuccessionAssociationFreeze, type SuccessionParticipant, type TimelineCursor, nativePrefixSelectionKey } from '@orchardworks/agent-remote-protocol';
import { LocalSuccessionPreparation, SuccessionPreparationRejected } from './local-succession-preparation.js';
import { SessionSuccessionStore } from './session-succession-store.js';
import { SuccessionPublicationUnknown } from './succession-persistence.js';
import { AgentOperationRejectedError, AGENT_NATIVE_EVIDENCE_REASONS, type AgentNativeEvidenceCode } from '@orchardworks/agent-provider-sdk';

export interface SuccessionAdmission {
  checkSource(source: NativeSessionRef): void;
  reserve(operationId: string, source: NativeSessionRef, restored?: boolean): void;
  registerCandidate(operationId: string, target: NativeSessionRef): { conflict: boolean };
  assertCommit(operationId: string, sourceBoundary?: TimelineCursor): void;
  releaseReservation(operationId: string, committed?: boolean): void;
}

/** Orchestrates local preparation; transport and UI never manufacture the committed decision. */
export class SessionSuccessionCoordinator {
  private readonly preparing = new Map<string, { identity: string; promise: Promise<SuccessionRecord> }>();
  private admission?: SuccessionAdmission;
  private readonly mutationTails = new Map<string, Promise<unknown>>();
  private admissionGeneration = -1;
  private admissionBlocks = new Map<string, 'reserved' | 'superseded'>();
  constructor(private readonly store: SessionSuccessionStore, private readonly preparation: LocalSuccessionPreparation) {}
  setAdmission(admission: SuccessionAdmission): void { this.admission = admission; }
  status(operationId: string): SuccessionRecord { return this.store.operation(operationId); }

  async prepare(request: SuccessionRequest): Promise<SuccessionRecord> {
    return this.prepareRequest(request, JSON.stringify(['local', requestKey(request)]), () => this.store.begin(request, true));
  }
  async prepareEnrolled(freeze: SuccessionAssociationFreeze, participants: SuccessionParticipant[], generation: number): Promise<SuccessionRecord> {
    if (freeze.request.preparation && freeze.version !== 3) throw new Error('Native prefix enrollment requires v3.');
    if (!this.store.read(freeze.request.roleId).enrollments?.some(saved => saved.request.operationId === freeze.request.operationId)) {
      if (freeze.version === 1) throw new Error('New succession preparation requires a bounded freeze.');
      await this.preparation.supportsBoundedProjection(this.store.read(freeze.request.roleId).role, freeze.request.targetProviderId, freeze.request.preparation);
    }
    return this.prepareRequest(freeze.request, JSON.stringify(['enrolled', successionFreezeKey(freeze)]), () => this.store.beginEnrolled(freeze, participants, generation, true));
  }
  private async prepareRequest(request: SuccessionRequest, identity: string, begin: () => Promise<SuccessionRecord>): Promise<SuccessionRecord> {
    const running = this.preparing.get(request.operationId);
    if (running) {
      if (running.identity !== identity) throw new Error('Succession operation identity conflict.');
      return running.promise;
    }
    const previous = this.store.all().flatMap(state => state.operations).find(record => record.operationId === request.operationId);
    if (previous) {
      const record = await begin();
      if (record.phase !== 'preparing') return this.releaseTerminal(record);
    }
    const promise = this.beginPreparation(request, begin, !!previous);
    this.preparing.set(request.operationId, { identity, promise });
    try { return this.releaseTerminal(await promise); }
    finally { if (this.preparing.get(request.operationId)?.promise === promise) this.preparing.delete(request.operationId); }
  }
  private async beginPreparation(request: SuccessionRequest, begin: () => Promise<SuccessionRecord>, restored: boolean): Promise<SuccessionRecord> {
    const role = this.store.read(request.roleId).role;
    try {
      this.admission?.checkSource(request.from);
      // Native readiness covers work predating this process/cache before enabling evidence pins.
      await this.preparation.check(role, role.current, undefined, request.preparation);
      await this.preparation.supports(role, request.targetProviderId, request.preparation);
    } catch (error) {
      await begin();
      return this.failPreparation(request.operationId, error);
    }
    this.admission?.reserve(request.operationId, request.from, restored);
    try { await begin(); }
    catch (error) { if (!(error instanceof SuccessionPublicationUnknown)) this.admission?.releaseReservation(request.operationId); throw error; }
    return this.run(request.operationId);
  }
  private releaseTerminal(record: SuccessionRecord): SuccessionRecord {
    if (['committed', 'cancelled', 'rejected'].includes(record.phase) && !this.awaitingEnrollmentRelease(record)) this.admission?.releaseReservation(record.operationId, record.phase === 'committed');
    return record;
  }

  private awaitingEnrollmentRelease(record: SuccessionRecord): boolean {
    if (record.phase !== 'committed' || !record.preparation) return false;
    const state = this.store.read(record.roleId);
    const freeze = state.enrollments?.find(item => item.request.operationId === record.operationId);
    return !!freeze && !state.releasedEnrollments?.includes(freeze.token);
  }
  releaseCommitted(operationId: string): void { this.releaseTerminal(this.store.operation(operationId)); }

  /** Serialize local durable boundaries, never an unresolved native call or read. */
  private serialized<T>(operationId: string, run: () => Promise<T>): Promise<T> {
    const next = (this.mutationTails.get(operationId) ?? Promise.resolve()).catch(() => undefined).then(run);
    this.mutationTails.set(operationId, next);
    void next.finally(() => { if (this.mutationTails.get(operationId) === next) this.mutationTails.delete(operationId); }).catch(() => undefined);
    return next;
  }
  private stopped(operationId: string): SuccessionRecord | undefined {
    const record = this.store.operation(operationId);
    return ['committed', 'cancelled', 'rejected'].includes(record.phase) ? record : undefined;
  }
  private async run(operationId: string): Promise<SuccessionRecord> {
    try {
      const record = this.store.operation(operationId), state = this.store.read(record.roleId);
      await this.preparation.check(state.role, record.from, undefined, record.preparation);
      await this.preparation.supports(state.role, record.targetProviderId, record.preparation);
      if (this.stopped(operationId)) return this.store.operation(operationId);
      if (record.preparation) return await this.runNativePrefix(record);
      const nativeCreate = await this.preparation.selectNativeCreation(state.role, operationId, record.targetProviderId);
      const context = await this.preparation.capture(state.role, operationId);
      await this.serialized(operationId, async () => {
        if (this.stopped(operationId)) return;
        if (context.operationId !== operationId || context.roleId !== record.roleId || context.roleRevision !== record.expectedRevision + 1
          || nativeSessionRefKey(context.source) !== nativeSessionRefKey(record.from)) throw new Error('Captured succession context identity changed.');
        await this.preparation.saveContext(context);
        await this.store.savePreparation(operationId, { ...context.boundary, capturedAt: context.capturedAt }, !!nativeCreate);
      });
      if (this.stopped(operationId)) return this.store.operation(operationId);
      const source = await this.preparation.check(state.role);
      if (source.boundary.epoch !== context.boundary.epoch || source.boundary.seq !== context.boundary.seq) throw new SuccessionPreparationRejected('succession_boundary_changed', 'Source history changed before native creation.');
      const started = await this.serialized(operationId, async () => {
        if (this.stopped(operationId)) return undefined;
        await this.store.startCreation(operationId);
        // Wrapping the promise lets cancellation proceed while native creation is unresolved.
        return { result: Promise.resolve().then(async () => nativeCreate ? nativeCreate() : this.preparation.create(state.role, operationId, record.targetProviderId)) };
      });
      if (!started) return this.store.operation(operationId);
      let result;
      try { result = await started.result; }
      catch (error) {
        if (nativeCreate && error instanceof AgentOperationRejectedError && typeof error.code === 'string' && Object.hasOwn(AGENT_NATIVE_EVIDENCE_REASONS, error.code)) {
          await this.serialized(operationId, () => this.store.rejectCreationBeforeDispatch(operationId, error.code as AgentNativeEvidenceCode));
        }
        throw error;
      }
      if (nativeCreate) {
        const outcome = result as Awaited<ReturnType<typeof nativeCreate>>;
        let conflict = false, registrationError: unknown;
        if (outcome.status === 'created' || outcome.status === 'known_rejected') {
          try { conflict = this.admission?.registerCandidate(operationId, { controllerId: record.from.controllerId, providerId: outcome.handle.providerId, nativeSessionId: outcome.handle.sessionId }).conflict ?? false; }
          catch (error) { registrationError = error; }
        }
        await this.serialized(operationId, () => this.store.saveCreationResult(operationId, outcome));
        if (this.stopped(operationId) || outcome.status !== 'created') return this.store.operation(operationId);
        if (registrationError) throw registrationError;
        if (conflict) throw new SuccessionPreparationRejected('succession_candidate_busy', 'Candidate has conflicting Host mutations.');
        return await this.finishCandidate(operationId);
      }
      const target = result as NativeSessionRef;
      if (!isNativeSessionRef(target) || nativeSessionRefKey(target) === nativeSessionRefKey(record.from)) throw new Error('Native creation returned an invalid candidate identity.');
      const conflict = this.admission?.registerCandidate(operationId, target).conflict;
      await this.serialized(operationId, async () => { await this.store.saveCandidate(operationId, target); });
      if (this.stopped(operationId)) return this.store.operation(operationId);
      if (conflict) throw new SuccessionPreparationRejected('succession_candidate_busy', 'Candidate has conflicting Host mutations.');
      return await this.finishCandidate(operationId);
    } catch (error) { return this.failPreparation(operationId, error); }
  }
  private async runNativePrefix(record: SuccessionRecord): Promise<SuccessionRecord> {
    const operationId = record.operationId, role = this.store.read(record.roleId).role;
    const observation = await this.preparation.check(role, record.from, undefined, record.preparation);
    const capture = { ...observation.boundary, capturedAt: new Date().toISOString() };
    await this.serialized(operationId, async () => { if (!this.stopped(operationId)) await this.store.savePreparation(operationId, capture); });
    if (this.stopped(operationId)) return this.store.operation(operationId);
    const source = await this.preparation.check(role, record.from, undefined, record.preparation);
    if (source.boundary.epoch !== capture.epoch || source.boundary.seq !== capture.seq) throw new SuccessionPreparationRejected('succession_boundary_changed', 'Source history changed before native prefix creation.');
    const started = await this.serialized(operationId, async () => {
      if (this.stopped(operationId)) return undefined;
      await this.store.startCreation(operationId);
      return { result: Promise.resolve().then(() => this.preparation.createNativePrefix({ operationId, roleId: record.roleId, expectedRevision: record.expectedRevision,
        from: record.from, ...(record.targetProviderId ? { targetProviderId: record.targetProviderId } : {}), preparation: record.preparation })) };
    });
    if (!started) return this.store.operation(operationId);
    const candidate = await started.result;
    let conflict = false, registrationError: unknown;
    try { conflict = this.admission?.registerCandidate(operationId, candidate.target).conflict ?? false; } catch (error) { registrationError = error; }
    await this.serialized(operationId, () => this.store.saveNativePrefixCandidate(operationId, candidate));
    if (this.stopped(operationId)) return this.store.operation(operationId);
    if (registrationError) throw registrationError;
    if (conflict) throw new SuccessionPreparationRejected('succession_candidate_busy', 'Candidate has conflicting Host mutations.');
    return this.finishCandidate(operationId);
  }
  private async finishCandidate(operationId: string): Promise<SuccessionRecord> {
    const record = this.store.operation(operationId), progress = this.store.progress(operationId), state = this.store.read(record.roleId);
    if (!record.to || progress?.stage !== 'candidate-known' || !progress.capture) throw new Error('Saved candidate preparation is incomplete.');
    if (progress.nativeCreation && progress.nativeCreation.outcome?.status !== 'created') throw new Error('Native creation evidence is not resumable.');
    if (record.to.providerId !== (record.targetProviderId ?? record.from.providerId)) throw new SuccessionPreparationRejected('succession_target_provider_mismatch', 'The candidate provider does not match the selected provider.');
    await this.serialized(operationId, async () => {
      if (this.stopped(operationId)) return;
      if (!record.preparation) await this.preparation.bind(operationId, record.to!);
    });
    if (this.stopped(operationId)) return this.store.operation(operationId);
    await this.preparation.check(state.role, record.to, undefined, record.preparation);
    if (this.stopped(operationId)) return this.store.operation(operationId);
    const prepared = { operationId, roleId: record.roleId, expectedRevision: record.expectedRevision, from: record.from,
      ...(record.targetProviderId ? { targetProviderId: record.targetProviderId } : {}), ...(record.preparation ? { preparation: record.preparation } : {}), to: record.to, workspace: state.role.workspace,
      associationRevision: state.associationRevision, participants: state.participants, capture: progress.capture };
    const verification = await this.preparation.verify(state.role, prepared);
    try {
      return await this.serialized(operationId, async () => { verification.assertCurrent(); return this.stopped(operationId)
        ?? await this.store.advance(operationId, 'transferring', { phase: 'ready', prepared }); });
    } finally { verification.release(); }
  }
  private async failPreparation(operationId: string, error: unknown): Promise<SuccessionRecord> {
    if (error instanceof SuccessionPublicationUnknown) throw error;
    return this.serialized(operationId, async () => {
      const stopped = this.stopped(operationId); if (stopped) return this.releaseTerminal(stopped);
      const progress = this.store.progress(operationId);
      const safe = progress?.stage === 'not-started' || progress?.stage === 'candidate-known';
      return this.releaseTerminal(await this.store.settlePreparation(operationId, safe ? 'rejected' : 'unknown', error instanceof SuccessionPreparationRejected ? error.code : safe ? 'succession_preparation_failed' : 'succession_creation_unknown'));
    });
  }
  async commit(operationId: string, expectedRevision: number): Promise<SuccessionRecord> {
    const record = this.store.operation(operationId);
    if (record.expectedRevision !== expectedRevision) throw new Error('Succession revision changed.');
    if (record.phase === 'committed') { this.store.assertCommittedProjection(operationId); return record; }
    if (record.phase !== 'ready' || !record.prepared) throw new Error('Succession is not ready.');
    const generation = this.store.generation;
    const verification = await this.preparation.verify(this.store.read(record.roleId).role, record.prepared);
    try {
      return await this.serialized(operationId, async () => this.releaseTerminal(await this.store.commit(operationId, generation, () => {
        this.admission?.assertCommit(operationId, record.prepared!.capture);
        verification.assertCurrent();
      })));
    } finally { verification.release(); }
  }
  /** Explicitly read-verify saved local data; recovery never replays native creation. */
  async reconcileReady(operationId: string): Promise<SuccessionRecord> {
    const record = await this.serialized(operationId, async () => {
      const record = this.store.operation(operationId), progress = this.store.progress(operationId);
      if (record.phase === 'cancelled' || record.phase === 'rejected') return record;
      if (record.phase !== 'unknown' || !progress?.stage) throw new Error('This unknown outcome requires native effect reconciliation.');
      if (progress.stage === 'not-started') return this.store.settlePreparation(operationId, 'rejected', 'succession_precreate_interrupted');
      if (progress.stage !== 'candidate-known') throw new Error('Native creation is unknown; explicitly cancel the certified handoff intent.');
      return this.store.revalidateCandidate(operationId);
    });
    if (record.phase !== 'transferring') return this.releaseTerminal(record);
    try {
      const role = this.store.read(record.roleId).role;
      await this.preparation.check(role, record.from, undefined, record.preparation); await this.preparation.supports(role, record.targetProviderId, record.preparation);
      const terminal = await this.serialized(operationId, async () => {
        const stopped = this.stopped(operationId); if (stopped) return this.releaseTerminal(stopped);
        const current = this.store.operation(operationId);
        if (current.phase !== 'transferring') throw new Error('Succession recovery changed.');
        this.admission?.reserve(operationId, current.from, true);
        if (current.to && this.admission?.registerCandidate(operationId, current.to).conflict) throw new Error('Candidate has conflicting Host mutations.');
        return undefined;
      });
      if (terminal) return terminal;
      return this.releaseTerminal(await this.finishCandidate(operationId));
    }
    catch (error) { return this.failPreparation(operationId, error); }
  }
  async cancel(operationId: string): Promise<SuccessionRecord> {
    return this.serialized(operationId, async () => {
      const record = this.store.operation(operationId);
      if (record.phase === 'cancelled') return this.releaseTerminal(record);
      if (record.phase === 'committed' || record.phase === 'rejected') throw new Error('Handoff cannot be cancelled in this phase.');
      return this.releaseTerminal(await this.store.settlePreparation(operationId, 'cancelled'));
    });
  }

  /** Invoke at native mutation admission; historical reads remain available. */
  assertAdmission(session: NativeSessionRef): void {
    this.refreshAdmission();
    const reason = this.admissionBlocks.get(nativeSessionRefKey(session));
    if (reason === 'reserved') throw new Error('This session is reserved for handoff and is not ready for new input.');
    if (reason === 'superseded') throw new Error('This session has been superseded. Open its current successor.');
  }

  /** Metadata relationships retain immutable source grants after succession. */
  assertReservation(session: NativeSessionRef): void {
    this.refreshAdmission();
    if (this.admissionBlocks.get(nativeSessionRefKey(session)) === 'reserved') throw new Error('This session is reserved for handoff.');
  }

  private refreshAdmission(): void {
    if (this.admissionGeneration === this.store.generation) return;
    const blocks = new Map<string, 'reserved' | 'superseded'>();
    for (const state of this.store.all()) {
      const current = nativeSessionRefKey(state.role.current);
      for (const record of state.operations) {
        const from = nativeSessionRefKey(record.from);
        if (!['committed', 'cancelled', 'rejected'].includes(record.phase)) {
          blocks.set(from, 'reserved');
          if (record.to) blocks.set(nativeSessionRefKey(record.to), 'reserved');
        }
        if (this.awaitingEnrollmentRelease(record) && record.to) blocks.set(nativeSessionRefKey(record.to), 'reserved');
        if (record.phase === 'committed' && from !== current && blocks.get(from) !== 'reserved') blocks.set(from, 'superseded');
      }
    }
    this.admissionBlocks = blocks; this.admissionGeneration = this.store.generation;
  }
}

function requestKey(request: SuccessionRequest): string { return JSON.stringify([request.operationId, request.roleId, request.expectedRevision, nativeSessionRefKey(request.from), request.targetProviderId ?? null, ...(request.preparation ? [nativePrefixSelectionKey(request.preparation)] : [])]); }

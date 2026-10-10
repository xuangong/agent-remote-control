import { nativeSessionRefKey, type NativeSessionRef, type SuccessionRecord, type SuccessionRequest } from '@orchardworks/agent-remote-protocol';
import { LocalSuccessionPreparation, SuccessionPreparationRejected } from './local-succession-preparation.js';
import { SessionSuccessionStore } from './session-succession-store.js';

/** Orchestrates local preparation; transport and UI never manufacture the committed decision. */
export class SessionSuccessionCoordinator {
  private readonly preparing = new Map<string, Promise<SuccessionRecord>>();
  private admissionGeneration = -1;
  private admissionBlocks = new Map<string, 'reserved' | 'superseded'>();
  constructor(private readonly store: SessionSuccessionStore, private readonly preparation: LocalSuccessionPreparation) {}
  status(operationId: string): SuccessionRecord { return this.store.operation(operationId); }

  async prepare(request: SuccessionRequest): Promise<SuccessionRecord> {
    const record = await this.store.begin(request);
    const running = this.preparing.get(request.operationId);
    if (running) return running;
    if (record.phase !== 'preparing') return record;
    const promise = this.run(request.operationId);
    this.preparing.set(request.operationId, promise);
    try { return await promise; }
    finally { if (this.preparing.get(request.operationId) === promise) this.preparing.delete(request.operationId); }
  }

  private async run(operationId: string): Promise<SuccessionRecord> {
    let target: NativeSessionRef | undefined;
    try {
      const record = this.store.operation(operationId);
      const state = this.store.read(record.roleId);
      await this.preparation.check(state.role);
      await this.store.advance(operationId, 'preparing', { phase: 'quiescing' });
      target = await this.preparation.create(state.role, operationId, record.targetProviderId);
      await this.store.advance(operationId, 'quiescing', { phase: 'transferring', to: target });
      if (target.providerId !== (record.targetProviderId ?? record.from.providerId)) throw new SuccessionPreparationRejected('succession_target_provider_mismatch', 'The candidate provider does not match the selected provider.');
      await this.preparation.check(state.role, target);
      const capture = await this.preparation.transfer(state.role, target, operationId);
      const prepared = { operationId, roleId: record.roleId, expectedRevision: record.expectedRevision,
        from: record.from, ...(record.targetProviderId ? { targetProviderId: record.targetProviderId } : {}), to: target, workspace: state.role.workspace,
        associationRevision: state.associationRevision, participants: state.participants, capture };
      await this.preparation.verify(state.role, prepared);
      return await this.store.advance(operationId, 'transferring', { phase: 'ready', prepared });
    } catch (error) {
      const record = this.store.operation(operationId);
      if (['committed', 'cancelled', 'rejected', 'unknown'].includes(record.phase)) throw error;
      return this.store.advance(operationId, record.phase, {
        phase: error instanceof SuccessionPreparationRejected ? 'rejected' : 'unknown',
        ...(target ? { to: target } : {}),
        failureCode: error instanceof SuccessionPreparationRejected ? error.code : 'succession_outcome_unknown',
      });
    }
  }

  async commit(operationId: string, expectedRevision: number): Promise<SuccessionRecord> {
    const record = this.store.operation(operationId);
    if (record.expectedRevision !== expectedRevision) throw new Error('Succession revision changed.');
    if (record.phase === 'committed') return record;
    if (record.phase !== 'ready' || !record.prepared) throw new Error('Succession is not ready.');
    const generation = this.store.generation;
    await this.preparation.verify(this.store.read(record.roleId).role, record.prepared);
    return this.store.commit(operationId, generation);
  }

  /** Only a persisted, fully prepared candidate can be revalidated without replaying effects. */
  async reconcileReady(operationId: string): Promise<SuccessionRecord> {
    const record = this.store.operation(operationId);
    if (record.phase !== 'unknown' || record.resumePhase !== 'ready' || !record.prepared) throw new Error('This unknown outcome requires native effect reconciliation.');
    await this.preparation.verify(this.store.read(record.roleId).role, record.prepared);
    return this.store.advance(operationId, 'unknown', { phase: 'ready' });
  }

  async cancel(operationId: string): Promise<SuccessionRecord> {
    if (this.preparing.has(operationId)) throw new Error('Handoff preparation is still running. Wait for its outcome before cancelling.');
    const record = this.store.operation(operationId);
    if (record.phase === 'cancelled') return record;
    if (record.phase === 'unknown') throw new Error('Reconcile the unknown handoff outcome before cancelling.');
    if (record.phase !== 'ready' && record.phase !== 'preparing') throw new Error('Handoff cannot be cancelled in this phase.');
    return this.store.advance(operationId, record.phase, { phase: 'cancelled' });
  }

  /** Invoke at native mutation admission; historical reads remain available. */
  assertAdmission(session: NativeSessionRef): void {
    this.refreshAdmission();
    const reason = this.admissionBlocks.get(nativeSessionRefKey(session));
    if (reason === 'reserved') throw new Error('This session is reserved for handoff and is not ready for new input.');
    if (reason === 'superseded') throw new Error('This session has been superseded. Open its current successor.');
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
        if (record.phase === 'committed' && from !== current) blocks.set(from, 'superseded');
      }
    }
    this.admissionBlocks = blocks; this.admissionGeneration = this.store.generation;
  }
}

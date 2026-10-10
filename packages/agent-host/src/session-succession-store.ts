import { sourceParticipantId } from './source-participant.js';
import { isRelationChangeReservation, isRelationChangeReceipt, relationChangeKey, type RelationChangeReservation, type RelationChangeReceipt } from '@orchardworks/agent-remote-protocol';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { assertSuccessionCapacity, isReservation, jsonBytes, largestSuccessionId, largestSuccessionRef, publishSuccessionState, reservationBytes, SuccessionPublicationUnknown } from './succession-persistence.js';
import { successionAuthorityKey, successionFreezeKey, isNativeSessionRef, isSuccessionAssociationAuthority, isSuccessionAssociationFreeze, type SuccessionAssociationAuthority, type SuccessionAssociationFreeze, type NativeSessionRef, isPrimaryRole, isPreparedSuccession, isSuccessionParticipant, isSuccessionRecord, isSuccessionRequest, nativeSessionRefKey,
  type PrimaryRole, type SuccessionParticipant, type SuccessionPhase, type SuccessionRecord, type SuccessionRequest } from '@orchardworks/agent-remote-protocol';

export interface LocalSuccessionProgress {
  operationId: string;
  reservedBytes: string;
  stage?: 'not-started' | 'create-started' | 'candidate-known';
  createOperationId?: string;
  zeroInputAndTask?: true;
  capture?: NonNullable<SuccessionRecord['prepared']>['capture'];
  orphanCandidate?: NativeSessionRef;
}
export interface SuccessionRoleState {
  localPreparations?: LocalSuccessionProgress[];
  relationChanges?: RelationChangeReceipt[];
  associationAuthority?: SuccessionAssociationAuthority;
  enrollments?: SuccessionAssociationFreeze[];
  releasedEnrollments?: string[];
  role: PrimaryRole;
  operations: SuccessionRecord[];
  associationRevision: number;
  participants: SuccessionParticipant[];
}
export interface SourceAssociationResult { id: string; fingerprint: string; scope: string; operationId: string; source: NativeSessionRef; reader: NativeSessionRef }
export interface AssociationRecovery { createKey: string; createFingerprint: string }
interface StoreState { version: 4; associationResults: SourceAssociationResult[]; roles: SuccessionRoleState[]; associationAdmissions: Array<{ id: string; fingerprint: string; source: NativeSessionRef; sourceReader?: true; recovery?: AssociationRecovery }> }
type Advance = Pick<SuccessionRecord, 'phase'> & Partial<Pick<SuccessionRecord, 'to' | 'prepared' | 'failureCode'>>;
const terminal = (phase: SuccessionPhase) => ['committed', 'rejected', 'cancelled'].includes(phase);
const fingerprint = (request: SuccessionRequest) => JSON.stringify([request.operationId, request.roleId, request.expectedRevision, nativeSessionRefKey(request.from), request.targetProviderId ?? request.from.providerId]);
const maxBytes = 8 * 1024 * 1024;

/** One owning Controller serializes role decisions; publication follows atomic file replacement. */
export class SessionSuccessionStore {
  readonly ready: Promise<void>;
  private state: StoreState = { version: 4, roles: [], associationAdmissions: [], associationResults: [] };
  private tail: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private writeFailure?: SuccessionPublicationUnknown;
  private revision = 0;
  private pendingReaderGeneration = -1;
  private pendingReaders = new Set<string>();
  constructor(private readonly directory: string) { this.ready = this.restore(); }
  get generation(): number { this.assertReadable(); return this.revision; }

  private assertReadable(): void {
    if (this.writeFailure) throw this.writeFailure;
    if (!this.loaded) throw new Error('Session succession store is not ready.');
  }
  progress(operationId: string): LocalSuccessionProgress | undefined {
    this.assertReadable();
    return structuredClone(this.state.roles.flatMap(item => item.localPreparations ?? []).find(item => item.operationId === operationId));
  }

  read(roleId: string): SuccessionRoleState {
    this.assertReadable();
    return structuredClone(this.findRole(this.state, roleId));
  }
  operation(operationId: string): SuccessionRecord {
    this.assertReadable();
    return structuredClone(this.findOperation(this.state, operationId));
  }
  all(): SuccessionRoleState[] {
    this.assertReadable();
    return structuredClone(this.state.roles);
  }

  relationChange(operationId: string): RelationChangeReceipt | undefined {
    this.assertReadable();
    const receipt = this.state.roles.flatMap(item => item.relationChanges ?? []).find(item => item.reservation.operationId === operationId);
    return receipt && structuredClone(receipt);
  }
  readerAssociationState(reader: NativeSessionRef): { pending: boolean } {
    this.assertReadable();
    if (this.pendingReaderGeneration !== this.generation) {
      this.pendingReaders = new Set(this.state.roles.flatMap(item => (item.relationChanges ?? []).filter(change => change.phase !== 'released').map(change => nativeSessionRefKey(change.reservation.readerRef))));
      this.pendingReaderGeneration = this.generation;
    }
    return { pending: this.pendingReaders.has(nativeSessionRefKey(reader)) };
  }
  reserveRelationChange(reservation: RelationChangeReservation, generation: number): Promise<RelationChangeReceipt> {
    const input = structuredClone(reservation);
    return this.mutate(state => {
      if (!isRelationChangeReservation(input)) throw new Error('Invalid relation change reservation.');
      const prior = state.roles.flatMap(item => item.relationChanges ?? []).find(item => item.reservation.operationId === input.operationId);
      if (prior) { if (relationChangeKey(prior.reservation) !== relationChangeKey(input)) throw new Error('Relation operation identity conflict.'); return prior; }
      const item = this.findRole(state, input.roleId);
      this.assertRelationRole(item, input);
      if (this.generation !== generation) throw new Error('Source associations changed during relation validation.');
      this.assertRelationOpen(state, item);
      if ((item.relationChanges?.length ?? 0) >= 512 || item.associationRevision >= Number.MAX_SAFE_INTEGER) throw new Error('Relation change storage or revision is exhausted.');
      if (input.linked && !input.previousMember && item.participants.length >= 1024) throw new Error('Primary role participant storage is full.');
      this.assertRelationMember(state, item, input);
      const receipt: RelationChangeReceipt = { reservation: input, phase: 'reserved', associationRevision: item.associationRevision };
      (item.relationChanges ??= []).push(receipt); return receipt;
    });
  }
  applyRelationChange(reservation: RelationChangeReservation, generation?: number): Promise<RelationChangeReceipt> {
    const input = structuredClone(reservation);
    return this.mutate(state => {
      const item = this.findRole(state, input.roleId), receipt = this.exactRelation(item, input);
      if (receipt.phase !== 'reserved') return receipt;
      this.assertRelationRole(item, input);
      if (generation !== undefined && generation !== this.generation) throw new Error('Source associations changed during relation validation.');
      this.assertRelationMember(state, item, input);
      const id = sourceParticipantId(input.readerRef, input.relationId);
      if (input.linked !== input.previousMember) {
        if (item.associationRevision >= Number.MAX_SAFE_INTEGER) throw new Error('Primary association revision is exhausted.');
        if (input.linked) item.participants.push({ relationId: id, kind: input.kind, before: input.readerRef, after: input.readerRef });
        else item.participants = item.participants.filter(participant => participant.relationId !== id);
        item.associationRevision++;
      }
      receipt.phase = 'applied'; receipt.associationRevision = item.associationRevision; return receipt;
    });
  }
  releaseRelationChange(reservation: RelationChangeReservation, associationRevision: number): Promise<RelationChangeReceipt> {
    const input = structuredClone(reservation);
    return this.mutate(state => {
      const item = this.findRole(state, input.roleId), receipt = this.exactRelation(item, input);
      if (receipt.phase === 'reserved') throw new Error('Relation change is not durably applied.');
      if (receipt.associationRevision !== associationRevision) throw new Error('Applied relation receipt changed.');
      if (receipt.phase === 'released') return receipt;
      if (item.associationRevision !== associationRevision || item.role.revision !== input.expectedRoleRevision) throw new Error('Applied relation state changed.');
      const member = item.participants.find(participant => participant.relationId === sourceParticipantId(input.readerRef, input.relationId));
      const readerKey = nativeSessionRefKey(input.readerRef);
      if (!!member !== input.linked || member && (member.kind !== input.kind || nativeSessionRefKey(member.before) !== readerKey || nativeSessionRefKey(member.after) !== readerKey)) throw new Error('Applied relation membership changed.');
      receipt.phase = 'released'; return receipt;
    });
  }
  private exactRelation(item: SuccessionRoleState, input: RelationChangeReservation): RelationChangeReceipt {
    if (!isRelationChangeReservation(input)) throw new Error('Invalid relation change reservation.');
    const receipt = item.relationChanges?.find(change => change.reservation.operationId === input.operationId);
    if (!receipt || relationChangeKey(receipt.reservation) !== relationChangeKey(input)) throw new Error('Relation operation identity conflict.');
    return receipt;
  }
  private assertRelationRole(item: SuccessionRoleState, input: RelationChangeReservation): void {
    if (!item.associationAuthority || successionAuthorityKey(item.associationAuthority) !== successionAuthorityKey(input.authority)) throw new Error('Relation association authority changed.');
    if (item.role.revision !== input.expectedRoleRevision || item.associationRevision !== input.associationRevision
      || nativeSessionRefKey(item.role.current) !== nativeSessionRefKey(input.current) || nativeSessionRefKey(item.role.origin) !== nativeSessionRefKey(input.origin)
      || JSON.stringify(this.lineage(item).map(nativeSessionRefKey)) !== JSON.stringify(input.lineage.map(nativeSessionRefKey))) throw new Error('Relation role or association revision changed.');
  }
  private assertRelationOpen(state: StoreState, item: SuccessionRoleState): void {
    if (item.operations.some(operation => !terminal(operation.phase)) || item.enrollments?.some(receipt => !item.releasedEnrollments?.includes(receipt.token))
      || item.relationChanges?.some(change => change.phase !== 'released')) throw new Error('Primary role associations are reserved.');
    const lineage = new Set(this.lineage(item).map(nativeSessionRefKey));
    if (state.associationAdmissions.some(admission => lineage.has(nativeSessionRefKey(admission.source)))) throw new Error('Source association outcome is unresolved.');
  }
  private assertRelationMember(state: StoreState, item: SuccessionRoleState, input: RelationChangeReservation): void {
    const id = sourceParticipantId(input.readerRef, input.relationId), key = nativeSessionRefKey(input.readerRef);
    const member = item.participants.find(participant => participant.relationId === id);
    if (!!member !== input.previousMember || member && (member.kind !== input.kind || nativeSessionRefKey(member.before) !== key || nativeSessionRefKey(member.after) !== key)) throw new Error('Relation participant membership changed.');
    if (state.roles.some(role => role.participants.some(participant => participant.kind !== 'tpm' && nativeSessionRefKey(participant.after) === key
      && (role !== item || participant.relationId !== id)))) throw new Error('Reader belongs to another relation or role.');
  }

  createRole(role: PrimaryRole): Promise<PrimaryRole> {
    const input = structuredClone(role);
    return this.mutate(state => {
      if (!isPrimaryRole(input) || input.revision !== 1 || nativeSessionRefKey(input.origin) !== nativeSessionRefKey(input.current)) throw new Error('Invalid initial primary role.');
      if (state.roles.some(item => item.role.id === input.id || nativeSessionRefKey(item.role.current) === nativeSessionRefKey(input.current))) throw new Error('Primary role already exists.');
      if (state.roles.length >= 1024) throw new Error('Primary role storage is full.');
      state.roles.push({ role: input, operations: [], associationRevision: 0, participants: [] }); return input;
    });
  }

  /** Called with Controller-verified relationships, never an unverified browser participant list. */
  setParticipants(roleId: string, expectedRevision: number, associationRevision: number, participants: SuccessionParticipant[]): Promise<SuccessionRoleState> {
    const input = structuredClone(participants);
    return this.mutate(state => {
      const item = this.findRole(state, roleId);
      if (item.associationAuthority) throw new Error('An authenticated association reservation is required.');
      if (item.role.revision !== expectedRevision || item.associationRevision !== associationRevision) throw new Error('Primary role association revision changed.');
      if (item.relationChanges?.some(change => change.phase !== 'released')) throw new Error('Primary role associations are reserved.');
      if (item.operations.some(op => !terminal(op.phase))) throw new Error('Primary role is reserved by a succession in progress.');
      if (JSON.stringify(item.participants) === JSON.stringify(input)) return item;
      if (item.associationRevision >= Number.MAX_SAFE_INTEGER) throw new Error('Primary association revision is exhausted.');
      item.participants = input; item.associationRevision++; return item;
    });
  }

  ensureRole(source: NativeSessionRef, canonicalCwd: string): Promise<PrimaryRole> {
    source = structuredClone(source);
    return this.mutate(state => {
      const existing = state.roles.find(item => this.lineage(item).some(ref => nativeSessionRefKey(ref) === nativeSessionRefKey(source)));
      if (existing) return existing.role;
      const id = `primary-${createHash('sha256').update(nativeSessionRefKey(source)).digest('hex')}`;
      const role: PrimaryRole = { id, revision: 1, origin: source, current: source, workspace: { controllerId: source.controllerId, canonicalCwd } };
      if (!isPrimaryRole(role) || state.roles.length >= 1024) throw new Error('Invalid or full primary role storage.');
      state.roles.push({ role, operations: [], associationRevision: 0, participants: [] });
      return role;
    });
  }
  lineage(item: SuccessionRoleState): NativeSessionRef[] {
    return [item.role.origin, ...item.operations.filter(operation => operation.phase === 'committed').map(operation => operation.to!)];
  }
  admitAssociation(id: string, fingerprint: string, source: NativeSessionRef, sourceReader = false, recovery?: AssociationRecovery): Promise<void> {
    source = structuredClone(source); recovery = structuredClone(recovery);
    return this.mutate(state => {
      const prior = state.associationAdmissions.find(item => item.id === id);
      if (prior) throw new Error(prior.fingerprint === fingerprint ? 'Source association outcome is unresolved.' : 'Source association identity conflict.');
      const role = state.roles.find(item => this.lineage(item).some(ref => nativeSessionRefKey(ref) === nativeSessionRefKey(source)));
      if (role?.relationChanges?.some(change => change.phase !== 'released') || role?.enrollments?.some(receipt => !role.releasedEnrollments?.includes(receipt.token)) || role?.operations.some(operation => !terminal(operation.phase))) throw new Error('Source associations are reserved by succession.');
      if (role && nativeSessionRefKey(role.role.current) !== nativeSessionRefKey(source)) throw new Error('Source session has been superseded.');
      if (sourceReader && state.associationResults.length + state.associationAdmissions.filter(item => item.sourceReader).length >= 1024) throw new Error('Source creation result storage is full.');
      if (state.associationAdmissions.length >= 1024) throw new Error('Source association admission storage is full. Resolve unsettled operations.');
      state.associationAdmissions.push({ id, fingerprint, source, ...(sourceReader ? { sourceReader: true as const } : {}), ...(recovery ? { recovery } : {}) });
    });
  }
  sourceResult(id: string, fingerprint: string): SourceAssociationResult | undefined {
    this.assertReadable();
    const result = this.state.associationResults.find(item => item.id === id);
    if (result && result.fingerprint !== fingerprint) throw new Error('Source creation identity conflict.');
    return result && structuredClone(result);
  }
  completeSourceAssociation(result: SourceAssociationResult): Promise<void> {
    const input = structuredClone(result);
    return this.mutate(state => {
      const admission = state.associationAdmissions.find(item => item.id === input.id);
      if (!admission?.sourceReader || admission.fingerprint !== input.fingerprint || nativeSessionRefKey(admission.source) !== nativeSessionRefKey(input.source)) throw new Error('Source creation admission changed.');
      if (state.associationResults.length >= 1024 || state.associationResults.some(item => item.id === input.id)) throw new Error('Source creation result storage is full or conflicting.');
      state.associationResults.push(input);
      state.associationAdmissions = state.associationAdmissions.filter(item => item.id !== input.id);
    });
  }
  settleRecoveredAssociation(recovery: AssociationRecovery, source: NativeSessionRef): Promise<void> {
    const evidence = structuredClone(recovery), target = structuredClone(source);
    return this.mutate(state => {
      const pending = state.associationAdmissions.filter(item => item.recovery?.createKey === evidence.createKey);
      if (pending.some(item => item.recovery?.createFingerprint !== evidence.createFingerprint || nativeSessionRefKey(item.source) !== nativeSessionRefKey(target))) throw new Error('Recovered source association evidence conflicts with admission.');
      state.associationAdmissions = state.associationAdmissions.filter(item => item.recovery?.createKey !== evidence.createKey);
    });
  }
  settleAssociation(id: string, fingerprint: string, allowMissing = false): Promise<void> {
    return this.mutate(state => {
      const prior = state.associationAdmissions.find(item => item.id === id);
      if (!prior && allowMissing) return;
      if (!prior || prior.fingerprint !== fingerprint) throw new Error('Source association identity conflict.');
      state.associationAdmissions = state.associationAdmissions.filter(item => item.id !== id);
    });
  }
  beginEnrolled(freeze: SuccessionAssociationFreeze, participants: SuccessionParticipant[], generation: number, local = false): Promise<SuccessionRecord> {
    const receipt = structuredClone(freeze), enrolled = structuredClone(participants);
    return this.mutate(state => {
      if (!isSuccessionAssociationFreeze(receipt)) throw new Error('Invalid association receipt.');
      const item = this.findRole(state, receipt.request.roleId);
      const previous = item.enrollments?.find(value => value.request.operationId === receipt.request.operationId);
      if (previous) {
        if (successionFreezeKey(previous) !== successionFreezeKey(receipt)) throw new Error('Association receipt conflict.');
        return this.findOperation(state, receipt.request.operationId);
      }
      if (item.relationChanges?.some(change => change.phase !== 'released')) throw new Error('Primary role associations are reserved.');
      if (item.operations.some(operation => operation.operationId === receipt.request.operationId)) throw new Error('Operation has no matching association receipt.');
      if (item.enrollments?.some(receipt => !item.releasedEnrollments?.includes(receipt.token))) throw new Error('Previous association reservation has not been released.');
      if (item.associationRevision >= Number.MAX_SAFE_INTEGER) throw new Error('Primary association revision is exhausted.');
      if (this.generation !== generation) throw new Error('Source associations changed during enrollment.');
      if (item.associationAuthority && successionAuthorityKey(item.associationAuthority) !== successionAuthorityKey(receipt.authority)) throw new Error('Primary role belongs to another association authority.');
      const lineage = this.lineage(item);
      if (JSON.stringify(lineage.map(nativeSessionRefKey)) !== JSON.stringify(receipt.lineage.map(nativeSessionRefKey))) throw new Error('Primary role lineage changed.');
      if (state.associationAdmissions.some(admission => lineage.some(ref => nativeSessionRefKey(ref) === nativeSessionRefKey(admission.source)))) throw new Error('Source association outcome is unresolved.');
      const record = this.beginRecord(state, receipt.request, local);
      item.associationAuthority = receipt.authority;
      (item.enrollments ??= []).push(receipt);
      item.participants = enrolled; item.associationRevision++;
      return record;
    });
  }
  /** Cancel an authenticated reservation before enrollment without certifying its participant snapshot. */
  cancelUnenrolled(freeze: SuccessionAssociationFreeze): Promise<SuccessionRecord> {
    const receipt = structuredClone(freeze);
    return this.mutate(state => {
      if (!isSuccessionAssociationFreeze(receipt)) throw new Error('Invalid association receipt.');
      const item = this.findRole(state, receipt.request.roleId);
      const previous = item.enrollments?.find(value => value.request.operationId === receipt.request.operationId);
      if (previous) {
        if (successionFreezeKey(previous) !== successionFreezeKey(receipt)) throw new Error('Association receipt conflict.');
        const record = this.findOperation(state, receipt.request.operationId);
        if (record.phase !== 'cancelled') throw new Error('Reservation was enrolled concurrently; read its durable outcome before cancelling.');
        return record;
      }
      if (item.relationChanges?.some(change => change.phase !== 'released')) throw new Error('Primary role associations are reserved.');
      if (item.operations.some(operation => operation.operationId === receipt.request.operationId)) throw new Error('Operation has no matching association receipt.');
      if (item.associationAuthority && successionAuthorityKey(item.associationAuthority) !== successionAuthorityKey(receipt.authority)) throw new Error('Primary role belongs to another association authority.');
      if (item.enrollments?.some(value => !item.releasedEnrollments?.includes(value.token))) throw new Error('Previous association reservation has not been released.');
      if (JSON.stringify(this.lineage(item).map(nativeSessionRefKey)) !== JSON.stringify(receipt.lineage.map(nativeSessionRefKey))) throw new Error('Primary role lineage changed.');
      const record = this.beginRecord(state, receipt.request);
      record.phase = 'cancelled';
      item.associationAuthority = receipt.authority;
      (item.enrollments ??= []).push(receipt);
      return record;
    });
  }
  releaseEnrollment(freeze: SuccessionAssociationFreeze): Promise<void> {
    const receipt = structuredClone(freeze);
    return this.mutate(state => {
      const item = this.findRole(state, receipt.request.roleId);
      const saved = item.enrollments?.find(value => value.token === receipt.token);
      if (!saved || successionFreezeKey(saved) !== successionFreezeKey(receipt)) throw new Error('Association receipt conflict.');
      if (!terminal(this.findOperation(state, receipt.request.operationId).phase)) throw new Error('Unknown association decisions remain reserved.');
      if (!item.releasedEnrollments?.includes(receipt.token)) (item.releasedEnrollments ??= []).push(receipt.token);
    });
  }
  begin(request: SuccessionRequest, local = false): Promise<SuccessionRecord> {
    const input = structuredClone(request);
    return this.mutate(state => {
      if (this.findRole(state, input.roleId).associationAuthority) throw new Error('An authenticated association reservation is required.');
      return this.beginRecord(state, input, local);
    });
  }
  private beginRecord(state: StoreState, input: SuccessionRequest, local = false): SuccessionRecord {
    if (!isSuccessionRequest(input)) throw new Error('Invalid succession request.');
    const prior = state.roles.flatMap(item => item.operations).find(op => op.operationId === input.operationId);
    if (prior) {
      if (fingerprint(prior) !== fingerprint(input)) throw new Error('Succession operation identity conflict.');
      return prior;
    }
    const item = this.findRole(state, input.roleId);
    if (item.role.revision !== input.expectedRevision || nativeSessionRefKey(item.role.current) !== nativeSessionRefKey(input.from)) throw new Error('Primary role revision changed.');
    if (item.relationChanges?.some(change => change.phase !== 'released')) throw new Error('Primary role associations are reserved.');
      if (item.operations.some(op => !terminal(op.phase))) throw new Error('Primary role is reserved by a succession in progress.');
    if (item.operations.length >= 512) throw new Error('Succession history is full.');
    const now = new Date().toISOString();
    const record: SuccessionRecord = { ...input, phase: 'preparing', startedAt: now, updatedAt: now };
    item.operations.push(record);
    (item.localPreparations ??= []).push({ operationId: record.operationId, reservedBytes: '00000000', ...(local ? { stage: 'not-started' as const } : {}) });
    return record;
  }

  savePreparation(operationId: string, capture: NonNullable<SuccessionRecord['prepared']>['capture']): Promise<void> {
    const saved = structuredClone(capture);
    return this.mutate(state => {
      const record = this.findOperation(state, operationId), progress = this.localProgress(state, record);
      if (record.phase !== 'preparing' || progress.stage !== 'not-started') throw new Error('Local preparation stage changed.');
      Object.assign(progress, { capture: saved, createOperationId: `${operationId}:create`, zeroInputAndTask: true });
    });
  }
  startCreation(operationId: string): Promise<void> {
    return this.mutate(state => {
      const record = this.findOperation(state, operationId), progress = this.localProgress(state, record);
      if (record.phase !== 'preparing' || progress.stage !== 'not-started' || !progress.capture || !progress.zeroInputAndTask) throw new Error('Native creation was not prepared.');
      progress.stage = 'create-started'; record.phase = 'quiescing'; record.updatedAt = new Date().toISOString();
    });
  }
  saveCandidate(operationId: string, target: NativeSessionRef): Promise<SuccessionRecord> {
    const candidate = structuredClone(target);
    return this.mutate(state => {
      if (!isNativeSessionRef(candidate)) throw new Error('Invalid native candidate identity.');
      const record = this.findOperation(state, operationId), progress = this.localProgress(state, record);
      if (progress.stage !== 'create-started' || !progress.zeroInputAndTask) throw new Error('Native candidate has no creation request.');
      if (record.phase === 'cancelled') {
        if (progress.orphanCandidate && nativeSessionRefKey(progress.orphanCandidate) !== nativeSessionRefKey(candidate)) throw new Error('Orphan candidate identity changed.');
        progress.orphanCandidate = candidate; return record;
      }
      if (terminal(record.phase)) throw new Error('Succession is already terminal.');
      if (nativeSessionRefKey(candidate) === nativeSessionRefKey(record.from)) throw new Error('Native candidate is the source session.');
      progress.stage = 'candidate-known'; record.to = candidate; record.phase = 'transferring';
      delete record.resumePhase; record.updatedAt = new Date().toISOString(); return record;
    });
  }
  settlePreparation(operationId: string, phase: 'rejected' | 'cancelled' | 'unknown', failureCode?: string): Promise<SuccessionRecord> {
    return this.mutate(state => {
      const record = this.findOperation(state, operationId), progress = this.localProgress(state, record);
      if (terminal(record.phase)) return record;
      if (!progress.stage) throw new Error('Legacy unknown preparation requires native reconciliation.');
      if (phase !== 'unknown' && progress.stage === 'create-started' && (phase !== 'cancelled' || !progress.zeroInputAndTask)) throw new Error('Unknown creation remains reserved.');
      if (phase === 'unknown') {
        if (record.phase !== 'unknown') record.resumePhase = record.phase as SuccessionRecord['resumePhase'];
      } else delete record.resumePhase;
      record.phase = phase; record.updatedAt = new Date().toISOString();
      if (failureCode) record.failureCode = failureCode;
      return record;
    });
  }
  revalidateCandidate(operationId: string): Promise<SuccessionRecord> {
    return this.mutate(state => {
      const record = this.findOperation(state, operationId), progress = this.localProgress(state, record);
      if (record.phase !== 'unknown' || progress.stage !== 'candidate-known' || !record.to || !progress.capture) throw new Error('No saved candidate can be revalidated.');
      record.phase = 'transferring'; delete record.resumePhase; return record;
    });
  }
  private localProgress(state: StoreState, record: SuccessionRecord): LocalSuccessionProgress {
    const item = this.findRole(state, record.roleId);
    let progress = item.localPreparations?.find(value => value.operationId === record.operationId);
    if (!progress) {
      progress = { operationId: record.operationId, reservedBytes: '00000000' };
      (item.localPreparations ??= []).push(progress);
    }
    return progress;
  }

  /** Compute finite representation growth from the actual role, request and participants. */
  private preparationGrowth(item: SuccessionRoleState, progress: LocalSuccessionProgress): number {
    const record = item.operations.find(value => value.operationId === progress.operationId)!;
    const current = jsonBytes({ record, progress });
    const release = item.enrollments?.find(value => value.request.operationId === record.operationId);
    const releaseGrowth = release && !item.releasedEnrollments?.includes(release.token)
      ? jsonBytes({ ...item, releasedEnrollments: [...(item.releasedEnrollments ?? []), release.token] }) - jsonBytes(item) : 0;
    if (terminal(record.phase)) {
      const orphan = record.phase === 'cancelled' && progress.stage === 'create-started' && !progress.orphanCandidate
        ? jsonBytes({ record, progress: { ...progress, orphanCandidate: largestSuccessionRef } }) - current : 0;
      return Math.max(0, orphan) + releaseGrowth;
    }
    const to = record.to ?? largestSuccessionRef;
    const capture = progress.capture ?? record.prepared?.capture ?? { epoch: largestSuccessionId, seq: Number.MAX_SAFE_INTEGER, capturedAt: largestSuccessionId };
    const request: SuccessionRequest = { operationId: record.operationId, roleId: record.roleId, expectedRevision: record.expectedRevision, from: record.from,
      ...(record.targetProviderId ? { targetProviderId: record.targetProviderId } : {}) };
    const prepared = record.prepared ?? { ...request, to, workspace: item.role.workspace, associationRevision: item.associationRevision, participants: item.participants, capture };
    const futureProgress = progress.stage ? { ...progress, stage: 'candidate-known', capture, createOperationId: `${record.operationId}:create`, zeroInputAndTask: true } : progress;
    const future = { ...record, to, prepared, updatedAt: '2000-01-01T00:00:00.000Z', phase: 'unknown', resumePhase: 'transferring', failureCode: largestSuccessionId };
    const readyGrowth = jsonBytes({ record: future, progress: futureProgress }) - current;
    const committed = { ...future, phase: 'committed', committedRevision: record.expectedRevision + 1 };
    delete (committed as Partial<typeof future>).resumePhase;
    const roleGrowth = Math.max(0, jsonBytes({ ...item.role, current: to, revision: record.expectedRevision + 1 }) - jsonBytes(item.role));
    const commitGrowth = jsonBytes({ record: committed, progress: futureProgress }) - current + roleGrowth;
    const cancelled = { ...record, phase: 'cancelled', updatedAt: '2000-01-01T00:00:00.000Z', failureCode: largestSuccessionId };
    const orphanProgress = progress.stage ? { ...progress, stage: 'create-started', capture, createOperationId: `${record.operationId}:create`, zeroInputAndTask: true, orphanCandidate: largestSuccessionRef } : progress;
    return Math.max(0, readyGrowth, commitGrowth, jsonBytes({ record: cancelled, progress: orphanProgress }) - current) + releaseGrowth;
  }
  private updateReservations(state: StoreState): void {
    for (const item of state.roles) for (const progress of item.localPreparations ?? []) progress.reservedBytes = reservationBytes(this.preparationGrowth(item, progress));
  }
  private checkCapacity(state: StoreState): void {
    assertSuccessionCapacity(state, state.roles.reduce((total, item) => total + (item.localPreparations ?? []).reduce((sum, progress) => sum + Number(progress.reservedBytes), 0), 0));
  }

  /** Unknown outcomes may advance only after the coordinator has reconciled their saved phase. */
  advance(operationId: string, expectedPhase: SuccessionPhase, change: Advance): Promise<SuccessionRecord> {
    const patch = structuredClone(change);
    return this.mutate(state => {
      const record = this.findOperation(state, operationId);
      if (record.phase !== expectedPhase) throw new Error('Succession phase changed.');
      this.localProgress(state, record);
      if (terminal(record.phase) || patch.phase === 'committed') throw new Error('Invalid succession phase transition.');
      if (record.phase === 'unknown') {
        if (patch.phase !== record.resumePhase) throw new Error('Reconcile the unknown succession phase before continuing.');
        delete record.resumePhase;
      } else if (patch.phase === 'unknown') {
        record.resumePhase = record.phase as SuccessionRecord['resumePhase'];
      } else {
        const next: Partial<Record<SuccessionPhase, SuccessionPhase>> = { preparing: 'quiescing', quiescing: 'transferring', transferring: 'ready' };
        if (!['rejected', 'cancelled'].includes(patch.phase) && next[record.phase] !== patch.phase) throw new Error('Invalid succession phase transition.');
      }
      if (record.to && patch.to && nativeSessionRefKey(record.to) !== nativeSessionRefKey(patch.to)) throw new Error('Succession target cannot change.');
      if (patch.to && nativeSessionRefKey(patch.to) === nativeSessionRefKey(record.from)) throw new Error('Succession target is the same session.');
      Object.assign(record, patch, { updatedAt: new Date().toISOString() });
      this.validateRecord(record); return record;
    });
  }

  commit(operationId: string, expectedGeneration?: number): Promise<SuccessionRecord> {
    return this.mutate(state => {
      if (expectedGeneration !== undefined && expectedGeneration !== this.generation) throw new Error('Succession state changed during commit verification.');
      const record = this.findOperation(state, operationId);
      if (record.phase === 'committed') return record;
      if (record.to && record.to.providerId !== (record.targetProviderId ?? record.from.providerId)) throw new Error('Succession target provider does not match the request.');
      if (record.phase !== 'ready' || !record.prepared || !record.to) throw new Error('Succession is not ready to commit.');
      const item = this.findRole(state, record.roleId);
      if (item.role.revision !== record.expectedRevision || nativeSessionRefKey(item.role.current) !== nativeSessionRefKey(record.from)) throw new Error('Primary role revision changed.');
      if (item.role.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Primary role revision is exhausted.');
      if (record.prepared.associationRevision !== item.associationRevision || JSON.stringify(record.prepared.participants) !== JSON.stringify(item.participants)) throw new Error('Primary role association snapshot changed.');
      if (state.roles.some(other => other !== item && nativeSessionRefKey(other.role.current) === nativeSessionRefKey(record.to!))) throw new Error('Succession target already executes another role.');
      item.role.current = structuredClone(record.to);
      item.role.workspace = structuredClone(record.prepared.workspace);
      item.role.revision++;
      record.phase = 'committed'; record.committedRevision = item.role.revision;
      record.updatedAt = new Date().toISOString(); delete record.resumePhase;
      return record;
    });
  }

  private findRole(state: StoreState, roleId: string): SuccessionRoleState {
    const item = state.roles.find(item => item.role.id === roleId);
    if (!item) throw new Error('Primary role was not found.');
    return item;
  }
  private findOperation(state: StoreState, operationId: string): SuccessionRecord {
    const record = state.roles.flatMap(item => item.operations).find(op => op.operationId === operationId);
    if (!record) throw new Error('Succession operation was not found.');
    return record;
  }
  private mutate<T>(change: (state: StoreState) => T): Promise<T> {
    const next = this.tail.catch(() => undefined).then(async () => {
      await this.ready; this.assertReadable();
      const state = structuredClone(this.state), result = change(state);
      this.updateReservations(state); this.validate(state); this.checkCapacity(state);
      if (JSON.stringify(state) !== JSON.stringify(this.state)) { await this.write(state); this.state = state; this.revision++; }
      return structuredClone(result);
    });
    this.tail = next; return next;
  }
  private validateRecord(record: SuccessionRecord): void {
    if (!isSuccessionRecord(record)) throw new Error('Invalid succession record.');
    if (record.to && nativeSessionRefKey(record.to) === nativeSessionRefKey(record.from)) throw new Error('Invalid succession target.');
    if (['transferring', 'ready', 'committed'].includes(record.phase) && !record.to) throw new Error('Succession target is missing.');
    if (record.phase === 'unknown' ? !record.resumePhase : record.resumePhase !== undefined) throw new Error('Invalid unknown succession phase.');
    if (['ready', 'committed'].includes(record.phase) && !record.prepared) throw new Error('Succession preparation is missing.');
    if (record.phase === 'committed' ? record.committedRevision !== record.expectedRevision + 1 : record.committedRevision !== undefined) throw new Error('Invalid succession commit revision.');
    if (record.prepared) {
      const prepared = record.prepared;
      if (!isPreparedSuccession(prepared) || fingerprint(prepared) !== fingerprint(record) || !record.to || nativeSessionRefKey(prepared.to) !== nativeSessionRefKey(record.to)) throw new Error('Succession preparation does not match the operation.');
      const relations = new Set<string>();
      for (const participant of prepared.participants) {
        if (relations.has(participant.relationId)) throw new Error('Duplicate succession participant.');
        relations.add(participant.relationId);
      }
    }
  }
  private validate(state: StoreState): void {
    if (!state || state.version !== 4 || !Array.isArray(state.roles) || state.roles.length > 1024) throw new Error('Unsupported succession storage format/version.');
    if (!Array.isArray(state.associationAdmissions) || state.associationAdmissions.length > 1024 || new Set(state.associationAdmissions.map(item => item.id)).size !== state.associationAdmissions.length
      || state.associationAdmissions.some(item => !item.id || !item.fingerprint || item.id.length > 512 || item.fingerprint.length > 512 || !isNativeSessionRef(item.source) || item.sourceReader !== undefined && item.sourceReader !== true || item.recovery !== undefined && (typeof item.recovery.createKey !== 'string' || !item.recovery.createKey || item.recovery.createKey.length > 16384 || !/^[a-f0-9]{64}$/.test(item.recovery.createFingerprint)))) throw new Error('Invalid source association admission.');
    if (!Array.isArray(state.associationResults) || state.associationResults.length > 1024 || new Set(state.associationResults.map(item => item.id)).size !== state.associationResults.length || state.associationResults.some(item => !item.id || !item.fingerprint || typeof item.scope !== 'string' || !item.scope || item.scope.length > 16384 || !item.operationId || item.operationId.length > 512 || !isNativeSessionRef(item.source) || !isNativeSessionRef(item.reader) || item.source.controllerId !== item.reader.controllerId || item.source.providerId !== item.reader.providerId || nativeSessionRefKey(item.source) === nativeSessionRefKey(item.reader))) throw new Error('Invalid source creation result.');
    if (state.associationResults.length + state.associationAdmissions.filter(item => item.sourceReader).length > 1024) throw new Error('Source creation result reservations exceed storage capacity.');
    const roles = new Set<string>(), operations = new Set<string>(), executors = new Set<string>();
    for (const item of state.roles) {
      if (!item || !isPrimaryRole(item.role) || !Array.isArray(item.operations) || item.operations.length > 512 || roles.has(item.role.id)) throw new Error('Invalid primary role record.');
      if (!Number.isSafeInteger(item.associationRevision) || item.associationRevision < 0 || !Array.isArray(item.participants)
        || item.participants.length > 1024 || !item.participants.every(isSuccessionParticipant)
        || new Set(item.participants.map(participant => participant.relationId)).size !== item.participants.length) throw new Error('Invalid primary role participants.');
      if (item.associationAuthority && !isSuccessionAssociationAuthority(item.associationAuthority)) throw new Error('Invalid association authority.');
      if (item.enrollments && (!Array.isArray(item.enrollments) || item.enrollments.length > 512 || item.enrollments.some(receipt => !isSuccessionAssociationFreeze(receipt) || receipt.request.roleId !== item.role.id || (!item.associationAuthority || successionAuthorityKey(receipt.authority) !== successionAuthorityKey(item.associationAuthority)) || !item.operations.some(operation => operation.operationId === receipt.request.operationId && fingerprint(operation) === fingerprint(receipt.request))))) throw new Error('Invalid association receipt.');
      if (item.releasedEnrollments && (!Array.isArray(item.releasedEnrollments) || item.releasedEnrollments.length > 512 || item.releasedEnrollments.some(token => !item.enrollments?.some(receipt => receipt.token === token && item.operations.some(operation => operation.operationId === receipt.request.operationId && terminal(operation.phase)))))) throw new Error('Invalid association release.');
      if (item.relationChanges && (!Array.isArray(item.relationChanges) || item.relationChanges.length > 512
        || item.relationChanges.some(change => !isRelationChangeReceipt(change) || change.reservation.roleId !== item.role.id
          || !item.associationAuthority || successionAuthorityKey(change.reservation.authority) !== successionAuthorityKey(item.associationAuthority)
          || (change.phase === 'reserved' ? change.associationRevision !== change.reservation.associationRevision
            : change.associationRevision !== change.reservation.associationRevision + Number(change.reservation.previousMember !== change.reservation.linked)))
        || item.relationChanges.filter(change => change.phase !== 'released').length > 1)) throw new Error('Invalid relation change storage.');
      for (const change of item.relationChanges ?? []) {
        if (operations.has(change.reservation.operationId)) throw new Error('Duplicate relation operation.');
        operations.add(change.reservation.operationId);
      }
      roles.add(item.role.id);
      const executor = nativeSessionRefKey(item.role.current);
      if (executors.has(executor)) throw new Error('Duplicate primary executor.');
      executors.add(executor);
      let current = item.role.origin, revision = 1, pending = 0;
      for (const op of item.operations) {
        this.validateRecord(op);
        if (op.roleId !== item.role.id || operations.has(op.operationId) || op.expectedRevision !== revision || nativeSessionRefKey(op.from) !== nativeSessionRefKey(current)) throw new Error('Invalid succession history.');
        operations.add(op.operationId);
        if (!terminal(op.phase)) pending++;
        if (op.phase === 'committed') { current = op.to!; revision++; }
      }
      if (pending > 1 || revision !== item.role.revision || nativeSessionRefKey(current) !== executor) throw new Error('Invalid current succession state.');
      if (item.localPreparations !== undefined) {
        if (!Array.isArray(item.localPreparations) || item.localPreparations.length > 512 || new Set(item.localPreparations.map(value => value.operationId)).size !== item.localPreparations.length) throw new Error('Invalid local succession progress.');
        for (const progress of item.localPreparations) {
          const record = item.operations.find(value => value.operationId === progress.operationId);
          if (!record || Object.keys(progress).some(name => !['operationId', 'reservedBytes', 'stage', 'createOperationId', 'zeroInputAndTask', 'capture', 'orphanCandidate'].includes(name))
            || !isReservation(progress.reservedBytes) || progress.reservedBytes !== reservationBytes(this.preparationGrowth(item, progress))) throw new Error('Invalid local succession reservation.');
          if (!progress.stage) {
            if (Object.keys(progress).some(name => !['operationId', 'reservedBytes'].includes(name))) throw new Error('Legacy progress cannot certify native creation.');
            continue;
          }
          if (!['not-started', 'create-started', 'candidate-known'].includes(progress.stage)) throw new Error('Invalid local preparation stage.');
          if (progress.zeroInputAndTask !== undefined && progress.zeroInputAndTask !== true || (progress.createOperationId !== undefined || progress.zeroInputAndTask !== undefined || progress.capture !== undefined)
            && (progress.createOperationId !== `${record.operationId}:create` || progress.zeroInputAndTask !== true || !progress.capture)) throw new Error('Invalid local creation certification.');
          if (progress.capture && !isPreparedSuccession({ operationId: record.operationId, roleId: record.roleId, expectedRevision: record.expectedRevision, from: record.from,
            to: record.to ?? { ...record.from, nativeSessionId: 'validation-candidate' }, workspace: item.role.workspace, associationRevision: item.associationRevision, participants: item.participants, capture: progress.capture })) throw new Error('Invalid local captured boundary.');
          if (progress.stage === 'not-started' && (record.to || record.prepared || !['preparing', 'unknown', 'cancelled', 'rejected'].includes(record.phase) || record.resumePhase && record.resumePhase !== 'preparing')) throw new Error('Contradictory precreate progress.');
          if (progress.stage !== 'not-started' && !progress.zeroInputAndTask) throw new Error('Native creation lacks saved certification.');
          if (progress.stage === 'create-started' && (record.to || record.prepared || !['quiescing', 'unknown', 'cancelled'].includes(record.phase) || record.resumePhase && record.resumePhase !== 'quiescing')) throw new Error('Contradictory unknown creation.');
          if (progress.stage === 'candidate-known' && (!record.to || ['preparing', 'quiescing'].includes(record.phase)
            || record.resumePhase && !['transferring', 'ready'].includes(record.resumePhase)
            || record.resumePhase === 'ready' && !record.prepared
            || record.prepared && JSON.stringify(record.prepared.capture) !== JSON.stringify(progress.capture))) throw new Error('Contradictory known candidate.');
          if (progress.orphanCandidate && (record.phase !== 'cancelled' || progress.stage !== 'create-started' || !isNativeSessionRef(progress.orphanCandidate))) throw new Error('Invalid orphan candidate evidence.');
        }
      }
    }
  }
  private async restore(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let text: string;
    try { text = await readFile(join(this.directory, 'state.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.loaded = true; return; }
    if (Buffer.byteLength(text) > maxBytes) throw new Error('Succession storage size limit exceeded.');
    const parsed = JSON.parse(text);
    const migrated = [1, 2, 3].includes(parsed.version);
    if (migrated && parsed.roles.some((item: SuccessionRoleState) => item.localPreparations !== undefined)) throw new Error('Ambiguous legacy preparation evidence.');
    if (parsed.version === 1 && (parsed.associationAdmissions !== undefined || parsed.associationResults !== undefined || parsed.roles.some((item: SuccessionRoleState) => item.associationAuthority || item.enrollments || item.releasedEnrollments))) throw new Error('Ambiguous legacy association storage.');
    if ((parsed.version === 1 || parsed.version === 2) && parsed.roles.some((item: SuccessionRoleState) => item.relationChanges !== undefined)) throw new Error('Ambiguous legacy relation change storage.');
    const state: StoreState = migrated ? { ...parsed, version: 4, associationAdmissions: parsed.version === 1 ? [] : parsed.associationAdmissions, associationResults: parsed.version === 1 ? [] : parsed.associationResults } : parsed; this.validate(state);
    let changed = migrated;
    for (const item of state.roles) for (const op of item.operations) if (!terminal(op.phase) && op.phase !== 'unknown') {
      op.resumePhase = op.phase as SuccessionRecord['resumePhase']; op.phase = 'unknown';
      op.failureCode = 'succession_recovery_required'; changed = true;
    }
    this.updateReservations(state); this.checkCapacity(state);
    if (changed) await this.write(state);
    this.state = state; this.loaded = true; this.revision++;
  }
  private async write(state: StoreState): Promise<void> {
    this.checkCapacity(state);
    try { await publishSuccessionState(this.directory, 'state.json', state); }
    catch (error) { if (error instanceof SuccessionPublicationUnknown) this.writeFailure = error; throw error; }
  }
}

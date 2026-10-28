import { createHash } from 'node:crypto';
import { AgentOperationRejectedError, AGENT_NATIVE_EVIDENCE_LIMITS, parseAgentPreparedTextInput, serializeAgentPreparedTextInput, parseAgentInputMaterialization, serializeAgentInputMaterialization, type AgentPreparedTextInput, type AgentTextInputProof, type AgentInputAcceptance, type AgentPersistenceHandle, serializeAgentEmptyCreationResult } from '@orchardworks/agent-provider-sdk';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isNativeSessionRef, isSuccessionRequest, nativeSessionRefKey, MAX_NORMALIZED_CONTEXT_BYTES, MAX_NORMALIZED_CONTEXT_ENTRIES, quotedSessionContextPrefix,
  type NativeSessionRef, type TimelineCursor } from '@orchardworks/agent-remote-protocol';
import { assertSuccessionCapacity, isReservation, jsonBytes, largestSuccessionRef, publishSuccessionState, reservationBytes, SuccessionCapacityError, SuccessionPublicationUnknown } from './succession-persistence.js';

export interface SuccessionContextAttachment {
  operationId: string;
  roleId: string;
  /** The committed successor revision, not the predecessor revision. */
  roleRevision: number;
  source: NativeSessionRef;
  target: NativeSessionRef;
  capturedAt: string;
  boundary: TimelineCursor;
  text: string;
  itemCount: number;
  shortenedToolCount?: number;
  inheritedFrom?: { operationId: string; source: NativeSessionRef; boundary: TimelineCursor; capturedAt: string };
}
export interface SuccessionInput {
  operationId: string;
  roleId: string;
  roleRevision: number;
  target: NativeSessionRef;
  text: string;
  /** Canonical rich-input identity, including attachments, supplied by the native dispatch caller. */
  contentIdentity?: string;
}
export type SuccessionDeliveryState = 'dispatching' | 'accepted' | 'unknown' | 'rejected' | 'materialized';
export interface SuccessionPreparedInput {
  version: 2;
  contextOperationId: string;
  contextIdentity: string;
  inputIdentity: string;
  witness: AgentPreparedTextInput;
}
export interface SuccessionContextDelivery extends SuccessionInput {
  preparedInput?: SuccessionPreparedInput;
  reservedBytes?: string;
  state: SuccessionDeliveryState;
  includesContext: boolean;
  nativeEvidence?: string;
  /** The actual native return receipt; absent means the adapter returned void. */
  inputAcceptance?: AgentInputAcceptance;
}
export interface SuccessionContextRecord extends SuccessionContextAttachment {
  version: 1 | 2 | 3;
  state: 'pending' | 'dispatching' | 'accepted' | 'unknown' | 'materialized';
  deliveries: SuccessionContextDelivery[];
  /** Latest adapter-confirmed recovery configuration; independent of empty initialization permission. */
  resumeHandle?: AgentPersistenceHandle;
  resumeReservedBytes?: string;
}
export type SuccessionContextPreparation = Omit<SuccessionContextAttachment, 'target'>;
interface ContextPreparationRecord extends SuccessionContextPreparation { version: 2; reservedBytes: string }
export interface SuccessionDeliveryEvidence {
  operationId: string;
  target: NativeSessionRef;
  roleRevision: number;
  /** Only authoritative adapter evidence can certify either outcome. */
  outcome: 'materialized' | 'not-dispatched';
  nativeEvidence: string;
}
interface MutationCoverage { target: NativeSessionRef; operationId?: string; prepared?: true }
interface ContextState { version: 3; attachments: SuccessionContextRecord[]; preparations?: ContextPreparationRecord[]; coverage?: MutationCoverage[] }
const MAX_STORE_BYTES = 8 * 1024 * 1024;
/** How long a restarted Controller fences a session whose mutation outcome the previous process could not confirm. */
export const RESTART_SETTLE_MS = 5 * 60_000;
const sameRef = (a: NativeSessionRef, b: NativeSessionRef) => nativeSessionRefKey(a) === nativeSessionRefKey(b);
const attachmentIdentity = (input: SuccessionContextAttachment) => JSON.stringify([input.operationId, input.roleId, input.roleRevision, nativeSessionRefKey(input.source), nativeSessionRefKey(input.target), input.capturedAt, input.boundary.epoch, input.boundary.seq, input.text, input.itemCount, input.shortenedToolCount ?? 0, input.inheritedFrom ? [input.inheritedFrom.operationId, nativeSessionRefKey(input.inheritedFrom.source), input.inheritedFrom.boundary.epoch, input.inheritedFrom.boundary.seq, input.inheritedFrom.capturedAt] : null]);
const inputIdentity = (input: SuccessionInput) => JSON.stringify([input.operationId, input.roleId, input.roleRevision, nativeSessionRefKey(input.target), input.text, input.contentIdentity ?? null]);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export function isSuccessionDeliveryUnresolved(delivery: SuccessionContextDelivery): boolean {
  return ['dispatching', 'accepted', 'unknown'].includes(delivery.state) || !!delivery.preparedInput && delivery.state === 'materialized' && !['started', 'handled'].includes(delivery.inputAcceptance?.disposition ?? '');
}
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Single-Controller ownership; snapshots are replaced atomically before native dispatch. */
export class SessionSuccessionContextStore {
  readonly ready: Promise<void>;
  private state: ContextState = { version: 3, attachments: [] };
  private loaded = false;
  private readonly lostCoverage = new Set<string>();
  private writeFailure?: Error;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly deliveryListeners = new Set<(delivery: SuccessionContextDelivery) => void>();
  subscribeDelivery(listener: (delivery: SuccessionContextDelivery) => void): () => void { this.deliveryListeners.add(listener); return () => { this.deliveryListeners.delete(listener); }; }
  private publishedDelivery(delivery: SuccessionContextDelivery): SuccessionContextDelivery {
    for (const listener of this.deliveryListeners) listener(structuredClone(delivery));
    return delivery;
  }
  private readonly dispatchTails = new Map<string, Promise<unknown>>();
  private restoredAt = 0;
  constructor(private readonly directory: string, private readonly options: { restartSettleMs?: number; now?: () => number } = {}) { this.ready = this.restore(); }
  /**
   * A marker restored from the previous process covers work whose outcome that process could not confirm, so it
   * fences succession while that work could still reach the native session. Succession separately requires the
   * native session to be idle with no pending input, approval or child work; the fence lifts once the restart has
   * settled. A first input to the session recovers only from its own native evidence.
   */
  coverageAvailable(target: NativeSessionRef): boolean {
    this.assertReadable();
    const key = nativeSessionRefKey(target);
    this.settleRestart(key, this.state);
    return !this.lostCoverage.has(key);
  }
  /** Time until a restored marker stops fencing succession, or undefined when time does not lift it. */
  restartSettlingMs(target: NativeSessionRef): number | undefined {
    this.assertReadable();
    const key = nativeSessionRefKey(target);
    if (!this.lostCoverage.has(key) || this.firstInputUnresolved(key, this.state)) return undefined;
    return Math.max(0, this.restoredAt + (this.options.restartSettleMs ?? RESTART_SETTLE_MS) - this.now());
  }
  /** Explains why a session without coverage cannot hand off or edit a prompt yet. */
  restartFenceMessage(target: NativeSessionRef): string {
    const remaining = this.restartSettlingMs(target);
    if (remaining === undefined) return 'This session has a first input whose outcome is unconfirmed since the Controller restarted. Reconcile it before continuing.';
    const minutes = Math.max(1, Math.ceil(remaining / 60_000));
    return `This session had an unconfirmed operation when the Controller restarted. Handoff and prompt edits resume in about ${minutes} minute${minutes === 1 ? '' : 's'} if the session stays idle.`;
  }
  /** Sessions still fenced by restored markers, and when time lifts their fences. */
  restartSettlement(): { delayMs: number; targets: NativeSessionRef[] } {
    this.assertReadable();
    const targets = (this.state.coverage ?? []).map(marker => marker.target).filter(target => this.restartSettlingMs(target) !== undefined);
    return { delayMs: Math.max(0, ...targets.map(target => this.restartSettlingMs(target)!)), targets: structuredClone(targets) };
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private settleRestart(key: string, state: ContextState): void {
    if (this.lostCoverage.has(key) && !this.firstInputUnresolved(key, state)
      && this.now() - this.restoredAt >= (this.options.restartSettleMs ?? RESTART_SETTLE_MS)) this.lostCoverage.delete(key);
  }
  private firstInputUnresolved(key: string, state: ContextState): boolean {
    return state.attachments.some(record => record.deliveries.some(delivery => nativeSessionRefKey(delivery.target) === key && isSuccessionDeliveryUnresolved(delivery)));
  }
  markMutation(target: NativeSessionRef, operationId: string): Promise<void> {
    const address = structuredClone(target), key = nativeSessionRefKey(address);
    return this.mutate(state => {
      this.settleRestart(key, state);
      const prior = state.coverage?.find(item => sameRef(item.target, address));
      if (prior) {
        if (!this.lostCoverage.has(key) && prior.operationId !== operationId) { delete prior.operationId; delete prior.prepared; }
      } else (state.coverage ??= []).push({ target: address, operationId });
    });
  }
  markPreparedMutation(target: NativeSessionRef, operationId: string): Promise<void> {
    return this.mutate(state => {
      const marker = state.coverage?.find(item => sameRef(item.target, target));
      if (marker?.operationId === operationId) marker.prepared = true;
    });
  }
  async clearMutation(target: NativeSessionRef, isClean: () => boolean): Promise<void> {
    const key = nativeSessionRefKey(target);
    await this.mutate(state => {
      const marker = state.coverage?.find(item => sameRef(item.target, target));
      if (!marker || !isClean()) return;
      this.settleRestart(key, state);
      if (this.lostCoverage.has(key)) {
        const delivery = state.attachments.flatMap(item => item.deliveries).find(item => item.operationId === marker.operationId && sameRef(item.target, target));
        if (!marker.prepared || !delivery?.preparedInput || isSuccessionDeliveryUnresolved(delivery)
          || delivery.state !== 'rejected' && !['started', 'handled'].includes(delivery.inputAcceptance?.disposition ?? '')) return;
      }
      state.coverage = state.coverage!.filter(item => item !== marker);
    });
    if (!this.state.coverage?.some(item => sameRef(item.target, target))) this.lostCoverage.delete(key);
  }
  read(operationId: string): SuccessionContextRecord {
    this.assertReadable();
    return structuredClone(this.find(this.state, operationId));
  }
  hasTarget(target: NativeSessionRef): boolean {
    this.assertReadable();
    return this.state.attachments.some(item => sameRef(item.target, target));
  }
  forTarget(target: NativeSessionRef): SuccessionContextRecord | undefined {
    this.assertReadable();
    return structuredClone(this.state.attachments.find(item => sameRef(item.target, target)));
  }
  canInitializeEmpty(target: NativeSessionRef): boolean {
    const record = this.forTarget(target);
    return this.coverageAvailable(target) && !!record && record.state === 'pending' && record.deliveries.every(item => item.state === 'rejected');
  }
  reserveResumeHandle(target: NativeSessionRef): Promise<void> {
    this.assertReadable();
    if (this.state.attachments.find(item => sameRef(item.target, target))?.resumeReservedBytes !== undefined) return Promise.resolve();
    return this.mutate(state => {
      const record = state.attachments.find(item => sameRef(item.target, target));
      if (!record) throw new Error('Successor recovery configuration was not found.');
      record.resumeReservedBytes = '00000000';
    });
  }
  retainResumeHandle(target: NativeSessionRef, handle: AgentPersistenceHandle): Promise<void> {
    this.assertReadable();
    const saved = structuredClone(handle), current = this.state.attachments.find(item => sameRef(item.target, target));
    if (current?.resumeReservedBytes !== undefined && JSON.stringify(current.resumeHandle) === JSON.stringify(saved)) return Promise.resolve();
    return this.mutate(state => {
      const record = state.attachments.find(item => sameRef(item.target, target));
      if (!record) throw new Error('Successor recovery configuration was not found.');
      if (!record.resumeReservedBytes) throw new Error('Recovery configuration capacity was not reserved.');
      this.validateResumeHandle(record, saved);
      record.resumeHandle = saved;
    });
  }
  private validateResumeHandle(record: SuccessionContextRecord, handle: AgentPersistenceHandle): void {
    if (handle.providerId !== record.target.providerId || handle.sessionId !== record.target.nativeSessionId) throw new Error('Recovery configuration identity mismatch.');
    serializeAgentEmptyCreationResult({ status: 'created', handle });
  }
  private resumeGrowth(record: SuccessionContextRecord): number {
    return AGENT_NATIVE_EVIDENCE_LIMITS.handleBytes + '"resumeHandle":,'.length
      - (record.resumeHandle ? jsonBytes(record.resumeHandle) + '"resumeHandle":,'.length : 0);
  }
  delivery(operationId: string): SuccessionContextDelivery | undefined {
    this.assertReadable();
    return structuredClone(this.state.attachments.flatMap(item => item.deliveries).find(item => item.operationId === operationId));
  }
  private assertReadable(): void {
    if (this.writeFailure) throw this.writeFailure;
    if (!this.loaded) throw new Error('Succession context store is not ready.');
  }
  preparation(operationId: string): SuccessionContextPreparation | undefined {
    this.assertReadable();
    const record = this.state.preparations?.find(item => item.operationId === operationId);
    if (!record) return undefined;
    const { version: _version, reservedBytes: _reservation, ...preparation } = record;
    return structuredClone(preparation);
  }
  prepare(preparation: SuccessionContextPreparation): Promise<void> {
    const input = structuredClone(preparation);
    return this.mutate(state => {
      this.validatePreparation(input);
      const prior = state.preparations?.find(item => item.operationId === input.operationId);
      if (prior) {
        const { version: _version, reservedBytes: _reservation, ...saved } = prior;
        if (JSON.stringify(saved) !== JSON.stringify(input)) throw new Error('Succession preparation identity conflict.');
        return;
      }
      if (state.attachments.some(item => item.operationId === input.operationId)) throw new Error('Succession context is already bound.');
      if (state.attachments.length + (state.preparations?.length ?? 0) >= 512) throw new Error('Succession context attachment limit exceeded.');
      (state.preparations ??= []).push({ ...input, version: 2, reservedBytes: '00000000' });
    });
  }
  /** Move the saved history into its bound representation without retaining a second copy. */
  bind(operationId: string, target: NativeSessionRef): Promise<SuccessionContextRecord> {
    const candidate = structuredClone(target);
    return this.mutate(state => {
      const prior = state.attachments.find(item => item.operationId === operationId);
      if (prior) { if (!sameRef(prior.target, candidate)) throw new Error('Succession target identity conflict.'); return prior; }
      const index = state.preparations?.findIndex(item => item.operationId === operationId) ?? -1;
      if (index < 0) throw new Error('Saved succession preparation was not found.');
      if (state.attachments.some(item => sameRef(item.target, candidate))) throw new Error('Succession target already has context.');
      const { reservedBytes: _reservation, ...saved } = state.preparations![index]!;
      const record: SuccessionContextRecord = { ...saved, target: candidate, state: 'pending', deliveries: [] };
      this.validateAttachment(record);
      state.preparations!.splice(index, 1); state.attachments.push(record); return record;
    });
  }
  /** Persist before declaring candidate readiness. Identical retries do not replace delivery evidence. */
  attach(attachment: SuccessionContextAttachment): Promise<SuccessionContextRecord> {
    const input = structuredClone(attachment);
    return this.mutate(state => {
      this.validateAttachment(input);
      const prior = state.attachments.find(item => item.operationId === input.operationId);
      if (prior) {
        const { version: _version, state: _state, deliveries: _deliveries, ...saved } = prior;
        if (attachmentIdentity(saved) !== attachmentIdentity(input)) throw new Error('Succession attachment identity conflict.');
        return prior;
      }
      if (state.attachments.length + (state.preparations?.length ?? 0) >= 512) throw new Error('Succession context attachment limit exceeded.');
      if (state.preparations?.some(item => item.operationId === input.operationId)) throw new Error('Succession context must bind its saved preparation.');
      if (state.attachments.some(item => sameRef(item.target, input.target))) throw new Error('Succession target already has context.');
      const record: SuccessionContextRecord = { ...input, version: 2, state: 'pending', deliveries: [] };
      state.attachments.push(record); return record;
    });
  }
  /** Shared across dispatchers so two devices/TPM cannot race the first native call. */
  serialized<T>(target: NativeSessionRef, run: () => Promise<T>): Promise<T> {
    const key = nativeSessionRefKey(target);
    const next = (this.dispatchTails.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
    this.dispatchTails.set(key, next);
    void next.finally(() => { if (this.dispatchTails.get(key) === next) this.dispatchTails.delete(key); }).catch(() => undefined);
    return next;
  }
  async begin(attachmentId: string, input: SuccessionInput, witness?: AgentPreparedTextInput): Promise<SuccessionContextDelivery> {
    const admitted = structuredClone(input);
    const prepared = witness === undefined ? undefined : parseAgentPreparedTextInput(serializeAgentPreparedTextInput(witness));
    return this.mutate(state => {
      this.validateInput(admitted);
      const record = this.find(state, attachmentId);
      if (!sameRef(record.target, admitted.target) || record.roleId !== admitted.roleId || record.roleRevision !== admitted.roleRevision) throw new Error('Succession input routing identity conflict.');
      const prior = state.attachments.flatMap(item => item.deliveries).find(item => item.operationId === admitted.operationId);
      if (prior) {
        if (inputIdentity(prior) !== inputIdentity(admitted) || prepared && (!prior.preparedInput || serializeAgentPreparedTextInput(prior.preparedInput.witness) !== serializeAgentPreparedTextInput(prepared))) throw new Error('Succession input identity conflict.');
        return prior;
      }
      if (record.deliveries.some(isSuccessionDeliveryUnresolved)) throw new AgentOperationRejectedError('succession_delivery_unresolved', 'Succession input delivery is unresolved.');
      if (record.deliveries.length >= 512) throw new Error('Succession input receipt limit exceeded.');
      const delivery: SuccessionContextDelivery = { ...admitted, state: 'dispatching', includesContext: record.state !== 'materialized', reservedBytes: '00000000' };
      if (prepared) {
        delivery.preparedInput = { version: 2, contextOperationId: record.operationId, contextIdentity: hash(attachmentIdentity(record)), inputIdentity: hash(inputIdentity(admitted)), witness: prepared };
        this.validatePreparedInput(record, delivery); record.version = 3;
      }
      record.deliveries.push(delivery);
      if (delivery.includesContext) record.state = 'dispatching';
      return delivery;
    });
  }
  settle(attachmentId: string, operationId: string, outcome: 'accepted' | 'rejected' | 'unknown', inputAcceptance?: AgentInputAcceptance): Promise<SuccessionContextDelivery> {
    return this.mutate(state => {
      const record = this.find(state, attachmentId), delivery = record.deliveries.find(item => item.operationId === operationId);
      if (!delivery || delivery.state !== 'dispatching') throw new Error('Succession input dispatch state changed.');
      delivery.state = outcome;
      if (inputAcceptance !== undefined) {
        if (outcome !== 'accepted' || !['started', 'queued', 'handled'].includes(inputAcceptance?.disposition)) delivery.state = 'unknown';
        else delivery.inputAcceptance = { disposition: inputAcceptance.disposition };
      }
      if (delivery.includesContext) record.state = delivery.state === 'rejected' ? 'pending' : delivery.state;
      return delivery;
    }).then(delivery => this.publishedDelivery(delivery));
  }
  /** Explicit adapter reconciliation; a transport receipt or ordinary empty history is insufficient. */
  reconcile(attachmentId: string, evidence: SuccessionDeliveryEvidence): Promise<SuccessionContextDelivery> {
    const proof = structuredClone(evidence);
    return this.mutate(state => {
      const record = this.find(state, attachmentId), delivery = record.deliveries.find(item => item.operationId === proof.operationId);
      if (!delivery || !sameRef(delivery.target, proof.target) || delivery.roleRevision !== proof.roleRevision || !nonempty(proof.nativeEvidence)
        || !['materialized', 'not-dispatched'].includes(proof.outcome)) throw new Error('Succession delivery evidence identity conflict.');
      if (delivery.preparedInput) {
        this.validatePreparedInput(record, delivery);
        if (Object.keys(proof).some(key => !['operationId', 'target', 'roleRevision', 'outcome', 'nativeEvidence'].includes(key)) || proof.outcome !== 'materialized') throw new Error('Optional native evidence requires exact positive materialization.');
        const execution = this.validatePositiveProof(delivery, proof.nativeEvidence);
        const previous = delivery.nativeEvidence ? parseAgentInputMaterialization(delivery.nativeEvidence) : undefined;
        const current = parseAgentInputMaterialization(proof.nativeEvidence);
        if (previous?.status === 'materialized' && current.status === 'materialized' && previous.proof.nativeInputId !== current.proof.nativeInputId) throw new Error('Native input evidence cannot be replaced.');
        if (previous?.status === 'materialized' && previous.execution && JSON.stringify(previous.execution) !== JSON.stringify(execution)) throw new Error('Native execution evidence cannot be replaced or removed.');
        if (execution) delivery.inputAcceptance = { disposition: execution.disposition };
      }
      const result = proof.outcome === 'materialized' ? 'materialized' : 'rejected';
      if (delivery.state === result && delivery.nativeEvidence === proof.nativeEvidence) return delivery;
      if (!['accepted', 'unknown', ...(delivery.preparedInput ? ['materialized'] : [])].includes(delivery.state)) throw new Error('Succession delivery cannot be reconciled in its current state.');
      delivery.state = result; delivery.nativeEvidence = proof.nativeEvidence;
      if (delivery.includesContext) record.state = result === 'rejected' ? 'pending' : 'materialized';
      return delivery;
    }).then(delivery => this.publishedDelivery(delivery));
  }
  private find(state: ContextState, operationId: string): SuccessionContextRecord {
    const record = state.attachments.find(item => item.operationId === operationId);
    if (!record) throw new Error('Succession context attachment was not found.');
    return record;
  }
  private bindingGrowth(preparation: ContextPreparationRecord): number {
    const { reservedBytes: _reservation, ...saved } = preparation;
    const bound = { ...saved, target: largestSuccessionRef, state: 'pending', deliveries: [] };
    // Include the append comma even if an unrelated attachment arrives before binding.
    return Math.max(0, jsonBytes({ attachments: [null, bound], preparations: [] }) - jsonBytes({ attachments: [null], preparations: [preparation] }));
  }
  private deliveryGrowth(record: SuccessionContextRecord, delivery: SuccessionContextDelivery): number {
    if (delivery.preparedInput) return this.preparedDeliveryGrowth(record, delivery);
    if (delivery.state !== 'dispatching') return 0;
    const current = jsonBytes({ state: record.state, delivery });
    return Math.max(0, ...(['accepted', 'rejected', 'unknown'] as const).map(outcome => {
      const next = { ...delivery, state: outcome, ...(outcome === 'accepted' ? { inputAcceptance: { disposition: 'started' } } : {}) };
      return jsonBytes({ state: delivery.includesContext ? outcome === 'rejected' ? 'pending' : outcome : record.state, delivery: next }) - current;
    }));
  }
  private preparedDeliveryGrowth(record: SuccessionContextRecord, delivery: SuccessionContextDelivery): number {
    if (delivery.state === 'rejected' || delivery.state === 'materialized' && !isSuccessionDeliveryUnresolved(delivery)) return 0;
    const proof = this.expectedProof(delivery.preparedInput!.witness);
    const nativeEvidence = serializeAgentInputMaterialization({ status: 'materialized', proof: { ...proof, nativeInputId: 'U'.repeat(AGENT_NATIVE_EVIDENCE_LIMITS.identityBytes), nativePartIds: ['p'.repeat(AGENT_NATIVE_EVIDENCE_LIMITS.identityBytes)] }, execution: { disposition: 'started', nativeExecutionId: 'R'.repeat(AGENT_NATIVE_EVIDENCE_LIMITS.identityBytes) } });
    const current = jsonBytes({ state: record.state, delivery });
    const acceptance = { disposition: 'started' as const };
    const materialized = { ...delivery, state: 'materialized', nativeEvidence, ...(acceptance ? { inputAcceptance: acceptance } : {}) };
    const outcomes = [jsonBytes({ state: delivery.includesContext ? 'materialized' : record.state, delivery: materialized })];
    if (delivery.state === 'dispatching') for (const state of ['accepted', 'unknown', 'rejected'] as const) {
      outcomes.push(jsonBytes({ state: delivery.includesContext ? state === 'rejected' ? 'pending' : state : record.state,
        delivery: { ...delivery, state, ...(state === 'accepted' ? { inputAcceptance: acceptance } : {}) } }));
    }
    return Math.max(0, ...outcomes.map(bytes => bytes - current));
  }
  private validatePreparedInput(record: SuccessionContextRecord, delivery: SuccessionContextDelivery): void {
    const prepared = delivery.preparedInput!;
    if (!prepared || prepared.version !== 2 || Object.keys(prepared).some(key => !['version', 'contextOperationId', 'contextIdentity', 'inputIdentity', 'witness'].includes(key))
      || prepared.contextOperationId !== record.operationId || prepared.contextIdentity !== hash(attachmentIdentity(record)) || prepared.inputIdentity !== hash(inputIdentity(delivery))) throw new Error('Prepared input original binding mismatch.');
    serializeAgentPreparedTextInput(prepared.witness);
    const witness = prepared.witness;
    const prefix = delivery.includesContext ? quotedSessionContextPrefix({ id: record.operationId, sourceSession: record.source.nativeSessionId,
      capturedAt: record.capturedAt, text: record.text, shortenedToolCount: record.shortenedToolCount }) : '';
    if (witness.providerId !== delivery.target.providerId || witness.nativeSessionId !== delivery.target.nativeSessionId || witness.parts[0].text !== prefix + delivery.text) throw new Error('Prepared native input does not match its target and composed text binding.');
  }
  private expectedProof(witness: AgentPreparedTextInput): Omit<AgentTextInputProof, 'nativeInputId' | 'nativePartIds'> {
    const canonical = parseAgentPreparedTextInput(serializeAgentPreparedTextInput(witness));
    const { delivery: _delivery, ...selections } = canonical.selections;
    return { version: 2, providerId: canonical.providerId, nativeSessionId: canonical.nativeSessionId, inputId: canonical.inputId,
      cwd: canonical.cwd, authority: canonical.authority, witnessSha256: hash(serializeAgentPreparedTextInput(canonical)), contentSha256: canonical.content.sha256, nativeSelectionsSha256: hash(JSON.stringify(selections)) };
  }
  private validatePositiveProof(delivery: SuccessionContextDelivery, encoded: string) {
    const result = parseAgentInputMaterialization(encoded);
    if (result.status !== 'materialized') throw new Error('Native materialization remains unknown.');
    const { nativePartIds: _parts, nativeInputId, ...proof } = result.proof;
    const expected = this.expectedProof(delivery.preparedInput!.witness);
    if (serializeAgentInputMaterialization({ status: 'materialized', proof: { ...proof, nativeInputId } }) !== serializeAgentInputMaterialization({ status: 'materialized', proof: { ...expected, nativeInputId } })) throw new Error('Native materialization proof binding mismatch.');
    return result.execution;
  }
  private updateReservations(state: ContextState): void {
    for (const preparation of state.preparations ?? []) preparation.reservedBytes = reservationBytes(this.bindingGrowth(preparation));
    for (const record of state.attachments) if (record.resumeReservedBytes !== undefined) record.resumeReservedBytes = reservationBytes(this.resumeGrowth(record));
    for (const record of state.attachments) for (const delivery of record.deliveries) if (delivery.reservedBytes !== undefined) delivery.reservedBytes = reservationBytes(this.deliveryGrowth(record, delivery));
  }
  private checkCapacity(state: ContextState): void {
    let reserved = 0;
    const reserve = (bytes: number) => { if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(reserved + bytes)) throw new SuccessionCapacityError(); reserved += bytes; };
    for (const preparation of state.preparations ?? []) reserve(Number(preparation.reservedBytes));
    for (const record of state.attachments) reserve(Number(record.resumeReservedBytes ?? 0));
    for (const record of state.attachments) for (const delivery of record.deliveries) reserve(Number(delivery.reservedBytes ?? 0));
    if (!Number.isSafeInteger(jsonBytes(state) + reserved)) throw new SuccessionCapacityError();
    assertSuccessionCapacity(state, reserved);
  }
  private validateInput(input: SuccessionInput): void {
    if (!input || !nonempty(input.operationId) || !nonempty(input.roleId) || !isNativeSessionRef(input.target)
      || !Number.isSafeInteger(input.roleRevision) || input.roleRevision < 2 || typeof input.text !== 'string'
      || input.contentIdentity !== undefined && !nonempty(input.contentIdentity)) throw new Error('Invalid succession input.');
    if (Buffer.byteLength(input.text) > MAX_NORMALIZED_CONTEXT_BYTES || (input.contentIdentity?.length ?? 0) > 1024) throw new Error('Succession input byte limit exceeded.');
    if (!isSuccessionRequest({ operationId: input.operationId, roleId: input.roleId, expectedRevision: input.roleRevision - 1, from: input.target })) throw new Error('Invalid succession input identity.');
    if (Object.keys(input).some(name => !['operationId', 'roleId', 'roleRevision', 'target', 'text', 'contentIdentity', 'state', 'includesContext', 'nativeEvidence', 'inputAcceptance', 'reservedBytes', 'preparedInput'].includes(name))) throw new Error('Invalid succession delivery fields.');
  }
  private validatePreparation(record: SuccessionContextPreparation): void {
    this.validateAttachment({ ...record, target: { ...record.source, nativeSessionId: record.source.nativeSessionId === 'preparation' ? 'candidate' : 'preparation' } });
  }
  private validateAttachment(record: SuccessionContextAttachment): void {
    if (!record || !nonempty(record.operationId) || !nonempty(record.roleId) || !Number.isSafeInteger(record.roleRevision) || record.roleRevision < 2
      || !isNativeSessionRef(record.source) || !isNativeSessionRef(record.target) || sameRef(record.source, record.target)
      || !nonempty(record.capturedAt) || !Number.isFinite(Date.parse(record.capturedAt)) || !record.boundary || !nonempty(record.boundary.epoch)
      || !Number.isSafeInteger(record.boundary.seq) || record.boundary.seq < 0 || typeof record.text !== 'string'
      || !Number.isSafeInteger(record.itemCount) || record.itemCount < 0 || record.itemCount > MAX_NORMALIZED_CONTEXT_ENTRIES
      || record.shortenedToolCount !== undefined && (!Number.isSafeInteger(record.shortenedToolCount) || record.shortenedToolCount < 0 || record.shortenedToolCount > record.itemCount)) throw new Error('Invalid succession context attachment.');
    if (Buffer.byteLength(record.text) > MAX_NORMALIZED_CONTEXT_BYTES) throw new Error('Succession context byte limit exceeded.');
    if (!isSuccessionRequest({ operationId: record.operationId, roleId: record.roleId, expectedRevision: record.roleRevision - 1, from: record.source })
      || record.capturedAt.length > 512 || record.boundary.epoch.length > 512 || /[\u0000-\u001f]/.test(record.boundary.epoch)) throw new Error('Invalid succession context identity.');
    if (Object.keys(record).some(name => !['operationId', 'roleId', 'roleRevision', 'source', 'target', 'capturedAt', 'boundary', 'text', 'itemCount', 'shortenedToolCount', 'inheritedFrom', 'version', 'state', 'deliveries', 'reservedBytes', 'resumeHandle', 'resumeReservedBytes'].includes(name))
      || Object.keys(record.boundary).some(name => !['epoch', 'seq'].includes(name))) throw new Error('Invalid succession context fields.');
    if (record.inheritedFrom && (!nonempty(record.inheritedFrom.operationId) || !isNativeSessionRef(record.inheritedFrom.source) || !nonempty(record.inheritedFrom.boundary?.epoch) || !Number.isSafeInteger(record.inheritedFrom.boundary.seq) || record.inheritedFrom.boundary.seq < 0 || !Number.isFinite(Date.parse(record.inheritedFrom.capturedAt)))) throw new Error('Invalid inherited succession provenance.');
    const rows: unknown = JSON.parse(record.text);
    if (!Array.isArray(rows) || rows.length !== record.itemCount || !rows.every(row => row && ['user', 'assistant', 'tool'].includes(row.role) && typeof row.text === 'string')) throw new Error('Invalid normalized succession history.');
  }
  private validate(state: ContextState): void {
    if (!state || state.version !== 3 || !Array.isArray(state.attachments) || state.preparations !== undefined && !Array.isArray(state.preparations)
      || state.attachments.length + (state.preparations?.length ?? 0) > 512) throw new Error('Unsupported succession context storage format/version.');
    if (state.coverage !== undefined && (!Array.isArray(state.coverage) || state.coverage.length > 1024)) throw new Error('Invalid succession mutation coverage.');
    const coverageTargets = new Set<string>();
    for (const marker of state.coverage ?? []) {
      if (!marker || !isNativeSessionRef(marker.target) || marker.operationId !== undefined && (!nonempty(marker.operationId) || marker.operationId.length > 256)
        || marker.prepared !== undefined && (marker.prepared !== true || !marker.operationId)
        || Object.keys(marker).some(key => !['target', 'operationId', 'prepared'].includes(key))) throw new Error('Invalid succession mutation coverage.');
      const key = nativeSessionRefKey(marker.target);
      if (coverageTargets.has(key)) throw new Error('Duplicate succession mutation coverage.');
      coverageTargets.add(key);
    }
    const ids = new Set<string>(), targets = new Set<string>(), deliveries = new Set<string>();
    const validateProvenance = (record: SuccessionContextPreparation) => {
      if (!record.inheritedFrom) return;
      const parent = state.attachments.find(item => item.operationId === record.inheritedFrom!.operationId);
      if (!parent || parent.operationId === record.operationId || !sameRef(parent.source, record.inheritedFrom.source) || !sameRef(parent.target, record.source) || parent.roleId !== record.roleId || parent.roleRevision + 1 !== record.roleRevision || parent.boundary.epoch !== record.inheritedFrom.boundary.epoch || parent.boundary.seq !== record.inheritedFrom.boundary.seq || parent.capturedAt !== record.inheritedFrom.capturedAt || parent.text !== record.text) throw new Error('Inherited succession provenance does not match retained attachment.');
    };
    for (const record of state.preparations ?? []) {
      this.validatePreparation(record); validateProvenance(record);
      if (record.version !== 2 || ids.has(record.operationId) || !isReservation(record.reservedBytes) || record.reservedBytes !== reservationBytes(this.bindingGrowth(record))
        || Object.keys(record).some(name => !['operationId', 'roleId', 'roleRevision', 'source', 'capturedAt', 'boundary', 'text', 'itemCount', 'shortenedToolCount', 'inheritedFrom', 'version', 'reservedBytes'].includes(name))) throw new Error('Invalid saved context preparation.');
      ids.add(record.operationId);
    }
    for (const record of state.attachments) {
      this.validateAttachment(record);
      if (record.resumeHandle) this.validateResumeHandle(record, record.resumeHandle);
      if (record.resumeReservedBytes !== undefined && (!isReservation(record.resumeReservedBytes)
        || record.resumeReservedBytes !== reservationBytes(this.resumeGrowth(record)))) throw new Error('Invalid recovery configuration capacity reservation.');
      const target = nativeSessionRefKey(record.target);
      if (![1, 2, 3].includes(record.version) || ids.has(record.operationId) || targets.has(target) || !Array.isArray(record.deliveries) || record.deliveries.length > 512
        || 'reservedBytes' in record || !['pending', 'dispatching', 'accepted', 'unknown', 'materialized'].includes(record.state)) throw new Error('Invalid succession context record.');
      validateProvenance(record);
      ids.add(record.operationId); targets.add(target);
      let contextState: SuccessionContextRecord['state'] = 'pending', unresolved = 0;
      for (const delivery of record.deliveries) {
        this.validateInput(delivery);
        if (deliveries.has(delivery.operationId) || !sameRef(record.target, delivery.target) || record.roleId !== delivery.roleId || record.roleRevision !== delivery.roleRevision
          || typeof delivery.includesContext !== 'boolean' || !['dispatching', 'accepted', 'unknown', 'rejected', 'materialized'].includes(delivery.state)
          || delivery.nativeEvidence !== undefined && !nonempty(delivery.nativeEvidence)
          || delivery.inputAcceptance !== undefined && (!['accepted', 'materialized', 'rejected'].includes(delivery.state) || !['started', 'queued', 'handled'].includes(delivery.inputAcceptance.disposition) || Object.keys(delivery.inputAcceptance).some(name => name !== 'disposition'))
          || delivery.reservedBytes !== undefined && (!isReservation(delivery.reservedBytes) || delivery.reservedBytes !== reservationBytes(this.deliveryGrowth(record, delivery)))) throw new Error('Invalid succession delivery record.');
        if (delivery.preparedInput !== undefined) {
          if (record.version !== 3 || delivery.reservedBytes === undefined) throw new Error('Optional input evidence requires its versioned reservation.');
          this.validatePreparedInput(record, delivery);
          if (delivery.state === 'materialized') {
            const execution = this.validatePositiveProof(delivery, delivery.nativeEvidence!);
            if (execution && delivery.inputAcceptance?.disposition !== execution.disposition) throw new Error('Native execution disposition differs from retained proof.');
          }
          else if (delivery.nativeEvidence !== undefined) throw new Error('Unsettled native delivery cannot contain materialization proof.');
        }
        deliveries.add(delivery.operationId);
        if (isSuccessionDeliveryUnresolved(delivery)) unresolved++;
        if (delivery.includesContext) {
          if (contextState !== 'pending') throw new Error('Invalid repeated succession context dispatch.');
          contextState = delivery.state === 'rejected' ? 'pending' : delivery.state;
        } else if (contextState !== 'materialized') throw new Error('Succession input bypasses pending context.');
      }
      if (unresolved > 1 || contextState !== record.state) throw new Error('Invalid succession context delivery state.');
    }
  }
  private mutate<T>(change: (state: ContextState) => T): Promise<T> {
    const next = this.tail.catch(() => undefined).then(async () => {
      await this.ready; this.assertReadable(); const state = structuredClone(this.state), result = change(state);
      this.updateReservations(state); this.validate(state); this.checkCapacity(state);
      if (JSON.stringify(state) !== JSON.stringify(this.state)) { await this.write(state); this.state = state; }
      return structuredClone(result);
    });
    this.tail = next; return next;
  }
  private async restore(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let text: string;
    try { text = await readFile(join(this.directory, 'context.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.loaded = true; return; }
    if (Buffer.byteLength(text) > MAX_STORE_BYTES) throw new Error('Succession context storage byte limit exceeded.');
    const parsed = JSON.parse(text);
    if (parsed.version === 1 && (parsed.preparations !== undefined || parsed.attachments?.some((record: SuccessionContextRecord) => record.version !== 1 || record.deliveries?.some(delivery => delivery.reservedBytes !== undefined)))) throw new Error('Ambiguous legacy context storage.');
    const legacy = [1, 2].includes(parsed.version);
    if (legacy && parsed.attachments?.some((record: SuccessionContextRecord) => record.version === 3 || record.deliveries?.some(delivery => delivery.preparedInput !== undefined))) throw new Error('Legacy context cannot certify optional native evidence.');
    const state: ContextState = legacy ? { ...parsed, version: 3 } : parsed;
    this.validate(state); let changed = legacy;
    for (const record of state.attachments) if (record.resumeReservedBytes !== undefined) record.resumeReservedBytes = reservationBytes(this.resumeGrowth(record));
    for (const record of state.attachments) for (const delivery of record.deliveries) if (delivery.state === 'dispatching') {
      delivery.state = 'unknown'; if (delivery.includesContext) record.state = 'unknown'; changed = true;
    }
    this.updateReservations(state); this.checkCapacity(state);
    if (changed) await this.write(state);
    this.state = state;
    this.restoredAt = this.now();
    for (const marker of state.coverage ?? []) this.lostCoverage.add(nativeSessionRefKey(marker.target));
    this.loaded = true;
  }
  private async write(state: ContextState): Promise<void> {
    this.checkCapacity(state);
    try { await publishSuccessionState(this.directory, 'context.json', state); }
    catch (error) { if (error instanceof SuccessionPublicationUnknown) this.writeFailure = error; throw error; }
  }
}

export interface SuccessionNativeDispatchResult { outcome: 'accepted' | 'rejected' | 'unknown'; inputAcceptance?: AgentInputAcceptance }
/** Own this once per Controller and route execution-capable inputs through it at the last native boundary. */
export class SessionSuccessionInputDispatcher {
  constructor(private readonly store: SessionSuccessionContextStore) {}
  dispatch(input: SuccessionInput, validateAdmission: () => Promise<void>, nativeDispatch: (input: SuccessionInput, contextPrefix: string, witness?: AgentPreparedTextInput) => Promise<SuccessionNativeDispatchResult>,
    prepareInput?: (input: SuccessionInput) => Promise<AgentPreparedTextInput>): Promise<SuccessionContextDelivery> {
    const admitted = structuredClone(input);
    return this.store.serialized(admitted.target, async () => {
      await this.store.ready;
      const attachment = this.store.forTarget(admitted.target);
      if (!attachment) throw new Error('Succession context attachment was not found.');
      const prior = attachment.deliveries.find(item => item.operationId === admitted.operationId);
      if (prior) {
        if (inputIdentity(prior) !== inputIdentity(admitted)) throw new Error('Succession input identity conflict.');
        return prior;
      }
      await validateAdmission();
      if (attachment.deliveries.some(isSuccessionDeliveryUnresolved)) throw new AgentOperationRejectedError('succession_delivery_unresolved', 'Succession input delivery is unresolved.');
      const prefix = attachment.state !== 'materialized' ? quotedSessionContextPrefix({ id: attachment.operationId, sourceSession: attachment.source.nativeSessionId,
        capturedAt: attachment.capturedAt, text: attachment.text, shortenedToolCount: attachment.shortenedToolCount }) : '';
      const text = prefix + admitted.text;
      const witness = await prepareInput?.({ ...admitted, text });
      const delivery = await this.store.begin(attachment.operationId, admitted, witness);
      // The Host must fence queued work again after durable reservation, before the native call.
      try { await validateAdmission(); }
      catch (error) { await this.store.settle(attachment.operationId, admitted.operationId, 'rejected'); throw error; }
      let result: SuccessionNativeDispatchResult;
      try { result = await nativeDispatch({ ...admitted, text }, prefix, delivery.preparedInput?.witness); }
      catch (error) {
        await this.store.settle(attachment.operationId, admitted.operationId, 'unknown');
        throw error;
      }
      // Rejected must mean a definitive pre-dispatch rejection, never timeout or queued acceptance.
      if (!result || !['accepted', 'rejected', 'unknown'].includes(result.outcome)) {
        await this.store.settle(attachment.operationId, admitted.operationId, 'unknown');
        throw new Error('Invalid native succession dispatch outcome.');
      }
      return this.store.settle(attachment.operationId, admitted.operationId, result.outcome, result.inputAcceptance);
    });
  }
}

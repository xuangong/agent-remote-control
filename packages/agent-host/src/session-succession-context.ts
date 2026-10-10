import { AgentOperationRejectedError, type AgentInputAcceptance } from '@orchardworks/agent-provider-sdk';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isNativeSessionRef, isSuccessionRequest, nativeSessionRefKey, MAX_NORMALIZED_CONTEXT_BYTES, MAX_NORMALIZED_CONTEXT_ENTRIES, quotedSessionContextPrefix,
  type NativeSessionRef, type TimelineCursor } from '@orchardworks/agent-remote-protocol';
import { assertSuccessionCapacity, isReservation, jsonBytes, largestSuccessionRef, publishSuccessionState, reservationBytes, SuccessionPublicationUnknown } from './succession-persistence.js';

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
export interface SuccessionContextDelivery extends SuccessionInput {
  reservedBytes?: string;
  state: SuccessionDeliveryState;
  includesContext: boolean;
  nativeEvidence?: string;
  /** The actual native return receipt; absent means the adapter returned void. */
  inputAcceptance?: AgentInputAcceptance;
}
export interface SuccessionContextRecord extends SuccessionContextAttachment {
  version: 1 | 2;
  state: 'pending' | 'dispatching' | 'accepted' | 'unknown' | 'materialized';
  deliveries: SuccessionContextDelivery[];
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
interface ContextState { version: 2; attachments: SuccessionContextRecord[]; preparations?: ContextPreparationRecord[] }
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const sameRef = (a: NativeSessionRef, b: NativeSessionRef) => nativeSessionRefKey(a) === nativeSessionRefKey(b);
const attachmentIdentity = (input: SuccessionContextAttachment) => JSON.stringify([input.operationId, input.roleId, input.roleRevision, nativeSessionRefKey(input.source), nativeSessionRefKey(input.target), input.capturedAt, input.boundary.epoch, input.boundary.seq, input.text, input.itemCount, input.shortenedToolCount ?? 0, input.inheritedFrom ? [input.inheritedFrom.operationId, nativeSessionRefKey(input.inheritedFrom.source), input.inheritedFrom.boundary.epoch, input.inheritedFrom.boundary.seq, input.inheritedFrom.capturedAt] : null]);
const inputIdentity = (input: SuccessionInput) => JSON.stringify([input.operationId, input.roleId, input.roleRevision, nativeSessionRefKey(input.target), input.text, input.contentIdentity ?? null]);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Single-Controller ownership; snapshots are replaced atomically before native dispatch. */
export class SessionSuccessionContextStore {
  readonly ready: Promise<void>;
  private state: ContextState = { version: 2, attachments: [] };
  private loaded = false;
  private writeFailure?: Error;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly dispatchTails = new Map<string, Promise<unknown>>();
  constructor(private readonly directory: string) { this.ready = this.restore(); }
  read(operationId: string): SuccessionContextRecord {
    this.assertReadable();
    return structuredClone(this.find(this.state, operationId));
  }
  forTarget(target: NativeSessionRef): SuccessionContextRecord | undefined {
    this.assertReadable();
    return structuredClone(this.state.attachments.find(item => sameRef(item.target, target)));
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
  begin(attachmentId: string, input: SuccessionInput): Promise<SuccessionContextDelivery> {
    const admitted = structuredClone(input);
    return this.mutate(state => {
      this.validateInput(admitted);
      const record = this.find(state, attachmentId);
      if (!sameRef(record.target, admitted.target) || record.roleId !== admitted.roleId || record.roleRevision !== admitted.roleRevision) throw new Error('Succession input routing identity conflict.');
      const prior = state.attachments.flatMap(item => item.deliveries).find(item => item.operationId === admitted.operationId);
      if (prior) {
        if (inputIdentity(prior) !== inputIdentity(admitted)) throw new Error('Succession input identity conflict.');
        return prior;
      }
      if (record.deliveries.some(item => ['dispatching', 'accepted', 'unknown'].includes(item.state))) throw new AgentOperationRejectedError('succession_delivery_unresolved', 'Succession input delivery is unresolved.');
      if (record.deliveries.length >= 512) throw new Error('Succession input receipt limit exceeded.');
      const delivery: SuccessionContextDelivery = { ...admitted, state: 'dispatching', includesContext: record.state !== 'materialized', reservedBytes: '00000000' };
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
    });
  }
  /** Explicit adapter reconciliation; a transport receipt or ordinary empty history is insufficient. */
  reconcile(attachmentId: string, evidence: SuccessionDeliveryEvidence): Promise<SuccessionContextDelivery> {
    const proof = structuredClone(evidence);
    return this.mutate(state => {
      const record = this.find(state, attachmentId), delivery = record.deliveries.find(item => item.operationId === proof.operationId);
      if (!delivery || !sameRef(delivery.target, proof.target) || delivery.roleRevision !== proof.roleRevision || !nonempty(proof.nativeEvidence)
        || !['materialized', 'not-dispatched'].includes(proof.outcome)) throw new Error('Succession delivery evidence identity conflict.');
      const result = proof.outcome === 'materialized' ? 'materialized' : 'rejected';
      if (delivery.state === result && delivery.nativeEvidence === proof.nativeEvidence) return delivery;
      if (!['accepted', 'unknown'].includes(delivery.state)) throw new Error('Succession delivery cannot be reconciled in its current state.');
      delivery.state = result; delivery.nativeEvidence = proof.nativeEvidence;
      if (delivery.includesContext) record.state = result === 'rejected' ? 'pending' : 'materialized';
      return delivery;
    });
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
    if (delivery.state !== 'dispatching') return 0;
    const current = jsonBytes({ state: record.state, delivery });
    return Math.max(0, ...(['accepted', 'rejected', 'unknown'] as const).map(outcome => {
      const next = { ...delivery, state: outcome, ...(outcome === 'accepted' ? { inputAcceptance: { disposition: 'started' } } : {}) };
      return jsonBytes({ state: delivery.includesContext ? outcome === 'rejected' ? 'pending' : outcome : record.state, delivery: next }) - current;
    }));
  }
  private updateReservations(state: ContextState): void {
    for (const preparation of state.preparations ?? []) preparation.reservedBytes = reservationBytes(this.bindingGrowth(preparation));
    for (const record of state.attachments) for (const delivery of record.deliveries) if (delivery.reservedBytes !== undefined) delivery.reservedBytes = reservationBytes(this.deliveryGrowth(record, delivery));
  }
  private checkCapacity(state: ContextState): void {
    const reserved = (state.preparations ?? []).reduce((sum, record) => sum + Number(record.reservedBytes), 0)
      + state.attachments.reduce((sum, record) => sum + record.deliveries.reduce((total, delivery) => total + Number(delivery.reservedBytes ?? 0), 0), 0);
    assertSuccessionCapacity(state, reserved);
  }
  private validateInput(input: SuccessionInput): void {
    if (!input || !nonempty(input.operationId) || !nonempty(input.roleId) || !isNativeSessionRef(input.target)
      || !Number.isSafeInteger(input.roleRevision) || input.roleRevision < 2 || typeof input.text !== 'string'
      || input.contentIdentity !== undefined && !nonempty(input.contentIdentity)) throw new Error('Invalid succession input.');
    if (Buffer.byteLength(input.text) > MAX_NORMALIZED_CONTEXT_BYTES || (input.contentIdentity?.length ?? 0) > 1024) throw new Error('Succession input byte limit exceeded.');
    if (!isSuccessionRequest({ operationId: input.operationId, roleId: input.roleId, expectedRevision: input.roleRevision - 1, from: input.target })) throw new Error('Invalid succession input identity.');
    if (Object.keys(input).some(name => !['operationId', 'roleId', 'roleRevision', 'target', 'text', 'contentIdentity', 'state', 'includesContext', 'nativeEvidence', 'inputAcceptance', 'reservedBytes'].includes(name))) throw new Error('Invalid succession delivery fields.');
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
    if (Object.keys(record).some(name => !['operationId', 'roleId', 'roleRevision', 'source', 'target', 'capturedAt', 'boundary', 'text', 'itemCount', 'shortenedToolCount', 'inheritedFrom', 'version', 'state', 'deliveries', 'reservedBytes'].includes(name))
      || Object.keys(record.boundary).some(name => !['epoch', 'seq'].includes(name))) throw new Error('Invalid succession context fields.');
    if (record.inheritedFrom && (!nonempty(record.inheritedFrom.operationId) || !isNativeSessionRef(record.inheritedFrom.source) || !nonempty(record.inheritedFrom.boundary?.epoch) || !Number.isSafeInteger(record.inheritedFrom.boundary.seq) || record.inheritedFrom.boundary.seq < 0 || !Number.isFinite(Date.parse(record.inheritedFrom.capturedAt)))) throw new Error('Invalid inherited succession provenance.');
    const rows: unknown = JSON.parse(record.text);
    if (!Array.isArray(rows) || rows.length !== record.itemCount || !rows.every(row => row && ['user', 'assistant', 'tool'].includes(row.role) && typeof row.text === 'string')) throw new Error('Invalid normalized succession history.');
  }
  private validate(state: ContextState): void {
    if (!state || state.version !== 2 || !Array.isArray(state.attachments) || state.preparations !== undefined && !Array.isArray(state.preparations)
      || state.attachments.length + (state.preparations?.length ?? 0) > 512) throw new Error('Unsupported succession context storage format/version.');
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
      const target = nativeSessionRefKey(record.target);
      if (![1, 2].includes(record.version) || ids.has(record.operationId) || targets.has(target) || !Array.isArray(record.deliveries) || record.deliveries.length > 512
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
        deliveries.add(delivery.operationId);
        if (['dispatching', 'accepted', 'unknown'].includes(delivery.state)) unresolved++;
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
    const state: ContextState = parsed.version === 1 ? { ...parsed, version: 2 } : parsed;
    this.validate(state); let changed = parsed.version === 1;
    for (const record of state.attachments) for (const delivery of record.deliveries) if (delivery.state === 'dispatching') {
      delivery.state = 'unknown'; if (delivery.includesContext) record.state = 'unknown'; changed = true;
    }
    this.updateReservations(state); this.checkCapacity(state);
    if (changed) await this.write(state);
    this.state = state; this.loaded = true;
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
  dispatch(input: SuccessionInput, validateAdmission: () => Promise<void>, nativeDispatch: (input: SuccessionInput, contextPrefix: string) => Promise<SuccessionNativeDispatchResult>): Promise<SuccessionContextDelivery> {
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
      const delivery = await this.store.begin(attachment.operationId, admitted);
      const prefix = delivery.includesContext ? quotedSessionContextPrefix({ id: attachment.operationId, sourceSession: attachment.source.nativeSessionId,
        capturedAt: attachment.capturedAt, text: attachment.text, shortenedToolCount: attachment.shortenedToolCount }) : '';
      const text = prefix + admitted.text;
      // The Host must fence queued work again after durable reservation, before the native call.
      try { await validateAdmission(); }
      catch (error) { await this.store.settle(attachment.operationId, admitted.operationId, 'rejected'); throw error; }
      let result: SuccessionNativeDispatchResult;
      try { result = await nativeDispatch({ ...admitted, text }, prefix); }
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

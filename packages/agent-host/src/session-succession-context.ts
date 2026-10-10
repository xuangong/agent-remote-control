import { AgentOperationRejectedError, type AgentInputAcceptance } from '@orchardworks/agent-provider-sdk';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeSessionRefKey, MAX_NORMALIZED_CONTEXT_BYTES, MAX_NORMALIZED_CONTEXT_ENTRIES, quotedSessionContextPrefix,
  type NativeSessionRef, type TimelineCursor } from '@orchardworks/agent-remote-protocol';

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
  state: SuccessionDeliveryState;
  includesContext: boolean;
  nativeEvidence?: string;
  /** The actual native return receipt; absent means the adapter returned void. */
  inputAcceptance?: AgentInputAcceptance;
}
export interface SuccessionContextRecord extends SuccessionContextAttachment {
  version: 1;
  state: 'pending' | 'dispatching' | 'accepted' | 'unknown' | 'materialized';
  deliveries: SuccessionContextDelivery[];
}
export interface SuccessionDeliveryEvidence {
  operationId: string;
  target: NativeSessionRef;
  roleRevision: number;
  /** Only authoritative adapter evidence can certify either outcome. */
  outcome: 'materialized' | 'not-dispatched';
  nativeEvidence: string;
}
interface ContextState { version: 1; attachments: SuccessionContextRecord[] }
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const isNativeSessionRef = (value: unknown): value is NativeSessionRef => { const ref = value as NativeSessionRef | undefined; return !!ref && nonempty(ref.controllerId) && nonempty(ref.providerId) && nonempty(ref.nativeSessionId); };
const sameRef = (a: NativeSessionRef, b: NativeSessionRef) => nativeSessionRefKey(a) === nativeSessionRefKey(b);
const attachmentIdentity = (input: SuccessionContextAttachment) => JSON.stringify([input.operationId, input.roleId, input.roleRevision, nativeSessionRefKey(input.source), nativeSessionRefKey(input.target), input.capturedAt, input.boundary.epoch, input.boundary.seq, input.text, input.itemCount, input.shortenedToolCount ?? 0]);
const inputIdentity = (input: SuccessionInput) => JSON.stringify([input.operationId, input.roleId, input.roleRevision, nativeSessionRefKey(input.target), input.text, input.contentIdentity ?? null]);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Single-Controller ownership; snapshots are replaced atomically before native dispatch. */
export class SessionSuccessionContextStore {
  readonly ready: Promise<void>;
  private state: ContextState = { version: 1, attachments: [] };
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
      if (state.attachments.length >= 512) throw new Error('Succession context attachment limit exceeded.');
      if (state.attachments.some(item => sameRef(item.target, input.target))) throw new Error('Succession target already has context.');
      const record: SuccessionContextRecord = { ...input, version: 1, state: 'pending', deliveries: [] };
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
      const delivery: SuccessionContextDelivery = { ...admitted, state: 'dispatching', includesContext: record.state !== 'materialized' };
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
        if (outcome !== 'accepted' || !['started', 'queued', 'handled'].includes(inputAcceptance.disposition)) throw new Error('Invalid native input acceptance receipt.');
        delivery.inputAcceptance = structuredClone(inputAcceptance);
      }
      if (delivery.includesContext) record.state = outcome === 'rejected' ? 'pending' : outcome;
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
  private validateInput(input: SuccessionInput): void {
    if (!input || !nonempty(input.operationId) || !nonempty(input.roleId) || !isNativeSessionRef(input.target)
      || !Number.isSafeInteger(input.roleRevision) || input.roleRevision < 2 || typeof input.text !== 'string'
      || input.contentIdentity !== undefined && !nonempty(input.contentIdentity)) throw new Error('Invalid succession input.');
    if (Buffer.byteLength(input.text) > MAX_NORMALIZED_CONTEXT_BYTES || (input.contentIdentity?.length ?? 0) > 1024) throw new Error('Succession input byte limit exceeded.');
  }
  private validateAttachment(record: SuccessionContextAttachment): void {
    if (!record || !nonempty(record.operationId) || !nonempty(record.roleId) || !Number.isSafeInteger(record.roleRevision) || record.roleRevision < 2
      || !isNativeSessionRef(record.source) || !isNativeSessionRef(record.target) || sameRef(record.source, record.target)
      || !nonempty(record.capturedAt) || !Number.isFinite(Date.parse(record.capturedAt)) || !record.boundary || !nonempty(record.boundary.epoch)
      || !Number.isSafeInteger(record.boundary.seq) || record.boundary.seq < 0 || typeof record.text !== 'string'
      || !Number.isSafeInteger(record.itemCount) || record.itemCount < 0 || record.itemCount > MAX_NORMALIZED_CONTEXT_ENTRIES
      || record.shortenedToolCount !== undefined && (!Number.isSafeInteger(record.shortenedToolCount) || record.shortenedToolCount < 0 || record.shortenedToolCount > record.itemCount)) throw new Error('Invalid succession context attachment.');
    if (Buffer.byteLength(record.text) > MAX_NORMALIZED_CONTEXT_BYTES) throw new Error('Succession context byte limit exceeded.');
    const rows: unknown = JSON.parse(record.text);
    if (!Array.isArray(rows) || rows.length !== record.itemCount || !rows.every(row => row && ['user', 'assistant', 'tool'].includes(row.role) && typeof row.text === 'string')) throw new Error('Invalid normalized succession history.');
  }
  private validate(state: ContextState): void {
    if (!state || state.version !== 1 || !Array.isArray(state.attachments) || state.attachments.length > 512) throw new Error('Unsupported succession context storage format/version.');
    const ids = new Set<string>(), targets = new Set<string>(), deliveries = new Set<string>();
    for (const record of state.attachments) {
      this.validateAttachment(record);
      const target = nativeSessionRefKey(record.target);
      if (record.version !== 1 || ids.has(record.operationId) || targets.has(target) || !Array.isArray(record.deliveries) || record.deliveries.length > 512
        || !['pending', 'dispatching', 'accepted', 'unknown', 'materialized'].includes(record.state)) throw new Error('Invalid succession context record.');
      ids.add(record.operationId); targets.add(target);
      let contextState: SuccessionContextRecord['state'] = 'pending', unresolved = 0;
      for (const delivery of record.deliveries) {
        this.validateInput(delivery);
        if (deliveries.has(delivery.operationId) || !sameRef(record.target, delivery.target) || record.roleId !== delivery.roleId || record.roleRevision !== delivery.roleRevision
          || typeof delivery.includesContext !== 'boolean' || !['dispatching', 'accepted', 'unknown', 'rejected', 'materialized'].includes(delivery.state)
          || delivery.nativeEvidence !== undefined && !nonempty(delivery.nativeEvidence)
          || delivery.inputAcceptance !== undefined && (!['accepted', 'materialized', 'rejected'].includes(delivery.state) || !['started', 'queued', 'handled'].includes(delivery.inputAcceptance.disposition))) throw new Error('Invalid succession delivery record.');
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
      await this.ready; this.assertReadable(); const state = structuredClone(this.state), result = change(state); this.validate(state);
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
    const state = JSON.parse(text) as ContextState; this.validate(state); let changed = false;
    for (const record of state.attachments) for (const delivery of record.deliveries) if (delivery.state === 'dispatching') {
      delivery.state = 'unknown'; if (delivery.includesContext) record.state = 'unknown'; changed = true;
    }
    if (changed) await this.write(state);
    this.state = state; this.loaded = true;
  }
  private async write(state: ContextState): Promise<void> {
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text) > MAX_STORE_BYTES) throw new Error('Succession context storage byte limit exceeded.');
    const target = join(this.directory, 'context.json'), temporary = `${target}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
      await rename(temporary, target); renamed = true;
      try {
        const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) {
        // Windows does not expose directory fsync through Node; actual storage errors remain fatal.
        if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    } catch (error) {
      if (renamed) this.writeFailure = new Error('Succession context persistence outcome is unknown. Restart and reconcile before dispatch.', { cause: error });
      throw error;
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
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

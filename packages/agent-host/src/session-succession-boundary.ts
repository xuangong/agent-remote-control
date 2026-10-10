import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { AgentOperationRejectedError, type AgentSession, type AgentInputAcceptance, type AgentInputPart, type AgentMessageOptions } from '@orchardworks/agent-provider-sdk';
import { nativeSessionRefKey, type NativeSessionRef, type TimelineCursor } from '@orchardworks/agent-remote-protocol';
import type { SessionWireOperation, OperationCache, MutationEntry } from '@orchardworks/agent-remote-relay';
import { SessionSuccessionContextStore, SessionSuccessionInputDispatcher } from './session-succession-context.js';

const mutations = new Set(['sendMessage', 'sendMessageContent', 'steer', 'cancel', 'respondToInteraction', 'setPlanning', 'setSessionSetting', 'executeCommand']);
interface AdmittedOperation { operationId: string; operation: SessionWireOperation; entry?: MutationEntry }
interface RoleDestination { roleId: string; roleRevision: number }

/** Host-owned native dispatch boundary shared by browser, HTTP and TPM operations. */
export class SessionSuccessionBoundary {
  private readonly context = new AsyncLocalStorage<AdmittedOperation>();
  private readonly dispatcher: SessionSuccessionInputDispatcher;
  private readonly admissions = new Map<string, ReadonlySet<string>>();
  private readonly reservations = new Map<string, Map<string, { target: NativeSessionRef; disable?: () => void }>>();
  private readonly enabled = new Map<string, () => void>();
  constructor(private readonly contexts: SessionSuccessionContextStore,
    private readonly assertAdmission: (target: NativeSessionRef) => void,
    private readonly resolveRole: (target: NativeSessionRef) => RoleDestination | undefined,
    private readonly cache?: OperationCache,
    private readonly assertHostState: (target: NativeSessionRef, boundary?: TimelineCursor, allowMissing?: boolean) => void = () => {}) {
    this.dispatcher = new SessionSuccessionInputDispatcher(contexts);
  }
  run<T>(operation: SessionWireOperation, scope: string, work: () => Promise<T>, entry?: MutationEntry): Promise<T> {
    const operationId = createHash('sha256').update(JSON.stringify([scope, operation.operationId])).digest('hex');
    return this.context.run({ operationId, operation, entry }, work);
  }
  close(): void {
    for (const id of this.reservations.keys()) this.releaseReservation(id);
    for (const disable of this.enabled.values()) disable();
    this.enabled.clear(); this.admissions.clear();
  }
  currentEntry(): MutationEntry | undefined { return this.context.getStore()?.entry; }
  pending(target: NativeSessionRef): number {
    const key = nativeSessionRefKey(target);
    return [...this.admissions.values()].filter(targets => targets.has(key)).length;
  }
  admit(targets: readonly NativeSessionRef[], operationKey: string): () => void {
    for (const target of targets) this.validate(target);
    if (this.admissions.has(operationKey)) throw new AgentOperationRejectedError('operation_conflict', 'This operation is already admitted.');
    this.admissions.set(operationKey, new Set(targets.map(nativeSessionRefKey)));
    return () => { this.admissions.delete(operationKey); };
  }
  checkSource(target: NativeSessionRef): void {
    if (this.pending(target) || this.cache?.hasUnsettledMutation(nativeSessionRefKey(target))) throw new Error('Session has unsettled Host mutations.');
    this.assertHostState(target, undefined, true);
  }
  reserve(operationId: string, source: NativeSessionRef, restored = false): void {
    const key = nativeSessionRefKey(source), prior = this.reservations.get(operationId);
    if (prior) { if (!prior.has(key)) throw new Error('Succession reservation identity changed.'); return; }
    if ([...this.reservations.values()].some(targets => targets.has(key))) throw new Error('Session is reserved for another handoff.');
    if (!restored) this.validate(source);
    this.assertQuiescent(source);
    this.reservations.set(operationId, new Map([[key, { target: structuredClone(source), disable: this.cache?.enableMutationTarget(key) }]]));
  }
  registerCandidate(operationId: string, target: NativeSessionRef): { conflict: boolean } {
    const reservation = this.reservations.get(operationId);
    // A late cancelled create is orphan evidence, never a new admission fence.
    if (!reservation) return { conflict: false };
    const key = nativeSessionRefKey(target);
    let conflict = this.pending(target) > 0 || this.cache?.hasUnsettledMutation(key) === true;
    for (const [id, targets] of this.reservations) if (id !== operationId && targets.has(key)) conflict = true;
    if (!reservation.has(key)) reservation.set(key, { target: structuredClone(target), disable: this.cache?.enableMutationTarget(key) });
    return { conflict };
  }
  assertCommit(operationId: string, sourceBoundary?: TimelineCursor): void {
    const reservation = this.reservations.get(operationId);
    if (!reservation) throw new Error('Succession admission must be re-established after restart.');
    for (const [id, targets] of this.reservations) {
      if (id !== operationId && [...targets.keys()].some(key => reservation.has(key))) throw new Error('Candidate has a conflicting handoff reservation.');
    }
    let first = true;
    for (const { target } of reservation.values()) { this.assertQuiescent(target, first ? sourceBoundary : undefined); first = false; }
  }
  releaseReservation(operationId: string, committed = false): void {
    const reservation = this.reservations.get(operationId);
    if (!reservation) return;
    this.reservations.delete(operationId);
    for (const [key, value] of reservation) {
      if (committed && value.disable && !this.enabled.has(key)) this.enabled.set(key, value.disable);
      else value.disable?.();
    }
  }
  private assertQuiescent(target: NativeSessionRef, boundary?: TimelineCursor): void {
    if (this.pending(target) || this.cache?.hasUnsettledMutation(nativeSessionRefKey(target))) throw new Error('Session has unsettled Host mutations.');
    this.assertHostState(target, boundary);
  }
  async mutate<T>(target: NativeSessionRef, work: () => Promise<T>): Promise<T> {
    const admitted = this.context.getStore();
    if (admitted?.entry) {
      if (!admitted.entry.targets.includes(nativeSessionRefKey(target))) throw new AgentOperationRejectedError('invalid_operation_target', 'Native target is outside this operation admission.');
      this.validate(target); return work();
    }
    const release = this.admit([target], randomUUID());
    try { return await work(); } finally { release(); }
  }
  private nativeMutation<T>(target: NativeSessionRef, work: () => Promise<T>): Promise<T> {
    if (this.currentEntry() || !this.cache) return this.mutate(target, work);
    const operationId = randomUUID(), key = nativeSessionRefKey(target);
    const operation: SessionWireOperation = { operationId, kind: 'execute_command', parameters: {}, maximumResultBytes: 8192 };
    return this.cache.execute({ operationId, scope: 'host:internal', kind: 'native_mutation', target: key, parameters: {} }, {
      mutationTargets: [key], admit: entry => this.admit([target], entry.key),
      run: (entry, run) => this.run(operation, 'host:internal', run, entry), dispatch: work,
    });
  }
  private async nativeEffect<T>(target: NativeSessionRef, input: boolean, work: () => Promise<T>): Promise<T> {
    this.validate(target);
    const effect = this.currentEntry()?.startNativeEffect(nativeSessionRefKey(target));
    try {
      const result = await work();
      const disposition = input ? (result as AgentInputAcceptance | undefined)?.disposition : undefined;
      if (!input || disposition === 'started' || disposition === 'handled') effect?.settled(); else effect?.unresolved();
      return result;
    } catch (error) {
      if (error instanceof AgentOperationRejectedError) effect?.settled(); else effect?.unresolved();
      throw error;
    }
  }
  private validate(target: NativeSessionRef): void {
    try {
      if ([...this.reservations.values()].some(targets => targets.has(nativeSessionRefKey(target)))) throw new Error('Session is reserved for handoff.');
      this.assertAdmission(target);
    }
    catch (error) { throw new AgentOperationRejectedError('succession_admission_closed', error instanceof Error ? error.message : 'Session handoff admission is closed.'); }
  }
  wrap(target: NativeSessionRef, session: AgentSession): AgentSession {
    const address = structuredClone(target), boundary = this;
    return new Proxy(session, { get(native, property) {
      const value = Reflect.get(native, property, native);
      if (typeof value !== 'function') return value;
      if (!mutations.has(String(property))) return value.bind(native);
      return (...args: unknown[]) => boundary.nativeMutation(address, async () => {
          if (property === 'sendMessage') return await boundary.send(address, args[0] as string, undefined, args[1] as AgentMessageOptions | undefined,
            (text, _parts, options) => boundary.nativeEffect(address, true, () => options === undefined ? native.sendMessage(text) : native.sendMessage(text, options)));
          if (property === 'sendMessageContent') {
            const parts = args[0] as readonly AgentInputPart[];
            return await boundary.send(address, parts.filter(part => part.type === 'text').map(part => part.text).join(''), parts, args[1] as AgentMessageOptions | undefined,
              (_text, content, options) => boundary.nativeEffect(address, true, () => native.sendMessageContent!(content!, options)));
          }
          const attachment = boundary.contexts.forTarget(address);
          if ((property === 'executeCommand' || property === 'steer') && attachment && attachment.state !== 'materialized') {
            throw new AgentOperationRejectedError('succession_context_pending', 'Send a message to deliver the pending handoff context before executing commands.');
          }
          boundary.validate(address);
          return await boundary.nativeEffect(address, property === 'steer', async () => Reflect.apply(value, native, args));
      });
    } });
  }
  private async send(target: NativeSessionRef, text: string, parts: readonly AgentInputPart[] | undefined, options: AgentMessageOptions | undefined,
    send: (text: string, parts: readonly AgentInputPart[] | undefined, options: AgentMessageOptions | undefined) => Promise<AgentInputAcceptance | void>): Promise<AgentInputAcceptance | void> {
    const attachment = this.contexts.forTarget(target);
    if (!attachment) { this.validate(target); return send(text, parts, options); }
    const admitted = this.context.getStore();
    if (!admitted) throw new AgentOperationRejectedError('succession_operation_identity_required', 'An admitted operation identity is required for this successor.');
    const role = this.resolveRole(target);
    if (!role || role.roleId !== attachment.roleId || role.roleRevision !== attachment.roleRevision) {
      throw new AgentOperationRejectedError('succession_not_committed', 'This candidate has not been committed as the current primary session.');
    }
    const contentIdentity = createHash('sha256').update(JSON.stringify([parts ?? null, options ?? null])).digest('hex');
    const prior = this.contexts.delivery(admitted.operationId);
    if (attachment.state === 'materialized' && !prior) { this.validate(target); return send(text, parts, options); }
    let result: AgentInputAcceptance | void = undefined, rejected: unknown;
    const delivery = await this.dispatcher.dispatch({ ...role, operationId: admitted.operationId, target, text, contentIdentity },
      async () => { this.validate(target); }, async (input, prefix) => {
        try {
          this.validate(target);
          result = await send(input.text, parts ? [...(prefix ? [{type: 'text' as const, text: prefix}] : []), ...parts] : undefined, options);
          return { outcome: 'accepted', ...(result ? { inputAcceptance: result } : {}) };
        } catch (error) {
          if (!(error instanceof AgentOperationRejectedError)) throw error;
          rejected = error; return { outcome: 'rejected' };
        }
      });
    if (rejected) throw rejected;
    if (delivery.state === 'unknown' || delivery.state === 'dispatching') throw new Error('The first handoff input has an unresolved delivery outcome. Reconcile native history before sending again.');
    if (delivery.state === 'rejected') throw new AgentOperationRejectedError('operation_rejected', 'This first input was rejected. Use a new operation identity after correcting its cause.');
    return delivery.inputAcceptance;
  }
}

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { AgentOperationRejectedError, type AgentSession, type AgentInputAcceptance, type AgentInputPart, type AgentMessageOptions, type AgentSessionNativeEvidence, type AgentRuntimeInfo } from '@orchardworks/agent-provider-sdk';
import { nativeSessionRefKey, type NativeSessionRef, type TimelineCursor } from '@orchardworks/agent-remote-protocol';
import type { SessionWireOperation, OperationCache, MutationEntry, NativeEffectHandle, NativeEffectReservation, SessionSettingIntentLifecycle } from '@orchardworks/agent-remote-relay';
import { isSuccessionDeliveryUnresolved, SessionSuccessionContextStore, SessionSuccessionInputDispatcher } from './session-succession-context.js';

const mutations = new Set(['sendMessage', 'sendMessageContent', 'steer', 'cancel', 'respondToInteraction', 'setPlanning', 'setSessionSetting', 'executeCommand']);
interface AdmittedOperation {
  operationId: string;
  operation: SessionWireOperation;
  entry?: MutationEntry;
  settingEffect?: { target: string; reservation: NativeEffectReservation };
}
interface RoleDestination { roleId: string; roleRevision: number }
type SettingMutationResult = Awaited<ReturnType<NonNullable<AgentSession['setSessionSetting']>>>;

/** Host-owned native dispatch boundary shared by browser, HTTP and TPM operations. */
export class SessionSuccessionBoundary {
  private readonly context = new AsyncLocalStorage<AdmittedOperation>();
  private readonly dispatcher: SessionSuccessionInputDispatcher;
  private readonly admissions = new Map<string, ReadonlySet<string>>();
  private readonly reservations = new Map<string, Map<string, { target: NativeSessionRef; disable?: () => void }>>();
  private readonly preparedInvocations = new Map<string, { target: string; effect?: NativeEffectHandle; onAcceptance?: AgentMessageOptions['onAcceptance'] }>();
  private readonly unsubscribeDelivery: () => void;
  private readonly unsubscribeSettlement?: () => void;
  private readonly enabled = new Map<string, () => void>();
  private readonly coverageWrites = new Set<Promise<void>>();
  private readonly recoveryWrites = new Set<Promise<unknown>>();
  private coverageFailure?: Error;
  private closePromise?: Promise<void>;
  private coverageRetired = false;
  constructor(private readonly contexts: SessionSuccessionContextStore,
    private readonly assertAdmission: (target: NativeSessionRef) => void,
    private readonly resolveRole: (target: NativeSessionRef) => RoleDestination | undefined,
    private readonly cache?: OperationCache,
    private readonly assertHostState: (target: NativeSessionRef, boundary?: TimelineCursor, allowMissing?: boolean) => void = () => {},
    private readonly assertAssociationReservation: (target: NativeSessionRef) => void = assertAdmission,
    private readonly requiresNativeEvidence: (target: NativeSessionRef) => boolean = () => false,
    private readonly reconcileFirstInput?: (operationId: string) => Promise<void>) {
    this.dispatcher = new SessionSuccessionInputDispatcher(contexts);
    this.unsubscribeSettlement = cache?.subscribeMutationSettlement(key => {
      const target = this.targetFromKey(key);
      if (target) void this.reconcileCoverage(target).catch(() => undefined);
    });
    this.unsubscribeDelivery = contexts.subscribeDelivery(delivery => {
      if (delivery.state !== 'rejected' && !['started', 'handled'].includes(delivery.inputAcceptance?.disposition ?? '')) return;
      const invocation = this.preparedInvocations.get(delivery.operationId);
      if (!invocation || invocation.target !== nativeSessionRefKey(delivery.target)) return;
      this.preparedInvocations.delete(delivery.operationId); invocation.effect?.settled();
      if (delivery.state !== 'rejected' && delivery.inputAcceptance) invocation.onAcceptance?.(delivery.inputAcceptance);
    });
  }
  run<T>(operation: SessionWireOperation, scope: string, work: () => Promise<T>, entry?: MutationEntry): Promise<T> {
    const operationId = createHash('sha256').update(JSON.stringify([scope, operation.operationId])).digest('hex');
    return this.context.run({ operationId, operation, entry }, async () => {
      for (const key of entry?.targets ?? []) {
        const target = this.targetFromKey(key);
        if (target) await this.contexts.markMutation(target, operationId);
      }
      return work();
    });
  }
  /** Attach Host preparation evidence before the shared operation cache retains its result. */
  inputResult<T>(target: NativeSessionRef, operation: SessionWireOperation, scope: string, result: T): T {
    if (operation.kind !== 'send_message') return result;
    // Internal callers retain native acceptance results instead of wire acknowledgement wrappers.
    if (!result || typeof result !== 'object' || Array.isArray(result) || !('accepted' in result) || result.accepted !== true) return result;
    const operationId = createHash('sha256').update(JSON.stringify([scope, operation.operationId])).digest('hex');
    const delivery = this.contexts.delivery(operationId);
    if (!delivery?.preparedInput) return result;
    if (nativeSessionRefKey(delivery.target) !== nativeSessionRefKey(target) || !['accepted', 'materialized'].includes(delivery.state)) {
      throw new Error('Prepared input result does not match its admitted submission.');
    }
    return { ...result, submittedTextSha256: delivery.preparedInput.witness.content.sha256 };
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.unsubscribeDelivery(); this.unsubscribeSettlement?.(); this.preparedInvocations.clear();
    return this.closePromise = (async () => {
      try {
        const drained = await Promise.allSettled([...this.coverageWrites, ...this.recoveryWrites]);
        const failed = drained.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) throw failed.reason;
        if (this.coverageFailure) throw this.coverageFailure;
      } finally {
        this.retireCoverageEvidence();
        for (const id of this.reservations.keys()) this.releaseReservation(id);
        for (const disable of this.enabled.values()) disable();
        this.enabled.clear(); this.admissions.clear();
      }
    })();
  }
  /** Once cache disposal begins, an empty cache cannot certify settled native work. */
  retireCoverageEvidence(): void { this.coverageRetired = true; }
  private targetFromKey(key: string): NativeSessionRef | undefined {
    try {
      const value = JSON.parse(key);
      if (Array.isArray(value) && value.length === 3 && value.every(part => typeof part === 'string' && part)) return { controllerId: value[0], providerId: value[1], nativeSessionId: value[2] };
    } catch { /* Non-native cache targets do not participate in succession. */ }
  }
  reconcileCoverage(target: NativeSessionRef): Promise<void> {
    if (this.closePromise || this.coverageRetired) return Promise.reject(new Error('Session mutation coverage is closing.'));
    const writing = this.contexts.clearMutation(target, () => !this.coverageRetired && !this.cache?.hasUnsettledMutation(nativeSessionRefKey(target)));
    this.coverageWrites.add(writing);
    void writing.then(() => { this.coverageWrites.delete(writing); }, error => {
      this.coverageWrites.delete(writing);
      this.coverageFailure ??= error instanceof Error ? error : new Error('Session mutation coverage could not be persisted.', { cause: error });
    });
    return writing;
  }
  currentEntry(): MutationEntry | undefined { return this.context.getStore()?.entry; }
  pending(target: NativeSessionRef): number {
    const key = nativeSessionRefKey(target);
    return [...this.admissions.values()].filter(targets => targets.has(key)).length;
  }
  admit(targets: readonly NativeSessionRef[], operationKey: string): () => void {
    for (const target of targets) this.validate(target);
    return this.recordAdmission(targets, operationKey);
  }
  /** Only fresh metadata relation reservations use this narrower admission. */
  admitAssociation(targets: readonly NativeSessionRef[], operationKey: string): () => void {
    for (const target of targets) this.validate(target, true);
    return this.recordAdmission(targets, operationKey);
  }
  private recordAdmission(targets: readonly NativeSessionRef[], operationKey: string): () => void {
    if (this.admissions.has(operationKey)) throw new AgentOperationRejectedError('operation_conflict', 'This operation is already admitted.');
    for (const target of targets) {
      const key = nativeSessionRefKey(target);
      if (this.cache && !this.enabled.has(key)) this.enabled.set(key, this.cache.enableMutationTarget(key));
    }
    this.admissions.set(operationKey, new Set(targets.map(nativeSessionRefKey)));
    return () => { this.admissions.delete(operationKey); };
  }
  /** Revalidate captured targets immediately before a nested durable/native mutation. */
  recheck(targets: readonly NativeSessionRef[]): void {
    this.recheckTargets(targets, false);
  }
  recheckAssociation(targets: readonly NativeSessionRef[]): void {
    this.recheckTargets(targets, true);
  }
  private recheckTargets(targets: readonly NativeSessionRef[], association: boolean): void {
    const entry = this.currentEntry();
    for (const target of targets) {
      if (entry && !entry.targets.includes(nativeSessionRefKey(target))) throw new AgentOperationRejectedError('invalid_operation_target', 'Mutation target is outside this operation admission.');
      this.validate(target, association);
    }
  }
  checkSource(target: NativeSessionRef): void {
    if (!this.contexts.coverageAvailable(target)) throw new Error('Session mutation coverage was lost across Controller restart.');
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
    if (!this.contexts.coverageAvailable(target)) throw new Error('Session mutation coverage was lost across Controller restart.');
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
  /** Capture one entry and target before an intent can publish or schedule work. */
  settingIntent(target: NativeSessionRef, accept: (lifecycle?: SessionSettingIntentLifecycle) => Promise<void>): Promise<void> {
    const address = structuredClone(target);
    return this.nativeMutation(address, async () => {
      const context = this.context.getStore();
      if (!context?.entry) return accept();
      const key = nativeSessionRefKey(address);
      const releaseWork = context.entry.retainAsyncWork(key);
      let reservation: NativeEffectReservation;
      try { reservation = context.entry.reserveNativeEffect(key); }
      catch (error) { releaseWork(); throw error; }
      let ended = false;
      const release = () => { if (ended) return; ended = true; releaseWork(); reservation.release(); };
      const captured = { ...context, settingEffect: { target: key, reservation } };
      try {
        await accept({
          run: work => this.context.run(captured, () => {
            if (ended) throw new AgentOperationRejectedError('setting_intent_ended', 'The setting intent is no longer live.');
            return work();
          }),
          // Runtime value readback confirms UI intent, not an uncorrelated native queue.
          confirmed: release,
          terminated: release,
        });
      } catch (error) { release(); throw error; }
    });
  }
  private async preparedEffect<T>(target: NativeSessionRef, operationId: string, onAcceptance: AgentMessageOptions['onAcceptance'], work: () => Promise<T>): Promise<T> {
    this.validate(target);
    await this.contexts.markPreparedMutation(target, operationId);
    const effect = this.currentEntry()?.startNativeEffect(nativeSessionRefKey(target));
    if (effect || onAcceptance) this.preparedInvocations.set(operationId, { target: nativeSessionRefKey(target), effect, onAcceptance });
    try { return await work(); }
    finally { effect?.unresolved(); }
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
  private async inputEffect(target: NativeSessionRef, options: AgentMessageOptions | undefined, work: (options: AgentMessageOptions | undefined) => Promise<AgentInputAcceptance | void>): Promise<AgentInputAcceptance | void> {
    this.validate(target);
    const effect = this.currentEntry()?.startNativeEffect(nativeSessionRefKey(target));
    if (!effect) return work(options);
    const confirm = (acceptance: AgentInputAcceptance) => {
      if (acceptance.disposition === 'started' || acceptance.disposition === 'handled') effect.settled();
    };
    try {
      const result = await work({ ...options, onAcceptance: acceptance => { confirm(acceptance); options?.onAcceptance?.(acceptance); } });
      if (result) confirm(result);
      effect.unresolved(); return result;
    } catch (error) {
      if (error instanceof AgentOperationRejectedError) effect.settled(); else effect.unresolved();
      throw error;
    }
  }
  private async settingEffect(target: NativeSessionRef, work: () => Promise<SettingMutationResult>): Promise<SettingMutationResult> {
    this.validate(target);
    const key = nativeSessionRefKey(target), reserved = this.context.getStore()?.settingEffect;
    if (reserved && reserved.target !== key) throw new AgentOperationRejectedError('invalid_operation_target', 'Setting target differs from its accepted intent.');
    const effect = reserved ? reserved.reservation.start() : this.currentEntry()?.startNativeEffect(key);
    try {
      const result = await work();
      if (result === undefined || result.status === 'deferred') effect?.settled(); else effect?.unresolved();
      return result;
    } catch (error) {
      if (error instanceof AgentOperationRejectedError) effect?.settled(); else effect?.unresolved();
      throw error;
    }
  }
  private validate(target: NativeSessionRef, association = false): void {
    try {
      if (this.closePromise) throw new Error('Session dispatch boundary is closing.');
      if ([...this.reservations.values()].some(targets => targets.has(nativeSessionRefKey(target)))) throw new Error('Session is reserved for handoff.');
      if (association) this.assertAssociationReservation(target); else this.assertAdmission(target);
    }
    catch (error) { throw new AgentOperationRejectedError('succession_admission_closed', error instanceof Error ? error.message : 'Session handoff admission is closed.'); }
  }
  wrap(target: NativeSessionRef, session: AgentSession): AgentSession {
    const address = structuredClone(target), boundary = this;
    const evidence = session.nativeEvidence;
    const retainsConfiguration = () => !boundary.closePromise && boundary.requiresNativeEvidence(address) && boundary.contexts.hasTarget(address);
    let recoveryTail: Promise<unknown> = Promise.resolve();
    const runtimeInfo = (options?: Parameters<AgentSession['runtimeInfo']>[0], retain = retainsConfiguration()): Promise<AgentRuntimeInfo> => {
      if (!retain) return session.runtimeInfo(options);
      // Read inside the serialized step: delayed runtime events cannot restore an older snapshot.
      const current = recoveryTail.catch(() => undefined).then(async () => {
        await boundary.contexts.reserveResumeHandle(address);
        const info = await session.runtimeInfo(options);
        if (!info.persistence) throw new Error('Native session recovery configuration is unavailable.');
        await boundary.contexts.retainResumeHandle(address, info.persistence);
        return info;
      });
      recoveryTail = current;
      boundary.recoveryWrites.add(current);
      void current.then(() => boundary.recoveryWrites.delete(current), () => boundary.recoveryWrites.delete(current));
      return current;
    };
    const preserveSettings = <T>(work: () => Promise<T>): Promise<T> => {
      if (!retainsConfiguration()) return work();
      const current = (async () => {
        try { await boundary.contexts.reserveResumeHandle(address); }
        catch { throw new AgentOperationRejectedError('succession_capacity_unavailable', 'Session recovery configuration could not be reserved before dispatch.'); }
        let outcome: { result: T } | { error: unknown };
        try { outcome = { result: await work() }; }
        catch (error) { outcome = { error }; }
        // A native refusal can still report a different confirmed value. Retain that
        // value before settling; an already admitted setter also drains during close.
        try { await runtimeInfo(undefined, true); }
        catch (cause) { throw new Error('Native settings settled but their recovery configuration could not be retained.', { cause }); }
        if ('error' in outcome) throw outcome.error;
        return outcome.result;
      })();
      boundary.recoveryWrites.add(current);
      void current.then(() => boundary.recoveryWrites.delete(current), () => boundary.recoveryWrites.delete(current));
      return current;
    };
    const protectedEvidence = evidence ? new Proxy({} as AgentSessionNativeEvidence, { get(_target, property) {
      const value = Reflect.get(evidence, property, evidence);
      if (property === 'dispatchInput') return async (witness: Parameters<AgentSessionNativeEvidence['dispatchInput']>[0]) => {
        if (!boundary.currentEntry()) throw new AgentOperationRejectedError('succession_operation_identity_required', 'The original admitted mutation entry is required for native input.');
        boundary.recheck([address]);
        const attachment = boundary.contexts.forTarget(address);
        if (attachment && attachment.state !== 'materialized') throw new AgentOperationRejectedError('succession_context_pending', 'Deliver the first handoff input through the durable message dispatcher.');
        return boundary.nativeEffect(address, true, () => evidence.dispatchInput(witness));
      };
      return typeof value === 'function' ? value.bind(evidence) : value;
    } }) : undefined;
    return new Proxy(session, { get(native, property) {
      if (property === 'nativeEvidence') return protectedEvidence;
      if (property === 'runtimeInfo') return runtimeInfo;
      if (property === 'observe') return async function* () {
        if (retainsConfiguration()) await runtimeInfo();
        for await (const item of native.observe()) {
          if (item.type === 'observation' && item.event.type === 'runtime_updated' && retainsConfiguration()) await runtimeInfo();
          yield item;
        }
      };
      if (property === 'dispose') return async () => { try { await recoveryTail; } finally { await native.dispose(); } };
      const value = Reflect.get(native, property, native);
      if (typeof value !== 'function') return value;
      if (!mutations.has(String(property))) return value.bind(native);
      return (...args: unknown[]) => {
        const evidence = native.nativeEvidence, attachment = boundary.contexts.forTarget(address);
        if ((property === 'sendMessage' || property === 'sendMessageContent') && evidence?.availability().status === 'configured'
          && attachment && attachment.state !== 'materialized' && boundary.cache && !boundary.currentEntry()) {
          return Promise.reject(new AgentOperationRejectedError('succession_operation_identity_required', 'The original admitted mutation entry is required for prepared input.'));
        }
        return boundary.nativeMutation(address, async () => {
          if (property === 'sendMessage') return await boundary.send(address, args[0] as string, undefined, args[1] as AgentMessageOptions | undefined,
            (text, _parts, options) => boundary.inputEffect(address, options, actual => actual === undefined ? native.sendMessage(text) : native.sendMessage(text, actual)), evidence);
          if (property === 'sendMessageContent') {
            const parts = args[0] as readonly AgentInputPart[];
            return await boundary.send(address, parts.filter(part => part.type === 'text').map(part => part.text).join(''), parts, args[1] as AgentMessageOptions | undefined,
              (_text, content, options) => boundary.inputEffect(address, options, actual => native.sendMessageContent!(content!, actual)), evidence);
          }
          const attachment = boundary.contexts.forTarget(address);
          if ((property === 'executeCommand' || property === 'steer') && attachment && attachment.state !== 'materialized') {
            throw new AgentOperationRejectedError('succession_context_pending', 'Send a message to deliver the pending handoff context before executing commands.');
          }
          boundary.validate(address);
          if (property === 'steer') return boundary.inputEffect(address, args[1] as AgentMessageOptions | undefined, actual => native.steer!(args[0] as string, actual));
          if (property === 'setSessionSetting') return boundary.settingEffect(address, () => preserveSettings(() => native.setSessionSetting!(args[0] as string, args[1] as string)));
          if (property === 'setPlanning') return boundary.nativeEffect(address, false, () => preserveSettings(() => native.setPlanning!(args[0] as boolean)));
          return await boundary.nativeEffect(address, property === 'steer', async () => Reflect.apply(value, native, args));
        });
      };
    } });
  }
  private async send(target: NativeSessionRef, text: string, parts: readonly AgentInputPart[] | undefined, options: AgentMessageOptions | undefined,
    send: (text: string, parts: readonly AgentInputPart[] | undefined, options: AgentMessageOptions | undefined) => Promise<AgentInputAcceptance | void>, evidence?: AgentSessionNativeEvidence): Promise<AgentInputAcceptance | void> {
    let attachment = this.contexts.forTarget(target);
    if (attachment?.deliveries.some(item => item.preparedInput && isSuccessionDeliveryUnresolved(item))) {
      await this.reconcileFirstInput?.(attachment.operationId); attachment = this.contexts.forTarget(target);
    }
    if (!attachment) { this.validate(target); return send(text, parts, options); }
    const admitted = this.context.getStore();
    if (!admitted) throw new AgentOperationRejectedError('succession_operation_identity_required', 'An admitted operation identity is required for this successor.');
    const role = this.resolveRole(target);
    if (!role || role.roleId !== attachment.roleId || role.roleRevision !== attachment.roleRevision) {
      throw new AgentOperationRejectedError('succession_not_committed', 'This candidate has not been committed as the current primary session.');
    }
    const { onAcceptance, ...selections } = options ?? {};
    const nativeOptions = Object.keys(selections).length ? selections : undefined;
    const contentIdentity = createHash('sha256').update(JSON.stringify([parts ?? null, nativeOptions ?? null])).digest('hex');
    const prior = this.contexts.delivery(admitted.operationId);
    if (attachment.state === 'materialized' && !prior) { this.validate(target); return send(text, parts, options); }
    const availability = evidence?.availability();
    const prepared = availability?.status === 'configured' && availability.version === 2 ? evidence : undefined;
    if (!prior && !prepared && this.requiresNativeEvidence(target)) throw new AgentOperationRejectedError('native_evidence_unavailable', 'Native evidence for the prepared successor is unavailable.');
    const validate = async () => {
      this.recheck([target]);
      const current = this.resolveRole(target);
      if (!current || current.roleId !== role.roleId || current.roleRevision !== role.roleRevision) throw new AgentOperationRejectedError('succession_not_committed', 'Successor role changed before input dispatch.');
    };
    let result: AgentInputAcceptance | void = undefined, rejected: unknown;
    const delivery = await this.dispatcher.dispatch({ ...role, operationId: admitted.operationId, target, text, contentIdentity },
      validate, async (input, prefix, witness) => {
        try {
          await validate();
          if (prepared && !witness) throw new Error('Prepared input witness was not durably retained.');
          result = prepared ? await this.preparedEffect(target, admitted.operationId, onAcceptance, () => prepared.dispatchInput(witness!))
            : await send(input.text, parts ? [...(prefix ? [{type: 'text' as const, text: prefix}] : []), ...parts] : undefined, options);
          return { outcome: 'accepted', ...(result ? { inputAcceptance: result } : {}) };
        } catch (error) {
          if (!(error instanceof AgentOperationRejectedError)) throw error;
          rejected = error; return { outcome: 'rejected' };
        }
      }, prepared ? async input => {
        if (parts?.some(part => part.type !== 'text') || nativeOptions && (Object.keys(nativeOptions).some(key => key !== 'delivery') || nativeOptions.delivery !== undefined && nativeOptions.delivery !== 'immediate')) {
          throw new AgentOperationRejectedError('native_evidence_unsupported', 'Prepared first input requires text and immediate delivery.');
        }
        return prepared.prepareInput([{ type: 'text', text: input.text }], nativeOptions);
      } : undefined);
    if (rejected) throw rejected;
    if (delivery.state === 'unknown' || delivery.state === 'dispatching') throw new Error('The first handoff input has an unresolved delivery outcome. Reconcile native history before sending again.');
    if (delivery.state === 'rejected') throw new AgentOperationRejectedError('operation_rejected', 'This first input was rejected. Use a new operation identity after correcting its cause.');
    return delivery.inputAcceptance;
  }
}

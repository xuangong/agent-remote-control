import type { SessionExecutionRouting } from './session-succession-service.js';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentInputAcceptance, AgentSessionExtensions, AgentSessionTool } from '@orchardworks/agent-provider-sdk';
import { AgentOperationRejectedError, bindAgentSessionTools } from '@orchardworks/agent-provider-sdk';
import { isTpmAction, isTpmCreate, sessionOperationAvailability, type TpmAction, type TpmCreate, type TpmIntent, type TpmWork, type TpmList, type NativeSessionRef, type SourceBinding, nativeSessionRefKey } from '@orchardworks/agent-remote-protocol';
import { OperationCacheError, type AgentManagerEvent, type RemoteHostSessionLease, type SessionWireOperationExecutor } from '@orchardworks/agent-remote-relay';
import { sessionHeartbeatInterval, sessionHeartbeatInstructions, sessionHeartbeatTools } from './session-heartbeat.js';
import { TpmStore, isTpmIntentSettled, type TpmRecord } from './tpm-store.js';
import { initialTpmTodo, tpmInstructions, tpmReviewPrompt, tpmPlaceholderTitle } from './tpm-role.js';
import { backgroundInputHash, withBackgroundReviews } from './session-background.js';
import { changeSessionTodo, confirmSessionTodo, invalidateSessionTodoApproval, currentSessionTodo, sessionTodoComplete, sessionTodoInstructions, sessionTodoTools } from './session-todo.js';

export interface TpmOptions {
  stateDirectory: string;
  heartbeatMs?: number;
  waitingHeartbeatMs?: number;
  minimumReviewMs?: number;
  coalesceMs?: number;
  tickMs?: number;
  now?: () => number;
}
export interface TpmMainResolution { target: NativeSessionRef; roleRevision?: number }
export interface TpmMainRouting {
  bind(providerId: string, nativeSessionId: string): Promise<SourceBinding>;
  resolve(binding: SourceBinding): TpmMainResolution;
  acquire(target: NativeSessionRef): Promise<RemoteHostSessionLease>;
  assertCurrent(binding: SourceBinding, target: NativeSessionRef, roleRevision?: number): void;
  read?(binding: SourceBinding, input: Record<string, unknown>, assertReader?: () => void): Promise<unknown>;
}
export interface TpmSessionAccess {
  controllerId: string;
  sessionRouting?: SessionExecutionRouting;
  mainRouting?: TpmMainRouting;
  supportedProviders(): string[];
  available(): boolean;
  acquire(providerId: string, nativeSessionId: string): Promise<RemoteHostSessionLease>;
  create(providerId: string, cwd: string | undefined, extensions: AgentSessionExtensions): Promise<string>;
  recover?(providerId: string, nativeSessionId: string, extensions: AgentSessionExtensions): Promise<void>;
  execute: SessionWireOperationExecutor;
}
interface Attachment { tpmTarget: NativeSessionRef; mainResolution?: TpmMainResolution; main: RemoteHostSessionLease; tpm: RemoteHostSessionLease; release(): void }
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function executionOperationId(intentId: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intentId)) return intentId;
  // Keep durable tool receipts intact while giving the executor a scoped UUID.
  const bytes = createHash('sha256').update(JSON.stringify(['host:tpm', intentId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const active = (work: TpmWork) => !work.archived && !work.paused && work.phase !== 'completed';
// Missing delegation preserves the behavior of work created before this control existed.
const automatic = (work: TpmWork) => active(work) && work.delegated !== false;
const unknown = (record: TpmRecord) => record.creation === 'unknown' || record.work.outbox?.some(intent => intent.status === 'unknown');
const shortError = (error: unknown) => (error instanceof Error ? error.message : 'TPM operation failed.').slice(0, 2048);

/** Local consumer of shared session managers. No browser or Relay liveness is involved. */
export class TpmCoordinator {
  readonly store: TpmStore;
  readonly ready: Promise<void>;
  private readonly attachments = new Map<string, Attachment>();
  private readonly attaching = new Map<string, Promise<Attachment>>();
  private readonly workers = new Map<string, Promise<void>>();
  private readonly retries = new Map<string, number>();
  private readonly failures = new Map<string, string>();
  private schedulerFailure?: string;
  private readonly reviewReservations = new Set<string>();
  private scanCursor = 0;
  private management: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly now: () => number;
  constructor(private readonly options: TpmOptions, private readonly access: TpmSessionAccess) {
    this.now = options.now ?? Date.now;
    this.store = new TpmStore(options.stateDirectory);
    this.ready = this.store.ready;
    void this.ready.then(() => {
      if (this.closed) return;
      this.timer = setInterval(() => { this.scheduleTick(); }, options.tickMs ?? 1000); this.timer.unref?.();
      this.scheduleTick();
    }).catch(() => { /* Control requests expose recovery failure; do not start partial automation. */ });
  }
  async list(cursor?: string): Promise<TpmList> {
    await this.ready;
    if (cursor !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(cursor)) throw new Error('Invalid TPM catalog cursor.');
    const supportedProviders = this.access.supportedProviders();
    const catalog: TpmList = { supported: supportedProviders.length > 0, supportedProviders, works: [] };
    await this.reconcileMainBindings();
    const works = this.store.all().map(record => this.visibleWork(record.work)).filter(work => cursor === undefined || work.id > cursor).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const work of works) {
      const summary: TpmWork = { ...work, detailsOmitted: true, todo: undefined, todoRevision: work.todo?.revision, document: '', acceptance: '', evidence: [],
        outbox: work.outbox?.filter(intent => !isTpmIntentSettled(intent)).map(({ error: _error, ...intent }) => ({ ...intent, purpose: intent.purpose.slice(0, 64), text: '[Details omitted; open work details.]' })) };
      const candidate = { ...catalog, works: [...catalog.works, summary], nextCursor: work.id };
      if (catalog.works.length >= 100 || Buffer.byteLength(JSON.stringify(candidate)) > 512 * 1024) {
        if (!catalog.works.length) throw new Error('TPM catalog summary exceeded its size budget.');
        catalog.nextCursor = catalog.works[catalog.works.length - 1]!.id; break;
      }
      catalog.works.push(summary);
    }
    return catalog;
  }
  async get(id: string): Promise<TpmWork> { await this.ready; await this.reconcileMainBindingSafely(id); return this.visibleWork(this.store.get(id).work); }
  /** Call after ready. Queue acceptance remains unsettled without native execution evidence. */
  hasUnsettledRecipient(target: NativeSessionRef): boolean {
    return this.store.all().some(record => (record.work.outbox ?? []).some(intent => {
      if (intent.status === 'prepared' || isTpmIntentSettled(intent)) return false;
      if (intent.resolvedTarget) return nativeSessionRefKey(intent.resolvedTarget) === nativeSessionRefKey(target);
      const known = intent.target === 'tpm' ? this.tpmAnchor(record.work) : record.work.mainSessionRef
        ?? (record.work.mainBinding?.kind === 'fixed' ? record.work.mainBinding.source : record.work.mainBinding?.origin)
        ?? { controllerId: this.access.controllerId, providerId: record.work.providerId, nativeSessionId: record.work.mainNativeSessionId };
      if (known.controllerId !== target.controllerId || known.providerId !== target.providerId) return false;
      if (nativeSessionRefKey(known) === nativeSessionRefKey(target)) return true;
      try {
        if (this.access.sessionRouting && nativeSessionRefKey(this.access.sessionRouting.resolve(known).target) === nativeSessionRefKey(this.access.sessionRouting.resolve(target).target)) return true;
        return intent.target === 'main' && !!record.work.mainBinding && !!this.access.mainRouting && nativeSessionRefKey(this.access.mainRouting.resolve(record.work.mainBinding).target) === nativeSessionRefKey(target);
      } catch { return true; }
    }));
  }
  private tpmAnchor(work: TpmWork): NativeSessionRef {
    if (!work.tpmNativeSessionId) throw new Error('TPM recipient is not attached.');
    return { controllerId: this.access.controllerId, providerId: work.providerId, nativeSessionId: work.tpmNativeSessionId };
  }
  private tpmTarget(work: TpmWork): NativeSessionRef {
    const anchor = this.tpmAnchor(work); return this.access.sessionRouting?.resolve(anchor).target ?? anchor;
  }
  private assertTpmCurrent(work: TpmWork, actual: NativeSessionRef): void {
    this.admit(work.providerId);
    if (this.access.sessionRouting) this.access.sessionRouting.assertCurrent(this.tpmAnchor(work), actual);
    else if (nativeSessionRefKey(this.tpmAnchor(work)) !== nativeSessionRefKey(actual)) throw new Error('TPM recipient is no longer current.');
  }
  private roleRecord(providerId: string, nativeSessionId: string, actualNativeSessionId?: string): TpmRecord | undefined {
    // Prefix preparation names the current source until the candidate's actual identity is known.
    const recipients = new Set([nativeSessionId, actualNativeSessionId].filter((id): id is string => !!id)
      .map(id => nativeSessionRefKey({ controllerId: this.access.controllerId, providerId, nativeSessionId: id })));
    const records = this.store.all().filter(value => {
      if (value.work.providerId !== providerId || !value.work.tpmNativeSessionId) return false;
      try { return recipients.has(nativeSessionRefKey(this.tpmTarget(value.work))); } catch { return false; }
    });
    if (records.length > 1) throw new Error('TPM recipient has ambiguous role anchors.');
    return records[0];
  }
  private reviewRecord(recipient: NativeSessionRef): TpmRecord | undefined {
    const key = nativeSessionRefKey(recipient);
    const records = this.store.all().filter(({ work }) => {
      if (work.providerId !== recipient.providerId || !work.tpmNativeSessionId) return false;
      if (nativeSessionRefKey(this.tpmAnchor(work)) === key || work.outbox?.some(intent =>
        intent.target === 'tpm' && intent.resolvedTarget && nativeSessionRefKey(intent.resolvedTarget) === key)) return true;
      try { return nativeSessionRefKey(this.tpmTarget(work)) === key; } catch { return false; }
    });
    if (records.length > 1) throw new Error('TPM review recipient has ambiguous work anchors.');
    return records[0];
  }
  async extensions(providerId: string, nativeSessionId: string, actual: () => string | undefined = () => nativeSessionId): Promise<AgentSessionExtensions | undefined> {
    try { await this.ready; } catch { return undefined; }
    const record = this.roleRecord(providerId, nativeSessionId, actual());
    return record ? this.boundExtensions(record.work.id, actual) : undefined;
  }
  async annotateSession(providerId: string, nativeSessionId: string, session: import('@orchardworks/agent-provider-sdk').AgentSession) {
    try { await this.ready; } catch { return session; }
    const recipient = { controllerId: this.access.controllerId, providerId, nativeSessionId };
    const record = this.reviewRecord(recipient);
    if (!record) return session;
    return withBackgroundReviews(session, {
      records: () => this.store.backgroundReviews(record.work.id).filter(review => this.store.get(record.work.id).work.outbox?.some(intent =>
        intent.target === 'tpm' && intent.id === review.id && (intent.resolvedTarget ? nativeSessionRefKey(intent.resolvedTarget) === nativeSessionRefKey(recipient) : nativeSessionId === record.work.tpmNativeSessionId))),
      bind: async (id, turnId) => { await this.store.update(record.work.id, undefined, current => {
        const review = current.backgroundReviews?.find(review => review.id === id);
        if (review && review.turnId === undefined) review.turnId = turnId;
      }); },
      fail: async id => { await this.store.update(record.work.id, undefined, current => {
        const review = current.backgroundReviews?.find(review => review.id === id); if (review) review.failed = true;
      }); },
    });
  }
  async create(input: TpmCreate, scope: string): Promise<TpmWork> {
    if (!isTpmCreate(input)) throw new Error('Invalid TPM creation request.');
    return this.manage(async () => {
      this.admit(input.providerId);
      const key = JSON.stringify([scope, input.operationId]); const hash = fingerprint(input);
      const previous = this.store.all().find(record => record.createKey === key);
      if (previous) { if (previous.createFingerprint !== hash) throw new Error('The operation identity was reused with different input.'); return this.visibleWork(previous.work); }
      const mainBinding = await this.access.mainRouting?.bind(input.providerId, input.mainNativeSessionId);
      const mainResolution = mainBinding ? this.access.mainRouting!.resolve(mainBinding) : undefined;
      const main = mainResolution ? await this.access.mainRouting!.acquire(mainResolution.target) : await this.access.acquire(input.providerId, input.mainNativeSessionId);
      try {
        const id = randomUUID(); const timestamp = new Date(this.now()).toISOString();
        await this.store.insert({ version: 1, createKey: key, createFingerprint: hash, creation: 'prepared', requirement: input.requirement ?? '', titleSetByUser: !!input.title,
          dirty: true, lastReviewAt: 0, actions: {}, work: { id, revision: 1, title: input.title ?? tpmPlaceholderTitle(this.store.all().map(record => record.work.title)), providerId: input.providerId,
            mainNativeSessionId: mainResolution?.target.nativeSessionId ?? input.mainNativeSessionId,
            ...(mainBinding ? { mainBinding, mainSessionRef: mainResolution!.target } : {}), phase: 'clarifying', waiting: input.requirement ? 'none' : 'user', paused: false, delegated: input.delegated ?? false,
            summary: input.requirement?.slice(0, 2048) ?? '', nextAction: 'Clarify requirements and agree on a delivery plan.', document: '', acceptance: '', evidence: [],
            createdAt: timestamp, updatedAt: timestamp, nextCheckAt: this.now(), outbox: [] } });
        await this.store.update(id, undefined, record => { record.creation = 'dispatching'; });
        try {
          this.admit(input.providerId);
          let actual: string | undefined;
          const nativeId = await this.access.create(input.providerId, main.agent.snapshot().payload.runtimeInfo.cwd, this.boundExtensions(id, () => actual));
          actual = nativeId;
          const introduction = input.requirement
            ? `User requirement:\n${input.requirement}\n\nBegin by understanding the user's need and discussing the plan.`
            : 'No requirement has been provided yet. Briefly ask the user what they want to accomplish, then wait for their reply. Do not infer a task from the main session or contact it before the user explains their need.';
          await this.store.update(id, undefined, record => {
            record.creation = 'accepted'; record.work.tpmNativeSessionId = nativeId;
            this.enqueueRecord(record, 'tpm', 'initial', `${introduction}\n\nRead read_work and call update_work to persist your assessment.`, randomUUID());
          });
        } catch (error) {
          await this.store.update(id, undefined, record => { if (record.creation !== 'accepted') record.creation = 'unknown'; record.work.health = shortError(error); });
        }
        this.scheduleTick(); return this.visibleWork(this.store.get(id).work);
      } finally { main.release(); }
    });
  }
  /** Preflight recovery without opening or inspecting the supplied native session. */
  validateCreationRecovery(input: TpmAction, scope: string): void {
    if (input.action !== 'resolve' || input.intentId !== 'creation' || input.resolution !== 'accepted') return;
    const previous = this.store.get(input.id), settled = previous.actions[fingerprint([scope, input.operationId])];
    if (settled) {
      if (settled.fingerprint !== fingerprint(input)) throw new AgentOperationRejectedError('tpm_action_conflict', 'The operation identity was reused with different input.');
      return;
    }
    const nativeId = input.nativeSessionId;
    try {
      if (previous.work.revision !== input.revision) throw new Error('TPM work changed. Refresh before applying this change.');
      if (previous.creation !== 'unknown') throw new Error('The uncertain creation was not found.');
      if (!nativeId) throw new Error('A verified native session identity is required to resolve creation.');
      if (nativeId === previous.work.mainNativeSessionId || this.store.all().some(record => record.work.id !== input.id && record.work.providerId === previous.work.providerId
        && [record.work.mainNativeSessionId, record.work.tpmNativeSessionId].includes(nativeId))) throw new Error('The recovered session is already bound to a main session or another TPM work.');
      if (!this.access.recover) throw new Error('This Controller cannot safely recover TPM creation.');
      this.admit(previous.work.providerId);
    } catch (error) {
      throw new AgentOperationRejectedError('tpm_recovery_rejected', error instanceof Error ? error.message : 'TPM recovery was rejected before native dispatch.');
    }
  }
  async action(input: TpmAction, scope: string): Promise<TpmWork> {
    if (!isTpmAction(input)) throw new Error('Invalid TPM action.');
    return this.manage(async () => {
      const previous = this.store.get(input.id); const key = fingerprint([scope, input.operationId]); const hash = fingerprint(input);
      const settled = previous.actions[key];
      if (settled) { if (settled.fingerprint !== hash) throw new AgentOperationRejectedError('tpm_action_conflict', 'The operation identity was reused with different input.'); return this.visibleWork(previous.work); }
      if (input.action === 'resolve' && input.intentId === 'creation' && input.resolution === 'accepted') {
        const nativeId = input.nativeSessionId;
        this.validateCreationRecovery(input, scope);
        await this.access.recover!(previous.work.providerId, nativeId!, this.boundExtensions(input.id, () => nativeId));
      }
      const updated = await this.store.update(input.id, input.action === 'confirm_todo' ? undefined : input.revision, record => {
        if (input.action === 'set_delegated') {
          if (input.delegated && (!active(record.work) || unknown(record))) throw new Error('Resolve paused, completed, archived or uncertain work before enabling delegation.');
          record.work.delegated = input.delegated;
          if (input.delegated) {
            record.dirty = true; record.changeVersion = (record.changeVersion ?? 0) + 1; record.work.nextCheckAt = this.now();
          } else {
            for (const intent of record.work.outbox ?? []) if (intent.target === 'tpm' && intent.purpose === 'review' && intent.status === 'prepared') {
              intent.status = 'canceled'; delete intent.error;
              record.backgroundReviews = record.backgroundReviews?.filter(review => review.id !== intent.id);
            }
          }
        } else if (input.action === 'rename') {
          record.work.title = input.title.trim(); record.titleSetByUser = true;
        } else if (input.action === 'archive' || input.action === 'unarchive') {
          record.work.archived = input.action === 'archive';
          if (record.work.archived) {
            record.work.paused = true; record.dirty = false; delete record.reviewIntentId;
            for (const intent of record.work.outbox ?? []) if (intent.status === 'prepared') {
              intent.status = 'rejected'; intent.error = 'Work archived before this message was dispatched.';
            }
          }
        } else if (input.action === 'confirm_todo') {
          if (!record.work.todo || !active(record.work)) throw new Error('This work is not accepting todo confirmations.');
          record.work.todo = confirmSessionTodo(record.work.todo, input.confirmation);
          if (input.confirmation.decision === 'approve') record.approvedSpecification = fingerprint([record.work.document, record.work.acceptance]);
          record.dirty = true; record.changeVersion = (record.changeVersion ?? 0) + 1;
          record.work.waiting = 'none'; record.work.nextCheckAt = this.now();
          if (!automatic(record.work)) this.enqueueRecord(record, 'tpm', 'decision', 'The user answered the current todo confirmation. Read read_work and read_todo_list, then continue the conversation from that decision. This does not enable background delegation.', randomUUID());
        } else if (input.action === 'pause') record.work.paused = true;
        else if (input.action === 'resolve') {
          if (input.intentId === 'creation' && record.creation === 'unknown') {
            if (input.resolution === 'accepted') {
              if (!input.nativeSessionId) throw new Error('A verified native session identity is required to resolve creation.');
              record.work.tpmNativeSessionId = input.nativeSessionId; record.creation = 'accepted';
              record.dirty = true; record.work.nextCheckAt = this.now();
              record.work.health = record.work.paused ? 'Creation verified. Work remains explicitly paused.' : 'Creation verified. Reviews will continue without replaying the creation request.';
            } else {
              record.creation = 'abandoned'; record.work.paused = true; record.work.health = 'Creation was explicitly abandoned. Create a new work item to retry.';
            }
          } else {
          const intent = record.work.outbox?.find(value => value.id === input.intentId);
          if (!intent || intent.status !== 'unknown') throw new Error('The uncertain intent was not found.');
          intent.status = input.resolution;
          if (record.reviewIntentId === intent.id) delete record.reviewIntentId;
          delete record.work.health;
          }
        } else {
          if (record.work.archived && input.action !== 'reopen') throw new Error('Restore archived work before resuming its follow-up.');
          if (record.creation === 'abandoned') throw new Error('This work creation was abandoned. Create a new work item.');
          if (unknown(record)) throw new Error('Resolve unknown operation outcomes before continuing.');
          if (input.action === 'reopen') {
            record.work.archived = false;
            if (record.work.phase === 'completed') {
              const todo = record.work.todo;
              const fresh = initialTpmTodo();
              if (todo) {
                fresh.steps = [...todo.steps, ...fresh.steps.map(step => ({ ...step, id: randomUUID() }))];
                fresh.revision = todo.revision + 1; fresh.planRevision = todo.planRevision + 1; fresh.changes = todo.changes;
              }
              record.work.todo = fresh; delete record.approvedSpecification;
            }
            record.work.phase = 'clarifying';
          }
          if (record.work.phase === 'completed') throw new Error('Reopen completed work before checking it.');
          if (input.action === 'resume' || input.action === 'reopen') record.work.paused = false;
          record.dirty = true; record.changeVersion = (record.changeVersion ?? 0) + 1; record.work.nextCheckAt = this.now();
        }
        // Store the resulting public revision as the durable idempotency receipt.
        record.actions[key] = { fingerprint: hash, revision: record.work.revision + 1 };
        const keys = Object.keys(record.actions); for (const old of keys.slice(0, Math.max(0, keys.length - 200))) delete record.actions[old];
      });
      if (!active(updated.work)) this.detach(input.id);
      this.scheduleTick(); return this.visibleWork(updated.work);
    });
  }
  async handoff(providerId: string, nativeSessionId: string): Promise<void> {
    await this.ready; await this.reconcileMainBindings();
    for (const record of this.store.all()) {
      let tpmTarget: NativeSessionRef | undefined;
      try { if (record.work.tpmNativeSessionId) tpmTarget = this.tpmTarget(record.work); }
      catch { /* An unavailable route does not identify a current TPM recipient. */ }
      const tpmMatches = tpmTarget?.providerId === providerId && tpmTarget.nativeSessionId === nativeSessionId;
      const mainMatches = (record.work.mainSessionRef?.providerId ?? record.work.providerId) === providerId && record.work.mainNativeSessionId === nativeSessionId;
      if (!tpmMatches && !mainMatches) continue;
      await this.store.update(record.work.id, undefined, item => { item.work.paused = true; item.work.health = 'Automation paused after native CLI takeover. Resume explicitly after returning control.'; });
      this.detach(record.work.id);
    }
  }
  async tick(): Promise<void> {
    if (this.closed || !this.access.available()) return;
    await this.ready;
    await this.reconcileMainBindings();
    const records = this.store.all();
    if (!records.length) return;
    const start = this.scanCursor % records.length;
    for (let offset = 0; offset < records.length; offset++) {
      const index = (start + offset) % records.length;
      const record = records[index]!;
      if (!active(record.work)) { this.detach(record.work.id); continue; }
      if (!automatic(record.work) && !record.reviewIntentId && !record.work.outbox?.some(intent => intent.status === 'prepared')) { this.detach(record.work.id); continue; }
      if ((this.retries.get(record.work.id) ?? 0) > this.now() || !record.work.tpmNativeSessionId || unknown(record) || this.workers.has(record.work.id)) continue;
      const held = this.attachments.get(record.work.id);
      if (held) {
        try { if (nativeSessionRefKey(held.tpmTarget) !== nativeSessionRefKey(this.tpmTarget(record.work))) this.detach(record.work.id); }
        catch (error) { await this.recordFailure(record.work.id, error); continue; }
      }
      // Retain every active binding, then spend worker slots only on pending or due work.
      if (this.attachments.has(record.work.id) && !record.work.outbox?.some(intent => intent.status === 'prepared') && record.work.nextCheckAt > this.now()) continue;
      if ([...this.workers.keys()].filter(id => active(this.store.get(id).work)).length >= 2) break;
      this.scanCursor = (index + 1) % records.length;
      const work = this.process(record.work.id).then(() => this.clearFailure(record.work.id))
        .catch(error => this.recordFailure(record.work.id, error)).finally(() => { this.workers.delete(record.work.id); });
      this.workers.set(record.work.id, work);
    }
    await Promise.allSettled([...this.workers.values()]);
  }
  async close(): Promise<void> {
    this.closed = true; clearInterval(this.timer);
    for (const id of this.attachments.keys()) this.detach(id);
    try { await this.ready; } catch { return; }
    await Promise.allSettled([...this.workers.values(), this.management]); await this.store.flush();
  }
  private admit(providerId: string) {
    if (this.closed || !this.access.available()) throw new Error('Controller is not accepting TPM operations.');
    if (!this.access.supportedProviders().includes(providerId)) throw new Error('This provider does not support TPM instructions and tools.');
  }
  private manage<T>(work: () => Promise<T>): Promise<T> {
    const result = this.management.catch(() => undefined).then(() => this.ready).then(work); this.management = result; return result;
  }
  private detach(id: string) { this.attachments.get(id)?.release(); this.attachments.delete(id); this.reviewReservations.delete(id); }
  private scheduleTick(): void {
    void this.tick().then(() => { this.schedulerFailure = undefined; }, error => {
      this.schedulerFailure = `Background TPM scheduling failed: ${shortError(error)}`.slice(0, 2048);
    });
  }
  private visibleWork(work: TpmWork): TpmWork {
    const health = this.failures.get(work.id) ?? this.schedulerFailure;
    let current: string | undefined;
    try { current = work.tpmNativeSessionId ? this.tpmTarget(work).nativeSessionId : undefined; } catch { /* An unavailable route must not expose a retired executable locator. */ }
    return { ...work, tpmNativeSessionId: current, delegated: work.delegated ?? true, ...(health ? { health } : {}) };
  }
  private async recordFailure(id: string, error: unknown): Promise<void> {
    const message = shortError(error);
    this.retries.set(id, this.now() + 30_000); this.failures.set(id, message);
    this.detach(id);
    try { await this.store.update(id, undefined, item => { item.work.health = message; }); }
    catch (persistenceError) { this.failures.set(id, `${message} Health persistence failed: ${shortError(persistenceError)}`.slice(0, 2048)); }
  }
  private async clearFailure(id: string): Promise<void> {
    const message = this.failures.get(id);
    if (message && this.store.get(id).work.health === message) await this.store.update(id, undefined, item => { if (item.work.health === message) delete item.work.health; });
    this.failures.delete(id); this.retries.delete(id);
  }
  private async reconcileMainBindingSafely(id: string): Promise<void> {
    if (!this.access.mainRouting || (this.retries.get(id) ?? 0) > this.now()) return;
    try { await this.reconcileMainBinding(id); await this.clearFailure(id); }
    catch (error) { await this.recordFailure(id, error); }
  }
  private async reconcileMainBindings(): Promise<void> {
    if (!this.access.mainRouting) return;
    for (const record of this.store.all()) await this.reconcileMainBindingSafely(record.work.id);
  }
  private async reconcileMainBinding(id: string): Promise<TpmMainResolution | undefined> {
    const routing = this.access.mainRouting;
    if (!routing) return undefined;
    let record = this.store.get(id);
    if (!record.work.mainBinding || record.work.mainBinding.kind === 'fixed') {
      const source = record.work.mainBinding?.kind === 'fixed' ? record.work.mainBinding.source : record.work.mainSessionRef;
      const binding = await routing.bind(source?.providerId ?? record.work.providerId, source?.nativeSessionId ?? record.work.mainNativeSessionId);
      if (JSON.stringify(binding) !== JSON.stringify(record.work.mainBinding)) {
        record = await this.store.update(id, undefined, item => { if (item.work.mainBinding?.kind !== 'primary_role') item.work.mainBinding = binding; });
      }
    }
    const resolution = routing.resolve(record.work.mainBinding!);
    const attachment = this.attachments.get(id);
    if (attachment && (!attachment.mainResolution || nativeSessionRefKey(attachment.mainResolution.target) !== nativeSessionRefKey(resolution.target)
      || attachment.mainResolution.roleRevision !== resolution.roleRevision)) this.detach(id);
    const hasLegacyReceipts = record.work.outbox?.some(intent => intent.target === 'main' && intent.status !== 'prepared' && !intent.resolvedTarget);
    if (hasLegacyReceipts || !record.work.mainSessionRef || nativeSessionRefKey(record.work.mainSessionRef) !== nativeSessionRefKey(resolution.target)) {
      await this.store.update(id, undefined, item => {
        const previousTarget = item.work.mainSessionRef ?? { controllerId: resolution.target.controllerId, providerId: item.work.providerId, nativeSessionId: item.work.mainNativeSessionId };
        for (const intent of item.work.outbox ?? []) if (intent.target === 'main' && intent.status !== 'prepared' && !intent.resolvedTarget) {
          // Legacy receipts name the persisted predecessor. Its historical role revision may be unknown.
          intent.resolvedTarget = previousTarget;
          if (nativeSessionRefKey(previousTarget) === nativeSessionRefKey(resolution.target)) intent.roleRevision = resolution.roleRevision;
        }
        item.work.mainSessionRef = resolution.target;
        item.work.mainNativeSessionId = resolution.target.nativeSessionId;
        item.dirty = true; item.changeVersion = (item.changeVersion ?? 0) + 1;
      });
    }
    return resolution;
  }
  private async attach(id: string): Promise<Attachment> {
    const mainResolution = await this.reconcileMainBinding(id);
    const tpmTarget = this.tpmTarget(this.store.get(id).work);
    let existing = this.attachments.get(id);
    if (existing && nativeSessionRefKey(existing.tpmTarget) !== nativeSessionRefKey(tpmTarget)) { this.detach(id); existing = undefined; }
    if (existing) return existing;
    const pending = this.attaching.get(id); if (pending) return pending;
    const operation = (async () => {
      const record = this.store.get(id); this.admit(record.work.providerId);
      const main = mainResolution ? await this.access.mainRouting!.acquire(mainResolution.target) : await this.access.acquire(record.work.providerId, record.work.mainNativeSessionId);
      let tpm: RemoteHostSessionLease | undefined;
      try {
        tpm = await this.access.acquire(tpmTarget.providerId, tpmTarget.nativeSessionId);
        this.assertTpmCurrent(this.store.get(id).work, tpmTarget);
        let contentChanged = false; let coalesce: ReturnType<typeof setTimeout> | undefined;
        let mainStatus = main.agent.snapshot().payload.status;
        const markDirty = () => {
          if (coalesce || this.closed) return;
          coalesce = setTimeout(() => {
            coalesce = undefined;
            void this.store.update(id, undefined, item => {
              if (!automatic(item.work)) return;
              item.dirty = true; item.changeVersion = (item.changeVersion ?? 0) + 1;
              item.work.nextCheckAt = Math.min(item.work.nextCheckAt, this.now() + (this.options.coalesceMs ?? 2000));
            }).catch(() => undefined);
          }, this.options.coalesceMs ?? 2000); coalesce.unref?.();
        };
        const unsubscribeMain = main.agent.subscribe((event: AgentManagerEvent) => {
          if (event.type === 'agent_stream' && event.delivery !== 'history') {
            const native = event.event;
            if (native.type === 'timeline' && ['user_message', 'assistant_message'].includes(native.item.type)) {
              // A known application operation echo is not another work request.
              if (native.item.type === 'user_message' && native.item.clientMessageId && this.store.get(id).work.outbox?.some(intent => intent.id === (native.item as { clientMessageId?: string }).clientMessageId)) return;
              contentChanged = true;
              if (main.agent.snapshot().payload.status === 'idle') markDirty();
            }
            if (native.type === 'turn_completed' || native.type === 'turn_failed' || native.type === 'turn_canceled') { contentChanged = false; markDirty(); }
          }
          if (event.type === 'agent_state') {
            const status = event.snapshot.payload.status;
            if (status !== mainStatus && (status === 'waiting' || status === 'failed' || status === 'idle' && contentChanged)) { contentChanged = false; markDirty(); }
            mainStatus = status;
          }
          if (event.type === 'timeline_rebuilt') markDirty();
        });
        const unsubscribeTpm = tpm.agent.subscribe(event => {
          if (event.type !== 'agent_stream' || event.delivery === 'history' || !['turn_completed', 'turn_failed', 'turn_canceled'].includes(event.event.type)) return;
          void this.store.update(id, undefined, item => {
            if (!active(item.work) || !item.reviewIntentId) return;
            const review = item.backgroundReviews?.find(review => review.id === item.reviewIntentId); if (review) review.failed = true;
            delete item.reviewIntentId;
            item.work.nextCheckAt = this.now() + this.heartbeat(item.work);
            item.work.health = automatic(item.work) ? 'The last review ended without updating work state. A heartbeat will check again.' : 'The last review ended without updating work state. Background delegation is off.';
          }).catch(() => undefined);
        });
        const attachment: Attachment = { tpmTarget, mainResolution, main, tpm, release() { clearTimeout(coalesce); unsubscribeMain(); unsubscribeTpm(); main.release(); tpm!.release(); } };
        if (this.closed || !active(this.store.get(id).work)) { attachment.release(); throw new Error('TPM work is paused or closed.'); }
        if (mainResolution) {
          try { this.access.mainRouting!.assertCurrent(record.work.mainBinding!, mainResolution.target, mainResolution.roleRevision); }
          catch (error) { attachment.release(); throw error; }
        }
        this.attachments.set(id, attachment); return attachment;
      } catch (error) { main.release(); tpm?.release(); throw error; }
    })().finally(() => this.attaching.delete(id));
    this.attaching.set(id, operation); return operation;
  }
  private heartbeat(work: TpmWork): number { return sessionHeartbeatInterval(work.waiting === 'user', { intervalMs: this.options.heartbeatMs, waitingIntervalMs: this.options.waitingHeartbeatMs }); }
  private async process(id: string): Promise<void> {
    const attachment = await this.attach(id); let record = this.store.get(id);
    this.admit(record.work.providerId);
    if (!active(record.work) || unknown(record)) return;
    const outstanding = record.work.outbox?.filter(intent => intent.status === 'prepared') ?? [];
    for (const intent of outstanding) await this.dispatch(id, intent, attachment);
    record = this.store.get(id);
    if (unknown(record) || !active(record.work)) return;
    if (!automatic(record.work)) {
      if (record.reviewIntentId && record.work.nextCheckAt <= this.now() && this.canSend(attachment.tpm, false)) {
        await this.store.update(id, undefined, item => {
          const review = item.backgroundReviews?.find(review => review.id === item.reviewIntentId); if (review) review.failed = true;
          delete item.reviewIntentId; item.work.health = 'The last review has no recorded assessment. Background delegation is off.';
        });
        this.detach(id);
      }
      return;
    }
    if (record.reviewIntentId) {
      // A receipt is not proof that the model completed its review. An overdue idle
      // runtime permits a new reflection, never replay of the accepted input.
      const intent = record.work.outbox?.find(value => value.id === record.reviewIntentId);
      if (intent?.status !== 'accepted' || record.work.nextCheckAt > this.now() || !this.canSend(attachment.tpm, false)) return;
      record = await this.store.update(id, undefined, item => {
        delete item.reviewIntentId; item.dirty = true;
        item.work.health = 'The accepted review has no recorded assessment. Checking current state without replaying it.';
      });
    }
    if (record.work.nextCheckAt > this.now() || this.now() - record.lastReviewAt < (this.options.minimumReviewMs ?? 30_000)) return;
    if (!this.canSend(attachment.tpm, false)) return;
    if (!this.reserveReview(id)) return;
    try {
      const reviewId = randomUUID();
      const intent = await this.enqueue(id, 'tpm', 'review', tpmReviewPrompt(id, record.dirty ? 'Main session updated' : 'Heartbeat', reviewId), reviewId);
      await this.dispatch(id, intent, attachment);
    } finally { this.reviewReservations.delete(id); }
  }
  private reserveReview(id: string): boolean {
    if (!active(this.store.get(id).work)) return false;
    if (this.reviewReservations.has(id)) return true;
    const occupied = new Set([...this.reviewReservations].filter(workId => active(this.store.get(workId).work)));
    for (const record of this.store.all()) if (active(record.work) && (record.reviewIntentId || this.attachments.get(record.work.id)?.tpm.agent.snapshot().payload.status === 'running')) occupied.add(record.work.id);
    if (!occupied.has(id) && occupied.size >= 2) return false;
    this.reviewReservations.add(id); return true;
  }
  private canSend(lease: RemoteHostSessionLease, queue: boolean): boolean {
    const snapshot = lease.agent.snapshot().payload;
    if (!sessionOperationAvailability(snapshot, queue ? 'queue_message' : 'send_message').allowed || snapshot.pendingInteractions.length) return false;
    return queue || snapshot.status === 'idle' && snapshot.activeTurn === null;
  }
  private async dispatch(id: string, candidate: TpmIntent, attachment: Attachment): Promise<void> {
    const before = this.store.get(id); if (!active(before.work) || unknown(before)) return;
    if (candidate.target === 'tpm' && candidate.purpose === 'review' && !automatic(before.work)) return;
    this.admit(before.work.providerId);
    attachment = await this.attach(id);
    const target = candidate.target === 'main' ? attachment.main : attachment.tpm;
    const resolution: TpmMainResolution = candidate.target === 'main' ? attachment.mainResolution ?? { target: { controllerId: this.access.controllerId, providerId: before.work.providerId, nativeSessionId: before.work.mainNativeSessionId } } : { target: attachment.tpmTarget };
    const queue = candidate.target === 'main' && target.agent.snapshot().payload.capabilities.queueMessage === true;
    if (!this.canSend(target, queue)) return;
    if (candidate.target === 'tpm' && (before.reviewIntentId && before.reviewIntentId !== candidate.id || !this.reserveReview(id))) return;
    try {
      let claimed = false;
      let settlement = Promise.resolve();
      const settle = (outcome: { status: 'accepted'; acceptance?: AgentInputAcceptance } | { status: 'rejected' | 'unknown'; error: string }, callback = false) => {
        const next = settlement.catch(() => undefined).then(async () => {
          if (callback && this.closed) return;
          const current = this.store.get(id).work.outbox?.find(value => value.id === candidate.id);
          if (!current || current.status === 'prepared' || current.text !== candidate.text || current.createdAt !== candidate.createdAt
            || current.target !== candidate.target || current.purpose !== candidate.purpose
            || resolution && (!current.resolvedTarget || nativeSessionRefKey(current.resolvedTarget) !== nativeSessionRefKey(resolution.target) || current.roleRevision !== resolution.roleRevision)) return;
          // A late return or transport failure cannot undo evidence for this invocation.
          if (current.status === 'accepted' && ['started', 'handled'].includes(current.acceptance ?? '')) return;
          const acceptance = outcome.status === 'accepted' ? outcome.acceptance?.disposition ?? current.acceptance : current.acceptance;
          if (current.status === outcome.status && current.acceptance === acceptance
            && current.error === (outcome.status === 'accepted' ? undefined : outcome.error)) return;
          await this.store.update(id, undefined, record => {
            const intent = record.work.outbox!.find(value => value.id === candidate.id)!;
            intent.status = outcome.status;
            if (outcome.status === 'accepted') {
              if (acceptance) intent.acceptance = acceptance;
              if (intent.error && record.work.health === intent.error) delete record.work.health;
              delete intent.error;
            } else {
              intent.error = outcome.error; record.work.health = outcome.error;
              if (outcome.status === 'rejected' && record.reviewIntentId === candidate.id) delete record.reviewIntentId;
            }
          });
        });
        settlement = next; return next;
      };
      const onAcceptance = (acceptance: AgentInputAcceptance) => {
        if (this.closed || !['started', 'queued', 'handled'].includes(acceptance.disposition)) return;
        void settle({ status: 'accepted', acceptance: { disposition: acceptance.disposition } }, true).catch(error => {
          if (!this.closed) void this.recordFailure(id, error);
        });
      };
      const check = () => {
        const record = this.store.get(id); this.admit(record.work.providerId);
        if (candidate.target === 'main') {
          this.assertTodoDispatch(record, candidate.todoStepId, candidate.todoPlanRevision, candidate.purpose.split(':')[0]!);
          if (record.work.mainBinding && this.access.mainRouting) {
            try { this.access.mainRouting!.assertCurrent(record.work.mainBinding!, resolution.target, resolution.roleRevision); }
            catch (error) { throw new AgentOperationRejectedError('tpm_main_changed', shortError(error)); }
          }
        }
        if (candidate.target === 'tpm') this.assertTpmCurrent(record.work, resolution.target);
        if (!active(record.work) || candidate.target === 'tpm' && candidate.purpose === 'review' && !automatic(record.work) || !this.canSend(target, queue)) throw new AgentOperationRejectedError('tpm_dispatch_deferred', 'TPM follow-up stopped or native input became unavailable before dispatch.');
      };
      try {
        const options = queue ? { delivery: 'next_turn' as const } : undefined;
        const result = await this.access.execute(target.agent, { operationId: executionOperationId(candidate.id), kind: 'send_message', parameters: { text: candidate.text, ...(options ? { options } : {}) }, maximumResultBytes: 4096 }, {
          beforeDispatch: check,
          dispatch: async () => {
            check();
            await this.store.update(id, undefined, record => {
              check();
              const intent = record.work.outbox?.find(value => value.id === candidate.id);
              if (!intent || intent.status !== 'prepared' || !active(record.work) || unknown(record) || candidate.target === 'tpm' && candidate.purpose === 'review' && !automatic(record.work)) return;
              if (resolution) {
                if (intent.resolvedTarget && (nativeSessionRefKey(intent.resolvedTarget) !== nativeSessionRefKey(resolution.target) || intent.roleRevision !== resolution.roleRevision)) {
                  intent.status = 'rejected'; intent.error = 'The admitted main recipient changed. Submit a new operation after reviewing its outcome.'; return;
                }
                intent.resolvedTarget = resolution.target; intent.roleRevision = resolution.roleRevision;
              }
              intent.status = 'dispatching'; claimed = true;
              if (candidate.target === 'tpm') { record.reviewIntentId = intent.id; record.reviewVersion = record.changeVersion ?? 0; record.lastReviewAt = this.now(); record.work.nextCheckAt = this.now() + this.heartbeat(record.work); }
            });
            if (!claimed) throw new AgentOperationRejectedError('tpm_dispatch_deferred', 'TPM intent is no longer prepared.');
            check(); return target.agent.sendMessage(candidate.text, { ...options, onAcceptance });
          },
        });
        const acceptance = result && typeof result === 'object' && 'disposition' in result && ['started', 'queued', 'handled'].includes(String(result.disposition))
          ? { disposition: result.disposition as AgentInputAcceptance['disposition'] } : undefined;
        await settle({ status: 'accepted', acceptance });
      } catch (error) {
        if (!claimed) {
          if (error instanceof AgentOperationRejectedError && ['tpm_paused', 'todo_step_unavailable', 'todo_approval_required'].includes(error.code)) {
            await this.store.update(id, undefined, record => {
              const intent = record.work.outbox?.find(value => value.id === candidate.id);
              if (intent?.status === 'prepared' && intent.text === candidate.text && intent.createdAt === candidate.createdAt) {
                intent.status = 'rejected'; intent.error = shortError(error);
              }
            });
          }
          return;
        }
        const rejected = error instanceof AgentOperationRejectedError || error instanceof OperationCacheError && error.code !== 'operation_outcome_unknown';
        await settle({ status: rejected ? 'rejected' : 'unknown', error: shortError(error) });
      }
    } finally { if (candidate.target === 'tpm') this.reviewReservations.delete(id); }
  }
  private async enqueue(id: string, target: 'main' | 'tpm', purpose: string, text: string, operationId: string = randomUUID(), todo?: Pick<TpmIntent, 'todoStepId' | 'todoPlanRevision'>, assertCurrent: () => void = () => {}): Promise<TpmIntent> {
    let result: TpmIntent | undefined;
    await this.store.update(id, undefined, record => {
      assertCurrent(); result = this.enqueueRecord(record, target, purpose, text, operationId, todo);
    });
    return result!;
  }
  private enqueueRecord(record: TpmRecord, target: 'main' | 'tpm', purpose: string, text: string, operationId: string, todo?: Pick<TpmIntent, 'todoStepId' | 'todoPlanRevision'>): TpmIntent {
    if (!active(record.work) || unknown(record)) throw new Error('TPM work is paused, completed, or awaiting operation resolution.');
    if (target === 'main') this.assertTodoDispatch(record, todo?.todoStepId, todo?.todoPlanRevision, purpose.split(':')[0]!);
    const outbox = record.work.outbox ??= [];
    const existing = outbox.find(intent => intent.id === operationId);
    if (existing) { if (existing.target !== target || existing.text !== text || existing.purpose !== purpose) throw new Error('Message operation identity was reused with different input.'); return existing; }
    while (outbox.length >= 200) { const index = outbox.findIndex(intent => isTpmIntentSettled(intent) && intent.id !== record.reviewIntentId); if (index < 0) throw new Error('Too many pending messages. Resolve them before adding more.'); outbox.splice(index, 1); }
    const result: TpmIntent = { ...todo, id: operationId, target, purpose, text, status: 'prepared', createdAt: new Date(this.now()).toISOString() }; outbox.push(result);
    if (target === 'tpm' && purpose === 'review') (record.backgroundReviews ??= []).push({ id: operationId, inputHash: backgroundInputHash(text) });
    return result;
  }
  private assertTodoDispatch(record: TpmRecord, stepId: string | undefined, planRevision: number | undefined, purpose: string): void {
    if (!active(record.work)) throw new AgentOperationRejectedError('tpm_paused', 'TPM work is paused or completed.');
    const todo = record.work.todo; const current = todo && currentSessionTodo(todo);
    if (!todo || !current || current.id !== stepId || current.kind !== 'task' || current.status === 'pending' || todo.planRevision !== planRevision) {
      throw new AgentOperationRejectedError('todo_step_unavailable', 'Start the current todo task before sending its main-session message.');
    }
    if (purpose !== 'consultation' && (todo.approvedPlanRevision !== todo.planRevision || record.approvedSpecification !== fingerprint([record.work.document, record.work.acceptance]))) {
      throw new AgentOperationRejectedError('todo_approval_required', 'Implementation requires explicit user approval of the current plan and specification.');
    }
  }
  private async assess(id: string, input: Record<string, any>, assertCurrent: () => void = () => {}): Promise<TpmWork> {
    const result = await this.store.update(id, input.revision, record => {
      assertCurrent();
      const previous = { phase: record.work.phase, waiting: record.work.waiting, summary: record.work.summary, nextAction: record.work.nextAction };
      if (input.reviewId !== undefined) {
        const review = record.backgroundReviews?.find(review => review.id === input.reviewId);
        if (!review || record.reviewIntentId !== review.id || review.result) throw new Error('This background review is no longer awaiting a result.');
        if (typeof input.notify !== 'boolean') throw new Error('A background result requires an explicit notification decision.');
        review.result = { notify: input.notify, summary: input.summary };
      }
      if (record.work.archived) throw new Error('This work is archived. Restore and resume it before changing its assessment.');
      if (record.work.phase === 'completed' && input.phase !== 'completed') throw new Error('Reopen completed work explicitly before changing its delivery phase.');
      if (input.acceptance !== undefined && input.acceptance !== record.work.acceptance && record.work.todo) record.work.todo = invalidateSessionTodoApproval(record.work.todo);
      for (const key of ['title', 'phase', 'waiting', 'summary', 'nextAction', 'acceptance', 'evidence'] as const) if (input[key] !== undefined && (key !== 'title' || !record.titleSetByUser)) (record.work as any)[key] = input[key];
      if (record.work.phase === 'completed' && (!record.work.acceptance.trim() || !record.work.evidence.length)) throw new Error('Completion requires acceptance criteria and work-specific evidence.');
      if (record.work.phase === 'completed' && (!record.work.todo || !sessionTodoComplete(record.work.todo))) throw new Error('Complete every todo step before completing the work.');
      if (record.work.todo && currentSessionTodo(record.work.todo)?.kind === 'confirmation') record.work.waiting = 'user';
      const review = record.backgroundReviews?.find(review => review.id === input.reviewId);
      if (review?.result && !review.result.notify) {
        if (record.work.phase !== previous.phase || record.work.waiting !== previous.waiting) review.result.notify = true;
        else { record.work.summary = previous.summary; record.work.nextAction = previous.nextAction; }
      }
      record.dirty = (record.changeVersion ?? 0) > (record.reviewVersion ?? 0); delete record.reviewIntentId; delete record.work.health;
      if (active(record.work)) record.work.nextCheckAt = this.now() + (record.dirty ? this.options.coalesceMs ?? 2000 : this.heartbeat(record.work));
    });
    if (!active(result.work)) this.detach(id);
    return this.visibleWork(result.work);
  }
  private boundExtensions(id: string, actual: () => string | undefined = () => this.store.get(id).work.tpmNativeSessionId): AgentSessionExtensions {
    const assertCurrent = () => { const work = this.store.get(id).work, nativeSessionId = actual(); if (!nativeSessionId) throw new Error('TPM recipient is not attached.'); this.assertTpmCurrent(work, { controllerId: this.access.controllerId, providerId: work.providerId, nativeSessionId }); };
    const integer = { type: 'integer', minimum: 1 };
    const text = { type: 'string', maxLength: 65536 };
    const short = { type: 'string', maxLength: 2048 };
    const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], execute: (input: Record<string, any>) => Promise<unknown>): AgentSessionTool => ({
      name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
      execute: async args => {
        await this.ready; const record = this.store.get(id); assertCurrent();
        return JSON.stringify(await execute(args as Record<string, any>));
      },
    });
    return { instructions: `${tpmInstructions(id)}\n\n${sessionTodoInstructions}\n\n${sessionHeartbeatInstructions}`, tools: bindAgentSessionTools([
      ...sessionTodoTools({
        read: async () => { await this.ready; const record = this.store.get(id); assertCurrent(); if (!record.work.todo) throw new Error('Reopen this completed work to start a new list.'); return record.work.todo; },
        change: async input => {
          const result = await this.store.update(id, undefined, record => {
            assertCurrent();
            if (!active(record.work) || !record.work.todo) throw new Error('This work is paused or completed.');
            if (record.work.outbox?.some(intent => intent.target === 'main' && ['prepared', 'dispatching', 'unknown'].includes(intent.status)) && ['complete', 'revise_remaining'].includes(input.action)) throw new Error('Settle pending main-session communication before advancing the todo.');
            record.work.todo = changeSessionTodo(record.work.todo, input);
            if (currentSessionTodo(record.work.todo)?.kind === 'confirmation') record.work.waiting = 'user';
            else if (record.work.waiting === 'user') record.work.waiting = 'none';
          });
          return result.work.todo!;
        },
      }),
      tool('read_work', 'Read this work and document versions. An optional documentRevision reads an older artifact without changing the current work revision.', { documentRevision: integer }, [], async input => {
        await this.reconcileMainBinding(id); assertCurrent(); const record = this.store.get(id);
        const historical = input.documentRevision !== undefined && input.documentRevision !== record.work.documentRevision
          ? record.documentHistory?.find(version => version.revision === input.documentRevision) : undefined;
        if (input.documentRevision !== undefined && input.documentRevision !== record.work.documentRevision && !historical) throw new Error('The requested work document revision is unavailable.');
        return { ...this.visibleWork(record.work), delegated: record.work.delegated ?? true, outbox: record.work.outbox?.map(intent => ['accepted', 'rejected', 'canceled'].includes(intent.status) ? { ...intent, text: '[Settled message text omitted.]' } : intent),
          ...(historical ? { document: historical.document, acceptance: historical.acceptance, evidence: historical.evidence ?? [] } : {}), requirement: record.requirement, creation: record.creation, titleSetByUser: !!record.titleSetByUser,
          activeReviewId: record.backgroundReviews?.some(review => review.id === record.reviewIntentId) ? record.reviewIntentId : undefined,
          documentRevision: input.documentRevision ?? record.work.documentRevision, documentVersions: (record.documentHistory ?? []).map(version => ({ revision: version.revision })) };
      }),
      tool('read_main_session', 'Read authoritative main-session state and bounded paginated history. Use the returned cursor to continue; a search filters only the returned page.', {
        direction: { type: 'string', enum: ['tail', 'before', 'after'] },
        cursor: { anyOf: [{ type: 'string', minLength: 1, maxLength: 16384 }, { type: 'object', properties: { epoch: { type: 'string' }, seq: { type: 'integer' } }, required: ['epoch', 'seq'], additionalProperties: false }] },
        sourceContext: { type: 'string', minLength: 1, maxLength: 16384 }, turnId: { type: 'string', minLength: 1, maxLength: 512 }, textOffset: { type: 'integer', minimum: 0 },
        sourceRef: { type: 'object', properties: { controllerId: { type: 'string', minLength: 1, maxLength: 512 }, providerId: { type: 'string', minLength: 1, maxLength: 512 }, nativeSessionId: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['controllerId', 'providerId', 'nativeSessionId'], additionalProperties: false },
        limit: { type: 'integer', minimum: 1, maximum: 100 }, query: { type: 'string', maxLength: 500 },
      }, [], async input => {
        const resolution = await this.reconcileMainBinding(id); assertCurrent(); const record = this.store.get(id);
        if (record.work.mainBinding && this.access.mainRouting?.read) { assertCurrent(); const result = await this.access.mainRouting.read(record.work.mainBinding, input, assertCurrent); assertCurrent(); return result; }
        if ((resolution?.roleRevision ?? 1) > 1 || typeof input.cursor === 'string' || input.sourceContext || input.sourceRef) {
          throw new Error('Contextual main-session reading is unavailable. Reconnect to a Controller with source history support.');
        }
        assertCurrent();
        const lease = resolution ? await this.access.mainRouting!.acquire(resolution.target) : await this.access.acquire(record.work.providerId, record.work.mainNativeSessionId);
        try {
          assertCurrent();
          const request = { requestId: randomUUID(), agentId: lease.agent.agentId, direction: input.direction ?? 'tail', limit: input.limit ?? 40, ...(input.cursor ? { cursor: input.cursor } : {}) };
          const page = await (lease.agent.loadTimeline?.(request) ?? lease.agent.fetchTimeline(request));
          assertCurrent();
          const query = input.query?.toLocaleLowerCase();
          const entries = page.payload.entries.filter(entry => !query || JSON.stringify(entry.item).toLocaleLowerCase().includes(query));
          // Explicitly truncate bodies while preserving native cursors, never silently claim a complete history.
          let budget = 48000; let truncated = false;
          const bounded = entries.flatMap(entry => {
            const encoded = JSON.stringify(entry); if (encoded.length > budget) { truncated = true; return []; }
            budget -= encoded.length; return [entry];
          });
          const { persistence: _persistence, runtimeInfo, ...snapshot } = lease.agent.snapshot().payload;
          const { persistence: _runtimePersistence, ...runtime } = runtimeInfo;
          return { state: { ...snapshot, runtimeInfo: runtime }, page: { ...page.payload, entries: bounded }, truncated, searchScope: 'returned_page' };
        } finally { lease.release(); }
      }),
      tool('send_main_message', 'Queue one work-scoped message to the main session without interrupting it. Reuse operationId for retries of the same request. Acceptance is not completion.', {
        todoStepId: { type: 'string', minLength: 1, maxLength: 128 }, operationId: { type: 'string', minLength: 1, maxLength: 128 }, purpose: { type: 'string', enum: ['consultation', 'implementation', 'acceptance_feedback'] }, text: { type: 'string', minLength: 1, maxLength: 48000 },
      }, ['todoStepId', 'operationId', 'purpose', 'text'], async input => {
        const record = this.store.get(id);
        const messageId = `tpm-${fingerprint([id, input.operationId])}`;
        const existing = record.work.outbox?.find(intent => intent.id === messageId);
        // The public input fingerprint remains independent of later work/document revisions.
        const purpose = `${input.purpose}:${fingerprint([input.text, input.todoStepId])}`;
        if (existing) { if (existing.purpose !== purpose) throw new Error('Message identity was reused with different content.'); return existing; }
        this.assertTodoDispatch(record, input.todoStepId, record.work.todo?.planRevision, input.purpose);
        const message = `[TPM ${id}; todo ${input.todoStepId}; spec revision ${record.work.documentRevision}; ${input.purpose}]\n${input.text}\n\nReply with evidence relevant to this work. Do not infer that unrelated main-session work belongs to it.`;
        const intent = await this.enqueue(id, 'main', purpose, message, messageId, { todoStepId: input.todoStepId, todoPlanRevision: record.work.todo!.planRevision }, assertCurrent);
        this.scheduleTick(); return intent;
      }),
      tool('update_work', 'Record your delivery assessment and acknowledge this review. Set title when the conversation establishes the objective. User-set titles are preserved. Completion requires explicit acceptance criteria and evidence. Does not change user pause.', {
        reviewId: { type: 'string', minLength: 1, maxLength: 128 }, notify: { type: 'boolean' },
        revision: integer, phase: { type: 'string', enum: ['clarifying', 'ready', 'implementing', 'validating', 'completed'] }, waiting: { type: 'string', enum: ['none', 'user', 'main_session'] },
        title: { type: 'string', minLength: 1, maxLength: 256, pattern: '\\S' }, summary: short, nextAction: short, acceptance: text, evidence: { type: 'array', items: short, maxItems: 100 },
      }, ['revision', 'phase', 'waiting', 'summary', 'nextAction'], input => this.assess(id, input, assertCurrent)),
      tool('complete_work', 'Finish this delivery and stop automatic follow-up. Requires all todo tasks, explicit user confirmations, acceptance criteria, and work-specific evidence. Does not archive the conversation.', {
        reviewId: { type: 'string', minLength: 1, maxLength: 128 }, notify: { type: 'boolean' },
        revision: integer, summary: short, acceptance: text, evidence: { type: 'array', items: short, minItems: 1, maxItems: 100 },
      }, ['revision', 'summary', 'evidence'], input => this.assess(id, { ...input, phase: 'completed', waiting: 'none', nextAction: '' }, assertCurrent)),
      tool('write_work_document', 'Replace this work PRD/spec Markdown and acceptance criteria with a revision check. Does not write project files.', {
        revision: integer, document: text, acceptance: text,
      }, ['revision', 'document', 'acceptance'], async input => this.visibleWork((await this.store.update(id, input.revision, record => {
        assertCurrent();
        if (record.work.archived) throw new Error('This work is archived. Restore and resume it before changing its document.');
        if (record.work.document !== input.document || record.work.acceptance !== input.acceptance) {
          if (record.work.todo) record.work.todo = invalidateSessionTodoApproval(record.work.todo);
          if (record.work.todo && currentSessionTodo(record.work.todo)?.kind === 'confirmation') record.work.waiting = 'user';
        }
        record.work.document = input.document; record.work.acceptance = input.acceptance;
      })).work)),
      ...sessionHeartbeatTools({
        read: async () => {
          await this.ready; const record = this.store.get(id); assertCurrent();
          return { now: this.now(), lastReviewAt: record.lastReviewAt, intervalMs: this.heartbeat(record.work), minimumIntervalMs: this.options.minimumReviewMs ?? 30000 };
        },
        schedule: async (at, reason) => this.visibleWork((await this.store.update(id, undefined, record => {
          assertCurrent(); if (!automatic(record.work)) throw new Error('Background scheduling requires delegated, active work.');
          record.work.nextCheckAt = at; record.work.nextAction = reason;
        })).work),
      }),
    ], assertCurrent) };
  }
}

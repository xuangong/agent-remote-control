import { createHash, randomUUID } from 'node:crypto';
import type { AgentSessionExtensions, AgentSessionTool } from '@orchardworks/agent-provider-sdk';
import { AgentOperationRejectedError, bindAgentSessionTools } from '@orchardworks/agent-provider-sdk';
import { isTpmAction, isTpmCreate, sessionOperationAvailability, type TpmAction, type TpmCreate, type TpmIntent, type TpmWork, type TpmList } from '@orchardworks/agent-remote-protocol';
import { OperationCacheError, type AgentManagerEvent, type RemoteHostSessionLease, type SessionWireOperationExecutor } from '@orchardworks/agent-remote-relay';
import { sessionHeartbeatInterval, sessionHeartbeatInstructions, sessionHeartbeatTools } from './session-heartbeat.js';
import { TpmStore, type TpmRecord } from './tpm-store.js';
import { initialTpmTodo, tpmInstructions, tpmReviewPrompt } from './tpm-role.js';
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
export interface TpmSessionAccess {
  supportedProviders(): string[];
  available(): boolean;
  acquire(providerId: string, nativeSessionId: string): Promise<RemoteHostSessionLease>;
  create(providerId: string, cwd: string | undefined, extensions: AgentSessionExtensions): Promise<string>;
  recover?(providerId: string, nativeSessionId: string, extensions: AgentSessionExtensions): Promise<void>;
  execute: SessionWireOperationExecutor;
}
interface Attachment { main: RemoteHostSessionLease; tpm: RemoteHostSessionLease; release(): void }
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const active = (work: TpmWork) => !work.paused && work.phase !== 'completed';
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
      this.timer = setInterval(() => { void this.tick(); }, options.tickMs ?? 1000); this.timer.unref?.();
      void this.tick();
    }).catch(() => { /* Control requests expose recovery failure; do not start partial automation. */ });
  }
  async list(cursor?: string): Promise<TpmList> {
    await this.ready;
    if (cursor !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(cursor)) throw new Error('Invalid TPM catalog cursor.');
    const supportedProviders = this.access.supportedProviders();
    const catalog: TpmList = { supported: supportedProviders.length > 0, supportedProviders, works: [] };
    const works = this.store.all().map(record => record.work).filter(work => cursor === undefined || work.id > cursor).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const work of works) {
      const summary: TpmWork = { ...work, detailsOmitted: true, todo: undefined, todoRevision: work.todo?.revision, document: '', acceptance: '', evidence: [],
        outbox: work.outbox?.filter(intent => ['prepared', 'dispatching', 'unknown'].includes(intent.status)).map(({ error: _error, ...intent }) => ({ ...intent, purpose: intent.purpose.slice(0, 64), text: '[Details omitted; open work details.]' })) };
      const candidate = { ...catalog, works: [...catalog.works, summary], nextCursor: work.id };
      if (catalog.works.length >= 100 || Buffer.byteLength(JSON.stringify(candidate)) > 512 * 1024) {
        if (!catalog.works.length) throw new Error('TPM catalog summary exceeded its size budget.');
        catalog.nextCursor = catalog.works[catalog.works.length - 1]!.id; break;
      }
      catalog.works.push(summary);
    }
    return catalog;
  }
  async get(id: string): Promise<TpmWork> { await this.ready; return this.store.get(id).work; }
  async extensions(providerId: string, nativeSessionId: string): Promise<AgentSessionExtensions | undefined> {
    try { await this.ready; } catch { return undefined; }
    const record = this.store.all().find(value => value.work.providerId === providerId && value.work.tpmNativeSessionId === nativeSessionId);
    return record ? this.boundExtensions(record.work.id) : undefined;
  }
  async create(input: TpmCreate, scope: string): Promise<TpmWork> {
    if (!isTpmCreate(input)) throw new Error('Invalid TPM creation request.');
    return this.manage(async () => {
      this.admit(input.providerId);
      const key = JSON.stringify([scope, input.operationId]); const hash = fingerprint(input);
      const previous = this.store.all().find(record => record.createKey === key);
      if (previous) { if (previous.createFingerprint !== hash) throw new Error('The operation identity was reused with different input.'); return previous.work; }
      const main = await this.access.acquire(input.providerId, input.mainNativeSessionId);
      try {
        const id = randomUUID(); const timestamp = new Date(this.now()).toISOString();
        await this.store.insert({ version: 1, createKey: key, createFingerprint: hash, creation: 'prepared', requirement: input.requirement,
          dirty: true, lastReviewAt: 0, actions: {}, work: { id, revision: 1, title: input.title, providerId: input.providerId,
            mainNativeSessionId: input.mainNativeSessionId, phase: 'clarifying', waiting: 'none', paused: false,
            summary: input.requirement.slice(0, 2048), nextAction: 'Clarify requirements and agree on a delivery plan.', document: '', acceptance: '', evidence: [],
            createdAt: timestamp, updatedAt: timestamp, nextCheckAt: this.now(), outbox: [] } });
        await this.store.update(id, undefined, record => { record.creation = 'dispatching'; });
        try {
          this.admit(input.providerId);
          const nativeId = await this.access.create(input.providerId, main.agent.snapshot().payload.runtimeInfo.cwd, this.boundExtensions(id));
          await this.store.update(id, undefined, record => { record.creation = 'accepted'; record.work.tpmNativeSessionId = nativeId; });
          await this.enqueue(id, 'tpm', 'initial', `TPM work: ${input.title}\n\nUser requirement:\n${input.requirement}\n\nBegin by understanding the user's need and discussing the plan. Read read_work and call update_work to persist your assessment.`);
        } catch (error) {
          await this.store.update(id, undefined, record => { if (record.creation !== 'accepted') record.creation = 'unknown'; record.work.health = shortError(error); });
        }
        void this.tick(); return this.store.get(id).work;
      } finally { main.release(); }
    });
  }
  async action(input: TpmAction, scope: string): Promise<TpmWork> {
    if (!isTpmAction(input)) throw new Error('Invalid TPM action.');
    return this.manage(async () => {
      const previous = this.store.get(input.id); const key = fingerprint([scope, input.operationId]); const hash = fingerprint(input);
      const settled = previous.actions[key];
      if (settled) { if (settled.fingerprint !== hash) throw new Error('The operation identity was reused with different input.'); return previous.work; }
      if (input.action === 'resolve' && input.intentId === 'creation' && input.resolution === 'accepted') {
        if (previous.work.revision !== input.revision) throw new Error('TPM work changed. Refresh before applying this change.');
        if (previous.creation !== 'unknown') throw new Error('The uncertain creation was not found.');
        const nativeId = input.nativeSessionId;
        if (!nativeId) throw new Error('A verified native session identity is required to resolve creation.');
        if (nativeId === previous.work.mainNativeSessionId || this.store.all().some(record => record.work.id !== input.id && record.work.providerId === previous.work.providerId
          && [record.work.mainNativeSessionId, record.work.tpmNativeSessionId].includes(nativeId))) throw new Error('The recovered session is already bound to a main session or another TPM work.');
        if (!this.access.recover) throw new Error('This Controller cannot safely recover TPM creation.');
        this.admit(previous.work.providerId);
        await this.access.recover(previous.work.providerId, nativeId, this.boundExtensions(input.id));
      }
      const updated = await this.store.update(input.id, input.action === 'confirm_todo' ? undefined : input.revision, record => {
        if (input.action === 'confirm_todo') {
          if (!record.work.todo || !active(record.work)) throw new Error('This work is not accepting todo confirmations.');
          record.work.todo = confirmSessionTodo(record.work.todo, input.confirmation);
          if (input.confirmation.decision === 'approve') record.approvedSpecification = fingerprint([record.work.document, record.work.acceptance]);
          record.dirty = true; record.changeVersion = (record.changeVersion ?? 0) + 1;
          record.work.waiting = 'none'; record.work.nextCheckAt = this.now();
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
          if (record.creation === 'abandoned') throw new Error('This work creation was abandoned. Create a new work item.');
          if (unknown(record)) throw new Error('Resolve unknown operation outcomes before continuing.');
          if (input.action === 'reopen') {
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
      void this.tick(); return updated.work;
    });
  }
  async handoff(providerId: string, nativeSessionId: string): Promise<void> {
    await this.ready;
    for (const record of this.store.all()) if (record.work.providerId === providerId && [record.work.mainNativeSessionId, record.work.tpmNativeSessionId].includes(nativeSessionId)) {
      await this.store.update(record.work.id, undefined, item => { item.work.paused = true; item.work.health = 'Automation paused after native CLI takeover. Resume explicitly after returning control.'; });
      this.detach(record.work.id);
    }
  }
  async tick(): Promise<void> {
    if (this.closed || !this.access.available()) return;
    await this.ready;
    const records = this.store.all();
    if (!records.length) return;
    const start = this.scanCursor % records.length;
    for (let offset = 0; offset < records.length; offset++) {
      const index = (start + offset) % records.length;
      const record = records[index]!;
      if (!active(record.work)) { this.detach(record.work.id); continue; }
      if ((this.retries.get(record.work.id) ?? 0) > this.now() || !record.work.tpmNativeSessionId || unknown(record) || this.workers.has(record.work.id)) continue;
      // Retain every active binding, then spend worker slots only on pending or due work.
      if (this.attachments.has(record.work.id) && !record.work.outbox?.some(intent => intent.status === 'prepared') && record.work.nextCheckAt > this.now()) continue;
      if (this.workers.size >= 2) break;
      this.scanCursor = (index + 1) % records.length;
      const work = this.process(record.work.id).catch(async error => {
        this.retries.set(record.work.id, this.now() + 30_000);
        await this.store.update(record.work.id, undefined, item => { item.work.health = shortError(error); }).catch(() => undefined);
      }).finally(() => { this.workers.delete(record.work.id); });
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
  private detach(id: string) { this.attachments.get(id)?.release(); this.attachments.delete(id); }
  private async attach(id: string): Promise<Attachment> {
    const existing = this.attachments.get(id); if (existing) return existing;
    const pending = this.attaching.get(id); if (pending) return pending;
    const operation = (async () => {
      const record = this.store.get(id); this.admit(record.work.providerId);
      const main = await this.access.acquire(record.work.providerId, record.work.mainNativeSessionId);
      let tpm: RemoteHostSessionLease | undefined;
      try {
        tpm = await this.access.acquire(record.work.providerId, record.work.tpmNativeSessionId!);
        let contentChanged = false; let coalesce: ReturnType<typeof setTimeout> | undefined;
        let mainStatus = main.agent.snapshot().payload.status;
        const markDirty = () => {
          if (coalesce || this.closed) return;
          coalesce = setTimeout(() => {
            coalesce = undefined;
            void this.store.update(id, undefined, item => {
              if (!active(item.work)) return;
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
            if (!item.reviewIntentId) return;
            delete item.reviewIntentId;
            item.work.nextCheckAt = this.now() + this.heartbeat(item.work);
            item.work.health = 'The last review ended without updating work state. A heartbeat will check again.';
          }).catch(() => undefined);
        });
        const attachment: Attachment = { main, tpm, release() { clearTimeout(coalesce); unsubscribeMain(); unsubscribeTpm(); main.release(); tpm!.release(); } };
        if (this.closed || !active(this.store.get(id).work)) { attachment.release(); throw new Error('TPM work is paused or closed.'); }
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
      const intent = await this.enqueue(id, 'tpm', 'review', tpmReviewPrompt(id, record.dirty ? 'The bound main session changed or a review was requested' : 'Heartbeat check'));
      await this.dispatch(id, intent, attachment);
    } finally { this.reviewReservations.delete(id); }
  }
  private reserveReview(id: string): boolean {
    if (this.reviewReservations.has(id)) return true;
    const occupied = new Set(this.reviewReservations);
    for (const record of this.store.all()) if (record.reviewIntentId || this.attachments.get(record.work.id)?.tpm.agent.snapshot().payload.status === 'running') occupied.add(record.work.id);
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
    this.admit(before.work.providerId);
    const target = candidate.target === 'main' ? attachment.main : attachment.tpm;
    const queue = candidate.target === 'main' && target.agent.snapshot().payload.capabilities.queueMessage === true;
    if (!this.canSend(target, queue)) return;
    if (candidate.target === 'tpm' && (before.reviewIntentId && before.reviewIntentId !== candidate.id || !this.reserveReview(id))) return;
    try {
      let claimed = false;
      await this.store.update(id, undefined, record => {
        const intent = record.work.outbox?.find(value => value.id === candidate.id);
        if (!intent || intent.status !== 'prepared' || !active(record.work) || unknown(record)) return;
        intent.status = 'dispatching'; claimed = true;
        if (candidate.target === 'tpm') { record.reviewIntentId = intent.id; record.reviewVersion = record.changeVersion ?? 0; record.lastReviewAt = this.now(); record.work.nextCheckAt = this.now() + this.heartbeat(record.work); }
      });
      if (!claimed) return;
      try {
        const options = queue ? { delivery: 'next_turn' as const } : undefined;
        const result = await this.access.execute(target.agent, { operationId: candidate.id, kind: 'send_message', parameters: { text: candidate.text, ...(options ? { options } : {}) }, maximumResultBytes: 4096 }, {
          beforeDispatch: () => {
            const record = this.store.get(id); this.admit(record.work.providerId);
            if (candidate.target === 'main') this.assertTodoDispatch(record, candidate.todoStepId, candidate.todoPlanRevision, candidate.purpose.split(':')[0]!);
            if (!active(record.work) || !this.canSend(target, queue)) throw new AgentOperationRejectedError('tpm_dispatch_deferred', 'TPM work paused or native input became unavailable before dispatch.');
          }, dispatch: () => target.agent.sendMessage(candidate.text, options),
        });
        await this.store.update(id, undefined, record => {
          const intent = record.work.outbox!.find(value => value.id === candidate.id)!; intent.status = 'accepted';
          if (result && typeof result === 'object' && 'disposition' in result && ['started', 'queued', 'handled'].includes(String(result.disposition))) intent.acceptance = result.disposition as 'started' | 'queued' | 'handled';
        });
      } catch (error) {
        const rejected = error instanceof AgentOperationRejectedError || error instanceof OperationCacheError && error.code !== 'operation_outcome_unknown';
        await this.store.update(id, undefined, record => {
          const intent = record.work.outbox!.find(value => value.id === candidate.id)!;
          intent.status = rejected ? 'rejected' : 'unknown'; intent.error = shortError(error);
          if (rejected && record.reviewIntentId === candidate.id) delete record.reviewIntentId;
          record.work.health = intent.error;
        });
      }
    } finally { if (candidate.target === 'tpm') this.reviewReservations.delete(id); }
  }
  private async enqueue(id: string, target: 'main' | 'tpm', purpose: string, text: string, operationId: string = randomUUID(), todo?: Pick<TpmIntent, 'todoStepId' | 'todoPlanRevision'>): Promise<TpmIntent> {
    let result: TpmIntent | undefined;
    await this.store.update(id, undefined, record => {
      if (!active(record.work) || unknown(record)) throw new Error('TPM work is paused, completed, or awaiting operation resolution.');
      if (target === 'main') this.assertTodoDispatch(record, todo?.todoStepId, todo?.todoPlanRevision, purpose.split(':')[0]!);
      const outbox = record.work.outbox ??= [];
      const existing = outbox.find(intent => intent.id === operationId);
      if (existing) { if (existing.target !== target || existing.text !== text || existing.purpose !== purpose) throw new Error('Message operation identity was reused with different input.'); result = existing; return; }
      while (outbox.length >= 200) { const index = outbox.findIndex(intent => ['accepted', 'rejected'].includes(intent.status) && intent.id !== record.reviewIntentId); if (index < 0) throw new Error('Too many pending messages. Resolve them before adding more.'); outbox.splice(index, 1); }
      result = { ...todo, id: operationId, target, purpose, text, status: 'prepared', createdAt: new Date(this.now()).toISOString() }; outbox.push(result);
    });
    return result!;
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
  private boundExtensions(id: string): AgentSessionExtensions {
    const integer = { type: 'integer', minimum: 1 };
    const text = { type: 'string', maxLength: 65536 };
    const short = { type: 'string', maxLength: 2048 };
    const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], execute: (input: Record<string, any>) => Promise<unknown>): AgentSessionTool => ({
      name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
      execute: async args => {
        await this.ready; const record = this.store.get(id); this.admit(record.work.providerId);
        return JSON.stringify(await execute(args as Record<string, any>));
      },
    });
    return { instructions: `${tpmInstructions(id)}\n\n${sessionTodoInstructions}\n\n${sessionHeartbeatInstructions}`, tools: bindAgentSessionTools([
      ...sessionTodoTools({
        read: async () => { await this.ready; const record = this.store.get(id); this.admit(record.work.providerId); if (!record.work.todo) throw new Error('Reopen this completed work to start a new list.'); return record.work.todo; },
        change: async input => {
          const result = await this.store.update(id, undefined, record => {
            this.admit(record.work.providerId);
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
        const record = this.store.get(id);
        const historical = input.documentRevision !== undefined && input.documentRevision !== record.work.documentRevision
          ? record.documentHistory?.find(version => version.revision === input.documentRevision) : undefined;
        if (input.documentRevision !== undefined && input.documentRevision !== record.work.documentRevision && !historical) throw new Error('The requested work document revision is unavailable.');
        return { ...record.work, outbox: record.work.outbox?.map(intent => ['accepted', 'rejected'].includes(intent.status) ? { ...intent, text: '[Settled message text omitted.]' } : intent),
          ...(historical ? { document: historical.document, acceptance: historical.acceptance, evidence: historical.evidence ?? [] } : {}), requirement: record.requirement, creation: record.creation,
          documentRevision: input.documentRevision ?? record.work.documentRevision, documentVersions: (record.documentHistory ?? []).map(version => ({ revision: version.revision })) };
      }),
      tool('read_main_session', 'Read authoritative main-session state and bounded paginated history. Use the returned cursor to continue; a search filters only the returned page.', {
        direction: { type: 'string', enum: ['tail', 'before', 'after'] }, cursor: { type: 'object', properties: { epoch: { type: 'string' }, seq: { type: 'integer' } }, required: ['epoch', 'seq'], additionalProperties: false },
        limit: { type: 'integer', minimum: 1, maximum: 100 }, query: { type: 'string', maxLength: 500 },
      }, [], async input => {
        const record = this.store.get(id); const lease = await this.access.acquire(record.work.providerId, record.work.mainNativeSessionId);
        try {
          const request = { requestId: randomUUID(), agentId: lease.agent.agentId, direction: input.direction ?? 'tail', limit: input.limit ?? 40, ...(input.cursor ? { cursor: input.cursor } : {}) };
          const page = await (lease.agent.loadTimeline?.(request) ?? lease.agent.fetchTimeline(request));
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
        const intent = await this.enqueue(id, 'main', purpose, message, messageId, { todoStepId: input.todoStepId, todoPlanRevision: record.work.todo!.planRevision });
        void this.tick(); return intent;
      }),
      tool('update_work', 'Record your delivery assessment and acknowledge this review. Completion requires explicit acceptance criteria and evidence. Does not change user pause.', {
        revision: integer, phase: { type: 'string', enum: ['clarifying', 'ready', 'implementing', 'validating', 'completed'] }, waiting: { type: 'string', enum: ['none', 'user', 'main_session'] },
        summary: short, nextAction: short, acceptance: text, evidence: { type: 'array', items: short, maxItems: 100 },
      }, ['revision', 'phase', 'waiting', 'summary', 'nextAction'], async input => {
        const result = await this.store.update(id, input.revision, record => {
          if (record.work.phase === 'completed' && input.phase !== 'completed') throw new Error('Reopen completed work explicitly before changing its delivery phase.');
          if (input.acceptance !== undefined && input.acceptance !== record.work.acceptance && record.work.todo) record.work.todo = invalidateSessionTodoApproval(record.work.todo);
          for (const key of ['phase', 'waiting', 'summary', 'nextAction', 'acceptance', 'evidence'] as const) if (input[key] !== undefined) (record.work as any)[key] = input[key];
          if (record.work.phase === 'completed' && (!record.work.acceptance.trim() || !record.work.evidence.length)) throw new Error('Completion requires acceptance criteria and work-specific evidence.');
          if (record.work.phase === 'completed' && (!record.work.todo || !sessionTodoComplete(record.work.todo))) throw new Error('Complete every todo step before completing the work.');
          if (record.work.todo && currentSessionTodo(record.work.todo)?.kind === 'confirmation') record.work.waiting = 'user';
          record.dirty = (record.changeVersion ?? 0) > (record.reviewVersion ?? 0); delete record.reviewIntentId; delete record.work.health;
          record.work.nextCheckAt = this.now() + (record.dirty ? this.options.coalesceMs ?? 2000 : this.heartbeat(record.work));
        });
        if (!active(result.work)) this.detach(id);
        return result.work;
      }),
      tool('write_work_document', 'Replace this work PRD/spec Markdown and acceptance criteria with a revision check. Does not write project files.', {
        revision: integer, document: text, acceptance: text,
      }, ['revision', 'document', 'acceptance'], async input => (await this.store.update(id, input.revision, record => {
        if (record.work.document !== input.document || record.work.acceptance !== input.acceptance) {
          if (record.work.todo) record.work.todo = invalidateSessionTodoApproval(record.work.todo);
          if (record.work.todo && currentSessionTodo(record.work.todo)?.kind === 'confirmation') record.work.waiting = 'user';
        }
        record.work.document = input.document; record.work.acceptance = input.acceptance;
      })).work),
      ...sessionHeartbeatTools({
        read: async () => {
          await this.ready; const record = this.store.get(id); this.admit(record.work.providerId);
          return { now: this.now(), lastReviewAt: record.lastReviewAt, intervalMs: this.heartbeat(record.work), minimumIntervalMs: this.options.minimumReviewMs ?? 30000 };
        },
        schedule: async (at, reason) => (await this.store.update(id, undefined, record => {
          this.admit(record.work.providerId); if (!active(record.work)) throw new Error('Work is paused or completed.');
          record.work.nextCheckAt = at; record.work.nextAction = reason;
        })).work,
      }),
    ]) };
  }
}

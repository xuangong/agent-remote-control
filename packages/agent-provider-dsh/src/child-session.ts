import type { AgentRuntimeInfo, AgentSession, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { DshChildSessions, DshObservationQueue, dshRuntimeObservation, dshChildLifecycleKey, type DshChildEvent } from './children.js';
import { DshProjector } from './projector.js';

type Entry = Parameters<DshChildSessions['read']>[1];

/** A native observation lease with optional parent-addressed current-turn cancellation. */
export class DshChildSession implements AgentSession {
  get capabilities() { return { history: true, sendMessage: false, queueMessage: false, steer: false,
    cancel: !this.closed && this.live && this.lifecycle !== undefined && this.source.canInterrupt(this.parentId, this.entry, this.lifecycle),
    readResource: false, commands: false, sessionSettings: false, planning: false,
    interactions: { question: false, planApproval: false, toolApproval: false } }; }
  private readonly queue = new DshObservationQueue<ProviderStreamItem>();
  private readonly abort = new AbortController();
  private readonly projector: DshProjector;
  private readonly seen: string[] = [];
  private readonly pending: DshChildEvent[] = [];
  private lifecycle?: string;
  private live = false;
  private initial = true;
  private observed = false;
  private closed = false;
  private stop?: () => void;
  private info: AgentRuntimeInfo;

  private constructor(private readonly source: DshChildSessions, private readonly parentId: string, private readonly entry: Entry) {
    this.info = { providerId: 'dsh', sessionId: entry.id, status: 'starting' };
    this.projector = new DshProjector({ sessionId: entry.id, tools: { get: () => undefined } });
  }
  static async open(source: DshChildSessions, parentId: string, entry: Entry, signal?: AbortSignal) {
    const view = new DshChildSession(source, parentId, entry);
    try {
      view.stop = source.watch((id, event, session) => {
        if (id !== entry.id || view.closed) return;
        if (session?.header?.parentSession !== parentId || session.header.origin !== 'subagent') {
          view.fail(new Error('DSH child parent changed.')); return;
        }
        if (view.lifecycle && session?.header && view.lifecycle !== dshChildLifecycleKey(session.header)) { view.fail(new Error('DSH child lifecycle changed.')); return; }
        if (session?.header) view.lifecycle ??= dshChildLifecycleKey(session.header);
        if (event) view.receive(event);
        else for (const item of session?.snapshotEvents?.() ?? []) view.receive(item);
        if (!view.initial && (!event || ['turn/start', 'turn/end'].includes(event.type))) void view.refreshStatus().catch((error) => view.fail(error));
      });
      const cut = await source.read(parentId, entry, signal ? AbortSignal.any([signal, view.abort.signal]) : view.abort.signal);
      try {
        if (view.closed || (view.lifecycle && view.lifecycle !== dshChildLifecycleKey(cut.header))) throw new Error('DSH child lifecycle changed during observation.');
        view.lifecycle = dshChildLifecycleKey(cut.header);
        view.live = cut.source === 'live';
        const descriptor = source.describe(entry, cut);
        view.info = { providerId: 'dsh', sessionId: entry.id, status: descriptor.status, cwd: cut.header.cwd };
        for (const event of cut.events) view.project(event, 'history');
      } finally { cut[Symbol.dispose](); }
      view.queue.push({ type: 'history_boundary' });
      view.initial = false;
      for (const event of view.pending.splice(0)) view.project(event, 'live');
      return view;
    } catch (error) { await view.dispose(); throw error; }
  }
  async *observe(): AsyncIterable<ProviderStreamItem> {
    if (this.observed) throw new Error('DSH child already has an observer.');
    this.observed = true;
    try { yield* this.queue; } finally { await this.dispose(); }
  }
  async sendMessage(): Promise<void> { throw new Error('DSH child view is read-only.'); }
  async cancel(): Promise<void> {
    if (this.closed || !this.live || this.lifecycle === undefined) throw new Error('DSH child cancellation is unavailable.');
    // Admission stays synchronous: no catalog or history await may change the current target turn.
    this.source.interrupt(this.parentId, this.entry, this.lifecycle);
  }
  async respondToInteraction(): Promise<void> { throw new Error('DSH child view is read-only; use its native owner for approvals.'); }
  async runtimeInfo(): Promise<AgentRuntimeInfo> { return { ...this.info }; }
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.abort.abort(); this.stop?.(); this.queue.close();
  }
  private receive(event: DshChildEvent): void {
    if (this.initial) this.pending.push(event);
    else { try { this.project(event, 'live'); } catch (error) { this.fail(error); } }
  }
  private project(event: DshChildEvent, delivery: 'history' | 'live'): void {
    const fingerprint = JSON.stringify(event);
    if (event.seq < this.seen.length && this.seen[event.seq] === fingerprint) return;
    if (!Number.isSafeInteger(event.seq) || event.seq !== this.seen.length) throw new Error('DSH child history changed or skipped a native sequence.');
    this.seen.push(fingerprint);
    if (event.type === 'subagent/descriptor') return;
    for (const item of this.projector.project({ kind: 'session_event', recordId: `child:${this.entry.id}:${event.seq}`, occurredAt: event.time, payload: event })) {
      // Child views do not advertise downloadable resource authority or live approvals.
      if (item.event.type === 'interaction_requested' || item.event.type === 'interaction_resolved') continue;
      this.queue.push({ ...item, delivery, resourceReferences: undefined });
    }
  }
  async validate(signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new Error('DSH child observation is closed.');
    const operation = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
    const entry = (await this.source.entries(this.parentId, operation)).find(({ id }) => id === this.entry.id);
    if (!entry || entry.mode !== this.entry.mode) throw new Error('DSH child descriptor changed.');
    await this.refreshStatus(operation);
  }
  private async refreshStatus(signal = this.abort.signal): Promise<void> {
    const cut = await this.source.read(this.parentId, this.entry, signal);
    try {
      if (this.closed) return;
      if (dshChildLifecycleKey(cut.header) !== this.lifecycle) throw new Error('DSH child lifecycle changed.');
      this.live = cut.source === 'live';
      const status = this.source.describe(this.entry, cut).status;
      if (this.info.status !== status) { this.info = { ...this.info, status }; this.queue.push(dshRuntimeObservation(this.info)); }
    } finally { cut[Symbol.dispose](); }
  }
  private fail(error: unknown): void {
    if (this.closed) return;
    this.info = { ...this.info, status: 'failed' };
    this.queue.push(dshRuntimeObservation(this.info)); this.queue.close(error);
    this.closed = true; this.abort.abort(); this.stop?.();
  }
}

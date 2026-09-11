import { randomUUID } from 'node:crypto';
import type { AgentChildSession, AgentSession } from '@borgee/agent-provider-sdk';
import { DshChildSession } from './child-session.js';
import { withDshChildren } from './parent-session.js';

export interface DshChildEvent { type: string; seq: number; time: number; data: unknown }
export interface DshChildHeader { id: string; origin?: string; isSeeded?: boolean; parentSession?: string; createdAt: number; cwd?: string }
export interface DshChildCut {
  header: DshChildHeader;
  source: 'live' | 'prepared';
  events: readonly DshChildEvent[];
  inheritedEventCount: number;
  projections?: { values: { subagent?: { mode: string; seq: number; label?: string } | null } };
  [Symbol.dispose](): void;
}
interface ChildEntry { kind: string; id: string; mode?: string; label?: string }
export interface DshChildContext {
  get?(name: string): unknown;
  on(name: string, listener: (...args: any[]) => void, options?: { global: boolean }): () => unknown;
}

/** Native Session query and lifecycle services, shared by directory and observer bindings. */
export class DshChildSessions {
  constructor(readonly context: DshChildContext, private readonly timeoutMs = 5000) {}

  private service(name: string): any { return this.context.get?.(name) ?? (this.context as any)[name]; }
  get supported(): boolean { return typeof this.service('subagents')?.listChildren === 'function' && typeof this.service('sessionQuery')?.observeSession === 'function'; }
  async entries(parentId: string, signal?: AbortSignal): Promise<ChildEntry[]> {
    if (!this.supported) return [];
    const entries: ChildEntry[] = await this.request((signal) => this.service('subagents').listChildren(parentId, signal), signal);
    if (!Array.isArray(entries) || entries.length > 256) throw new Error('DSH child catalog is invalid or exceeds the supported limit.');
    return entries.filter((entry) => entry && entry.kind === 'child' && typeof entry.id === 'string' && entry.id.length > 0);
  }
  async read(parentId: string, entry: ChildEntry, signal?: AbortSignal): Promise<DshChildCut> {
    const cut: DshChildCut = await this.request(async (signal) => {
      const result = await this.service('sessionQuery').observeSession(entry.id, { signal, projectionMode: 'all' });
      if (signal.aborted) { result[Symbol.dispose](); signal.throwIfAborted(); }
      return result;
    }, signal);
    try {
      if (cut.header.id !== entry.id || cut.header.origin !== 'subagent' || cut.header.parentSession !== parentId) throw new Error('DSH child does not belong to this parent.');
      const identity = cut.projections?.values.subagent;
      if (!identity || !['one-shot', 'continuable'].includes(identity.mode) || identity.mode !== entry.mode
        || !Number.isSafeInteger(identity.seq) || identity.seq < cut.inheritedEventCount) throw new Error('DSH child descriptor is unavailable.');
      if (!Number.isFinite(cut.header.createdAt) || cut.header.createdAt < 0) throw new Error('DSH child creation time is unavailable.');
      return cut;
    } catch (error) { cut[Symbol.dispose](); throw error; }
  }
  describe(entry: ChildEntry, cut: DshChildCut): AgentChildSession {
    const agent = this.service('agents')?.get?.(entry.id);
    return { nativeSessionId: entry.id, title: entry.label || entry.id, role: entry.mode,
      createdAt: new Date(cut.header.createdAt).toISOString(), observation: cut.source === 'live' ? 'live' : 'saved_history',
      status: agent ? agent.status === 'running' ? 'running' : 'idle' : 'closed' };
  }
  canInterrupt(parentId: string, entry: ChildEntry, lifecycle: string): boolean {
    return this.interruptService(parentId, entry, lifecycle) !== undefined;
  }
  interrupt(parentId: string, entry: ChildEntry, lifecycle: string): void {
    const service = this.interruptService(parentId, entry, lifecycle);
    if (!service) throw new Error('DSH child cancellation is unavailable or its lifecycle changed.');
    const receipt = service.interruptByParent(entry.id, parentId, 'continuable');
    if (receipt?.accepted !== true) throw new Error('DSH child cancellation was not acknowledged by the native service.');
  }
  private interruptService(parentId: string, entry: ChildEntry, lifecycle: string):
    { interruptByParent(childId: string, parentId: string, mode: 'continuable'): { accepted: boolean } } | undefined {
    if (entry.mode !== 'continuable') return undefined;
    const service = this.service('subagents');
    const agents = this.service('agents');
    if (typeof service?.interruptByParent !== 'function' || typeof agents?.get !== 'function') return undefined;
    // Read only the resident Session witness; mutation authority remains inside the native service.
    const header = agents.get(entry.id)?.session?.header;
    if (!header || header.id !== entry.id || header.origin !== 'subagent' || header.parentSession !== parentId
      || dshChildLifecycleKey(header) !== lifecycle) return undefined;
    return service;
  }
  async list(parentId: string, signal?: AbortSignal): Promise<AgentChildSession[]> {
    return this.request(async (signal) => {
      const result: AgentChildSession[] = [];
      for (const entry of await this.entries(parentId, signal)) {
        signal.throwIfAborted();
        const cut = await this.read(parentId, entry, signal);
        try { result.push(this.describe(entry, cut)); } finally { cut[Symbol.dispose](); }
      }
      return result;
    }, signal);
  }
  async open(parentId: string, childId: string): Promise<AgentSession> {
    return this.request(async (signal) => {
      const entry = (await this.entries(parentId, signal)).find(({ id }) => id === childId);
      if (!entry) throw new Error('DSH session is not an available direct child.');
      const session = await DshChildSession.open(this, parentId, entry, signal);
      if (signal.aborted) { await session.dispose(); signal.throwIfAborted(); }
      return session;
    });
  }
  async validate(session: AgentSession): Promise<void> {
    if (!(session instanceof DshChildSession)) throw new Error('DSH child observation does not belong to this adapter.');
    await this.request((signal) => session.validate(signal));
  }
  decorate(parentId: string, session: AgentSession): AgentSession {
    return this.supported ? withDshChildren(this, parentId, session) : session;
  }
  watch(listener: (sessionId: string, event?: DshChildEvent, session?: { header?: DshChildHeader; snapshotEvents?(): readonly DshChildEvent[] }) => void): () => void {
    const stops = [this.context.on('session/event', (session, event) => listener(String(session.id), event, session), { global: true }),
      this.context.on('session/created', (session) => listener(String(session.id), undefined, session), { global: true }),
      this.context.on('agent/disposed', ({ agent }) => listener(String(agent.session.id), undefined, agent.session), { global: true })];
    return () => { for (const stop of stops) stop(); };
  }
  private async request<T>(work: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(outer?.reason);
    outer?.addEventListener('abort', abort, { once: true });
    if (outer?.aborted) abort();
    const timeout = setTimeout(() => controller.abort(new Error('DSH child lookup timed out.')), this.timeoutMs);
    let rejectAbort: (() => void) | undefined;
    try {
      controller.signal.throwIfAborted();
      const cancelled = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
      });
      return await Promise.race([work(controller.signal), cancelled]);
    } finally {
      clearTimeout(timeout);
      if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
      outer?.removeEventListener('abort', abort);
    }
  }
}

export class DshObservationQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private wake?: () => void;
  private closed = false;
  private error?: unknown;
  push(value: T): void { if (!this.closed) { this.values.push(value); this.wake?.(); } }
  close(error?: unknown): void { this.error = error; this.closed = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() { for (;;) {
    if (this.values.length) yield this.values.shift()!;
    else if (this.closed) { if (this.error) throw this.error; return; }
    else await new Promise<void>((resolve) => { this.wake = resolve; });
  } }
}
export function dshRuntimeObservation(runtimeInfo: Awaited<ReturnType<AgentSession['runtimeInfo']>>) {
  return { type: 'observation' as const, sourceKey: `dsh:runtime:${randomUUID()}`, occurredAt: Date.now(), delivery: 'live' as const,
    event: { type: 'runtime_updated' as const, provider: 'dsh', runtimeInfo } };
}

export function dshChildLifecycleKey(header: DshChildHeader): string {
  return JSON.stringify([header.id, header.createdAt, header.cwd, header.isSeeded, header.origin, header.parentSession]);
}

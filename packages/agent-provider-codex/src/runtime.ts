import type { AgentChildSession, AgentRuntimeConnection, AgentRuntimeInfo } from '@agent-remote-controller/agent-provider-sdk';
import { CodexServerRequestCanceled } from './app-server-transport.js';
import type { CodexAppServerTransport } from './app-server-transport.js';
import { collectCodexThreadHistoryItems } from './history.js';
import { initializeCodexTransport } from './initialize.js';
import { isRecord, readString } from './native.js';
import {
  abortableDelay,
  normalizeRecoverySettings,
  permanentRecoveryReason,
  recoveryDelay,
  sharedRestorationSemaphore,
  withDeadline,
  type CodexSharedRecoveryPlan,
} from './shared-recovery.js';

export interface CodexThreadSession {
  receiveNotification(method: string, params: unknown): void;
  receiveRequest(method: string, params: unknown, id: string | number): Promise<unknown>;
  receiveTermination(error: Error): void;
  notifyChildrenChanged(): void;
  childRuntimeInfo(): AgentRuntimeInfo;
  prepareObservation(): Promise<void>;
  markHistoryRefreshNeeded(uncertain?: boolean): void;
  beginRecovery(reason: string): void;
  replaceTransport(transport: CodexAppServerTransport, generation: number): void;
  restoreSnapshot(snapshot: unknown, buffered: CodexRawNotification[]): void;
  connectionChanged(): void;
}
export interface CodexRawNotification { method: string; params: unknown }
interface ChildEntry {
  parentId: string;
  descriptor: AgentChildSession;
  session?: CodexThreadSession;
}

/** Owns native thread routing independently of which Remote chat is observed. */
export class CodexSessionRuntime {
  private readonly sessions = new Map<string, CodexThreadSession>();
  private readonly children = new Map<string, ChildEntry>();
  private readonly discoveries = new Map<string, Promise<CodexThreadSession | undefined>>();
  private readonly buffered = new Map<string, Array<CodexRawNotification & { sequence: number }>>();
  private notificationSequence = 0;
  private readonly origins = new Map<string, { parentId: string; turnId?: string; callId?: string; description?: string }>();
  private closed = false;
  private readonly pendingDispatches = new Map<string, { resolved: boolean }>();
  private readonly overflowed = new Set<string>();
  private readonly discoveryOrder = new Map<string, number>();
  private transport: CodexAppServerTransport;
  private generation = 0;
  private recoveryTask: Promise<void> | undefined;
  private recoveryAbort: AbortController | undefined;
  private connection: AgentRuntimeConnection | undefined;
  private restorationBuffer: Array<CodexRawNotification & { sequence: number }> | undefined;
  private restorationSequence = 0;

  constructor(
    transport: CodexAppServerTransport,
    private readonly root: CodexThreadSession,
    private readonly createChild: (thread: Record<string, unknown>, history: unknown, buffered: CodexRawNotification[]) => CodexThreadSession,
    private readonly recoveryPlan?: CodexSharedRecoveryPlan,
  ) {
    this.transport = transport;
    this.connection = recoveryPlan ? { state: 'connected' } : undefined;
    this.bindTransport(transport);
  }

  private bindTransport(transport: CodexAppServerTransport): number {
    const generation = ++this.generation;
    this.transport = transport;
    transport.setNotificationHandler((method, params) => {
      if (generation === this.generation) this.routeNotification(method, params);
    });
    transport.setTerminationHandler((error) => {
      if (generation === this.generation) this.handleTermination(error);
    });
    for (const method of ['item/tool/requestUserInput', 'tool/requestUserInput', 'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval', 'mcpServer/elicitation/request', 'item/permissions/requestApproval']) {
      transport.setRequestHandler(method, async (params, id) => {
        if (generation !== this.generation) throw new CodexServerRequestCanceled('Codex request belongs to an old connection');
        const threadId = isRecord(params) ? readString(params.threadId) : undefined;
        if (!threadId) throw new Error('Codex request belongs to an unavailable thread');
        const key = `${generation}:${threadId}:${id}`;
        const dispatch = { resolved: false };
        this.pendingDispatches.set(key, dispatch);
        try {
          const session = this.sessions.get(threadId) ?? await this.discover(threadId).catch((error) => {
            const pendingSession = this.sessions.get(threadId);
            if (pendingSession) return pendingSession;
            throw error;
          });
          if (dispatch.resolved) throw new CodexServerRequestCanceled('Codex request already resolved');
          if (!session) throw new Error('Codex request belongs to an unavailable thread');
          return await session.receiveRequest(method, params, id);
        } finally { this.pendingDispatches.delete(key); }
      });
    }
    return generation;
  }

  connectionInfo(): AgentRuntimeConnection | undefined {
    return this.connection ? { ...this.connection } : undefined;
  }

  assertConnected(): void {
    if (!this.connection || this.connection.state === 'connected') return;
    throw new Error(`Codex shared runtime is ${this.connection.state}; wait for native recovery before retrying.`);
  }

  private handleTermination(error: Error): void {
    if (this.closed) return;
    if (!this.recoveryPlan) {
      this.terminate(error);
      return;
    }
    this.generation += 1;
    this.discoveries.clear();
    this.buffered.clear();
    this.overflowed.clear();
    for (const session of this.uniqueSessions()) session.beginRecovery('connection_lost');
    if (this.recoveryTask) return;
    this.recoveryAbort = new AbortController();
    this.recoveryTask = this.recover(this.recoveryAbort.signal).finally(() => {
      this.recoveryTask = undefined;
      this.recoveryAbort = undefined;
    });
  }

  private async recover(signal: AbortSignal): Promise<void> {
    if (!this.recoveryPlan) return;
    const settings = normalizeRecoverySettings(this.recoveryPlan.settings);
    let attempt = 0;
    while (!signal.aborted && !this.closed && (settings.maximumAttempts === undefined || attempt < settings.maximumAttempts)) {
      attempt += 1;
      const delay = recoveryDelay(settings, attempt);
      this.setConnection({ state: 'reconnecting', reason: 'connection_lost', attempt, nextRetryAt: Date.now() + delay });
      let connecting: Promise<CodexAppServerTransport> | undefined;
      let nextTransport: CodexAppServerTransport | undefined;
      try {
        await abortableDelay(delay, signal);
        connecting = this.recoveryPlan.connect();
        nextTransport = await withDeadline(connecting, settings.connectionDeadlineMs, signal, 'Codex shared connection');
        if (signal.aborted || this.closed) {
          await nextTransport.dispose();
          return;
        }
        this.setConnection({ state: 'restoring', reason: 'connection_lost', attempt });
        const generation = this.bindTransport(nextTransport);
        for (const session of this.uniqueSessions()) session.replaceTransport(nextTransport, generation);
        await sharedRestorationSemaphore.run(
          () => withDeadline(this.restore(generation), settings.restorationDeadlineMs, signal, 'Codex shared restoration'),
          signal,
        );
        if (generation !== this.generation || signal.aborted || this.closed) continue;
        this.setConnection({ state: 'connected' });
        return;
      } catch (error) {
        this.restorationBuffer = undefined;
        if (!nextTransport && connecting) {
          void connecting.then(transport => transport.dispose()).catch(() => undefined);
        }
        if (signal.aborted || this.closed) return;
        if (nextTransport) await nextTransport.dispose().catch(() => undefined);
        const permanent = permanentRecoveryReason(error);
        if (permanent) {
          this.setConnection({ state: 'unavailable', reason: permanent, attempt });
          return;
        }
      }
    }
    if (!signal.aborted && !this.closed && settings.maximumAttempts !== undefined) {
      this.setConnection({ state: 'unavailable', reason: 'retry_exhausted', attempt: settings.maximumAttempts });
    }
  }

  private async restore(generation: number): Promise<void> {
    this.restorationBuffer = [];
    this.restorationSequence = 0;
    await initializeCodexTransport(this.transport);
    const rootId = [...this.sessions.entries()].find(([, session]) => session === this.root)?.[0];
    if (!rootId) throw new Error('Codex shared restoration has no native root');
    const attached = await this.transport.request('thread/resume', { threadId: rootId, historyMode: 'paginated' });
    if (generation !== this.generation) throw new Error('Codex shared restoration used a stale connection');
    if (!isRecord(attached) || !isRecord(attached.thread) || attached.thread.id !== rootId) {
      throw new Error('Codex shared restoration could not attach the native root');
    }
    const snapshots = new Map<string, { value: unknown; sequence: number }>();
    for (const [threadId] of this.sessions) {
      for (let attempt = 0; ; attempt += 1) {
        const sequence = this.restorationSequence;
        const value = await this.transport.request('thread/read', { threadId, includeTurns: true });
        if (generation !== this.generation) throw new Error('Codex shared restoration used a stale connection');
        if (!isRecord(value) || !isRecord(value.thread) || value.thread.id !== threadId) {
          throw new Error('Codex shared restoration returned an incompatible thread snapshot');
        }
        const duringRead = this.restorationBuffer.filter(item => item.sequence > sequence && notificationThreadId(item.params) === threadId);
        if (!historyOverlapsNotifications(value, threadId, duringRead)) {
          snapshots.set(threadId, { value, sequence });
          break;
        }
        if (attempt === 2) throw new Error('Codex shared history remained active across bounded snapshot reads');
      }
    }
    if (generation !== this.generation) throw new Error('Codex shared restoration used a stale connection');
    const buffered = this.restorationBuffer;
    this.restorationBuffer = undefined;
    for (const [threadId, session] of this.sessions) {
      const snapshot = snapshots.get(threadId);
      if (!snapshot) continue;
      session.restoreSnapshot(snapshot.value, buffered.filter(item => item.sequence > snapshot.sequence && notificationThreadId(item.params) === threadId));
    }
    this.inspectHistory(rootId, snapshots.get(rootId)?.value);
  }

  private setConnection(connection: AgentRuntimeConnection): void {
    this.connection = connection;
    for (const session of this.uniqueSessions()) session.connectionChanged();
  }

  private uniqueSessions(): Set<CodexThreadSession> {
    return new Set([this.root, ...this.sessions.values()]);
  }

  registerRoot(id: string): void { this.sessions.set(id, this.root); }
  hasThread(id: string): boolean { return !this.closed && this.sessions.has(id); }
  hasChild(parentId: string, childId: string): boolean { return this.hasThread(parentId) && this.children.get(childId)?.parentId === parentId; }

  childSessions(parentId: string): AgentChildSession[] {
    return [...this.children.values()].filter((child) => child.parentId === parentId).sort((a, b) => this.discoveryOrder.get(a.descriptor.nativeSessionId)! - this.discoveryOrder.get(b.descriptor.nativeSessionId)!).map(({ descriptor }) => ({ ...descriptor }));
  }

  async openChild(parentId: string, childId: string): Promise<CodexThreadSession> {
    if (this.closed) throw new Error('Codex runtime is closed');
    await this.discoveries.get(childId);
    const child = this.children.get(childId);
    if (!this.sessions.has(parentId) || !child || child.parentId !== parentId) throw new Error('Codex session is not a direct child of the loaded parent');
    if (!child.session) throw new Error('Codex child history is unavailable');
    await child.session.prepareObservation();
    return child.session;
  }

  sessionChanged(id: string): void {
    const child = this.children.get(id);
    if (!child?.session) return;
    const status = child.session.childRuntimeInfo().status;
    if (child.descriptor.status === status) return;
    child.descriptor.status = status;
    child.descriptor.observation = status === 'closed' ? 'saved_history' : 'live';
    this.sessions.get(child.parentId)?.notifyChildrenChanged();
  }

  inspectHistory(parentId: string, history: unknown): void {
    if (!isRecord(history) || !isRecord(history.thread) || !Array.isArray(history.thread.turns)) return;
    for (const turn of history.thread.turns) {
      if (!isRecord(turn) || !Array.isArray(turn.items)) continue;
      for (const item of turn.items) this.inspectItem(parentId, readString(turn.id), item);
    }
  }

  private routeNotification(method: string, params: unknown): void {
    if (this.closed) return;
    if (this.restorationBuffer) {
      this.restorationBuffer.push({ method, params, sequence: ++this.restorationSequence });
      return;
    }
    const thread = isRecord(params) && isRecord(params.thread) ? params.thread : undefined;
    const id = isRecord(params) ? readString(params.threadId) ?? (thread ? readString(thread.id) : undefined) : undefined;
    if (id && method === 'serverRequest/resolved' && isRecord(params)) {
      const dispatch = this.pendingDispatches.get(`${this.generation}:${id}:${params.requestId}`);
      if (dispatch) dispatch.resolved = true;
    }
    if (!id) { this.root.receiveNotification(method, params); return; }
    if (isRecord(params) && (method === 'item/started' || method === 'item/completed')) this.inspectItem(id, readString(params.turnId), params.item);
    const session = this.sessions.get(id);
    if (session) { session.receiveNotification(method, params); return; }
    // The root start response establishes its id; its early notifications belong in bootstrap.
    if (!this.sessions.size && (!thread || !parentThreadId(thread))) {
      this.root.receiveNotification(method, params);
      return;
    }
    const queue = this.buffered.get(id) ?? [];
    queue.push({ method, params, sequence: ++this.notificationSequence });
    if (queue.length > 512) { queue.shift(); this.overflowed.add(id); }
    this.buffered.set(id, queue);
    void this.discover(id).catch(() => undefined);
  }

  private inspectItem(parentId: string, turnId: string | undefined, item: unknown): void {
    if (!isRecord(item)) return;
    if (item.type === 'subAgentActivity') {
      const id = readString(item.agentThreadId);
      if (!id || id === parentId) return;
      if (item.kind === 'started' && !this.origins.has(id)) {
        this.origins.set(id, { parentId, turnId, callId: readString(item.id) });
        const entry = this.children.get(id);
        if (entry && entry.parentId === parentId) {
          Object.assign(entry.descriptor, this.originFields(id, parentId));
          this.sessions.get(parentId)?.notifyChildrenChanged();
        }
      }
      void this.discover(id).catch(() => undefined);
      return;
    }
    if (item.type !== 'collabAgentToolCall' || !Array.isArray(item.receiverThreadIds)) return;
    for (const id of item.receiverThreadIds) {
      if (typeof id !== 'string') continue;
      if (item.tool === 'spawnAgent' && !this.origins.has(id)) {
        this.origins.set(id, { parentId, turnId, callId: readString(item.id), description: readString(item.prompt) });
        const entry = this.children.get(id);
        if (entry && entry.parentId === parentId) {
          Object.assign(entry.descriptor, this.originFields(id, parentId));
          this.sessions.get(parentId)?.notifyChildrenChanged();
        }
      }
      if (item.tool === 'spawnAgent' || this.children.has(id)) void this.discover(id).catch(() => undefined);
    }
  }

  private originFields(id: string, parentId: string): Pick<AgentChildSession, 'parentTurnId' | 'parentCallId' | 'description'> {
    const origin = this.origins.get(id);
    if (origin?.parentId !== parentId) return {};
    return { ...(origin.turnId ? { parentTurnId: origin.turnId } : {}), ...(origin.callId ? { parentCallId: origin.callId } : {}),
      ...(origin.description ? { description: origin.description } : {}) };
  }

  private discover(id: string, ancestry: string[] = []): Promise<CodexThreadSession | undefined> {
    if (this.closed || ancestry.includes(id) || ancestry.length > 32) return Promise.resolve(undefined);
    const session = this.sessions.get(id);
    if (session) return Promise.resolve(session);
    const pending = this.discoveries.get(id);
    if (pending) return pending;
    if (!this.discoveryOrder.has(id)) this.discoveryOrder.set(id, this.discoveryOrder.size);
    const generation = this.generation;
    let operation: Promise<CodexThreadSession | undefined>;
    operation = this.readChild(id, ancestry, generation).finally(() => {
      if (this.discoveries.get(id) === operation) {
        this.discoveries.delete(id);
        this.buffered.delete(id);
      }
    });
    this.discoveries.set(id, operation);
    return operation;
  }

  private async readChild(id: string, ancestry: string[], generation: number): Promise<CodexThreadSession | undefined> {
    const metadata = await this.transport.request('thread/read', { threadId: id, includeTurns: false });
    if (generation !== this.generation || this.closed || !isRecord(metadata) || !isRecord(metadata.thread) || metadata.thread.id !== id) return undefined;
    const parentId = parentThreadId(metadata.thread);
    if (!parentId || parentId === id) return undefined;
    if (!this.sessions.has(parentId) && !await this.discover(parentId, [...ancestry, id])) return undefined;
    if (generation !== this.generation || this.closed) return undefined;
    const previous = this.children.get(id);
    if (previous && previous.parentId !== parentId) return undefined;
    let snapshotStart = this.notificationSequence;
    let history = await this.transport.request('thread/read', { threadId: id, includeTurns: true });
    if (generation !== this.generation || this.closed || !isRecord(history) || !isRecord(history.thread) || history.thread.id !== id || parentThreadId(history.thread) !== parentId) return undefined;
    let thread = history.thread;
    const loaded = isRecord(thread.status) && thread.status.type !== 'notLoaded';
    const descriptor: AgentChildSession = {
      nativeSessionId: id,
      title: childTitle(thread, id),
      ...(readString(thread.agentRole) ? { role: readString(thread.agentRole) } : {}),
      createdAt: previous?.descriptor.createdAt ?? nativeCreatedAt(thread.createdAt),
      status: loaded ? 'starting' : 'closed', observation: loaded ? 'live' : 'saved_history',
      ...this.originFields(id, parentId),
    };
    const entry: ChildEntry = { parentId, descriptor };
    this.children.set(id, entry);
    if (!loaded && thread.ephemeral === true && (!Array.isArray(thread.turns) || !thread.turns.length)) {
      this.sessions.get(parentId)?.notifyChildrenChanged();
      return undefined;
    }
    try {
      for (let attempt = 0; ; attempt++) {
        const duringRead = (this.buffered.get(id) ?? []).filter((item) => item.sequence > snapshotStart);
        if (!historyOverlapsNotifications(history, id, duringRead)) break;
        if (attempt === 2) throw new Error('Codex child history is changing during snapshot reads. Reopen the child to retry.');
        snapshotStart = this.notificationSequence;
        history = await this.transport.request('thread/read', { threadId: id, includeTurns: true });
        if (generation !== this.generation || !isRecord(history) || !isRecord(history.thread) || history.thread.id !== id || parentThreadId(history.thread) !== parentId) throw new Error('Codex child history is unavailable. Reopen the child to retry.');
        thread = history.thread;
      }
      descriptor.observation = isRecord(thread.status) && thread.status.type === 'notLoaded' ? 'saved_history' : 'live';
      descriptor.title = childTitle(thread, id);
      if (readString(thread.agentRole)) descriptor.role = readString(thread.agentRole);
      if (generation !== this.generation) return undefined;
      entry.session = this.createChild(thread, history, this.buffered.get(id) ?? []);
    } catch (error) {
      if (generation !== this.generation || this.closed) {
        if (this.children.get(id) === entry) this.children.delete(id);
        return undefined;
      }
      entry.session = this.createChild(thread, history, this.buffered.get(id) ?? []);
      entry.session.markHistoryRefreshNeeded(true);
      this.sessions.set(id, entry.session);
      descriptor.status = entry.session.childRuntimeInfo().status;
      this.sessions.get(parentId)?.notifyChildrenChanged();
      throw error;
    }
    if (generation !== this.generation) return undefined;
    this.sessions.set(id, entry.session);
    if (this.overflowed.delete(id)) entry.session.markHistoryRefreshNeeded();
    descriptor.status = entry.session.childRuntimeInfo().status;
    this.inspectHistory(id, history);
    this.sessions.get(parentId)?.notifyChildrenChanged();
    return entry.session;
  }

  terminate(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.recoveryAbort?.abort(new Error('Codex runtime is closed'));
    this.restorationBuffer = undefined;
    for (const session of new Set([this.root, ...this.sessions.values()])) session.receiveTermination(error);
  }
}

function notificationThreadId(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  const thread = isRecord(params.thread) ? params.thread : undefined;
  return readString(params.threadId) ?? (thread ? readString(thread.id) : undefined);
}

function childTitle(thread: Record<string, unknown>, id: string): string {
  const spawn = isRecord(thread.source) && isRecord(thread.source.subAgent) && isRecord(thread.source.subAgent.thread_spawn)
    ? thread.source.subAgent.thread_spawn : undefined;
  return readString(thread.agentPath) ?? (spawn ? readString(spawn.agent_path) : undefined)
    ?? readString(thread.name) ?? readString(thread.agentNickname) ?? readString(thread.agentRole) ?? id;
}

function parentThreadId(thread: Record<string, unknown>): string | undefined {
  if (readString(thread.parentThreadId)) return readString(thread.parentThreadId);
  if (!isRecord(thread.source) || !isRecord(thread.source.subAgent) || !isRecord(thread.source.subAgent.thread_spawn)) return undefined;
  return readString(thread.source.subAgent.thread_spawn.parent_thread_id);
}

function nativeCreatedAt(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value * 1000);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return new Date().toISOString();
}

export function historyOverlapsNotifications(history: unknown, threadId: string, notifications: readonly CodexRawNotification[]): boolean {
  const items = collectCodexThreadHistoryItems(history, threadId);
  return notifications.some(({ method, params }) => (
    method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta' || method === 'item/plan/delta'
  ) && isRecord(params) && typeof params.itemId === 'string' && items.has(params.itemId));
}

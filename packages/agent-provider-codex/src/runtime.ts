import type { AgentChildSession, AgentRuntimeConnection, AgentRuntimeInfo } from '@orchardworks/agent-provider-sdk';
import { CodexDaemonClient, CodexRestorationSemaphore, type CodexChildSnapshot, type CodexThreadOrigin } from '@orchardworks/codex-daemon-client';
import type { CodexAppServerTransport } from './app-server-transport.js';
import { providerInitialization } from './initialize.js';
import { isRecord, readString } from './native.js';
import type { CodexSharedRecoveryPlan } from './shared-recovery.js';
export { historyOverlapsNotifications } from '@orchardworks/codex-daemon-client';

export interface CodexThreadSession {
  hasIdleState(): boolean;
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
  discoveryOrder: number;
}

// Provider roots share the process-wide native restoration limit.
const restorationScheduler = new CodexRestorationSemaphore(4);

/** Projects native client callbacks into Provider sessions and child descriptors. */
export class CodexSessionRuntime {
  private readonly sessions = new Map<string, CodexThreadSession>();
  private readonly children = new Map<string, ChildEntry>();
  private readonly client: CodexDaemonClient;

  constructor(
    transport: CodexAppServerTransport,
    private readonly root: CodexThreadSession,
    private readonly createChild: (thread: Record<string, unknown>, history: unknown, buffered: CodexRawNotification[]) => CodexThreadSession,
    recoveryPlan?: CodexSharedRecoveryPlan,
  ) {
    this.client = new CodexDaemonClient({ paginatedHistory: true, transport, initialization: providerInitialization, recovery: recoveryPlan, restorationScheduler,
      callbacks: {
        onNotification: (method, params) => {
          const thread = isRecord(params) && isRecord(params.thread) ? params.thread : undefined;
          const id = isRecord(params) ? readString(params.threadId) ?? (thread ? readString(thread.id) : undefined) : undefined;
          (id ? this.sessions.get(id) ?? this.root : this.root).receiveNotification(method, params);
        },
        onRequest: (method, params, id, context) => {
          const session = this.sessions.get(context.threadId);
          if (!session) throw new Error('Codex request belongs to an unavailable thread');
          return session.receiveRequest(method, params, id);
        },
        onSnapshot: ({ threadId, snapshot, notifications }) => this.sessions.get(threadId)?.restoreSnapshot(snapshot, notifications),
        onChild: child => this.acceptChild(child),
        onChildOrigin: (id, origin) => {
          const entry = this.children.get(id);
          if (!entry || entry.parentId !== origin.parentThreadId) return;
          Object.assign(entry.descriptor, originFields(origin));
          this.sessions.get(entry.parentId)?.notifyChildrenChanged();
        },
        onInvalidated: reason => { for (const session of this.uniqueSessions()) session.beginRecovery(reason); },
        onTransport: (next, generation) => { for (const session of this.uniqueSessions()) session.replaceTransport(next, generation); },
        onConnection: () => { for (const session of this.uniqueSessions()) session.connectionChanged(); },
        onTermination: error => { for (const session of this.uniqueSessions()) session.receiveTermination(error); },
      },
    });
  }

  connectionInfo(): AgentRuntimeConnection | undefined { return this.client.connectionInfo(); }
  assertConnected(): void { this.client.assertConnected(); }
  registerRoot(id: string): void { this.sessions.set(id, this.root); this.client.registerRoot(id); }
  hasThread(id: string): boolean { return this.client.hasThread(id); }
  hasChild(parentId: string, childId: string): boolean { return this.client.hasChild(parentId, childId); }
  inspectHistory(parentId: string, history: unknown): void { this.client.inspectHistory(parentId, history); }
  terminate(error: Error): void { this.client.terminate(error); }

  async reconcileIdle(): Promise<boolean> {
    if (![...this.uniqueSessions()].every(session => session.hasIdleState())) return false;
    return await this.client.reconcileIdle() && this.canReleaseIdle();
  }

  canReleaseIdle(): boolean {
    return !this.client.hasUnresolvedChildren() && [...this.uniqueSessions()].every(session => session.hasIdleState())
      && [...this.children.values()].every(child => child.session || child.descriptor.status === 'closed');
  }

  private uniqueSessions(): Set<CodexThreadSession> { return new Set([this.root, ...this.sessions.values()]); }

  childSessions(parentId: string): AgentChildSession[] {
    return [...this.children.values()].filter(child => child.parentId === parentId)
      .sort((a, b) => a.discoveryOrder - b.discoveryOrder).map(({ descriptor }) => ({ ...descriptor }));
  }

  async openChild(parentId: string, childId: string): Promise<CodexThreadSession> {
    await this.client.waitForChild(parentId, childId);
    const session = this.children.get(childId)?.session;
    if (!session) throw new Error('Codex child history is unavailable');
    await session.prepareObservation();
    return session;
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

  private acceptChild(child: CodexChildSnapshot): void {
    const { thread, parentThreadId: parentId } = child;
    const id = readString(thread.id)!;
    const previous = this.children.get(id);
    const loaded = isRecord(thread.status) && thread.status.type !== 'notLoaded';
    const descriptor: AgentChildSession = {
      nativeSessionId: id, title: childTitle(thread, id),
      ...(readString(thread.agentRole) ? { role: readString(thread.agentRole) } : {}),
      createdAt: previous?.descriptor.createdAt ?? nativeCreatedAt(thread.createdAt),
      status: loaded ? 'starting' : 'closed', observation: loaded ? 'live' : 'saved_history',
      ...originFields(child.origin),
    };
    const entry: ChildEntry = { parentId, descriptor, discoveryOrder: child.discoveryOrder };
    this.children.set(id, entry);
    if (child.historyState !== 'unavailable') {
      entry.session = this.createChild(thread, child.history, child.notifications);
      if (child.historyState === 'uncertain' || child.requiresRefresh) entry.session.markHistoryRefreshNeeded(child.historyState === 'uncertain');
      this.sessions.set(id, entry.session);
      descriptor.status = entry.session.childRuntimeInfo().status;
    }
    this.sessions.get(parentId)?.notifyChildrenChanged();
  }
}

function originFields(origin: CodexThreadOrigin | undefined): Pick<AgentChildSession, 'parentTurnId' | 'parentCallId' | 'description'> {
  if (!origin) return {};
  return { ...(origin.turnId ? { parentTurnId: origin.turnId } : {}), ...(origin.callId ? { parentCallId: origin.callId } : {}),
    ...(origin.description ? { description: origin.description } : {}) };
}

function childTitle(thread: Record<string, unknown>, id: string): string {
  const spawn = isRecord(thread.source) && isRecord(thread.source.subAgent) && isRecord(thread.source.subAgent.thread_spawn)
    ? thread.source.subAgent.thread_spawn : undefined;
  return readString(thread.agentPath) ?? (spawn ? readString(spawn.agent_path) : undefined)
    ?? readString(thread.name) ?? readString(thread.agentNickname) ?? readString(thread.agentRole) ?? id;
}

function nativeCreatedAt(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value * 1000);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return new Date().toISOString();
}

import type { CodexAppServerTransport } from './app-server-transport.js';
import { historyOverlapsNotifications, reconcileCodexHistoryNotifications } from './history.js';
import { isRecord, readString } from './native.js';
import type { CodexDaemonCallbacks, CodexRawNotification, CodexThreadOrigin } from './types.js';

/** Native discovery and buffering do not depend on how an application observes a thread. */
export class CodexThreadRouter {
  readonly threads = new Set<string>();
  rootId: string | undefined;
  private readonly children = new Map<string, string>();
  private readonly discoveries = new Map<string, Promise<boolean>>();
  private readonly buffered = new Map<string, Array<CodexRawNotification & { sequence: number }>>();
  private readonly origins = new Map<string, CodexThreadOrigin>();
  private readonly overflowed = new Set<string>();
  private readonly discoveryOrder = new Map<string, number>();
  private notificationSequence = 0;
  private generation = 0;
  private closed = false;

  constructor(private readonly transport: () => CodexAppServerTransport, private readonly callbacks: CodexDaemonCallbacks) {}

  registerRoot(id: string): void { this.rootId = id; this.threads.add(id); }
  hasThread(id: string): boolean { return !this.closed && this.threads.has(id); }
  hasChild(parentId: string, id: string): boolean { return this.hasThread(parentId) && this.children.get(id) === parentId; }

  async waitForChild(parentId: string, id: string): Promise<void> {
    if (this.closed) throw new Error('Codex runtime is closed');
    await this.discoveries.get(id);
    if (!this.hasChild(parentId, id)) throw new Error('Codex session is not a direct child of the loaded parent');
    if (!this.threads.has(id)) throw new Error('Codex child history is unavailable');
  }

  invalidate(): void {
    this.generation++;
    this.discoveries.clear();
    this.buffered.clear();
    this.overflowed.clear();
  }

  close(): void { this.closed = true; this.invalidate(); }

  routeNotification(method: string, params: unknown): void {
    if (this.closed) return;
    const thread = isRecord(params) && isRecord(params.thread) ? params.thread : undefined;
    const id = notificationThreadId(params);
    if (!id) { this.callbacks.onNotification?.(method, params); return; }
    if (isRecord(params) && (method === 'item/started' || method === 'item/completed')) this.inspectItem(id, readString(params.turnId), params.item);
    if (this.threads.has(id)) { this.callbacks.onNotification?.(method, params); return; }
    // The root start response establishes its id; early notifications belong to bootstrap.
    if (!this.threads.size && (!thread || !parentThreadId(thread))) {
      this.callbacks.onNotification?.(method, params);
      return;
    }
    const queue = this.buffered.get(id) ?? [];
    queue.push({ method, params, sequence: ++this.notificationSequence });
    if (queue.length > 512) { queue.shift(); this.overflowed.add(id); }
    this.buffered.set(id, queue);
    void this.discover(id).catch(() => undefined);
  }

  inspectHistory(parentId: string, history: unknown): void {
    if (!isRecord(history) || !isRecord(history.thread) || !Array.isArray(history.thread.turns)) return;
    for (const turn of history.thread.turns) {
      if (!isRecord(turn) || !Array.isArray(turn.items)) continue;
      for (const item of turn.items) this.inspectItem(parentId, readString(turn.id), item);
    }
  }

  inspectItem(parentId: string, turnId: string | undefined, item: unknown): void {
    if (!isRecord(item)) return;
    if (item.type === 'subAgentActivity') {
      const id = readString(item.agentThreadId);
      if (!id || id === parentId) return;
      if (item.kind === 'started') this.recordOrigin(id, { parentThreadId: parentId, turnId, callId: readString(item.id) });
      void this.discover(id).catch(() => undefined);
      return;
    }
    if (item.type !== 'collabAgentToolCall' || !Array.isArray(item.receiverThreadIds)) return;
    for (const id of item.receiverThreadIds) {
      if (typeof id !== 'string') continue;
      if (item.tool === 'spawnAgent') this.recordOrigin(id, { parentThreadId: parentId, turnId, callId: readString(item.id), description: readString(item.prompt) });
      if (item.tool === 'spawnAgent' || this.children.has(id)) void this.discover(id).catch(() => undefined);
    }
  }

  private recordOrigin(id: string, origin: CodexThreadOrigin): void {
    if (this.origins.has(id)) return;
    this.origins.set(id, origin);
    if (this.children.get(id) === origin.parentThreadId) this.callbacks.onChildOrigin?.(id, origin);
  }

  discover(id: string, ancestry: string[] = []): Promise<boolean> {
    if (this.closed || ancestry.includes(id) || ancestry.length > 32) return Promise.resolve(false);
    if (this.threads.has(id)) return Promise.resolve(true);
    const pending = this.discoveries.get(id);
    if (pending) return pending;
    if (!this.discoveryOrder.has(id)) this.discoveryOrder.set(id, this.discoveryOrder.size);
    const generation = this.generation;
    let operation: Promise<boolean>;
    operation = this.readChild(id, ancestry, generation).finally(() => {
      if (this.discoveries.get(id) === operation) {
        this.discoveries.delete(id);
        this.buffered.delete(id);
      }
    });
    this.discoveries.set(id, operation);
    return operation;
  }

  private async readChild(id: string, ancestry: string[], generation: number): Promise<boolean> {
    const transport = this.transport();
    const metadata = await transport.request('thread/read', { threadId: id, includeTurns: false });
    if (generation !== this.generation || this.closed || !isRecord(metadata) || !isRecord(metadata.thread) || metadata.thread.id !== id) return false;
    const parentId = parentThreadId(metadata.thread);
    if (!parentId || parentId === id) return false;
    if (!this.threads.has(parentId) && !await this.discover(parentId, [...ancestry, id])) return false;
    if (generation !== this.generation || this.closed) return false;
    const previous = this.children.get(id);
    if (previous && previous !== parentId) return false;
    let snapshotStart = this.notificationSequence;
    let history = await transport.request('thread/read', { threadId: id, includeTurns: true });
    if (generation !== this.generation || this.closed || !isRecord(history) || !isRecord(history.thread) || history.thread.id !== id || parentThreadId(history.thread) !== parentId) return false;
    let thread = history.thread;
    const loaded = isRecord(thread.status) && thread.status.type !== 'notLoaded';
    this.children.set(id, parentId);
    const handoff = (historyState: 'available' | 'uncertain' | 'unavailable') => {
      const origin = this.origins.get(id);
      this.callbacks.onChild?.({ thread, parentThreadId: parentId, history,
        notifications: reconcileCodexHistoryNotifications(history, id, this.buffered.get(id) ?? []), historyState,
        requiresRefresh: this.overflowed.delete(id), discoveryOrder: this.discoveryOrder.get(id)!,
        origin: origin?.parentThreadId === parentId ? origin : undefined });
    };
    if (!loaded && thread.ephemeral === true && (!Array.isArray(thread.turns) || !thread.turns.length)) {
      handoff('unavailable');
      return false;
    }
    try {
      for (let attempt = 0; ; attempt++) {
        const duringRead = (this.buffered.get(id) ?? []).filter(item => item.sequence > snapshotStart);
        if (!historyOverlapsNotifications(history, id, duringRead)) break;
        if (attempt === 2) throw new Error('Codex child history is changing during snapshot reads. Reopen the child to retry.');
        snapshotStart = this.notificationSequence;
        history = await transport.request('thread/read', { threadId: id, includeTurns: true });
        if (generation !== this.generation || !isRecord(history) || !isRecord(history.thread) || history.thread.id !== id || parentThreadId(history.thread) !== parentId) throw new Error('Codex child history is unavailable. Reopen the child to retry.');
        thread = history.thread;
      }
      if (generation !== this.generation) return false;
      handoff('available');
    } catch (error) {
      if (generation !== this.generation || this.closed) {
        if (this.children.get(id) === parentId) this.children.delete(id);
        return false;
      }
      handoff('uncertain');
      this.threads.add(id);
      throw error;
    }
    if (generation !== this.generation) return false;
    this.threads.add(id);
    this.inspectHistory(id, history);
    return true;
  }
}

export function notificationThreadId(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  const thread = isRecord(params.thread) ? params.thread : undefined;
  return readString(params.threadId) ?? (thread ? readString(thread.id) : undefined);
}

function parentThreadId(thread: Record<string, unknown>): string | undefined {
  if (readString(thread.parentThreadId)) return readString(thread.parentThreadId);
  if (!isRecord(thread.source) || !isRecord(thread.source.subAgent) || !isRecord(thread.source.subAgent.thread_spawn)) return undefined;
  return readString(thread.source.subAgent.thread_spawn.parent_thread_id);
}

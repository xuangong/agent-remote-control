import { CodexServerRequestCanceled, type CodexAppServerTransport } from './app-server-transport.js';
import { readCodexHistoryPage } from './history-page.js';
import { historyOverlapsNotifications } from './history.js';
import { initializeCodexTransport, type CodexInitialization } from './initialize.js';
import { isRecord, readString } from './native.js';
import { abortableDelay, normalizeRecoverySettings, permanentRecoveryReason, recoveryDelay, withDeadline,
  CodexRestorationSemaphore, type CodexRestorationScheduler, type CodexSharedRecoveryPlan } from './recovery.js';
import { CodexThreadRouter, notificationThreadId } from './thread-router.js';
import type { CodexConnectionInfo, CodexDaemonCallbacks, CodexRawNotification } from './types.js';

export interface CodexDaemonClientOptions {
  transport: CodexAppServerTransport;
  initialization: CodexInitialization;
  callbacks?: CodexDaemonCallbacks;
  recovery?: CodexSharedRecoveryPlan;
  paginatedHistory?: boolean;
  restorationScheduler?: CodexRestorationScheduler;
}

/** Owns a connection to Codex, never the lifetime of an external daemon. */
export class CodexDaemonClient {
  private transport: CodexAppServerTransport;
  private readonly callbacks: CodexDaemonCallbacks;
  private readonly router: CodexThreadRouter;
  private readonly restorationScheduler: CodexRestorationScheduler;
  private generation = 0;
  private closed = false;
  private recoveryTask: Promise<void> | undefined;
  private recoveryAbort: AbortController | undefined;
  private connection: CodexConnectionInfo | undefined;
  private restorationBuffer: Array<CodexRawNotification & { sequence: number }> | undefined;
  private restorationSequence = 0;
  private readonly pendingDispatches = new Map<string, AbortController>();

  constructor(private readonly options: CodexDaemonClientOptions) {
    this.transport = options.transport;
    this.callbacks = options.callbacks ?? {};
    this.router = new CodexThreadRouter(() => this.transport, this.callbacks, options.paginatedHistory);
    this.restorationScheduler = options.restorationScheduler ?? new CodexRestorationSemaphore();
    this.connection = options.recovery ? { state: 'connected' } : undefined;
    this.bindTransport(options.transport);
  }

  async initialize(): Promise<void> { await initializeCodexTransport(this.transport, this.options.initialization); }
  registerRoot(id: string): void { this.router.registerRoot(id); }
  hasThread(id: string): boolean { return this.router.hasThread(id); }
  hasChild(parentId: string, id: string): boolean { return this.router.hasChild(parentId, id); }
  waitForChild(parentId: string, id: string): Promise<void> { return this.router.waitForChild(parentId, id); }
  inspectHistory(threadId: string, history: unknown): void { this.router.inspectHistory(threadId, history); }
  connectionInfo(): CodexConnectionInfo | undefined { return this.connection ? { ...this.connection } : undefined; }

  assertConnected(): void {
    if (this.closed) throw new Error('Codex runtime is closed');
    if (!this.connection || this.connection.state === 'connected') return;
    throw new Error(`Codex shared runtime is ${this.connection.state}; wait for native recovery before retrying.`);
  }

  /** Sends once. A failed mutation can have an unknown native outcome and is never replayed. */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    this.assertConnected();
    return this.transport.request(method, params, timeoutMs);
  }

  private bindTransport(transport: CodexAppServerTransport): number {
    const generation = ++this.generation;
    this.transport = transport;
    transport.setNotificationHandler((method, params) => {
      if (generation === this.generation) this.routeNotification(method, params);
    });
    transport.setTerminationHandler(error => {
      if (generation === this.generation) this.handleTermination(error, generation);
    });
    for (const method of ['item/tool/call', 'item/tool/requestUserInput', 'tool/requestUserInput', 'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval', 'mcpServer/elicitation/request', 'item/permissions/requestApproval']) {
      transport.setRequestHandler(method, async (params, id) => {
        if (generation !== this.generation) throw new CodexServerRequestCanceled('Codex request belongs to an old connection');
        const threadId = isRecord(params) ? readString(params.threadId) : undefined;
        if (!threadId) throw new Error('Codex request belongs to an unavailable thread');
        const key = `${generation}:${threadId}:${id}`;
        const dispatch = new AbortController();
        this.pendingDispatches.set(key, dispatch);
        try {
          const available = this.router.hasThread(threadId) || await this.router.discover(threadId).catch(error => {
            if (this.router.hasThread(threadId)) return true;
            throw error;
          });
          if (dispatch.signal.aborted) throw dispatch.signal.reason;
          if (!available || !this.callbacks.onRequest) throw new Error('Codex request belongs to an unavailable thread');
          const response = this.callbacks.onRequest(method, params, id, { threadId, generation, signal: dispatch.signal });
          const value = await cancelableResponse(Promise.resolve(response), dispatch.signal);
          if (generation !== this.generation || dispatch.signal.aborted) throw new CodexServerRequestCanceled('Codex request belongs to an old connection');
          return value;
        } finally { this.pendingDispatches.delete(key); }
      });
    }
    return generation;
  }

  private routeNotification(method: string, params: unknown): void {
    if (this.closed) return;
    const id = notificationThreadId(params);
    if (id && method === 'serverRequest/resolved' && isRecord(params)) {
      this.pendingDispatches.get(`${this.generation}:${id}:${params.requestId}`)?.abort(new CodexServerRequestCanceled('Codex request already resolved'));
    }
    if (this.restorationBuffer) {
      this.restorationBuffer.push({ method, params, sequence: ++this.restorationSequence });
      return;
    }
    this.router.routeNotification(method, params);
  }

  private handleTermination(error: Error, generation: number): void {
    if (this.closed) return;
    if (!this.options.recovery) { this.terminate(error); return; }
    if (!this.retireGeneration(generation, 'connection_lost') || this.recoveryTask) return;
    this.recoveryAbort = new AbortController();
    this.recoveryTask = this.recover(this.recoveryAbort.signal).finally(() => {
      this.recoveryTask = undefined;
      this.recoveryAbort = undefined;
    });
  }

  private async recover(signal: AbortSignal): Promise<void> {
    if (!this.options.recovery) return;
    const settings = normalizeRecoverySettings(this.options.recovery.settings);
    let attempt = 0;
    while (!signal.aborted && !this.closed && (settings.maximumAttempts === undefined || attempt < settings.maximumAttempts)) {
      attempt += 1;
      const delay = recoveryDelay(settings, attempt);
      this.setConnection({ state: 'reconnecting', reason: 'connection_lost', attempt, nextRetryAt: Date.now() + delay });
      let connecting: Promise<CodexAppServerTransport> | undefined;
      let nextTransport: CodexAppServerTransport | undefined;
      let generation: number | undefined;
      try {
        await abortableDelay(delay, signal);
        connecting = this.options.recovery.connect();
        nextTransport = await withDeadline(connecting, settings.connectionDeadlineMs, signal, 'Codex shared connection');
        if (signal.aborted || this.closed) {
          await nextTransport.dispose();
          return;
        }
        this.setConnection({ state: 'restoring', reason: 'connection_lost', attempt });
        const activeGeneration = this.bindTransport(nextTransport);
        generation = activeGeneration;
        this.callbacks.onTransport?.(nextTransport, activeGeneration);
        await this.restorationScheduler.run(
          () => withDeadline(this.restore(activeGeneration), settings.restorationDeadlineMs, signal, 'Codex shared restoration'),
          signal,
        );
        if (activeGeneration !== this.generation || signal.aborted || this.closed) continue;
        this.setConnection({ state: 'connected' });
        return;
      } catch (error) {
        if (generation === undefined) this.restorationBuffer = undefined;
        else this.retireGeneration(generation, 'restoration_failed');
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

  private retireGeneration(generation: number, reason: string): boolean {
    if (generation !== this.generation) return false;
    this.generation += 1;
    this.restorationBuffer = undefined;
    this.router.invalidate();
    const prefix = `${generation}:`;
    for (const [key, dispatch] of this.pendingDispatches) {
      if (key.startsWith(prefix)) dispatch.abort(new CodexServerRequestCanceled('Codex request belongs to an old connection'));
    }
    this.callbacks.onInvalidated?.(reason, generation);
    return true;
  }

  private async restore(generation: number): Promise<void> {
    this.restorationBuffer = [];
    this.restorationSequence = 0;
    const transport = this.transport;
    await initializeCodexTransport(transport, this.options.initialization);
    if (generation !== this.generation) throw new Error('Codex shared restoration used a stale connection');
    const rootId = this.router.rootId;
    if (!rootId) throw new Error('Codex shared restoration has no native root');
    const attached = await transport.request('thread/resume', { threadId: rootId, excludeTurns: true });
    if (generation !== this.generation) throw new Error('Codex shared restoration used a stale connection');
    if (!isRecord(attached) || !isRecord(attached.thread) || attached.thread.id !== rootId) {
      throw new Error('Codex shared restoration could not attach the native root');
    }
    const snapshots = new Map<string, { value: unknown; sequence: number }>();
    for (const threadId of this.router.threads) {
      for (let attempt = 0; ; attempt += 1) {
        const sequence = this.restorationSequence;
        const value = this.options.paginatedHistory
          ? await readCodexHistoryPage(transport, threadId, { metadata: threadId === rootId ? attached : undefined })
          : await transport.request('thread/read', { threadId, includeTurns: true });
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
    for (const threadId of this.router.threads) {
      const snapshot = snapshots.get(threadId);
      if (!snapshot) continue;
      // Thread history cannot replace pending request state, even when a later read advances the timeline cutoff.
      this.callbacks.onSnapshot?.({ threadId, snapshot: snapshot.value, notifications: buffered.filter(item => notificationThreadId(item.params) === threadId
        && (item.method === 'serverRequest/resolved' || item.sequence > snapshot.sequence)) });
    }
    for (const item of buffered) {
      const threadId = notificationThreadId(item.params);
      if (!threadId || !snapshots.has(threadId)) this.routeNotification(item.method, item.params);
      else if (isRecord(item.params) && (item.method === 'item/started' || item.method === 'item/completed')) {
        this.router.inspectItem(threadId, readString(item.params.turnId), item.params.item);
      }
    }
    for (const [threadId, snapshot] of snapshots) this.router.inspectHistory(threadId, snapshot.value);
  }

  private setConnection(connection: CodexConnectionInfo): void {
    this.connection = connection;
    this.callbacks.onConnection?.({ ...connection });
  }

  terminate(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.recoveryAbort?.abort(new Error('Codex runtime is closed'));
    this.restorationBuffer = undefined;
    this.router.close();
    for (const dispatch of this.pendingDispatches.values()) dispatch.abort(new CodexServerRequestCanceled('Codex runtime is closed'));
    this.callbacks.onTermination?.(error);
  }

  async dispose(): Promise<void> {
    this.terminate(new Error('Codex runtime is closed'));
    await this.transport.dispose();
    await this.recoveryTask;
  }
}

async function cancelableResponse(response: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  let canceled: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    canceled = () => reject(signal.reason);
    if (signal.aborted) canceled();
    else signal.addEventListener('abort', canceled, { once: true });
  });
  try { return await Promise.race([response, cancellation]); }
  finally { if (canceled) signal.removeEventListener('abort', canceled); }
}

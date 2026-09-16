import { createHash, type Hash } from 'node:crypto';

import type {
  AgentCapabilities,
  AgentCommand,
  AgentCommandResult,
  AgentInteractionRequest,
  AgentInteractionResponse,
  AgentMessageOptions,
  AgentPersistenceHandle,
  AgentResourceReadResult,
  AgentRuntimeInfo,
  AgentSession,
  ProviderObservation,
  ProviderStreamItem,
} from '@agent-remote-controller/agent-provider-sdk';

import { isRecord, safeNonNegativeInteger, type DshNativeObservation } from './native.js';
import { DshGeneratedResourceReader } from './generated-resource.js';
import { DshProjector } from './projector.js';
import { validateDshInteractionResponse, type DshOwnedAgent } from './runtime.js';
import type { DshToolRegistry } from './tools.js';

class ObservationQueue implements AsyncIterableIterator<ProviderStreamItem> {
  private readonly values: ProviderStreamItem[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<ProviderStreamItem>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private failure: unknown;

  constructor(private readonly onReturn: () => Promise<void>) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<ProviderStreamItem> { return this; }

  next(): Promise<IteratorResult<ProviderStreamItem>> {
    const value = this.values.shift();
    if (value) return Promise.resolve({ value, done: false });
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async return(): Promise<IteratorResult<ProviderStreamItem>> {
    await this.onReturn();
    return { value: undefined, done: true };
  }

  push(value: ProviderStreamItem): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

export class LiveDshSession implements AgentSession {
  readonly capabilities: AgentCapabilities;
  private readonly projector: DshProjector;
  private readonly pending = new Map<string, AgentInteractionRequest>();
  private readonly buffered: DshNativeObservation[] = [];
  private readonly seen = new Map<string, string>();
  private queue: ObservationQueue | undefined;
  private unsubscribe: (() => void) | undefined;
  private tailCursor = -1;
  private observing = false;
  private state: 'idle' | 'hydrating' | 'live' | 'closing' | 'closed' = 'idle';
  private releasePromise: Promise<void> | undefined;
  private readonly generatedResourceReader: DshGeneratedResourceReader;

  constructor(
    private readonly agent: DshOwnedAgent,
    private readonly persistence: AgentPersistenceHandle,
    tools: DshToolRegistry,
  ) {
    this.generatedResourceReader = new DshGeneratedResourceReader(agent.sessionId, () => this.agent.events);
    this.projector = new DshProjector({
      sessionId: agent.sessionId,
      tools,
      runtimeInfo: () => ({
        providerId: this.persistence.providerId, sessionId: agent.sessionId,
        ...agent.runtimeInfo, persistence: this.persistence,
      }),
      referenceGeneratedResource: (locator, revisionKey) => (
        this.generatedResourceReader.reference(locator, revisionKey)
      ),
    });
    this.capabilities = {
      commands: agent.features.commands ?? false,
      history: true,
      sendMessage: true,
      queueMessage: true,
      steer: agent.features.steer,
      cancel: agent.features.cancel,
      readResource: agent.features.readResource,
      planning: agent.features.planning ?? false,
      sessionSettings: agent.features.sessionSettings ?? false,
      interactions: { ...agent.features.interactions },
    };
  }

  observe(): AsyncIterable<ProviderStreamItem> {
    if (this.observing) throw new Error('Live DSH sessions support one observation stream.');
    this.assertOpen();
    this.observing = true;
    this.state = 'hydrating';
    const queue = new ObservationQueue(() => this.dispose());
    this.queue = queue;
    try {
      this.unsubscribe = this.agent.subscribe((record) => this.receive(record));
      const history = [...this.agent.events];
      const tail = contiguousTail(history);
      if (tail.status === 'failed') {
        this.fail(tail.message);
        return queue;
      }
      this.tailCursor = tail.cursor;
      for (const record of history) this.emitRecord(record, 'history');
      queue.push({ type: 'history_boundary' });
      for (const record of this.buffered.splice(0)) this.receiveLive(record);
      if (this.state === 'hydrating') this.state = 'live';
    } catch (error) {
      this.fail(errorMessage(error));
    }
    return queue;
  }

  async sendMessage(text: string, options?: AgentMessageOptions): Promise<void> {
    this.assertOpen();
    if (!text.trim()) throw new Error('DSH message must not be empty.');
    if (options?.delivery !== 'next_turn' && this.agent.runtimeInfo.status === 'running') {
      if (!this.capabilities.steer) throw new Error('DSH immediate delivery requires native steering while running.');
      this.agent.steer(text);
      return;
    }
    this.agent.followup(text);
  }

  async steer(text: string): Promise<void> {
    this.assertOpen();
    if (!this.capabilities.steer) throw new Error('DSH steering is unsupported.');
    if (!text.trim()) throw new Error('DSH steering message must not be empty.');
    this.agent.steer(text);
  }

  async cancel(): Promise<void> {
    this.assertOpen();
    if (!this.capabilities.cancel || !this.agent.cancel()) throw new Error('DSH session cannot be canceled.');
  }

  async listCommands(): Promise<AgentCommand[]> {
    this.assertOpen();
    if (!this.capabilities.commands || !this.agent.listCommands) throw new Error('DSH commands are unsupported.');
    return this.agent.listCommands();
  }

  async executeCommand(id: string, args: string): Promise<AgentCommandResult> {
    this.assertOpen();
    if (!this.capabilities.commands || !this.agent.executeCommand) throw new Error('DSH commands are unsupported.');
    if (this.pending.size > 0) throw new Error('DSH commands cannot execute with pending interactions.');
    return this.agent.executeCommand(id, args);
  }

  async setSessionSetting(id: string, value: string): Promise<void> {
    this.assertOpen();
    if (!this.capabilities.sessionSettings || !this.agent.setSessionSetting) throw new Error('DSH session settings are unsupported.');
    if (this.pending.size > 0) throw new Error('DSH settings cannot change with pending interactions.');
    await this.agent.setSessionSetting(id, value);
  }

  async setPlanning(active: boolean): Promise<void> {
    this.assertOpen();
    if (!this.capabilities.planning || !this.agent.setPlanning) throw new Error('DSH planning control is unsupported.');
    if (this.pending.size > 0) throw new Error('DSH planning cannot change with pending interactions.');
    this.agent.setPlanning(active);
  }

  async respondToInteraction(requestId: string, response: AgentInteractionResponse): Promise<void> {
    this.assertOpen();
    const request = this.pending.get(requestId);
    if (!request) throw new Error(`No pending DSH interaction ${requestId}`);
    if (request.kind !== response.kind) {
      throw new Error(`DSH interaction ${requestId} requires a ${request.kind} response`);
    }
    validateDshInteractionResponse(request, response);
    if (!await this.agent.respondToInteraction(requestId, response)) {
      throw new Error(`No pending DSH interaction ${requestId}`);
    }
    this.pending.delete(requestId);
  }

  async readResource(locator: string): Promise<AgentResourceReadResult> {
    this.assertOpen();
    if (locator.startsWith('dsh-skill:')) return this.agent.readDocumentation?.(locator) ?? { status: 'unavailable', reason: 'DSH skill documentation is unsupported.' };
    const reference = this.projector.imageReference(locator);
    if (reference) {
      try {
        const stored = await this.agent.readImage(reference);
        return { status: 'available', bytes: stored.data, mediaType: stored.mediaType };
      } catch (error) {
        return { status: 'unavailable', reason: errorMessage(error) };
      }
    }
    if (locator.startsWith('dsh-attachment:')) {
      return { status: 'unavailable', reason: 'Resource is not an image attachment referenced by this DSH session.' };
    }
    return this.generatedResourceReader.read(locator);
  }

  stopGeneratedResourceReader(): void {
    this.generatedResourceReader.stop();
  }

  async runtimeInfo(): Promise<AgentRuntimeInfo> {
    await this.agent.loadSettings?.();
    return {
      providerId: this.persistence.providerId,
      sessionId: this.agent.sessionId,
      ...this.agent.runtimeInfo,
      persistence: this.persistence,
    };
  }

  dispose(): Promise<void> {
    if (this.releasePromise) return this.releasePromise;
    this.state = 'closing';
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.releasePromise = (async () => {
      let failure: unknown;
      if (!this.agent.borrowed) {
        try {
          await this.agent.flush();
        } catch (error) {
          failure = error;
        }
      }
      try {
        await this.agent.dispose();
      } catch (error) {
        failure ??= error;
      }
      this.state = 'closed';
      this.queue?.close();
      if (failure !== undefined) throw failure;
    })();
    return this.releasePromise;
  }

  private assertOpen(): void {
    if (this.state === 'closing') throw new Error('DSH session is closing.');
    if (this.state === 'closed') throw new Error('DSH session is closed.');
  }

  private receive(record: DshNativeObservation): void {
    if (this.state === 'hydrating') this.buffered.push(record);
    else if (this.state === 'live') this.receiveLive(record);
  }

  private receiveLive(record: DshNativeObservation): void {
    const key = recordIdentity(record);
    const fingerprint = stableFingerprint(record);
    const prior = this.seen.get(key);
    if (prior === fingerprint) return;
    const cursor = nativeCursor(record);
    if (record.kind === 'session_event') {
      if (cursor === undefined) {
        this.fail('Live DSH session event has no native sequence cursor.');
        return;
      }
      if (cursor <= this.tailCursor) {
        this.fail(`DSH event ${record.recordId} changed after its native sequence was observed.`);
        return;
      }
      if (cursor !== this.tailCursor + 1) {
        this.fail(`Live DSH sequence jumped from ${this.tailCursor} to ${cursor}.`);
        return;
      }
      this.tailCursor = cursor;
    }
    this.emitRecord(record, 'live');
  }

  private emitRecord(record: DshNativeObservation, delivery: 'history' | 'live'): void {
    const key = recordIdentity(record);
    const fingerprint = stableFingerprint(record);
    if (this.seen.get(key) === fingerprint) return;
    this.seen.set(key, fingerprint);
    for (const projected of this.projector.project(record)) {
      const observation: ProviderObservation = { ...projected, delivery };
      this.trackInteraction(observation);
      this.queue?.push(observation);
    }
  }

  private trackInteraction(observation: ProviderObservation): void {
    if (observation.event.type === 'interaction_requested') {
      this.pending.set(observation.event.request.requestId, observation.event.request);
    } else if (observation.event.type === 'interaction_resolved') {
      this.pending.delete(observation.event.requestId);
    }
  }

  private fail(message: string): void {
    if (this.state === 'closing' || this.state === 'closed') return;
    this.state = 'closing';
    this.queue?.fail(new Error(message));
    void this.dispose().catch(() => undefined);
  }
}

function recordIdentity(record: DshNativeObservation): string {
  return `${record.kind}:${record.recordId}`;
}

function nativeCursor(record: DshNativeObservation): number | undefined {
  if (record.kind !== 'session_event' || !isRecord(record.payload)) return undefined;
  return safeNonNegativeInteger(record.payload.seq);
}

function contiguousTail(history: readonly DshNativeObservation[]): { status: 'ok'; cursor: number } | { status: 'failed'; message: string } {
  let expected = 0;
  for (const record of history) {
    if (record.kind !== 'session_event') continue;
    const cursor = nativeCursor(record);
    if (cursor === undefined) return { status: 'failed', message: 'DSH history event has no native sequence cursor.' };
    if (cursor !== expected) return { status: 'failed', message: `DSH history sequence expected ${expected} but found ${cursor}.` };
    expected += 1;
  }
  return { status: 'ok', cursor: expected - 1 };
}

function stableFingerprint(value: unknown): string {
  const hash = createHash('sha256');
  updateStableHash(hash, value);
  return hash.digest('hex');
}

function updateStableHash(hash: Hash, value: unknown): void {
  if (Array.isArray(value)) {
    hash.update(`array:${value.length}[`);
    for (const entry of value) updateStableHash(hash, entry);
    hash.update(']');
    return;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    hash.update(`object:${entries.length}{`);
    for (const [key, entry] of entries) {
      hash.update(`key:${key.length}:`);
      hash.update(key);
      updateStableHash(hash, entry);
    }
    hash.update('}');
    return;
  }
  if (typeof value === 'string') {
    hash.update(`string:${value.length}:`);
    hash.update(value);
    return;
  }
  hash.update(`${typeof value}:${JSON.stringify(value) ?? ''};`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

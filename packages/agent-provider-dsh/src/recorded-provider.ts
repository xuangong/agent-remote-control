import type {
  AgentCapabilities,
  AgentInteractionResponse,
  AgentPersistenceHandle,
  AgentProviderAdapter,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  ProviderObservation,
  ProviderStreamItem,
} from '@borgee/agent-provider-sdk';

import { DshPlayback, type PlaybackClock, type PlaybackMode } from './playback.js';
import { DshProjector } from './projector.js';
import type { DshTrace } from './trace/schema.js';

const descriptor = { providerId: 'dsh-recorded', displayName: 'Recorded DSH trace' } as const;

const capabilities: AgentCapabilities = {
  history: true,
  sendMessage: false,
  steer: false,
  cancel: false,
  readResource: false,
  interactions: { question: false, planApproval: false, toolApproval: false },
};

const realtimeClock: PlaybackClock = {
  wait(milliseconds, cancellation): Promise<void> {
    return new Promise((resolve) => {
      const timers = globalThis as unknown as {
        setTimeout(callback: () => void, delay: number): unknown;
        clearTimeout(handle: unknown): void;
      };
      const timer = timers.setTimeout(resolve, milliseconds);
      void cancellation.whenCancelled().then(() => {
        timers.clearTimeout(timer);
        resolve();
      });
    });
  },
};

export interface RecordedDshSession extends AgentSession {
  advancePlayback(): void;
}

export interface RecordedDshProvider extends AgentProviderAdapter {
  createSession(config: AgentSessionConfig): Promise<RecordedDshSession>;
  resumeSession(handle: AgentPersistenceHandle): Promise<RecordedDshSession>;
}

export function createRecordedDshProvider(options: {
  trace: DshTrace;
  mode: PlaybackMode;
  clock?: PlaybackClock;
}): RecordedDshProvider {
  return new RecordedProvider(options.trace, options.mode, options.clock ?? realtimeClock);
}

class RecordedProvider implements RecordedDshProvider {
  readonly descriptor = descriptor;
  private readonly persistence: AgentPersistenceHandle;

  constructor(
    private readonly trace: DshTrace,
    private readonly mode: PlaybackMode,
    private readonly clock: PlaybackClock,
  ) {
    this.persistence = {
      providerId: descriptor.providerId,
      sessionId: trace.header.sessionId,
      opaque: `dsh-trace:${trace.header.sessionId}`,
    };
  }

  async createSession(config: AgentSessionConfig): Promise<RecordedDshSession> {
    if (config.sessionId !== this.trace.header.sessionId) {
      throw new Error('Recorded DSH trace session identity does not match the request.');
    }
    return new RecordedSession(this.trace, this.mode, this.clock, this.persistence);
  }

  async resumeSession(handle: AgentPersistenceHandle): Promise<RecordedDshSession> {
    if (handle.providerId !== descriptor.providerId
      || handle.sessionId !== this.persistence.sessionId
      || handle.opaque !== this.persistence.opaque) {
      throw new Error('Recorded DSH trace persistence handle does not match this Provider.');
    }
    return new RecordedSession(this.trace, this.mode, this.clock, this.persistence);
  }
}

class RecordedSession implements RecordedDshSession {
  readonly capabilities = capabilities;
  private readonly playback: DshPlayback;
  private observed = false;

  constructor(
    private readonly trace: DshTrace,
    mode: PlaybackMode,
    clock: PlaybackClock,
    private readonly persistence: AgentPersistenceHandle,
  ) {
    this.playback = new DshPlayback(trace.records, mode, clock);
  }

  observe(): AsyncIterable<ProviderStreamItem> {
    if (this.observed) throw new Error('Recorded DSH sessions support one observation stream.');
    this.observed = true;
    return this.stream();
  }

  async sendMessage(_text: string): Promise<void> {
    throw new Error('Message submission is unsupported by a recorded DSH trace.');
  }

  async respondToInteraction(_requestId: string, _response: AgentInteractionResponse): Promise<void> {
    throw new Error('Interaction responses are unsupported by a recorded DSH trace.');
  }

  async runtimeInfo(): Promise<AgentRuntimeInfo> {
    const runtime = this.trace.header.runtimeInfo;
    return {
      providerId: descriptor.providerId,
      sessionId: this.trace.header.sessionId,
      status: runtime.status === 'stopped' ? 'closed' : runtime.status,
      ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
      model: runtime.model?.id ?? null,
      persistence: this.persistence,
    };
  }

  async dispose(): Promise<void> { this.playback.cancel(); }

  advancePlayback(): void { this.playback.advance(); }

  private async *stream(): AsyncGenerator<ProviderStreamItem> {
    yield { type: 'history_boundary' };
    const projector = new DshProjector({ sessionId: this.trace.header.sessionId, tools: { get: () => undefined } });
    const seen = new Set<string>();
    for await (const record of this.playback.recordsInOrder()) {
      const observations = projector.project({
        recordId: record.recordId,
        occurredAt: record.offset,
        kind: record.kind,
        payload: record.payload,
      });
      for (const observation of observations) {
        if (seen.has(observation.sourceKey)) continue;
        seen.add(observation.sourceKey);
        yield asLive(observation);
      }
    }
    if (this.playback.cancelled) return;
    const occurredAt = this.trace.records.at(-1)?.offset ?? 0;
    for (const observation of projector.close('completed', occurredAt)) {
      if (seen.has(observation.sourceKey)) continue;
      seen.add(observation.sourceKey);
      yield asLive(observation);
    }
  }
}

function asLive(observation: ProviderObservation): ProviderObservation {
  return { ...observation, delivery: 'live' };
}

export type { PlaybackClock, PlaybackMode } from './playback.js';

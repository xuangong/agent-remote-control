import type { DshTraceNativeRecord } from './trace/schema.js';

export type PlaybackMode =
  | { kind: 'immediate' }
  | { kind: 'realtime'; speed: number }
  | { kind: 'manual' };

export interface PlaybackCancellation {
  readonly cancelled: boolean;
  whenCancelled(): Promise<void>;
}

export interface PlaybackClock {
  wait(delay: number, cancellation: PlaybackCancellation): Promise<void>;
}

export class DshPlayback {
  private permits = 0;
  private resolveAdvance: (() => void) | undefined;
  private activeCancellation: PlaybackCancellationSource | undefined;
  private wasCancelled = false;

  constructor(
    private readonly records: readonly DshTraceNativeRecord[],
    private readonly mode: PlaybackMode,
    private readonly clock: PlaybackClock,
  ) {
    if (mode.kind === 'realtime' && (!Number.isFinite(mode.speed) || mode.speed <= 0)) {
      throw new Error('Realtime playback speed must be a positive finite number.');
    }
  }

  recordsInOrder(): AsyncIterable<DshTraceNativeRecord> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<DshTraceNativeRecord> => {
        const cancellation = new PlaybackCancellationSource();
        this.activeCancellation = cancellation;
        const iterator = this.iterate(cancellation);
        return {
          next: () => iterator.next(),
          return: async () => {
            this.cancel();
            return iterator.return(undefined);
          },
        };
      },
    };
  }

  advance(): void {
    if (this.mode.kind !== 'manual') return;
    const resolve = this.resolveAdvance;
    this.resolveAdvance = undefined;
    if (resolve) {
      resolve();
      return;
    }
    this.permits += 1;
  }

  cancel(): void {
    this.wasCancelled = true;
    this.activeCancellation?.cancel();
  }

  get cancelled(): boolean {
    return this.wasCancelled || this.activeCancellation?.cancelled === true;
  }

  private async *iterate(cancellation: PlaybackCancellation): AsyncGenerator<DshTraceNativeRecord> {
    try {
      let previousOffset = 0;
      for (const record of this.records) {
        if (!await this.beforeRecord(record.offset - previousOffset, cancellation)) return;
        previousOffset = record.offset;
        yield record;
      }
    } finally {
      if (this.activeCancellation === cancellation) this.activeCancellation = undefined;
    }
  }

  private async beforeRecord(offset: number, cancellation: PlaybackCancellation): Promise<boolean> {
    if (this.mode.kind === 'immediate') return !cancellation.cancelled;
    if (this.mode.kind === 'manual') return this.waitForAdvance(cancellation);
    await Promise.race([this.clock.wait(offset / this.mode.speed, cancellation), cancellation.whenCancelled()]);
    return !cancellation.cancelled;
  }

  private waitForAdvance(cancellation: PlaybackCancellation): Promise<boolean> {
    if (this.permits > 0) {
      this.permits -= 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (advanced: boolean): void => {
        if (settled) return;
        settled = true;
        if (this.resolveAdvance === advance) this.resolveAdvance = undefined;
        resolve(advanced);
      };
      const advance = (): void => finish(true);
      void cancellation.whenCancelled().then(() => finish(false));
      if (cancellation.cancelled) {
        finish(false);
        return;
      }
      this.resolveAdvance = advance;
    });
  }
}

class PlaybackCancellationSource implements PlaybackCancellation {
  private resolveCancellation: (() => void) | undefined;
  private readonly promise = new Promise<void>((resolve) => {
    this.resolveCancellation = resolve;
  });
  cancelled = false;

  whenCancelled(): Promise<void> {
    return this.promise;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.resolveCancellation?.();
  }
}

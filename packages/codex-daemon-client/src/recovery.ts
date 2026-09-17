import { CodexAppServerRpcError, type CodexAppServerTransport } from './app-server-transport.js';

export interface CodexSharedRecoverySettings {
  initialDelayMs?: number;
  maximumDelayMs?: number;
  maximumAttempts?: number;
  connectionDeadlineMs?: number;
  restorationDeadlineMs?: number;
  jitter?: () => number;
}

export interface CodexSharedRecoveryPlan {
  connect(): Promise<CodexAppServerTransport>;
  settings?: CodexSharedRecoverySettings;
}

export interface NormalizedRecoverySettings {
  initialDelayMs: number;
  maximumDelayMs: number;
  maximumAttempts: number | undefined;
  connectionDeadlineMs: number;
  restorationDeadlineMs: number;
  jitter(): number;
}

export function normalizeRecoverySettings(settings: CodexSharedRecoverySettings = {}): NormalizedRecoverySettings {
  return {
    initialDelayMs: positive(settings.initialDelayMs, 500),
    maximumDelayMs: positive(settings.maximumDelayMs, 30_000),
    maximumAttempts: positiveInteger(settings.maximumAttempts),
    connectionDeadlineMs: positive(settings.connectionDeadlineMs, 10_000),
    restorationDeadlineMs: positive(settings.restorationDeadlineMs, 30_000),
    jitter: settings.jitter ?? Math.random,
  };
}

export function recoveryDelay(settings: NormalizedRecoverySettings, attempt: number): number {
  const ceiling = Math.min(settings.maximumDelayMs, settings.initialDelayMs * (2 ** Math.max(0, attempt - 1)));
  const factor = Math.max(0, Math.min(1, settings.jitter()));
  return Math.max(1, Math.round(ceiling * (0.5 + factor * 0.5)));
}

export async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      signal.removeEventListener('abort', canceled);
      resolve();
    }
    function canceled(): void {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', canceled, { once: true });
  });
}

export async function withDeadline<T>(operation: Promise<T>, milliseconds: number, signal: AbortSignal, label: string): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let timer: NodeJS.Timeout | undefined;
  let cancel: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded its deadline`)), milliseconds);
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) signal.removeEventListener('abort', cancel);
  }
}

export type PermanentRecoveryReason = 'permission_denied' | 'protocol_incompatible' | 'thread_unavailable';

export function permanentRecoveryReason(error: unknown): PermanentRecoveryReason | undefined {
  if (error instanceof CodexAppServerRpcError) {
    if (error.code === -32601) return 'protocol_incompatible';
    if ((error.code === -32600 || error.code === -32602) && /thread|session|rollout/i.test(error.message)
      && /missing|not found|no .*found|does not exist|unknown|unavailable/i.test(error.message)) {
      return 'thread_unavailable';
    }
    if (error.code === -32001 || error.code === 401 || error.code === 403) return 'permission_denied';
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/permission denied|forbidden|unauthori[sz]ed/i.test(message)) return 'permission_denied';
  return undefined;
}

export interface CodexRestorationScheduler {
  run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T>;
}

/** Share an instance to cap simultaneous root restorations across clients. */
export class CodexRestorationSemaphore implements CodexRestorationScheduler {
  constructor(private readonly concurrency = 4) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Restoration concurrency must be a positive integer');
  }
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  async run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    while (this.active >= this.concurrency) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          signal.removeEventListener('abort', canceled);
          resolve();
        };
        const canceled = () => {
          const index = this.waiters.indexOf(ready);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal.reason);
        };
        this.waiters.push(ready);
        signal.addEventListener('abort', canceled, { once: true });
      });
    }
    if (signal.aborted) throw signal.reason;
    this.active += 1;
  }
}



function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

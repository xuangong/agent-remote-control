import { TunnelError } from './errors.js';

type WaitingRequest = { start(): void; reject(error: Error): void };

/** Bound HTTP work for the entire tunnel, including response bodies, not just headers. */
export class PreviewHttpAdmission {
  private active = 0;
  private closed = false;
  private readonly waiting = new Set<WaitingRequest>();
  constructor(private readonly concurrency = 8, private readonly maxWaiting = 512, private readonly waitTimeoutMs = 30_000) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.closed) return Promise.reject(new TunnelError('closed', 'Tunnel connection is closed.'));
    if (signal?.aborted) return Promise.reject(new TunnelError('cancelled', 'Preview request was cancelled.'));
    if (this.active < this.concurrency) return Promise.resolve(this.reserve());
    if (this.waiting.size >= this.maxWaiting) return Promise.reject(new TunnelError('capacity', 'Preview request queue is full.'));
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.waiting.delete(waiter); };
      const waiter: WaitingRequest = {
        start: () => { cleanup(); resolve(this.reserve()); },
        reject: error => { cleanup(); reject(error); },
      };
      const abort = () => waiter.reject(new TunnelError('cancelled', 'Preview request was cancelled.'));
      const timer = setTimeout(() => waiter.reject(new TunnelError('timeout', 'Preview request queue timed out.')), this.waitTimeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      this.waiting.add(waiter);
    });
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiting) waiter.reject(new TunnelError('closed', 'Tunnel connection is closed.'));
  }

  private reserve(): () => void {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      if (!this.closed) this.waiting.values().next().value?.start();
    };
  }
}

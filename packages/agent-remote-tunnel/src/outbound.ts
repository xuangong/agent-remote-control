import { encodeTunnelFrame, type TunnelFrame } from './codec.js';
import { TunnelError } from './errors.js';
import type { TunnelData, TunnelSocket } from './types.js';

type PendingFrame = {
  data: TunnelData; bytes: number;
  resolve(): void; reject(error: Error): void;
  cleanup(): void;
};

/** Schedules payloads by writable bytes, reserving transport capacity for control frames. */
export class TunnelOutbound {
  private readonly controls: PendingFrame[] = [];
  private readonly payloads: PendingFrame[] = [];
  private readonly sending = new Set<PendingFrame>();
  private controlBytes = 0;
  private sendingBytes = 0;
  private failure?: Error;
  private polling?: ReturnType<typeof setTimeout>;
  private draining = false;
  private readonly payloadLimit: number;

  constructor(private readonly socket: TunnelSocket, private readonly maxFrameBytes: number,
    private readonly maxQueuedBytes: number, private readonly failed: (error: Error) => void) {
    this.payloadLimit = Math.max(maxFrameBytes, maxQueuedBytes - Math.min(64 * 1024, Math.floor(maxQueuedBytes / 4)));
  }

  control(frame: TunnelFrame, signal?: AbortSignal): void {
    if (signal?.aborted) return;
    if (this.failure) throw this.failure;
    const encoded = this.encode(frame);
    if (this.controlBytes + encoded.bytes > this.maxQueuedBytes) throw new TunnelError('backpressure', 'Tunnel control queue is full.');
    this.controlBytes += encoded.bytes;
    const item: PendingFrame = { ...encoded, resolve() {}, reject() {}, cleanup: () => signal?.removeEventListener('abort', abort) };
    const abort = () => {
      const index = this.controls.indexOf(item);
      if (index >= 0) { this.controls.splice(index, 1); this.controlBytes -= item.bytes; }
      item.cleanup(); this.drain();
    };
    signal?.addEventListener('abort', abort, { once: true });
    this.controls.push(item);
    this.drain();
  }

  payload(frame: TunnelFrame, signal: AbortSignal): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (signal.aborted) return Promise.reject(new TunnelError('cancelled', 'Tunnel stream ended.'));
    const encoded = this.encode(frame);
    return new Promise((resolve, reject) => {
      const item: PendingFrame = { ...encoded, resolve, reject, cleanup: () => signal.removeEventListener('abort', abort) };
      const abort = () => {
        const index = this.payloads.indexOf(item);
        if (index >= 0) this.payloads.splice(index, 1);
        item.cleanup(); reject(new TunnelError('cancelled', 'Tunnel stream ended.')); this.drain();
      };
      signal.addEventListener('abort', abort, { once: true });
      this.payloads.push(item); this.drain();
    });
  }

  close(error: Error = new TunnelError('closed', 'Tunnel connection is closed.')): void {
    if (this.failure) return;
    this.failure = error; clearTimeout(this.polling); this.polling = undefined;
    for (const item of [...this.controls, ...this.payloads, ...this.sending]) { item.cleanup(); item.reject(error); }
    this.controls.length = 0; this.payloads.length = 0; this.controlBytes = 0;
    this.sending.clear(); this.sendingBytes = 0;
  }

  private encode(frame: TunnelFrame) {
    const data = encodeTunnelFrame(frame, this.maxFrameBytes);
    return { data, bytes: typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength };
  }

  private drain(): void {
    if (this.draining || this.failure) return;
    this.draining = true;
    try {
      while (this.controls.length || this.payloads.length) {
        const control = this.controls.length > 0;
        const item = (control ? this.controls : this.payloads)[0]!;
        const buffered = Math.max(this.sendingBytes, this.socket.bufferedAmount ?? 0);
        if (buffered + item.bytes > (control ? this.maxQueuedBytes : this.payloadLimit)) {
          // Promise-based transports wake on completion. Poll only when the runtime
          // still reports buffered bytes without any outstanding send callbacks.
          if (!this.sending.size && !this.polling) {
            this.polling = setTimeout(() => { this.polling = undefined; this.drain(); }, 10);
            this.polling.unref?.();
          }
          break;
        }
        (control ? this.controls : this.payloads).shift();
        if (control) this.controlBytes -= item.bytes;
        this.sending.add(item); this.sendingBytes += item.bytes;
        try {
          const sent = this.socket.send(item.data);
          void Promise.resolve(sent).then(() => this.complete(item), error => this.complete(item, error instanceof Error ? error : new Error('Tunnel send failed.')));
        } catch (error) { this.complete(item, error instanceof Error ? error : new Error('Tunnel send failed.')); break; }
      }
    } finally { this.draining = false; }
    if (!this.controls.length && !this.payloads.length) { clearTimeout(this.polling); this.polling = undefined; }
  }

  private complete(item: PendingFrame, error?: Error): void {
    if (!this.sending.delete(item)) return;
    this.sendingBytes -= item.bytes; item.cleanup();
    if (error) {
      item.reject(error);
      if (!this.failure) { this.close(error); this.failed(error); }
    } else { item.resolve(); this.drain(); }
  }
}

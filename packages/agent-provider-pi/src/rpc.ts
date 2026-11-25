import { randomUUID } from 'node:crypto';
import { DeadlineError } from './channel.js';
import { isRecord, str, type Json } from './native.js';
import type { PiChannel, PiExit } from './process.js';

/** pi refused a command: its response said success false. */
export class PiRequestError extends Error {
  constructor(readonly command: string, message: string) { super(message); this.name = 'PiRequestError'; }
}
/** The process ended while a command waited for its response. */
export class PiClosedError extends Error {
  constructor(readonly exit?: PiExit) { super('The pi process has ended.'); this.name = 'PiClosedError'; }
}

interface Waiting { command: string; resolve(data: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

/**
 * Commands and responses over one channel, matched by id; every other record is an event or an extension UI request. A command that
 * times out is not retried: its effect is unknown and the caller decides.
 */
export class PiRpc {
  private readonly waiting = new Map<string, Waiting>();
  private exit: PiExit | undefined;
  private closed = false;
  constructor(private readonly channel: PiChannel, private readonly timeoutMs: number,
    private readonly handlers: { event(event: Json): void; ui(request: Json): void; exit(exit: PiExit): void }) {
    channel.onMessage(message => this.receive(message));
    channel.onExit(exit => {
      this.exit = exit; this.closed = true;
      for (const [id, entry] of this.waiting) { clearTimeout(entry.timer); this.waiting.delete(id); entry.reject(new PiClosedError(exit)); }
      handlers.exit(exit);
    });
  }
  get isClosed(): boolean { return this.closed; }
  private receive(message: Json): void {
    if (message.type === 'response') {
      const id = str(message.id);
      const entry = id ? this.waiting.get(id) : undefined;
      if (!id || !entry) return;
      this.waiting.delete(id); clearTimeout(entry.timer);
      if (message.success === false) entry.reject(new PiRequestError(entry.command, str(message.error) ?? `pi refused ${entry.command}.`));
      else entry.resolve(message.data);
    } else if (message.type === 'extension_ui_request') this.handlers.ui(message);
    else this.handlers.event(message);
  }
  /** Sends a command and resolves with its response data. */
  request<T = Json>(type: string, params: Json = {}, timeoutMs = this.timeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(new PiClosedError(this.exit));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new DeadlineError(`pi ${type} timed out.`)); }, timeoutMs);
      timer.unref?.();
      this.waiting.set(id, { command: type, resolve: data => resolve((isRecord(data) ? data : data ?? {}) as T), reject, timer });
      try { this.channel.send({ id, type, ...params }); }
      catch (error) { this.waiting.delete(id); clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  /** Answers an extension UI request; nothing comes back. */
  answerUi(id: string, answer: { value: string } | { cancelled: true }): void {
    if (!this.closed) this.channel.send({ type: 'extension_ui_response', id, ...answer });
  }
  stop(): Promise<void> { return this.channel.stop(); }
}

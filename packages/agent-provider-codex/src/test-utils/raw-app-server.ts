import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { providerInitialization } from '../initialize.js';
import { spawnCodexAppServer } from '../native.js';

export interface RawMessage { method: string; params: any }

type ServerRequestHandler = (message: { id: number | string; method: string; params: any }) => unknown;

/**
 * A bare JSON-RPC client of `codex app-server`: no adapter in between, so a test sees the notifications and the history
 * pages exactly as the native runtime writes them.
 */
export class RawAppServer {
  readonly notifications: RawMessage[] = [];
  readonly serverRequests: RawMessage[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private next = 1;
  private waiters: Array<() => void> = [];

  constructor(executable: string, cwd: string, env: Record<string, string>, private readonly onServerRequest: ServerRequestHandler = () => ({})) {
    this.child = spawnCodexAppServer({ executable, cwd, env });
    createInterface({ input: this.child.stdout }).on('line', line => this.read(line));
    this.child.stderr.resume();
  }

  private read(line: string): void {
    if (!line.trim()) return;
    const message = JSON.parse(line) as { id?: number | string; method?: string; params?: any; result?: any; error?: { message?: string } };
    if (message.method && message.id !== undefined) {
      this.serverRequests.push({ method: message.method, params: message.params });
      Promise.resolve(this.onServerRequest({ id: message.id, method: message.method, params: message.params }))
        .then(result => this.send({ id: message.id, result }), error => this.send({ id: message.id, error: { code: -32000, message: String(error) } }));
    } else if (message.method) {
      this.notifications.push({ method: message.method, params: message.params });
    } else if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error.message ?? 'Codex request failed'));
      else pending?.resolve(message.result);
    }
    const waiters = this.waiters; this.waiters = [];
    for (const wake of waiters) wake();
  }

  private send(message: unknown): void { this.child.stdin.write(`${JSON.stringify(message)}\n`); }

  request(method: string, params: unknown): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', providerInitialization);
    this.send({ method: 'initialized', params: {} });
  }

  /** Waits until a notification of `method` matches, from the start of the log or from `from`. */
  async until(method: string, matches: (params: any) => boolean = () => true, from = 0, timeoutMs = 30_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const at = this.notifications.findIndex((entry, index) => index >= from && entry.method === method && matches(entry.params));
      if (at >= 0) return at;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${method}; saw ${this.notifications.slice(from).map(entry => entry.method).join(', ')}`);
      await new Promise<void>(resolve => { this.waiters.push(resolve); setTimeout(resolve, 200); });
    }
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    // The app-server leaves when its input ends; a test never kills a process.
    await new Promise<void>(resolve => { this.child.once('exit', () => resolve()); setTimeout(resolve, 5_000).unref(); });
  }
}

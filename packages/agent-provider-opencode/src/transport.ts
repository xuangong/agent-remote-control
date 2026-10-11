import { OpenCode, type OpenCodeClient, type V2Event } from '@opencode/client';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export interface OpenCodeAgentProviderOptions {
  serverUrl?: string;
  /** Private rendezvous shared with the explicitly installed native callback plugin. */
  callbackConfigPath?: string;
  username?: string;
  password?: string;
  requestTimeoutMs?: number;
  restrictedNative?: boolean;
  onDiagnostic?: (line: string) => void;
}
export class OpenCodeRequestError extends Error {
  constructor(readonly status?: number, readonly nativeCode?: string, message?: string) {
    super(message ?? (status ? `OpenCode request failed (HTTP ${status}).` : 'OpenCode request did not complete. Its outcome may be unknown; input was not replayed.'));
    this.name = 'OpenCodeRequestError';
  }
}
interface EventSubscriber { connected(): void; disconnected(attempt: number): void; receive(event: V2Event): void; }
export class OpenCodeTransport {
  readonly client: OpenCodeClient;
  readonly namespaceId: string;
  readonly timeout: number;
  readonly restricted: boolean;
  readonly local: boolean;
  private readonly lifetime = new AbortController();
  private readonly subscribers = new Set<EventSubscriber>();
  private eventAbort?: AbortController;
  private eventTask?: Promise<void>;
  private eventConnected = false;
  constructor(private readonly options: OpenCodeAgentProviderOptions) {
    const url = new URL(options.serverUrl ?? 'http://127.0.0.1:4096');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid OpenCode server URL. Configure credentials separately.');
    this.namespaceId = createHash('sha256').update(url.toString()).digest('hex');
    this.local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    this.timeout = options.requestTimeoutMs ?? 15000;
    if (!Number.isFinite(this.timeout) || this.timeout < 1 || this.timeout > 120000) throw new Error('Invalid OpenCode request timeout.');
    this.restricted = options.restrictedNative === true;
    this.client = OpenCode.make({
      baseUrl: url.toString().replace(/\/$/, ''),
      headers: options.password === undefined ? undefined : { Authorization: `Basic ${Buffer.from(`${options.username ?? 'opencode'}:${options.password}`).toString('base64')}` },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const stream = new URL(request.url).pathname.endsWith('/api/event');
        const signal = AbortSignal.any([request.signal, this.lifetime.signal, ...(stream ? [] : [AbortSignal.timeout(this.timeout)])]);
        return fetch(new Request(request, { signal, redirect: 'error' }));
      },
    });
  }
  async request<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof OpenCodeRequestError) throw error;
      const native = error as { _tag?: string; message?: string; cause?: { status?: number } };
      const codes: Record<string, number> = { InvalidRequestError: 400, UnauthorizedError: 401, ForbiddenError: 403,
        SessionNotFoundError: 404, MessageNotFoundError: 404, PermissionNotFoundError: 404, FormNotFoundError: 404,
        SessionBusyError: 409, ConflictError: 409, FormAlreadySettledError: 409, FormInvalidAnswerError: 400 };
      const code = typeof native?._tag === 'string' ? native._tag : undefined;
      throw new OpenCodeRequestError(code ? codes[code] : native?.cause?.status, code,
        code && typeof native.message === 'string' ? native.message : undefined);
    }
  }
  diagnostic(message: string): void { try { this.options.onDiagnostic?.(message); } catch { /* Diagnostics cannot interrupt native observation. */ } }
  events(signal: AbortSignal, connected: () => void, disconnected: (attempt: number) => void, receive: (event: V2Event) => void): Promise<void> {
    if (signal.aborted || this.lifetime.signal.aborted) return Promise.resolve();
    return new Promise<void>(resolve => {
      const subscriber = { connected, disconnected, receive };
      const remove = () => {
        signal.removeEventListener('abort', remove); this.lifetime.signal.removeEventListener('abort', remove);
        this.subscribers.delete(subscriber);
        if (this.subscribers.size === 0) { this.eventConnected = false; this.eventAbort?.abort(); }
        resolve();
      };
      signal.addEventListener('abort', remove, { once: true });
      this.lifetime.signal.addEventListener('abort', remove, { once: true });
      this.subscribers.add(subscriber);
      if (this.eventConnected) connected();
      this.ensureEvents();
    });
  }
  private ensureEvents(): void {
    if (this.eventTask || this.lifetime.signal.aborted || this.subscribers.size === 0) return;
    const controller = new AbortController(); this.eventAbort = controller;
    this.eventTask = this.consumeEvents(controller.signal).finally(() => {
      this.eventTask = undefined; this.eventAbort = undefined; this.eventConnected = false;
      this.ensureEvents();
    });
  }
  private broadcast(action: (subscriber: EventSubscriber) => void): void {
    for (const subscriber of this.subscribers) {
      try { action(subscriber); } catch { this.diagnostic('OpenCode event subscriber rejected a native event.'); }
    }
  }
  private async consumeEvents(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted && !this.lifetime.signal.aborted) {
      const connection = new AbortController();
      const combined = AbortSignal.any([signal, this.lifetime.signal, connection.signal]);
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const arm = (ms: number) => { clearTimeout(watchdog); watchdog = setTimeout(() => connection.abort(), ms); watchdog.unref(); };
      let ready = false;
      try {
        arm(this.timeout);
        const events = this.client.event.subscribe({ signal: combined, onActivity: () => arm(45000) });
        for await (const event of events) {
          if (combined.aborted) break;
          arm(45000);
          if (!ready) { ready = true; attempt = 0; this.eventConnected = true; this.broadcast(subscriber => subscriber.connected()); }
          this.broadcast(subscriber => subscriber.receive(event));
        }
      } catch { this.diagnostic('OpenCode event connection interrupted; reconciling native state on reconnect.'); }
      finally { clearTimeout(watchdog); connection.abort(); }
      if (signal.aborted || this.lifetime.signal.aborted) break;
      this.eventConnected = false;
      this.broadcast(subscriber => subscriber.disconnected(attempt + 1));
      attempt++;
      await delay(Math.min(200 * 2 ** Math.min(attempt - 1, 5), 5000), undefined, { signal: AbortSignal.any([signal, this.lifetime.signal]) }).catch(() => undefined);
    }
  }
  async close(): Promise<void> { this.lifetime.abort(); this.eventAbort?.abort(); await this.eventTask; }
}

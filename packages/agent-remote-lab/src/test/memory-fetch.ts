/**
 * Test support: the Relay's HTTP answers without a listener. `stubMemoryFetch(handler)` replaces the global `fetch`, which the
 * clients bind when they are created, so call it before mounting. The handler sees each request as a server would (its method, its
 * path with the query, its headers, its body) and answers with JSON, with 'lost' (the reply never arrives and the call fails as a dropped
 * connection does) or with 'hang' (a long poll that ends only when the caller aborts it). `vi.unstubAllGlobals()` restores `fetch`.
 */
import { vi } from 'vitest';

export interface MemoryRequest { readonly method: string; readonly path: string; readonly body: string; readonly headers: Headers; readonly signal: AbortSignal | undefined }
export type MemoryReply = { readonly status?: number; readonly json?: unknown } | 'lost' | 'hang';

export function stubMemoryFetch(handler: (request: MemoryRequest) => MemoryReply | Promise<MemoryReply>): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const signal = init?.signal ?? request?.signal ?? undefined;
    const body = typeof init?.body === 'string' ? init.body : request ? await request.text() : '';
    const headers = new Headers(init?.headers ?? request?.headers);
    const reply = await handler({ method: (init?.method ?? request?.method ?? 'GET').toUpperCase(), path: url.pathname + url.search, body, headers, signal });
    if (reply === 'lost') throw new TypeError('fetch failed');
    if (reply === 'hang') return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) reject(signal.reason);
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return Response.json(reply.json ?? {}, { status: reply.status ?? 200 });
  });
}

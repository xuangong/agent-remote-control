import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { Duplex, Readable } from 'node:stream';

import { WebSocket, type ClientOptions } from 'ws';

/**
 * A Node `http.Server` reached without a listener: `fetch` and a WebSocket client whose bytes travel over in-memory socket pairs
 * handed to the server's own `connection` event. The server parses real HTTP, runs its `request` and `upgrade` handlers and frames
 * WebSocket messages with `ws` exactly as on a port, so a test that does not check the socket itself loses none of the server's
 * behaviour: headers, status codes, upgrade authorization, close codes and frame order stay the server's.
 *
 * Contract. `memoryHttp(server)` returns `fetch` (a fetch-shaped call: a string, URL or `Request`; the host in the URL is ignored),
 * `webSocket(url, options)` (a `ws` client; its `ClientOptions`, such as `origin` and `headers`, reach the server's upgrade handler) and `WebSocket`
 * (the same as a constructor for a client that takes one, e.g. `HttpWebSocketTransport`'s `WebSocket` option). `url` is a base URL
 * to give clients that need one. Each call opens its own pair, so a connection closes when its request ends. `close()` destroys
 * every pair still open (a server's `close()` does not wait for them). A lost network is `socket.terminate()` on the client.
 */
export interface MemoryHttp {
  readonly url: string;
  readonly fetch: typeof fetch;
  webSocket(url: string | URL, options?: ClientOptions): WebSocket;
  readonly WebSocket: new (url: string | URL, protocols?: string | string[], options?: object) => WebSocket;
  close(): void;
}

class MemorySocket extends Duplex {
  peer!: MemorySocket;
  readonly remoteAddress = '127.0.0.1';
  readonly remotePort = 0;
  readonly localAddress = '127.0.0.1';
  readonly localPort = 80;
  readonly encrypted = false;
  constructor() { super({ allowHalfOpen: false }); }
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void { this.peer.push(chunk); done(); }
  _final(done: (error?: Error | null) => void): void { this.peer.push(null); done(); }
  _destroy(error: Error | null, done: (error: Error | null) => void): void { if (!this.peer.destroyed) this.peer.push(null); done(error); }
  setNoDelay(): this { return this; }
  setKeepAlive(): this { return this; }
  setTimeout(): this { return this; }
  ref(): this { return this; }
  unref(): this { return this; }
}

export function memoryHttp(server: Server): MemoryHttp {
  const open = new Set<MemorySocket>();
  /** The client's end of a new connection; the server's end is already handed to it. */
  const connect = (): MemorySocket => {
    const client = new MemorySocket(), serverEnd = new MemorySocket();
    client.peer = serverEnd; serverEnd.peer = client;
    for (const end of [client, serverEnd]) { open.add(end); end.once('close', () => open.delete(end)); }
    server.emit('connection', serverEnd);
    return client;
  };

  const fetchFromMemory: MemoryHttp['fetch'] = async (input, init) => {
    const source = input instanceof Request ? input : undefined;
    const url = new URL(source?.url ?? String(input));
    const method = (init?.method ?? source?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers ?? source?.headers);
    const signal = init?.signal ?? source?.signal ?? undefined;
    const body = method === 'GET' || method === 'HEAD' ? undefined
      : init?.body !== undefined && init.body !== null ? Buffer.from(await new Response(init.body).arrayBuffer())
      : source ? Buffer.from(await source.arrayBuffer()) : undefined;
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const outgoing: Record<string, string> = {};
      headers.forEach((value, name) => { outgoing[name] = value; });
      if (body) outgoing['content-length'] = String(body.length);
      const request = httpRequest({ method, path: url.pathname + url.search, host: url.host, headers: outgoing, createConnection: connect });
      const abort = () => { request.destroy(); reject(signal!.reason); };
      signal?.addEventListener('abort', abort, { once: true });
      request.once('error', error => reject(new TypeError('fetch failed', { cause: error })));
      request.once('response', reply => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(reply.headers as IncomingHttpHeaders)) for (const each of [value].flat()) if (each !== undefined) responseHeaders.append(name, each);
        const status = reply.statusCode ?? 200;
        const empty = method === 'HEAD' || status === 204 || status === 205 || status === 304;
        if (empty) reply.resume();
        resolve(new Response(empty ? null : Readable.toWeb(reply) as ReadableStream<Uint8Array>, { status, statusText: reply.statusMessage ?? '', headers: responseHeaders }));
      });
      request.end(body);
    });
  };

  const webSocket: MemoryHttp['webSocket'] = (url, options = {}) => new WebSocket(url, { ...options, createConnection: connect as never });

  return {
    url: 'http://memory.test',
    fetch: fetchFromMemory,
    webSocket,
    WebSocket: class extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[], options: object = {}) {
        super(url, protocols as never, { createConnection: connect as never, ...options });
      }
    } as MemoryHttp['WebSocket'],
    close() { for (const end of open) end.destroy(); },
  };
}

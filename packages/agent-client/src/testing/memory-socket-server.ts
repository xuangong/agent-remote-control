/**
 * Test support: a WebSocket server and its clients in memory, for the client transport's behaviour over a socket without a port.
 *
 * Contract. `memorySocketServer()` returns the `WebSocket` constructor to hand to `HttpWebSocketTransport` and the server's side: `urls`
 * (the request path and query of each connection, in order), `sockets` (the server end of each) and `frames` (every JSON frame a client
 * sent, with its socket). A client opens on the next microtask and sees `onopen`; the server end sees `connection` listeners first.
 * `serverSocket.send` reaches the client's `onmessage`; `serverSocket.close()` and `terminate()` end the client with `onclose` (terminate
 * without a close frame, as a lost network does); a client `close()` ends the server end the same way. `readyState` follows the standard
 * values (0 connecting, 1 open, 3 closed). Delivery is in order and never reordered; nothing is dropped unless a test terminates a socket.
 */
const CONNECTING = 0, OPEN = 1, CLOSED = 3;

type Listener = (...args: any[]) => void;
export interface MemoryServerSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'message' | 'close', listener: Listener): this;
}

export function memorySocketServer() {
  const urls: string[] = [];
  const sockets: MemoryServerSocket[] = [];
  const frames: Array<{ socket: MemoryServerSocket; frame: any }> = [];
  const connections: Array<(socket: MemoryServerSocket, request: { url: string }) => void> = [];

  class MemoryWebSocket {
    static readonly CONNECTING = CONNECTING; static readonly OPEN = OPEN; static readonly CLOSED = CLOSED;
    readyState = CONNECTING;
    bufferedAmount = 0;
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    private readonly server: MemoryServerSocket;
    private readonly listeners = { message: [] as Listener[], close: [] as Listener[] };

    constructor(url: string) {
      const path = new URL(url).pathname + new URL(url).search;
      const closeBoth = () => {
        if (this.readyState === CLOSED) return;
        this.readyState = CLOSED; this.server.readyState = CLOSED;
        queueMicrotask(() => { this.onclose?.({}); for (const listener of this.listeners.close) listener(); });
      };
      this.server = {
        readyState: CONNECTING,
        send: data => { if (this.server.readyState !== OPEN) throw new Error('The socket is not open.'); queueMicrotask(() => { if (this.readyState === OPEN) this.onmessage?.({ data }); }); },
        close: () => closeBoth(), terminate: () => closeBoth(),
        on: (event, listener) => { this.listeners[event].push(listener); return this.server; },
      };
      urls.push(path); sockets.push(this.server);
      queueMicrotask(() => {
        if (this.readyState !== CONNECTING) return;
        this.readyState = OPEN; this.server.readyState = OPEN;
        for (const connection of connections) connection(this.server, { url: path });
        this.onopen?.({});
      });
      this.closeBoth = closeBoth;
    }
    private closeBoth: () => void;
    send(value: string): void {
      if (this.readyState !== OPEN) throw new Error('The socket is not open.');
      const frame = JSON.parse(value);
      frames.push({ socket: this.server, frame });
      queueMicrotask(() => { for (const listener of this.listeners.message) listener(value); });
    }
    close(): void { this.closeBoth(); }
  }

  return {
    WebSocket: MemoryWebSocket as unknown as new (url: string) => import('../client/http-websocket-transport.js').WebSocketLike,
    urls, sockets, frames,
    /** Runs when a client connects, as a server's `connection` handler: `onConnection(socket, { url })`; the socket's `message` listeners see client frames. */
    onConnection(listener: (socket: MemoryServerSocket, request: { url: string }) => void) { connections.push(listener); },
  };
}

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { WebSocket } from 'ws';

import { isRecord, type JsonObject } from './native.js';

type JsonRpcId = string | number;
type RequestHandler = (params: unknown, requestId: JsonRpcId) => unknown | Promise<unknown>;
type NotificationHandler = (method: string, params: unknown) => void;
type TerminationHandler = (error: Error) => void;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface CodexAppServerTransportOptions {
  requestTimeoutMs?: number;
  gracefulShutdownMs?: number;
  onDiagnostic?: (line: string) => void;
}

export class CodexTransportUnavailableError extends Error {}
export class CodexRequestTimeoutError extends Error {
  constructor(readonly method: string) { super(`Codex app-server request timed out for ${method}`); }
}

export class CodexServerRequestCanceled extends Error {}

export class CodexAppServerRpcError extends Error {
  constructor(
    message: string,
    readonly code: string | number | undefined,
    readonly data: unknown,
  ) {
    super(message);
    this.name = 'CodexAppServerRpcError';
  }
}

export class CodexAppServerTransport {
  private readonly lines: readline.Interface | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly requestTimeoutMs: number;
  private readonly gracefulShutdownMs: number;
  private readonly onDiagnostic: (line: string) => void;
  private notificationHandler: NotificationHandler | undefined;
  private terminationHandler: TerminationHandler | undefined;
  private terminationError: Error | undefined;
  private nextId = 1;
  private readonly diagnosticId = randomUUID();
  private closed = false;
  private disposePromise: Promise<void> | undefined;
  private stderr = '';

  constructor(
    readonly child: ChildProcessWithoutNullStreams | undefined,
    options: CodexAppServerTransportOptions = {},
    private readonly socket?: WebSocket,
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 90_000;
    this.gracefulShutdownMs = options.gracefulShutdownMs ?? 2_000;
    this.onDiagnostic = options.onDiagnostic ?? (() => undefined);
    if (socket) {
      socket.on('message', (data, binary) => {
        if (binary) { this.handleTermination(new Error('Codex shared app-server sent a binary JSON-RPC frame')); socket.terminate(); return; }
        void this.handleLine(data.toString());
      });
      socket.once('error', error => this.handleTermination(error));
      socket.once('close', () => this.handleTermination(new Error('Codex shared app-server connection closed. Restore the daemon and restart the Host connection.')));
      return;
    }
    if (!child) throw new Error('Codex transport requires a process or a shared socket.');
    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on('line', (line) => void this.handleLine(line));
    child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-8192);
    });
    child.once('error', (error) => this.handleTermination(error));
    child.once('exit', (code, signal) => {
      const suffix = this.stderr.trim() ? `\n${this.stderr.trim()}` : '';
      this.handleTermination(new Error(
        `Codex app-server exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}${suffix}`,
      ));
    });
  }

  static async connectShared(socketPath: string, options: CodexAppServerTransportOptions = {}): Promise<CodexAppServerTransport> {
    const socket = new WebSocket('ws://localhost/', {
      createConnection: () => connect(socketPath),
      handshakeTimeout: options.requestTimeoutMs ?? 5000,
      maxPayload: 64 * 1024 * 1024, perMessageDeflate: false, followRedirects: false,
    });
    const transport = new CodexAppServerTransport(undefined, options, socket);
    try { await once(socket, 'open'); return transport; }
    catch (error) {
      socket.terminate();
      throw new CodexTransportUnavailableError('Could not connect to the shared Codex app-server. Start the native daemon or check its local socket path.', { cause: error });
    }
  }

  setNotificationHandler(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  setTerminationHandler(handler: TerminationHandler): void {
    if (this.terminationError) {
      const error = this.terminationError;
      this.terminationError = undefined;
      handler(error);
      return;
    }
    this.terminationHandler = handler;
  }

  setRequestHandler(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  request(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (this.closed) return Promise.reject(new CodexTransportUnavailableError('Codex app-server transport is closed'));
    const id = this.nextId++;
    const started = Date.now();
    const phase = method === 'thread/resume' ? 'resume' : method === 'thread/read' ? 'history' : method === 'thread/list' ? 'catalog' : method === 'initialize' ? 'initialize' : undefined;
    const diagnostic = (outcome: 'started' | 'completed' | 'timeout' | 'unavailable' | 'rejected') => {
      if (!phase) return;
      try { this.onDiagnostic(JSON.stringify({ event: 'codex_request', connectionId: this.diagnosticId, requestId: id,
        phase, outcome, elapsedMs: Date.now() - started })); } catch { /* Diagnostics cannot change native request outcomes. */ }
    };
    diagnostic('started');
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRequestTimeoutError(method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      this.write({ id, method, params });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return result.then(value => { diagnostic('completed'); return value; }, error => {
      diagnostic(error instanceof CodexRequestTimeoutError ? 'timeout' : error instanceof CodexTransportUnavailableError ? 'unavailable' : 'rejected');
      throw error;
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write({ method, params });
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = this.disposeOnce();
    return this.disposePromise;
  }

  private async disposeOnce(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.notificationHandler = undefined;
    this.terminationHandler = undefined;
    this.rejectPending(new CodexTransportUnavailableError('Codex app-server transport is closed'));
    this.lines?.close();
    if (this.socket) {
      if (this.socket.readyState === WebSocket.CLOSED) return;
      const exited = once(this.socket, 'close');
      this.socket.close();
      const timer = setTimeout(() => this.socket?.terminate(), this.gracefulShutdownMs);
      try { await exited; } finally { clearTimeout(timer); }
      return;
    }
    if (!this.child) return;
    this.child.stdin.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;

    const exited = once(this.child, 'exit').then(() => undefined);
    this.child.kill('SIGTERM');
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.gracefulShutdownMs);
    });
    await Promise.race([exited, timeout]);
    if (timer) clearTimeout(timer);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGKILL');
    }
  }

  private handleTermination(error: Error): void {
    if (this.closed) return;
    error = new CodexTransportUnavailableError(error.message, { cause: error });
    this.closed = true;
    this.lines?.close();
    this.socket?.terminate();
    this.notificationHandler = undefined;
    this.rejectPending(error);
    const handler = this.terminationHandler;
    this.terminationHandler = undefined;
    if (handler) handler(error);
    else this.terminationError = error;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.onDiagnostic(line);
      return;
    }
    if (!isRecord(message)) return;
    if (isJsonRpcRequest(message)) {
      await this.handleServerRequest(message);
      return;
    }
    if (isJsonRpcResponse(message)) {
      this.handleResponse(message);
      return;
    }
    if (typeof message.method === 'string') {
      this.notificationHandler?.(message.method, message.params);
    }
  }

  private handleResponse(message: JsonObject): void {
    const id = message.id;
    if (typeof id !== 'number') return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (isRecord(message.error)) {
      pending.reject(new CodexAppServerRpcError(
        typeof message.error.message === 'string' ? message.error.message : 'Unknown RPC error',
        typeof message.error.code === 'string' || typeof message.error.code === 'number'
          ? message.error.code : undefined,
        message.error.data,
      ));
      return;
    }
    pending.resolve(message.result);
  }

  private async handleServerRequest(message: JsonObject): Promise<void> {
    const id = message.id as JsonRpcId;
    const method = message.method as string;
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.write({ id, error: { code: -32601, message: `Unsupported Codex server request: ${method}` } });
      return;
    }
    try {
      this.write({ id, result: await handler(message.params, id) });
    } catch (error) {
      if (error instanceof CodexServerRequestCanceled) return;
      this.write({ id, error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error),
      } });
    }
  }

  private write(message: JsonObject): void {
    if (this.closed) return;
    if (this.socket) {
      this.socket.send(JSON.stringify(message), error => { if (error) this.handleTermination(error); });
    } else if (this.child?.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

function isJsonRpcRequest(message: JsonObject): boolean {
  return (typeof message.id === 'number' || typeof message.id === 'string')
    && typeof message.method === 'string';
}

function isJsonRpcResponse(message: JsonObject): boolean {
  return typeof message.id === 'number'
    && ('result' in message || 'error' in message);
}

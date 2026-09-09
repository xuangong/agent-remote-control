import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';

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
  private readonly lines: readline.Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly requestTimeoutMs: number;
  private readonly gracefulShutdownMs: number;
  private readonly onDiagnostic: (line: string) => void;
  private notificationHandler: NotificationHandler | undefined;
  private terminationHandler: TerminationHandler | undefined;
  private terminationError: Error | undefined;
  private nextId = 1;
  private closed = false;
  private disposePromise: Promise<void> | undefined;
  private stderr = '';

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    options: CodexAppServerTransportOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 90_000;
    this.gracefulShutdownMs = options.gracefulShutdownMs ?? 2_000;
    this.onDiagnostic = options.onDiagnostic ?? (() => undefined);
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
    if (this.closed) return Promise.reject(new Error('Codex app-server transport is closed'));
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return result;
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
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
    this.rejectPending(new Error('Codex app-server transport is closed'));
    this.lines.close();
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
    this.closed = true;
    this.lines.close();
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
    if (this.closed || !this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
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

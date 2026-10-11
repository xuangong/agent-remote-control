import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Ajv, type ValidateFunction } from 'ajv';
import type { AgentSessionTool } from '@orchardworks/agent-provider-sdk';

export const CALLBACK_TOOL_IDS = ['arc_host_discover', 'arc_host_invoke'] as const;
const MAX_BODY = 64 * 1024;
const MAX_OUTPUT = 128 * 1024;
interface Binding { tools: Map<string, { tool: AgentSessionTool; validate: ValidateFunction }>; controller: AbortController }
interface Rendezvous { version: 1; pid: number; baseUrl: string; token: string; serverUrl: string }

/** Process-local callback authority; credentials are only published in the private rendezvous file. */
export class OpenCodeCallbackBridge {
  private readonly token = randomBytes(32).toString('hex');
  private readonly sessions = new Map<string, Binding>();
  private readonly seen = new Map<string, number>();
  private server?: Server;
  private startTask?: Promise<void>;
  private closeTask?: Promise<void>;
  private closed = false;
  constructor(readonly configPath: string, private readonly serverUrl: string, private readonly timeoutMs = 10000) {
    if (!isAbsolute(configPath)) throw new Error('OpenCode callback config path must be absolute.');
    const url = new URL(serverUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('OpenCode callbacks require a trusted local HTTP server.');
  }
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('OpenCode callback bridge is closed.'));
    return this.startTask ??= this.startServer();
  }
  private async startServer(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true, mode: 0o700 });
    if (this.closed) throw new Error('OpenCode callback bridge is closed.');
    const server = createServer((request, response) => { void this.route(request, response); });
    server.requestTimeout = this.timeoutMs; server.headersTimeout = this.timeoutMs;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    this.server = server;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('OpenCode callback bridge did not bind.');
    if (this.closed) { await this.shutdown(); throw new Error('OpenCode callback bridge is closed.'); }
    const value: Rendezvous = { version: 1, pid: process.pid, baseUrl: `http://127.0.0.1:${address.port}`, token: this.token, serverUrl: this.serverUrl };
    try {
      try {
        const stat = await lstat(this.configPath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('OpenCode callback config must be a private regular file.');
        const previous = JSON.parse(await readFile(this.configPath, 'utf8')) as Rendezvous;
        if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error('OpenCode callback config is invalid.');
        let live = true;
        try { process.kill(previous.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') live = false; }
        if (live) throw new Error('OpenCode callback config already has a live Controller owner. Use one callback owner per native server.');
        await unlink(this.configPath);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await writeFile(this.configPath, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    } catch (error) { await this.shutdown(); throw error; }
  }
  isAvailable(directory: string): boolean { return Date.now() - (this.seen.get(directory) ?? 0) < 6000; }
  async waitForPlugin(directory: string, timeoutMs = 4000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) { if (this.isAvailable(directory)) return true; await delay(50); }
    return this.isAvailable(directory);
  }
  bind(nativeSessionId: string, tools: readonly AgentSessionTool[]): () => void {
    if (this.closed) throw new Error('OpenCode callback bridge is closed.');
    const validator = new Ajv({ strict: true, allErrors: false });
    const binding: Binding = { tools: new Map(), controller: new AbortController() };
    for (const tool of tools) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tool.name) || binding.tools.has(tool.name)) throw new Error('Invalid or duplicate OpenCode callback tool name.');
      binding.tools.set(tool.name, { tool, validate: validator.compile(tool.inputSchema) });
    }
    this.sessions.get(nativeSessionId)?.controller.abort();
    this.sessions.set(nativeSessionId, binding);
    return () => { binding.controller.abort(); if (this.sessions.get(nativeSessionId) === binding) this.sessions.delete(nativeSessionId); };
  }
  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const abort = new AbortController();
    const timer = setTimeout(() => { abort.abort(); send(response, 504, { error: 'Host callback timed out.' }); request.destroy(); }, this.timeoutMs);
    request.once('aborted', () => abort.abort());
    try {
      const auth = Buffer.from(request.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${this.token}`);
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { send(response, 401, { error: 'Unauthorized.' }); return; }
      if (request.headers.origin) { send(response, 403, { error: 'Browser requests are not allowed.' }); return; }
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (path === '/ready' && request.method === 'POST') {
        const value = await body(request) as Record<string, unknown>;
        if (value?.serverUrl !== this.serverUrl || typeof value.directory !== 'string' || value.version !== 1) { send(response, 409, { error: 'Native callback server identity mismatch.' }); return; }
        this.seen.set(value.directory, Date.now()); send(response, 200, { ready: true }); return;
      }
      const match = /^\/sessions\/([^/]+)\/(discover|invoke)$/.exec(path);
      if (!match) { send(response, 404, { error: 'Not found.' }); return; }
      const binding = this.sessions.get(decodeURIComponent(match[1]!));
      if (!binding) { send(response, 403, { error: 'Native session has no Host callback grant.' }); return; }
      if (match[2] === 'discover' && request.method === 'GET') {
        send(response, 200, { tools: [...binding.tools.values()].map(({ tool }) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) }); return;
      }
      if (match[2] !== 'invoke' || request.method !== 'POST') { send(response, 405, { error: 'Method not allowed.' }); return; }
      const value = await body(request) as Record<string, unknown>;
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'name' && key !== 'arguments') || typeof value.name !== 'string') { send(response, 400, { error: 'Invalid Host callback arguments.' }); return; }
      const selected = binding.tools.get(value.name);
      if (!selected || !selected.validate(value.arguments)) { send(response, 400, { error: 'Unknown callback or invalid callback arguments.' }); return; }
      const signal = AbortSignal.any([abort.signal, binding.controller.signal]);
      const output = await new Promise<string>((resolve, reject) => {
        const cancel = () => reject(new Error('Host callback is unavailable.'));
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted || this.sessions.get(decodeURIComponent(match[1]!)) !== binding) { cancel(); return; }
        Promise.resolve().then(() => { if (signal.aborted) throw new Error('Host callback is unavailable.'); return selected.tool.execute(value.arguments); }).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
      });
      if (signal.aborted) throw new Error('Host callback is unavailable.');
      if (typeof output !== 'string' || Buffer.byteLength(output) > MAX_OUTPUT) { send(response, 413, { error: 'Host callback output exceeds the limit. Read a smaller page.' }); return; }
      send(response, 200, { output });
    } catch { send(response, 400, { error: 'Host callback failed or its arguments were invalid.' }); }
    finally { clearTimeout(timer); }
  }
  close(): Promise<void> {
    this.closed = true;
    return this.closeTask ??= (async () => { await this.startTask?.catch(() => undefined); await this.shutdown(); })();
  }
  private async shutdown(): Promise<void> {
    for (const binding of this.sessions.values()) binding.controller.abort();
    this.sessions.clear(); this.seen.clear();
    const server = this.server; this.server = undefined;
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    try { const value = JSON.parse(await readFile(this.configPath, 'utf8')); if (value.token === this.token) await unlink(this.configPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
async function body(request: IncomingMessage): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) { const data = Buffer.from(chunk); size += data.length; if (size > MAX_BODY) throw new Error('Body too large.'); chunks.push(data); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function send(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const output = JSON.stringify(value);
  response.writeHead(Buffer.byteLength(output) > MAX_OUTPUT ? 413 : status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(Buffer.byteLength(output) > MAX_OUTPUT ? '{"error":"Host callback output exceeds the limit."}' : output);
}

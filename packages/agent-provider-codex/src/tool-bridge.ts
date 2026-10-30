import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { open } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AgentSessionToolNamespace } from '@orchardworks/agent-provider-sdk';
import { isRecord, readString } from './native.js';

/** MCP protocol versions this bridge answers; a client asking for another gets the newest. */
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_BODY = 4 * 1024 * 1024;
const MAX_META_LINE = 16 * 1024 * 1024;

interface Registration { names: ReadonlySet<string>; namespaces(): readonly AgentSessionToolNamespace[] }
export interface CodexToolBridgeRegistration {
  /** Config overrides for thread/resume that add one MCP server per namespace. */
  config: Record<string, unknown>;
  release(): void;
}

/** Namespaces a bridge can offer: Codex config keys and MCP tool prefixes are built from their names. */
export const bridgeableNamespace = (name: string) => NAME.test(name);

/**
 * Offers tool namespaces to Codex threads that did not declare them when they started, as MCP servers on loopback.
 * Codex fixes dynamic tools at thread start but loads MCP servers from a thread's config on every resume, so a thread
 * started elsewhere gains the namespaces when the Controller resumes it. Each registration has its own bearer token,
 * so a call reaches only the session that registered; Codex keeps neither the token nor the address.
 */
export class CodexToolBridge {
  private listening: Promise<{ server: Server; port: number }> | undefined;
  private readonly registrations = new Map<string, Registration>();

  async register(names: readonly string[], namespaces: () => readonly AgentSessionToolNamespace[]): Promise<CodexToolBridgeRegistration> {
    if (!names.length || names.some(name => !bridgeableNamespace(name))) throw new Error('Codex tool bridge namespace names are invalid.');
    const { port } = await this.listen();
    const token = randomBytes(32).toString('base64url');
    this.registrations.set(token, { names: new Set(names), namespaces });
    const config = Object.fromEntries(names.map(name => [`mcp_servers.${name}`, {
      url: `http://127.0.0.1:${port}/mcp/${name}`, http_headers: { Authorization: `Bearer ${token}` },
      // These are the Host's own tools, which it offers the session; Codex would otherwise ask the user before every call.
      default_tools_approval_mode: 'approve', tool_timeout_sec: 600,
    }]));
    return { config, release: () => { this.registrations.delete(token); } };
  }

  /** The server stays up, unreferenced, until the provider is disposed: a thread keeps its address until it is resumed again. */
  async dispose(): Promise<void> { this.registrations.clear(); await this.close(); }

  private listen(): Promise<{ server: Server; port: number }> {
    this.listening ??= (async () => {
      let port = 0;
      const server = createServer((request, response) => { void this.handle(request, response, port).catch(() => { if (!response.headersSent) response.writeHead(500).end(); }); });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      server.unref();
      port = (server.address() as { port: number }).port;
      return { server, port };
    })();
    return this.listening;
  }

  private async close(): Promise<void> {
    const listening = this.listening;
    this.listening = undefined;
    if (!listening) return;
    const { server } = await listening.catch(() => ({ server: undefined }));
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse, port: number): Promise<void> {
    const reply = (status: number, body?: unknown) => {
      if (body === undefined) { response.writeHead(status).end(); return; }
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    };
    // A web page can reach loopback, but only with its own Origin or a rebound Host name.
    if (request.headers.host !== `127.0.0.1:${port}` || request.headers.origin !== undefined) return reply(403);
    const token = /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(request.headers.authorization ?? '')?.[1];
    const registration = token ? this.registrations.get(token) : undefined;
    const name = /^\/mcp\/([^/?#]+)$/.exec(request.url ?? '')?.[1];
    if (!registration || !name || !registration.names.has(name)) return reply(401);
    if (request.method !== 'POST') { response.setHeader('allow', 'POST'); return reply(405); }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) return reply(413);
      chunks.push(chunk as Buffer);
    }
    let message: unknown;
    try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } }); }
    if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request.' } });
    // Notifications, such as notifications/initialized, need no answer.
    if (message.id === undefined) return reply(202);
    const answer = (result: unknown) => reply(200, { jsonrpc: '2.0', id: message.id, result });
    const fail = (code: number, text: string) => reply(200, { jsonrpc: '2.0', id: message.id, error: { code, message: text } });
    const namespace = registration.namespaces().find(item => item.name === name);
    if (!namespace) return fail(-32603, 'Session tools are unavailable. Reopen this session through its Host.');
    const params = isRecord(message.params) ? message.params : {};
    if (message.method === 'initialize') {
      const requested = readString(params.protocolVersion);
      return answer({ protocolVersion: requested && PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } }, serverInfo: { name, version: '1.0.0' }, instructions: namespace.description });
    }
    if (message.method === 'ping') return answer({});
    if (message.method === 'tools/list') return answer({ tools: namespace.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    if (message.method === 'tools/call') {
      const tool = namespace.tools.find(item => item.name === params.name);
      if (!tool) return fail(-32602, 'Unknown tool.');
      try { return answer({ content: [{ type: 'text', text: await tool.execute(params.arguments ?? {}) }] }); }
      catch (error) { return answer({ content: [{ type: 'text', text: error instanceof Error ? error.message : 'Session tool failed.' }], isError: true }); }
    }
    return fail(-32601, 'Method not found.');
  }
}

/**
 * The namespaces a thread declared as dynamic tools when it started, from the first record of its rollout;
 * undefined when the rollout cannot be read as this thread's.
 */
export async function declaredToolNamespaces(path: string, threadId: string): Promise<Set<string> | undefined> {
  let file;
  try { file = await open(path, 'r'); } catch { return undefined; }
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    for (let position = 0; position < MAX_META_LINE;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      const end = buffer.subarray(0, bytesRead).indexOf(10);
      chunks.push(Buffer.from(buffer.subarray(0, end < 0 ? bytesRead : end)));
      if (end >= 0) break;
      position += bytesRead;
    }
    const row: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isRecord(row) || row.type !== 'session_meta' || !isRecord(row.payload) || row.payload.id !== threadId) return undefined;
    const tools = row.payload.dynamic_tools;
    if (tools === undefined || tools === null) return new Set();
    if (!Array.isArray(tools)) return undefined;
    return new Set(tools.filter(tool => isRecord(tool) && tool.type === 'namespace' && typeof tool.name === 'string').map(tool => (tool as { name: string }).name));
  } catch { return undefined; }
  finally { await file.close(); }
}

import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * A scripted Responses API for the real `codex` binary: one list of events per model request, a temporary CODEX_HOME whose
 * config.toml points at it, and a fake API key. Nothing signs in and nothing reads the user's own Codex home.
 */
export type ResponsesEvent = { type: string; [field: string]: unknown };

/** What the scripted model answers to one request. `stall` keeps the stream open after `events` until the client goes away (an interrupt). */
export type ResponsesStep = readonly ResponsesEvent[] | { events: readonly ResponsesEvent[]; stall: true } | { status: number; body: string };

export interface ResponsesRequest { input: Array<Record<string, unknown>>; [field: string]: unknown }

export type ResponsesScript = readonly ResponsesStep[] | ((request: ResponsesRequest, index: number) => ResponsesStep);

export interface ResponsesFixtureOptions {
  approvalPolicy?: 'never' | 'on-request' | 'untrusted';
  sandboxMode?: 'read-only' | 'workspace-write';
  /** Raw TOML tables appended to config.toml, for example a failing MCP server. */
  config?: string;
  /** Raw top-level TOML keys, written before any table. */
  topLevel?: string;
  /** Use a model whose catalog entry offers the freeform `apply_patch` tool, so a scenario can change files. */
  patchTool?: boolean;
}

export interface ResponsesFixture {
  url: string;
  home: string;
  cwd: string;
  requests: ResponsesRequest[];
  /** The environment a `codex app-server` needs to use this fixture's home. */
  env: Record<string, string>;
  close(): Promise<void>;
}

/** A pause in the model's stream, so items of one response start at different milliseconds as they do from a real model. */
export const pause = (ms: number): ResponsesEvent => ({ type: 'x-pause', ms });

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

const sse = (events: readonly ResponsesEvent[]): string => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');

/** A message the model streams as `deltas` and then finishes as `text` (the two differ in a correction). */
export function message(id: string, text: string, deltas: readonly string[] = [text]): ResponsesEvent[] {
  return [
    { type: 'response.output_item.added', item: { type: 'message', role: 'assistant', id, content: [] } },
    ...deltas.map(delta => ({ type: 'response.output_text.delta', item_id: id, delta })),
    { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id, content: [{ type: 'output_text', text }] } },
  ];
}

/** A reasoning item with summary parts; `streamed` is what each part streams before the item finishes with `parts`. */
export function reasoning(id: string, parts: readonly string[], streamed: readonly string[] = parts): ResponsesEvent[] {
  return [
    { type: 'response.output_item.added', item: { type: 'reasoning', id, summary: [] } },
    ...streamed.flatMap((text, summaryIndex) => [
      { type: 'response.reasoning_summary_part.added', item_id: id, summary_index: summaryIndex },
      { type: 'response.reasoning_summary_text.delta', item_id: id, summary_index: summaryIndex, delta: text },
    ]),
    { type: 'response.output_item.done', item: { type: 'reasoning', id, summary: parts.map(text => ({ type: 'summary_text', text })) } },
  ];
}

/** A function call of the model; the real app-server runs it. */
export function call(callId: string, name: string, args: unknown): ResponsesEvent[] {
  const item = { type: 'function_call', id: `fc-${callId}`, call_id: callId, name, arguments: JSON.stringify(args) };
  return [{ type: 'response.output_item.added', item }, { type: 'response.output_item.done', item }];
}

/** A freeform `apply_patch` call; needs `patchTool`. */
export const patch = (callId: string, text: string): ResponsesEvent[] => {
  const item = { type: 'custom_tool_call', id: `ctc-${callId}`, call_id: callId, name: 'apply_patch', input: text };
  return [{ type: 'response.output_item.added', item }, { type: 'response.output_item.done', item }];
};

export const shell = (callId: string, command: string): ResponsesEvent[] => call(callId, 'exec_command', { cmd: command, max_output_tokens: 1000 });

/** A model step that never finishes: the events so far, then silence until the turn is interrupted. */
export const stalled = (events: readonly ResponsesEvent[]): ResponsesStep => ({ events, stall: true });

/** The tool outputs the app-server sent back, by call id. */
export const toolOutputs = (request: ResponsesRequest): Map<string, unknown> =>
  new Map(request.input.flatMap(item => item.type === 'function_call_output' ? [[String(item.call_id), item.output] as const] : []));

export async function startResponsesFixture(script: ResponsesScript, options: ResponsesFixtureOptions = {}): Promise<ResponsesFixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arc-codex-responses-')));
  const home = join(root, 'home'); const cwd = join(root, 'workspace');
  mkdirSync(home); mkdirSync(cwd);
  const requests: ResponsesRequest[] = [];
  const open = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      if (request.method !== 'POST' || request.url !== '/v1/responses') { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ResponsesRequest;
      const index = requests.push(body) - 1;
      const step = typeof script === 'function' ? script(body, index) : script[Math.min(index, script.length - 1)]!;
      if ('status' in step) { response.writeHead(step.status, { 'content-type': 'application/json' }).end(step.body); return; }
      const id = `response-${index + 1}`;
      const events = Array.isArray(step) ? step as readonly ResponsesEvent[] : (step as { events: readonly ResponsesEvent[] }).events;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const stall = !Array.isArray(step);
      if (stall) { open.add(response); response.on('close', () => open.delete(response)); }
      void (async () => {
        response.write(sse([{ type: 'response.created', response: { id } }]));
        for (const event of events) {
          if (response.destroyed) return;
          if (event.type === 'x-pause') await sleep(Number(event.ms)); else response.write(sse([event]));
        }
        if (!stall) response.end(sse([{ type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]));
      })();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The scripted Responses server has no TCP address');
  const url = `http://127.0.0.1:${address.port}`;
  writeFileSync(join(home, 'config.toml'), `model = "${options.patchTool ? 'step-settings-a' : 'mock-model'}"
${options.patchTool ? `model_catalog_json = ${JSON.stringify(fileURLToPath(new URL('./step-model-catalog.json', import.meta.url)))}\n` : ''}model_provider = "fixture"
approval_policy = "${options.approvalPolicy ?? 'never'}"
sandbox_mode = "${options.sandboxMode ?? 'read-only'}"
${options.topLevel ?? ''}

[features]
plugins = false

[model_providers.fixture]
name = "Scripted Responses"
base_url = "${url}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
${options.config ?? ''}
`);
  return {
    url, home, cwd, requests,
    env: { CODEX_HOME: home, OPENAI_API_KEY: 'local-test', LC_ALL: 'C' },
    async close() {
      for (const response of open) response.destroy();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

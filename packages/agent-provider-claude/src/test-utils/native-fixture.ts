import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A block of a scripted reply: text (optionally split into several deltas), a thinking block, or a tool call. */
export type NativeBlock = { type: 'text'; text: string; deltas?: string[] } | { type: 'thinking'; thinking: string; deltas?: string[] } | { type: 'tool_use'; id: string; name: string; input: unknown };

/** A reply's message id: the fixture numbers its replies in order, so a recording does not change from run to run. */
const messageIdOf = (response: ServerResponse): string => (response as ServerResponse & { messageId?: string }).messageId ?? `msg-${Math.random()}`;

function nativeEvents(response: ServerResponse, content: NativeBlock[], usage: { inputTokens: number; outputTokens: number }, finish: boolean): any[] {
  const events: any[] = [{ type: 'message_start', message: { id: messageIdOf(response), type: 'message', role: 'assistant', model: 'claude-sonnet-4-5-20250929', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.inputTokens, output_tokens: 0 } } }];
  for (const [index, block] of content.entries()) {
    const last = !finish && index === content.length - 1;
    if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
        ...(block.deltas ?? [block.text]).map(text => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })));
    } else if (block.type === 'thinking') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
        ...(block.deltas ?? [block.thinking]).map(thinking => ({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } })),
        ...(last ? [] : [{ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'fixture-signature' } }]));
    } else {
      events.push({ type: 'content_block_start', index, content_block: { ...block, input: {} } },
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    if (!last) events.push({ type: 'content_block_stop', index });
  }
  if (finish) events.push({ type: 'message_delta', delta: { stop_reason: content.some((part) => part.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.outputTokens } }, { type: 'message_stop' });
  return events;
}

const sse = (events: any[]) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');

export function nativeReply(response: ServerResponse, content: NativeBlock[] | any[], usage = { inputTokens: 10, outputTokens: 5 }): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(sse(nativeEvents(response, content as NativeBlock[], usage, true)));
}

/**
 * A finished reply whose blocks arrive `gapMs` apart, as a slow model streams them. The CLI runs a tool as soon as its block ends, so a
 * tool can finish while later blocks of the same message still stream.
 */
export async function nativePaced(response: ServerResponse, content: NativeBlock[], gapMs: number, usage = { inputTokens: 10, outputTokens: 5 }): Promise<void> {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of nativeEvents(response, content, usage, true)) {
    response.write(sse([event]));
    if (event.type === 'content_block_stop') await new Promise(resolve => { setTimeout(resolve, gapMs); });
  }
  response.end();
}

/** A reply that never finishes: its blocks so far, then silence until the turn is interrupted. The last block stays open. */
export function nativeStalled(response: ServerResponse, content: NativeBlock[], usage = { inputTokens: 10, outputTokens: 5 }): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(sse(nativeEvents(response, content, usage, false)));
}

export async function nativeFixture(handler: (body: any, response: ServerResponse) => void, options: { sessionTitles?: 'automatic' | 'manual' } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'claude-control-home-'));
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'claude-control-workspace-')));
  const bodies: any[] = [];
  const sessionTitles: any[] = [];
  const requests: { method: string | undefined; path: string | undefined }[] = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      if (request.url?.includes('count_tokens')) { response.setHeader('content-type', 'application/json'); response.end('{"input_tokens":10}'); return; }
      if (!request.url?.startsWith('/v1/messages')) { response.writeHead(404); response.end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const content = body.messages?.[0]?.content;
      const titleRequest = body.messages?.length === 1 && body.messages[0].role === 'user' && !body.tools?.length
        && Array.isArray(content) && content.length === 1 && content[0]?.type === 'text'
        && content[0].text.startsWith('<session>\n') && content[0].text.includes('\n</session>\n\nWrite the title in the predominant language of the session');
      if (titleRequest) {
        sessionTitles.push(body);
        if (options.sessionTitles !== 'manual') {
          nativeReply(response, [{ type: 'text', text: 'Isolated native fixture' }], { inputTokens: 0, outputTokens: 0 });
          return;
        }
      }
      (response as ServerResponse & { messageId?: string }).messageId = `msg-${bodies.length + 1}`;
      bodies.push(body); handler(body, response);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
  return { cwd, home, bodies, sessionTitles, requests, options: { executable: process.env.AGENT_CLAUDE_TEST_EXECUTABLE ?? 'claude', requestTimeoutMs: 5000,
    env: { CLAUDE_CONFIG_DIR: home, ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: 'local-claude-test',
      ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CODE_USE_BEDROCK: undefined,
      CLAUDE_CODE_USE_VERTEX: undefined, CLAUDE_CODE_USE_FOUNDRY: undefined, DISABLE_NON_ESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true }); } };
}

import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function nativeReply(response: ServerResponse, content: any[]): void {
  const events: any[] = [{ type: 'message_start', message: { id: `msg-${Math.random()}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5-20250929', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }];
  for (const [index, block] of content.entries()) {
    events.push({ type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } },
      { type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } },
      { type: 'content_block_stop', index });
  }
  events.push({ type: 'message_delta', delta: { stop_reason: content.some((part) => part.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' });
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}

export async function nativeFixture(handler: (body: any, response: ServerResponse) => void) {
  const home = await mkdtemp(join(tmpdir(), 'claude-control-home-'));
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'claude-control-workspace-')));
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      if (request.url?.includes('count_tokens')) { response.setHeader('content-type', 'application/json'); response.end('{"input_tokens":10}'); return; }
      if (!request.url?.startsWith('/v1/messages')) { response.writeHead(404); response.end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body); handler(body, response);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
  return { cwd, home, bodies, options: { executable: process.env.AGENT_CLAUDE_TEST_EXECUTABLE ?? 'claude', requestTimeoutMs: 5000,
    env: { CLAUDE_CONFIG_DIR: home, ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: 'local-claude-test',
      ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CODE_USE_BEDROCK: undefined,
      CLAUDE_CODE_USE_VERTEX: undefined, CLAUDE_CODE_USE_FOUNDRY: undefined, DISABLE_NON_ESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true }); } };
}

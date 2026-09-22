import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentSession } from '@orchardworks/agent-provider-sdk';
import { CodexAppServerProvider } from './provider.js';

it.runIf(!!process.env.ARC_PROMPT_EDIT_TEST_EXECUTABLE)('matches 0.155.1 Esc with a real isolated native runtime and preserves the original thread', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-prompt-edit-'));
  let requests = 0;
  const server = createServer((request, response) => {
    request.resume(); request.on('end', () => {
      if (request.url !== '/v1/responses') { response.writeHead(404).end(); return; }
      const id = 'response-' + ++requests;
      response.setHeader('content-type', 'text/event-stream');
      response.end([
        { type: 'response.created', response: { id } },
        { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'answer-' + requests, content: [{ type: 'output_text', text: 'Done ' + requests }] } },
        { type: 'response.completed', response: { id, usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
      ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const home = join(directory, 'home'); await mkdir(home);
  await writeFile(join(home, 'config.toml'), `model = "mock-model"\nmodel_provider = "mock"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.mock]\nname = "Local prompt edit test"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  const provider = new CodexAppServerProvider({ executable: process.env.ARC_PROMPT_EDIT_TEST_EXECUTABLE,
    env: { CODEX_HOME: home, OPENAI_API_KEY: 'local-test', LC_ALL: 'C' }, requestTimeoutMs: 10000 });
  const sessions: AgentSession[] = [];
  try {
    const source = await provider.createSession({ sessionId: 'test', cwd: directory }); sessions.push(source);
    const stream = source.observe()[Symbol.asyncIterator](); await stream.next();
    const prompts: Array<{ turnId: string; messageId: string }> = [];
    for (const text of ['Keep this prompt', 'Edit this prompt']) {
      await source.sendMessage(text);
      for (;;) {
        const next = await stream.next(); if (next.done) throw new Error('Runtime ended');
        if (next.value.type !== 'observation') continue;
        const { event } = next.value;
        if (event.type === 'timeline' && event.item.type === 'user_message') prompts.push({ turnId: event.turnId!, messageId: event.item.messageId! });
        if (event.type === 'turn_failed') throw new Error(JSON.stringify(event));
        if (event.type === 'turn_completed') break;
      }
    }
    const persistence = (await source.runtimeInfo()).persistence!;
    const fork = await provider.forkForPromptEdit({ nativeSessionId: persistence.sessionId, ...prompts[1]! }); sessions.push(fork);
    expect((await fork.runtimeInfo()).sessionId).not.toBe(persistence.sessionId);
    const texts: string[] = [];
    for await (const value of fork.observe()) {
      if (value.type === 'history_boundary') break;
      if (value.event.type === 'timeline' && value.event.item.type === 'user_message') texts.push(value.event.item.text);
    }
    expect(texts).toEqual(['Keep this prompt']);
    const first = await provider.forkForPromptEdit({ nativeSessionId: persistence.sessionId, ...prompts[0]! }); sessions.push(first);
    expect((await first.observe()[Symbol.asyncIterator]().next()).value).toMatchObject({ type: 'history_boundary' });
    await source.dispose();
    const original = await provider.resumeSession(persistence); sessions.push(original);
    const originalTexts: string[] = [];
    for await (const value of original.observe()) {
      if (value.type === 'history_boundary') break;
      if (value.event.type === 'timeline' && value.event.item.type === 'user_message') originalTexts.push(value.event.item.text);
    }
    expect(originalTexts).toEqual(['Keep this prompt', 'Edit this prompt']);
    expect(requests).toBe(2);
  } finally {
    await Promise.allSettled(sessions.map(session => session.dispose()));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

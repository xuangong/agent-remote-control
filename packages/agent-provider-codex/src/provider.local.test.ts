import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CodexAppServerProvider } from './provider.js';

function responseSse(): string {
  const events = [
    { type: 'response.created', response: { id: 'response-1' } },
    {
      type: 'response.output_item.done',
      item: {
        type: 'message', role: 'assistant', id: 'message-1',
        content: [{ type: 'output_text', text: 'LOCAL_PROCESS_OK' }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: 'response-1',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

async function startResponsesServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.statusCode = 404;
        response.end('not found');
        return;
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'text/event-stream');
      response.end(responseSse());
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock Responses server has no TCP address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

describe('Codex app-server local process', () => {
  it('initializes codex-cli 0.148.0 and completes thread start, resume, and read', async () => {
    const executable = process.env.BORGEE_CODEX_TEST_EXECUTABLE ?? 'codex';
    const version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();
    expect(version).toContain('codex-cli 0.148.0');

    const codexHome = mkdtempSync(path.join(os.tmpdir(), 'borgee-codex-home-'));
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'borgee-codex-workspace-'));
    const responses = await startResponsesServer();
    writeFileSync(path.join(codexHome, 'config.toml'), `
model = "mock-model"
model_provider = "mock_provider"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.mock_provider]
name = "Borgee local process test"
base_url = "${responses.url}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`);
    const provider = new CodexAppServerProvider({
      executable,
      env: { CODEX_HOME: codexHome, OPENAI_API_KEY: 'local-process-test' },
      requestTimeoutMs: 10_000,
    });
    try {
      const created = await provider.createSession({ sessionId: 'local-process', cwd, model: 'mock-model' });
      const live = created.observe()[Symbol.asyncIterator]();
      await expect(live.next()).resolves.toMatchObject({ value: { type: 'history_boundary' } });
      await created.sendMessage('Reply with the sentinel.');
      const liveEvents = [];
      while (true) {
        const next = await live.next();
        if (next.done || next.value.type !== 'observation') continue;
        liveEvents.push(next.value.event);
        if (
          next.value.event.type === 'turn_completed'
          || next.value.event.type === 'turn_failed'
          || next.value.event.type === 'turn_canceled'
        ) break;
      }
      expect(liveEvents).toContainEqual(expect.objectContaining({ type: 'turn_completed' }));
      expect(liveEvents).toContainEqual(expect.objectContaining({
        type: 'timeline', item: expect.objectContaining({ type: 'assistant_message', text: 'LOCAL_PROCESS_OK' }),
      }));
      const persistence = (await created.runtimeInfo()).persistence!;
      await created.dispose();

      const resumed = await provider.resumeSession(persistence);
      const history = [];
      for await (const item of resumed.observe()) {
        if (item.type === 'history_boundary') break;
        history.push(item.event);
      }
      expect(history).toContainEqual(expect.objectContaining({
        type: 'timeline', item: expect.objectContaining({ type: 'assistant_message', text: 'LOCAL_PROCESS_OK' }),
      }));
      await resumed.dispose();
    } finally {
      await responses.close();
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

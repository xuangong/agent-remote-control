import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexAppServerProvider } from './provider.js';
import { spawnCodexAppServer } from './native.js';

function response(output: Record<string, unknown>): string {
  return [
    { type: 'response.created', response: { id: 'local-response' } },
    { type: 'response.output_item.done', item: output },
    { type: 'response.completed', response: { id: 'local-response', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

function message(text: string): Record<string, unknown> {
  return { type: 'message', role: 'assistant', id: 'message', content: [{ type: 'output_text', text }] };
}

describe('Codex native child process', () => {
  it('opens and reads a real native spawn from its original app-server process', async () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), 'codex-native-child-home-'));
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'codex-native-child-workspace-'));
    let spawns = 0;
    let childRequests = 0;
    const server = createServer((request, reply) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const input = body.input as Array<Record<string, unknown>>;
        const child = input.some((item) => item.role === 'user' && JSON.stringify(item.content).includes('CHILD_NATIVE_REQUEST'));
        const spawned = input.some((item) => item.type === 'function_call_output' && item.call_id === 'native-spawn');
        if (child) childRequests++;
        reply.setHeader('content-type', 'text/event-stream');
        reply.end(response(child ? message('CHILD_NATIVE_REPLY') : spawned ? message('PARENT_NATIVE_REPLY') : {
          type: 'function_call', id: 'spawn-item', call_id: 'native-spawn', name: 'spawn_agent', namespace: 'multi_agent_v1',
          arguments: JSON.stringify({ message: 'CHILD_NATIVE_REQUEST' }),
        }));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No local address');
    writeFileSync(path.join(codexHome, 'config.toml'), `
model = "mock-model"
model_provider = "mock_provider"
approval_policy = "never"
sandbox_mode = "read-only"
[features]
multi_agent = true
[model_providers.mock_provider]
name = "Native child fixture"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`);
    const provider = new CodexAppServerProvider({
      spawn: ({ cwd }) => {
        spawns++;
        return spawnCodexAppServer({ cwd, executable: process.env.BORGEE_CODEX_TEST_EXECUTABLE ?? 'codex', env: { CODEX_HOME: codexHome, OPENAI_API_KEY: 'local-test' } });
      },
      requestTimeoutMs: 10_000,
    });
    const parent = await provider.createSession({ sessionId: 'local-parent', cwd });
    try {
      await parent.sendMessage('Create the requested native child.');
      for await (const item of parent.observe()) {
        if (item.type !== 'observation') continue;
        if (item.event.type === 'turn_failed') throw new Error(JSON.stringify(item.event));
        if (item.event.type === 'turn_completed') break;
      }
      await expect.poll(() => childRequests, { timeout: 5_000 }).toBeGreaterThan(0);
      await expect.poll(async () => (await parent.runtimeInfo()).childSessions?.[0]?.status, { timeout: 5_000 }).toBe('idle');
      const info = await parent.runtimeInfo();
      const descriptor = info.childSessions![0]!;
      expect(descriptor).toMatchObject({ parentCallId: 'native-spawn', observation: 'live' });
      const child = await provider.openChildSession(info.sessionId!, descriptor.nativeSessionId);
      const text: string[] = [];
      for await (const item of child.observe()) {
        if (item.type !== 'observation') continue;
        if (item.event.type === 'timeline' && item.event.item.type === 'assistant_message') text.push(item.event.item.text);
        if (text.join('').includes('CHILD_NATIVE_REPLY')) break;
      }
      expect(text.join('')).toContain('CHILD_NATIVE_REPLY');
      expect(spawns).toBe(1);
      await child.dispose();
      expect((await parent.runtimeInfo()).childSessions?.[0]?.status).toBe('idle');
    } finally {
      await parent.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);
});

import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { AgentSessionToolNamespace } from '@orchardworks/agent-provider-sdk';
import { CodexAppServerProvider } from './provider.js';

type Item = Record<string, unknown>;
type Body = { tools?: unknown[]; input?: Array<{ type?: string }> };
const schema = { type: 'object', properties: { role: { type: 'string' } }, required: ['role'], additionalProperties: false };

// A scripted model that emits one output item per completed tool output, then a final message.
async function run(model: string, deferred: boolean, steps: Item[]) {
  const executable = process.env.BORGEE_CODEX_TEST_EXECUTABLE ?? 'codex';
  expect(execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim()).toMatch(/^codex-cli \d+\.\d+\.\d+/);
  const home = mkdtempSync(path.join(os.tmpdir(), 'codex-namespaces-home-'));
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'codex-namespaces-workspace-')));
  const bodies: Body[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Body;
      bodies.push(body);
      const done = (body.input ?? []).filter(item => ['function_call_output', 'tool_search_output'].includes(item.type ?? '')).length;
      const item = steps[done] ?? { type: 'message', role: 'assistant', id: 'final', content: [{ type: 'output_text', text: 'NAMESPACES_DONE' }] };
      const events = [{ type: 'response.created', response: { id: `r-${done}` } }, { type: 'response.output_item.done', item },
        { type: 'response.completed', response: { id: `r-${done}`, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as { port: number };
  writeFileSync(path.join(home, 'config.toml'), `model = "${model}"
model_provider = "fixture"
[model_providers.fixture]
name = "Namespace fixture"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`);
  const calls: unknown[] = [];
  const namespaces: AgentSessionToolNamespace[] = [{ name: 'agent_remote', description: 'Agent Remote Control: call for support from other sessions and models.', deferred,
    tools: [{ name: 'call_for_support', description: 'Call for support from other sessions: reviewers, consultants, testers.', inputSchema: schema,
      execute: async args => { calls.push(args); return 'CALL_ACCEPTED call-123'; } }] }];
  const provider = new CodexAppServerProvider({ executable, env: { CODEX_HOME: home, OPENAI_API_KEY: 'local-namespaces' }, requestTimeoutMs: 10_000 });
  const session = await provider.createSession({ sessionId: 'namespaces', cwd, model, toolNamespaces: namespaces });
  try {
    const stream = session.observe()[Symbol.asyncIterator]();
    await session.sendMessage('Call for support.');
    for (;;) {
      const next = await stream.next();
      if (next.done || next.value.type === 'observation' && ['turn_completed', 'turn_failed', 'turn_canceled'].includes(next.value.event.type)) break;
    }
    return { bodies, calls };
  } finally {
    await session.dispose(); await provider.dispose?.();
    server.close(); rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true });
  }
}

const mentions = (value: unknown) => JSON.stringify(value ?? []).includes('call_for_support');
const call = { type: 'function_call', call_id: 'call-support', namespace: 'agent_remote', name: 'call_for_support', arguments: JSON.stringify({ role: 'code reviewer' }) };
const outputs = (bodies: Body[], type: string) => bodies.flatMap(body => (body.input ?? []).filter(item => item.type === type));

it('hides a deferred namespace until the model searches for it, then runs its tool', async () => {
  const { bodies, calls } = await run('gpt-5.5', true, [
    { type: 'tool_search_call', call_id: 'search-support', execution: 'client', arguments: { query: 'call for support reviewers', limit: 3 } }, call]);
  expect(mentions(bodies[0]!.tools)).toBe(false);
  expect(mentions(outputs(bodies, 'tool_search_output'))).toBe(true);
  expect(calls).toEqual([{ role: 'code reviewer' }]);
  expect(JSON.stringify(outputs(bodies, 'function_call_output'))).toContain('CALL_ACCEPTED call-123');
}, 60_000);

it('offers a direct namespace from the first request', async () => {
  const { bodies, calls } = await run('mock-model', false, [call]);
  expect(mentions(bodies[0]!.tools)).toBe(true);
  expect(calls).toEqual([{ role: 'code reviewer' }]);
  expect(JSON.stringify(outputs(bodies, 'function_call_output'))).toContain('CALL_ACCEPTED call-123');
}, 60_000);

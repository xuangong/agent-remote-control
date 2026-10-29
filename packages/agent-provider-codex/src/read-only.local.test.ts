import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { AgentStreamEvent } from '@orchardworks/agent-provider-sdk';
import { CodexAppServerProvider } from './provider.js';

// The model tries to write the workspace and its git repository, then reads it.
const steps = [
  'echo shell > shell.txt; echo exit=$?',
  'git commit --allow-empty -qm sneaky; echo exit=$?',
  'git show HEAD:existing.txt && cat existing.txt',
];

it('runs a read-only session whose commands cannot write the workspace and never ask for approval', async () => {
  const executable = process.env.BORGEE_CODEX_TEST_EXECUTABLE ?? 'codex';
  expect(execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim()).toMatch(/^codex-cli \d+\.\d+\.\d+/);
  const home = mkdtempSync(path.join(os.tmpdir(), 'codex-read-only-home-'));
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'codex-read-only-workspace-')));
  writeFileSync(path.join(cwd, 'existing.txt'), 'original\n');
  execFileSync('git', ['init', '-q'], { cwd }); execFileSync('git', ['add', '.'], { cwd });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { input?: Array<{ type?: string }> };
      const done = (body.input ?? []).filter(item => item.type === 'function_call_output').length;
      const item = done < steps.length
        ? { type: 'function_call', call_id: `command-${done}`, name: 'exec_command', arguments: JSON.stringify({ cmd: steps[done], max_output_tokens: 400 }) }
        : { type: 'message', role: 'assistant', id: 'final', content: [{ type: 'output_text', text: 'READ_ONLY_DONE' }] };
      const events = [{ type: 'response.created', response: { id: `r-${done}` } }, { type: 'response.output_item.done', item },
        { type: 'response.completed', response: { id: `r-${done}`, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as { port: number };
  writeFileSync(path.join(home, 'config.toml'), `model = "mock-model"
model_provider = "fixture"
[model_providers.fixture]
name = "Read-only fixture"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`);
  const provider = new CodexAppServerProvider({ executable, env: { CODEX_HOME: home, OPENAI_API_KEY: 'local-read-only' }, requestTimeoutMs: 10_000 });
  const session = await provider.createSession({ sessionId: 'read-only', cwd, model: 'mock-model', access: 'read_only' });
  try {
    const events: AgentStreamEvent[] = [];
    const stream = session.observe()[Symbol.asyncIterator]();
    await session.sendMessage('Run the steps.');
    for (;;) {
      const next = await stream.next();
      if (next.done) break;
      if (next.value.type !== 'observation') continue;
      events.push(next.value.event);
      if (['turn_completed', 'turn_failed', 'turn_canceled'].includes(next.value.event.type)) break;
    }
    expect(events.some(event => event.type === 'interaction_requested')).toBe(false);
    expect(existsSync(path.join(cwd, 'shell.txt'))).toBe(false);
    expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd, encoding: 'utf8' }).trim()).toBe('1');
    expect(readFileSync(path.join(cwd, 'existing.txt'), 'utf8')).toBe('original\n');
    const output = JSON.stringify(events);
    expect(output).toContain('operation not permitted');
    expect(output).toMatch(/original\\noriginal/);
  } finally {
    await session.dispose(); await provider.dispose?.();
    server.close(); rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);

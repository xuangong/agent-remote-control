import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentSession, AgentStreamEvent, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { CodexAppServerProvider } from './provider.js';
import { spawnCodexAppServer } from './native.js';

// A real app-server interprets these model tool calls; the fixture never emits question RPCs.
async function fixture(feature?: boolean) {
  const executable = process.env.BORGEE_CODEX_TEST_EXECUTABLE ?? 'codex';
  expect(execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()).toBe('codex-cli 0.148.0');
  const home = mkdtempSync(join(tmpdir(), 'codex-default-question-'));
  let ordinal = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const id = ++ordinal;
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const input = body.input ?? [];
      const lastUser = input.findLastIndex((item: any) => item.role === 'user');
      const prompt = JSON.stringify(input[lastUser]);
      const answer = input.slice(lastUser + 1).find((item: any) => item.type === 'function_call_output' && item.call_id?.startsWith('question-'));
      const item = answer || prompt.includes('Follow up') ? {
        type: 'message', role: 'assistant', id: `final-${id}`,
        content: [{ type: 'output_text', text: answer ? `ANSWER: ${answer.output}` : 'FOLLOW_UP_OK' }],
      } : {
        type: 'function_call', call_id: `question-${id}`, name: 'request_user_input',
        arguments: JSON.stringify({ questions: [{ id: 'profession', header: 'Profession', question: 'Choose a profession',
          options: [{ label: 'Engineer', description: 'Build systems' }, { label: 'Designer', description: 'Design products' }] }] }),
      };
      const events = [
        { type: 'response.created', response: { id: `response-${id}` } },
        { type: 'response.output_item.done', item },
        { type: 'response.completed', response: { id: `response-${id}`, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const config = `model = "mock-model"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "read-only"
${feature === undefined ? '' : `[features]\ndefault_mode_request_user_input = ${feature}\n`}
[model_providers.fixture]
name = "Local question fixture"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`;
  writeFileSync(join(home, 'config.toml'), config);
  const native: any[] = [];
  const provider = new CodexAppServerProvider({ requestTimeoutMs: 5000, spawn: () => {
    const child = spawnCodexAppServer({ executable, cwd: home, env: { CODEX_HOME: home, OPENAI_API_KEY: 'local-fixture' } });
    let buffered = '';
    child.stdout.on('data', chunk => {
      buffered += String(chunk);
      const lines = buffered.split('\n'); buffered = lines.pop() ?? '';
      for (const line of lines) if (line) native.push(JSON.parse(line));
    });
    return child;
  } });
  return { home, provider, native, async close() {
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(config);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  } };
}

async function until(stream: AsyncIterator<ProviderStreamItem>, predicate: (event: AgentStreamEvent) => boolean) {
  const events: AgentStreamEvent[] = [];
  while (true) {
    const next = await stream.next();
    if (next.done) throw new Error('Session ended before expected event');
    if (next.value.type !== 'observation') continue;
    events.push(next.value.event);
    if (predicate(next.value.event)) return events;
    if (next.value.event.type === 'turn_failed' || next.value.event.type === 'turn_completed') {
      throw new Error(`Turn ended before expected event: ${JSON.stringify(events)}`);
    }
  }
}

function assistantText(events: AgentStreamEvent[]): string {
  return events.flatMap(event => event.type === 'timeline' && event.item.type === 'assistant_message' ? [event.item.text] : []).join('');
}

async function ask(session: AgentSession, stream: AsyncIterator<ProviderStreamItem>) {
  await session.sendMessage('Ask about my profession.');
  const events = await until(stream, event => event.type === 'interaction_requested');
  const event = events.at(-1)!;
  if (event.type !== 'interaction_requested' || event.request.kind !== 'question') throw new Error('Expected question');
  return event.request;
}

const answer = { kind: 'question' as const, answers: [{ questionId: 'profession', selectedValues: ['Engineer'] }] };

describe('Native Default questions', () => {
  it.each([undefined, false])('asks, answers, resumes an old handle, cancels and continues in Default with profile flag %s', async feature => {
    const f = await fixture(feature);
    let session: AgentSession | undefined;
    try {
      session = await f.provider.createSession({ sessionId: 'question', cwd: f.home, model: 'mock-model', planning: false });
      let stream = session.observe()[Symbol.asyncIterator]();
      const question = await ask(session, stream);
      await session.respondToInteraction!(question.requestId, answer);
      const completed = await until(stream, event => event.type === 'turn_completed');
      expect(completed.filter(event => event.type === 'interaction_resolved')).toHaveLength(1);
      expect(assistantText(completed)).toContain('Engineer');
      await expect(session.respondToInteraction!(question.requestId, answer)).rejects.toThrow('No pending');
      const handle = (await session.runtimeInfo()).persistence!;
      await session.dispose();
      // Catalog opens after a Host restart have no stored adapter settings, including pre-fix sessions.
      session = await f.provider.resumeSession({ ...handle, opaque: '{}' });
      stream = session.observe()[Symbol.asyncIterator]();
      while ((await stream.next()).value?.type !== 'history_boundary') { /* drain history */ }
      const resumedQuestion = await ask(session, stream);
      await session.respondToInteraction!(resumedQuestion.requestId, answer);
      const resumedAnswer = await until(stream, event => event.type === 'turn_completed');
      expect(assistantText(resumedAnswer)).toContain('Engineer');
      expect(resumedAnswer.filter(event => event.type === 'interaction_resolved')).toHaveLength(1);
      const canceled = await ask(session, stream);
      await session.cancel!();
      const cancellation = await until(stream, event => event.type === 'turn_canceled');
      if (!cancellation.some(event => event.type === 'interaction_resolved')) {
        cancellation.push(...await until(stream, event => event.type === 'interaction_resolved'));
      }
      expect(cancellation.filter(event => event.type === 'interaction_resolved')).toHaveLength(1);
      await expect(session.respondToInteraction!(canceled.requestId, answer)).rejects.toThrow('No pending');
      await session.sendMessage('Follow up normally.');
      expect(assistantText(await until(stream, event => event.type === 'turn_completed'))).toBe('FOLLOW_UP_OK');
      const nativeQuestions = f.native.filter(message => message.method === 'item/tool/requestUserInput');
      expect(nativeQuestions).toHaveLength(3);
      expect(nativeQuestions.every(message => message.params.isBlocking === false)).toBe(true);
      const info = await session.runtimeInfo();
      expect(info.planning?.active).toBe(false);
      expect(info.settings?.find(setting => setting.id === 'approval')?.value).toBe('never');
      expect(info.settings?.find(setting => setting.id === 'sandbox')?.value).toBe('readOnly');
      const turns = f.native.filter(message => message.method === 'turn/started');
      expect(turns.length).toBeGreaterThanOrEqual(3);
    } finally { await session?.dispose(); await f.close(); }
  }, 30_000);
});

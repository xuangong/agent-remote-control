import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { AgentSession, AgentSessionHostAccess, AgentStreamEvent } from '@orchardworks/agent-provider-sdk';
import { ClaudeAgentProvider } from '@orchardworks/agent-provider-claude';
import { CodexAppServerProvider } from '@orchardworks/agent-provider-codex';
import { nativeFixture, nativeReply } from '../../agent-provider-claude/src/test-utils/native-fixture.js';
import { handleSessionCall, listenSessionCalls, sessionCallerEndpoint, SessionCallerStore, SESSION_SOCKET_VARIABLE, SESSION_TOKEN_VARIABLE,
  type SessionCallerCatalog, type SessionCallerRef } from './session-callers.js';
import { controllerSkills } from './session-skills.js';

// The built CLI, run by the session's own shell inside its native sandbox.
const command = `"${process.execPath}" "${resolve('dist/cli.js')}" session`;
const steps = [`${command} read self`, `${command} list --limit 5`];
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** A Controller endpoint whose catalog holds only the calling session. */
async function controller(ref: SessionCallerRef): Promise<AgentSessionHostAccess> {
  const state = await mkdtemp(join(tmpdir(), 'arc-session-commands-'));
  cleanup.push(() => rm(state, { recursive: true, force: true }));
  const store = new SessionCallerStore(join(state, 'callers.json'));
  const endpoint = await sessionCallerEndpoint(state);
  const token = (await store.issue(ref))!;
  const summary = { ...ref, title: 'Native fixture', workspace: state, createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', state: 'running' as const };
  const catalog: SessionCallerCatalog = { providers: () => [ref.providerId], sessions: async () => [summary],
    session: async target => target.nativeSessionId === ref.nativeSessionId ? summary : undefined,
    history: async () => ({ entries: [{ id: 'entry', turnId: 'turn', role: 'user', text: 'NATIVE_HISTORY', textOffset: 0, totalChars: 14 }] }),
    liveState: () => 'running' };
  const server = await listenSessionCalls(endpoint.listen, input => handleSessionCall(input, { store, catalog, hostId: async () => 'local-host' }));
  cleanup.push(() => server.close());
  return { environment: { [SESSION_TOKEN_VARIABLE]: token, [SESSION_SOCKET_VARIABLE]: endpoint.access }, unixSockets: [endpoint.access] };
}

async function runTurn(session: AgentSession, approve: boolean): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  const stream = session.observe()[Symbol.asyncIterator]();
  await session.sendMessage('Run the session commands.');
  for (;;) {
    const next = await stream.next();
    if (next.done) break;
    if (next.value.type !== 'observation') continue;
    const event = next.value.event;
    events.push(event);
    if (event.type === 'interaction_requested' && approve && event.request.kind === 'tool_approval') {
      await session.respondToInteraction(event.request.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'once' });
    }
    if (['turn_completed', 'turn_failed', 'turn_canceled'].includes(event.type)) break;
  }
  return events;
}

const toolResults = (body: any): unknown[] => (body.messages ?? []).flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
  .filter((part: any) => part?.type === 'tool_result');

it.each([['restricted', false], ['read-only', true]] as const)('a %s Claude session identifies itself and lists sessions from its sandboxed shell', async (_mode, readOnly) => {
  const fixture = await nativeFixture((body, response) => {
    const done = toolResults(body).length;
    nativeReply(response, done < steps.length
      ? [{ type: 'tool_use', id: `session-command-${done}`, name: 'Bash', input: { command: steps[done], description: 'Session command' } }]
      : [{ type: 'text', text: 'SESSION_COMMANDS_DONE' }]);
  });
  cleanup.push(() => fixture.close());
  const hostAccess = { ...await controller({ providerId: 'claude', nativeSessionId: 'fixture-session' }), skills: await controllerSkills() };
  const provider = new ClaudeAgentProvider({ ...fixture.options, restrictedNative: true, requestTimeoutMs: 15_000 });
  const session = await provider.createSession({ sessionId: 'ignored', cwd: fixture.cwd, model: 'claude-sonnet-4-5-20250929', hostAccess, ...(readOnly ? { access: 'read_only' as const } : {}) });
  cleanup.push(() => session.dispose());
  expect((await session.listCommands!()).map(entry => entry.name)).toContain('agent-remote:agent-remote');
  const events = await runTurn(session, true);
  expect(events.some(event => event.type === 'turn_completed')).toBe(true);
  const outputs = JSON.stringify(toolResults(fixture.bodies.at(-1)));
  expect(outputs).toContain('local-host/claude/fixture-session');
  expect(outputs).toContain('NATIVE_HISTORY');
  expect(outputs).toMatch(/\\"self\\": true/);
  expect(outputs).not.toContain('controller_unreachable');
}, 90_000);

async function codexFixture(commands: readonly string[] = steps) {
  const home = await mkdtemp(join(tmpdir(), 'arc-session-commands-codex-home-'));
  const cwd = await mkdtemp(join(tmpdir(), 'arc-session-commands-codex-work-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }), () => rm(cwd, { recursive: true, force: true }));
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { input?: Array<{ type?: string }> };
      const done = (body.input ?? []).filter(item => item.type === 'function_call_output').length;
      const item = done < commands.length
        ? { type: 'function_call', call_id: `session-command-${done}`, name: 'exec_command', arguments: JSON.stringify({ cmd: commands[done], max_output_tokens: 2000 }) }
        : { type: 'message', role: 'assistant', id: 'final', content: [{ type: 'output_text', text: 'SESSION_COMMANDS_DONE' }] };
      const events = [{ type: 'response.created', response: { id: `r-${done}` } }, { type: 'response.output_item.done', item },
        { type: 'response.completed', response: { id: `r-${done}`, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise(done => server.close(done)));
  const { port } = server.address() as { port: number };
  await writeFile(join(home, 'config.toml'), `model = "mock-model"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Session commands fixture"\n`
    + `base_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  const executable = process.env.BORGEE_CODEX_TEST_EXECUTABLE ?? 'codex';
  expect(execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim()).toMatch(/^codex-cli \d+\.\d+\.\d+/);
  const provider = new CodexAppServerProvider({ executable, env: { CODEX_HOME: home, OPENAI_API_KEY: 'local-session-commands' }, requestTimeoutMs: 15_000 });
  cleanup.push(async () => provider.dispose?.());
  return { provider, cwd, home };
}

it('a read-only Codex session reaches the Controller through its permission profile, and nothing else on the network', async () => {
  const { provider, cwd, home } = await codexFixture([...steps, 'curl -s -o /dev/null -w "NETWORK_STATUS=%{http_code}" --max-time 8 https://example.com; echo " NETWORK_EXIT=$?"']);
  const hostAccess = { ...await controller({ providerId: 'codex', nativeSessionId: 'fixture-thread' }), skills: await controllerSkills() };
  const session = await provider.createSession({ sessionId: 'ignored', cwd, model: 'mock-model', access: 'read_only', hostAccess });
  cleanup.push(() => session.dispose());
  const output = JSON.stringify(await runTurn(session, false));
  expect(output).toContain('local-host/codex/fixture-thread');
  expect(output).toContain('NATIVE_HISTORY');
  expect(output).not.toContain('controller_unreachable');
  expect(output).toMatch(/NETWORK_STATUS=000|blocked/);
  expect(output).not.toContain('NETWORK_STATUS=200');
  expect(await readFile(join(home, 'skills', 'agent-remote', 'SKILL.md'), 'utf8')).toMatch(/^---\nname: agent-remote\n/);
}, 90_000);

it('a Codex session sandboxed by the user\'s own configuration reports the blocked socket', async () => {
  const { provider, cwd } = await codexFixture();
  const hostAccess = await controller({ providerId: 'codex', nativeSessionId: 'fixture-thread' });
  const session = await provider.createSession({ sessionId: 'ignored', cwd, model: 'mock-model', hostAccess });
  cleanup.push(() => session.dispose());
  const output = JSON.stringify(await runTurn(session, false));
  expect(output).toContain('controller_unreachable');
  expect(output).not.toContain('local-host/codex/fixture-thread');
}, 90_000);

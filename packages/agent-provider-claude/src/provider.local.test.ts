import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentSession, AgentStreamEvent, ProviderStreamItem } from '@agent-remote-controller/agent-provider-sdk';
import { ClaudeAgentProvider } from '../dist/provider.js';

function sse(content: unknown[], stopReason: string): string {
  const id = `message-${Math.random().toString(36).slice(2)}`;
  const events: unknown[] = [{ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5-20250929',
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }];
  for (const [index, value] of content.entries()) {
    const block = value as any;
    events.push({ type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
    if (block.type === 'text') {
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text.slice(0, 6) } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text.slice(6) } });
    } else events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    events.push({ type: 'content_block_stop', index });
  }
  events.push({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' });
  return events.map((event: any) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

async function messagesServer(workspace: string) {
  let calls = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      if (request.url?.includes('count_tokens')) { response.setHeader('content-type', 'application/json'); response.end('{"input_tokens":10}'); return; }
      if (!request.url?.startsWith('/v1/messages')) { response.writeHead(404); response.end(); return; }
      calls++;
      const body = JSON.parse(Buffer.concat(chunks).toString()) as any;
      const last = body.messages.at(-1);
      const text = typeof last?.content === 'string' ? last.content : (last?.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join(' ');
      if (text.includes('WAIT_FOR_INTERRUPT')) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); return; }
      const content = text.includes('SPAWN_NATIVE_CHILD')
        ? [{ type: 'tool_use', id: 'native-agent', name: body.tools.find((tool: any) => ['Agent', 'Task'].includes(tool.name))?.name ?? 'Agent',
          input: { description: 'Review fixture', prompt: 'CHILD_FIXTURE_TASK', subagent_type: 'general-purpose' } }]
        : text.includes('USE_WRITE_TOOL')
        ? [{ type: 'tool_use', id: 'native-write', name: 'Write', input: { file_path: join(workspace, 'output.txt'), content: 'CLAUDE_TOOL_OK' } }]
        : [{ type: 'text', text: 'LOCAL_CLAUDE_OK' }];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(sse(content, content[0]?.type === 'tool_use' ? 'tool_use' : 'end_turn'));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return { url: `http://127.0.0.1:${address.port}`, calls: () => calls,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

async function turn(session: AgentSession, iterator: AsyncIterator<ProviderStreamItem>) {
  const events: AgentStreamEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) throw new Error('Session ended before turn completion');
    if (next.value.type !== 'observation') continue;
    const event = next.value.event;
    events.push(event);
    if (event.type === 'interaction_requested' && event.request.kind === 'tool_approval') {
      await session.respondToInteraction(event.request.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'once' });
    }
    if (['turn_completed', 'turn_failed', 'turn_canceled'].includes(event.type)) return events;
  }
}

describe('Claude Code native process', () => {
  it('streams multiple turns, approves a real tool, resumes native history and interrupts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-provider-home-'));
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'claude-provider-workspace-')));
    const api = await messagesServer(cwd);
    const diagnostic: string[] = [];
    const provider = new ClaudeAgentProvider({ executable: process.env.AGENT_CLAUDE_TEST_EXECUTABLE ?? 'claude', requestTimeoutMs: 15_000,
      onDiagnostic: (line) => diagnostic.push(line), env: { CLAUDE_CONFIG_DIR: home, ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: 'local-claude-test', ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined,
        CLAUDE_CODE_USE_BEDROCK: undefined, CLAUDE_CODE_USE_VERTEX: undefined, CLAUDE_CODE_USE_FOUNDRY: undefined,
        DISABLE_NON_ESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } });
    let session: AgentSession | undefined;
    try {
      const skillDir = join(cwd, '.claude/skills/fixture-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), '---\nname: fixture-skill\ndescription: Native fixture skill\n---\nReply briefly to the supplied request.\n');
      session = await provider.createSession({ sessionId: 'host-proposal', cwd, model: 'claude-sonnet-4-5-20250929' });
      const id = (await session.runtimeInfo()).sessionId!;
      expect(id).not.toBe('host-proposal');
      const output = session.observe()[Symbol.asyncIterator]();
      expect((await output.next()).value).toEqual({ type: 'history_boundary' });
      await session.sendMessage('Say hello');
      const first = await turn(session, output);
      expect(first.at(-1), JSON.stringify(first)).toMatchObject({ type: 'turn_completed' });
      expect(first.flatMap((event) => event.type === 'timeline' && event.item.type === 'assistant_message' ? [event.item.text] : []).join('')).toBe('LOCAL_CLAUDE_OK');
      const skill = (await session.listCommands!()).find(({ name }) => name === 'fixture-skill');
      expect(skill).toMatchObject({ kind: 'skill' });
      await session.executeCommand!(skill!.id, 'Inspect this fixture');
      expect((await turn(session, output)).at(-1)).toMatchObject({ type: 'turn_completed' });
      await session.sendMessage('SPAWN_NATIVE_CHILD');
      const spawned = await turn(session, output);
      expect(spawned.at(-1)).toMatchObject({ type: 'turn_completed' });
      await expect.poll(async () => (await session!.runtimeInfo()).childSessions?.length).toBe(1);
      await expect.poll(async () => (await session!.runtimeInfo()).childSessions?.[0]?.status).toBe('closed');
      expect(spawned.filter((event) => event.type === 'timeline' && event.item.type === 'assistant_message').map((event: any) => event.item.text).join('')).toBe('LOCAL_CLAUDE_OK');
      const nativeChild = (await session.runtimeInfo()).childSessions![0]!;
      const child = await provider.openChildSession(id, nativeChild.nativeSessionId);
      expect(child.capabilities.sendMessage).toBe(false);
      const childOutput = child.observe()[Symbol.asyncIterator]();
      const childItems: ProviderStreamItem[] = [];
      for (;;) { const next = await childOutput.next(); if (next.done || next.value.type === 'history_boundary') break; childItems.push(next.value); }
      expect(childItems).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: 'timeline', item: expect.objectContaining({ type: 'assistant_message', text: 'LOCAL_CLAUDE_OK' }) }) }));
      await child.dispose();
      await session.sendMessage('USE_WRITE_TOOL');
      const second = await turn(session, output);
      expect(second.at(-1), JSON.stringify(second)).toMatchObject({ type: 'turn_completed' });
      expect(second.some((event) => event.type === 'interaction_requested')).toBe(true);
      expect(second).toContainEqual(expect.objectContaining({ type: 'timeline', item: expect.objectContaining({ type: 'tool_call', callId: 'native-write', status: 'completed' }) }));
      expect(await readFile(join(cwd, 'output.txt'), 'utf8')).toBe('CLAUDE_TOOL_OK');
      const handle = (await session.runtimeInfo()).persistence!;
      await session.dispose();
      const catalog = await provider.listSessions();
      expect(catalog, JSON.stringify({ catalog, cwd })).toContainEqual(expect.objectContaining({ nativeSessionId: id, workspace: cwd }));
      session = await provider.resumeSession(handle);
      expect((await session.runtimeInfo()).childSessions).toContainEqual(expect.objectContaining({ nativeSessionId: nativeChild.nativeSessionId, observation: 'saved_history' }));
      const resumed = session.observe()[Symbol.asyncIterator]();
      const history: ProviderStreamItem[] = [];
      for (;;) { const next = await resumed.next(); if (next.done || next.value.type === 'history_boundary') break; history.push(next.value); }
      expect(history).toContainEqual(expect.objectContaining({ delivery: 'history', event: expect.objectContaining({ type: 'timeline', item: expect.objectContaining({ type: 'assistant_message', text: 'LOCAL_CLAUDE_OK' }) }) }));
      await session.sendMessage('Say hello again');
      expect((await turn(session, resumed)).at(-1)).toMatchObject({ type: 'turn_completed' });
      const before = api.calls();
      await session.sendMessage('WAIT_FOR_INTERRUPT');
      await expect.poll(() => api.calls()).toBeGreaterThan(before);
      await session.cancel();
      expect((await turn(session, resumed)).at(-1)).toMatchObject({ type: 'turn_canceled' });
      expect((await session.runtimeInfo()).status).toBe('idle');
    } catch (error) { throw new Error(`${error instanceof Error ? error.stack : error}\nNative diagnostics: ${diagnostic.join('\n').slice(-4000)}`); }
    finally { await session?.dispose(); await api.close(); await rm(home, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true }); }
  }, 10_000);
});

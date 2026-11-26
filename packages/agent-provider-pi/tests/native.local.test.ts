import { describe, expect, it } from 'vitest';
import type { AgentSessionTool, AgentStreamEvent } from '@orchardworks/agent-provider-sdk';
import { fixture, observe, reply, waitFor, type ModelRequest } from '../src/test-utils/native-fixture.js';

/**
 * The adapter over the real pi CLI, against a scripted model on loopback and a temporary profile (`src/test-utils/native-fixture.ts`):
 * the process tier. A fixture proves the adapter's use of pi's RPC and extension protocol; it does not prove an online model workflow.
 */
const call = (name: string, args: object) => ({ name, arguments: args });
const turns = (seen: ReturnType<typeof observe>, count: number) => waitFor(() => seen.events().filter(event => event.type === 'turn_completed').length >= count, `${count} completed turn(s)`);
const requested = (seen: ReturnType<typeof observe>, count: number) => waitFor(() => seen.events().filter(event => event.type === 'interaction_requested').length >= count, `${count} approval request(s)`);
const nthRequest = (seen: ReturnType<typeof observe>, at: number) => {
  const event = seen.events().filter((candidate): candidate is Extract<AgentStreamEvent, { type: 'interaction_requested' }> => candidate.type === 'interaction_requested')[at];
  if (!event) throw new Error('No such interaction request.');
  return event.request;
};
const toolNames = (request: ModelRequest) => (request.tools ?? []).map(tool => tool.function.name);

describe('the adapter over the real pi', () => {
  it('runs a turn with a tool call, keeps the same rows when the session is opened again, and lists it', async () => {
    const f = await fixture((body, res, index) => reply(res, body, index === 1 ? call('bash', { command: 'echo NATIVE_OK' }) : 'ALL DONE'));
    try {
      const session = await f.provider.createSession({ sessionId: 'a', cwd: f.cwd, yolo: true });
      const seen = observe(session);
      await session.sendMessage('Say it');
      await turns(seen, 1);
      expect(f.errors).toEqual([]);
      const live = seen.timeline().map(row => row.item);
      expect(live.map(item => item.type)).toEqual(['user_message', 'tool_call', 'assistant_message']);
      expect(live[1]).toMatchObject({ type: 'tool_call', status: 'completed', detail: { type: 'shell', command: 'echo NATIVE_OK' }, result: { content: [{ text: expect.stringContaining('NATIVE_OK') }] } });
      expect(live[2]).toMatchObject({ type: 'assistant_message', text: 'ALL DONE' });
      await waitFor(() => seen.events().some(event => event.type === 'usage_updated'), 'usage');
      const handle = (await session.runtimeInfo()).persistence!;
      expect((await f.provider.listSessions()).map(entry => [entry.nativeSessionId, entry.title])).toEqual([[handle.sessionId, 'Say it']]);
      await session.dispose(); await seen.done;
      const resumed = await f.provider.resumeSession(handle);
      const again = observe(resumed);
      await waitFor(() => again.items.some(item => item.type === 'history_boundary'));
      expect(again.timeline().map(row => row.item)).toEqual(live);
      await resumed.dispose(); await again.done;
    } finally { await f.close(); }
  }, 60_000);

  it('asks before a tool runs, runs it after the person allows it, and blocks it with the reason after a denial', async () => {
    const f = await fixture((body, res, index) => reply(res, body, index === 1 ? call('bash', { command: 'echo ALLOWED_OK' }) : index === 2 ? call('bash', { command: 'echo DENIED_NOT_RUN' }) : 'FINISHED'));
    try {
      const session = await f.provider.createSession({ sessionId: 'a', cwd: f.cwd });
      const seen = observe(session);
      await session.sendMessage('Run two commands');
      await requested(seen, 1);
      expect(nthRequest(seen, 0)).toMatchObject({ kind: 'tool_approval', toolName: 'bash', summary: 'Run: echo ALLOWED_OK' });
      await session.respondToInteraction(nthRequest(seen, 0).requestId, { kind: 'tool_approval', decision: 'allow', scope: 'once' });
      await requested(seen, 2);
      await session.respondToInteraction(nthRequest(seen, 1).requestId, { kind: 'tool_approval', decision: 'deny', message: 'Not this one.' });
      await turns(seen, 1);
      const tools = seen.timeline().map(row => row.item).filter(item => item.type === 'tool_call');
      expect(tools[0]).toMatchObject({ status: 'completed', result: { content: [{ text: expect.stringContaining('ALLOWED_OK') }] } });
      expect(tools[1]).toMatchObject({ status: 'failed', error: expect.stringContaining('Not this one.') });
      expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain('Not this one.');
      expect(JSON.stringify(f.requests.at(-1)?.messages)).not.toContain('DENIED_NOT_RUN\\n');
      expect(seen.events().filter(event => event.type === 'interaction_resolved')).toHaveLength(2);
      await session.dispose(); await seen.done;
    } finally { await f.close(); }
  }, 60_000);

  it('gives the model the Host tools, runs them in the adapter and returns their result to the model', async () => {
    const calls: unknown[] = [];
    const message: AgentSessionTool = { name: 'message', description: 'Send a message to another bot.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } }, required: ['to', 'text'], additionalProperties: false },
      execute: async args => { calls.push(args); return JSON.stringify({ outcome: 'delivered' }); } };
    const f = await fixture((body, res, index) => reply(res, body, index === 1 ? call('agent_remote__message', { to: 'chief', text: 'done' }) : 'SENT'));
    try {
      const session = await f.provider.createSession({ sessionId: 'a', cwd: f.cwd, toolNamespaces: [{ name: 'agent_remote', description: 'Bots', tools: [message] }], instructions: 'You are a bot named Rita.' });
      const seen = observe(session);
      await session.sendMessage('Report');
      await turns(seen, 1);
      expect(calls).toEqual([{ to: 'chief', text: 'done' }]);
      expect(toolNames(f.requests[0]!)).toContain('agent_remote__message');
      expect(JSON.stringify(f.requests[0]!.messages)).toContain('You are a bot named Rita.');
      expect(JSON.stringify(f.requests[1]!.messages)).toContain('delivered');
      expect(seen.events().filter(event => event.type === 'interaction_requested')).toEqual([]);
      expect(seen.timeline().map(row => row.item).find(item => item.type === 'tool_call')).toMatchObject({ name: 'agent_remote__message', status: 'completed' });
      await session.dispose(); await seen.done;
    } finally { await f.close(); }
  }, 60_000);

  it('offers tools the Host gives a running session at its next run, without reopening it', async () => {
    const calls: unknown[] = [];
    const message: AgentSessionTool = { name: 'message', description: 'Send a message to another bot.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      execute: async args => { calls.push(args); return 'delivered'; } };
    const f = await fixture((body, res, index) => reply(res, body, index === 2 ? call('agent_remote__message', { text: 'now a bot' }) : index === 3 ? 'SENT' : 'PLAIN'));
    try {
      const session = await f.provider.createSession({ sessionId: 'a', cwd: f.cwd });
      const seen = observe(session);
      await session.sendMessage('plain'); await turns(seen, 1);
      expect(toolNames(f.requests[0]!)).not.toContain('agent_remote__message');
      await session.updateToolNamespaces!([{ name: 'agent_remote', description: 'Bots', tools: [message] }]);
      await session.sendMessage('now report'); await turns(seen, 2);
      expect(toolNames(f.requests[1]!)).toContain('agent_remote__message');
      expect(calls).toEqual([{ text: 'now a bot' }]);
      await session.dispose(); await seen.done;
    } finally { await f.close(); }
  }, 60_000);

  it('offers a read-only session only tools that cannot write, and its own', async () => {
    const own: AgentSessionTool = { name: 'board', description: 'Read the board.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => '{}' };
    const f = await fixture((body, res) => reply(res, body, 'READ ONLY'));
    try {
      const session = await f.provider.createSession({ sessionId: 'a', cwd: f.cwd, access: 'read_only', tools: [own] });
      const seen = observe(session);
      await session.sendMessage('Look');
      await turns(seen, 1);
      expect(toolNames(f.requests[0]!).sort()).toEqual(['board', 'find', 'grep', 'ls', 'read']);
      await session.dispose(); await seen.done;
    } finally { await f.close(); }
  }, 60_000);

  it('changes the model and the thinking level for the next request, and keeps the choice when the session is opened again', async () => {
    const f = await fixture((body, res) => reply(res, body, `FROM ${body.model}`));
    try {
      const session = await f.provider.createSession({ sessionId: 'a', cwd: f.cwd, yolo: true });
      const seen = observe(session);
      expect((await session.runtimeInfo()).settings!.find(setting => setting.id === 'model')!.options.map(option => option.value)).toEqual(['fixture/m1', 'fixture/m2']);
      await session.sendMessage('one'); await turns(seen, 1);
      await session.setSessionSetting!('model', 'fixture/m2');
      expect((await session.runtimeInfo()).model).toBe('fixture/m2');
      await session.sendMessage('two'); await turns(seen, 2);
      expect(f.requests.map(request => request.model)).toEqual(['m1', 'm2']);
      const handle = (await session.runtimeInfo()).persistence!;
      await session.dispose(); await seen.done;
      const resumed = await f.provider.resumeSession(handle);
      expect((await resumed.runtimeInfo()).model).toBe('fixture/m2');
      await resumed.dispose();
    } finally { await f.close(); }
  }, 60_000);

  it('cancels a turn that is streaming', async () => {
    let held: import('node:http').ServerResponse | undefined;
    const f = await fixture((body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'PARTIAL TEXT' }, finish_reason: null }] })}\n\n`);
      held = res;
    });
    try {
      const session = await f.provider.createSession({ sessionId: 'a', cwd: f.cwd });
      const seen = observe(session);
      await session.sendMessage('Stream for long');
      await waitFor(() => seen.events().some(event => event.type === 'timeline' && event.item.type === 'assistant_message'));
      await session.cancel!();
      await waitFor(() => seen.events().some(event => event.type === 'turn_canceled'), 'the cancellation');
      held?.end();
      expect((await session.runtimeInfo()).status).toBe('idle');
      await session.dispose(); await seen.done;
    } finally { await f.close(); }
  }, 60_000);

  it('steers a running turn with input sent while it works', async () => {
    let held: { res: import('node:http').ServerResponse; body: ModelRequest } | undefined;
    const f = await fixture((body, res, index) => { if (index === 1) held = { res, body }; else reply(res, body, 'ACK'); });
    try {
      const session = await f.provider.createSession({ sessionId: 'a', cwd: f.cwd, yolo: true });
      const seen = observe(session);
      await session.sendMessage('Start'); await waitFor(() => held, 'the first request');
      expect(await session.sendMessage('Also this')).toEqual({ disposition: 'queued' });
      reply(held!.res, held!.body, call('bash', { command: 'echo STEER_BASE' }));
      await turns(seen, 1);
      expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain('Also this');
      expect(seen.events().filter(event => event.type === 'turn_started')).toHaveLength(1);
      await session.dispose(); await seen.done;
    } finally { await f.close(); }
  }, 60_000);

  it('fails the turn with the reason when the model server errors', async () => {
    const f = await fixture((_body, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad request from fixture', type: 'invalid_request_error' } })); });
    try {
      const session = await f.provider.createSession({ sessionId: 'a', cwd: f.cwd });
      const seen = observe(session);
      await session.sendMessage('Fail');
      await waitFor(() => seen.events().some(event => event.type === 'turn_failed'), 'the failure');
      expect(seen.events().find(event => event.type === 'turn_failed')).toMatchObject({ error: expect.stringContaining('bad request from fixture') });
      expect(seen.timeline().some(row => row.item.type === 'error')).toBe(true);
      await session.dispose(); await seen.done;
    } finally { await f.close(); }
  }, 60_000);
});

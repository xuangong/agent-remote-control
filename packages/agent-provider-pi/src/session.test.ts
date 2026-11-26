import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentOperationRejectedError, AgentRuntimeError, type AgentSessionTool } from '@orchardworks/agent-provider-sdk';
import { BRIDGE_EXTENSION_SOURCE } from './bridge-extension.js';
import { FakeClock, playRun } from './test-utils/fake-pi.js';
import { follow, piHarness, uiRequest } from './test-utils/harness.js';

const open: Array<{ close(): Promise<void> }> = [];
const harness = (...args: Parameters<typeof piHarness>) => { const h = piHarness(...args); open.push(h); return h; };
afterEach(async () => { await Promise.all(open.splice(0).map(h => h.close())); });

describe('a new pi session', () => {
  it('starts pi in RPC mode in the workspace with the approval extension and no session of the user loaded, then publishes its history boundary, thread and runtime', async () => {
    const h = harness();
    const session = await h.provider.createSession({ sessionId: 'host', cwd: h.cwd, yolo: false });
    const seen = follow(session);
    await seen.until(() => seen.of('runtime_updated').length > 0, 'the runtime');
    const launch = h.fake.launches[0]!;
    expect(launch.cwd).toBe(realpathSync(h.cwd));
    expect(launch.args.slice(0, 3)).toEqual(['--mode', 'rpc', '--offline']);
    expect(launch.args).not.toContain('--session');
    expect(launch.env.PI_OFFLINE).toBe('1');
    expect(seen.items.map(item => item.type === 'observation' ? item.event.type : item.type)).toEqual(['history_boundary', 'thread_started', 'runtime_updated']);
    const info = await session.runtimeInfo();
    expect(info).toMatchObject({ providerId: 'pi', status: 'idle', model: 'fixture/m1' });
    expect(info.persistence).toMatchObject({ providerId: 'pi', sessionId: h.fake.last.sessionId });
    expect(info.settings?.map(setting => [setting.id, setting.value, setting.mutable])).toEqual([['model', 'fixture/m1', true], ['reasoning_effort', 'off', false], ['tool_approval_mode', 'ask', true]]);
    await session.dispose(); await seen.done;
  });

  it('keeps the extension and its tool declarations in a private directory that goes with the session, and nothing in the pi profile', async () => {
    const h = harness();
    const tool: AgentSessionTool = { name: 'message', description: 'Send a message.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, execute: async () => 'sent' };
    const session = await h.provider.createSession({ sessionId: 'host', cwd: h.cwd, toolNamespaces: [{ name: 'agent_remote', description: 'Bots', tools: [tool] }] });
    const extension = h.fake.launches[0]!.args[h.fake.launches[0]!.args.indexOf('-e') + 1]!;
    expect(readFileSync(extension, 'utf8')).toBe(BRIDGE_EXTENSION_SOURCE);
    const declared = JSON.parse(readFileSync(h.fake.launches[0]!.env.ARC_PI_BRIDGE_CONFIG!, 'utf8')) as { tools: Array<{ name: string }> };
    expect(declared.tools.map(entry => entry.name)).toEqual(['agent_remote__message']);
    expect(extension.startsWith(h.work)).toBe(true);
    expect(h.workDirectories()).toHaveLength(1);
    await session.dispose();
    expect(h.workDirectories()).toEqual([]);
  });

  it('starts in YOLO when the Host says so, and asks otherwise', async () => {
    const h = harness();
    const yolo = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd, yolo: true });
    const asking = await h.provider.createSession({ sessionId: 'b', cwd: h.cwd });
    expect((await yolo.runtimeInfo()).settings?.find(setting => setting.id === 'tool_approval_mode')?.value).toBe('allow');
    expect((await asking.runtimeInfo()).settings?.find(setting => setting.id === 'tool_approval_mode')?.value).toBe('ask');
  });

  it('appends the Host instructions to the system prompt and gives the Host environment to the commands it runs', async () => {
    const h = harness();
    await h.provider.createSession({ sessionId: 'a', cwd: h.cwd, instructions: 'You are a bot.', systemPrompt: 'Source rules.', hostAccess: { environment: { ARC_TOKEN: 'secret' }, unixSockets: [] } });
    const launch = h.fake.launches[0]!;
    const appended = launch.args.flatMap((arg, index) => arg === '--append-system-prompt' ? [launch.args[index + 1]] : []);
    expect(appended).toEqual(['Source rules.', 'You are a bot.']);
    expect(launch.env.ARC_TOKEN).toBe('secret');
  });

  it('gives a read-only session only the tools that cannot write, with its own, and refuses to change its permissions', async () => {
    const h = harness();
    const tool: AgentSessionTool = { name: 'board', description: 'Read.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => '{}' };
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd, access: 'read_only', tools: [tool] });
    const launch = h.fake.launches[0]!;
    expect(launch.args[launch.args.indexOf('--tools') + 1]).toBe('read,grep,find,ls,board');
    const mode = (await session.runtimeInfo()).settings!.find(setting => setting.id === 'tool_approval_mode')!;
    expect(mode.mutable).toBe(false);
    await expect(session.setSessionSetting!('tool_approval_mode', 'ask')).rejects.toThrow(/read-only/);
    expect(JSON.parse((await session.runtimeInfo()).persistence!.opaque)).toMatchObject({ access: 'read_only' });
  });

  it('opens with the model asked for, and fails when the model is not one pi has', async () => {
    const h = harness();
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd, model: 'fixture/m2', reasoningEffort: 'high' });
    expect(await session.runtimeInfo()).toMatchObject({ model: 'fixture/m2' });
    expect(h.fake.last.thinkingLevel).toBe('high');
    await expect(h.provider.createSession({ sessionId: 'b', cwd: h.cwd, model: 'fixture/zzz' })).rejects.toThrow(/Unavailable Model/);
    expect(h.fake.processes[1]!.exited).toBeDefined();
  });

  it('refuses a workspace that is not a directory', async () => {
    const h = harness();
    await expect(h.provider.createSession({ sessionId: 'a', cwd: join(h.cwd, 'missing') })).rejects.toThrow();
  });
});

describe('input', () => {
  it('starts a run with the prompt, accepted as started, and reports the turn, the usage and the idle runtime', async () => {
    const h = harness();
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd });
    const seen = follow(session);
    h.fake.script({ messages: [{ text: 'hello there' }] });
    expect(await session.sendMessage('hi')).toEqual({ disposition: 'started' });
    await seen.until(() => seen.of('turn_completed').length === 1, 'the turn');
    expect(h.fake.last.commands.find(command => command.type === 'prompt')).toMatchObject({ message: 'hi', streamingBehavior: 'steer' });
    await seen.until(() => seen.of('usage_updated').length === 1, 'usage');
    expect(seen.of('usage_updated')[0]!.usage).toMatchObject({ tokenScope: 'session', inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, totalTokens: 18, contextScope: 'current', contextWindowUsedTokens: 1000, contextWindowMaxTokens: 100000 });
    const runtimes = seen.of('runtime_updated').map(event => event.runtimeInfo.status);
    expect(runtimes.at(-1)).toBe('idle');
    expect(runtimes).toContain('running');
    await session.dispose(); await seen.done;
  });

  it('queues input sent during a run, as steering by default and as a follow-up for the next turn, and says which', async () => {
    const h = harness();
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd });
    const seen = follow(session);
    let finish!: () => void;
    h.fake.hooks.prompt = (command, process) => {
      process.emit({ id: command.id, type: 'response', command: 'prompt', success: true });
      if (!process.streaming) { process.streaming = true; process.emit({ type: 'agent_start' }); new Promise<void>(resolve => { finish = resolve; }).then(() => process.emit({ type: 'agent_end', messages: [] })); }
      return true;
    };
    await session.sendMessage('long task');
    await seen.until(() => seen.of('runtime_updated').some(event => event.runtimeInfo.status === 'running'), 'the run');
    expect(await session.sendMessage('also this')).toEqual({ disposition: 'queued' });
    expect(await session.sendMessage('after that', { delivery: 'next_turn' })).toEqual({ disposition: 'queued' });
    expect(await session.steer!('change course')).toEqual({ disposition: 'queued' });
    expect(h.fake.last.commands.filter(command => command.type === 'prompt').map(command => command.streamingBehavior)).toEqual(['steer', 'steer', 'followUp', 'steer']);
    finish();
    await session.dispose(); await seen.done;
  });

  it('does not claim to know whether input queues while a prompt it just sent has not started', async () => {
    const h = harness();
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd });
    h.fake.hooks.prompt = (command, process) => { process.emit({ id: command.id, type: 'response', command: 'prompt', success: true }); return true; };
    expect(await session.sendMessage('one')).toEqual({ disposition: 'started' });
    expect(await session.sendMessage('two')).toBeUndefined();
  });

  it('reports a prompt pi refuses as rejected, and one that times out as unknown, never retrying it', async () => {
    const h = harness({ requestTimeoutMs: 20 });
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd });
    h.fake.hooks.prompt = (command, process) => { process.emit({ id: command.id, type: 'response', command: 'prompt', success: false, error: 'No model selected' }); return true; };
    await expect(session.sendMessage('hi')).rejects.toBeInstanceOf(AgentOperationRejectedError);
    h.fake.hooks.prompt = () => true;
    await expect(session.sendMessage('hi')).rejects.toMatchObject({ code: 'native_request_timeout' });
    expect(h.fake.last.commands.filter(command => command.type === 'prompt')).toHaveLength(2);
  });

  it('sends resource references as text and refuses images', async () => {
    const h = harness();
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd });
    await session.sendMessageContent!([{ type: 'text', text: 'see' }, { type: 'resource', resourceId: 'r1', path: '/tmp/a.txt', name: 'a.txt', mediaType: 'text/plain', byteLength: 1, sha256: 'a'.repeat(64), label: 'a.txt' }]);
    expect(String(h.fake.last.commands.find(command => command.type === 'prompt')!.message)).toMatch(/^see\n<agent-resource>/);
    await expect(session.sendMessageContent!([{ type: 'image', path: '/tmp/a.png', mediaType: 'image/png', sha256: 'a'.repeat(64), label: 'a' }])).rejects.toBeInstanceOf(AgentOperationRejectedError);
  });

  it('cancels the run with abort', async () => {
    const h = harness();
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd });
    await session.cancel!();
    expect(h.fake.aborted).toBe(1);
  });

  it('lists the commands pi knows and runs one as a prompt', async () => {
    const h = harness();
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd });
    expect((await session.listCommands!()).map(command => [command.id, command.kind])).toEqual([['fix-tests', 'prompt'], ['skill:search', 'skill']]);
    await session.executeCommand!('fix-tests', 'now');
    expect(h.fake.last.commands.find(command => command.type === 'prompt')).toMatchObject({ message: '/fix-tests now' });
    await expect(session.executeCommand!('nope', '')).rejects.toBeInstanceOf(AgentOperationRejectedError);
  });
});

describe('approvals', () => {
  const ask = (h: ReturnType<typeof harness>, id: string, toolName: string, input: unknown, callId = `call-${id}`) =>
    h.fake.last.emit(uiRequest(id, { kind: 'approval', toolCallId: callId, toolName, input }));

  it('asks for a tool call, answers pi when the person allows it once, and records the resolution as a live-only item', async () => {
    const h = harness();
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd });
    const seen = follow(session);
    ask(h, 'ui-1', 'bash', { command: 'rm -rf build' });
    await seen.until(() => seen.of('interaction_requested').length === 1, 'the request');
    const request = seen.of('interaction_requested')[0]!.request;
    expect(request).toMatchObject({ kind: 'tool_approval', toolName: 'bash', toolCallId: 'call-ui-1', summary: 'Run: rm -rf build', detail: { type: 'shell', command: 'rm -rf build' }, allowedDecisions: ['allow', 'deny', 'cancel'], allowScopes: ['once', 'session'] });
    expect((await session.runtimeInfo()).status).toBe('waiting');
    await session.respondToInteraction(request.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'once' });
    expect(JSON.parse(String(h.fake.last.uiAnswers.get('ui-1')!.value))).toEqual({ allow: true });
    await seen.until(() => seen.of('interaction_resolved').length === 1, 'the resolution');
    const resolved = seen.observations().find(observation => observation.event.type === 'interaction_resolved')!;
    expect(resolved.itemIdentity).toEqual({ key: `interaction:${request.requestId}`, completes: true, liveOnly: true });
    await expect(session.respondToInteraction(request.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'once' })).rejects.toBeInstanceOf(AgentOperationRejectedError);
    await session.dispose(); await seen.done;
  });

  it('blocks the tool with the reason the person gave when they deny it, and rejects a response the request did not offer', async () => {
    const h = harness();
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd });
    const seen = follow(session);
    ask(h, 'ui-1', 'write', { path: 'a.txt', content: 'x' });
    await seen.until(() => seen.of('interaction_requested').length === 1);
    const { requestId } = seen.of('interaction_requested')[0]!.request;
    await expect(session.respondToInteraction(requestId, { kind: 'tool_approval', decision: 'allow', scope: 'policy', policyId: 'x' })).rejects.toBeInstanceOf(AgentOperationRejectedError);
    await expect(session.respondToInteraction(requestId, { kind: 'question', answers: [] })).rejects.toBeInstanceOf(AgentOperationRejectedError);
    await session.respondToInteraction(requestId, { kind: 'tool_approval', decision: 'deny', message: 'Not in this repo.' });
    expect(JSON.parse(String(h.fake.last.uiAnswers.get('ui-1')!.value))).toEqual({ allow: false, reason: 'Not in this repo.' });
    await session.dispose(); await seen.done;
  });

  it('lets a tool run unasked for the rest of the session when the person allows it for the session', async () => {
    const h = harness();
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd });
    const seen = follow(session);
    ask(h, 'ui-1', 'bash', { command: 'ls' });
    await seen.until(() => seen.of('interaction_requested').length === 1);
    await session.respondToInteraction(seen.of('interaction_requested')[0]!.request.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'session' });
    ask(h, 'ui-2', 'bash', { command: 'pwd' });
    ask(h, 'ui-3', 'write', { path: 'a', content: '' });
    await seen.until(() => seen.of('interaction_requested').length === 2);
    expect(JSON.parse(String(h.fake.last.uiAnswers.get('ui-2')!.value))).toEqual({ allow: true });
    expect(seen.of('interaction_requested')[1]!.request).toMatchObject({ toolName: 'write' });
    await session.dispose(); await seen.done;
  });

  it('cancels the run when the person cancels the approval', async () => {
    const h = harness();
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd });
    const seen = follow(session);
    ask(h, 'ui-1', 'bash', { command: 'ls' });
    await seen.until(() => seen.of('interaction_requested').length === 1);
    await session.respondToInteraction(seen.of('interaction_requested')[0]!.request.requestId, { kind: 'tool_approval', decision: 'cancel' });
    expect(JSON.parse(String(h.fake.last.uiAnswers.get('ui-1')!.value))).toMatchObject({ allow: false });
    expect(h.fake.aborted).toBe(1);
    await session.dispose(); await seen.done;
  });

  it('settles a pending approval when the run is canceled or ends, so no request outlives its run', async () => {
    const h = harness();
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd });
    const seen = follow(session);
    ask(h, 'ui-1', 'bash', { command: 'ls' });
    await seen.until(() => seen.of('interaction_requested').length === 1);
    await session.cancel!();
    await seen.until(() => seen.of('interaction_resolved').length === 1, 'the resolution');
    expect(seen.of('interaction_resolved')[0]!.response).toEqual({ kind: 'tool_approval', decision: 'cancel' });
    await session.dispose(); await seen.done;
  });

  it('answers every tool call at once in YOLO, with no interaction, and asks again after the person turns approvals back on', async () => {
    const h = harness();
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd, yolo: true });
    const seen = follow(session);
    ask(h, 'ui-1', 'bash', { command: 'ls' });
    expect(JSON.parse(String(h.fake.last.uiAnswers.get('ui-1')!.value))).toEqual({ allow: true });
    expect(seen.of('interaction_requested')).toEqual([]);
    await session.setSessionSetting!('tool_approval_mode', 'ask');
    ask(h, 'ui-2', 'bash', { command: 'ls' });
    await seen.until(() => seen.of('interaction_requested').length === 1);
    await session.dispose(); await seen.done;
  });

  it('declines the dialogs of an extension the user installed instead of leaving pi waiting', async () => {
    const h = harness();
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd });
    h.fake.last.emit({ type: 'extension_ui_request', id: 'other', method: 'confirm', title: 'Really?', message: '' });
    h.fake.last.emit({ type: 'extension_ui_request', id: 'quiet', method: 'notify', message: 'hi' });
    expect(h.fake.last.uiAnswers.get('other')).toMatchObject({ cancelled: true });
    expect(h.fake.last.uiAnswers.has('quiet')).toBe(false);
    await session.dispose();
  });
});

describe('Host tools', () => {
  const tool = (execute: (args: unknown) => Promise<string>): AgentSessionTool => ({ name: 'message', description: 'Send.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, execute });

  it('runs a tool the Host gave the session in the adapter and answers pi with its result, validating the arguments first', async () => {
    const h = harness();
    const calls: unknown[] = [];
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd, toolNamespaces: [{ name: 'agent_remote', description: 'Bots', tools: [tool(async args => { calls.push(args); return '{"outcome":"delivered"}'; })] }] });
    h.fake.last.emit(uiRequest('t1', { kind: 'tool', name: 'agent_remote__message', toolCallId: 'c1', arguments: { text: 'hi' } }));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(calls).toEqual([{ text: 'hi' }]);
    expect(JSON.parse(String(h.fake.last.uiAnswers.get('t1')!.value))).toEqual({ ok: true, text: '{"outcome":"delivered"}' });
    h.fake.last.emit(uiRequest('t2', { kind: 'tool', name: 'agent_remote__message', toolCallId: 'c2', arguments: { nope: 1 } }));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(JSON.parse(String(h.fake.last.uiAnswers.get('t2')!.value))).toMatchObject({ ok: false, error: expect.stringMatching(/Invalid arguments/) });
    h.fake.last.emit(uiRequest('t3', { kind: 'tool', name: 'ghost', toolCallId: 'c3', arguments: {} }));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(JSON.parse(String(h.fake.last.uiAnswers.get('t3')!.value))).toMatchObject({ ok: false });
    await session.dispose();
  });

  it('reports a failing tool as a failed call and a plain tool under its own name', async () => {
    const h = harness();
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd, tools: [tool(async () => { throw new Error('The receiver is gone.'); })] });
    const declared = JSON.parse(readFileSync(h.fake.launches[0]!.env.ARC_PI_BRIDGE_CONFIG!, 'utf8')) as { tools: Array<{ name: string }> };
    expect(declared.tools[0]!.name).toBe('message');
    h.fake.last.emit(uiRequest('t1', { kind: 'tool', name: 'message', toolCallId: 'c1', arguments: { text: 'x' } }));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(JSON.parse(String(h.fake.last.uiAnswers.get('t1')!.value))).toEqual({ ok: false, error: 'The receiver is gone.' });
    await session.dispose();
  });

  it('refuses tools with the same name', async () => {
    const h = harness();
    await expect(h.provider.createSession({ sessionId: 'a', cwd: h.cwd, tools: [tool(async () => ''), tool(async () => '')] })).rejects.toThrow(/valid and unique|duplicate/i);
  });
});

describe('live Host tools', () => {
  const tool = (name: string, execute: (args: unknown) => Promise<string>): AgentSessionTool => ({ name, description: `Tool ${name}.`, inputSchema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false }, execute });

  it('answers the extension\'s question for the tools the session has now, so a session given tools later offers them at its next run', async () => {
    const h = harness();
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd });
    h.fake.last.emit(uiRequest('q1', { kind: 'tools' }));
    expect(JSON.parse(String(h.fake.last.uiAnswers.get('q1')!.value))).toEqual({ tools: [] });
    await session.updateToolNamespaces!([{ name: 'agent_remote', description: 'Bots', tools: [tool('message', async () => 'sent')] }]);
    h.fake.last.emit(uiRequest('q2', { kind: 'tools' }));
    const answer = JSON.parse(String(h.fake.last.uiAnswers.get('q2')!.value)) as { tools: Array<{ name: string; description: string }> };
    expect(answer.tools.map(entry => entry.name)).toEqual(['agent_remote__message']);
    h.fake.last.emit(uiRequest('t1', { kind: 'tool', name: 'agent_remote__message', toolCallId: 'c1', arguments: { text: 'hi' } }));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(JSON.parse(String(h.fake.last.uiAnswers.get('t1')!.value))).toEqual({ ok: true, text: 'sent' });
    await session.updateToolNamespaces!([]);
    h.fake.last.emit(uiRequest('t2', { kind: 'tool', name: 'agent_remote__message', toolCallId: 'c2', arguments: {} }));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(JSON.parse(String(h.fake.last.uiAnswers.get('t2')!.value))).toMatchObject({ ok: false });
    await session.dispose();
  });

  it('refuses tools of a read-only session, whose pi has a fixed tool list, and duplicate names', async () => {
    const h = harness();
    const readOnly = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd, access: 'read_only' });
    await expect(readOnly.updateToolNamespaces!([{ name: 'ns', description: 'x', tools: [tool('t', async () => '')] }])).rejects.toBeInstanceOf(AgentOperationRejectedError);
    const session = await h.provider.createSession({ sessionId: 'b', cwd: h.cwd, tools: [tool('t', async () => '')] });
    await expect(session.updateToolNamespaces!([{ name: 'ns', description: 'x', tools: [tool('t', async () => '')] }, { name: 'ns', description: 'x', tools: [] }])).rejects.toThrow();
  });
});

describe('resuming', () => {
  const seed = (h: ReturnType<typeof harness>, id = '0f5c51e2-71e4-4ab9-b111-e054c951bc6a') => {
    const clock = new FakeClock();
    const { messages } = playRun({ prompt: 'First', messages: [{ text: 'ANSWER_1' }] }, clock);
    const file = join(h.agentDirectory, 'sessions', '--workspace--', `2026-11-26T00-00-00-000Z_${id}.jsonl`);
    return { id, file, write: () => { h.fake.save({ sessionFile: file, sessionId: id, launch: { cwd: h.cwd }, conversation: messages } as never); } };
  };

  it('reads the file into history, then the boundary, and opens pi on that file', async () => {
    const h = harness();
    const { id, file, write } = seed(h); write();
    const session = await h.provider.resumeSession({ providerId: 'pi', sessionId: id, opaque: '{}' });
    const seen = follow(session);
    await seen.until(() => seen.of('thread_started').length === 1);
    expect(h.fake.launches[0]!.args.slice(h.fake.launches[0]!.args.indexOf('--session'))[1]).toBe(file);
    const order = seen.items.map(item => item.type === 'observation' ? `${item.delivery}:${item.event.type}` : item.type);
    expect(order).toEqual(['history:timeline', 'history:turn_started', 'history:timeline', 'history:turn_completed', 'history_boundary', 'live:thread_started', 'live:runtime_updated']);
    await session.dispose(); await seen.done;
  });

  it('fails explicitly for a session pi never saved, instead of opening a new one under the old id', async () => {
    const h = harness();
    await expect(h.provider.resumeSession({ providerId: 'pi', sessionId: '0f5c51e2-71e4-4ab9-b111-e054c951bc6a', opaque: '{}' }, {}, { initializeEmpty: true })).rejects.toMatchObject({ code: 'native_session_unavailable' });
    expect(h.fake.launches).toEqual([]);
  });

  it('rejects another provider, an invalid id and a session that is already loaded', async () => {
    const h = harness();
    const { id, write } = seed(h); write();
    await expect(h.provider.resumeSession({ providerId: 'codex', sessionId: id, opaque: '{}' })).rejects.toThrow(/Invalid pi persistence handle/);
    await expect(h.provider.resumeSession({ providerId: 'pi', sessionId: '../etc', opaque: '{}' })).rejects.toThrow(/Invalid pi persistence handle/);
    const session = await h.provider.resumeSession({ providerId: 'pi', sessionId: id, opaque: '{}' });
    await expect(h.provider.resumeSession({ providerId: 'pi', sessionId: id, opaque: '{}' })).rejects.toThrow(/already loaded/);
    await session.dispose();
    await (await h.provider.resumeSession({ providerId: 'pi', sessionId: id, opaque: '{}' })).dispose();
  });

  it('fails when pi opens another session than the one asked for', async () => {
    const h = harness();
    const { id, write } = seed(h); write();
    h.fake.hooks.get_state = (command, process) => { process.emit({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'other', sessionFile: process.sessionFile, isStreaming: false, thinkingLevel: 'off', model: null } }); return true; };
    await expect(h.provider.resumeSession({ providerId: 'pi', sessionId: id, opaque: '{}' })).rejects.toMatchObject({ code: 'native_session_unavailable' });
    expect(h.fake.last.exited).toBeDefined();
  });

  it('keeps the permission mode its owner last confirmed, and a read-only session stays read-only', async () => {
    const saved = new Map<string, 'ask' | 'allow'>();
    const store = { read: async (id: string) => saved.get(id), write: async (id: string, mode: 'ask' | 'allow') => { saved.set(id, mode); } };
    const h = harness({ permissionModes: store });
    const { id, write } = seed(h); write();
    saved.set(id, 'allow');
    const session = await h.provider.resumeSession({ providerId: 'pi', sessionId: id, opaque: JSON.stringify({ access: 'read_only' }) });
    const info = await session.runtimeInfo();
    expect(info.settings!.find(setting => setting.id === 'tool_approval_mode')).toMatchObject({ value: 'allow', mutable: false });
    expect(h.fake.last.launch.args).toContain('--tools');
    await session.dispose();
    const again = await h.provider.resumeSession({ providerId: 'pi', sessionId: id, opaque: '{}' });
    await again.setSessionSetting!('tool_approval_mode', 'ask');
    expect(saved.get(id)).toBe('ask');
    await again.dispose();
  });

  it('reports an entry or role of a kind it does not know as one diagnostic and no row', async () => {
    const h = harness();
    const { id, file, write } = seed(h); write();
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    const leaf = (JSON.parse(lines.at(-1)!) as { id: string }).id;
    lines.push(JSON.stringify({ type: 'hologram', id: 'ffffffff', parentId: leaf, timestamp: '2026-11-26T00:00:00.000Z' }));
    await import('node:fs').then(fs => fs.writeFileSync(file, `${lines.join('\n')}\n`));
    const session = await h.provider.resumeSession({ providerId: 'pi', sessionId: id, opaque: '{}' });
    expect(h.diagnostics.filter(line => line.includes('native_event_unknown'))).toHaveLength(1);
    expect(h.diagnostics[0]).toContain('hologram');
    await session.dispose();
  });
});

describe('settings', () => {
  it('changes the model and the thinking level through pi and shows what pi confirms', async () => {
    const h = harness();
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd });
    await session.setSessionSetting!('model', 'fixture/m2');
    let settings = (await session.runtimeInfo()).settings!;
    expect(settings.find(setting => setting.id === 'model')?.value).toBe('fixture/m2');
    expect(settings.find(setting => setting.id === 'reasoning_effort')).toMatchObject({ mutable: true, value: 'off' });
    await session.setSessionSetting!('reasoning_effort', 'high');
    settings = (await session.runtimeInfo()).settings!;
    expect(settings.find(setting => setting.id === 'reasoning_effort')?.value).toBe('high');
    await expect(session.setSessionSetting!('model', 'fixture/zzz')).rejects.toBeInstanceOf(AgentOperationRejectedError);
    await expect(session.setSessionSetting!('nope', 'x')).rejects.toBeInstanceOf(AgentOperationRejectedError);
  });
});

describe('failure', () => {
  it('fails a run that pi ends by exiting as native_exited, fails the stream and refuses later operations', async () => {
    const h = harness();
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd });
    const seen = follow(session);
    h.fake.last.emit({ type: 'agent_start' });
    await seen.until(() => seen.of('runtime_updated').some(event => event.runtimeInfo.status === 'running'));
    h.fake.last.exit(1, 'boom');
    await seen.done;
    expect(seen.of('turn_failed')[0]).toMatchObject({ code: 'native_exited' });
    expect(seen.failure.error).toBeInstanceOf(Error);
    expect((await session.runtimeInfo()).status).toBe('failed');
    await expect(session.sendMessage('hi')).rejects.toBeInstanceOf(AgentOperationRejectedError);
    expect(h.diagnostics.some(line => line.includes('boom'))).toBe(true);
    await session.dispose();
  });

  it('fails the open as native_exited when pi exits before it answers', async () => {
    const h = harness();
    h.fake.hooks.get_state = (_command, process) => { process.exit(2, 'no models'); return true; };
    await expect(h.provider.createSession({ sessionId: 'a', cwd: h.cwd })).rejects.toBeInstanceOf(AgentRuntimeError);
  });

  it('fails the open as timed out when pi never answers, and stops the process', async () => {
    const h = harness({ startTimeoutMs: 20 });
    h.fake.hooks.get_state = () => true;
    await expect(h.provider.createSession({ sessionId: 'a', cwd: h.cwd })).rejects.toMatchObject({ code: 'native_resume_timeout' });
    expect(h.fake.last.exited).toBeDefined();
    expect(h.workDirectories()).toEqual([]);
  });

  it('reports an event of a kind it does not know as one diagnostic and no row, live', async () => {
    const h = harness();
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd });
    const seen = follow(session);
    const before = seen.observations().length;
    h.fake.last.emit({ type: 'hologram' });
    expect(seen.observations().length).toBe(before);
    expect(h.diagnostics.filter(line => line.includes('native_event_unknown'))).toHaveLength(1);
    await session.dispose(); await seen.done;
  });

  it('stops pi and removes its work directory when the session is disposed, once', async () => {
    const h = harness();
    const session = await h.provider.createSession({ sessionId: 'a', cwd: h.cwd });
    await session.dispose(); await session.dispose();
    expect(h.fake.last.exited).toBeDefined();
    expect(h.workDirectories()).toEqual([]);
    await expect(session.sendMessage('hi')).rejects.toBeInstanceOf(AgentOperationRejectedError);
  });
});

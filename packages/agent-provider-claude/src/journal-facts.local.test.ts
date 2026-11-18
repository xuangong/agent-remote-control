import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentSession, ProviderObservation } from '@orchardworks/agent-provider-sdk';

import { ClaudeAgentProvider } from './provider.js';
import { ClaudeEventProjector } from './projector.js';
import { nativeFixture, nativeReply, nativeStalled, type NativeBlock } from './test-utils/native-fixture.js';

const DUMP = process.env.JOURNAL_FACTS_DUMP;
const dump = (name: string, value: unknown) => { if (DUMP) { mkdirSync(DUMP, { recursive: true }); writeFileSync(join(DUMP, `${name}.json`), JSON.stringify(value, null, 1)); } };
const MODEL = 'claude-sonnet-4-5-20250929';

type Run = Awaited<ReturnType<typeof scenario>>;
const main = (run: Run): any[] => Object.entries(run.transcripts).find(([file]) => !file.includes('/subagents/'))![1] as any[];
const withUuid = (rows: any[], uuid: string) => rows.find(row => row.uuid === uuid);
const userRows = (run: Run) => run.live.flatMap(({ event }) => event.type === 'timeline' && event.item.type === 'user_message' ? [event.item] : []);
const rereadUsers = (run: Run) => run.reread.flatMap(({ event }) => event.type === 'timeline' && event.item.type === 'user_message' ? [event.item] : []);
const rawOf = (run: Run, predicate: (message: any) => boolean) => (run.liveRaw as any[]).filter(predicate);

async function waitFor(condition: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) { if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`); await new Promise(resolve => { setTimeout(resolve, 50); }); }
}

function watch(session: AgentSession) {
  const all: Array<{ boundary: true } | { boundary: false; observation: ProviderObservation }> = [];
  const done = (async () => { for await (const item of session.observe()) { if (item.type === 'history_boundary') all.push({ boundary: true }); else if (item.type === 'observation') all.push({ boundary: false, observation: item }); } })().catch(() => undefined);
  const observations = () => all.flatMap(entry => entry.boundary ? [] : [entry.observation]);
  return {
    done, observations,
    events: () => observations().map(({ event }) => event),
    ready: () => waitFor(() => all.some(entry => entry.boundary), 'the history boundary'),
    history: () => all.slice(0, all.findIndex(entry => entry.boundary)).flatMap(entry => entry.boundary ? [] : [entry.observation]),
  };
}
const turnsDone = (seen: ReturnType<typeof watch>, count: number) => waitFor(() => seen.events().filter(event => event.type === 'turn_completed' || event.type === 'turn_failed' || event.type === 'turn_canceled').length >= count, `${count} finished turns`);

type Fixture = Awaited<ReturnType<typeof nativeFixture>>;

/** Runs one scenario against the real CLI and returns what the live run, the transcript and the SDK read say. */
async function scenario(name: string, handler: (body: any, response: any) => void, drive: (session: AgentSession, seen: ReturnType<typeof watch>, fixture: Fixture) => Promise<void>, config: object = {}, setup?: (fixture: Fixture) => Promise<void>) {
  const fixture = await nativeFixture(handler);
  await setup?.(fixture);
  const raw: unknown[] = [];
  const original = ClaudeEventProjector.prototype.project;
  ClaudeEventProjector.prototype.project = function (this: ClaudeEventProjector, value: unknown) { raw.push(value); return original.call(this, value); };
  const provider = new ClaudeAgentProvider({ ...fixture.options });
  try {
    const session = await provider.createSession({ cwd: fixture.cwd, model: MODEL, ...config });
    const seen = watch(session);
    await seen.ready();
    await drive(session, seen, fixture);
    const handle = (await session.runtimeInfo()).persistence!;
    const live = seen.observations();
    const liveRaw = raw.splice(0);
    await session.dispose(); await seen.done;
    ClaudeEventProjector.prototype.project = original;
    const files = readdirSync(join(fixture.options.env.CLAUDE_CONFIG_DIR!, 'projects'), { recursive: true }).map(String).filter(file => file.endsWith('.jsonl'));
    const transcripts = Object.fromEntries(files.map(file => [file, readFileSync(join(fixture.options.env.CLAUDE_CONFIG_DIR!, 'projects', file), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))]));
    const catalog = (provider as any).catalog;
    const sdkMessages = await catalog.messages(handle.sessionId);
    const timeline = await catalog.timelineMessages(handle.sessionId);
    const resumed = await provider.resumeSession(handle);
    const history = watch(resumed);
    await history.ready();
    const reread = history.history();
    await resumed.dispose(); await history.done;
    const value = { live, liveRaw, transcripts, sdkMessages, timeline, reread };
    dump(name, value);
    return value;
  } finally { ClaudeEventProjector.prototype.project = original; await provider.dispose(); await fixture.close(); }
}

describe('what the native Claude Code 2.1.319 runtime does, which the journal keys depend on', () => {
  it('settled', async () => {
    const run = await scenario('settled', (body, response) => {
      const results = JSON.stringify(body.messages);
      const turn2 = results.includes('SECOND_PROMPT');
      if (turn2) return nativeReply(response, [{ type: 'text', text: 'ANSWER_2' }]);
      if (!results.includes('write-1')) return nativeReply(response, [{ type: 'text', text: 'Writing ', deltas: ['Writing ', 'it.'] }, { type: 'tool_use', id: 'write-1', name: 'Write', input: { file_path: 'hello.txt', content: 'hello\n' } }]);
      if (!results.includes('edit-1')) return nativeReply(response, [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: 'hello.txt', old_string: 'hello', new_string: 'goodbye' } }]);
      if (!results.includes('bash-1')) return nativeReply(response, [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'printf SETTLED_OK', description: 'Print' } }]);
      return nativeReply(response, [{ type: 'text', text: 'ANSWER_1' }]);
    }, async (session, seen, fixture) => {
      await session.sendMessage('First'); await turnsDone(seen, 1);
      await session.sendMessage('SECOND_PROMPT'); await turnsDone(seen, 2);
    }, { permissionMode: 'bypassPermissions' });
    // FL1: a typed input keeps its uuid in the transcript. FL2: the raw row of a tool result carries what the live row carries.
    const users = main(run).filter(row => row.type === 'user' && typeof row.message.content === 'string');
    expect(userRows(run).map(item => item.messageId)).toEqual(users.map(row => row.uuid));
    const results = main(run).filter(row => row.type === 'user' && Array.isArray(row.message.content) && row.message.content[0]?.type === 'tool_result');
    expect(results.map(row => row.message.content[0].tool_use_id)).toEqual(['write-1', 'edit-1', 'bash-1']);
    for (const row of results) expect(row.toolUseResult, 'the transcript row keeps the structured result').toBeDefined();
    const liveResults = rawOf(run, message => message.type === 'user' && message.tool_use_result !== undefined);
    expect(liveResults.map(message => message.uuid), 'the live frame is the transcript row').toEqual(results.map(row => row.uuid));
    expect(liveResults.map(message => message.tool_use_result)).toEqual(results.map(row => row.toolUseResult));
    expect((run.sdkMessages as any[]).every(message => message.tool_use_result === undefined && message.toolUseResult === undefined), 'the public read omits it').toBe(true);
    expect(run.timeline.every((message: any) => message.turnId !== undefined), 'FL8: the catalog names the turn of every row').toBe(true);
  }, 120_000);

  it('thinking', async () => {
    const run = await scenario('thinking', (body, response) => nativeReply(response, [{ type: 'thinking', thinking: 'Let me think about it.', deltas: ['Let me ', 'think about it.'] }, { type: 'text', text: 'ANSWER', deltas: ['ANS', 'WER'] }]),
      async (session, seen) => { await session.sendMessage('Think'); await turnsDone(seen, 1); });
    // FL3: the SDK read holds a streamed thinking block with the same text.
    const live = run.live.flatMap(({ event }) => event.type === 'timeline' && event.item.type === 'reasoning' ? [event.item.text] : []);
    const reread = run.reread.flatMap(({ event }) => event.type === 'timeline' && event.item.type === 'reasoning' ? [event.item.text] : []);
    expect(reread).toEqual(['Let me think about it.']);
    expect(live.join('')).toBe(reread[0]);
  }, 60_000);

  it('approval', async () => {
    const run = await scenario('approval', (body, response) => {
      const results = JSON.stringify(body.messages);
      if (!results.includes('ask-1')) return nativeReply(response, [{ type: 'tool_use', id: 'ask-1', name: 'AskUserQuestion', input: { questions: [{ question: 'Pick a colour', header: 'Colour', multiSelect: false, options: [{ label: 'Blue', description: 'b' }, { label: 'Green', description: 'g' }] }] } }]);
      if (!results.includes('write-1')) return nativeReply(response, [{ type: 'tool_use', id: 'write-1', name: 'Write', input: { file_path: 'approved.txt', content: 'ok\n' } }]);
      return nativeReply(response, [{ type: 'text', text: 'FINAL' }]);
    }, async (session, seen) => {
      await session.sendMessage('Ask me, then write');
      await waitFor(() => seen.events().some(event => event.type === 'interaction_requested'), 'the question');
      const question = seen.events().find(event => event.type === 'interaction_requested')!;
      if (question.type !== 'interaction_requested' || question.request.kind !== 'question') throw new Error('Expected a question');
      await session.respondToInteraction!(question.request.requestId, { kind: 'question', answers: [{ questionId: 'question-0', selectedValues: ['Blue'] }] });
      await waitFor(() => seen.events().filter(event => event.type === 'interaction_requested').length >= 2, 'the approval');
      const approval = seen.events().filter(event => event.type === 'interaction_requested')[1]!;
      if (approval.type !== 'interaction_requested') throw new Error('Expected an approval');
      await session.respondToInteraction!(approval.request.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'once' });
      await turnsDone(seen, 1);
    });
    // FL4: the transcript holds no record of a permission prompt or a question beyond the tool rows.
    expect(main(run).filter(row => row.type === 'user' || row.type === 'assistant').map(row => row.message.content[0]?.type ?? 'text')).toEqual(['text', 'tool_use', 'tool_result', 'tool_use', 'tool_result', 'text']);
    expect(run.reread.some(({ event }) => event.type === 'interaction_requested' || event.type === 'interaction_resolved')).toBe(false);
  }, 60_000);

  it('plan approval', async () => {
    await scenario('plan-approval', (body, response) => {
      const text = JSON.stringify(body);
      const path = /create your plan at (\/[^ "\\]+\.md)/.exec(text)?.[1];
      if (!text.includes('write-plan')) return nativeReply(response, path ? [{ type: 'tool_use', id: 'write-plan', name: 'Write', input: { file_path: path, content: '# Plan\n- one' } }] : [{ type: 'text', text: 'NO_PLAN_FILE' }]);
      if (!text.includes('exit-1')) return nativeReply(response, [{ type: 'tool_use', id: 'exit-1', name: 'ExitPlanMode', input: {} }]);
      return nativeReply(response, [{ type: 'text', text: 'PLAN_DONE' }]);
    }, async (session, seen) => {
      await session.sendMessage('Plan it');
      await waitFor(() => seen.events().some(event => event.type === 'interaction_requested'), 'the plan approval');
      const request = seen.events().find(event => event.type === 'interaction_requested')!;
      if (request.type !== 'interaction_requested') throw new Error('Expected a request');
      await session.respondToInteraction!(request.request.requestId, { kind: 'plan_approval', action: 'approve_and_resume' });
      await turnsDone(seen, 1);
    }, { planning: true });
  }, 60_000);

  it('todos', async () => {
    await scenario('todos', (body, response) => JSON.stringify(body.messages).includes('todo-1') ? nativeReply(response, [{ type: 'text', text: 'DONE' }])
      : nativeReply(response, [{ type: 'tool_use', id: 'todo-1', name: 'TodoWrite', input: { todos: [{ content: 'alpha', status: 'in_progress', activeForm: 'Doing alpha' }, { content: 'beta', status: 'pending', activeForm: 'Doing beta' }] } }]),
    async (session, seen) => { await session.sendMessage('Plan'); await turnsDone(seen, 1); }, { permissionMode: 'bypassPermissions' });
  }, 60_000);

  it('interrupted', async () => {
    const run = await scenario('interrupted', (body, response) => {
      const results = JSON.stringify(body.messages);
      if (results.includes('RUN_AND_STOP') && !results.includes('bash-1')) return nativeReply(response, [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'sleep 30', description: 'wait' } }]);
      if (results.includes('RUN_AND_STOP')) return nativeStalled(response, [{ type: 'text', text: 'never ends' }]);
      return nativeStalled(response, [{ type: 'thinking', thinking: 'Thinking ' }, { type: 'text', text: 'Half of ' }]);
    }, async (session, seen) => {
      await session.sendMessage('Stream then stop');
      await waitFor(() => seen.events().some(event => event.type === 'timeline' && event.item.type === 'assistant_message' && event.item.text === 'Half of '), 'the partial text');
      await session.cancel!(); await turnsDone(seen, 1);
      await session.sendMessage('RUN_AND_STOP');
      await waitFor(() => seen.events().some(event => event.type === 'timeline' && event.item.type === 'tool_call' && event.item.status === 'running'), 'the running tool');
      await new Promise(resolve => { setTimeout(resolve, 1500); });
      await session.cancel!(); await turnsDone(seen, 2);
    }, { permissionMode: 'bypassPermissions' });
    // FL7: the partial assistant text is recorded, and so is the notice; the tool in flight has its result row.
    const rows = main(run).filter(row => row.type === 'user' || row.type === 'assistant');
    expect(rows.flatMap(row => Array.isArray(row.message.content) ? row.message.content.map((block: any) => block.type === 'text' ? block.text : block.type) : [row.message.content])).toContain('Half of ');
    const notices = rows.filter(row => JSON.stringify(row.message.content).includes('[Request interrupted by user]'));
    expect(notices).toHaveLength(2);
    // FL6: the notice is a row of the live stream and of the SDK read, with one uuid.
    expect(rawOf(run, message => message.type === 'user' && JSON.stringify(message.message.content).includes('[Request interrupted')).map(message => message.uuid)).toEqual(notices.map(row => row.uuid));
    expect(rereadUsers(run).map(item => item.messageId)).toEqual(expect.arrayContaining(notices.map(row => row.uuid)));
  }, 90_000);

  it('steer', async () => {
    const run = await scenario('steer', (body, response) => {
      const messages = JSON.stringify(body.messages);
      if (!messages.includes('tool_result')) return nativeReply(response, [{ type: 'tool_use', id: 'fold-wait', name: 'Bash', input: { command: 'sleep 2', description: 'wait' } }]);
      return nativeReply(response, [{ type: 'text', text: messages.includes('FOLDED_INPUT') ? 'SAW_FOLDED' : 'NO_FOLDED' }]);
    }, async (session, seen) => {
      await session.sendMessage('Start the work.');
      await waitFor(() => seen.events().some(event => event.type === 'timeline' && event.item.type === 'tool_call'), 'the tool');
      await session.sendMessage('FOLDED_INPUT also check this');
      await turnsDone(seen, 1);
    }, { permissionMode: 'bypassPermissions' });
    // The folded input is a queued_command attachment whose source is the uuid the Controller gave it.
    const folded = main(run).find(row => row.type === 'attachment' && row.attachment.type === 'queued_command');
    expect(folded.attachment.source_uuid).toBe(userRows(run).find(item => item.text.startsWith('FOLDED_INPUT'))!.messageId);
    expect(folded.uuid).not.toBe(folded.attachment.source_uuid);
  }, 60_000);

  it('parallel tools', async () => {
    const run = await scenario('parallel-tools', (body, response) => JSON.stringify(body.messages).includes('par-1') ? nativeReply(response, [{ type: 'text', text: 'BOTH' }])
      : nativeReply(response, [{ type: 'tool_use', id: 'par-1', name: 'Bash', input: { command: 'printf ONE', description: 'one' } }, { type: 'tool_use', id: 'par-2', name: 'Bash', input: { command: 'printf TWO', description: 'two' } }]),
    async (session, seen) => { await session.sendMessage('Run both'); await turnsDone(seen, 1); }, { permissionMode: 'bypassPermissions' });
    const assistants = main(run).filter(row => row.type === 'assistant');
    expect(assistants.map(row => row.message.id).slice(0, 2)[0]).toBe(assistants[1].message.id);
    expect(main(run).filter(row => row.type === 'user' && Array.isArray(row.message.content) && row.message.content[0]?.type === 'tool_result').map(row => row.message.content[0].tool_use_id).sort()).toEqual(['par-1', 'par-2']);
    // Concurrent tools finish in either order, so the results are written in either order.
  }, 60_000);

  it('compaction', async () => {
    const run = await scenario('compaction', (body, response) => nativeReply(response, [{ type: 'text', text: JSON.stringify(body.messages).includes('compact') || JSON.stringify(body.system ?? '').includes('summar') ? '<summary>Summary of the work.</summary>' : 'ANSWER' }]),
      async (session, seen) => {
        await session.sendMessage('First'); await turnsDone(seen, 1);
        await session.sendMessage('/compact');
        await waitFor(() => seen.events().some(event => event.type === 'timeline' && event.item.type === 'compaction' && event.item.status === 'completed'), 'the compaction');
        await turnsDone(seen, 2);
        await session.sendMessage('Second'); await turnsDone(seen, 3);
      }, { permissionMode: 'bypassPermissions' });
    // FL5: after /compact the SDK read starts at the summary row; no compaction row; live has the status and the boundary.
    expect((run.sdkMessages as any[])[0].message.content).toContain('This session is being continued');
    expect(rawOf(run, message => message.type === 'system' && message.subtype === 'status' && message.status === 'compacting')).toHaveLength(1);
    expect(rawOf(run, message => message.type === 'system' && message.subtype === 'compact_boundary')).toHaveLength(1);
    // FL6: the typed command is the live row; the transcript row is its expansion, with the same uuid.
    const typed = userRows(run).find(item => item.text === '/compact')!;
    // The transcript row is the envelope; the adapter reads it as typed.
    expect(JSON.stringify(run.timeline.find((message: any) => message.uuid === typed.messageId)!.message)).toContain('<command-name>/compact</command-name>');
    expect(rereadUsers(run).find(item => item.messageId === typed.messageId)!.text).toBe('/compact');
  }, 90_000);

  it('slash commands', async () => {
    const run = await scenario('slash', (body, response) => nativeReply(response, [{ type: 'text', text: JSON.stringify(body.messages).includes('CUSTOM_COMMAND_BODY') ? 'SAW_COMMAND' : 'PLAIN' }]), async (session, seen) => {
      await session.sendMessage('/hello world'); await turnsDone(seen, 1);
      await session.sendMessage('/context'); await turnsDone(seen, 2);
    }, { permissionMode: 'bypassPermissions' }, async fixture => {
      const home = fixture.options.env.CLAUDE_CONFIG_DIR!;
      await mkdir(join(home, 'commands'), { recursive: true });
      await writeFile(join(home, 'commands', 'hello.md'), '---\ndescription: Say hello\n---\nCUSTOM_COMMAND_BODY $ARGUMENTS\n');
    });
    const typed = userRows(run).find(item => item.text === '/hello world')!;
    expect(JSON.stringify(run.timeline.find((message: any) => message.uuid === typed.messageId)!.message)).toContain('<command-args>world</command-args>');
    expect(rereadUsers(run).find(item => item.messageId === typed.messageId)!.text).toBe('/hello world');
    // The expansion the model saw is a meta row, which neither the live stream nor the SDK read holds; the output of a local command is a system row the SDK read omits.
    expect(main(run).some(row => row.isMeta === true && JSON.stringify(row.message.content).includes('CUSTOM_COMMAND_BODY'))).toBe(true);
    expect(JSON.stringify(run.sdkMessages)).not.toContain('CUSTOM_COMMAND_BODY');
    expect(main(run).some(row => row.type === 'system' && row.subtype === 'local_command')).toBe(true);
    expect(rawOf(run, message => message.type === 'assistant' && message.message.model === '<synthetic>')).toHaveLength(1);
  }, 60_000);

  it('hook', async () => {
    const run = await scenario('hook', (body, response) => nativeReply(response, [{ type: 'text', text: JSON.stringify(body.messages).includes('HOOK_CONTEXT') ? 'SAW_HOOK' : 'NO_HOOK' }]), async (session, seen) => {
      await session.sendMessage('Hello'); await turnsDone(seen, 1);
    }, { permissionMode: 'bypassPermissions' }, async fixture => {
      const home = fixture.options.env.CLAUDE_CONFIG_DIR!;
      const output = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'HOOK_CONTEXT' } });
      await writeFile(join(home, 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `printf '%s' '${output}'` }] }] } }));
    });
    // FL9: a hook that adds context writes an attachment, which neither the live stream nor the SDK read shows.
    expect(main(run).some(row => row.type === 'attachment' && row.attachment.type === 'hook_additional_context')).toBe(true);
    expect(JSON.stringify(run.sdkMessages)).not.toContain('HOOK_CONTEXT');
    expect(JSON.stringify(run.live)).not.toContain('HOOK_CONTEXT');
  }, 60_000);

  it('images', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=', 'base64');
    await scenario('images', (body, response) => JSON.stringify(body.messages).includes('read-image') ? nativeReply(response, [{ type: 'text', text: 'IMAGE_OK' }])
      : JSON.stringify(body.messages).includes('SHOW_PIXEL') ? nativeReply(response, [{ type: 'tool_use', id: 'read-image', name: 'Read', input: { file_path: 'pixel.png' } }]) : nativeReply(response, [{ type: 'text', text: 'SAW_IMAGE' }]), async (session, seen, fixture) => {
      const path = join(fixture.cwd, 'pixel.png');
      await writeFile(path, png);
      await (session as any).sendMessageContent([{ type: 'text', text: 'Look at this' }, { type: 'image', path, mediaType: 'image/png', sha256: createHash('sha256').update(png).digest('hex'), label: 'image #1' }]); await turnsDone(seen, 1);
      await session.sendMessage('SHOW_PIXEL: read pixel.png'); await turnsDone(seen, 2);
    }, { permissionMode: 'bypassPermissions' });
  }, 60_000);

  it('sub-agent', async () => {
    const run = await scenario('subagent', (body, response) => {
      const first = JSON.stringify(body.messages?.[0] ?? '');
      if (first.includes('SUBAGENT_TASK')) return nativeReply(response, [{ type: 'text', text: 'SUBAGENT_DONE' }]);
      if (JSON.stringify(body.messages).includes('task-1')) return nativeReply(response, [{ type: 'text', text: 'PARENT_DONE' }]);
      return nativeReply(response, [{ type: 'tool_use', id: 'task-1', name: 'Task', input: { description: 'Do the task', prompt: 'SUBAGENT_TASK do it', subagent_type: 'general-purpose' } }]);
    }, async (session, seen) => { await session.sendMessage('Delegate'); await turnsDone(seen, 1); }, { permissionMode: 'bypassPermissions' });
    // A finished task wakes the session with a user row the stream never shows, and its sidechain is a transcript of its own.
    const wake = main(run).find(row => row.type === 'user' && row.origin?.kind === 'task-notification');
    expect(wake).toBeDefined();
    expect(rawOf(run, message => message.uuid === wake.uuid)).toEqual([]);
    // The SDK read holds it; the adapter's pass drops it, as the stream never shows it.
    expect(JSON.stringify(run.sdkMessages)).toContain(wake.uuid);
    expect(rereadUsers(run).some(item => item.messageId === wake.uuid)).toBe(false);
    expect(Object.keys(run.transcripts).some(file => file.includes('/subagents/'))).toBe(true);
  }, 90_000);

  it('queued and withdrawn input', async () => {
    let release: (() => void) | undefined;
    await scenario('queued', (body, response) => {
      const messages = JSON.stringify(body.messages);
      if (messages.includes('NEVER_RUNS')) return nativeReply(response, [{ type: 'text', text: 'SAW_NEVER' }]);
      if (messages.includes('NEXT_TURN_INPUT') && messages.includes('FIRST_REPLY')) return nativeReply(response, [{ type: 'text', text: 'SAW_NEXT' }]);
      void new Promise<void>(resolve => { release = resolve; }).then(() => nativeReply(response, [{ type: 'text', text: 'FIRST_REPLY' }]));
    }, async (session, seen) => {
      await session.sendMessage('Start the work.');
      await waitFor(() => typeof release === 'function', 'the stalled reply');
      await session.sendMessage('NEXT_TURN_INPUT');
      await new Promise(resolve => { setTimeout(resolve, 1000); });
      release?.();
      await turnsDone(seen, 2);
      await session.sendMessage('Start again.');
      await waitFor(() => release !== undefined, 'the stalled reply');
      await session.sendMessage('NEVER_RUNS do this next');
      await new Promise(resolve => { setTimeout(resolve, 1000); });
      await session.cancel!();
      release?.();
      await turnsDone(seen, 3);
    });
  }, 90_000);
});

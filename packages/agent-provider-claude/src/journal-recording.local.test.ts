import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AgentInteractionRequest, AgentSession, ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { journalObservation, recordingShape, serializeRecording, type JournalRecording } from '@orchardworks/agent-provider-sdk/testing';

import { claudeBehaviour } from './behaviour.js';
import { ClaudeAgentProvider } from './provider.js';
import { nativeFixture, nativePaced, nativeReply, nativeStalled, type NativeBlock } from './test-utils/native-fixture.js';

/**
 * Records what the real Claude Code CLI does for the scenarios a journal must survive: the observations of the live run, and the
 * history observations of the same native session opened again. The CLI runs against a scripted model and a temporary
 * CLAUDE_CONFIG_DIR; nothing signs in. `RECORD_JOURNAL_FIXTURES=1` rewrites src/journal-fixtures; otherwise the run is compared with the
 * stored recording by the shape of its identities, so a change of the adapter or of the CLI is a visible change. The test imports the
 * built provider, because the catalog worker that reads native history is a built file.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'journal-fixtures');
const RECORDING = process.env.RECORD_JOURNAL_FIXTURES === '1';
const MODEL = 'claude-sonnet-4-5-20250929';
/** The CLI a recording is made with, which its header names. */
const cli = { name: 'claude', version: /^(\d+\.\d+\.\d+) \(Claude Code\)/m.exec(execFileSync(process.env.AGENT_CLAUDE_TEST_EXECUTABLE ?? 'claude', ['--version'], { encoding: 'utf8', timeout: 5000 }))?.[1] ?? 'unknown' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=', 'base64');

type Fixture = Awaited<ReturnType<typeof nativeFixture>>;
type Stream = ReturnType<typeof watch>;
type Handler = (body: any, response: Parameters<typeof nativeReply>[0]) => void;
interface Context { fixture: Fixture; provider: ClaudeAgentProvider; /** 1 for the session that ran first, 2 for the one opened after it. */ round: number }
type Drive = (session: AgentSession, seen: Stream, context: Context) => Promise<void>;
interface Options { config?: object; setup?: (fixture: Fixture) => Promise<void>; newProcess?: boolean; reopen?: boolean }

async function waitFor(condition: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => { setTimeout(resolve, 50); });
  }
}
const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

/** Collects every observation of a session in the background, and where its history boundary fell. */
function watch(session: AgentSession) {
  const all: Array<{ boundary: true } | { boundary: false; observation: ProviderObservation }> = [];
  const done = (async () => {
    for await (const item of session.observe()) {
      if (item.type === 'history_boundary') all.push({ boundary: true });
      else if (item.type === 'observation') all.push({ boundary: false, observation: item });
    }
  })().catch(() => undefined);
  const observations = () => all.flatMap(entry => entry.boundary ? [] : [entry.observation]);
  return {
    done,
    events: () => observations().map(({ event }) => event),
    ready: () => waitFor(() => all.some(entry => entry.boundary), 'the history boundary'),
    history: () => all.slice(0, all.findIndex(entry => entry.boundary)).flatMap(entry => entry.boundary ? [] : [entry.observation]),
    kept: () => observations().filter(journalObservation),
  };
}

const turnsDone = (seen: Stream, count: number) => waitFor(() => seen.events().filter(event => event.type === 'turn_completed' || event.type === 'turn_failed' || event.type === 'turn_canceled').length >= count, `${count} finished turns`);
const requested = (seen: Stream, count: number) => waitFor(() => seen.events().filter(event => event.type === 'interaction_requested').length >= count, `${count} interaction requests`);
const nthRequest = (seen: Stream, at: number): AgentInteractionRequest => {
  const event = seen.events().filter(candidate => candidate.type === 'interaction_requested')[at];
  if (event?.type !== 'interaction_requested') throw new Error('No such interaction request.');
  return event.request;
};
const timelineItem = (event: ProviderObservation['event']) => event.type === 'timeline' ? event.item : undefined;
const itemSeen = (seen: Stream, predicate: (item: NonNullable<ReturnType<typeof timelineItem>>) => boolean) => waitFor(() => seen.events().some(event => { const item = timelineItem(event); return item !== undefined && predicate(item); }), 'a timeline item');
const toolCalled = (seen: Stream, status: 'running' | 'completed') => itemSeen(seen, item => item.type === 'tool_call' && item.status === status);
const sawInput = (body: any, text: string) => JSON.stringify(body.messages).includes(text);
/** The absolute path a model names for a file of the session's workspace, which the CLI states in its prompt. */
const inWorkspace = (body: any, name: string) => `${/working directory: (\/[^\s\\"]+)/.exec(JSON.stringify(body))?.[1] ?? '/workspace'}/${name}`;

async function readAgain(provider: ClaudeAgentProvider, handle: NonNullable<Awaited<ReturnType<AgentSession['runtimeInfo']>>['persistence']>): Promise<ProviderObservation[]> {
  const resumed = await provider.resumeSession(handle);
  const history = watch(resumed);
  await history.ready();
  const reread = history.history().filter(journalObservation);
  await resumed.dispose(); await history.done;
  return reread;
}

async function record(handler: Handler, drive: Drive, options: Options = {}): Promise<{ recording: JournalRecording; cwd: string; home: string }> {
  const fixture = await nativeFixture(handler);
  await options.setup?.(fixture);
  let provider = new ClaudeAgentProvider({ ...fixture.options });
  try {
    const session = await provider.createSession({ cwd: fixture.cwd, model: MODEL, permissionMode: 'bypassPermissions', ...options.config });
    const seen = watch(session);
    await seen.ready();
    const context: Context = { fixture, provider, round: 1 };
    await drive(session, seen, context);
    const handle = (await session.runtimeInfo()).persistence!;
    await session.dispose(); await seen.done;
    let live = seen.kept();
    if (options.newProcess) { await provider.dispose(); provider = new ClaudeAgentProvider({ ...fixture.options }); }
    if (options.reopen) {
      // A turn run after a reopen: the second session reads the first turn as history and runs the second one live.
      context.round = 2; context.provider = provider;
      const second = await provider.resumeSession(handle);
      const secondSeen = watch(second);
      await secondSeen.ready();
      await drive(second, secondSeen, context);
      await second.dispose(); await secondSeen.done;
      live = secondSeen.kept();
    }
    return { recording: { live, reread: await readAgain(provider, handle) }, cwd: fixture.cwd, home: fixture.options.env.CLAUDE_CONFIG_DIR! };
  } finally { await provider.dispose(); await fixture.close(); }
}

/** Paths of this machine and run never enter a fixture. */
async function scrub(recording: JournalRecording, paths: string[]): Promise<JournalRecording> {
  let text = JSON.stringify(recording);
  const variants = (await Promise.all(paths.map(async path => [path, await realpath(path).catch(() => path)]))).flat();
  for (const path of [...new Set(variants)].sort((a, b) => b.length - a.length)) text = text.replaceAll(path, path === homedir() ? '/home/user' : '/workspace');
  return JSON.parse(text.replaceAll(homedir(), '/home/user')) as JournalRecording;
}


async function check(name: string, recording: JournalRecording, cwd: string, home: string) {
  const path = join(FIXTURES, `${name}.json`);
  const clean = { cli, ...await scrub(recording, [cwd, home, tmpdir(), homedir()]) };
  if (RECORDING) { await mkdir(FIXTURES, { recursive: true }); await writeFile(path, serializeRecording(clean)); return; }
  if (!existsSync(path)) throw new Error(`No recording ${name}.json: run with RECORD_JOURNAL_FIXTURES=1.`);
  // Concurrent tools finish in either order and their results are written in either order: Claude Code declares siblings_unordered.
  const order = claudeBehaviour.reread.order;
  expect(recordingShape(clean, order), `the shape of the ${name} recording`).toEqual(recordingShape(JSON.parse(await readFile(path, 'utf8')) as JournalRecording, order));
}

async function recorded(name: string, handler: Handler, drive: Drive, options?: Options) {
  const { recording, cwd, home } = await record(handler, drive, options);
  await check(name, recording, cwd, home);
  return recording;
}

const answer = (session: AgentSession, seen: Stream, at: number, response: Parameters<AgentSession['respondToInteraction'] & {}>[1]) => session.respondToInteraction!(nthRequest(seen, at).requestId, response);
const sleeper = { command: 'node -e "setTimeout(() => {}, 30000)"', description: 'wait' };

describe('the recordings of the real Claude Code CLI', () => {
  // Turn one streams text, writes, edits and runs a command, then answers; turn two answers.
  const settled: Handler = (body, response) => {
    if (sawInput(body, 'SECOND_PROMPT')) return nativeReply(response, [{ type: 'text', text: 'ANSWER_2', deltas: ['ANSWER', '_2'] }]);
    if (!sawInput(body, 'write-1')) return nativeReply(response, [{ type: 'text', text: 'Writing it.', deltas: ['Writing ', 'it.'] }, { type: 'tool_use', id: 'write-1', name: 'Write', input: { file_path: inWorkspace(body, 'hello.txt'), content: 'hello\n' } }]);
    if (!sawInput(body, 'edit-1')) return nativeReply(response, [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: inWorkspace(body, 'hello.txt'), old_string: 'hello', new_string: 'goodbye' } }]);
    if (!sawInput(body, 'bash-1')) return nativeReply(response, [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'printf SETTLED_OK', description: 'Print' } }]);
    return nativeReply(response, [{ type: 'text', text: 'ANSWER_1', deltas: ['ANSWER', '_1'] }]);
  };
  const converse: Drive = async (session, seen) => {
    await session.sendMessage('First'); await turnsDone(seen, 1);
    await session.sendMessage('SECOND_PROMPT'); await turnsDone(seen, 2);
  };

  it('settled: streamed text, a Write, an Edit and a Bash with their results, and a second turn, released and reopened', async () => {
    const run = await recorded('settled', settled, converse);
    expect(run.reread.length).toBeGreaterThan(0);
    // FL8: a history row names the turn its live row names, so a retention window cuts both at the same place.
    const turnOf = (observations: ProviderObservation[]) => new Map(observations.flatMap(({ event, itemIdentity }) => event.type === 'timeline' && event.turnId !== undefined && itemIdentity !== undefined ? [[itemIdentity.key, event.turnId] as const] : []));
    const live = turnOf(run.live), reread = turnOf(run.reread);
    expect([...reread.keys()].length).toBeGreaterThan(0);
    for (const [key, turnId] of reread) expect(live.get(key), key).toBe(turnId);
  }, 90_000);

  it('restart: the same session read again by a new provider and a new catalog process', async () => {
    await recorded('restart', settled, converse, { newProcess: true });
  }, 90_000);

  it('after-reopen: a turn run after a reopen, then read again', async () => {
    const run = await record(settled, async (session, seen, { round }) => {
      await session.sendMessage(round === 1 ? 'First' : 'SECOND_PROMPT'); await turnsDone(seen, 1);
    }, { reopen: true });
    await check('after-reopen', run.recording, run.cwd, run.home);
    expect(run.recording.live.some(({ delivery }) => delivery === 'history')).toBe(true);
    expect(run.recording.live.some(({ delivery }) => delivery === 'live')).toBe(true);
  }, 90_000);

  it('thinking: a streamed thinking block that the SDK read keeps', async () => {
    await recorded('thinking', (body, response) => nativeReply(response, [{ type: 'thinking', thinking: 'Let me think about it.', deltas: ['Let me ', 'think about it.'] }, { type: 'text', text: 'ANSWER', deltas: ['ANS', 'WER'] }]),
      async (session, seen) => { await session.sendMessage('Think'); await turnsDone(seen, 1); });
  }, 60_000);

  it('approval: a question and a permission prompt, both resolved, neither in the transcript', async () => {
    await recorded('approval', (body, response) => {
      if (!sawInput(body, 'ask-1')) return nativeReply(response, [{ type: 'tool_use', id: 'ask-1', name: 'AskUserQuestion', input: { questions: [{ question: 'Pick a colour', header: 'Colour', multiSelect: false, options: [{ label: 'Blue', description: 'b' }, { label: 'Green', description: 'g' }] }] } }]);
      if (!sawInput(body, 'write-1')) return nativeReply(response, [{ type: 'tool_use', id: 'write-1', name: 'Write', input: { file_path: inWorkspace(body, 'approved.txt'), content: 'ok\n' } }]);
      return nativeReply(response, [{ type: 'text', text: 'FINAL' }]);
    }, async (session, seen) => {
      await session.sendMessage('Ask me, then write');
      await requested(seen, 1);
      await answer(session, seen, 0, { kind: 'question', answers: [{ questionId: 'question-0', selectedValues: ['Blue'] }] });
      await requested(seen, 2);
      await answer(session, seen, 1, { kind: 'tool_approval', decision: 'allow', scope: 'once' });
      await turnsDone(seen, 1);
    }, { config: { permissionMode: 'default' } });
  }, 90_000);

  it('plan-approval: a plan review in a plan-mode run', async () => {
    await recorded('plan-approval', (body, response) => {
      const text = JSON.stringify(body);
      const path = /create your plan at (\/[^ "\\]+\.md)/.exec(text)?.[1];
      if (!text.includes('write-plan')) return nativeReply(response, path ? [{ type: 'tool_use', id: 'write-plan', name: 'Write', input: { file_path: path, content: '# Plan\n- one' } }] : [{ type: 'text', text: 'NO_PLAN_FILE' }]);
      if (!text.includes('exit-1')) return nativeReply(response, [{ type: 'tool_use', id: 'exit-1', name: 'ExitPlanMode', input: {} }]);
      return nativeReply(response, [{ type: 'text', text: 'PLAN_DONE' }]);
    }, async (session, seen) => {
      await session.sendMessage('Plan it'); await requested(seen, 1);
      await answer(session, seen, 0, { kind: 'plan_approval', action: 'approve_and_resume' });
      await turnsDone(seen, 1);
    }, { config: { planning: true, permissionMode: 'default' } });
  }, 90_000);

  it('todos: a TodoWrite call, rebuilt from its tool row', async () => {
    await recorded('todos', (body, response) => sawInput(body, 'todo-1') ? nativeReply(response, [{ type: 'text', text: 'DONE' }])
      : nativeReply(response, [{ type: 'tool_use', id: 'todo-1', name: 'TodoWrite', input: { todos: [{ content: 'alpha', status: 'in_progress', activeForm: 'Doing alpha' }, { content: 'beta', status: 'pending', activeForm: 'Doing beta' }] } }]),
    async (session, seen) => { await session.sendMessage('Plan'); await turnsDone(seen, 1); });
  }, 60_000);

  it('compaction: /compact against the scripted model, then a turn', async () => {
    await recorded('compaction', (body, response) => nativeReply(response, [{ type: 'text', text: '<summary>Summary of the work.</summary>' }]), async (session, seen) => {
      await session.sendMessage('First'); await turnsDone(seen, 1);
      await session.sendMessage('/compact');
      await itemSeen(seen, item => item.type === 'compaction' && item.status === 'completed');
      await turnsDone(seen, 2);
      await session.sendMessage('Second'); await turnsDone(seen, 3);
    });
  }, 90_000);

  it('failed-compaction: the model refuses to summarize', async () => {
    let compacting = false;
    const run = await record((body, response) => {
      if (compacting) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'summary failed' } })); return; }
      nativeReply(response, [{ type: 'text', text: 'ANSWER' }]);
    }, async (session, seen) => {
      await session.sendMessage('First'); await turnsDone(seen, 1);
      compacting = true;
      await session.sendMessage('/compact');
      await turnsDone(seen, 2);
    });
    await check('failed-compaction', run.recording, run.cwd, run.home);
    expect(run.recording.live.some(({ event }) => event.type === 'timeline' && event.item.type === 'compaction' && event.item.status === 'completed')).toBe(false);
  }, 90_000);

  it('interrupted: a turn cancelled while thinking and text stream, and another during a tool', async () => {
    await recorded('interrupted', (body, response) => {
      if (sawInput(body, 'RUN_AND_STOP')) return sawInput(body, 'bash-1') ? nativeStalled(response, [{ type: 'text', text: 'never ends' }]) : nativeReply(response, [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: sleeper }]);
      return nativeStalled(response, [{ type: 'thinking', thinking: 'Thinking ' }, { type: 'text', text: 'Half of ' }]);
    }, async (session, seen) => {
      await session.sendMessage('Stream then stop');
      await itemSeen(seen, item => item.type === 'assistant_message' && item.text === 'Half of ');
      await session.cancel!(); await turnsDone(seen, 1);
      await session.sendMessage('RUN_AND_STOP');
      await toolCalled(seen, 'running');
      // The command is well under way when the turn is cancelled.
      await pause(1500);
      await session.cancel!(); await turnsDone(seen, 2);
    });
  }, 90_000);

  it('steer: input folded into a running turn', async () => {
    await recorded('steer', (body, response) => !sawInput(body, 'tool_result') ? nativeReply(response, [{ type: 'tool_use', id: 'fold-wait', name: 'Bash', input: { command: 'sleep 2', description: 'wait' } }])
      : nativeReply(response, [{ type: 'text', text: sawInput(body, 'FOLDED_INPUT') ? 'SAW_FOLDED' : 'NO_FOLDED' }]), async (session, seen) => {
      await session.sendMessage('Start the work.');
      await toolCalled(seen, 'running');
      await session.sendMessage('FOLDED_INPUT also check this');
      await turnsDone(seen, 1);
    });
  }, 60_000);

  it('queued: input sent while a reply is pending, run as the next turn', async () => {
    let release: (() => void) | undefined;
    await recorded('queued', (body, response) => {
      if (sawInput(body, 'NEXT_TURN_INPUT') && sawInput(body, 'FIRST_REPLY')) return nativeReply(response, [{ type: 'text', text: 'SAW_NEXT' }]);
      void new Promise<void>(resolve => { release = resolve; }).then(() => nativeReply(response, [{ type: 'text', text: 'FIRST_REPLY' }]));
    }, async (session, seen) => {
      await session.sendMessage('Start the work.');
      await waitFor(() => release !== undefined, 'the pending reply');
      await session.sendMessage('NEXT_TURN_INPUT');
      await pause(1000);
      release?.();
      await turnsDone(seen, 2);
    });
  }, 90_000);

  it('withdrawn: input removed from the native queue before it ran', async () => {
    let release: (() => void) | undefined;
    const run = await record((body, response) => {
      if (sawInput(body, 'NEVER_RUNS')) return nativeReply(response, [{ type: 'text', text: 'SAW_NEVER' }]);
      void new Promise<void>(resolve => { release = resolve; }).then(() => nativeReply(response, [{ type: 'text', text: 'FIRST_REPLY' }]));
    }, async (session, seen) => {
      await session.sendMessage('Start the work.');
      await waitFor(() => release !== undefined, 'the pending reply');
      await session.sendMessage('NEVER_RUNS do this next');
      await pause(1000);
      await session.cancel!();
      release?.();
      await turnsDone(seen, 1);
      await pause(1500);
    });
    await check('withdrawn', run.recording, run.cwd, run.home);
    expect(run.recording.live.flatMap(({ event }) => event.type === 'timeline' && event.item.type === 'user_message' && event.item.withdrawn ? [event.item.text] : [])).toEqual(['NEVER_RUNS do this next']);
  }, 90_000);

  it('subagent: a scripted Task call served by the same fake API', async () => {
    await recorded('subagent', (body, response) => {
      if (JSON.stringify(body.messages?.[0] ?? '').includes('SUBAGENT_TASK')) return nativeReply(response, [{ type: 'text', text: 'SUBAGENT_DONE' }]);
      if (sawInput(body, 'task-1')) return nativeReply(response, [{ type: 'text', text: 'PARENT_DONE' }]);
      return nativeReply(response, [{ type: 'tool_use', id: 'task-1', name: 'Task', input: { description: 'Do the task', prompt: 'SUBAGENT_TASK do it', subagent_type: 'general-purpose' } }]);
    }, async (session, seen) => { await session.sendMessage('Delegate'); await turnsDone(seen, 1); await pause(2000); });
  }, 90_000);

  it('slash-command: a custom command and a built-in that prints its own output', async () => {
    await recorded('slash-command', (body, response) => nativeReply(response, [{ type: 'text', text: sawInput(body, 'CUSTOM_COMMAND_BODY') ? 'SAW_COMMAND' : 'PLAIN' }]), async (session, seen) => {
      await session.sendMessage('/hello world'); await turnsDone(seen, 1);
      await session.sendMessage('/context'); await turnsDone(seen, 2);
    }, { setup: async fixture => {
      const home = fixture.options.env.CLAUDE_CONFIG_DIR!;
      await mkdir(join(home, 'commands'), { recursive: true });
      await writeFile(join(home, 'commands', 'hello.md'), '---\ndescription: Say hello\n---\nCUSTOM_COMMAND_BODY $ARGUMENTS\n');
    } });
  }, 90_000);

  it('parallel-tools: two tool calls of one message, their results written in either order', async () => {
    await recorded('parallel-tools', (body, response) => sawInput(body, 'par-1') ? nativeReply(response, [{ type: 'text', text: 'BOTH' }])
      : nativeReply(response, [{ type: 'tool_use', id: 'par-1', name: 'Bash', input: { command: 'printf ONE', description: 'one' } }, { type: 'tool_use', id: 'par-2', name: 'Bash', input: { command: 'printf TWO', description: 'two' } }]),
    async (session, seen) => { await session.sendMessage('Run both'); await turnsDone(seen, 1); });
  }, 60_000);

  it('parallel-edits: six approved Edits of one streamed message, the first finishing while later ones still stream', async () => {
    // As in a real run: the first Edit is approved and written while the model still streams the third and fourth, and the CLI links the
    // fourth to that result, so the second and third leave the parent chain the public read follows.
    const files = ['a', 'b', 'c', 'd', 'e', 'f'];
    const gapMs = 800;
    const run = await recorded('parallel-edits', (body, response) => {
      if (sawInput(body, 'edit-f')) return nativeReply(response, [{ type: 'text', text: 'EDITED' }]);
      if (sawInput(body, 'par-read-f')) return void nativePaced(response, [{ type: 'thinking', thinking: 'Edit all six.' }, ...files.map(name => ({ type: 'tool_use' as const, id: `edit-${name}`, name: 'Edit', input: { file_path: inWorkspace(body, `${name}.txt`), old_string: 'old', new_string: 'new' } }))], gapMs);
      return nativeReply(response, files.map(name => ({ type: 'tool_use', id: `par-read-${name}`, name: 'Read', input: { file_path: inWorkspace(body, `${name}.txt`) } })));
    }, async (session, seen) => {
      await session.sendMessage('Rename in all six');
      // Edit a is approved after c streamed and before d streams; the others after d streamed.
      await requested(seen, 1);
      await pause(gapMs * 2.5);
      await answer(session, seen, 0, { kind: 'tool_approval', decision: 'allow', scope: 'once' });
      await pause(gapMs * 1.5);
      for (let at = 1; at < files.length; at += 1) { await requested(seen, at + 1); await answer(session, seen, at, { kind: 'tool_approval', decision: 'allow', scope: 'once' }); }
      await turnsDone(seen, 1);
    }, { config: { permissionMode: 'default' }, setup: async fixture => { for (const name of files) await writeFile(join(fixture.cwd, `${name}.txt`), 'old\n'); } });
    // A reread shows the tool rows in the order the live stream showed them.
    const toolOrder = (observations: ProviderObservation[]) => [...new Set(observations.flatMap(({ event }) => event.type === 'timeline' && event.item.type === 'tool_call' && event.item.name === 'Edit' ? [event.item.callId] : []))];
    expect(toolOrder(run.live)).toEqual(files.map(name => `edit-${name}`));
    expect(toolOrder(run.reread)).toEqual(toolOrder(run.live));
  }, 90_000);

  it('images: a user image, an image a tool returns, and a folded input with an image', async () => {
    await recorded('images', (body, response) => {
      if (sawInput(body, 'FOLDED_IMAGE')) return nativeReply(response, [{ type: 'text', text: 'SAW_FOLDED_IMAGE' }]);
      if (sawInput(body, 'WAIT_FOR_FOLD')) return sawInput(body, 'fold-wait') ? nativeReply(response, [{ type: 'text', text: 'WAITED' }]) : nativeReply(response, [{ type: 'tool_use', id: 'fold-wait', name: 'Bash', input: { command: 'sleep 2', description: 'wait' } }]);
      if (sawInput(body, 'read-image')) return nativeReply(response, [{ type: 'text', text: 'IMAGE_OK' }]);
      if (sawInput(body, 'SHOW_PIXEL')) return nativeReply(response, [{ type: 'tool_use', id: 'read-image', name: 'Read', input: { file_path: inWorkspace(body, 'pixel.png') } }]);
      return nativeReply(response, [{ type: 'text', text: 'SAW_IMAGE' }]);
    }, async (session, seen, { fixture }) => {
      const path = join(fixture.cwd, 'pixel.png');
      await writeFile(path, PNG);
      const image = { type: 'image' as const, path, mediaType: 'image/png' as const, sha256: createHash('sha256').update(PNG).digest('hex'), label: 'image #1' };
      await session.sendMessageContent!([{ type: 'text', text: 'Look at this' }, image]); await turnsDone(seen, 1);
      await session.sendMessage('SHOW_PIXEL: read pixel.png'); await turnsDone(seen, 2);
      await session.sendMessage('WAIT_FOR_FOLD'); await toolCalled(seen, 'running');
      await session.sendMessageContent!([{ type: 'text', text: 'FOLDED_IMAGE look too' }, image]); await turnsDone(seen, 3);
    });
  }, 120_000);

  it('hook: a UserPromptSubmit hook that adds context, which neither path shows', async () => {
    await recorded('hook', (body, response) => nativeReply(response, [{ type: 'text', text: sawInput(body, 'HOOK_CONTEXT') ? 'SAW_HOOK' : 'NO_HOOK' }]), async (session, seen) => {
      await session.sendMessage('Hello'); await turnsDone(seen, 1);
    }, { setup: async fixture => {
      const output = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'HOOK_CONTEXT' } });
      await writeFile(join(fixture.options.env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `printf '%s' '${output}'` }] }] } }));
    } });
  }, 60_000);
});

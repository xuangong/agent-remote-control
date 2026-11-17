import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AgentInteractionRequest, AgentSession, ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { journalObservation, recordingShape, serializeRecording, type JournalRecording } from '@orchardworks/agent-provider-sdk/testing';

import { CodexAppServerProvider } from './provider.js';
import { call, message, patch, pause, reasoning, shell, stalled, startResponsesFixture, type ResponsesFixture, type ResponsesFixtureOptions, type ResponsesScript } from './test-utils/native-responses-fixture.js';

/**
 * Records what the real Codex CLI does for the scenarios a journal must survive: the observations of the live run, and the history
 * observations of the same native session opened again. The app-server runs against a scripted Responses API and a temporary CODEX_HOME;
 * nothing signs in. `RECORD_JOURNAL_FIXTURES=1` rewrites src/journal-fixtures; otherwise the run is compared with the stored recording
 * by the shape of its identities, so a change of the adapter or of the CLI is a visible change.
 */
const executable = process.env.BORGEE_CODEX_TEST_EXECUTABLE ?? 'codex';
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'journal-fixtures');
const RECORDING = process.env.RECORD_JOURNAL_FIXTURES === '1';
const PATCH_MODEL = 'step-settings-a';

type Stream = ReturnType<typeof watch>;
interface Context { f: ResponsesFixture; provider: CodexAppServerProvider; /** 1 for the session that ran first, 2 for the one opened after it. */ round: number; handle(): Promise<NonNullable<Awaited<ReturnType<AgentSession['runtimeInfo']>>['persistence']>> }
type Drive = (session: AgentSession, seen: Stream, context: Context) => Promise<void>;

async function waitFor(condition: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => { setTimeout(resolve, 50); });
  }
}

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
const itemSeen = (seen: Stream, predicate: (item: NonNullable<ReturnType<typeof timelineItem>>) => boolean) => waitFor(() => seen.events().some(event => { const item = timelineItem(event); return item !== undefined && predicate(item); }), 'a timeline item');
const timelineItem = (event: ProviderObservation['event']) => event.type === 'timeline' ? event.item : undefined;

async function readAgain(provider: CodexAppServerProvider, handle: Awaited<ReturnType<Context['handle']>>): Promise<ProviderObservation[]> {
  const resumed = await provider.resumeSession(handle);
  const history = watch(resumed);
  await history.ready();
  const reread = history.history().filter(journalObservation);
  await resumed.dispose(); await history.done;
  return reread;
}

function newProvider(f: ResponsesFixture): CodexAppServerProvider {
  return new CodexAppServerProvider({ executable, env: f.env, requestTimeoutMs: 20_000 });
}

async function record(script: ResponsesScript, drive: Drive, options: ResponsesFixtureOptions & { model?: string; planning?: boolean; newProcess?: boolean; reopen?: boolean } = {}): Promise<{ recording: JournalRecording; cwd: string; home: string }> {
  const f = await startResponsesFixture(script, options);
  let provider = newProvider(f);
  try {
    const session = await provider.createSession({ sessionId: 'public', cwd: f.cwd, model: options.model ?? (options.patchTool ? PATCH_MODEL : 'mock-model'), ...(options.planning ? { planning: true } : {}) });
    const seen = watch(session);
    await seen.ready();
    let handle: Awaited<ReturnType<Context['handle']>> | undefined;
    const context: Context = { f, provider, round: 1, handle: async () => (handle ??= (await session.runtimeInfo()).persistence!) };
    await drive(session, seen, context);
    const persisted = await context.handle();
    await session.dispose(); await seen.done;
    let live = seen.kept();
    if (options.newProcess) provider = newProvider(f);
    if (options.reopen) {
      // A turn run after a reopen: the second session reads the first turn as history and runs the second one live.
      context.round = 2;
      const second = await provider.resumeSession(persisted);
      const secondSeen = watch(second);
      await secondSeen.ready();
      await drive(second, secondSeen, context);
      await second.dispose(); await secondSeen.done;
      live = secondSeen.kept();
    }
    return { recording: { live, reread: await readAgain(provider, persisted) }, cwd: f.cwd, home: f.home };
  } finally { await f.close(); }
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
  const clean = await scrub(recording, [cwd, home, tmpdir(), homedir()]);
  if (RECORDING) { await mkdir(FIXTURES, { recursive: true }); await writeFile(path, serializeRecording(clean)); return; }
  if (!existsSync(path)) throw new Error(`No recording ${name}.json: run with RECORD_JOURNAL_FIXTURES=1.`);
  expect(recordingShape(clean), `the shape of the ${name} recording`).toEqual(recordingShape(JSON.parse(await readFile(path, 'utf8')) as JournalRecording));
}

async function recorded(name: string, script: ResponsesScript, drive: Drive, options?: Parameters<typeof record>[2]) {
  const { recording, cwd, home } = await record(script, drive, options);
  await check(name, recording, cwd, home);
  return recording;
}

const answer = { kind: 'question' as const, answers: [{ questionId: 'profession', selectedValues: ['Engineer'] }] };
const profession = call('q1', 'request_user_input', { questions: [{ id: 'profession', header: 'Profession', question: 'Choose', options: [{ label: 'Engineer', description: 'Build' }, { label: 'Designer', description: 'Design' }] }] });
const addFile = (callId: string, name: string) => patch(callId, `*** Begin Patch\n*** Add File: ${name}\n+hello\n*** End Patch`);

describe('the recordings of the real Codex CLI', () => {
  // Turn one streams text, runs a command, changes a file and answers; turn two answers.
  const settled: ResponsesScript = (request, index) => index === 0 ? [...message('m1', 'Running it.', ['Running ', 'it.']), ...shell('c1', 'printf SETTLED_OK')]
    : index === 1 ? addFile('p1', 'hello.txt') : index === 2 ? message('m2', 'ANSWER_1', ['ANSWER', '_1']) : message('m3', 'ANSWER_2', ['ANSWER', '_2']);
  const converse: Drive = async (session, seen) => {
    await session.sendMessage('First'); await turnsDone(seen, 1);
    await session.sendMessage('Second'); await turnsDone(seen, 2);
  };
  const settledOptions = { patchTool: true, sandboxMode: 'workspace-write' as const };

  it('settled: streamed text, a command with its output, a file change and a second turn, released and reopened', async () => {
    const run = await recorded('settled', settled, converse, settledOptions);
    expect(run.reread.length).toBeGreaterThan(0);
  }, 90_000);

  it('restart: the same session read again by a new app-server process of a new provider', async () => {
    await recorded('restart', settled, converse, { ...settledOptions, newProcess: true });
  }, 90_000);

  it('reasoning: two summary parts, streamed, that history joins', async () => {
    await recorded('reasoning', () => [...reasoning('r1', ['Part one', 'Part two']), ...message('m1', 'ANSWER', ['ANS', 'WER'])],
      async (session, seen) => { await session.sendMessage('Think'); await turnsDone(seen, 1); });
  }, 60_000);

  it('approval: a question and a command approval, both resolved, neither in native history', async () => {
    await recorded('approval', (request, index) => index === 0 ? profession
      : index === 1 ? call('c1', 'exec_command', { cmd: 'touch approved.txt', sandbox_permissions: 'require_escalated', justification: 'Write a file', max_output_tokens: 200 }) : message('m1', 'FINAL'),
    async (session, seen) => {
      await session.sendMessage('Ask me, then write');
      await requested(seen, 1);
      await session.respondToInteraction!(nthRequest(seen, 0).requestId, answer);
      await requested(seen, 2);
      const approval = nthRequest(seen, 1);
      if (approval.kind !== 'tool_approval') throw new Error('Expected a tool approval.');
      await session.respondToInteraction!(approval.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'once' });
      await turnsDone(seen, 1);
    }, { approvalPolicy: 'on-request' });
  }, 90_000);

  it('todos: two plan updates, which native history never holds', async () => {
    await recorded('todos', (request, index) => index === 0 ? call('p1', 'update_plan', { plan: [{ step: 'alpha', status: 'in_progress' }, { step: 'beta', status: 'pending' }] })
      : index === 1 ? call('p2', 'update_plan', { plan: [{ step: 'alpha', status: 'completed' }, { step: 'beta', status: 'in_progress' }] }) : message('m1', 'DONE'),
    async (session, seen) => { await session.sendMessage('Plan'); await turnsDone(seen, 1); }, { config: '\n[tools.update_plan]\nenabled = true\n' });
  }, 60_000);

  it('plan-mode: a plan turn whose plan streams as a message and is offered again for approval', async () => {
    await recorded('plan-mode', () => [{ type: 'response.output_item.added', item: { type: 'message', role: 'assistant', id: 'm0', content: [] } },
      { type: 'response.output_text.delta', item_id: 'm0', delta: 'Here is the plan.\n\n' }, pause(60),
      { type: 'response.output_text.delta', item_id: 'm0', delta: '<proposed_plan>\n- one\n' }, pause(60),
      { type: 'response.output_text.delta', item_id: 'm0', delta: '</proposed_plan>\nBye' },
      { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'm0', content: [{ type: 'output_text', text: 'Here is the plan.\n\n<proposed_plan>\n- one\n</proposed_plan>\nBye' }] } }],
    async (session, seen) => {
      await session.sendMessage('Plan it'); await requested(seen, 1);
      await session.respondToInteraction!(nthRequest(seen, 0).requestId, { kind: 'plan_approval', action: 'reject' });
    }, { planning: true });
  }, 60_000);

  it('compaction: a compaction that succeeds, then a turn', async () => {
    await recorded('compaction', (request, index) => index === 0 ? message('m1', 'ANSWER_1') : index === 1 ? message('s1', 'SUMMARY') : message('m2', 'ANSWER_2'), async (session, seen) => {
      await session.sendMessage('First'); await turnsDone(seen, 1);
      await session.executeCommand!('compact', '');
      await itemSeen(seen, item => item.type === 'compaction' && item.status === 'completed');
      await waitFor(() => seen.events().filter(event => event.type === 'turn_completed').length >= 2, 'the compaction turn');
      await session.sendMessage('Second'); await turnsDone(seen, 3);
    });
  }, 90_000);

  it('interrupted: a turn cancelled while text and reasoning stream, and another during a tool', async () => {
    const partial = [{ type: 'response.output_item.added', item: { type: 'reasoning', id: 'r1', summary: [] } }, { type: 'response.reasoning_summary_part.added', item_id: 'r1', summary_index: 0 }, { type: 'response.reasoning_summary_text.delta', item_id: 'r1', summary_index: 0, delta: 'Thinking ' },
      { type: 'response.output_item.added', item: { type: 'message', role: 'assistant', id: 'm1', content: [] } }, { type: 'response.output_text.delta', item_id: 'm1', delta: 'Half of ' }];
    await recorded('interrupted', (request, index) => index === 0 ? stalled(partial) : stalled(shell('c1', 'sleep 30')), async (session, seen) => {
      await session.sendMessage('Stream then stop');
      await itemSeen(seen, item => item.type === 'assistant_message' && item.text === 'Half of ');
      await session.cancel!(); await turnsDone(seen, 1);
      await session.sendMessage('Run then stop');
      await itemSeen(seen, item => item.type === 'tool_call' && item.status === 'running');
      // The command is well under way when the turn is cancelled; cancelled at once, the native runtime sometimes records it and sometimes does not.
      await new Promise(resolve => { setTimeout(resolve, 1500); });
      await session.cancel!(); await turnsDone(seen, 2);
    });
  }, 90_000);

  it('correction: a final message and a final reasoning that do not continue what streamed', async () => {
    await recorded('correction', () => [...reasoning('r1', ['Other thought'], ['Zed']), ...message('m1', 'xyz', ['abc'])],
      async (session, seen) => { await session.sendMessage('Correct me'); await turnsDone(seen, 1); });
  }, 60_000);

  it('steer: input folded into a running turn', async () => {
    await recorded('steer', (request, index) => index === 0 ? shell('c1', 'sleep 2') : message('m1', 'AFTER_STEER', ['AFTER_', 'STEER']), async (session, seen) => {
      await session.sendMessage('Run');
      await itemSeen(seen, item => item.type === 'tool_call' && item.status === 'running');
      await session.sendMessage('Also this');
      await turnsDone(seen, 1);
    });
  }, 60_000);

  it('after-reopen: a turn run after a reopen, then read again', async () => {
    const run = await record(settled, async (session, seen, { round }) => {
      await session.sendMessage(round === 1 ? 'First' : 'Second'); await turnsDone(seen, 1);
    }, { ...settledOptions, reopen: true });
    await check('after-reopen', run.recording, run.cwd, run.home);
    expect(run.recording.live.some(({ delivery }) => delivery === 'history')).toBe(true);
    expect(run.recording.live.some(({ delivery }) => delivery === 'live')).toBe(true);
  }, 90_000);

  it('errors: a model failure that fails a turn, and a failing MCP server that reaches no timeline', async () => {
    const run = await recorded('errors', (request, index) => index === 0 ? message('m1', 'ONE') : { status: 500, body: JSON.stringify({ error: { message: 'model exploded' } }) },
      async (session, seen) => {
        await session.sendMessage('First'); await turnsDone(seen, 1);
        await session.sendMessage('Second'); await turnsDone(seen, 2);
      }, { config: '\n[mcp_servers.broken]\ncommand = "/nonexistent/arc-broken-mcp"\n' });
    // The failure is announced by the error notification and again by the turn's end: one item, and the start-up failure of the MCP server is none.
    expect(new Set(run.live.flatMap(({ event, itemIdentity }) => event.type === 'timeline' && event.item.type === 'error' ? [itemIdentity?.key] : []))).toEqual(new Set([expect.stringMatching(/^turn-error:/)]));
  }, 90_000);
});

import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ServerResponse} from 'node:http';
import {describe, expect, it} from 'vitest';
import type {AgentSession, ProviderObservation} from '@orchardworks/agent-provider-sdk';
import {journalObservation as kept, recordingShape, serializeRecording, type JournalRecording as Recording} from '@orchardworks/agent-provider-sdk/testing';
import {CopilotAgentProvider} from '../src/provider.js';
import {fixture, observe, reply, waitFor, type ModelRequest} from './native-fixture.js';

/**
 * Records what the real Copilot CLI does for the scenarios the journal must survive: the observations of the live run, and
 * the history observations of the same native session opened again. The CLI runs against a scripted model and a temporary
 * COPILOT_HOME; nothing signs in. `RECORD_JOURNAL_FIXTURES=1` rewrites tests/fixtures/journal; otherwise the run is compared
 * with the stored recording by the shape of its identities, so a change of the adapter or of the CLI is a visible change.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'journal');
const RECORDING = process.env.RECORD_JOURNAL_FIXTURES === '1';

type Handler = (body: ModelRequest, res: ServerResponse, index: number) => void;
type Drive = (session: AgentSession, seen: ReturnType<typeof observe>, context: {cwd: string; home: string}) => Promise<void>;

async function readAgain(provider: CopilotAgentProvider, handle: NonNullable<Awaited<ReturnType<AgentSession['runtimeInfo']>>['persistence']>): Promise<ProviderObservation[]> {
  const resumed = await provider.resumeSession(handle); const history = observe(resumed);
  await waitFor(() => history.items.some(item => item.type === 'history_boundary'));
  const reread = history.items.slice(0, history.items.findIndex(item => item.type === 'history_boundary')).filter(kept);
  await resumed.dispose(); await history.done;
  return reread;
}

async function record(handler: Handler, drive: Drive, options: {model?: string; reasoningEffort?: 'high'; newProcess?: boolean} = {}): Promise<Recording> {
  const f = await fixture(handler);
  try {
    const session = await f.provider.createSession({sessionId: 'public', cwd: f.cwd, model: options.model ?? 'gpt-4.1', ...(options.reasoningEffort ? {reasoningEffort: options.reasoningEffort} : {})});
    const seen = observe(session);
    await drive(session, seen, {cwd: f.cwd, home: f.home});
    const handle = (await session.runtimeInfo()).persistence!;
    await session.dispose(); await seen.done;
    const live = seen.items.filter(kept);
    if (!options.newProcess) return {live, reread: await readAgain(f.provider, handle)};
    await f.provider.dispose();
    const second = new CopilotAgentProvider({useLoggedInUser: false, requestTimeoutMs: 15000, env: {COPILOT_HOME: join(f.home, 'profile'), GITHUB_TOKEN: undefined, GH_TOKEN: undefined, COPILOT_GITHUB_TOKEN: undefined},
      nativeSessionConfig: {provider: {type: 'openai', baseUrl: f.baseUrl, wireApi: 'completions'}}});
    try { return {live, reread: await readAgain(second, handle)}; } finally { await second.dispose(); }
  } finally { await f.close(); }
}

const turnsDone = (seen: ReturnType<typeof observe>, count: number) => waitFor(() => seen.events().filter(event => event.type === 'turn_completed').length >= count);
const requests = (seen: ReturnType<typeof observe>, count: number) => waitFor(() => seen.events().filter(event => event.type === 'interaction_requested').length >= count);
const nthRequest = (seen: ReturnType<typeof observe>, at: number) => {
  const event = seen.events().filter(candidate => candidate.type === 'interaction_requested')[at];
  if (event?.type !== 'interaction_requested') throw new Error('No such interaction request.');
  return event.request;
};
const call = (name: string, args: object) => ({name, arguments: args});
/** A streamed reply that may carry reasoning, built by hand because the shared helper only knows text and one tool call. */
function stream(res: ServerResponse, body: ModelRequest, deltas: object[]) {
  res.writeHead(200, {'content-type': 'text/event-stream'});
  const chunk = (delta: object, finish: string | null) => ({id: 'fixture-completion', object: 'chat.completion.chunk', model: body.model, choices: [{index: 0, delta, finish_reason: finish}]});
  res.end([...deltas.map(delta => chunk(delta, null)), chunk({}, 'stop')].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n');
}

/** The todo snapshot is read from the CLI after the event that announced it, so its place among its neighbours varies from run to run. */
const lateTodo = (line: string) => line.includes(' todo ');

/** Paths of this machine and run never enter a fixture. */
async function scrub(recording: Recording, paths: string[]): Promise<Recording> {
  let text = JSON.stringify(recording);
  const variants = (await Promise.all(paths.map(async path => [path, await realpath(path).catch(() => path)]))).flat();
  for (const path of [...new Set(variants)].sort((a, b) => b.length - a.length)) text = text.replaceAll(path, path === homedir() ? '/home/user' : '/workspace');
  return JSON.parse(text.replaceAll(homedir(), '/home/user'));
}

async function check(name: string, recording: Recording, cwd: string, home: string) {
  const path = join(FIXTURES, `${name}.json`);
  const clean = await scrub(recording, [cwd, home, tmpdir(), homedir()]);
  if (RECORDING) { await mkdir(FIXTURES, {recursive: true}); await writeFile(path, serializeRecording(clean)); return; }
  if (!existsSync(path)) throw new Error(`No recording ${name}.json: run with RECORD_JOURNAL_FIXTURES=1.`);
  expect(recordingShape(clean, lateTodo), `the shape of the ${name} recording`).toEqual(recordingShape(JSON.parse(await readFile(path, 'utf8')) as Recording, lateTodo));
}

async function recorded(name: string, handler: Handler, drive: Drive, options?: Parameters<typeof record>[2]) {
  let context = {cwd: '', home: ''};
  const recording = await record(handler, async (session, seen, where) => { context = where; await drive(session, seen, where); }, options);
  await check(name, recording, context.cwd, context.home);
  return recording;
}

describe('the recordings of the real Copilot CLI', () => {
  const settled: Handler = (body, res, index) => reply(res, body, index === 1 ? call('bash', {command: 'echo SETTLED_OK', description: 'Print'}) : `ANSWER_${index}`);
  const converse: Drive = async (session, seen) => {
    await session.setSessionSetting!('tool_approval_mode', 'allow');
    await session.sendMessage('First'); await turnsDone(seen, 1);
    await session.sendMessage('Second'); await turnsDone(seen, 2);
  };

  it('settled: streamed text, a tool call with its result and a second turn, released and reopened', async () => {
    const run = await recorded('settled', settled, converse);
    expect(run.reread.length).toBeGreaterThan(0);
  }, 60000);

  it('restart: the same session read again by a new CLI process', async () => {
    await recorded('restart', settled, converse, {newProcess: true});
  }, 60000);

  it('reasoning: a streamed reasoning the native history does not keep', async () => {
    await recorded('reasoning', (body, res) => stream(res, body, [{role: 'assistant', reasoning_content: 'Let me '}, {reasoning_content: 'think.'}, {content: 'ANS'}, {content: 'WER'}]),
      async (session, seen) => { await session.sendMessage('Think'); await turnsDone(seen, 1); }, {model: 'gpt-5.4', reasoningEffort: 'high'});
  }, 60000);

  it('approval: a question and a session-scope tool approval', async () => {
    let outside = '';
    const dir = await mkdtemp(join(homedir(), '.arc-journal-recording-'));
    try {
      outside = join(dir, 'outside.txt'); await writeFile(outside, 'MARKER');
      await recorded('approval', (body, res, index) => reply(res, body, index === 1 ? call('ask_user', {question: 'Choose a marker', choices: ['BLUE', 'GREEN'], allow_freeform: true}) : index === 2 ? call('view', {path: outside}) : 'FINAL_REPLY'), async (session, seen) => {
        await session.sendMessage('Ask me, then read');
        await requests(seen, 1);
        const question = nthRequest(seen, 0);
        if (question.kind !== 'question') throw new Error('Expected a question.');
        await session.respondToInteraction(question.requestId, {kind: 'question', answers: [{questionId: question.questions[0]!.questionId, selectedValues: ['BLUE']}]});
        for (let at = 1; at <= 2; at += 1) {
          await requests(seen, at + 1);
          await session.respondToInteraction(nthRequest(seen, at).requestId, {kind: 'tool_approval', decision: 'allow', scope: 'session'});
        }
        await turnsDone(seen, 1);
      });
    } finally { await rm(dir, {recursive: true, force: true}); }
  }, 60000);

  it('todos: two changes of the todo list', async () => {
    const sql = (query: string) => call('sql', {description: 'Update todos', query});
    await recorded('todos', (body, res, index) => reply(res, body, index === 1 ? sql("CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, title TEXT, description TEXT, status TEXT); INSERT INTO todos (id, title, status) VALUES ('one', 'Write the test', 'in_progress');")
      : index === 3 ? sql("UPDATE todos SET status = 'done' WHERE id = 'one';") : `ANSWER_${index}`), converse);
  }, 60000);

  it('compaction: one that succeeds and one that fails', async () => {
    let failing = false;
    await recorded('compaction', (body, res, index) => reply(res, body, index === 1 ? 'FIRST' : 'SUMMARY'), async (session, seen) => {
      await session.sendMessage('Hello'); await turnsDone(seen, 1);
      const rpc = (session as unknown as {rpc: {history: {compact(options: object): Promise<unknown>}}}).rpc;
      await rpc.history.compact({});
      failing = true;
      await rpc.history.compact({}).catch(() => undefined);
      await waitFor(() => seen.events().filter(event => event.type === 'timeline' && event.item.type === 'error').length >= 1);
    });
    expect(failing).toBe(true);
  }, 90000);

  it('interrupted: a turn cancelled while it streams, released and reopened', async () => {
    let held: ServerResponse | undefined;
    await recorded('interrupted', (body, res, index) => {
      if (index > 1) return reply(res, body, 'AFTER');
      res.writeHead(200, {'content-type': 'text/event-stream'});
      res.write(`data: ${JSON.stringify({id: 'x', object: 'chat.completion.chunk', model: body.model, choices: [{index: 0, delta: {role: 'assistant', content: 'PARTIAL TEXT'}, finish_reason: null}]})}\n\n`);
      held = res;
    }, async (session, seen) => {
      await session.sendMessage('Stream for long');
      await waitFor(() => seen.events().some(event => event.type === 'timeline' && event.item.type === 'assistant_message'));
      await session.cancel!();
      await waitFor(() => seen.events().some(event => event.type === 'turn_canceled'));
      held?.end();
    });
  }, 60000);

  it('partial-tool: a tool that streams output before it completes', async () => {
    await recorded('partial-tool', (body, res, index) => reply(res, body, index === 1 ? call('bash', {command: 'echo ONE; sleep 1; echo TWO; sleep 1; echo THREE', description: 'Slow output', initial_wait: 1}) : 'DONE'),
      async (session, seen) => { await session.setSessionSetting!('tool_approval_mode', 'allow'); await session.sendMessage('Run slowly'); await turnsDone(seen, 1); });
  }, 90000);
});

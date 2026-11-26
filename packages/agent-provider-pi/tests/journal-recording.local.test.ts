import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { AgentSession, ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { journalObservation as kept, recordingShape, serializeRecording, type JournalRecording as Recording } from '@orchardworks/agent-provider-sdk/testing';
import { piBehaviour } from '../src/behaviour.js';
import { PiAgentProvider } from '../src/provider.js';
import { fixture, observe, piRuntimeVersion, reply, waitFor, type ModelRequest } from '../src/test-utils/native-fixture.js';

/**
 * Records what the real pi CLI does for the scenarios the journal must survive: the observations of the live run, and the history observations
 * of the same native session opened again. The CLI runs against a scripted model and a temporary profile; nothing signs in.
 * `RECORD_JOURNAL_FIXTURES=1` rewrites tests/fixtures/journal; otherwise the run is compared with the stored recording by the shape of its
 * identities, so a change of the adapter or of the CLI is a visible change.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'journal');
const cli = { name: 'pi', version: piRuntimeVersion() };
const RECORDING = process.env.RECORD_JOURNAL_FIXTURES === '1';

type Handler = (body: ModelRequest, res: ServerResponse, index: number) => void;
type Context = { cwd: string; home: string };
type Drive = (session: AgentSession, seen: ReturnType<typeof observe>, context: Context) => Promise<void>;

async function readAgain(provider: PiAgentProvider, handle: NonNullable<Awaited<ReturnType<AgentSession['runtimeInfo']>>['persistence']>): Promise<ProviderObservation[]> {
  const resumed = await provider.resumeSession(handle); const history = observe(resumed);
  await waitFor(() => history.items.some(item => item.type === 'history_boundary'), 'the history boundary');
  const reread = history.items.slice(0, history.items.findIndex(item => item.type === 'history_boundary')).filter(kept);
  await resumed.dispose(); await history.done;
  return reread;
}

async function record(handler: Handler, drive: Drive, options: { newProcess?: boolean; yolo?: boolean; model?: string } = {}): Promise<{ recording: Recording; context: Context }> {
  const f = await fixture(handler);
  try {
    const session = await f.provider.createSession({ sessionId: 'public', cwd: f.cwd, yolo: options.yolo ?? true, ...(options.model ? { model: options.model } : {}) });
    const seen = observe(session);
    const context = { cwd: f.cwd, home: f.home };
    await drive(session, seen, context);
    const handle = (await session.runtimeInfo()).persistence!;
    await session.dispose(); await seen.done;
    const live = seen.items.filter(kept);
    if (!options.newProcess) return { recording: { live, reread: await readAgain(f.provider, handle) }, context };
    await f.provider.dispose();
    const second = new PiAgentProvider({ executable: (f.provider as unknown as { options: { executable: string } }).options.executable, env: f.environment, requestTimeoutMs: 15_000 });
    try { return { recording: { live, reread: await readAgain(second, handle) }, context }; } finally { await second.dispose(); }
  } finally { await f.close(); }
}

const turns = (seen: ReturnType<typeof observe>, count: number) => waitFor(() => seen.events().filter(event => event.type === 'turn_completed').length >= count, `${count} completed turn(s)`);
const call = (name: string, args: object) => ({ name, arguments: args });

/** Paths of this machine and run never enter a fixture, and the clock of the run does not either: each timestamp pi wrote is numbered in the order it appears. */
async function scrub(recording: Recording, paths: string[]): Promise<Recording> {
  let text = JSON.stringify(recording);
  const variants = (await Promise.all(paths.map(async path => [path, await realpath(path).catch(() => path)]))).flat();
  for (const path of [...new Set(variants)].sort((a, b) => b.length - a.length)) text = text.replaceAll(path, path === homedir() ? '/home/user' : '/workspace');
  text = text.replaceAll(homedir(), '/home/user');
  // The timestamps that name an item are numbered, per kind of item, in the order the items appear (two kinds may share a millisecond);
  // every other clock reading is one fixed value.
  const stamps = new Map<string, number>();
  const ordinal = (kind: string, stamp: string) => { const key = `${kind}:${stamp}`; if (!stamps.has(key)) stamps.set(key, 1_795_000_000_000 + stamps.size); return stamps.get(key)!; };
  // One pass, so a number just written is never read as a clock reading again.
  text = text.replace(/\b(user|assistant|reasoning|error|bash|turn):(1[67]\d{11})\b|\b1[67]\d{11}\b/g, (whole, kind: string | undefined, stamp: string | undefined) => {
    if (!kind) return '1795000000000';
    if (kind === 'turn') return `turn:${stamps.get(`user:${stamp}`) ?? 1_795_000_000_000}`;
    return `${kind}:${ordinal(kind, stamp!)}`;
  });
  return JSON.parse(text) as Recording;
}

async function check(name: string, recording: Recording, context: Context) {
  const path = join(FIXTURES, `${name}.json`);
  const clean = { cli, ...await scrub(recording, [context.cwd, context.home, tmpdir(), homedir()]) };
  if (RECORDING) { await mkdir(FIXTURES, { recursive: true }); await writeFile(path, serializeRecording(clean)); return; }
  if (!existsSync(path)) throw new Error(`No recording ${name}.json: run with RECORD_JOURNAL_FIXTURES=1.`);
  const order = piBehaviour.reread.order;
  expect(recordingShape(clean, order), `the shape of the ${name} recording`).toEqual(recordingShape(JSON.parse(await readFile(path, 'utf8')) as Recording, order));
}

async function recorded(name: string, handler: Handler, drive: Drive, options?: Parameters<typeof record>[2]) {
  const { recording, context } = await record(handler, drive, options);
  await check(name, recording, context);
  return recording;
}

describe('the recordings of the real pi CLI', () => {
  const settled: Handler = (body, res, index) => reply(res, body, index === 1 ? call('bash', { command: 'echo SETTLED_OK' }) : `ANSWER_${index}`);
  const converse: Drive = async (session, seen) => {
    await session.sendMessage('First'); await turns(seen, 1);
    await session.sendMessage('Second'); await turns(seen, 2);
  };

  it('settled: streamed text, a tool call with its result and a second turn, released and reopened', async () => {
    const run = await recorded('settled', settled, converse);
    expect(run.reread.length).toBeGreaterThan(0);
  }, 60_000);

  it('restart: the same session read again by a new pi process', async () => {
    await recorded('restart', settled, converse, { newProcess: true });
  }, 60_000);

  it('reasoning: a streamed thinking block that the session file keeps', async () => {
    await recorded('reasoning', (body, res) => reply(res, body, { thinking: 'Let me think.', text: 'ANSWER' }),
      async (session, seen) => { await session.sendMessage('Think'); await turns(seen, 1); }, { model: 'fixture/m2' });
  }, 60_000);

  it('approval: a tool allowed once and a tool denied', async () => {
    await recorded('approval', (body, res, index) => reply(res, body, index === 1 ? call('bash', { command: 'echo ALLOWED' }) : index === 2 ? call('bash', { command: 'echo DENIED' }) : 'FINAL_REPLY'), async (session, seen) => {
      await session.sendMessage('Run two');
      for (const [at, decision] of [[1, 'allow'], [2, 'deny']] as const) {
        await waitFor(() => seen.events().filter(event => event.type === 'interaction_requested').length >= at, `approval ${at}`);
        const request = seen.events().filter(event => event.type === 'interaction_requested')[at - 1];
        if (request?.type !== 'interaction_requested') throw new Error('Expected an approval.');
        await session.respondToInteraction(request.request.requestId, decision === 'allow' ? { kind: 'tool_approval', decision, scope: 'once' } : { kind: 'tool_approval', decision, message: 'No.' });
      }
      await turns(seen, 1);
    }, { yolo: false });
  }, 60_000);

  it('interrupted: a turn canceled while it streams, released and reopened', async () => {
    let held: ServerResponse | undefined;
    await recorded('interrupted', (body, res, index) => {
      if (index > 1) return reply(res, body, 'AFTER');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'PARTIAL TEXT' }, finish_reason: null }] })}\n\n`);
      held = res;
    }, async (session, seen) => {
      await session.sendMessage('Stream for long');
      await waitFor(() => seen.events().some(event => event.type === 'timeline' && event.item.type === 'assistant_message'), 'streamed text');
      await session.cancel!();
      await waitFor(() => seen.events().some(event => event.type === 'turn_canceled'), 'the cancellation');
      held?.end();
    });
  }, 60_000);

  it('failed: a turn the model server refuses, with the error kept in the file', async () => {
    await recorded('failed', (_body, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'refused by the fixture', type: 'invalid_request_error' } })); },
      async (session, seen) => { await session.sendMessage('Fail'); await waitFor(() => seen.events().some(event => event.type === 'turn_failed'), 'the failure'); });
  }, 60_000);

  it('steered: input sent during a run joins it as steering', async () => {
    let held: { res: ServerResponse; body: ModelRequest } | undefined;
    await recorded('steered', (body, res, index) => { if (index === 1) held = { res, body }; else reply(res, body, 'ACK'); }, async (session, seen) => {
      await session.sendMessage('Start'); await waitFor(() => held, 'the first request');
      await session.sendMessage('Also this');
      reply(held!.res, held!.body, call('bash', { command: 'echo STEERED_BASE' }));
      await turns(seen, 1);
    });
  }, 60_000);

  it('partial-tool: a tool that streams output before it completes', async () => {
    await recorded('partial-tool', (body, res, index) => reply(res, body, index === 1 ? call('bash', { command: 'echo ONE; sleep 1; echo TWO' }) : 'DONE'),
      async (session, seen) => { await session.sendMessage('Run slowly'); await turns(seen, 1); });
  }, 60_000);
});

import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { AgentSessionInUseError, readUnknownNativeEvent, type AgentSession, type ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { followSession } from '@orchardworks/agent-provider-sdk/conformance';

import { codexBehaviour } from './behaviour.js';
import { CodexAppServerProvider } from './provider.js';
import { recording, recordingNames } from './recordings.js';
import { message, shell, startResponsesFixture } from './test-utils/native-responses-fixture.js';

/**
 * The native assumption checks of Codex (step B5, section 4.4 of `docs/superpowers/specs/2026-11-21-requirements-vs-external-dependencies.md`):
 * what the adapter declares (`behaviour.ts`) and what its recordings record, re-verified against the installed CLI, which updates itself.
 * Run nightly or by hand with `pnpm test:native:codex`, which also runs the recorder against the committed recordings. A difference fails
 * loudly and names the declared field it contradicts. Every check runs `codex app-server` against a scripted Responses API in a temporary
 * CODEX_HOME: nothing signs in, and no thread of the person's own Codex is touched.
 */
const executable = process.env.BORGEE_CODEX_TEST_EXECUTABLE ?? 'codex';
const declared = codexBehaviour('shared');
const installed = /codex-cli\s+(\d+\.\d+\.\d+)/.exec(execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000 }))?.[1];
const INPUT_ID = '0b6f8f60-5d2e-4c5a-9a33-3e8d1c4b7a21';

async function opened(session: AgentSession) {
  const seen = followSession(session);
  await seen.boundary();
  return seen;
}
const turnEnded = (seen: ReturnType<typeof followSession>) => seen.until(() => seen.liveEvents().some(event => event.type === 'turn_completed' || event.type === 'turn_failed'), 'the end of the turn', 30_000);

/** The raw answers of a `codex app-server` process to requests about a thread, as JSON-RPC carries them: the error, or `answered`. */
async function rawAnswers(env: Record<string, string>, requests: Array<[method: string, params: unknown]>): Promise<Array<{ code?: unknown; message?: unknown; data?: unknown } | 'answered'>> {
  const child = spawn(executable, ['app-server'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout! });
  const answers = new Map<number, (value: { result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } }) => void>();
  lines.on('line', line => { try { const value = JSON.parse(line) as { id?: number }; if (typeof value.id === 'number') answers.get(value.id)?.(value); } catch { /* Not an answer. */ } });
  let next = 0;
  const request = (method: string, params: unknown) => new Promise<{ result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } }>(resolve => {
    const id = ++next; answers.set(id, resolve); child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    await request('initialize', { clientInfo: { name: 'arc_native_check', title: 'Agent Remote Control native check', version: '0.0.0' }, capabilities: { experimentalApi: true } });
    child.stdin!.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const answers = [];
    for (const [method, params] of requests) { const answer = await request(method, params); answers.push(answer.error ?? 'answered' as const); }
    return answers;
  } finally { child.kill('SIGTERM'); }
}

describe(`the installed Codex CLI (${installed ?? 'no version'}) against the declaration and the recordings`, () => {
  it('is the version the declaration was verified on (verifiedVersion)', () => {
    expect(installed, `verifiedVersion ${declared.verifiedVersion}: the installed CLI is codex ${installed}. Run these checks against it and update verifiedVersion in behaviour.ts`).toBe(declared.verifiedVersion);
  });

  it('made the recordings (their cli header)', () => {
    const others = recordingNames().flatMap(name => recording(name).cli?.version === installed ? [] : [`${name} (${recording(name).cli?.version ?? 'none'})`]);
    expect(others, `recordings made with another Codex than the installed ${installed}: record them again with RECORD_JOURNAL_FIXTURES=1 pnpm test:native:codex, then review the diff and the golden rows`).toEqual([]);
  });

  it("refuses a second process on a thread another process holds, typed writer_elsewhere, in the words the adapter matches (concurrency.probe 'lock_file', failures.inUse)", async () => {
    const f = await startResponsesFixture([message('m1', 'HELD')]);
    const holder = new CodexAppServerProvider({ executable, env: f.env, requestTimeoutMs: 20_000 });
    const session = await holder.createSession({ sessionId: 'holder', cwd: f.cwd, model: 'mock-model' });
    try {
      const seen = await opened(session);
      await session.sendMessage('Hold this thread');
      await turnEnded(seen);
      const handle = (await session.runtimeInfo()).persistence!;
      // The words and code Codex answers with: the adapter matches them, and would match a structured code if Codex gave one.
      const [raw] = await rawAnswers(f.env, [['thread/resume', { threadId: handle.sessionId, excludeTurns: true }]]);
      expect(raw, 'concurrency.probe lock_file: a second app-server resumed a thread another one holds').not.toBe('answered');
      expect(raw).toMatchObject({ code: -32600, message: `thread ${handle.sessionId} already has an active writer` });
      expect(raw === 'answered' ? undefined : raw!.data, 'Codex now gives the refusal a structured code: match it instead of the words (session.ts)').toBeUndefined();
      const second = new CodexAppServerProvider({ executable, env: f.env, requestTimeoutMs: 20_000 });
      const refused = await second.resumeSession(handle).then(async resumed => { await resumed.dispose(); return undefined; }, (error: unknown) => error);
      expect(refused, 'failures.inUse writer_elsewhere').toBeInstanceOf(AgentSessionInUseError);
      expect(refused).toMatchObject({ reason: 'writer_elsewhere' });
    } finally { await session.dispose(); await f.close(); }
  }, 90_000);

  it('refuses a steer when no turn runs in the words the adapter matches (session.ts)', async () => {
    const f = await startResponsesFixture([message('m1', 'DONE')]);
    const provider = new CodexAppServerProvider({ executable, env: f.env, requestTimeoutMs: 20_000 });
    const session = await provider.createSession({ sessionId: 'steer', cwd: f.cwd, model: 'mock-model' });
    try {
      const seen = await opened(session);
      await session.sendMessage('Finish');
      await turnEnded(seen);
      const threadId = (await session.runtimeInfo()).persistence!.sessionId;
      await session.dispose(); await seen.done;
      const [, steer] = await rawAnswers(f.env, [['thread/resume', { threadId, excludeTurns: true }],
        ['turn/steer', { threadId, expectedTurnId: 'no-such-turn', clientUserMessageId: INPUT_ID, input: [{ type: 'text', text: 'Also', text_elements: [] }] }]]);
      expect(steer, 'the refusal of a steer without a running turn').toMatchObject({ message: 'no active turn to steer' });
    } finally { await f.close(); }
  }, 90_000);

  it("keeps the client's input id as the user message's clientId, live and when read again (input.identity 'echoes_client_id')", async () => {
    const f = await startResponsesFixture((request, index) => index === 0 ? shell('c1', 'printf NATIVE_OK') : message('m1', 'DONE'));
    const diagnostics: string[] = [];
    const provider = new CodexAppServerProvider({ executable, env: f.env, requestTimeoutMs: 20_000, onDiagnostic: line => diagnostics.push(line) });
    try {
      const session = await provider.createSession({ sessionId: 'identity', cwd: f.cwd, model: 'mock-model' });
      const seen = await opened(session);
      await session.sendMessage('Run it', { inputId: INPUT_ID });
      await turnEnded(seen);
      const handle = (await session.runtimeInfo()).persistence!;
      await session.dispose(); await seen.done;
      const again = await provider.resumeSession(handle);
      const reread = await opened(again);
      await again.dispose(); await reread.done;
      const ids = (observations: ProviderObservation[]) => observations.flatMap(({ event }) => event.type === 'timeline' && event.item.type === 'user_message' ? [event.item.clientMessageId] : []);
      expect(ids(seen.journal()), 'input.identity live').toContain(INPUT_ID);
      expect(ids(reread.history()), 'input.identity on a reread').toContain(INPUT_ID);
      // A normal turn with a command sends nothing the adapter does not know (gap 10): a new notification shows here first.
      expect(diagnostics.flatMap(line => { const unknown = readUnknownNativeEvent(line); return unknown ? [`${unknown.delivery} ${unknown.kind}`] : []; }), 'events of a kind the adapter does not know').toEqual([]);
    } finally { await f.close(); }
  }, 90_000);
});

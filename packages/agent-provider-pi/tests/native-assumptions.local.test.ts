import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentSessionInUseError, readUnknownNativeEvent } from '@orchardworks/agent-provider-sdk';
import { piBehaviour } from '../src/behaviour.js';
import { PiAgentProvider } from '../src/provider.js';
import { spawnPi, type PiChannel } from '../src/process.js';
import { PiRpc } from '../src/rpc.js';
import { recording, recordingNames } from '../src/recordings.js';
import { fixture, nativePiExecutable, observe, piRuntimeVersion, reply, waitFor } from '../src/test-utils/native-fixture.js';

/**
 * The native assumption checks of the pi CLI: what the adapter declares (`behaviour.ts`) and what its recordings record, re-verified against the
 * installed pi. Run with `pnpm test:native:pi`, which also runs the recorder. A difference fails loudly and names the declared field it
 * contradicts. The CLI runs against a scripted model in a temporary profile (PI_CODING_AGENT_DIR): nothing signs in.
 */
const installed = piRuntimeVersion();
const call = (name: string, args: object) => ({ name, arguments: args });
const turns = (seen: ReturnType<typeof observe>, count: number) => waitFor(() => seen.events().filter(event => event.type === 'turn_completed').length >= count, `${count} completed turn(s)`);
const unknownKinds = (lines: string[]) => lines.flatMap(line => { const unknown = readUnknownNativeEvent(line); return unknown ? [`${unknown.delivery} ${unknown.kind}`] : []; });

describe(`the pi CLI the adapter runs (${installed}) against the declaration and the recordings`, () => {
  it('is the version the declaration was verified on (verifiedVersion)', () => {
    expect(installed, `verifiedVersion ${piBehaviour.verifiedVersion ?? 'none'}: the adapter runs pi ${installed}. Run these checks against it and update verifiedVersion in behaviour.ts`).toBe(piBehaviour.verifiedVersion);
  });

  it('made the recordings (their cli header)', () => {
    const others = recordingNames().flatMap(name => recording(name).cli?.version === installed ? [] : [`${name} (${recording(name).cli?.version ?? 'none'})`]);
    expect(others, `recordings made with another pi than ${installed}: record them again with RECORD_JOURNAL_FIXTURES=1, then review the diff and the golden rows`).toEqual([]);
  });

  it('opens a session within the resume deadline (resume.deadlineMs)', async () => {
    const f = await fixture((body, res) => reply(res, body, 'READY'));
    try {
      const started = Date.now();
      const session = await f.provider.createSession({ sessionId: 'a', cwd: f.cwd });
      expect(Date.now() - started, 'resume.deadlineMs: a healthy open took longer').toBeLessThan(piBehaviour.resume.deadlineMs);
      await session.dispose();
    } finally { await f.close(); }
  }, 60_000);

  it("accepts a second process on the session another process writes, and the two fork its history (concurrency.model 'fork_on_divergence', probe 'none', failures.inUse)", async () => {
    const f = await fixture((body, res, index) => reply(res, body, `ANSWER_${index}`));
    const second = new PiAgentProvider({ executable: nativePiExecutable(), env: f.environment, requestTimeoutMs: 15_000 });
    try {
      const first = await f.provider.createSession({ sessionId: 'a', cwd: f.cwd, yolo: true });
      const seen = observe(first);
      await first.sendMessage('Hold this session'); await turns(seen, 1);
      const handle = (await first.runtimeInfo()).persistence!;
      const other = await second.resumeSession(handle).catch((error: unknown) => error);
      expect(other, 'concurrency.probe none: a second process was refused, so pi does detect another writer').not.toBeInstanceOf(AgentSessionInUseError);
      expect(other, `the second process could not open the session: ${String(other)}`).not.toBeInstanceOf(Error);
      const session = other as Awaited<ReturnType<PiAgentProvider['resumeSession']>>;
      const again = observe(session);
      await first.sendMessage('From the first'); await turns(seen, 2);
      await session.sendMessage('From the second'); await turns(again, 1);
      await first.dispose(); await session.dispose(); await seen.done; await again.done;
      // The file holds both turns, and a reader follows the branch of the last write only: the other turn is not in the conversation.
      const reread = await f.provider.resumeSession(handle); const history = observe(reread);
      await waitFor(() => history.items.some(item => item.type === 'history_boundary'));
      const texts = history.timeline().flatMap(row => row.item.type === 'user_message' ? [row.item.text] : []);
      expect(texts, 'concurrency.model fork_on_divergence: two writers did not diverge the history').toEqual(['Hold this session', 'From the second']);
      await reread.dispose(); await history.done;
    } finally { await second.dispose(); await f.close(); }
  }, 90_000);

  it('sends no event of a kind the adapter does not know through a turn with tools, steering, a cancellation and a failure (a normal turn)', async () => {
    let held: import('node:http').ServerResponse | undefined;
    const f = await fixture((body, res, index) => {
      if (index === 1) reply(res, body, call('bash', { command: 'echo ONE' }));
      else if (index === 2) reply(res, body, call('write', { path: 'out.txt', content: 'x' }));
      else if (index === 3) reply(res, body, call('read', { path: 'out.txt' }));
      else if (index === 4) reply(res, body, 'DONE');
      else if (index === 5) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'PARTIAL' }, finish_reason: null }] })}\n\n`); held = res; }
      else { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'refused', type: 'invalid_request_error' } })); }
    });
    try {
      const session = await f.provider.createSession({ sessionId: 'a', cwd: f.cwd, yolo: true });
      const seen = observe(session);
      await session.sendMessage('Tools'); await turns(seen, 1);
      await session.sendMessage('Stream'); await waitFor(() => held, 'the streaming request');
      await session.cancel!(); await waitFor(() => seen.events().some(event => event.type === 'turn_canceled'));
      held?.end();
      await session.sendMessage('Fail'); await waitFor(() => seen.events().some(event => event.type === 'turn_failed'));
      await session.dispose(); await seen.done;
      expect(unknownKinds(f.diagnostics), 'events of a type the adapter does not know').toEqual([]);
    } finally { await f.close(); }
  }, 90_000);

  it('writes a session file only with the first answer, so a session never answered cannot be opened again (the empty-session limit)', async () => {
    const f = await fixture((body, res) => reply(res, body, 'FIRST'));
    try {
      const session = await f.provider.createSession({ sessionId: 'a', cwd: f.cwd });
      const handle = (await session.runtimeInfo()).persistence!;
      expect(await f.provider.listSessions(), 'a session with no answer already has a file: the empty-session limit is gone').toEqual([]);
      await session.dispose();
      await expect(f.provider.resumeSession(handle, {}, { initializeEmpty: true })).rejects.toMatchObject({ code: 'native_session_unavailable' });
    } finally { await f.close(); }
  }, 60_000);

  it('reads a name set through /name and the name the adapter appends to the file as the session name', async () => {
    const f = await fixture((body, res) => reply(res, body, 'ANSWER'));
    try {
      const session = await f.provider.createSession({ sessionId: 'a', cwd: f.cwd });
      const seen = observe(session);
      await session.sendMessage('Name me'); await turns(seen, 1);
      const handle = (await session.runtimeInfo()).persistence!;
      expect(await f.provider.renameSession(handle.sessionId, 'Named while open')).toBe('Named while open');
      await session.dispose(); await seen.done;
      expect(await f.provider.readSessionTitle(handle.sessionId), 'set_session_name no longer writes a session_info entry the adapter reads').toBe('Named while open');
      expect(await f.provider.renameSession(handle.sessionId, 'Named from outside')).toBe('Named from outside');
      const state = await stateOfSession(f, handle.sessionId);
      expect(state.sessionName, 'the session_info entry the adapter appends is not what pi reads as the name').toBe('Named from outside');
    } finally { await f.close(); }
  }, 60_000);

  it('declines the dialog of an extension the user installed, which then sees the dialog canceled instead of waiting (extension UI)', async () => {
    const f = await fixture((body, res, index) => reply(res, body, index === 1 ? call('bash', { command: 'echo SHOULD_NOT_RUN' }) : 'AFTER'));
    try {
      mkdirSync(join(f.agentDirectory, 'extensions'));
      writeFileSync(join(f.agentDirectory, 'extensions', 'guard.ts'), `export default function (pi) { pi.on('tool_call', async (event, ctx) => { const ok = await ctx.ui.confirm('Run it?', event.toolName); if (!ok) return { block: true, reason: 'declined by the guard' }; }); }\n`);
      const session = await f.provider.createSession({ sessionId: 'a', cwd: f.cwd, yolo: true });
      const seen = observe(session);
      await session.sendMessage('Run it'); await turns(seen, 1);
      expect(seen.timeline().map(row => row.item).find(item => item.type === 'tool_call')).toMatchObject({ status: 'failed', error: expect.stringContaining('declined by the guard') });
      await session.dispose(); await seen.done;
    } finally { await f.close(); }
  }, 60_000);

  it('ends a turn as native_exited when the pi process ends under it (failures.runtime)', async () => {
    let held: import('node:http').ServerResponse | undefined;
    const channels: PiChannel[] = [];
    const f = await fixture((body, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'WORKING' }, finish_reason: null }] })}\n\n`); held = res; },
      { launch: launch => { const channel = spawnPi(nativePiExecutable())(launch); channels.push(channel); return channel; } });
    try {
      const session = await f.provider.createSession({ sessionId: 'a', cwd: f.cwd });
      const seen = observe(session);
      await session.sendMessage('Work'); await waitFor(() => held, 'the request');
      await channels[0]!.stop();
      await seen.done;
      expect(seen.events().find(event => event.type === 'turn_failed'), 'failures.runtime native_exited').toMatchObject({ code: 'native_exited' });
      held?.end();
      await session.dispose();
    } finally { await f.close(); }
  }, 60_000);
});

/** What a new pi process reports of a session it opens, through the real RPC. */
async function stateOfSession(f: Awaited<ReturnType<typeof fixture>>, sessionId: string): Promise<{ sessionName?: string }> {
  const dir = join(f.agentDirectory, 'sessions');
  const file = (await f.provider.listSessions()).length ? await findFile(dir, sessionId) : undefined;
  if (!file) throw new Error('The session file is missing.');
  const channel = spawnPi(nativePiExecutable())({ args: ['--mode', 'rpc', '--offline', '--session', file], cwd: f.cwd, env: { ...process.env, ...f.environment } });
  const rpc = new PiRpc(channel, 15_000, { event: () => {}, ui: () => {}, exit: () => {} });
  try { return await rpc.request('get_state'); } finally { await rpc.stop(); }
}
async function findFile(dir: string, sessionId: string): Promise<string | undefined> {
  const { findPiSessionFile } = await import('../src/session-file.js');
  return findPiSessionFile(dir, sessionId);
}

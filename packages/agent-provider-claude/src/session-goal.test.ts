import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAgentSession } from './session.js';
import { Channel } from './channel.js';
import { CLAUDE_GOAL_COMMAND } from './goal.js';

const SESSION = '5c0e2a7b-4d1f-4e8a-9b63-2f7d0c9e1a44';
const T0 = '2026-11-28T10:00:00.000Z', T1 = '2026-11-28T10:01:00.000Z';
const goalRow = (timestamp: string, attachment: Record<string, unknown>) => `${JSON.stringify({ type: 'attachment', uuid: `u-${timestamp}`, timestamp, attachment: { type: 'goal_status', condition: 'all tests pass', ...attachment } })}\n`;
const setRow = goalRow(T0, { met: false, sentinel: true });
const checkRow = goalRow(T1, { met: false, reason: 'two tests fail' });

let home: string | undefined;
afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); home = undefined; });

/** A session over a scripted query, with the transcript Claude Code keeps for it in a temporary config directory. */
async function open(transcript: string) {
  home = await mkdtemp(join(tmpdir(), 'claude-goal-session-'));
  await mkdir(join(home, 'projects', 'workspace'), { recursive: true });
  const file = join(home, 'projects', 'workspace', `${SESSION}.jsonl`);
  await writeFile(file, transcript);
  const events = new Channel<any>();
  let input!: AsyncIterator<any>;
  const commands = [{ name: 'goal', description: 'Set a goal — keep working until the condition is met', argumentHint: '' }];
  const native = { [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](), initializationResult: async () => ({}), close: () => events.close(),
    interrupt: async () => {}, setPermissionMode: async () => {}, reloadSkills: async () => ({}), supportedCommands: async () => commands };
  const session = await ClaudeAgentSession.open({ sessionId: SESSION }, { env: { CLAUDE_CONFIG_DIR: home }, query: ((args: any) => { input = args.prompt[Symbol.asyncIterator](); return native; }) as any });
  const goals: unknown[] = [];
  void (async () => { for await (const item of session.observe()) if (item.type === 'observation' && item.event.type === 'runtime_updated') goals.push(item.event.runtimeInfo.goal); })().catch(() => {});
  return { session, file, events, goals, nextInput: () => input.next() };
}
const syntheticUser = { type: 'user', uuid: 'hook-feedback', session_id: SESSION, isSynthetic: true, message: { role: 'user', content: [{ type: 'text', text: 'Stop hook feedback:\n[all tests pass]: two tests fail' }] } };
const result = { type: 'result', subtype: 'success', is_error: false, session_id: SESSION, uuid: 'turn-result', usage: {} };

describe('the goal of a Claude Code session', () => {
  it('is restored from the transcript when the session opens, with a clear action', async () => {
    const { session } = await open(setRow + checkRow);
    try {
      expect((await session.runtimeInfo()).goal).toEqual({ objective: 'all tests pass', status: 'active', iterations: 1, lastReason: 'two tests fail',
        startedAt: Date.parse(T0), updatedAt: Date.parse(T1), actions: [{ kind: 'clear', commandId: CLAUDE_GOAL_COMMAND, args: 'clear' }] });
    } finally { await session.dispose(); }
  });

  it('has none for a session that never set one', async () => {
    const { session } = await open('');
    try { expect((await session.runtimeInfo()).goal).toBeUndefined(); } finally { await session.dispose(); }
  });

  it('follows the transcript while the goal\'s turn runs, at each record the check leaves, and reports it once', async () => {
    const { session, file, events, goals } = await open(setRow);
    try {
      expect((await session.runtimeInfo()).goal?.iterations).toBe(0);
      await appendFile(file, checkRow);
      events.push(syntheticUser);
      await expect.poll(() => goals.at(-1)).toMatchObject({ iterations: 1, lastReason: 'two tests fail' });
      const reported = goals.length;
      events.push({ ...syntheticUser, uuid: 'another' });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(goals.length).toBe(reported);
    } finally { await session.dispose(); }
  });

  it('drops the goal when `/goal clear` closed it, and shows it complete when a check found it met', async () => {
    const { session, file, events, goals } = await open(setRow);
    try {
      await appendFile(file, goalRow(T1, { met: true, reason: 'tests pass', iterations: 3, durationMs: 90_000, tokens: 800 }));
      events.push(result);
      await expect.poll(() => (goals.at(-1) as any)?.status).toBe('complete');
      expect(goals.at(-1)).toMatchObject({ iterations: 3, tokensUsed: 800, timeUsedSeconds: 90 });
      expect((goals.at(-1) as any).actions).toBeUndefined();
      await appendFile(file, setRow.replace(T0, '2026-11-28T10:05:00.000Z'));
      await appendFile(file, goalRow('2026-11-28T10:06:00.000Z', { met: true, sentinel: true }));
      events.push({ ...result, uuid: 'later-result' });
      await expect.poll(async () => (await session.runtimeInfo()).goal).toBeUndefined();
    } finally { await session.dispose(); }
  });
});

describe('the `/goal` command of a Claude Code session', () => {
  it('is a command of the session with an argument hint, not a skill', async () => {
    const { session } = await open('');
    try { expect(await session.listCommands!()).toEqual([expect.objectContaining({ id: CLAUDE_GOAL_COMMAND, name: 'goal', kind: 'command', inputHint: 'Condition to meet, or clear' })]); }
    finally { await session.dispose(); }
  });

  it('reaches Claude Code as the person typed it, the space after the command left out', async () => {
    const { session, nextInput } = await open('');
    try {
      await session.executeCommand!(CLAUDE_GOAL_COMMAND, ' all tests pass ');
      expect((await nextInput()).value.message.content).toBe('/goal all tests pass');
    } finally { await session.dispose(); }
  });

  it('clears the goal while its turn runs, which another command could not', async () => {
    const { session, nextInput } = await open(setRow);
    try {
      await session.sendMessage('work on it');
      await nextInput();
      await session.executeCommand!(CLAUDE_GOAL_COMMAND, 'clear');
      expect((await nextInput()).value.message.content).toBe('/goal clear');
    } finally { await session.dispose(); }
  });
});

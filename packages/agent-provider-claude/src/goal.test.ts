import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeGoalOfRows, ClaudeGoalTracker, CLAUDE_GOAL_COMMAND, goalRowOf } from './goal.js';

const SESSION = '5c0e2a7b-4d1f-4e8a-9b63-2f7d0c9e1a44';
const row = (timestamp: string, attachment: Record<string, unknown>) => JSON.stringify({ type: 'attachment', uuid: `u-${timestamp}`, timestamp, attachment: { type: 'goal_status', ...attachment } });
const set = (at: string, condition = 'all tests pass') => row(at, { met: false, sentinel: true, condition });
const check = (at: string, reason: string, condition = 'all tests pass') => row(at, { met: false, condition, reason });
const rowsOf = (...lines: string[]) => lines.flatMap(line => { const found = goalRowOf(line); return found ? [found] : []; });
const T0 = '2026-11-28T10:00:00.000Z', T1 = '2026-11-28T10:01:00.000Z', T2 = '2026-11-28T10:02:00.000Z';

describe('the goal a Claude Code transcript holds', () => {
  it('opens an active goal at the set row, with the clear action of the goal command', () => {
    expect(claudeGoalOfRows(rowsOf(set(T0)))).toEqual({ objective: 'all tests pass', status: 'active', iterations: 0, startedAt: Date.parse(T0), updatedAt: Date.parse(T0),
      actions: [{ kind: 'clear', commandId: CLAUDE_GOAL_COMMAND, args: 'clear' }] });
  });

  it('counts each check that found the goal not met and keeps the last reason', () => {
    const goal = claudeGoalOfRows(rowsOf(set(T0), check(T1, 'two tests fail'), check(T2, 'one test fails')));
    expect(goal).toMatchObject({ status: 'active', iterations: 2, lastReason: 'one test fails', startedAt: Date.parse(T0), updatedAt: Date.parse(T2) });
  });

  it('is complete with the evaluator\'s figures when a check found it met, and offers no action', () => {
    const goal = claudeGoalOfRows(rowsOf(set(T0), check(T1, 'x'), row(T2, { met: true, condition: 'all tests pass', reason: 'tests pass', iterations: 2, durationMs: 120_400, tokens: 3300 })));
    expect(goal).toEqual({ objective: 'all tests pass', status: 'complete', iterations: 2, tokensUsed: 3300, timeUsedSeconds: 120, lastReason: 'tests pass', startedAt: Date.parse(T0), updatedAt: Date.parse(T2) });
  });

  it('is blocked when the evaluator found the condition impossible', () => {
    expect(claudeGoalOfRows(rowsOf(set(T0), row(T1, { met: false, failed: true, condition: 'all tests pass', reason: 'no test runner', iterations: 1, durationMs: 1000, tokens: 5 }))))
      .toMatchObject({ status: 'blocked', lastReason: 'no test runner', iterations: 1 });
  });

  it('has no goal after a sentinel row that closes it, which is `/goal clear`', () => {
    expect(claudeGoalOfRows(rowsOf(set(T0), row(T1, { met: true, sentinel: true, condition: 'all tests pass' })))).toBeUndefined();
  });

  it('follows the goal that was set last, and ignores a check of an earlier one', () => {
    const goal = claudeGoalOfRows(rowsOf(set(T0, 'first'), set(T1, 'second'), check(T2, 'late', 'first')));
    expect(goal).toMatchObject({ objective: 'second', iterations: 0 });
    expect(goal?.lastReason).toBeUndefined();
  });

  it('describes a goal whose set row lies outside what was read', () => {
    expect(claudeGoalOfRows(rowsOf(check(T1, 'still failing')))).toMatchObject({ objective: 'all tests pass', status: 'active', iterations: 1, lastReason: 'still failing' });
  });

  it('skips lines that are no goal row', () => {
    expect(goalRowOf('{"type":"user","message":"a goal_status mention"}')).toBeUndefined();
    expect(goalRowOf('{"attachment":{"type":"goal_status","met":"no","condition":"x"}}')).toBeUndefined();
    expect(goalRowOf('not json goal_status')).toBeUndefined();
  });
});

describe('a tracker over a transcript file', () => {
  let home: string | undefined;
  afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); home = undefined; });
  const open = async (initial: string) => {
    home = await mkdtemp(join(tmpdir(), 'claude-goal-'));
    await mkdir(join(home, 'projects', 'workspace'), { recursive: true });
    const file = join(home, 'projects', 'workspace', `${SESSION}.jsonl`);
    await writeFile(file, initial);
    return { file, tracker: new ClaudeGoalTracker(SESSION, { CLAUDE_CONFIG_DIR: home }) };
  };

  it('restores the goal at open and reads only what is appended afterwards', async () => {
    const { file, tracker } = await open(`${set(T0)}\n${check(T1, 'first')}\n`);
    expect(await tracker.refresh()).toBe(true);
    expect(tracker.current()).toMatchObject({ iterations: 1, lastReason: 'first' });
    expect(await tracker.refresh()).toBe(false);
    await appendFile(file, `${check(T2, 'second')}\n`);
    expect(await tracker.refresh()).toBe(true);
    expect(tracker.current()).toMatchObject({ iterations: 2, lastReason: 'second' });
  });

  it('waits for the end of a row that is still being written, and keeps a split character whole', async () => {
    const { file, tracker } = await open(`${set(T0)}\n`);
    await tracker.refresh();
    const line = Buffer.from(`${check(T1, 'tests of 日本 fail')}\n`);
    const cut = line.indexOf(Buffer.from('日')) + 1;
    await appendFile(file, line.subarray(0, cut));
    expect(await tracker.refresh()).toBe(false);
    await appendFile(file, line.subarray(cut));
    expect(await tracker.refresh()).toBe(true);
    expect(tracker.current()?.lastReason).toBe('tests of 日本 fail');
  });

  it('has no goal for a session without a transcript, and for an id that names no file', async () => {
    const { tracker } = await open('');
    expect(await tracker.refresh()).toBe(false);
    expect(tracker.current()).toBeUndefined();
    expect(await new ClaudeGoalTracker('not-a-session', { CLAUDE_CONFIG_DIR: home }).refresh()).toBe(false);
  });
});

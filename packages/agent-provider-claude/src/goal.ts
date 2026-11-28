import { open, stat } from 'node:fs/promises';
import type { AgentSessionGoal } from '@orchardworks/agent-provider-sdk';
import { transcriptFile } from './prompt-edit.js';
import { record } from './projector.js';

/**
 * The goal of a Claude Code session (`/goal <condition>`), read from the `goal_status` attachment rows its transcript keeps.
 * The SDK's `active_goal` message reaches only a remote session, so the transcript is the one record that holds a goal live, after a
 * reopen and in history. A sentinel row sets or clears it; a row after the set is one check of the condition: not met (with the
 * evaluator's reason), met, or impossible.
 */
export const CLAUDE_GOAL_COMMAND = 'claude:goal';

const MAX_CONDITION = 4096;
const MAX_REASON = 1024;

interface GoalRow { timestamp?: unknown; attachment: { met: boolean; sentinel?: boolean; failed?: boolean; condition: string; reason?: unknown; iterations?: unknown; durationMs?: unknown; tokens?: unknown } }

const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** The goal row a transcript line holds, or undefined for any other line. */
export function goalRowOf(line: string): GoalRow | undefined {
  if (!line.includes('"goal_status"')) return undefined;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return undefined; }
  if (!record(value) || !record(value.attachment) || value.attachment.type !== 'goal_status'
    || typeof value.attachment.met !== 'boolean' || typeof value.attachment.condition !== 'string' || !value.attachment.condition) return undefined;
  return value as unknown as GoalRow;
}

/** The goal after one more row of the transcript, in the order they were written. */
export function foldGoalRow(goal: AgentSessionGoal | undefined, row: GoalRow): AgentSessionGoal | undefined {
  const { attachment } = row;
  const at = typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp)) ? Date.parse(row.timestamp) : undefined;
  const objective = attachment.condition.slice(0, MAX_CONDITION);
  const reason = typeof attachment.reason === 'string' && attachment.reason ? attachment.reason.slice(0, MAX_REASON) : undefined;
  if (attachment.sentinel) {
    // The set row opens the goal; the same row with the condition met closes it, as `/goal clear` and an error that ended it do.
    if (attachment.met) return undefined;
    return withActions({ objective, status: 'active', iterations: 0, ...(at !== undefined ? { startedAt: at, updatedAt: at } : {}) });
  }
  // A check of a goal this transcript never set (its start is outside the part read) still describes the goal that exists.
  const current: AgentSessionGoal = goal?.objective === objective ? goal : { objective, status: 'active', ...(at !== undefined ? { startedAt: at } : {}) };
  if (goal && goal.objective !== objective) return goal;
  const iterations = count(attachment.iterations);
  const seconds = typeof attachment.durationMs === 'number' && attachment.durationMs >= 0 ? Math.round(attachment.durationMs / 1000) : undefined;
  const tokens = count(attachment.tokens);
  const next: AgentSessionGoal = { ...current, status: attachment.met ? 'complete' : attachment.failed ? 'blocked' : 'active',
    iterations: iterations ?? (attachment.met || attachment.failed ? current.iterations : (current.iterations ?? 0) + 1),
    ...(tokens !== undefined ? { tokensUsed: tokens } : {}), ...(seconds !== undefined ? { timeUsedSeconds: seconds } : {}),
    ...(reason ? { lastReason: reason } : {}), ...(at !== undefined ? { updatedAt: at } : {}) };
  return withActions(next);
}

const withActions = (goal: AgentSessionGoal): AgentSessionGoal => {
  const { actions: _actions, ...rest } = goal;
  return goal.status === 'active' ? { ...rest, actions: [{ kind: 'clear', commandId: CLAUDE_GOAL_COMMAND, args: 'clear' }] } : rest;
};

export const claudeGoalOfRows = (rows: readonly GoalRow[]): AgentSessionGoal | undefined => rows.reduce<AgentSessionGoal | undefined>(foldGoalRow, undefined);

/** Follows one session's transcript and reads only the bytes appended since its last read. */
export class ClaudeGoalTracker {
  private goal: AgentSessionGoal | undefined;
  private file: string | undefined;
  private offset = 0;
  /** The bytes after the last newline read, a line still being written; kept as bytes so a character split between reads stays whole. */
  private partial = Buffer.alloc(0);

  constructor(private readonly sessionId: string, private readonly env: NodeJS.ProcessEnv) {}

  current(): AgentSessionGoal | undefined { return this.goal ? structuredClone(this.goal) : undefined; }

  /** Reads what the transcript gained; true when the goal changed. A transcript that cannot be read leaves the goal as it was. */
  async refresh(): Promise<boolean> {
    const before = JSON.stringify(this.goal);
    try {
      this.file ??= await transcriptFile(this.sessionId, this.env);
      if (!this.file) return false;
      const { size } = await stat(this.file);
      if (size < this.offset) { this.offset = 0; this.partial = Buffer.alloc(0); this.goal = undefined; }
      if (size === this.offset) return false;
      const handle = await open(this.file, 'r');
      try {
        const buffer = Buffer.alloc(size - this.offset);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
        this.offset += bytesRead;
        const bytes = Buffer.concat([this.partial, buffer.subarray(0, bytesRead)]);
        const end = bytes.lastIndexOf(10) + 1;
        this.partial = bytes.subarray(end);
        for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) { const row = goalRowOf(line); if (row) this.goal = foldGoalRow(this.goal, row); }
      } finally { await handle.close(); }
    } catch { return false; }
    return JSON.stringify(this.goal) !== before;
  }
}

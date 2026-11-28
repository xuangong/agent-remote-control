import type { AgentSessionGoal } from '@orchardworks/agent-provider-sdk';
import { isRecord, readString } from './native.js';

/**
 * The goal of a Codex thread (`/goal`, app-server `thread/goal/*`): what the native `ThreadGoal` becomes in the session's runtime
 * information, and what the person's `/goal` command asks of the thread.
 */
export const CODEX_GOAL_COMMAND = 'goal';
export const GOAL_INPUT_HINT = 'Objective, or pause, resume, clear';
const MAX_OBJECTIVE = 4096;

const STATUSES: Record<string, AgentSessionGoal['status']> = {
  active: 'active', paused: 'paused', blocked: 'blocked', usageLimited: 'usage_limited', budgetLimited: 'budget_limited', complete: 'complete',
};

const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const milliseconds = (seconds: unknown): number | undefined => { const value = count(seconds); return value === undefined ? undefined : value * 1000; };

/** What a person can do to a goal in this state; Codex keeps a limited or finished goal until it is cleared. */
function actionsFor(status: AgentSessionGoal['status']): NonNullable<AgentSessionGoal['actions']> {
  const clear = { kind: 'clear' as const, commandId: CODEX_GOAL_COMMAND, args: 'clear' };
  if (status === 'active') return [{ kind: 'pause', commandId: CODEX_GOAL_COMMAND, args: 'pause' }, clear];
  if (status === 'paused') return [{ kind: 'resume', commandId: CODEX_GOAL_COMMAND, args: 'resume' }, clear];
  return [clear];
}

/** The runtime's goal for a native `ThreadGoal`, or undefined for anything that is not one. */
export function codexGoalOf(value: unknown): AgentSessionGoal | undefined {
  if (!isRecord(value)) return undefined;
  const objective = readString(value.objective);
  const status = typeof value.status === 'string' ? STATUSES[value.status] : undefined;
  if (!objective || !status) return undefined;
  const tokensUsed = count(value.tokensUsed), tokenBudget = count(value.tokenBudget), timeUsedSeconds = count(value.timeUsedSeconds);
  const startedAt = milliseconds(value.createdAt), updatedAt = milliseconds(value.updatedAt);
  return { objective: objective.slice(0, MAX_OBJECTIVE), status,
    ...(tokensUsed !== undefined ? { tokensUsed } : {}), ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    ...(timeUsedSeconds !== undefined ? { timeUsedSeconds } : {}), ...(startedAt !== undefined ? { startedAt } : {}), ...(updatedAt !== undefined ? { updatedAt } : {}),
    actions: actionsFor(status) };
}

export type GoalRequest =
  | { kind: 'show' } | { kind: 'clear' } | { kind: 'pause' } | { kind: 'resume' }
  | { kind: 'set'; objective: string } | { kind: 'edit'; objective: string };

/** What the person typed after `/goal`: a word of the command, or the objective itself. Only a whole word is a subcommand. */
export function parseGoalRequest(args: string): GoalRequest | { error: string } {
  const text = args.trim();
  if (!text) return { kind: 'show' };
  if (text === 'clear' || text === 'pause' || text === 'resume') return { kind: text };
  const edit = /^edit(?:\s+([\s\S]*))?$/.exec(text);
  const objective = edit ? edit[1]?.trim() : text;
  if (edit && !objective) return { error: 'Say what the goal becomes: /goal edit <objective>.' };
  if (objective!.length > MAX_OBJECTIVE) return { error: `A goal objective is at most ${MAX_OBJECTIVE} characters.` };
  return edit ? { kind: 'edit', objective: objective! } : { kind: 'set', objective: objective! };
}

/** The line `/goal` without arguments answers with. */
export const describeGoal = (goal: AgentSessionGoal | undefined): string => goal
  ? `Goal (${goal.status.replace('_', ' ')}): ${goal.objective}` : 'No goal is set. Use /goal <objective>.';

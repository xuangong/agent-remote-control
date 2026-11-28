/**
 * The goal a session works toward, in the words a person reads (the pinned line of a conversation and the badge of a tile). The adapter
 * reports what its CLI keeps (`runtimeInfo.goal`); this only says it: the status, the figures the CLI gave and none it did not, and
 * the actions the adapter offered, labelled.
 */
import type { AgentSessionGoal } from '@orchardworks/agent-remote-protocol';
import { elapsedWords, type MessageKey, type Translate } from './messages.js';

export interface SessionGoalAction { readonly kind: 'clear' | 'pause' | 'resume'; readonly label: string; readonly commandId: string; readonly args: string }

export interface SessionGoalView {
  readonly objective: string;
  readonly status: AgentSessionGoal['status'];
  /** The status in words: "Working toward it", "Paused". */
  readonly statusWords: string;
  /** The tile's badge: "Goal", "Goal paused". */
  readonly badge: string;
  /** The figures that exist, short: "3 checks · 1.2k tokens · 4m 05s". Empty when the CLI keeps none. */
  readonly progress: string;
  /** Everything known, one fact per line, for a title and for a reader who wants the reason. */
  readonly detail: string;
  readonly actions: readonly SessionGoalAction[];
}

/** A count of tokens as a person reads it: 950, 1.2k, 12k, 3.4M. */
export function tokenCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return count < 10_000 ? `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

const ACTION_LABELS: Record<SessionGoalAction['kind'], MessageKey> = { clear: 'timeline.goal.clear', pause: 'timeline.goal.pause', resume: 'timeline.goal.resume' };

export function sessionGoalView(goal: AgentSessionGoal, t: Translate): SessionGoalView {
  const figures = [
    goal.iterations !== undefined && goal.iterations > 0 ? t('timeline.goal.checks', { count: goal.iterations }) : undefined,
    goal.tokensUsed !== undefined && (goal.tokensUsed > 0 || goal.tokenBudget !== undefined)
      ? goal.tokenBudget !== undefined ? t('timeline.goal.tokensOf', { tokens: tokenCount(goal.tokensUsed), budget: tokenCount(goal.tokenBudget) }) : t('timeline.goal.tokens', { tokens: tokenCount(goal.tokensUsed) })
      : undefined,
    goal.timeUsedSeconds !== undefined && goal.timeUsedSeconds > 0 ? elapsedWords(goal.timeUsedSeconds, t) : undefined,
  ].filter((figure): figure is string => figure !== undefined);
  const statusWords = t(`timeline.goal.status.${goal.status}`);
  return {
    objective: goal.objective, status: goal.status, statusWords, badge: t(`timeline.goal.badge.${goal.status}`), progress: figures.join(' · '),
    detail: [goal.objective, [statusWords, ...figures].join(' · '), goal.lastReason ? t('timeline.goal.lastReason', { reason: goal.lastReason }) : undefined].filter(Boolean).join('\n'),
    actions: (goal.actions ?? []).map(action => ({ ...action, label: t(ACTION_LABELS[action.kind]) })),
  };
}

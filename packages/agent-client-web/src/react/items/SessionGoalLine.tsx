import { useEffect, useState } from 'react';
import { sessionGoalView } from '@orchardworks/agent-client';
import type { AgentSessionGoal } from '@orchardworks/agent-remote-protocol';
import { useTranslate } from '../locale.js';

/**
 * The goal a session works toward, as one line pinned above its conversation: what it is, where it stands, and the actions its adapter
 * offers (Pause, Resume, Clear goal), each sent as the native command that does it. A change of the goal rewrites the line where it
 * stands and adds no entry; the line keeps its height in every state.
 */
export function SessionGoalLine({ goal, onAction }: {
  readonly goal: AgentSessionGoal;
  /** Runs the command of an action; absent while the person cannot change the session. */
  readonly onAction?: (commandId: string, args: string) => Promise<unknown>;
}) {
  const t = useTranslate();
  const view = sessionGoalView(goal, t);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  // What the CLI reports next replaces a failure the person already saw.
  useEffect(() => { setFailed(false); }, [goal]);
  async function run(commandId: string, args: string) {
    setPending(true); setFailed(false);
    try { await onAction!(commandId, args); } catch { setFailed(true); } finally { setPending(false); }
  }
  return <div className="agent-goal-line" data-goal-line="" data-goal-status={goal.status} role="group" aria-label={t('timeline.goal.label', { objective: goal.objective })} title={view.detail}>
    <span className="agent-goal-kicker">{t('timeline.goal.title')}</span>
    <strong className="agent-goal-objective">{goal.objective}</strong>
    <span className="agent-goal-status" role={failed ? 'alert' : undefined}>{failed ? t('timeline.goal.actionFailed') : [view.statusWords, view.progress].filter(Boolean).join(' · ')}</span>
    {onAction ? view.actions.map(action => <button key={action.kind} type="button" className="agent-task-open" data-goal-action={action.kind} disabled={pending}
      onClick={() => { void run(action.commandId, action.args); }}>{action.label}</button>) : null}
  </div>;
}

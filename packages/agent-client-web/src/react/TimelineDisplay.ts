import { createContext, useContext, useState } from 'react';
import type { AgentTimelineItem } from '@orchardworks/agent-remote-protocol';
export const TimelineSearchReveal = createContext(false);

/** How each step of an open work line shows: its one-line header (`summary`) or today's preview block (`preview`). */
export const TimelineStepLevel = createContext<'summary' | 'preview'>('preview');

export type TimelineDisplayMode = 'preview' | 'simple' | 'content';
export const TimelineDisplay = createContext<TimelineDisplayMode>('preview');
export const TimelineLettersVisible = createContext(true);

const planTools = new Set(['update_plan', 'TodoWrite', 'todo_write', 'EnterPlanMode', 'ExitPlanMode', 'enter_plan_mode', 'exit_plan_mode', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

/** Content includes requirements, plans, progress, and user decisions. */
export function isContentOnlyItem(item: AgentTimelineItem): boolean {
  if (item.type === 'agent_communication' || item.type === 'user_message' || item.type === 'assistant_message' || item.type === 'todo' || item.type === 'interaction' || item.type === 'error') return true;
  return item.type === 'tool_call' && planTools.has(item.name.split('.').at(-1) ?? item.name);
}

/** Explicit choices survive item updates and changes of the step level. */
export function useItemDisclosure() {
  const level = useContext(TimelineStepLevel);
  const revealed = useContext(TimelineSearchReveal);
  const [disclosure, setDisclosure] = useState<{ revealed: boolean; choice?: boolean }>({ revealed });
  // A newly selected search result opens once; readers can still collapse it.
  if (disclosure.revealed !== revealed) setDisclosure({ revealed, choice: revealed ? true : disclosure.choice });
  const choice = disclosure.revealed === revealed ? disclosure.choice : revealed ? true : disclosure.choice;
  return {
    expanded: choice ?? revealed,
    preview: !revealed && choice === undefined && level === 'preview',
    toggle: () => setDisclosure({ revealed, choice: !(choice ?? revealed) }),
  };
}

import { createContext, useContext, useState } from 'react';
import type { AgentTimelineItem } from '@orchardworks/agent-remote-protocol';

export type TimelineDisplayMode = 'preview' | 'simple' | 'content';
export const TimelineDisplay = createContext<TimelineDisplayMode>('preview');

const planTools = new Set(['update_plan', 'TodoWrite', 'todo_write', 'EnterPlanMode', 'ExitPlanMode', 'enter_plan_mode', 'exit_plan_mode', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

/** Content includes requirements, plans, progress, and user decisions. */
export function isContentOnlyItem(item: AgentTimelineItem): boolean {
  if (item.type === 'user_message' || item.type === 'assistant_message' || item.type === 'todo' || item.type === 'interaction') return true;
  return item.type === 'tool_call' && planTools.has(item.name.split('.').at(-1) ?? item.name);
}

/** Explicit choices survive item updates and changes to the default display mode. */
export function useItemDisclosure() {
  const mode = useContext(TimelineDisplay);
  const [choice, setChoice] = useState<boolean>();
  return {
    expanded: choice === true,
    preview: choice === undefined && mode !== 'simple',
    toggle: () => setChoice(current => current !== true),
  };
}

import { createContext, useContext } from 'react';
import type { BoardItem, TaskView } from '@orchardworks/agent-remote-protocol';

/**
 * What the page knows about tasks, for task cards: whether a task's worker session can be opened, and opening it. The page supplies it;
 * without it a card shows the task without the action.
 */
export interface TaskDirectory {
  canOpen(taskId: string): boolean;
  open(taskId: string): void;
  /** The tasks a session owns, newest first. */
  owned(owner: { providerId: string; nativeSessionId: string }): readonly TaskView[];
  /** A bot's standing staff: the bots it created and is chief of (bots design 10). */
  staff?(botId: string): readonly { botId: string; name: string }[];
  /** The items of a standing bot's board, newest first (bots design 6). */
  board?(bot: { providerId: string; nativeSessionId: string }): readonly BoardItem[];
  /** The person stops a running task, takes it as done, or keeps its bot as a standing bot (bots design 10). */
  act(taskId: string, action: 'cancel_task' | 'mark_task_done' | 'keep_task'): Promise<void>;
}
export const TaskDirectoryContext = createContext<TaskDirectory | undefined>(undefined);
export const useTaskDirectory = (): TaskDirectory | undefined => useContext(TaskDirectoryContext);

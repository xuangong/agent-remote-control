import { createContext, useContext } from 'react';
import type { TaskView } from '@orchardworks/agent-remote-protocol';

/**
 * What the page knows about tasks, for task cards: whether a task's worker session can be opened, and opening it. The page supplies it;
 * without it a card shows the task without the action.
 */
export interface TaskDirectory {
  canOpen(taskId: string): boolean;
  open(taskId: string): void;
  /** The tasks a session owns, newest first. */
  owned(owner: { providerId: string; nativeSessionId: string }): readonly TaskView[];
  /** The person stops a running task or takes it as done. */
  act(taskId: string, action: 'cancel_task' | 'mark_task_done'): Promise<void>;
}
export const TaskDirectoryContext = createContext<TaskDirectory | undefined>(undefined);
export const useTaskDirectory = (): TaskDirectory | undefined => useContext(TaskDirectoryContext);

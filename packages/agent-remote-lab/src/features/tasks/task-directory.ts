import { taskView, type Team } from '@orchardworks/agent-remote-protocol';
import type { TaskDirectory } from '@orchardworks/agent-client-web/react';

/** A worker session the page can open: a task's Leader once its session exists. */
export interface TaskWorker { hostId: string; providerId: string; nativeSessionId: string; title: string }

export function taskWorker(tasks: readonly Team[] | undefined, taskId: string): TaskWorker | undefined {
  const team = tasks?.find(item => item.id === taskId && !!item.task), worker = team?.members[0];
  if (!team || !worker || worker.creation !== 'ready' || !worker.nativeSessionId) return undefined;
  return { hostId: worker.hostId, providerId: worker.providerId, nativeSessionId: worker.nativeSessionId, title: team.task?.title ?? team.title };
}

/** Task cards open a task's worker session the way the page opens any session. */
export function taskDirectory(tasks: readonly Team[] | undefined, open: (worker: TaskWorker) => void): TaskDirectory {
  return {
    canOpen: taskId => !!taskWorker(tasks, taskId),
    open: taskId => { const worker = taskWorker(tasks, taskId); if (worker) open(worker); },
    owned: owner => (tasks ?? []).filter(team => team.task && team.members[1]?.providerId === owner.providerId && team.members[1].nativeSessionId === owner.nativeSessionId)
      .map(taskView).sort((a, b) => b.updatedAt - a.updatedAt),
  };
}

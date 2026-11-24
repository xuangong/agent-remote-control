import { taskView, type Team, type WindowGroup, type BoardItem } from '@orchardworks/agent-remote-protocol';
import type { TaskDirectory } from '@orchardworks/agent-client-web/react';

/** A worker session the page can open: a task's Leader once its session exists. */
export interface TaskWorker { hostId: string; providerId: string; nativeSessionId: string; title: string }

export function taskWorker(tasks: readonly Team[] | undefined, taskId: string): TaskWorker | undefined {
  const team = tasks?.find(item => item.id === taskId && !!item.task), worker = team?.members[0];
  if (!team || !worker || worker.creation !== 'ready' || !worker.nativeSessionId) return undefined;
  return { hostId: worker.hostId, providerId: worker.providerId, nativeSessionId: worker.nativeSessionId, title: team.task?.title ?? team.title };
}

/** The tasks and the bots' inboxes, as the Relay lists them. Task cards open a task's worker session the way the page opens any session. */
export function taskDirectory(tasks: readonly Team[] | undefined, open: (worker: TaskWorker) => void, act: TaskDirectory['act'] = async () => {}, groups: readonly WindowGroup[] = [], setChief?: TaskDirectory['setChief'], ask?: TaskDirectory['ask']): TaskDirectory {
  const standing = () => groups.flatMap(group => Object.values(group.bots?.members ?? {}).flatMap(item => item.botId ? [{ botId: item.botId, name: item.name ?? item.botId, ...(item.chief ? { chief: item.chief } : {}) }] : []));
  return {
    canOpen: taskId => !!taskWorker(tasks, taskId),
    open: taskId => { const worker = taskWorker(tasks, taskId); if (worker) open(worker); },
    act,
    owned: owner => (tasks ?? []).filter(team => team.task && team.members[1]?.providerId === owner.providerId && team.members[1].nativeSessionId === owner.nativeSessionId)
      .map(taskView).sort((a, b) => b.updatedAt - a.updatedAt),
    // A bot's standing bots are the ones whose record names it as their chief.
    staff: botId => groups.flatMap(group => Object.values(group.bots?.members ?? {}).flatMap(item => item.chief === botId && item.botId ? [{ botId: item.botId, name: item.name ?? item.botId }] : [])),
    // The chief a bot has now, and the other standing bots it may move to: not itself, and not one of its own staff, which would make a loop.
    chief: botId => {
      const bots = standing(), up = (id: string | undefined): boolean => !!id && (id === botId || up(bots.find(bot => bot.botId === id)?.chief));
      const chief = bots.find(bot => bot.botId === bots.find(item => item.botId === botId)?.chief);
      return { ...(chief ? { current: { botId: chief.botId, name: chief.name } } : {}), choices: bots.filter(bot => !up(bot.botId)).map(({ botId: id, name }) => ({ botId: id, name })) };
    },
    ...(setChief ? { setChief } : {}),
    bots: () => standing().map(({ botId, name }) => ({ botId, name })),
    ...(ask ? { ask } : {}),
    // What the person asked from a conversation, from the answer sessions that conversation has; oldest first.
    asks: from => (tasks ?? []).filter(team => team.ask && team.ask.from.providerId === from.providerId && team.ask.from.nativeSessionId === from.nativeSessionId)
      .flatMap(team => team.ask!.entries.map(entry => ({ id: entry.id, botId: team.ask!.botId, bot: standing().find(bot => bot.botId === team.ask!.botId)?.name ?? team.members[0]?.name ?? team.title,
        text: entry.text, at: entry.at, ...(entry.answer ? { answer: entry.answer } : {}) })))
      .sort((a, b) => a.at - b.at),
    // The sessions a bot has open to answer mentions now (an hour after the last question the Relay retires them).
    answering: botId => (tasks ?? []).filter(team => team.ask?.botId === botId && team.status === 'active')
      .map(team => ({ teamId: team.id, conversation: team.ask!.from.name, lastAt: team.ask!.lastAt, count: team.ask!.entries.length }))
      .sort((a, b) => b.lastAt - a.lastAt),
    // A standing bot's inbox is bound to its session; its board travels on it.
    board: bot => [...(tasks ?? []).find(team => team.inbox && team.members[0]?.providerId === bot.providerId && team.members[0].nativeSessionId === bot.nativeSessionId)?.inbox?.board?.items ?? []]
      .sort((a: BoardItem, b: BoardItem) => b.updatedAt - a.updatedAt),
  };
}

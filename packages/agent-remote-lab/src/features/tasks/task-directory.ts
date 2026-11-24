import { taskView, type Team, type WindowGroup, type BoardItem } from '@orchardworks/agent-remote-protocol';
import type { SideCard, TaskDirectory } from '@orchardworks/agent-client-web/react';
import type { Translate } from '@orchardworks/agent-client';

/** A worker session the page can open: a task's Leader once its session exists. */
export interface TaskWorker { hostId: string; providerId: string; nativeSessionId: string; title: string }

export function taskWorker(tasks: readonly Team[] | undefined, taskId: string): TaskWorker | undefined {
  const team = tasks?.find(item => item.id === taskId && !!item.task), worker = team?.members[0];
  if (!team || !worker || worker.creation !== 'ready' || !worker.nativeSessionId) return undefined;
  return { hostId: worker.hostId, providerId: worker.providerId, nativeSessionId: worker.nativeSessionId, title: team.task?.title ?? team.title };
}

/** What a side's answer says when the person brings it back into the conversation: their own words, quoting the answer. */
export const bringBackText = (card: SideCard, t: Translate): string => `${t('timeline.side.quote', { title: card.title })}\n\n${card.summary.split('\n').map(line => `> ${line}`).join('\n')}`;

/** The tasks and the bots' inboxes, as the Relay lists them. Task cards open a task's worker session the way the page opens any session. */
export function taskDirectory(tasks: readonly Team[] | undefined, open: (worker: TaskWorker) => void, act: TaskDirectory['act'] = async () => {}, groups: readonly WindowGroup[] = [], setChief?: TaskDirectory['setChief'], ask?: TaskDirectory['ask'], writeBoard?: TaskDirectory['writeBoard'], bringBack?: TaskDirectory['bringBack']): TaskDirectory {
  const standing = () => groups.flatMap(group => Object.values(group.bots?.members ?? {}).flatMap(item => item.botId ? [{ botId: item.botId, name: item.name ?? item.botId, ...(item.chief ? { chief: item.chief } : {}) }] : []));
  const inbox = (botId: string) => (tasks ?? []).find(team => team.inbox?.botId === botId);
  const temporary = (botId: string) => (tasks ?? []).find(team => team.task?.botId === botId);
  /** The session a bot works in that the page can open: a standing bot's main session, or a temporary bot's worker. */
  const sessionOf = (botId: string): TaskWorker | undefined => {
    const team = inbox(botId), seat = team?.members[0];
    if (team && seat?.nativeSessionId) return { hostId: seat.hostId, providerId: seat.providerId, nativeSessionId: seat.nativeSessionId, title: standing().find(bot => bot.botId === botId)?.name ?? seat.name };
    const task = temporary(botId);
    return task ? taskWorker(tasks, task.id) : undefined;
  };
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
    ...(bringBack ? { bringBack } : {}),
    // The sides asked from a conversation that have reported; their results never reach it as input.
    sides: from => (tasks ?? []).filter(team => team.task?.side && team.task.result && team.members[1]?.providerId === from.providerId && team.members[1].nativeSessionId === from.nativeSessionId)
      .map(team => ({ taskId: team.id, title: team.task!.title, status: team.task!.result!.status, summary: team.task!.result!.summary, at: team.task!.result!.reportedAt }))
      .sort((a, b) => a.at - b.at),
    // What the person asked from a conversation, from the answer sessions that conversation has; oldest first.
    asks: from => (tasks ?? []).filter(team => team.ask && team.ask.from.providerId === from.providerId && team.ask.from.nativeSessionId === from.nativeSessionId)
      .flatMap(team => team.ask!.entries.map(entry => ({ id: entry.id, botId: team.ask!.botId, bot: standing().find(bot => bot.botId === team.ask!.botId)?.name ?? team.members[0]?.name ?? team.title,
        text: entry.text, at: entry.at, ...(entry.answer ? { answer: entry.answer } : {}) })))
      .sort((a, b) => a.at - b.at),
    // The sessions a bot has open to answer mentions now (an hour after the last question the Relay retires them).
    answering: botId => (tasks ?? []).filter(team => team.ask?.botId === botId && team.status === 'active')
      .map(team => ({ teamId: team.id, conversation: team.ask!.from.name, lastAt: team.ask!.lastAt, count: team.ask!.entries.length }))
      .sort((a, b) => b.lastAt - a.lastAt),
    boardOf: botId => inbox(botId)?.inbox?.board,
    botName: botId => standing().find(bot => bot.botId === botId)?.name ?? temporary(botId)?.task?.title,
    // The bot's standing staff, and its temporary bots at work (the tasks its main session owns).
    assignees: botId => {
      const seat = inbox(botId)?.members[0];
      const working = (tasks ?? []).filter(team => team.task?.botId && team.task.state !== 'done' && team.task.state !== 'failed' && team.task.state !== 'cancelled' && !!seat
        && team.members[1]?.providerId === seat.providerId && team.members[1].nativeSessionId === seat.nativeSessionId).map(team => ({ botId: team.task!.botId!, name: team.task!.title }));
      return [...standing().filter(bot => bot.chief === botId).map(({ botId: id, name }) => ({ botId: id, name })), ...working];
    },
    canOpenBot: botId => !!sessionOf(botId),
    openBot: botId => { const worker = sessionOf(botId); if (worker) open(worker); },
    ...(writeBoard ? { writeBoard } : {}),
    // A standing bot's inbox is bound to its session; its board travels on it.
    board: bot => [...(tasks ?? []).find(team => team.inbox && team.members[0]?.providerId === bot.providerId && team.members[0].nativeSessionId === bot.nativeSessionId)?.inbox?.board?.items ?? []]
      .sort((a: BoardItem, b: BoardItem) => b.updatedAt - a.updatedAt),
  };
}

import { taskView, type Team, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { projectBotWorkbench, workbenchBotId, workbenchMainView, type WorkbenchLocator, type WorkbenchModel } from './bot-workbench.js';

/**
 * The bot workbench's model from the Teams the page holds: the sub-sessions (`task`), the answer sessions (`ask`) and the bot's
 * inbox, whose seat is the bot's current main session. `teams: undefined` is "not loaded". A Window that is not bound yields the
 * free workbench's tiles.
 */
export function botMainSession(teams: readonly Team[] | undefined, botId: string): WorkbenchLocator | undefined {
  const seat = teams?.find(team => team.inbox?.botId === botId)?.members[0];
  return seat?.nativeSessionId && seat.creation === 'ready' ? { hostId: seat.hostId, providerId: seat.providerId, nativeSessionId: seat.nativeSessionId } : undefined;
}

export interface WorkbenchState { readonly expanded: ReadonlySet<string>; readonly held: readonly string[]; readonly previous: readonly string[] }

export function workbenchFromTeams(window: WorkspaceWindow, teams: readonly Team[] | undefined, state: WorkbenchState): WorkbenchModel {
  const botId = workbenchBotId(window);
  const binding = workbenchMainView(window)?.binding;
  const mainSession = botId ? botMainSession(teams, botId) ?? (binding ? { hostId: binding.hostId, providerId: binding.providerId, nativeSessionId: binding.nativeSessionId } : undefined) : undefined;
  const answers = botId ? (teams ?? []).filter(team => team.ask?.botId === botId && team.status === 'active')
    .map(team => { const seat = team.members[0];
      return { teamId: team.id, conversation: team.ask!.from.name, lastAt: team.ask!.lastAt, count: team.ask!.entries.length,
        ...(seat?.nativeSessionId && seat.creation === 'ready' ? { locator: { hostId: seat.hostId, providerId: seat.providerId, nativeSessionId: seat.nativeSessionId } } : {}) }; }) : [];
  return projectBotWorkbench({ window, botId, mainSession, tasks: teams?.filter(team => !!team.task).map(taskView), answers, ...state });
}

/** Where an item's owner is in the workbench: a tile (a sub-session, derived or kept) or another bot, whose own workbench opens. */
export type OwnerTarget = { readonly kind: 'tile'; readonly id: string } | { readonly kind: 'bot'; readonly botId: string };
export function ownerTarget(teams: readonly Team[] | undefined, model: WorkbenchModel, ownerId: string): OwnerTarget | undefined {
  const team = teams?.find(item => item.task?.subSessionId === ownerId);
  if (!team) return teams?.some(item => item.inbox?.botId === ownerId) ? { kind: 'bot', botId: ownerId } : undefined;
  const kept = model.stored.find(tile => tile.taskId === team.id);
  return { kind: 'tile', id: kept?.id ?? `sub:${team.id}` };
}

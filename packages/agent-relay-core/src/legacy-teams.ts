/**
 * Ordinary Teams, a Leader and the members the person made from a panel, were folded into bots (bots design 9). A Relay that still
 * holds one migrates it when its state loads: the Leader becomes the chief of the members its group shows, those members become its
 * staff, and the Team, its inboxes and its messages are dropped. Members the group never showed stay plain sessions.
 */
import type { Team, WindowView } from '@orchardworks/agent-remote-protocol';
import { BOT_MISSION_LIMIT, hasBotAppearance } from '@orchardworks/agent-remote-protocol';
import { botIdsByView, mergeBots, migrationBotId, reconcileBots, type SavedBot } from './bot-store.js';
import type { SavedWorkspaceWindow } from './window-workspaces.js';

/** A Team of one person's own making: none of a task, a link, a bot's inbox or a room. */
export const isOrdinaryTeam = (team: unknown): boolean => {
  const value = team as Partial<Team> | null;
  return !!value && typeof value === 'object' && !value.task && !value.link && !value.inbox && !value.room;
};
/** The first rank-ordered slot for a group that gains a section: after every section the person ordered. */
const NEW_SECTION_RANK = 'z';
interface Broker { teams?: Team[] }
type Tenant = { subject: string; broker: Broker };

const teamOf = (view: WindowView) => view.feature?.kind === 'team' ? view.feature : undefined;

/** Whether some tenant still holds an ordinary Team. */
export const hasLegacyTeams = (tenants: readonly Tenant[]): boolean => tenants.some(tenant => tenant.broker?.teams?.some(isOrdinaryTeam));

interface Chiefship { subject: string; windowId: string; staffViewId: string; chiefWindowId: string; chiefViewId: string }
const viewKey = (windowId: string, viewId: string) => JSON.stringify([windowId, viewId]);

/**
 * Removes every ordinary Team from the tenants and makes bots of the views its groups show: their Team tags and managed binding are
 * dropped, each view gets bot details (its name and, for staff, its responsibility as the mission), and the bot records are made or
 * updated with `reconcileBots`, which this runs for the groups it changed only. The chief of each staff bot is recorded last.
 * Run after the bot records of earlier builds exist, so no view is made a bot twice.
 */
export function dropLegacyTeams(tenants: Tenant[], rows: SavedWorkspaceWindow[], bots: SavedBot[], now: number): void {
  for (const tenant of tenants) {
    const teams = tenant.broker?.teams?.filter(isOrdinaryTeam) ?? [];
    if (!teams.length) continue;
    const { subject } = tenant;
    tenant.broker.teams = tenant.broker.teams!.filter(team => !isOrdinaryTeam(team));
    const before = botIdsByView(subject, rows), changed = new Set<string>(), chiefs: Chiefship[] = [];
    for (const team of teams) {
      const mine = rows.filter(row => row.subject === subject && !row.deleted && row.window);
      const shown = mine.flatMap(row => row.window!.views.filter(view => teamOf(view)?.id === team.id).map(view => ({ row, view })));
      const leader = shown.find(({ view }) => teamOf(view)!.metadata?.role === 'leader');
      for (const { row, view } of shown) {
        const seat = team.members.find(member => member.id === teamOf(view)!.metadata?.memberId)
          ?? team.members.find(member => member.nativeSessionId === view.binding?.nativeSessionId && member.hostId === view.binding?.hostId);
        const isLeader = leader?.view === view;
        // The Window keeps showing the session; only the Team's hold on it goes.
        delete view.feature; if (view.bindingPolicy === 'managed') delete view.bindingPolicy;
        changed.add(row.id);
        if (!before.has(viewKey(row.id, view.id))) before.set(viewKey(row.id, view.id), migrationBotId(subject, row.id, view.id));
        if (!hasBotAppearance({ window: row.window!, ...(row.presentation ? { presentation: row.presentation } : {}) })) continue;
        // Details carry the identity the records hold, so reconciling the group changes no other bot.
        const section = row.bots = mergeBots(subject, { window: row.window!, bots: row.bots ?? { rank: NEW_SECTION_RANK, members: {} } }, bots).bots!;
        const details = section.members[view.id] ??= {};
        const name = (isLeader ? team.title : seat?.name)?.slice(0, 60);
        if (!details.name && name) details.name = name;
        if (!isLeader && !details.mission && seat?.responsibility) details.mission = seat.responsibility.slice(0, BOT_MISSION_LIMIT);
        if (!isLeader && leader) chiefs.push({ subject, windowId: row.id, staffViewId: view.id, chiefWindowId: leader.row.id, chiefViewId: leader.view.id });
      }
    }
    reconcileBots(subject, rows, bots, changed, before, now);
    applyChiefs(chiefs, rows, bots);
  }
}

/** Records each staff bot's chief once every bot has a record; a chief that did not become a bot leaves the staff to the person. */
function applyChiefs(chiefs: readonly Chiefship[], rows: readonly SavedWorkspaceWindow[], bots: SavedBot[]): void {
  const botIdOf = (subject: string, windowId: string, viewId: string) => rows.find(row => row.subject === subject && row.id === windowId && !row.deleted)?.bots?.members[viewId]?.botId;
  for (const { subject, windowId, staffViewId, chiefWindowId, chiefViewId } of chiefs) {
    const chiefId = botIdOf(subject, chiefWindowId, chiefViewId), staffId = botIdOf(subject, windowId, staffViewId);
    const staff = bots.find(bot => bot.subject === subject && bot.botId === staffId);
    if (chiefId && staff && chiefId !== staffId && bots.some(bot => bot.subject === subject && bot.botId === chiefId) && staff.chief.kind === 'person') staff.chief = { kind: 'bot', botId: chiefId };
  }
}

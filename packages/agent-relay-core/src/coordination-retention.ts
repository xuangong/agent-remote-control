/**
 * How long tasks, rooms and links stay in an account's Teams once they have nothing left to do. A finished task, an ended room
 * and a link between two assistants are kept, up to a number per kind, while their deliveries are settled; beyond that, and to
 * make room for a new Team at the account limit, the oldest are removed. Nothing with input still on its way is ever removed.
 */
import { ACCOUNT_TEAM_LIMIT, unresolvedTeamDelivery, type SavedTeam } from './team-delivery.js';
import { plain } from './drafts.js';

/** Finished tasks kept per account. */
export const TASK_FINISHED_KEEP = 200;
/** Ended rooms kept per account, so the person can read them. */
export const ROOM_ENDED_KEEP = 50;
/** Links kept per account: a removed link forgets which messages may be answered with reply_to. */
export const LINK_KEEP = 100;

type Kind = 'task' | 'room' | 'link';
const KEEP: Record<Kind, number> = { task: TASK_FINISHED_KEEP, room: ROOM_ENDED_KEEP, link: LINK_KEEP };

const kind = (team: SavedTeam): Kind | undefined => team.task ? 'task' : team.room ? 'room' : team.link ? 'link' : undefined;
/** Nothing more will happen to it: a finished task, an ended room, or any link (it opens again with the next message). */
const ended = (team: SavedTeam): boolean => {
  if (team.task) return team.task.state === 'done' || team.task.state === 'failed' || team.task.state === 'cancelled';
  if (team.room) return team.room.state !== 'open';
  return !!team.link;
};
const settled = (team: SavedTeam) => ![...team.messages, ...(team.deliveryReceipts ?? [])].some(message => message.status === 'queued' || unresolvedTeamDelivery(message));
const age = (team: SavedTeam) => team.task?.updatedAt ?? team.updatedAt;

/** Removes the oldest ended tasks, rooms and links with settled deliveries beyond the kept numbers, and makes room for `reserve` more Teams at the account limit. */
export function pruneCoordination(teams: SavedTeam[], reserve = 0): void {
  const view = plain(teams);
  const removable = view.filter(team => kind(team) && ended(team) && settled(team)).sort((a, b) => age(a) - age(b));
  const excess: Record<Kind, number> = { task: 0, room: 0, link: 0 };
  for (const key of Object.keys(KEEP) as Kind[]) excess[key] = Math.max(0, view.filter(team => kind(team) === key && ended(team)).length - KEEP[key]);
  let capacity = Math.max(0, view.length + reserve - ACCOUNT_TEAM_LIMIT);
  const removed = new Set<string>();
  // First what each kind keeps too many of, then the oldest of any kind until the new Teams fit.
  for (const team of removable) { const key = kind(team)!; if (excess[key] > 0) { excess[key]--; capacity--; removed.add(team.id); } }
  for (const team of removable) { if (capacity <= 0) break; if (!removed.has(team.id)) { capacity--; removed.add(team.id); } }
  for (const id of removed) teams.splice(plain(teams).findIndex(item => item.id === id), 1);
}

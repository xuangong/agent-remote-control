/**
 * Rooms: several assistants and the people of the account talking in one conversation. The Relay asks one member at a time to
 * speak and gives it only the messages it has not seen, as a framed input that waits for that member's main session to be idle
 * (like task updates and assistant messages). A member answers with room_say or room_pass; the person writes or ends the room
 * from the page. A room ends when a member says it is done, the person ends it, or its turns or time run out.
 */
import { createHash, randomUUID } from 'node:crypto';
import { nativeSessionRefKey, roomTurnText, ROOM_TRANSCRIPT_LIMIT, ROOM_TURN_LIMIT, type Team, type TeamHostCall, type TeamMember, type TeamRoom } from '@orchardworks/agent-remote-protocol';
import { ACCOUNT_TEAM_LIMIT, assertTeamQueueCapacity, type SavedTeam } from './team-delivery.js';
import { plain } from './drafts.js';
import type { TeamBrokerPorts } from './teams.js';
import { pruneCoordination } from './coordination-retention.js';
import { accountDirectory, assistantSeat, coordinatorCaller, namedAssistant, type AssistantBrokerPorts, type AssistantPorts } from './assistants.js';

type OpenCall = Extract<TeamHostCall, { action: 'open_room' }>;
type SayCall = Extract<TeamHostCall, { action: 'room_say' | 'room_pass' }>;
/** A member asked to speak this long ago without answering loses its turn at the next change. */
export const ROOM_TURN_TIMEOUT_MS = 15 * 60_000;
/** Who the transcript names for the people of the account. */
export const ROOM_PERSON = 'person';
const fail = (message: string): never => { throw new Error(message); };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const room = (team: Team): TeamRoom => team.room ?? fail('Team is not a room.');

function append(team: SavedTeam, item: TeamRoom, from: string, name: string, text: string, now: number) {
  item.transcript.push({ id: randomUUID(), from, name, text, at: now });
  if (item.transcript.length > ROOM_TRANSCRIPT_LIMIT) {
    const dropped = item.transcript.length - ROOM_TRANSCRIPT_LIMIT;
    item.transcript.splice(0, dropped);
    for (const key of Object.keys(item.seen)) item.seen[key] = Math.max(0, item.seen[key]! - dropped);
  }
  item.passed = [];
}
function touch(team: SavedTeam, now: number) { team.revision++; team.updatedAt = now; }

/**
 * Asks the next member to speak when nobody is asked: round the members after the last speaker, the first that has messages it has
 * not seen from someone else and has not passed since. A room whose time or turns ran out closes instead.
 */
export function scheduleRoom(team: SavedTeam, now: number): void {
  const item = room(team);
  if (item.state !== 'open') return;
  if (now >= item.deadline || item.turns >= ROOM_TURN_LIMIT) { item.state = 'closed'; delete item.speaker; delete item.askedAt; touch(team, now); return; }
  if (item.speaker && now - (item.askedAt ?? 0) < ROOM_TURN_TIMEOUT_MS) return;
  if (item.speaker) { item.passed.push(item.speaker); delete item.speaker; delete item.askedAt; }
  const last = [...item.transcript].reverse().find(entry => entry.from !== ROOM_PERSON)?.from;
  const start = Math.max(0, team.members.findIndex(member => member.id === last) + 1);
  const order = team.members.map((_, index) => team.members[(start + index) % team.members.length]!);
  const unseen = (member: TeamMember) => item.transcript.slice(item.seen[member.id] ?? 0).filter(entry => entry.from !== member.id);
  const next = order.find(member => member.creation === 'ready' && !item.passed.includes(member.id) && unseen(member).length);
  if (!next) return;
  const messages = unseen(next);
  const message = { id: digest(['room-turn', team.id, next.id, item.transcript.length, item.turns, now]), from: team.members.find(member => member.id !== next.id)!.id, to: next.id,
    text: roomTurnText({ roomId: team.id, name: item.name, messages: messages.map(entry => ({ name: entry.name, text: entry.text })), minutesLeft: (item.deadline - now) / 60_000 }),
    status: 'queued' as const, createdAt: now };
  assertTeamQueueCapacity(team, message);
  team.messages.push(message);
  item.seen[next.id] = item.transcript.length; item.speaker = next.id; item.askedAt = now;
  touch(team, now);
}

/** The person writes in a room, or ends it. */
export function roomAction(team: SavedTeam, input: { action: 'room_post'; operationId: string; text: string } | { action: 'close_room' }, now: number): void {
  const item = room(team);
  if (input.action === 'close_room') { if (item.state === 'open') { item.state = 'closed'; delete item.speaker; delete item.askedAt; touch(team, now); } return; }
  if (item.state !== 'open') fail('This room has ended.');
  if (item.transcript.some(entry => entry.id === input.operationId)) return;
  append(team, item, ROOM_PERSON, 'Person', input.text, now);
  item.transcript.at(-1)!.id = input.operationId;
  touch(team, now);
  scheduleRoom(team, now);
}

export class Rooms {
  constructor(private readonly broker: AssistantBrokerPorts, private readonly ports: AssistantPorts) {}
  /** An assistant opens a room with others; it speaks first after the topic. */
  async open(hostId: string, call: OpenCall): Promise<{ roomId: string; members: string[] }> {
    if (!this.ports.capable(hostId)) fail('Update the Controller to use rooms.');
    const directory = accountDirectory(this.ports.groups(), this.ports.coordinatorProvider), opener = coordinatorCaller(this.broker.ports.resolveSession, hostId, call.owner, directory);
    const others = call.members.map(name => namedAssistant(directory, name, opener));
    if (new Set(others.map(item => item.key)).size !== others.length) fail('Name each member once.');
    const created = await this.broker.change(teams => {
      const existing = teams.find(team => team.operationId === call.operationId && team.room);
      if (existing) return existing;
      pruneCoordination(teams, 1);
      if (plain(teams).length >= ACCOUNT_TEAM_LIMIT) fail('Team capacity reached.');
      const now = this.broker.ports.now(), members = [opener, ...others].map(item => assistantSeat(item, now));
      const team: SavedTeam = { id: randomUUID(), operationId: call.operationId, revision: 1, title: call.name, status: 'active', members, messages: [],
        source: { hostId: opener.hostId, providerId: opener.providerId, nativeSessionId: opener.nativeSessionId, title: opener.name },
        room: { name: call.name, topic: call.topic, state: 'open', deadline: now + call.minutes * 60_000, turns: 0, seen: {}, passed: [],
          transcript: [{ id: randomUUID(), from: members[0]!.id, name: opener.name, text: call.topic, at: now }] }, createdAt: now, updatedAt: now };
      // The opener said the topic; the others are asked in turn.
      team.room!.seen[members[0]!.id] = 1;
      teams.push(team);
      return team;
    });
    for (const member of created.members) await this.broker.provision(created.id, member.id).catch(() => undefined);
    await this.broker.change(teams => { const team = teams.find(item => item.id === created.id); if (team) scheduleRoom(team, this.broker.ports.now()); });
    return { roomId: created.id, members: created.members.map(member => member.name) };
  }
  /** The member asked to speak answers, or passes. */
  speak(hostId: string, call: SayCall): Promise<{ roomId: string; state: TeamRoom['state'] }> {
    if (!this.ports.capable(hostId)) fail('Update the Controller to use rooms.');
    const resolve = this.broker.ports.resolveSession;
    const key = (host: string, providerId: string, nativeSessionId: string) => { try { return nativeSessionRefKey(resolve(host, providerId, nativeSessionId)); } catch { return undefined; } };
    const caller = key(hostId, call.owner.providerId, call.owner.nativeSessionId);
    return this.broker.change(teams => {
      const team = teams.find(item => item.id === call.roomId && item.room) ?? fail('Room not found.'), item = room(team), now = this.broker.ports.now();
      // A member is the session the room bound, or the one that holds its role now; what its bot shows later does not matter.
      const member = team.members.find(candidate => candidate.hostId === hostId && !!caller && !!candidate.nativeSessionId && key(candidate.hostId, candidate.providerId, candidate.nativeSessionId) === caller)
        ?? fail('Room not found.');
      if (item.state !== 'open') fail('This room has ended.');
      if (item.speaker !== member.id) fail('It is not your turn in this room; wait to be asked.');
      delete item.speaker; delete item.askedAt;
      if (call.action === 'room_pass') item.passed.push(member.id);
      else {
        append(team, item, member.id, member.name, call.text, now); item.turns++;
        if (call.done) { item.state = 'done'; item.result = { from: member.id, text: call.text }; }
      }
      touch(team, now);
      scheduleRoom(team, now);
      return { roomId: team.id, state: item.state };
    });
  }
}

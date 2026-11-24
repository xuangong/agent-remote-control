/**
 * Bots' inboxes on the Team path (bots design 3): one Team per bot, whose only seat is the bot's main session, bound where it is.
 * Whatever reaches the bot arrives there as a message the Relay framed and is delivered between its turns, at most once. The first
 * thing sent is the bot's standing instructions, again whenever they change: a resumed Claude Code session ignores instructions
 * appended when it opens (design 5.1).
 */
import { createHash, randomUUID } from 'node:crypto';
import { botInstructions, type BotFact, nativeSessionRefKey, standingInstructionsText, type TeamMember } from '@orchardworks/agent-remote-protocol';
import { ACCOUNT_TEAM_LIMIT, assertTeamQueueCapacity, type SavedTeam } from './team-delivery.js';
import { plain } from './drafts.js';
import { assistantSeat, type Assistant, type AssistantBrokerPorts, type AssistantPorts } from './assistants.js';
import { pruneCoordination } from './coordination-retention.js';
import { pushBackTimers } from './bot-work.js';

const digest = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
/** Which standing instructions a bot was sent: the hash of their text. */
export const instructionsHash = (mission: string | undefined, memory?: readonly BotFact[]) => digest(botInstructions(mission, memory));

export class BotInboxes {
  constructor(private readonly broker: AssistantBrokerPorts, private readonly ports?: Pick<AssistantPorts, 'placeBot'>) {}
  private sessionKey(hostId: string, providerId: string, nativeSessionId: string): string | undefined {
    try { return nativeSessionRefKey(this.broker.ports.resolveSession(hostId, providerId, nativeSessionId)); } catch { return undefined; }
  }
  /** The bot's active inbox whose seat is the session the bot shows now. */
  current(teams: readonly SavedTeam[], bot: Assistant): SavedTeam | undefined {
    const key = this.sessionKey(bot.hostId, bot.providerId, bot.nativeSessionId);
    return teams.find(team => team.inbox?.botId === bot.key && team.status === 'active'
      && this.sessionKey(team.members[0]!.hostId, team.members[0]!.providerId, team.members[0]!.nativeSessionId!) === key);
  }
  /**
   * In a change: the bot's inbox bound to its current main session, created when it has none (an inbox left on a session the bot no
   * longer shows is archived), with its standing instructions queued when it was not sent this text yet. Undefined at capacity.
   */
  prepare(teams: SavedTeam[], bot: Assistant, now: number): SavedTeam | undefined {
    let inbox = this.current(teams, bot);
    if (!inbox) {
      for (const stale of teams) if (stale.inbox?.botId === bot.key && stale.status === 'active') { stale.status = 'archiving'; stale.revision++; stale.updatedAt = now; }
      pruneCoordination(teams, 1);
      if (plain(teams).length >= ACCOUNT_TEAM_LIMIT) return undefined;
      inbox = { id: randomUUID(), operationId: digest(['inbox', bot.key, now]), revision: 1, title: `${bot.name}'s inbox`, status: 'active',
        source: { hostId: bot.hostId, providerId: bot.providerId, nativeSessionId: bot.nativeSessionId, title: bot.name },
        members: [assistantSeat(bot, now)], messages: [], inbox: { botId: bot.key }, createdAt: now, updatedAt: now };
      teams.push(inbox);
    }
    const hash = instructionsHash(bot.mission, bot.memory);
    if (inbox.inbox!.instructions !== hash) {
      const seat = inbox.members[0]!;
      const message = { id: digest(['standing', inbox.id, hash]), from: seat.id, to: seat.id, text: standingInstructionsText(bot.mission, bot.memory), status: 'queued' as const, createdAt: now };
      if (!inbox.messages.some(item => item.id === message.id)) { assertTeamQueueCapacity(inbox, message); inbox.messages.push(message); pushBackTimers(inbox, now); }
      inbox.inbox!.instructions = hash;
      inbox.revision++; inbox.updatedAt = now;
    }
    return inbox;
  }
  /**
   * Places the standing bots other bots created whose sessions on this Host are ready: their view and details go into the chief's
   * group, and the inbox becomes an ordinary one. The session was created with its standing instructions, so they count as sent. A
   * placement that fails is tried again at the Host's next poll.
   */
  async place(hostId: string): Promise<void> {
    if (!this.ports?.placeBot) return;
    const ready = this.broker.ports.read().filter(team => team.inbox?.pending && team.status === 'active' && team.members[0]!.creation === 'ready' && team.members[0]!.hostId === hostId);
    for (const team of ready) {
      const seat = team.members[0]!, pending = team.inbox!.pending!;
      try {
        await this.ports.placeBot(pending.groupId, { id: `bot-${team.inbox!.botId.slice(2, 14)}`, binding: { hostId: seat.hostId, providerId: seat.providerId, nativeSessionId: seat.nativeSessionId!, title: pending.name } },
          { botId: team.inbox!.botId, name: pending.name, mission: pending.mission, chief: pending.chief });
      } catch { continue; }
      await this.broker.change(teams => {
        const current = teams.find(item => item.id === team.id);
        if (!current?.inbox?.pending) return;
        current.inbox = { botId: current.inbox.botId, instructions: instructionsHash(pending.mission), ...(current.inbox.recent ? { recent: current.inbox.recent } : {}) };
        current.revision++; current.updatedAt = this.broker.ports.now();
      });
    }
  }
  /** The bot wrote this mission and memory itself, so it has these standing instructions already: they count as sent. */
  async known(bot: Assistant, written: { mission?: string; memory?: readonly BotFact[] }): Promise<void> {
    await this.broker.change(teams => {
      const inbox = this.current(teams, bot);
      if (inbox?.inbox) { inbox.inbox.instructions = instructionsHash(written.mission ?? bot.mission, written.memory ?? bot.memory); inbox.revision++; inbox.updatedAt = this.broker.ports.now(); }
    });
  }
  /** The bot answered these messages of its inbox, from the senders named: a reply from its final text then has nothing left to answer. */
  async answered(bot: Assistant, ids: readonly string[], sender: string): Promise<void> {
    const inbox = this.current(this.broker.ports.read(), bot);
    if (!inbox?.inbox?.recent?.some(entry => ids.includes(entry.id) && entry.from === sender && !entry.answered)) return;
    await this.broker.change(teams => {
      const current = this.current(teams, bot);
      for (const entry of current?.inbox?.recent ?? []) if (ids.includes(entry.id) && entry.from === sender) entry.answered = true;
      if (current) { current.revision++; current.updatedAt = this.broker.ports.now(); }
    });
  }
  /** Binds the bot's inbox seat when it is not bound yet; the seat as it stands after. */
  async bind(bot: Assistant): Promise<TeamMember | undefined> {
    const inbox = this.current(this.broker.ports.read(), bot);
    if (!inbox) return undefined;
    if (inbox.members[0]!.creation === 'ready') return inbox.members[0];
    return (await this.broker.provision(inbox.id, inbox.members[0]!.id).catch(() => undefined))?.members[0];
  }
  /**
   * Sends a bot with a mission its standing instructions when it was not sent that text yet. A bot without one is left quiet: it
   * gets them with the first message another bot sends it (`prepare`), so a deployment wakes no bot by itself.
   */
  async ensure(bots: readonly Assistant[]): Promise<void> {
    const pending = (teams: readonly SavedTeam[]) => bots.filter(bot => {
      const sent = this.current(teams, bot)?.inbox?.instructions;
      return sent ? sent !== instructionsHash(bot.mission, bot.memory) : !!bot.mission || !!bot.memory?.length;
    });
    if (pending(this.broker.ports.read()).length) await this.broker.change(teams => { const now = this.broker.ports.now(); for (const bot of pending(plain(teams))) this.prepare(teams, bot, now); });
    // Binding a main session where it is never creates anything, so a Host that was offline is asked again at its next poll.
    for (const bot of bots) await this.bind(bot);
  }
}

/**
 * Answer sessions (bots plan 8b). The person mentions a bot from one of their conversations (`@Name text`): the bot answers in a
 * session of its own for that conversation, never in the conversation's session and never in its own main session. One answer
 * session exists per (bot, conversation): it takes the follow-ups of that conversation and is retired after an hour without one.
 * Its final text is the answer, recorded on the Team for the page to show in the asking conversation's timeline.
 */
import { createHash, randomUUID } from 'node:crypto';
import { askText, ASK_ENTRY_LIMIT, ASK_IDLE_MS, nativeSessionRefKey, type BotFact, type TeamAsk, type TeamAskRequest, type TeamHostCall, type TeamMember } from '@orchardworks/agent-remote-protocol';
import { accountDirectory, type Assistant, type AssistantBrokerPorts, type AssistantPorts } from './assistants.js';
import { ACCOUNT_TEAM_LIMIT, assertTeamQueueCapacity, type SavedTeam } from './team-delivery.js';
import { plain } from './drafts.js';
import { pruneCoordination } from './coordination-retention.js';
import { chainScope } from './chain-scope.js';
import { personChainId, type BotChains } from './chains.js';
import { cutReply } from './reply-text.js';
import type { BotInboxes } from './inboxes.js';

const fail = (message: string): never => { throw new Error(message); };
const fold = (text: string) => text.trim().toLocaleLowerCase('en');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const NOT_FOUND = 'No bot of this account answers to that name.';

export class BotAsks {
  private timer: unknown;
  constructor(private readonly broker: AssistantBrokerPorts, private readonly ports: AssistantPorts, private readonly chains: BotChains, private readonly inboxes: BotInboxes) {}
  private key(hostId: string, providerId: string, nativeSessionId: string): string | undefined {
    try { return nativeSessionRefKey(this.broker.ports.resolveSession(hostId, providerId, nativeSessionId)); } catch { return undefined; }
  }
  private fromKey(from: TeamAsk['from']): string | undefined { return this.key(from.hostId, from.providerId, from.nativeSessionId); }
  /** The answer session whose seat is this session. */
  forSession(hostId: string, owner: { providerId: string; nativeSessionId: string }): SavedTeam | undefined {
    const own = this.key(hostId, owner.providerId, owner.nativeSessionId);
    if (!own) return undefined;
    return this.broker.ports.read().find(team => team.ask && team.status === 'active' && team.members[0]!.hostId === hostId && !!team.members[0]!.nativeSessionId
      && this.key(hostId, team.members[0]!.providerId, team.members[0]!.nativeSessionId) === own);
  }
  /** The answer sessions open now, for the bot. */
  open(botId: string): SavedTeam[] { return this.broker.ports.read().filter(team => team.ask?.botId === botId && team.status === 'active'); }
  /** What a new answer session starts with: the bot's mission and memory as they stand now. */
  seat(team: SavedTeam): { botId: string; mission?: string; memory?: BotFact[] } {
    const bot = accountDirectory(this.ports.groups()).find(item => item.key === team.ask!.botId);
    return { botId: team.ask!.botId, ...(bot?.mission ? { mission: bot.mission } : {}), ...(bot?.memory?.length ? { memory: bot.memory } : {}) };
  }
  private bot(name: string): Assistant {
    const matches = accountDirectory(this.ports.groups()).filter(item => item.key.startsWith('b_') && !item.hidden && (item.key === name || fold(item.name) === fold(name)));
    return matches.length === 1 ? matches[0]! : fail(NOT_FOUND);
  }
  /**
   * The person asks a bot from a conversation: the question reaches the answer session for (bot, conversation), created when none is
   * open. Nothing is sent to the conversation's own session. The mention is a chain of the person's.
   */
  async ask(request: TeamAskRequest): Promise<SavedTeam> {
    const bot = this.bot(request.bot), from = request.source;
    if (!this.ports.capable(bot.hostId)) fail('Update the Controller of that bot\'s computer to ask it.');
    this.broker.ports.assertHost(bot.hostId, bot.providerId);
    const fromKey = this.key(from.hostId, from.providerId, from.nativeSessionId) ?? fail('The conversation you ask from is not known to this account.');
    const messageId = digest(['ask', request.operationId]), chain = personChainId(from, request.operationId);
    const team = await this.broker.change(teams => {
      const now = this.broker.ports.now();
      const repeated = teams.find(item => item.ask && item.messages.some(message => message.id === messageId));
      if (repeated) return repeated;
      // A session whose hour passed before its timer ran is retired now, so a follow-up never finds it.
      for (const item of teams) if (item.ask && item.status === 'active' && now - item.ask.lastAt >= ASK_IDLE_MS) { item.status = 'archived'; item.revision++; item.updatedAt = now; }
      let session = teams.find(item => item.ask?.botId === bot.key && item.status === 'active' && this.fromKey(item.ask.from) === fromKey);
      if (!session) {
        pruneCoordination(teams, 1);
        if (plain(teams).length >= ACCOUNT_TEAM_LIMIT) fail('Team capacity reached.');
        const seat: TeamMember = { id: randomUUID(), role: 'leader', hostId: bot.hostId, providerId: bot.providerId, name: bot.name, responsibility: `Answers the person's questions from ${from.title}.`,
          creation: 'reserved', activity: 'unknown', summary: '', updatedAt: now, access: 'read_only' };
        session = { id: randomUUID(), operationId: digest(['ask-session', bot.key, fromKey, now]), revision: 1, title: `${bot.name} answers ${from.title}`, status: 'active',
          source: { hostId: bot.hostId, providerId: bot.providerId, nativeSessionId: bot.nativeSessionId, title: bot.name }, members: [seat], messages: [],
          ask: { botId: bot.key, from: { hostId: from.hostId, providerId: from.providerId, nativeSessionId: from.nativeSessionId, name: from.title }, lastAt: now, entries: [] }, createdAt: now, updatedAt: now };
        teams.push(session);
        session = teams[teams.length - 1]!;
      }
      const seat = session.members[0]!;
      // The conversation may have been renamed since the last mention.
      session.ask!.from.name = from.title;
      const message = { id: messageId, from: seat.id, to: seat.id, text: askText({ from: from.title, text: request.text }), status: 'queued' as const, createdAt: now, chain };
      assertTeamQueueCapacity(session, message);
      session.messages.push(message);
      session.ask!.entries.push({ id: messageId, text: request.text, at: now });
      if (session.ask!.entries.length > ASK_ENTRY_LIMIT) session.ask!.entries.splice(0, session.ask!.entries.length - ASK_ENTRY_LIMIT);
      session.ask!.lastAt = now; session.revision++; session.updatedAt = now;
      return session;
    });
    const scope = chainScope(chain); scope.messages = 1; scope.bots.add(bot.key);
    await this.chains.record(scope, { cause: 'person', bot: bot.key }).catch(() => undefined);
    this.arm();
    if (team.members[0]!.creation !== 'ready') await this.broker.provision(team.id, team.members[0]!.id).catch(() => undefined);
    return this.broker.ports.read().find(item => item.id === team.id) ?? team;
  }
  /** An answer session's turn ended with this final text: it answers what is asked and not answered yet, cut where a bot's message is cut. */
  async answer(hostId: string, call: Extract<TeamHostCall, { action: 'bot_answer' }>): Promise<{ outcome: 'delivered' | 'duplicate' | 'forbidden'; reason?: string }> {
    const team = this.forSession(hostId, call.owner);
    if (!team) return { outcome: 'forbidden', reason: 'This session is not answering anyone.' };
    const bot = accountDirectory(this.ports.groups()).find(item => item.key === team.ask!.botId);
    if (!team.ask!.entries.some(entry => !entry.answer)) return { outcome: 'duplicate' };
    const text = cutReply(call.text, bot?.name ?? 'the bot');
    await this.broker.change(teams => {
      const current = teams.find(item => item.id === team.id), now = this.broker.ports.now();
      for (const entry of current?.ask?.entries ?? []) if (!entry.answer) {
        entry.answer = { text, at: now };
        // What the person asked and the bot answered elsewhere goes in the bot's work log, which its main session is told of with its next input.
        if (bot) this.inboxes.appendLog(teams, bot, now, { where: current!.ask!.from.name, question: entry.text, answer: text });
      }
      if (current) { current.revision++; current.updatedAt = now; }
    });
    return { outcome: 'delivered' };
  }
  /** Sets the one timer for the next answer session to retire. */
  arm(): void {
    const scheduler = this.broker.ports.scheduler;
    if (!scheduler) return;
    scheduler.clearTimeout(this.timer); this.timer = undefined;
    const due = this.broker.ports.read().flatMap(team => team.ask && team.status === 'active' ? [team.ask.lastAt + ASK_IDLE_MS] : []);
    if (!due.length) return;
    const wait = Math.min(Math.max(0, Math.min(...due) - this.broker.ports.now()), 24 * 60 * 60_000);
    this.timer = scheduler.setTimeout(() => { this.timer = undefined; void this.retire().catch(() => undefined).finally(() => this.arm()); }, wait);
  }
  /** Retires the answer sessions that had no follow-up for an hour. Its Host lets the session go; the Team stays as the page's record of the answers. */
  async retire(): Promise<void> {
    const idle = (team: SavedTeam, now: number) => !!team.ask && team.status === 'active' && now - team.ask.lastAt >= ASK_IDLE_MS;
    if (!this.broker.ports.read().some(team => idle(team, this.broker.ports.now()))) return;
    await this.broker.change(teams => {
      const now = this.broker.ports.now();
      plain(teams).forEach((team, index) => { if (idle(team, now)) { teams[index]!.status = 'archived'; teams[index]!.revision++; teams[index]!.updatedAt = now; } });
    });
  }
}

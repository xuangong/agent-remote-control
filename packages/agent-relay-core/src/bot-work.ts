/**
 * A standing bot's fallback timers (bots design 6.2), kept on its inbox. A timer is due only after a quiet interval: every message
 * queued for the bot pushes it back, so it never fires while work flows. A bot with open board items has one by default, every five
 * minutes, or thirty while all of them wait. When one is due the Relay queues `[Timer … · due]` with the bot's open items, unless
 * something is already on its way to the bot.
 */
import { createHash } from 'node:crypto';
import { boardItemOpen, timerText, type BotTimer, type TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { assertTeamQueueCapacity, pendingTeamMessage, type SavedTeam } from './team-delivery.js';
import { plain } from './drafts.js';
import type { Assistant, AssistantBrokerPorts } from './assistants.js';
import type { BotInboxes } from './inboxes.js';
import { timerChainId, type BotChains } from './chains.js';
import { chainScope } from './chain-scope.js';
import { ownerTasks } from './tasks.js';

type Call<A extends TeamHostCall['action']> = Extract<TeamHostCall, { action: A }>;
const fail = (message: string): never => { throw new Error(message); };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const WORK_TIMER_MS = 5 * 60_000;
export const WAITING_TIMER_MS = 30 * 60_000;

/** Every message queued for the bot pushes its timers back to a full interval from now. */
export function pushBackTimers(inbox: SavedTeam, now: number): void {
  for (const timer of inbox.inbox?.timers ?? []) timer.dueAt = now + timer.intervalMs;
}
/** The timer a bot keeps while it has open board items: five minutes, thirty while all of them wait; none once all are finished. */
function syncWorkTimer(inbox: SavedTeam, now: number): void {
  const box = inbox.inbox!, open = (box.board?.items ?? []).filter(item => boardItemOpen(item.status));
  const others = (box.timers ?? []).filter(timer => !timer.work);
  if (!open.length) { if (box.timers) box.timers = others; return; }
  const intervalMs = open.every(item => item.status === 'waiting') ? WAITING_TIMER_MS : WORK_TIMER_MS;
  const current = box.timers?.find(timer => timer.work);
  box.timers = [...others, current && current.intervalMs === intervalMs ? current : { name: 'work', intervalMs, dueAt: now + intervalMs, work: true }];
}
const settled = (inbox: SavedTeam) => !inbox.messages.some(pendingTeamMessage);

export class BotWork {
  private timer: unknown;
  constructor(private readonly broker: AssistantBrokerPorts, private readonly inboxes: BotInboxes, private readonly chains?: BotChains) {}
  private async change<T>(bot: Assistant, update: (inbox: SavedTeam, now: number) => T): Promise<T> {
    const value = await this.broker.change(teams => {
      const now = this.broker.ports.now(), inbox = this.inboxes.prepare(teams, bot, now) ?? fail('Team capacity reached.');
      const result = update(inbox, now);
      inbox.revision++; inbox.updatedAt = now;
      return result;
    });
    this.arm();
    return value;
  }
  /** Brings the bot's work timer in line with its open board items; inside a change. */
  syncTimer(inbox: SavedTeam, now: number): void { syncWorkTimer(inbox, now); }
  setTimer(bot: Assistant, call: Call<'set_timer'>): Promise<{ timers: BotTimer[] }> {
    return this.change(bot, (inbox, now) => {
      // The work timer follows the open board items; a bot names its own timers otherwise.
      if (call.name === 'work') fail('The work timer follows your open board items; name your timer otherwise.');
      const box = inbox.inbox!, timers = (box.timers ?? []).filter(timer => timer.name !== call.name);
      if (call.minutes > 0) {
        timers.push({ name: call.name, intervalMs: call.minutes * 60_000, dueAt: now + call.minutes * 60_000 });
        if (timers.length > 8) fail('A bot keeps at most 8 timers.');
      }
      box.timers = timers;
      return { timers };
    });
  }
  /** Sets the one timer for the next bot timer due, as rooms do theirs. */
  arm(): void {
    const scheduler = this.broker.ports.scheduler;
    if (!scheduler) return;
    scheduler.clearTimeout(this.timer); this.timer = undefined;
    const due = this.broker.ports.read().flatMap(team => team.inbox && team.status === 'active' ? (team.inbox.timers ?? []).map(timer => timer.dueAt) : []);
    if (!due.length) return;
    const wait = Math.min(Math.max(0, Math.min(...due) - this.broker.ports.now()), 24 * 60 * 60_000);
    this.timer = scheduler.setTimeout(() => { this.timer = undefined; void this.due().catch(() => undefined).finally(() => this.arm()); }, wait);
  }
  /** The live sub-sessions the bot's session owns, as its timer's frame lists them; a person's own side is not the bot's. */
  private roster(teams: readonly SavedTeam[], seat: { hostId: string; providerId: string; nativeSessionId?: string }, now: number) {
    return ownerTasks([...teams], this.broker.ports.resolveSession, seat.hostId, { providerId: seat.providerId, nativeSessionId: seat.nativeSessionId ?? '' })
      .filter(team => team.task!.state !== 'ended' && team.task!.startedBy !== 'person').sort((a, b) => a.createdAt - b.createdAt).map(team => {
        const item = team.task!, idle = item.state === 'idle' ? Math.max(1, Math.round((now - item.updatedAt) / 60_000)) : undefined;
        return { name: item.title, ...(idle !== undefined ? { idle: idle < 60 ? `${idle} min` : idle < 1440 ? `${Math.round(idle / 60)} h` : `${Math.round(idle / 1440)} d` } : {}),
          ...(item.lastWork ? { lastWork: item.lastWork.title } : {}), ...(item.currentStep ? { step: item.currentStep } : {}) };
      });
  }
  private async due(): Promise<void> {
    // Each reminder starts a chain of its own (bots design 7).
    const started = await this.broker.change(teams => {
      const now = this.broker.ports.now(), chains: Array<{ id: string; bot: string }> = [];
      plain(teams).forEach((team, index) => {
        if (!team.inbox || team.status !== 'active' || !team.inbox.timers?.some(timer => timer.dueAt <= now)) return;
        const inbox = teams[index]!, seat = inbox.members[0]!;
        for (const timer of inbox.inbox!.timers!.filter(item => item.dueAt <= now)) {
          // Something already on its way wakes the bot anyway; the timer only waits again.
          if (settled(inbox)) {
            const open = (inbox.inbox!.board?.items ?? []).filter(item => boardItemOpen(item.status)).map(item => ({ title: item.title, status: item.status, ...(item.report ? { report: item.report } : {}) }));
            const chain = timerChainId(inbox.id, timer.name, now);
            const message = { id: digest(['timer', inbox.id, timer.name, now]), from: seat.id, to: seat.id, text: timerText({ name: timer.name, items: open, subSessions: this.roster(teams, seat, now) }), status: 'queued' as const, createdAt: now, chain };
            assertTeamQueueCapacity(inbox, message); inbox.messages.push(message); chains.push({ id: chain, bot: inbox.inbox!.botId });
          }
          timer.dueAt = now + timer.intervalMs;
        }
        inbox.revision++; inbox.updatedAt = now;
      });
      return chains;
    });
    for (const chain of started) {
      const scope = chainScope(chain.id); scope.messages = 1; scope.bots.add(chain.bot);
      await this.chains?.record(scope, { cause: 'timer', bot: chain.bot }).catch(() => undefined);
    }
  }
}

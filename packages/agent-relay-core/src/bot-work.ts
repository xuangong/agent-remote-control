/**
 * A standing bot's work items and fallback timers (bots design 6), kept on its inbox. A timer is due only after a quiet interval:
 * every message queued for the bot pushes it back, so it never fires while work flows. A bot with open work has one by default,
 * every five minutes, or thirty while it waits for the person. When one is due the Relay queues `[Timer … · due]` with the bot's open
 * work, unless something is already on its way to the bot.
 */
import { createHash } from 'node:crypto';
import { timerText, WORK_ITEM_LIMIT, type BotTimer, type TeamHostCall, type WorkItem } from '@orchardworks/agent-remote-protocol';
import { assertTeamQueueCapacity, pendingTeamMessage, type SavedTeam } from './team-delivery.js';
import { plain } from './drafts.js';
import type { Assistant, AssistantBrokerPorts } from './assistants.js';
import type { BotInboxes } from './inboxes.js';

type Call<A extends TeamHostCall['action']> = Extract<TeamHostCall, { action: A }>;
const fail = (message: string): never => { throw new Error(message); };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const WORK_TIMER_MS = 5 * 60_000;
export const WAITING_TIMER_MS = 30 * 60_000;

/** Every message queued for the bot pushes its timers back to a full interval from now. */
export function pushBackTimers(inbox: SavedTeam, now: number): void {
  for (const timer of inbox.inbox?.timers ?? []) timer.dueAt = now + timer.intervalMs;
}
/** The timer a bot keeps while it has open work: five minutes, thirty while it waits for the person; none once all work is done. */
function syncWorkTimer(inbox: SavedTeam, now: number): void {
  const box = inbox.inbox!, open = (box.work ?? []).filter(item => item.phase !== 'done');
  const others = (box.timers ?? []).filter(timer => !timer.work);
  if (!open.length) { if (box.timers) box.timers = others; return; }
  const intervalMs = open.every(item => item.phase === 'waiting') ? WAITING_TIMER_MS : WORK_TIMER_MS;
  const current = box.timers?.find(timer => timer.work);
  box.timers = [...others, current && current.intervalMs === intervalMs ? current : { name: 'work', intervalMs, dueAt: now + intervalMs, work: true }];
}
const settled = (inbox: SavedTeam) => !inbox.messages.some(pendingTeamMessage);

export class BotWork {
  private timer: unknown;
  constructor(private readonly broker: AssistantBrokerPorts, private readonly inboxes: BotInboxes) {}
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
  update(bot: Assistant, call: Call<'update_work'>): Promise<WorkItem> {
    return this.change(bot, (inbox, now) => {
      const box = inbox.inbox!, work = box.work ??= [];
      let item = call.work ? work.find(entry => entry.id === call.work) ?? fail('No work item by that id; list yours with list_bots.') : undefined;
      if (!item) {
        if (!call.title || !call.summary) fail('A new work item needs a title and a summary.');
        item = { id: `w_${digest([inbox.id, call.title, now]).slice(0, 12)}`, title: call.title!, phase: call.phase ?? 'clarifying', summary: call.summary!, updatedAt: now };
        work.push(item);
        // Done items make room for a new one; open ones stay.
        while (work.length > WORK_ITEM_LIMIT) { const done = work.findIndex(entry => entry.phase === 'done'); if (done < 0) fail('You keep 20 open work items already; complete one first.'); work.splice(done, 1); }
      }
      for (const key of ['title', 'phase', 'summary', 'next', 'acceptance'] as const) if (call[key] !== undefined) (item as Record<string, unknown>)[key] = call[key];
      item.updatedAt = now;
      syncWorkTimer(inbox, now);
      return structuredClone(item);
    });
  }
  complete(bot: Assistant, call: Call<'complete_work'>): Promise<WorkItem> {
    return this.change(bot, (inbox, now) => {
      const item = (inbox.inbox!.work ?? []).find(entry => entry.id === call.work) ?? fail('No work item by that id.');
      item.phase = 'done'; item.summary = call.summary; delete item.next; item.updatedAt = now;
      syncWorkTimer(inbox, now);
      return structuredClone(item);
    });
  }
  setTimer(bot: Assistant, call: Call<'set_timer'>): Promise<{ timers: BotTimer[] }> {
    return this.change(bot, (inbox, now) => {
      // The work timer follows the open work items; a bot names its own timers otherwise.
      if (call.name === 'work') fail('The work timer follows your open work items; name your timer otherwise.');
      const box = inbox.inbox!, timers = (box.timers ?? []).filter(timer => timer.name !== call.name);
      if (call.minutes > 0) {
        timers.push({ name: call.name, intervalMs: call.minutes * 60_000, dueAt: now + call.minutes * 60_000 });
        if (timers.length > 8) fail('A bot keeps at most 8 timers.');
      }
      box.timers = timers;
      return { timers: structuredClone(timers) };
    });
  }
  /** The bot's work items, newest first. */
  items(bot: Assistant): WorkItem[] {
    return [...(this.inboxes.current(this.broker.ports.read(), bot)?.inbox?.work ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
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
  private async due(): Promise<void> {
    await this.broker.change(teams => {
      const now = this.broker.ports.now();
      plain(teams).forEach((team, index) => {
        if (!team.inbox || team.status !== 'active' || !team.inbox.timers?.some(timer => timer.dueAt <= now)) return;
        const inbox = teams[index]!, seat = inbox.members[0]!;
        for (const timer of inbox.inbox!.timers!.filter(item => item.dueAt <= now)) {
          // Something already on its way wakes the bot anyway; the timer only waits again.
          if (settled(inbox)) {
            const open = (inbox.inbox!.work ?? []).filter(item => item.phase !== 'done').map(item => ({ title: item.title, phase: item.phase, ...(item.next ? { next: item.next } : {}) }));
            const message = { id: digest(['timer', inbox.id, timer.name, now]), from: seat.id, to: seat.id, text: timerText({ name: timer.name, work: open }), status: 'queued' as const, createdAt: now };
            assertTeamQueueCapacity(inbox, message); inbox.messages.push(message);
          }
          timer.dueAt = now + timer.intervalMs;
        }
        inbox.revision++; inbox.updatedAt = now;
      });
    });
  }
}

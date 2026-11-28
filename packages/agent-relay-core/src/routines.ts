/**
 * A standing bot's routines (routines design 3), kept on its inbox. A routine is a schedule and a prompt: when the schedule says it is
 * due, the Relay queues a framed message for the bot, in a chain of its own, and keeps the run. The schedule kinds are the clock ones
 * (once, every, daily, weekdays) and `quiet`, the old timer: due only after a quiet interval, pushed back by every message queued for
 * the bot, so it never fires while work flows. A bot with open board items has a quiet routine of the Relay's own, every five minutes
 * (thirty while all of them wait).
 *
 * Rules a run keeps. One run of a routine waits or works at a time. A due time that finds the run still waiting for the bot (busy, or its
 * Host away) does not queue another: the waiting run counts it as missed and says so when it is delivered, so a long absence is one run.
 * A due time that finds the run working is skipped. A routine with its own daily limit stops there.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { HOOK_BATCH_LIMIT, HOOK_EVENT_CHARS, HOOK_MIN_GAP_MS, ROUTINE_RUNS_KEPT, ROUTINES_PER_BOT, boardItemOpen, localTime, nextRun, routineText, type Routine, type RoutineRun, type RoutineSchedule, type TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { assertTeamQueueCapacity, pendingTeamMessage, type SavedTeam } from './team-delivery.js';
import { plain } from './drafts.js';
import type { Assistant, AssistantBrokerPorts } from './assistants.js';
import type { BotInboxes } from './inboxes.js';
import { routineChainId, type BotChains } from './chains.js';
import { chainScope, inChain } from './chain-scope.js';
import { ownerTasks } from './tasks.js';

type Call<A extends TeamHostCall['action']> = Extract<TeamHostCall, { action: A }>;
const fail = (message: string): never => { throw new Error(message); };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const WORK_QUIET_MS = 5 * 60_000;
export const WAITING_QUIET_MS = 30 * 60_000;
/** A run the bot took and never finished stops blocking its routine after this long. */
export const ROUTINE_RUN_TIMEOUT_MS = 2 * 60 * 60_000;
/** A run for a sub-session whose Host was away is tried again this often. */
export const SUB_RETRY_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** What a person or a bot asks of a routine: the fields `set_routine` carries. */
export interface RoutineSpec { name: string; schedule: RoutineSchedule; prompt?: string; model?: string; maxRunsPerDay?: number; untilMinutes?: number; timeZone?: string; paused?: boolean; workspace?: 'same' }
export interface RoutineOptions {
  /** The account's time zone, where daily and weekdays times are read. */
  zone?: () => string;
  /** Why an unattended start must not happen now (a budget, a pause, a provider limit), or undefined. */
  refuse?: (inbox: SavedTeam, routine: Routine, now: number) => string | undefined;
  /** A run was queued for the bot: the account counts it. */
  started?: (bot: string) => Promise<void>;
  /** Starts a sub-session of the bot's own, with the model a routine names, to do a run's work; its result reaches the bot as a sub-session's does. */
  startSub?: (start: { hostId: string; providerId: string; nativeSessionId: string; title: string; operationId: string; name: string; prompt: string; model?: string; workspace?: 'read_only' }) => Promise<void>;
}
/** A run that goes to a sub-session of its own: the routine names a model, and the bot's own session is never switched to it. */
interface SubStart { chain: string; bot: string; hostId: string; providerId: string; nativeSessionId: string; title: string; name: string; model?: string; readOnly: boolean; text: string }
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
/** A webhook's secret and what the routine keeps of it: its id and the secret's hash. The token is the id and the secret, shown to the person once. */
function newHook(keep?: string): { hook: NonNullable<Routine['hook']>; token: string } {
  const id = keep ?? randomBytes(6).toString('hex'), secret = randomBytes(32).toString('base64url');
  return { hook: { id, hash: sha(secret) }, token: `${id}.${secret}` };
}

/** Every message queued for the bot pushes its quiet routines back to a full interval from now. */
export function pushBackQuietRoutines(inbox: SavedTeam, now: number): void {
  for (const routine of inbox.inbox?.routines ?? []) if (routine.schedule.kind === 'quiet') routine.dueAt = now + routine.schedule.minutes * 60_000;
}
/** The quiet routine a bot keeps while it has open board items: five minutes, thirty while all of them wait; none once all are finished. */
function syncWorkRoutine(inbox: SavedTeam, now: number): void {
  const box = inbox.inbox!, open = (box.board?.items ?? []).filter(item => boardItemOpen(item.status));
  const others = (box.routines ?? []).filter(routine => !routine.work);
  if (!open.length) { if (box.routines) box.routines = others; return; }
  const minutes = open.every(item => item.status === 'waiting') ? WAITING_QUIET_MS / 60_000 : WORK_QUIET_MS / 60_000;
  const current = box.routines?.find(routine => routine.work);
  box.routines = [...others, current && current.schedule.kind === 'quiet' && current.schedule.minutes === minutes ? current
    : { id: 'work', name: 'work', schedule: { kind: 'quiet', minutes }, by: 'system', work: true, anchor: now, dueAt: now + minutes * 60_000, runCount: current?.runCount ?? 0, runs: current?.runs ?? [] }];
}
/** When a routine next needs the Relay: it is due, or it ends, whichever comes first. A paused or finished one never does. */
const stirsAt = (routine: Routine): number => {
  if (routine.paused || routine.finished) return Infinity;
  const retry = routine.runs.find(run => run.state === 'waiting' && run.tried !== undefined);
  return Math.min(routine.dueAt ?? Infinity, routine.endsAt ?? Infinity, retry ? retry.tried! + SUB_RETRY_MS : Infinity);
};
const settled = (inbox: SavedTeam) => !inbox.messages.some(pendingTeamMessage);
const clockText = (instant: number, zone: string) => { const local = localTime(instant, zone), pad = (value: number) => String(value).padStart(2, '0'); return `${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][local.weekday - 1]} ${pad(local.hour)}:${pad(local.minute)}`; };

/** The runs of a routine as they stand now: a waiting run whose message was taken is working; a working run the bot never ended has failed. Pure, so views can use it. */
export function settledRuns(inbox: SavedTeam, routine: Routine, now: number): RoutineRun[] {
  return routine.runs.map((run): RoutineRun => {
    if (run.state === 'waiting' && run.tried === undefined) {
      const message = inbox.messages.find(item => item.chain === run.chain);
      if (message && pendingTeamMessage(message)) return run;
      if (message && (message.status === 'rejected' || message.status === 'canceled')) return { ...run, state: 'failed', endedAt: now, reason: message.status === 'canceled' ? 'withdrawn' : 'not accepted' };
      return { ...run, state: 'running', startedAt: run.startedAt ?? now };
    }
    return run;
  })  .map((run): RoutineRun => run.state === 'running' && now - (run.startedAt ?? run.dueAt) > ROUTINE_RUN_TIMEOUT_MS ? { ...run, state: 'failed', endedAt: now, reason: 'no result' } : run);
}

export class BotRoutines {
  private timer: unknown;
  /** Runs a change decided to send to sub-sessions; they start once the change has committed. */
  private subs: SubStart[] = [];
  constructor(private readonly broker: AssistantBrokerPorts, private readonly inboxes: BotInboxes, private readonly chains?: BotChains, private readonly options: RoutineOptions = {}) {}
  private zone(routine?: { timeZone?: string }): string { return routine?.timeZone ?? this.options.zone?.() ?? 'UTC'; }
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
  /** Brings the bot's work routine in line with its open board items; inside a change. */
  syncWorkRoutine(inbox: SavedTeam, now: number): void { syncWorkRoutine(inbox, now); }
  /** The routines of a bot as they stand now, with their runs settled. */
  list(botKey: string): Routine[] {
    const now = this.broker.ports.now(), inbox = this.broker.ports.read().find(team => team.inbox?.botId === botKey && team.status === 'active');
    return (inbox?.inbox?.routines ?? []).map(routine => ({ ...structuredClone(routine), runs: structuredClone(settledRuns(inbox!, routine, now)) }));
  }
  /**
   * Sets a routine by name, replacing the one of that name (its runs stay). A bot sets its own; an event routine is the person's alone,
   * and a bot working in an unattended chain sets none, so unattended work cannot enlarge itself.
   */
  setRoutine(bot: Assistant, spec: RoutineSpec, by: 'person' | 'bot', unattended = false): Promise<{ routines: Routine[]; hook?: { token: string } }> {
    if (by === 'bot' && unattended) fail('A routine or event cannot set routines; it can pause or delete them.');
    if (by === 'bot' && spec.schedule.kind === 'event') fail('Only the person sets a routine that an event starts.');
    if (spec.name === 'work') fail('The work routine follows your open board items; name your routine otherwise.');
    if (spec.timeZone !== undefined) this.zone(spec);
    return this.change(bot, (inbox, now) => {
      const box = inbox.inbox!, zone = this.zone(spec), others = (box.routines ?? []).filter(routine => routine.name !== spec.name), previous = box.routines?.find(routine => routine.name === spec.name);
      if (spec.schedule.kind === 'once' && spec.schedule.at <= now) fail('A once routine needs a time in the future.');
      if (others.length >= ROUTINES_PER_BOT) fail(`A bot keeps at most ${ROUTINES_PER_BOT} routines.`);
      const dueAt = nextRun(spec.schedule, now, zone, now);
      const routine: Routine = { id: previous?.id ?? randomUUID().slice(0, 8), name: spec.name, schedule: spec.schedule, by: previous?.by === 'person' && by === 'bot' ? 'person' : by, anchor: now,
        ...(spec.prompt !== undefined ? { prompt: spec.prompt } : {}), ...(spec.model !== undefined ? { model: spec.model } : {}), ...(spec.timeZone !== undefined ? { timeZone: spec.timeZone } : {}),
        ...(spec.paused ? { paused: true as const } : {}), ...(dueAt !== undefined ? { dueAt } : {}),
        ...(spec.untilMinutes !== undefined ? { endsAt: now + spec.untilMinutes * 60_000 } : {}), ...(spec.maxRunsPerDay !== undefined ? { maxRunsPerDay: spec.maxRunsPerDay } : {}),
        runCount: previous?.runCount ?? 0, runs: previous?.runs ?? [] };
      // A webhook routine keeps its address when it is edited; a new one gets one, shown once.
      let token: string | undefined;
      if (spec.schedule.kind === 'event') {
        if (previous?.hook && previous.schedule.kind === 'event') { routine.hook = previous.hook; if (previous.events) routine.events = previous.events; if (previous.lastEventAt) routine.lastEventAt = previous.lastEventAt; }
        else { const made = newHook(); routine.hook = made.hook; token = made.token; }
        if (spec.workspace) routine.workspace = spec.workspace;
      }
      box.routines = [...others, routine];
      return { routines: box.routines, ...(token ? { hook: { token } } : {}) };
    });
  }
  /** The person replaces a webhook routine's secret: the old address stops answering at once. */
  rotateHook(bot: Assistant, name: string): Promise<{ hook: { token: string } }> {
    return this.change(bot, inbox => {
      const routine = inbox.inbox!.routines?.find(item => item.name === name && item.schedule.kind === 'event') ?? fail(`No webhook routine of yours is named "${name}".`);
      const made = newHook(routine.hook?.id); routine.hook = made.hook;
      return { hook: { token: made.token } };
    });
  }
  /**
   * A webhook call: the token names the routine (its id) and proves the caller (the secret, by its hash, compared in constant time). A call to a paused
   * routine, or one the budget refuses, is answered and recorded as skipped. Otherwise the payload joins the routine's batch; the run starts once none is
   * waiting or working and the last event run began at least five minutes ago, and it takes every event that arrived by then (at most twenty).
   */
  async receive(token: string, payload: string): Promise<{ status: 'unknown' } | { status: 'accepted'; queued: boolean; reason?: string }> {
    const [id, secret] = token.split('.');
    const find = (teams: readonly SavedTeam[]) => { for (const team of teams) for (const routine of team.inbox?.routines ?? []) if (routine.hook?.id === id) return { team, routine }; return undefined; };
    const found = id && secret ? find(this.broker.ports.read()) : undefined;
    const given = Buffer.from(sha(secret ?? ''), 'hex'), kept = Buffer.from(found?.routine.hook?.hash ?? '0'.repeat(64), 'hex');
    if (!found || !timingSafeEqual(given, kept)) return { status: 'unknown' };
    const outcome = await this.broker.change(teams => {
      const own = find(teams); if (!own) return { queued: false, reason: 'gone' };
      const { team, routine } = own, now = this.broker.ports.now();
      team.revision++; team.updatedAt = now;
      if (routine.paused) return { queued: false, reason: 'paused' };
      const refused = this.options.refuse?.(team, routine, now);
      if (refused) { this.skip(routine, now, now, refused, 'event'); return { queued: false, reason: refused }; }
      const events = routine.events ??= [];
      if (events.length < HOOK_BATCH_LIMIT) events.push(payload.slice(0, HOOK_EVENT_CHARS)); else routine.eventsDropped = (routine.eventsDropped ?? 0) + 1;
      routine.dueAt ??= Math.max(now, (routine.lastEventAt ?? 0) + HOOK_MIN_GAP_MS);
      return { queued: true };
    });
    this.arm();
    return { status: 'accepted', ...outcome };
  }
  pause(bot: Assistant, name: string, paused: boolean): Promise<{ routines: Routine[] }> {
    return this.change(bot, (inbox, now) => {
      const routine = inbox.inbox!.routines?.find(item => item.name === name) ?? fail(`No routine of yours is named "${name}".`);
      if (paused) routine.paused = true;
      else { delete routine.paused; if (routine.schedule.kind !== 'event' && !routine.finished) { const dueAt = nextRun(routine.schedule, now, this.zone(routine), routine.anchor); if (dueAt !== undefined) routine.dueAt = dueAt; } }
      return { routines: inbox.inbox!.routines! };
    });
  }
  delete(bot: Assistant, name: string): Promise<{ routines: Routine[] }> {
    return this.change(bot, inbox => {
      const box = inbox.inbox!, routine = box.routines?.find(item => item.name === name) ?? fail(`No routine of yours is named "${name}".`);
      if (routine.work) fail('The work routine follows your open board items.');
      box.routines = box.routines!.filter(item => item !== routine);
      return { routines: box.routines };
    });
  }
  /** The person starts a routine now: the same prompt and frame, marked as a test. It ignores the schedule and every pause, not an active run. */
  async test(bot: Assistant, name: string): Promise<{ run: number }> {
    const started: Array<{ id: string; bot: string }> = [];
    const result = await this.change(bot, (inbox, now) => {
      const routine = inbox.inbox!.routines?.find(item => item.name === name) ?? fail(`No routine of yours is named "${name}".`);
      routine.runs = settledRuns(inbox, routine, now);
      if (routine.runs.some(run => run.state === 'waiting' || run.state === 'running')) fail('A run of this routine is still active.');
      const teams = this.broker.ports.read();
      const run = this.queue(inbox, teams, routine, now, now, 'test', 0, started, routine.schedule.kind === 'event' ? { events: ['{"sample":"This is a test run; no event arrived."}'], dropped: 0 } : undefined);
      return { run: run.n };
    });
    await this.recordStarted(started);
    await this.startSubs();
    return result;
  }
  /** A turn of a routine's chain ended: its run is done. */
  async turnEnded(chainId: string, used?: { tokens: number; usd: number; flags: string[] }, outcome: 'finished' | 'failed' | 'interrupted' = 'finished', reason?: string): Promise<void> {
    await this.broker.change(teams => {
      const now = this.broker.ports.now();
      for (const team of plain(teams).map((_, index) => teams[index]!)) for (const routine of team.inbox?.routines ?? []) {
        const run = routine.runs.find(item => item.chain === chainId);
        if (!run) continue;
        if (run.state !== 'done' && run.state !== 'failed') { run.state = outcome === 'finished' ? 'done' : 'failed'; run.startedAt ??= now; run.endedAt = now; if (outcome !== 'finished') run.reason = (outcome === 'failed' ? reason?.replace(/\s+/g, ' ').trim().slice(0, 120) || 'the turn failed' : 'interrupted'); }
        if (used) { run.tokens = (run.tokens ?? 0) + used.tokens; run.usd = (run.usd ?? 0) + used.usd; const flags = [...new Set([...run.flags ?? [], ...used.flags])].slice(0, 6); if (flags.length) run.flags = flags; }
        team.revision++; team.updatedAt = now;
      }
    });
  }
  /** Sets the one timer for the next routine due, as rooms do theirs. */
  arm(): void {
    const scheduler = this.broker.ports.scheduler;
    if (!scheduler) return;
    scheduler.clearTimeout(this.timer); this.timer = undefined;
    const due = this.broker.ports.read().flatMap(team => team.inbox && team.status === 'active' ? (team.inbox.routines ?? []).map(stirsAt) : []).filter(Number.isFinite);
    if (!due.length) return;
    const wait = Math.min(Math.max(0, Math.min(...due) - this.broker.ports.now()), DAY_MS);
    this.timer = scheduler.setTimeout(() => { this.timer = undefined; void this.due().catch(() => undefined).finally(() => this.arm()); }, wait);
  }
  /** The live sub-sessions the bot's session owns, as a quiet routine's frame lists them; a person's own side is not the bot's. */
  private roster(teams: readonly SavedTeam[], seat: { hostId: string; providerId: string; nativeSessionId?: string }, now: number) {
    return ownerTasks([...teams], this.broker.ports.resolveSession, seat.hostId, { providerId: seat.providerId, nativeSessionId: seat.nativeSessionId ?? '' })
      .filter(team => team.task!.state !== 'ended' && team.task!.startedBy !== 'person').sort((a, b) => a.createdAt - b.createdAt).map(team => {
        const item = team.task!, idle = item.state === 'idle' ? Math.max(1, Math.round((now - item.updatedAt) / 60_000)) : undefined;
        return { name: item.title, ...(idle !== undefined ? { idle: idle < 60 ? `${idle} min` : idle < 1440 ? `${Math.round(idle / 60)} h` : `${Math.round(idle / 1440)} d` } : {}),
          ...(item.lastWork ? { lastWork: item.lastWork.title } : {}), ...(item.currentStep ? { step: item.currentStep } : {}) };
      });
  }
  /** The text a run delivers, written from the record. */
  private frame(inbox: SavedTeam, teams: readonly SavedTeam[], routine: Routine, run: RoutineRun, now: number): string {
    const seat = inbox.members[0]!, zone = this.zone(routine), quiet = routine.schedule.kind === 'quiet';
    const open = (inbox.inbox!.board?.items ?? []).filter(item => boardItemOpen(item.status)).map(item => ({ title: item.title, status: item.status, ...(item.report ? { report: item.report } : {}) }));
    const late = clockText(run.dueAt, zone) !== clockText(now, zone);
    const detail = quiet ? 'quiet' : run.events !== undefined ? [`event run ${run.n}`, `${run.events} ${run.events === 1 ? 'event' : 'events'}`, ...(run.trigger === 'test' ? ['test'] : [])].join(' · ') : [`run ${run.n}`, `due ${clockText(run.dueAt, zone)}`, ...(late ? [`started ${clockText(now, zone)}`] : []), ...(run.trigger === 'test' ? ['test'] : [])].join(' · ');
    return routineText({ name: routine.name, detail, quiet, ...(routine.prompt ? { prompt: routine.prompt } : {}), ...(run.payloads ? { events: run.payloads, eventsDropped: run.left ?? 0 } : {}),
      ...(run.missed ? { missed: { count: run.missed, since: clockText(run.dueAt, zone) } } : {}), ...(quiet ? { items: open, subSessions: this.roster(teams, seat, now) } : {}) });
  }
  /** Queues a run of a routine for its bot; inside a change. */
  private queue(inbox: SavedTeam, teams: readonly SavedTeam[], routine: Routine, dueAt: number, now: number, trigger: RoutineRun['trigger'], missed: number, started: Array<{ id: string; bot: string }>, event?: { events: string[]; dropped: number }): RoutineRun {
    const seat = inbox.members[0]!, chain = routineChainId(inbox.id, routine.id, now, routine.runCount + 1);
    const run: RoutineRun = { n: ++routine.runCount, trigger, dueAt, state: 'waiting', chain, ...(routine.model ? { model: routine.model } : {}), ...(missed ? { missed } : {}),
      ...(event ? { events: Math.max(1, event.events.length), payloads: event.events, ...(event.dropped ? { left: event.dropped } : {}) } : {}) };
    const text = this.frame(inbox, teams, routine, run, now);
    routine.runs = [...routine.runs, run].slice(-ROUTINE_RUNS_KEPT);
    // A routine that names a model, and every routine an event starts, works in a sub-session of its own: the bot's own session is never switched
    // to another model, and an event's text, which anyone with the address can write, reaches a session that cannot change files unless the person allowed it.
    if ((routine.model || routine.schedule.kind === 'event') && this.options.startSub) {
      run.tried = now;
      this.subs.push(this.subStart(inbox, routine, run, text));
      return run;
    }
    const message = { id: digest(['routine', inbox.id, routine.id, run.n]), from: seat.id, to: seat.id, text, status: 'queued' as const, createdAt: now, chain };
    assertTeamQueueCapacity(inbox, message); inbox.messages.push(message);
    started.push({ id: chain, bot: inbox.inbox!.botId });
    return run;
  }
  private subStart(inbox: SavedTeam, routine: Routine, run: RoutineRun, text: string): SubStart {
    const seat = inbox.members[0]!;
    return { chain: run.chain!, bot: inbox.inbox!.botId, hostId: seat.hostId, providerId: seat.providerId, nativeSessionId: seat.nativeSessionId ?? '', title: inbox.title, name: routine.name, ...(routine.model ? { model: routine.model } : {}), readOnly: routine.schedule.kind === 'event' && routine.workspace !== 'same', text };
  }
  private skip(routine: Routine, dueAt: number, now: number, reason: string, trigger: RoutineRun['trigger'] = 'schedule'): void {
    routine.runs = [...routine.runs, { n: ++routine.runCount, trigger, dueAt, state: 'skipped' as const, endedAt: now, reason }].slice(-ROUTINE_RUNS_KEPT);
  }
  /** Starts the sub-sessions of the runs the last change decided on; one that cannot start ends its run as failed. */
  private async startSubs(): Promise<void> {
    const subs = this.subs; this.subs = [];
    for (const item of subs) {
      const scope = chainScope(item.chain); scope.bots.add(item.bot);
      try {
        await inChain(scope, () => this.options.startSub!({ hostId: item.hostId, providerId: item.providerId, nativeSessionId: item.nativeSessionId, title: item.title,
          operationId: `routine:${item.chain}`, name: item.name, prompt: item.text, ...(item.model ? { model: item.model } : {}), ...(item.readOnly ? { workspace: 'read_only' as const } : {}) }));
        await this.chains?.record(scope, { cause: 'routine', bot: item.bot }).catch(() => undefined);
        await this.options.started?.(item.bot).catch(() => undefined);
        await this.changeRun(item.chain, (run, now) => { delete run.tried; delete run.payloads; run.state = 'running'; run.startedAt = now; });
      } catch (error) {
        const reason = (error instanceof Error ? error.message : 'could not start').slice(0, 100);
        // A Host that is away keeps the run waiting: it is tried again, and the due times that pass meanwhile count as missed.
        const away = /offline|unavailable|not connected/i.test(reason);
        await this.changeRun(item.chain, (run, now) => { if (away) run.tried = now; else { delete run.tried; delete run.payloads; run.state = 'failed'; run.endedAt = now; run.reason = reason; } });
      }
    }
  }
  /** Changes one run, found by its chain. */
  private async changeRun(chain: string, update: (run: RoutineRun, now: number) => void): Promise<void> {
    await this.broker.change(teams => {
      const now = this.broker.ports.now();
      for (const team of plain(teams).map((_, index) => teams[index]!)) for (const routine of team.inbox?.routines ?? []) {
        const run = routine.runs.find(candidate => candidate.chain === chain);
        if (run) { update(run, now); team.revision++; team.updatedAt = now; }
      }
    });
    this.arm();
  }
  private async recordStarted(started: ReadonlyArray<{ id: string; bot: string }>): Promise<void> {
    for (const chain of started) {
      const scope = chainScope(chain.id); scope.messages = 1; scope.bots.add(chain.bot);
      await this.chains?.record(scope, { cause: 'routine', bot: chain.bot }).catch(() => undefined);
      await this.options.started?.(chain.bot).catch(() => undefined);
    }
  }
  private async due(): Promise<void> {
    // Each run starts a chain of its own (bots design 7).
    const started: Array<{ id: string; bot: string }> = [];
    await this.broker.change(teams => {
      const now = this.broker.ports.now();
      plain(teams).forEach((team, index) => {
        if (!team.inbox || team.status !== 'active' || !team.inbox.routines?.some(routine => stirsAt(routine) <= now)) return;
        const inbox = teams[index]!, box = inbox.inbox!, zone = (routine: Routine) => this.zone(routine);
        // A routine past its end is dropped without waking the bot.
        box.routines = box.routines!.filter(routine => routine.endsAt === undefined || routine.endsAt > now);
        for (const routine of box.routines.filter(item => stirsAt(item) <= now)) {
          routine.runs = settledRuns(inbox, routine, now);
          // A run that could not start in its sub-session is tried again, with the due times that passed since counted in it.
          const retry = routine.runs.find(run => run.state === 'waiting' && run.tried !== undefined && run.tried + SUB_RETRY_MS <= now);
          if (retry) { retry.tried = now; this.subs.push(this.subStart(inbox, routine, retry, this.frame(inbox, teams, routine, retry, now))); }
          if (routine.dueAt === undefined || routine.dueAt > now) continue;
          if (routine.schedule.kind === 'event') {
            // The events that came in run together once nothing of this routine is waiting or working; the next event run starts at least five minutes later.
            delete routine.dueAt;
            const events = routine.events ?? [];
            if (!events.length) continue;
            if (routine.runs.some(run => run.state === 'waiting' || run.state === 'running')) { routine.dueAt = now + SUB_RETRY_MS; continue; }
            const dropped = routine.eventsDropped ?? 0;
            delete routine.events; delete routine.eventsDropped;
            const refused = this.options.refuse?.(inbox, routine, now);
            if (refused) { this.skip(routine, now, now, refused, 'event'); continue; }
            if (routine.maxRunsPerDay !== undefined && routine.runs.filter(run => run.state !== 'skipped' && now - run.dueAt < DAY_MS).length >= routine.maxRunsPerDay) { this.skip(routine, now, now, 'daily limit', 'event'); continue; }
            routine.lastEventAt = now;
            this.queue(inbox, teams, routine, now, now, 'event', 0, started, { events, dropped });
            continue;
          }
          const dueAt = routine.dueAt, quiet = routine.schedule.kind === 'quiet';
          // The next due time is counted from this one (quiet: from now); a once routine is finished.
          const next = nextRun(routine.schedule, quiet ? now : dueAt, zone(routine), routine.anchor);
          if (next === undefined) { delete routine.dueAt; if (routine.schedule.kind === 'once') routine.finished = true; } else routine.dueAt = Math.max(next, now + 1);
          // Something already on its way wakes a quiet routine's bot anyway; it only waits again.
          if (quiet && !settled(inbox)) continue;
          const waiting = quiet ? undefined : routine.runs.find(run => run.state === 'waiting'), working = quiet ? undefined : routine.runs.find(run => run.state === 'running');
          const message = waiting && inbox.messages.find(item => item.chain === waiting.chain);
          if (waiting && (message?.status === 'queued' || waiting.tried !== undefined)) { waiting.missed = (waiting.missed ?? 0) + 1; if (message) message.text = this.frame(inbox, teams, routine, waiting, now); continue; }
          if (waiting || working) { this.skip(routine, dueAt, now, 'overlap'); continue; }
          const refused = this.options.refuse?.(inbox, routine, now);
          if (refused) { this.skip(routine, dueAt, now, refused); continue; }
          if (routine.maxRunsPerDay !== undefined && routine.runs.filter(run => run.state !== 'skipped' && now - run.dueAt < DAY_MS).length >= routine.maxRunsPerDay) { this.skip(routine, dueAt, now, 'daily limit'); continue; }
          this.queue(inbox, teams, routine, dueAt, now, 'schedule', 0, started);
        }
        inbox.revision++; inbox.updatedAt = now;
      });
    });
    await this.recordStarted(started);
    await this.startSubs();
  }
}

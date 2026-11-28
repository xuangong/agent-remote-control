/**
 * The account's unattended work (routines design 11): its settings, the usage of unattended chains by local day and bot, the provider
 * limits that stand, and the one check made before each unattended start. Cost is the estimate the price table gives (≈$, API-equivalent).
 * A cap refuses new starts only: a run in progress finishes (decided with the owner).
 */
import { dayKey, PROVIDER_LIMIT_PROBE_MS, USAGE_DAYS_KEPT, type Estimate, type ModelRates, type Routine, type UnattendedBudget, type UnattendedSettings, type UnattendedState, type UnattendedView, type UsageDay } from '@orchardworks/agent-remote-protocol';

export interface UnattendedStore { read(): UnattendedState; change<T>(update: (state: UnattendedState) => T): Promise<T> }
export const emptyUnattended = (): UnattendedState => ({ settings: {}, ledger: {}, limits: {} });
/** An in-memory store, for a broker without saved state. */
export function memoryUnattended(): UnattendedStore {
  let state = emptyUnattended();
  return { read: () => state, change: async update => { const draft = structuredClone(state); const value = update(draft); state = draft; return value; } };
}
export const DEFAULT_ABSENCE_DAYS = 14;
/** The system bound on unattended runs a day, whatever the budget says. */
export const RUNS_PER_DAY_BOUND = 200;
const DAY_MS = 24 * 60 * 60_000;
const blank = (): UsageDay => ({ usd: 0, tokens: 0, turns: 0, runs: 0 });

/** What the person's patch says about one budget: the fields given replace, null removes. */
function mergeBudget(current: UnattendedBudget | undefined, given: UnattendedBudget | null): UnattendedBudget | undefined {
  if (given === null) return undefined;
  return Object.keys(given).length ? given : undefined;
}

export class Unattended {
  constructor(private readonly store: UnattendedStore, private readonly now: () => number) {}
  settings(): UnattendedSettings { return this.store.read().settings; }
  zone(): string { return this.settings().timeZone ?? 'UTC'; }
  private day(at = this.now()): string { return dayKey(at, this.zone()); }
  /** The usage of one local day, summed over bots, and of the month the day is in. */
  private totals(state: UnattendedState, day: string, bot?: string): { day: UsageDay; month: UsageDay } {
    const sum = (into: UsageDay, row: UsageDay) => { into.usd += row.usd; into.tokens += row.tokens; into.turns += row.turns; into.runs += row.runs; };
    const out = { day: blank(), month: blank() };
    for (const [key, bots] of Object.entries(state.ledger)) for (const [id, row] of Object.entries(bots)) {
      if (bot !== undefined && id !== bot) continue;
      if (key === day) sum(out.day, row);
      if (key.slice(0, 7) === day.slice(0, 7)) sum(out.month, row);
    }
    return out;
  }
  /** Adds what an unattended turn used to its bot's day. */
  record(bot: string, estimate: Estimate, model?: string): Promise<void> {
    return this.store.change(state => {
      const day = this.day(), row = (state.ledger[day] ??= {})[bot] ??= blank();
      row.usd += estimate.usd; row.tokens += estimate.tokens; row.turns++;
      if (estimate.flags.includes('price unknown')) {
        row.unpriced = (row.unpriced ?? 0) + 1;
        const name = model ?? 'unknown model', seen = (state.unpriced ??= {});
        if (seen[name] !== undefined || Object.keys(seen).length < 50) seen[name] = (seen[name] ?? 0) + 1;
      }
      this.prune(state);
    });
  }
  /** Counts a run the Relay started for a bot. */
  countRun(bot: string): Promise<void> {
    return this.store.change(state => { const row = (state.ledger[this.day()] ??= {})[bot] ??= blank(); row.runs++; this.prune(state); });
  }
  private prune(state: UnattendedState): void {
    const keep = Object.keys(state.ledger).sort().slice(-USAGE_DAYS_KEPT);
    for (const key of Object.keys(state.ledger)) if (!keep.includes(key)) delete state.ledger[key];
  }
  /** The person opened a client or acted; written at most once an hour. */
  touch(): Promise<void> | undefined {
    const now = this.now(), seen = this.settings().activeAt;
    if (seen !== undefined && now - seen < 60 * 60_000) return undefined;
    return this.store.change(state => { state.settings.activeAt = now; });
  }
  setLimit(provider: string, resetsAt?: number): Promise<void> {
    return this.store.change(state => { state.limits[provider] = { at: this.now(), ...(resetsAt !== undefined ? { resetsAt } : {}) }; });
  }
  /** Whether a provider's usage window stands now: until its reset, or, without one, for an hour from when it was reported. */
  limited(provider: string, now = this.now()): { resetsAt?: number } | undefined {
    const limit = this.store.read().limits[provider];
    if (!limit) return undefined;
    const until = limit.resetsAt ?? limit.at + PROVIDER_LIMIT_PROBE_MS;
    return until > now ? { ...(limit.resetsAt !== undefined ? { resetsAt: limit.resetsAt } : {}) } : undefined;
  }
  /** The caps that stand for a scope on a day: the day's cap includes what the person allowed for it. */
  private caps(state: UnattendedState, bot?: string): UnattendedBudget {
    const own = bot !== undefined ? state.settings.bots?.[bot]?.budget : undefined, account = state.settings.budget ?? {};
    const caps = bot !== undefined ? own ?? {} : account;
    const extra = state.settings.extraToday?.day === this.day() ? state.settings.extraToday.usd : 0;
    return { ...caps, ...(caps.perDay !== undefined ? { perDay: caps.perDay + extra } : {}) };
  }
  /** The scopes that reached a cap now. */
  tripped(state = this.store.read()): Array<{ scope: string; period: 'day' | 'month' }> {
    const day = this.day(), out: Array<{ scope: string; period: 'day' | 'month' }> = [];
    const test = (scope: string, bot: string | undefined) => {
      const caps = this.caps(state, bot), used = this.totals(state, day, bot);
      if (caps.perDay !== undefined && used.day.usd >= caps.perDay) out.push({ scope, period: 'day' });
      if (caps.perMonth !== undefined && used.month.usd >= caps.perMonth) out.push({ scope, period: 'month' });
    };
    test('account', undefined);
    for (const bot of Object.keys(state.settings.bots ?? {})) test(bot, bot);
    return out;
  }
  /**
   * Why an unattended start of a routine must not happen now, or undefined. In order: the account's pause, the bot's pause, the person's
   * long absence, the provider's usage window, the cost caps (account, then bot), the runs a day.
   */
  refuse(bot: string, provider: string, routine: Routine, now: number): string | undefined {
    const state = this.store.read(), settings = state.settings;
    if (settings.paused) return 'paused';
    if (settings.bots?.[bot]?.paused) return 'bot paused';
    const absence = settings.absenceDays ?? DEFAULT_ABSENCE_DAYS;
    if (absence > 0 && settings.activeAt !== undefined && now - settings.activeAt > absence * DAY_MS) return 'absence';
    if (this.limited(provider, now)) return 'provider limit';
    const tripped = this.tripped(state);
    if (tripped.some(item => item.scope === 'account') || tripped.some(item => item.scope === bot)) return 'budget';
    const day = this.day(now), bound = settings.budget?.runsPerDay ?? RUNS_PER_DAY_BOUND;
    if (this.totals(state, day).day.runs >= bound) return 'daily limit';
    const own = settings.bots?.[bot]?.budget?.runsPerDay;
    if (own !== undefined && this.totals(state, day, bot).day.runs >= own) return 'daily limit';
    return undefined;
  }
  /** The person's patch of the settings. */
  patch(patch: { timeZone?: string; paused?: boolean; absenceDays?: number; budget?: UnattendedBudget | null; defaultPrice?: ModelRates | null; prices?: Record<string, ModelRates | null>;
    bots?: Record<string, { paused?: boolean; budget?: UnattendedBudget | null }>; allowMoreToday?: number }): Promise<UnattendedSettings> {
    return this.store.change(state => {
      const settings = state.settings;
      if (patch.timeZone !== undefined) settings.timeZone = patch.timeZone;
      if (patch.paused !== undefined) { if (patch.paused) settings.paused = true; else delete settings.paused; }
      if (patch.absenceDays !== undefined) settings.absenceDays = patch.absenceDays;
      if (patch.budget !== undefined) { const next = mergeBudget(settings.budget, patch.budget); if (next) settings.budget = next; else delete settings.budget; }
      if (patch.defaultPrice !== undefined) { if (patch.defaultPrice) settings.defaultPrice = patch.defaultPrice; else delete settings.defaultPrice; }
      for (const [model, rates] of Object.entries(patch.prices ?? {})) {
        if (rates) (settings.prices ??= {})[model] = rates; else if (settings.prices) { delete settings.prices[model]; if (!Object.keys(settings.prices).length) delete settings.prices; }
      }
      for (const [bot, change] of Object.entries(patch.bots ?? {})) {
        const entry = (settings.bots ??= {})[bot] ??= {};
        if (change.paused !== undefined) { if (change.paused) entry.paused = true; else delete entry.paused; }
        if (change.budget !== undefined) { const next = mergeBudget(entry.budget, change.budget); if (next) entry.budget = next; else delete entry.budget; }
        if (!entry.paused && !entry.budget) delete settings.bots[bot];
      }
      if (settings.bots && !Object.keys(settings.bots).length) delete settings.bots;
      if (patch.allowMoreToday !== undefined) { const day = this.day(); settings.extraToday = { day, usd: (settings.extraToday?.day === day ? settings.extraToday.usd : 0) + patch.allowMoreToday }; }
      return settings;
    });
  }
  /** What the person sees. */
  view(): UnattendedView {
    const state = this.store.read(), day = this.day(), today: UnattendedView['today'] = { usd: 0, bots: {} }, month: UnattendedView['month'] = { usd: 0, bots: {} };
    for (const [key, bots] of Object.entries(state.ledger)) for (const [bot, row] of Object.entries(bots)) {
      const into = (target: UnattendedView['today']) => { const entry = target.bots[bot] ??= blank(); entry.usd += row.usd; entry.tokens += row.tokens; entry.turns += row.turns; entry.runs += row.runs; target.usd += row.usd; };
      if (key === day) into(today);
      if (key.slice(0, 7) === day.slice(0, 7)) into(month);
    }
    const now = this.now(), absence = state.settings.absenceDays ?? DEFAULT_ABSENCE_DAYS;
    return { settings: state.settings, timeZone: this.zone(), day, today, month,
      limits: Object.entries(state.limits).filter(([provider]) => this.limited(provider, now)).map(([provider, limit]) => ({ provider, ...(limit.resetsAt !== undefined ? { resetsAt: limit.resetsAt } : {}) })),
      tripped: this.tripped(state), unpriced: Object.keys(state.unpriced ?? {}),
      ...(absence > 0 && state.settings.activeAt !== undefined && now - state.settings.activeAt > absence * DAY_MS ? { absent: true as const } : {}) };
  }
}

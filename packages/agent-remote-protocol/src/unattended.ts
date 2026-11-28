/**
 * What the person sets for unattended work (routines design 10, 11): the account's time zone, a pause, the budget in estimated cost, the
 * price table that estimate uses, and the usage the Relay has seen so far. Cost is "≈ $", API-equivalent: what the reported tokens would
 * cost at the model's public prices, whatever the person pays their provider.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const strict = { additionalProperties: false } as const;
const usd = Type.Number({ minimum: 0, maximum: 1_000_000 });

/** USD per million tokens: input (uncached), cache write (cache creation), cache read (cached input), output. */
export const ModelRates = Type.Object({ input: usd, cacheWrite: usd, cacheRead: usd, output: usd }, strict);
export type ModelRates = Static<typeof ModelRates>;

/** The caps on unattended work in ≈$. A cap refuses new starts only: a run in progress finishes. */
export const UnattendedBudget = Type.Object({ perDay: Type.Optional(usd), perMonth: Type.Optional(usd), runsPerDay: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })) }, strict);
export type UnattendedBudget = Static<typeof UnattendedBudget>;

export const UnattendedSettings = Type.Object({
  /** An IANA time zone: where daily times and the budget's days are read. */
  timeZone: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  /** The person paused all unattended work. */
  paused: Type.Optional(Type.Literal(true)),
  /** Days without the person before unattended work pauses by itself; 0 turns it off. Default 14. */
  absenceDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 365 })),
  budget: Type.Optional(UnattendedBudget),
  /** The bots' own caps, by bot id: replacing the account's number for that bot's own starts. */
  bots: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 64 }), Type.Object({ paused: Type.Optional(Type.Literal(true)), budget: Type.Optional(UnattendedBudget) }, strict), { maxProperties: 100 })),
  /** The person's own rates by exact model id; they win over the shipped table. */
  prices: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 256 }), ModelRates, { maxProperties: 200 })),
  /** What a model with no row costs: shipped high, editable. */
  defaultPrice: Type.Optional(ModelRates),
  /** When the person last opened a client or acted. */
  activeAt: Type.Optional(Type.Integer({ minimum: 0 })),
  /** Extra ≈$ the person allowed for one day ("allow more today"), by local day. */
  extraToday: Type.Optional(Type.Object({ day: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), usd }, strict)),
}, strict);
export type UnattendedSettings = Static<typeof UnattendedSettings>;
export const isUnattendedSettings = (value: unknown): value is UnattendedSettings => Value.Check(UnattendedSettings, value);

/** One day of unattended usage of one bot: ≈$, tokens, turns and runs started. */
export const UsageDay = Type.Object({ usd, tokens: Type.Integer({ minimum: 0 }), turns: Type.Integer({ minimum: 0 }), runs: Type.Integer({ minimum: 0 }), unpriced: Type.Optional(Type.Integer({ minimum: 0 })) }, strict);
export type UsageDay = Static<typeof UsageDay>;
export const USAGE_DAYS_KEPT = 62;

/** A provider's usage window stands until `resetsAt` (or, with none, until a start tries again after PROVIDER_LIMIT_PROBE_MS). */
export const ProviderLimit = Type.Object({ at: Type.Integer({ minimum: 0 }), resetsAt: Type.Optional(Type.Integer({ minimum: 0 })) }, strict);
export type ProviderLimit = Static<typeof ProviderLimit>;
export const PROVIDER_LIMIT_PROBE_MS = 60 * 60_000;

/** Everything the Relay keeps for unattended work: the settings, the usage by local day and bot, and the provider limits by host and provider. */
export const UnattendedState = Type.Object({
  settings: UnattendedSettings,
  ledger: Type.Record(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), Type.Record(Type.String({ minLength: 1, maxLength: 64 }), UsageDay, { maxProperties: 200 }), { maxProperties: USAGE_DAYS_KEPT + 3, additionalProperties: false }),
  limits: Type.Record(Type.String({ minLength: 1, maxLength: 300 }), ProviderLimit, { maxProperties: 50 }),
  /** Models priced by the default price, with the turns so priced; the person adds a row for each. */
  unpriced: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Integer({ minimum: 1 }), { maxProperties: 50 })),
}, strict);
export type UnattendedState = Static<typeof UnattendedState>;
export const isUnattendedState = (value: unknown): value is UnattendedState => Value.Check(UnattendedState, value);

/** One turn's usage as the Controller reports it: the parts are disjoint (input excludes cached and cache-written tokens). */
export const TurnUsage = Type.Object({ model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), input: Type.Optional(Type.Integer({ minimum: 0 })), cachedInput: Type.Optional(Type.Integer({ minimum: 0 })),
  cacheCreation: Type.Optional(Type.Integer({ minimum: 0 })), output: Type.Optional(Type.Integer({ minimum: 0 })) }, strict);
export type TurnUsage = Static<typeof TurnUsage>;

/**
 * The shipped price table, public prices in USD per million tokens as of `SHIPPED_PRICES_DATE`. A row matches a model id by its pattern, first row first;
 * cacheWrite is the 5-minute premium where a provider charges one, and the input rate where it does not.
 */
export const SHIPPED_PRICES_DATE = '2026-11-28';
export const SHIPPED_PRICES: ReadonlyArray<{ label: string; pattern: string } & ModelRates> = [
  // Opus 5 is priced like Sonnet: Claude Code's own cost for two real claude-opus-5.5 turns fits these rates within 11% and fits the older Opus rates at 1.5 to 1.9 times too high.
  { label: 'Claude Opus 5 and later', pattern: 'opus[-_ ]?[5-9]', input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  { label: 'Claude Opus 4.5', pattern: 'opus[-_ ]?4[-_.]?[5-9]', input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  { label: 'Claude Opus', pattern: 'opus', input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  { label: 'Claude Sonnet', pattern: 'sonnet', input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  { label: 'Claude Haiku 3.5', pattern: 'haiku[-_ ]?3', input: 0.8, cacheWrite: 1, cacheRead: 0.08, output: 4 },
  { label: 'Claude Haiku', pattern: 'haiku', input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  { label: 'GPT-5 mini and Codex mini', pattern: 'gpt-5[^ ]*mini|codex[-_ ]?mini', input: 0.25, cacheWrite: 0.25, cacheRead: 0.025, output: 2 },
  { label: 'GPT-5 nano', pattern: 'gpt-5[^ ]*nano', input: 0.05, cacheWrite: 0.05, cacheRead: 0.005, output: 0.4 },
  { label: 'GPT-5 and Codex', pattern: 'gpt-5|codex', input: 1.25, cacheWrite: 1.25, cacheRead: 0.125, output: 10 },
  { label: 'GPT-4.1', pattern: 'gpt-4\\.1', input: 2, cacheWrite: 2, cacheRead: 0.5, output: 8 },
  { label: 'o-series', pattern: '^o[134]', input: 2, cacheWrite: 2, cacheRead: 0.5, output: 8 },
];
/** What a model without a row costs: the dearest shipped rates, so an unknown model never looks cheap. */
export const SHIPPED_DEFAULT_PRICE: ModelRates = { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 };

export interface PriceOf { rates: ModelRates; source: 'person' | 'shipped' | 'default' }
/** The rates of a model: the person's own row for its exact id, else the first shipped row it matches, else the default price. */
export function priceOf(model: string | undefined, settings: Pick<UnattendedSettings, 'prices' | 'defaultPrice'> = {}): PriceOf {
  if (model !== undefined) {
    const own = settings.prices?.[model];
    if (own) return { rates: own, source: 'person' };
    const row = SHIPPED_PRICES.find(item => new RegExp(item.pattern, 'i').test(model));
    if (row) return { rates: { input: row.input, cacheWrite: row.cacheWrite, cacheRead: row.cacheRead, output: row.output }, source: 'shipped' };
  }
  return { rates: settings.defaultPrice ?? SHIPPED_DEFAULT_PRICE, source: 'default' };
}
export interface Estimate { usd: number; tokens: number; flags: string[] }
/**
 * The ≈$ of one turn: each part at its own rate. Flags say where the estimate is soft: the model had no row, the provider gave only a total (priced as
 * input), reported no usage, or reported no cache writes for a model that charges more for them (so they sit in the input figure).
 */
export function estimateCost(usage: TurnUsage | undefined, total: number | undefined, settings: Pick<UnattendedSettings, 'prices' | 'defaultPrice'> = {}): Estimate {
  const flags: string[] = [], parts = usage && (usage.input !== undefined || usage.cachedInput !== undefined || usage.cacheCreation !== undefined || usage.output !== undefined);
  const { rates, source } = priceOf(usage?.model, settings);
  if (source === 'default') flags.push('price unknown');
  if (!parts) {
    if (!total) return { usd: 0, tokens: 0, flags: [...flags, 'no usage reported'] };
    return { usd: total * rates.input / 1e6, tokens: total, flags: [...flags, 'no breakdown'] };
  }
  if (usage!.cacheCreation === undefined && rates.cacheWrite > rates.input) flags.push('cache writes not reported');
  const input = usage!.input ?? 0, read = usage!.cachedInput ?? 0, write = usage!.cacheCreation ?? 0, output = usage!.output ?? 0;
  return { usd: (input * rates.input + write * rates.cacheWrite + read * rates.cacheRead + output * rates.output) / 1e6, tokens: input + read + write + output, flags };
}
/** The local day (`YYYY-MM-DD`) of an instant in a zone, the ledger's key. */
export function dayKey(instant: number, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

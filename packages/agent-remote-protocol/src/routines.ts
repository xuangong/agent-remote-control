/**
 * Routines (routines design 3): the work a bot does when its schedule says so, and what the Relay keeps of each run. A routine is stored
 * on the bot's inbox. Its due time is kept as `dueAt`, computed by `nextRun`; a run is one message to the bot's session, in a chain of
 * its own, and the routine keeps the last `ROUTINE_RUNS_KEPT` runs.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { RoutineSchedule } from './routine-schedule.js';

const strict = { additionalProperties: false } as const;
const time = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const ROUTINE_RUNS_KEPT = 20;
export const ROUTINES_PER_BOT = 20;
export const ROUTINE_PROMPT_LIMIT = 2000;
/** The most runs one routine starts in a day unless its own limit is lower: a bound of the system, not a budget. */
export const ROUTINE_RUNS_PER_DAY_LIMIT = 200;

/**
 * One run. dueAt: when the schedule said it was due. waiting: due and queued for the bot, not yet taken. running: taken, the chain's turns
 * have not ended. done and failed: the first turn ended (failed carries a reason). skipped: not started, with the reason (overlap, paused,
 * budget, provider limit, absence). missed: how many earlier due times this run stands for (the Host was away).
 */
export const RoutineRun = Type.Object({
  n: Type.Integer({ minimum: 1 }), trigger: Type.Union([Type.Literal('schedule'), Type.Literal('event'), Type.Literal('test')]), dueAt: time,
  state: Type.Union([Type.Literal('waiting'), Type.Literal('running'), Type.Literal('done'), Type.Literal('failed'), Type.Literal('skipped')]),
  startedAt: Type.Optional(time), endedAt: Type.Optional(time), reason: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })), chain: Type.Optional(Type.String({ pattern: '^c_[0-9a-f]{16}$' })),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), missed: Type.Optional(Type.Integer({ minimum: 1 })),
  /** What the run's chain used: tokens, the estimated cost in ≈$, and where the estimate is soft. */
  /** A run that goes to a sub-session and could not start yet (its Host is away): when the Relay last tried. */
  tried: Type.Optional(time),
  tokens: Type.Optional(count), usd: Type.Optional(Type.Number({ minimum: 0 })), flags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 6 })),
}, strict);
export type RoutineRun = Static<typeof RoutineRun>;

/**
 * A routine. by: who made it (the person, the bot itself, or the Relay for the work routine). work: the quiet routine the Relay keeps while the bot
 * has open board items. model: the model its runs use, the bot's own when empty. timeZone: where daily and weekdays times are read, the account's
 * when empty. anchor: when it began counting (for `every`). dueAt: the next time it is due; none for an event routine or a once routine that ran.
 * finished: a once routine that ran. missed: due times that passed while the bot could not be reached, delivered as one run.
 */
export const Routine = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 40 }), name: Type.String({ minLength: 1, maxLength: 60 }), prompt: Type.Optional(Type.String({ minLength: 1, maxLength: ROUTINE_PROMPT_LIMIT })),
  schedule: RoutineSchedule, by: Type.Union([Type.Literal('person'), Type.Literal('bot'), Type.Literal('system')]),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), timeZone: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  paused: Type.Optional(Type.Literal(true)), work: Type.Optional(Type.Literal(true)), finished: Type.Optional(Type.Literal(true)),
  anchor: time, dueAt: Type.Optional(time), endsAt: Type.Optional(time), missed: Type.Optional(Type.Integer({ minimum: 1 })),
  maxRunsPerDay: Type.Optional(Type.Integer({ minimum: 1, maximum: ROUTINE_RUNS_PER_DAY_LIMIT })),
  runCount: count, runs: Type.Array(RoutineRun, { maxItems: ROUTINE_RUNS_KEPT }),
}, strict);
export type Routine = Static<typeof Routine>;
export const isRoutine = (value: unknown): value is Routine => Value.Check(Routine, value);

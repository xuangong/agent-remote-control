import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { BoardItemEdit, BoardPlanEdit, BotId } from './bots.js';

/**
 * A chain is the work one cause set off (bots design 7): an input the person sent to a bot, a bot's timer coming due, or a bot's own
 * turn whose cause is not known. Every message between bots, bot created and turn that follows from it counts in the chain.
 */
const object = { additionalProperties: false } as const;
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const time = count;
export const ChainId = Type.String({ pattern: '^c_[0-9a-f]{16}$' });
export type ChainId = Static<typeof ChainId>;
/** The bots one chain names, and the chains an account keeps. */
export const CHAIN_BOT_LIMIT = 32;
export const CHAIN_LIMIT = 100;
export const CHAIN_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** The most standing approvals one chain holds. */
export const CHAIN_APPROVAL_LIMIT = 20;
/**
 * The choice a Controller adds to a bot's native tool approval, as a policy of the request: "for this chain in this folder". The person
 * choosing it allows the request once and records a standing approval in the chain (bots plan 9d).
 */
export const CHAIN_APPROVAL_POLICY = 'chain-folder';

/**
 * What started the turn a bot calls from, as its Host sees it: the person's input (its message id), or input the Relay framed, whose
 * chain the Relay knows from what it delivered.
 */
export const TurnCause = Type.Union([
  Type.Object({ kind: Type.Literal('person'), messageId: Type.String({ minLength: 1, maxLength: 256 }) }, object),
  // answers: the one message from another bot that started the turn, which is not itself a reply, so the turn's final text answers it (bots design 3.3).
  Type.Object({ kind: Type.Literal('framed'), answers: Type.Optional(Type.String({ pattern: '^m[0-9a-f]{12}$' })),
    // asked: the turn answers what the person asked from another conversation; its final text is the answer (bots design 3.3, plan 8b).
    asked: Type.Optional(Type.Literal(true)) }, object),
]);
export type TurnCause = Static<typeof TurnCause>;
export const ChainUsage = Type.Object({ tokens: count, costUsd: Type.Optional(Type.Number({ minimum: 0 })) }, object);
export type ChainUsage = Static<typeof ChainUsage>;

/**
 * What the person allowed for the rest of a chain: native tool approvals of any kind, from bots of the chain working in this directory,
 * are answered allow by their Controllers. at: when the person chose it. applied: how many requests it answered.
 */
export const StandingApproval = Type.Object({ cwd: Type.String({ minLength: 1, maxLength: 4096 }), at: time, applied: count }, object);
export type StandingApproval = Static<typeof StandingApproval>;

/**
 * One chain as the Relay keeps it. cause and bot: what started it and at which bot. bots: the bots it reached, in order. depth: the
 * longest run of replies along it. stopped: when the person stopped it.
 */
export const BotChain = Type.Object({ id: ChainId, cause: Type.Union([Type.Literal('person'), Type.Literal('timer'), Type.Literal('bot')]), bot: BotId,
  bots: Type.Array(BotId, { minItems: 1, maxItems: CHAIN_BOT_LIMIT }), messages: count, turns: count, created: count, subSessions: Type.Optional(count), depth: count, usage: ChainUsage,
  startedAt: time, updatedAt: time, stopped: Type.Optional(time),
  /** Bots whose part of the chain the person stopped. */
  stoppedBots: Type.Optional(Type.Array(BotId, { maxItems: CHAIN_BOT_LIMIT })),
  /** What the person allowed for this chain; it ends with the chain. */
  approvals: Type.Optional(Type.Array(StandingApproval, { maxItems: CHAIN_APPROVAL_LIMIT })),
  /** The person's thresholds this chain passed, each told to the person once. */
  passed: Type.Optional(Type.Array(Type.Union([Type.Literal('tokens'), Type.Literal('depth'), Type.Literal('minutes')]), { maxItems: 3, uniqueItems: true })) }, object);
export type BotChain = Static<typeof BotChain>;
export const isBotChain = (value: unknown): value is BotChain => Value.Check(BotChain, value);

/**
 * The person's thresholds for a chain (bots design 7): its usage in tokens, its reply depth, and how long it has run. Passing one
 * tells the person once, as a reminder that the chain's first bot needs them; nothing stops.
 */
export const ChainThresholds = Type.Object({ tokens: Type.Optional(Type.Integer({ minimum: 1 })), depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
  minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 7 * 24 * 60 })) }, object);
export type ChainThresholds = Static<typeof ChainThresholds>;
export const isChainThresholds = (value: unknown): value is ChainThresholds => Value.Check(ChainThresholds, value);

/**
 * What the person does from the audit (bots design 7). stop: the chain's waiting messages are withdrawn, its running turns stopped and
 * its sub-sessions' running turns interrupted; a bot's later call in it is refused. stop_bot: the same for one bot's part. pause_bot and resume_bot: a
 * standing bot's inbox holds its messages until resumed.  update_board: the person edits a standing bot's items and plan note. set_chief: a standing bot moves to another standing bot as its chief, or to the person (null).
 */
export const ChainAction = Type.Union([
  Type.Object({ action: Type.Literal('stop'), chainId: ChainId }, object),
  Type.Object({ action: Type.Literal('stop_bot'), chainId: ChainId, botId: BotId }, object),
  Type.Object({ action: Type.Literal('pause_bot'), botId: BotId }, object),
  Type.Object({ action: Type.Literal('resume_bot'), botId: BotId }, object),
  Type.Object({ action: Type.Literal('set_chief'), botId: BotId, chief: Type.Union([BotId, Type.Null()]) }, object),
  // The person writes a standing bot's board as the person; the bots the write changes are told, as when a bot writes it.
  Type.Object({ action: Type.Literal('update_board'), botId: BotId, items: Type.Optional(Type.Array(BoardItemEdit, { minItems: 1, maxItems: 10 })), plan: Type.Optional(BoardPlanEdit) }, object),
  Type.Object({ action: Type.Literal('set_thresholds'), thresholds: ChainThresholds }, object),
  Type.Object({ action: Type.Literal('revoke_approval'), chainId: ChainId, cwd: StandingApproval.properties.cwd }, object),
]);
export type ChainAction = Static<typeof ChainAction>;
export const isChainAction = (value: unknown): value is ChainAction => Value.Check(ChainAction, value);
/** The audit's view: the account's chains, newest first, the names of their bots, and which standing bots are paused. */
export interface ChainView { chains: BotChain[]; names: Record<string, string>; paused: string[]; thresholds: ChainThresholds }

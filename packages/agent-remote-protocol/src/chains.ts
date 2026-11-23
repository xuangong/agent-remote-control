import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { BotId } from './bots.js';

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

/**
 * What started the turn a bot calls from, as its Host sees it: the person's input (its message id), or input the Relay framed, whose
 * chain the Relay knows from what it delivered.
 */
export const TurnCause = Type.Union([
  Type.Object({ kind: Type.Literal('person'), messageId: Type.String({ minLength: 1, maxLength: 256 }) }, object),
  Type.Object({ kind: Type.Literal('framed') }, object),
]);
export type TurnCause = Static<typeof TurnCause>;
export const ChainUsage = Type.Object({ tokens: count, costUsd: Type.Optional(Type.Number({ minimum: 0 })) }, object);
export type ChainUsage = Static<typeof ChainUsage>;

/**
 * One chain as the Relay keeps it. cause and bot: what started it and at which bot. bots: the bots it reached, in order. depth: the
 * longest run of replies along it. stopped: when the person stopped it.
 */
export const BotChain = Type.Object({ id: ChainId, cause: Type.Union([Type.Literal('person'), Type.Literal('timer'), Type.Literal('bot')]), bot: BotId,
  bots: Type.Array(BotId, { minItems: 1, maxItems: CHAIN_BOT_LIMIT }), messages: count, turns: count, created: count, depth: count, usage: ChainUsage,
  startedAt: time, updatedAt: time, stopped: Type.Optional(time),
  /** Bots whose part of the chain the person stopped. */
  stoppedBots: Type.Optional(Type.Array(BotId, { maxItems: CHAIN_BOT_LIMIT })) }, object);
export type BotChain = Static<typeof BotChain>;
export const isBotChain = (value: unknown): value is BotChain => Value.Check(BotChain, value);

/**
 * What the person does from the audit (bots design 7). stop: the chain's waiting messages are withdrawn, its running turns stopped and
 * its temporary bots stopped; a bot's later call in it is refused. stop_bot: the same for one bot's part. pause_bot and resume_bot: a
 * standing bot's inbox holds its messages until resumed. retire_bot: a temporary bot ends, what it did standing as its result.
 */
export const ChainAction = Type.Union([
  Type.Object({ action: Type.Literal('stop'), chainId: ChainId }, object),
  Type.Object({ action: Type.Literal('stop_bot'), chainId: ChainId, botId: BotId }, object),
  Type.Object({ action: Type.Literal('pause_bot'), botId: BotId }, object),
  Type.Object({ action: Type.Literal('resume_bot'), botId: BotId }, object),
  Type.Object({ action: Type.Literal('retire_bot'), botId: BotId }, object),
]);
export type ChainAction = Static<typeof ChainAction>;
export const isChainAction = (value: unknown): value is ChainAction => Value.Check(ChainAction, value);
/** The audit's view: the account's chains, newest first, the names of their bots, and which standing bots are paused. */
export interface ChainView { chains: BotChain[]; names: Record<string, string>; paused: string[] }

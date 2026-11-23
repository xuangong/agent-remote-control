import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const strict = { additionalProperties: false } as const;
const time = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

/** A bot's picture: a shape, a colour and which of six directions it looks (0 to 5; omitted means the default look). */
export const BotPicture = Type.Object({
  shape: Type.Union([Type.Literal('circle'), Type.Literal('squircle'), Type.Literal('triangle'), Type.Literal('sideways')]),
  color: Type.String({ pattern: '^#[0-9a-f]{6}$' }),
  gaze: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
}, strict);
export type BotPicture = Static<typeof BotPicture>;
/** A stored picture in the current form: older rows hold `rounded` or `hexagon`, which read as `squircle` with the same colour; an invalid picture reads as none. */
export function readBotPicture(stored: unknown): BotPicture | undefined {
  if (!stored || typeof stored !== 'object') return undefined;
  const picture = stored as { shape?: unknown };
  const current = picture.shape === 'rounded' || picture.shape === 'hexagon' ? { ...picture, shape: 'squircle' } : picture;
  return Value.Check(BotPicture, current) ? current : undefined;
}

/** A bot's id: stable across handoffs and moves between groups. */
export const BotId = Type.String({ pattern: '^b_[0-9a-f]{32}$' });
export const BOT_MISSION_LIMIT = 4000;
/** What a bot is for and how it sees its place; its standing instructions after the base instructions. */
export const BotMission = Type.String({ minLength: 1, maxLength: BOT_MISSION_LIMIT });
export const BotName = Type.String({ minLength: 1, maxLength: 60 });
export const BotLabel = Type.String({ minLength: 1, maxLength: 120 });

/**
 * One bot of an account, kept by the Relay (bots design 2.1). Its placement in Bot mode and Windows stays in the groups, which refer
 * to it by `botId`. `retiredAt`: it left every group, or its work ended; a retired bot is unreachable.
 */
export const BotRecord = Type.Object({
  botId: BotId,
  name: Type.Optional(BotName),
  label: Type.Optional(BotLabel),
  picture: Type.Optional(BotPicture),
  mission: Type.Optional(BotMission),
  organizer: Type.Union([Type.Object({ kind: Type.Literal('person') }, strict), Type.Object({ kind: Type.Literal('bot'), botId: BotId }, strict)]),
  lifetime: Type.Union([Type.Literal('standing'), Type.Literal('temporary')]),
  createdAt: time,
  updatedAt: time,
  retiredAt: Type.Optional(time),
}, strict);
export type BotRecord = Static<typeof BotRecord>;
export const isBotRecord = (value: unknown): value is BotRecord => Value.Check(BotRecord, value);

/** The bot details fields that belong to the bot rather than to its place in a group. */
export const BOT_IDENTITY_FIELDS = ['name', 'label', 'picture', 'mission'] as const;
type IdentityField = typeof BOT_IDENTITY_FIELDS[number];
export type BotIdentity = Partial<Pick<BotRecord, IdentityField>>;

/** The identity part of bot details, as the bot's record keeps it. */
export function botIdentity<T extends BotIdentity>(details: T): BotIdentity {
  return Object.fromEntries(BOT_IDENTITY_FIELDS.filter(key => details[key] !== undefined).map(key => [key, details[key]])) as BotIdentity;
}
/** The placement part of bot details, as the group keeps it: everything but identity. */
export function botPlacement<T extends BotIdentity>(details: T): Omit<T, IdentityField> {
  const placement = { ...details } as T;
  for (const key of BOT_IDENTITY_FIELDS) delete placement[key];
  return placement;
}

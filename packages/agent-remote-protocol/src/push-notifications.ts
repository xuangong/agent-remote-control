/**
 * Web Push reminders (I5c, owner decisions of 2026-11-22): the Relay pushes two reminders to the devices an account subscribed, and
 * nothing else. An assistant needs the person (`needs_you`), or finished a turn while no page of the account showed it (`finished`).
 * - A device subscribes once from Settings > Assistants ("Notify me on this device"): `PushSubscriptionRequest` to
 *   `POST /v1/push-subscriptions`, which keeps one subscription per device and account; `DELETE` forgets it, and so do sign-out, a
 *   revoked browser and a push service's 404 or 410. `GET` says whether the Relay sends pushes (its VAPID public key) and what it keeps
 *   of this device (`PushDevice`).
 * - The payload is `PushReminder` (push-reminder.ts, which a service worker reads without a schema library); `PushReminderSchema` is
 *   the same contract as a schema.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/** The most devices one account keeps subscribed; a new one beyond it replaces the account's least recently updated. */
export const PUSH_DEVICE_LIMIT = 16;

const strict = { additionalProperties: false } as const;
const PushLocaleSchema = Type.Union([Type.Literal('en'), Type.Literal('zh')]);
const endpoint = Type.String({ minLength: 12, maxLength: 2048, pattern: '^https?://[^\\s]+$' });
/** The keys a browser hands out with its subscription: its P-256 public key (65 bytes) and its 16-byte auth secret, base64url. */
export const PushSubscriptionKeys = Type.Object({ p256dh: Type.String({ pattern: '^[A-Za-z0-9_-]{87}$' }), auth: Type.String({ pattern: '^[A-Za-z0-9_-]{22}$' }) }, strict);

/**
 * This device's subscription as the browser gave it (`PushSubscription.toJSON()`), the language its reminders speak, and `paused`
 * while the device's own Notifications switch is off.
 */
export const PushSubscriptionRequest = Type.Object({ endpoint, keys: PushSubscriptionKeys, locale: PushLocaleSchema, paused: Type.Optional(Type.Literal(true)) }, strict);
export type PushSubscriptionRequest = Static<typeof PushSubscriptionRequest>;
/** What the Relay keeps of this device's subscription. */
export const PushDeviceSubscription = Type.Object({ endpoint, locale: PushLocaleSchema, paused: Type.Optional(Type.Literal(true)) }, strict);
export type PushDeviceSubscription = Static<typeof PushDeviceSubscription>;
/** `GET /v1/push-subscriptions`: the key to subscribe with, absent when the Relay sends no pushes, and this device's subscription. */
export const PushDevice = Type.Object({ publicKey: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_-]{87}$' })), device: Type.Optional(PushDeviceSubscription) }, strict);
export type PushDevice = Static<typeof PushDevice>;

/** `PushReminder` as a schema: the payload of a reminder. */
export const PushReminderSchema = Type.Object({
  v: Type.Literal(1),
  kind: Type.Union([Type.Literal('needs_you'), Type.Literal('finished')]),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  locale: PushLocaleSchema,
  url: Type.String({ minLength: 2, maxLength: 1024, pattern: '^/\\?[^\\s]*$' }),
  tag: Type.String({ pattern: '^[A-Za-z0-9_-]{1,32}$' }),
  at: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
}, strict);

export const isPushSubscriptionRequest = (value: unknown): value is PushSubscriptionRequest => Value.Check(PushSubscriptionRequest, value);
export const isPushDevice = (value: unknown): value is PushDevice => Value.Check(PushDevice, value);

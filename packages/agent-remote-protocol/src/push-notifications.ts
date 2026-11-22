/**
 * Web Push reminders (I5c, owner decisions of 2026-11-22): the Relay pushes two reminders to the devices an account subscribed, and
 * nothing else. An assistant needs the person (`needs_you`), or finished a turn while no page of the account showed it (`finished`).
 * - A device subscribes once from Settings > Assistants ("Notify me on this device"): `PushSubscriptionRequest` to
 *   `POST /v1/push-subscriptions`, which keeps one subscription per device and account; `DELETE` forgets it, and so do sign-out, a
 *   revoked browser and a push service's 404 or 410. `GET` says whether the Relay sends pushes (its VAPID public key) and what it keeps
 *   of this device (`PushDevice`).
 * - The payload (`PushReminder`) carries the assistant's name and the reminder's kind, and what the service worker needs to show and
 *   route it: the device's language, the conversation's address, the tag that collapses one session's reminders and when the Relay
 *   decided it. Never conversation text: a push service sees only names and identifiers.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { AssistantReminder } from './window-groups.js';

export const PUSH_REMINDER_KINDS = ['needs_you', 'finished'] as const;
export type PushReminderKind = typeof PUSH_REMINDER_KINDS[number];

/** The push a page's reminder is: waiting for the person is "needs you", a finished turn is "finished". */
export const pushReminderKind = (reminder: AssistantReminder): PushReminderKind => reminder === 'waiting' ? 'needs_you' : 'finished';

/** How long a push service holds a reminder for a device that is offline, in seconds: a need waits a day, a finished turn six hours. */
export const PUSH_REMINDER_TTL_SECONDS: Readonly<Record<PushReminderKind, number>> = { needs_you: 24 * 3600, finished: 6 * 3600 };
/** How soon a push service delivers it (RFC 8030 `Urgency`): a need at once, a finished turn as the device's battery allows. */
export const PUSH_REMINDER_URGENCY: Readonly<Record<PushReminderKind, 'high' | 'normal'>> = { needs_you: 'high', finished: 'normal' };
/** The most devices one account keeps subscribed; a new one beyond it replaces the account's least recently updated. */
export const PUSH_DEVICE_LIMIT = 16;

const strict = { additionalProperties: false } as const;
const PushLocale = Type.Union([Type.Literal('en'), Type.Literal('zh')]);
export type PushLocale = Static<typeof PushLocale>;
const endpoint = Type.String({ minLength: 12, maxLength: 2048, pattern: '^https?://[^\\s]+$' });
/** The keys a browser hands out with its subscription: its P-256 public key (65 bytes) and its 16-byte auth secret, base64url. */
export const PushSubscriptionKeys = Type.Object({ p256dh: Type.String({ pattern: '^[A-Za-z0-9_-]{87}$' }), auth: Type.String({ pattern: '^[A-Za-z0-9_-]{22}$' }) }, strict);

/**
 * This device's subscription as the browser gave it (`PushSubscription.toJSON()`), the language its reminders speak, and `paused`
 * while the device's own Notifications switch is off.
 */
export const PushSubscriptionRequest = Type.Object({ endpoint, keys: PushSubscriptionKeys, locale: PushLocale, paused: Type.Optional(Type.Literal(true)) }, strict);
export type PushSubscriptionRequest = Static<typeof PushSubscriptionRequest>;
/** What the Relay keeps of this device's subscription. */
export const PushDeviceSubscription = Type.Object({ endpoint, locale: PushLocale, paused: Type.Optional(Type.Literal(true)) }, strict);
export type PushDeviceSubscription = Static<typeof PushDeviceSubscription>;
/** `GET /v1/push-subscriptions`: the key to subscribe with, absent when the Relay sends no pushes, and this device's subscription. */
export const PushDevice = Type.Object({ publicKey: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_-]{87}$' })), device: Type.Optional(PushDeviceSubscription) }, strict);
export type PushDevice = Static<typeof PushDevice>;

/** The payload of a reminder, as the service worker reads it. */
export const PushReminder = Type.Object({
  v: Type.Literal(1),
  kind: Type.Union([Type.Literal('needs_you'), Type.Literal('finished')]),
  /** The assistant's name: its own, or the one every device calls it by. */
  name: Type.String({ minLength: 1, maxLength: 80 }),
  locale: PushLocale,
  /** The conversation's address on the site, such as `/?mode=bot&section=…&bot=…`. */
  url: Type.String({ minLength: 2, maxLength: 1024, pattern: '^/\\?[^\\s]*$' }),
  /** One per session: a newer reminder of the session replaces the older, at the push service (`Topic`) and on the screen. */
  tag: Type.String({ pattern: '^[A-Za-z0-9_-]{1,32}$' }),
  /** When the Relay decided it, in milliseconds: of two reminders of one session that arrive out of order, the later stays. */
  at: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
}, strict);
export type PushReminder = Static<typeof PushReminder>;

export const isPushSubscriptionRequest = (value: unknown): value is PushSubscriptionRequest => Value.Check(PushSubscriptionRequest, value);
export const isPushDevice = (value: unknown): value is PushDevice => Value.Check(PushDevice, value);
export const encodePushReminder = (reminder: PushReminder): string => JSON.stringify(reminder);
/** A reminder from a push's text, or undefined for anything else. */
export function decodePushReminder(text: string | undefined | null): PushReminder | undefined {
  if (!text) return undefined;
  try { const value: unknown = JSON.parse(text); return Value.Check(PushReminder, value) ? value : undefined; } catch { return undefined; }
}

/** The tag of a session's reminders: the same for every reminder of one session, from its identity, 17 base64url characters. */
export function pushTag(session: { readonly hostId: string; readonly providerId: string; readonly nativeSessionId: string }): string {
  const text = JSON.stringify([session.hostId, session.providerId, session.nativeSessionId]);
  const hash = (seed: number) => {
    let value = seed;
    for (let index = 0; index < text.length; index += 1) { value ^= text.charCodeAt(index); value = Math.imul(value, 0x01000193) >>> 0; }
    return value.toString(16).padStart(8, '0');
  };
  return `s${hash(0x811c9dc5)}${hash(0x2f8b6e1d)}`;
}

/** The address of an assistant's conversation in Bot mode, as the page writes it. */
export function assistantAddress(groupId: string, viewId: string): string {
  return `/?${new URLSearchParams({ mode: 'bot', section: groupId, bot: viewId })}`;
}

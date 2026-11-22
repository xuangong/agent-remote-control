/**
 * A push reminder's payload (I5c), as the Relay writes it and a service worker reads it: the assistant's name and the reminder's kind,
 * and what the worker needs to show and route it: the device's language, the conversation's address, the tag that collapses one
 * session's reminders and when the Relay decided it. Never conversation text: a push service sees only names and identifiers.
 * This module has no schema library, so a service worker reads it without one; `PushReminderSchema` (push-notifications.ts) is the
 * same contract as a schema, and a test keeps the two equal.
 */
import type { AssistantReminder } from './window-groups.js';

export const PUSH_REMINDER_KINDS = ['needs_you', 'finished'] as const;
export type PushReminderKind = typeof PUSH_REMINDER_KINDS[number];
export type PushLocale = 'en' | 'zh';

export interface PushReminder {
  readonly v: 1;
  readonly kind: PushReminderKind;
  /** The assistant's name: its own, or the one every device calls it by; 1 to 80 characters. */
  readonly name: string;
  readonly locale: PushLocale;
  /** The conversation's address on the site, such as `/?mode=bot&section=…&bot=…`; at most 1024 characters. */
  readonly url: string;
  /** One per session, up to 32 base64url characters: a newer reminder of the session replaces the older, at the push service and on screen. */
  readonly tag: string;
  /** When the Relay decided it, in milliseconds: of two reminders of one session that arrive out of order, the later stays. */
  readonly at: number;
}

/** The push a page's reminder is: waiting for the person is "needs you", a finished turn is "finished". */
export const pushReminderKind = (reminder: AssistantReminder): PushReminderKind => reminder === 'waiting' ? 'needs_you' : 'finished';
/** How long a push service holds a reminder for a device that is offline, in seconds: a need waits a day, a finished turn six hours. */
export const PUSH_REMINDER_TTL_SECONDS: Readonly<Record<PushReminderKind, number>> = { needs_you: 24 * 3600, finished: 6 * 3600 };
/** How soon a push service delivers it (RFC 8030 `Urgency`): a need at once, a finished turn as the device's battery allows. */
export const PUSH_REMINDER_URGENCY: Readonly<Record<PushReminderKind, 'high' | 'normal'>> = { needs_you: 'high', finished: 'normal' };

const REMINDER_FIELDS = ['v', 'kind', 'name', 'locale', 'url', 'tag', 'at'];
export const encodePushReminder = (reminder: PushReminder): string => JSON.stringify(reminder);
/** A reminder from a push's text, or undefined for anything else. */
export function decodePushReminder(text: string | undefined | null): PushReminder | undefined {
  if (!text) return undefined;
  let value: Record<string, unknown>;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !REMINDER_FIELDS.includes(key))) return undefined;
  const { v, kind, name, locale, url, tag, at } = value;
  const valid = v === 1 && (kind === 'needs_you' || kind === 'finished') && typeof name === 'string' && name.length >= 1 && name.length <= 80
    && (locale === 'en' || locale === 'zh') && typeof url === 'string' && url.length >= 2 && url.length <= 1024 && /^\/\?[^\s]*$/.test(url)
    && typeof tag === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(tag) && typeof at === 'number' && Number.isSafeInteger(at) && at >= 0;
  return valid ? value as unknown as PushReminder : undefined;
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

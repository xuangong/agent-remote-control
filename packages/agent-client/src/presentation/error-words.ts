/**
 * The words of an error made for a person: the one way the client, the Session View and the Lab make and show them. A thrown
 * error carries its English `message` and, beside it, the catalogue `messageKey` (and `messageParams`): `keyedError(key)` makes
 * one, `withMessageKey(error, key)` marks one that exists. The place that shows it says `errorWords(error, t, fallback)`. A
 * message the client stored as text (a pending message's error, a settlement failure, an activity notice) is found again by
 * its English with `storedWords`. What the Relay or a Controller sent is data: it has no key and stays as sent.
 */
import { messageCatalogue, translator, type MessageKey, type MessageParams, type Translate } from './messages.js';
import { withMessageKey } from './locale-choice.js';

export { withMessageKey, type MessageKeyed } from './locale-choice.js';
import type { MessageKeyed } from './locale-choice.js';

let storedKeys: ReadonlyMap<string, MessageKey> | undefined;
/** The `client.*` messages without placeholders, by their English text. */
function storedKeyOf(text: string): MessageKey | undefined {
  if (!storedKeys) {
    const keys = new Map<string, MessageKey>();
    for (const [key, message] of Object.entries(messageCatalogue('en')) as [MessageKey, string | { other: string }][]) {
      if (key.startsWith('client.') && typeof message === 'string' && !message.includes('{')) keys.set(message, key);
    }
    storedKeys = keys;
  }
  return storedKeys.get(text);
}

/** A stored English message in the locale's words; any other text (from the Relay, a Controller or a person) as it is. */
export function storedWords(text: string, t: Translate): string {
  const key = storedKeyOf(text);
  return key ? t(key) : text;
}

/** An error made for a person: its English words from the catalogue as `message`, and its key and params for the reader's language. */
export function keyedError(key: MessageKey, params?: MessageParams): Error & MessageKeyed {
  return withMessageKey(new Error(translator('en')(key, params)), key, params);
}

/**
 * What to show for an error: its catalogue words when it has a key, else its message (found again by its English when the client
 * stored it), else the fallback's words. Anything with a `message` counts as an error, so a `DOMException` or an error from another
 * realm reads the same; a thrown string or other value has no words for a person.
 */
export function errorWords(error: unknown, t: Translate, fallback?: MessageKey): string {
  const { messageKey, messageParams, message } = (error ?? {}) as MessageKeyed & { message?: unknown };
  if (messageKey) return t(messageKey, messageParams);
  if (typeof message === 'string' && message.trim()) return storedWords(message, t);
  return fallback ? t(fallback) : '';
}

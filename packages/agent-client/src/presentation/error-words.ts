/**
 * The words of an error the client made for a person. A thrown error carries its English `message` and, beside it, the
 * catalogue `messageKey` (and `messageParams`); the place that shows it says `errorWords(error, t)`. A message the client
 * stored as text (a pending message's error, a settlement failure, an activity notice) is found again by its English with
 * `storedWords`. What the Relay or a Controller sent is data: it has no key and stays as sent.
 */
import { messageCatalogue, type MessageKey, type MessageParams, type Translate } from './messages.js';

export interface MessageKeyed {
  readonly messageKey?: MessageKey;
  readonly messageParams?: MessageParams;
}

/** Marks an error with the catalogue key of its message; the error is returned so a throw site stays one expression. */
export function withMessageKey<E extends Error>(error: E, key: MessageKey, params?: MessageParams): E {
  return Object.assign(error, params === undefined ? { messageKey: key } : { messageKey: key, messageParams: params });
}

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

/** What to show for an error: its catalogue words when it has a key, else its stored message found by its English, else its message. */
export function errorWords(error: unknown, t: Translate): string {
  if (!(error instanceof Error)) return typeof error === 'string' ? storedWords(error, t) : '';
  const { messageKey, messageParams } = error as Error & MessageKeyed;
  return messageKey ? t(messageKey, messageParams) : storedWords(error.message, t);
}

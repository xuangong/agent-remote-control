import type { MessageKey, Translate } from '@orchardworks/agent-client';

/** An error made for a person: its English words, and the catalogue key the page that shows it reads instead. */
export interface LocalizedError extends Error { readonly messageKey?: MessageKey }

/** An error with its English message and the catalogue key of the same words. */
export function localizedError(message: string, messageKey: MessageKey): LocalizedError {
  return Object.assign(new Error(message), { messageKey });
}

/** The words of an error in the reader's language: its catalogue key when it has one, its own message, or the fallback. */
export function errorWords(reason: unknown, t: Translate, fallback: MessageKey): string {
  if (reason instanceof Error) {
    const key = (reason as LocalizedError).messageKey;
    if (key) return t(key);
    if (reason.message) return reason.message;
  }
  return t(fallback);
}

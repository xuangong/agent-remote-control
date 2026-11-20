import { errorWords, type MessageKey, type Translate } from '@orchardworks/agent-client';

/** An error made for a person: its English words, and the catalogue key the page that shows it reads instead. */
export interface LocalizedError extends Error { readonly messageKey?: MessageKey }

/** An error with its English message and the catalogue key of the same words. */
export function localizedError(message: string, messageKey: MessageKey): LocalizedError {
  return Object.assign(new Error(message), { messageKey });
}

/** The words of an error in the reader's language, or the fallback's when the error has none. */
export function errorWordsOr(reason: unknown, t: Translate, fallback: MessageKey): string {
  if (!(reason instanceof Error) || !reason.message.trim() && !(reason as LocalizedError).messageKey) return t(fallback);
  return errorWords(reason, t) || t(fallback);
}

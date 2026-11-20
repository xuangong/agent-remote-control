import { translator, type MessageKey, type MessageParams, type Translate } from '@orchardworks/agent-client';

/** An error whose words a person reads: its English `message` is for logs and tests, `messageKey` for the page's language. */
export class WindowFailure extends Error {
  constructor(readonly messageKey: MessageKey, readonly messageParams?: MessageParams) {
    super(translator('en')(messageKey, messageParams));
  }
}

/**
 * The words of an error in the page's language: its catalogue key when it has one (a `WindowFailure`, or any error the client
 * marked the same way), else its own message (a Relay's answer, a browser's), else the fallback.
 */
export function errorWords(error: unknown, t: Translate, fallback?: MessageKey): string {
  const keyed = error as { messageKey?: MessageKey; messageParams?: MessageParams } | null | undefined;
  if (keyed?.messageKey) return t(keyed.messageKey, keyed.messageParams);
  const own = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof own === 'string' && own) return own;
  return fallback && error instanceof Error ? t(fallback) : String(error);
}

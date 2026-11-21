/**
 * Native events an adapter does not know (gap 10 of `docs/superpowers/specs/2026-11-21-requirements-vs-external-dependencies.md`). One
 * rule for every adapter:
 * - U1 An event, notification, message, record or item of a kind the adapter does not know, or of a known kind whose shape it cannot read,
 *   becomes one diagnostic, reported through the adapter's diagnostic sink. It is never a timeline row, so a CLI update never puts a row
 *   the person cannot act on into a conversation, and a reread never replaces a journal for it.
 * - U2 Nothing a CLI sends is dropped without that diagnostic: every kind the adapter ignores on purpose is a kind it knows, listed with
 *   the native release it was written against.
 * - U3 The diagnostic names the provider, the kind (at most 128 characters), whether it came live or in a read of history, and why; it
 *   carries none of the event's content. The Controller counts them and reports them in its health.
 *
 * Pure: no clock, no I/O.
 */
export const UNKNOWN_NATIVE_EVENT = 'native_event_unknown';

export interface UnknownNativeEvent {
  readonly event: typeof UNKNOWN_NATIVE_EVENT;
  readonly providerId: string;
  /** The kind the CLI named: a notification method, a message or record type, an item type. */
  readonly kind: string;
  readonly delivery: 'live' | 'history';
  /** `unknown_kind`: the adapter does not know the kind; `unreadable`: it knows the kind and cannot read this one. */
  readonly reason: 'unknown_kind' | 'unreadable';
}

const KIND_MAX = 128;

/** U3: the diagnostic line an adapter reports for a native event it does not know. */
export function unknownNativeEventLine(providerId: string, kind: unknown, delivery: 'live' | 'history', reason: UnknownNativeEvent['reason'] = 'unknown_kind'): string {
  const named = typeof kind === 'string' && kind.length > 0 ? kind.slice(0, KIND_MAX) : '(unnamed)';
  return JSON.stringify({ event: UNKNOWN_NATIVE_EVENT, providerId, kind: named, delivery, reason } satisfies UnknownNativeEvent);
}

/** The unknown native event a diagnostic line reports, or undefined for any other line. */
export function readUnknownNativeEvent(line: string): UnknownNativeEvent | undefined {
  if (!line.includes(UNKNOWN_NATIVE_EVENT)) return undefined;
  try {
    const value = JSON.parse(line) as Partial<UnknownNativeEvent>;
    if (value.event !== UNKNOWN_NATIVE_EVENT || typeof value.providerId !== 'string' || typeof value.kind !== 'string') return undefined;
    if (value.delivery !== 'live' && value.delivery !== 'history') return undefined;
    if (value.reason !== 'unknown_kind' && value.reason !== 'unreadable') return undefined;
    return { event: UNKNOWN_NATIVE_EVENT, providerId: value.providerId, kind: value.kind.slice(0, KIND_MAX), delivery: value.delivery, reason: value.reason };
  } catch { return undefined; }
}

export interface DshNativeObservation {
  readonly recordId: string;
  readonly occurredAt: number;
  readonly kind: 'session_event' | 'interaction_requested' | 'interaction_resolved';
  readonly payload: unknown;
}

export type NativeRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is NativeRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function safeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function nativeEvent(input: DshNativeObservation): { type?: string; data: NativeRecord | undefined } {
  if (!isRecord(input.payload)) return { data: undefined };
  const type = nonEmptyString(input.payload.type);
  const data = isRecord(input.payload.data) ? input.payload.data : input.payload;
  return { type, data };
}

export function dshIdentifier(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return nonEmptyString(value);
}

export function dshProviderSourceKey(sessionId: string, input: DshNativeObservation): string {
  return `dsh:${sourceKeyPart(sessionId)}:${sourceKeyPart(input.recordId)}`;
}

function sourceKeyPart(value: string): string {
  return `${value.length}:${value}`;
}

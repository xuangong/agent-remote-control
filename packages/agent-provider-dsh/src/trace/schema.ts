import type { DshNativeObservation } from '../native.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function cloneJsonData(value: unknown): JsonValue {
  if (!isJsonDataValue(value)) throw new Error('Recorded DSH payloads must be JSON data values.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(cloneJsonData);
  const copy = Object.create(null) as Record<string, JsonValue>;
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(copy, key, { value: cloneJsonData(entry), enumerable: true, writable: true, configurable: true });
  }
  return copy;
}

export function isJsonDataValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return isJsonDataArray(value);
  if (!isJsonDataObject(value)) return false;
  return Object.values(value).every(isJsonDataValue);
}

function isJsonDataArray(value: unknown[]): boolean {
  if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) return false;
  if (Object.getOwnPropertyNames(value).length !== value.length + 1) return false;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !('value' in lengthDescriptor)) return false;
  if (lengthDescriptor.value !== value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || !isJsonDataValue(descriptor.value)) return false;
  }
  return true;
}

export function isJsonDataObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => descriptor.enumerable && 'value' in descriptor);
}

export interface DshTraceRuntimeInfo {
  status: 'idle' | 'running' | 'waiting' | 'stopped' | 'failed';
  cwd?: string;
  model?: {
    id: string;
    displayName?: string;
    provider?: string;
    reasoningEffort?: string;
  };
}

export interface DshTraceHeader {
  type: 'trace_header';
  format: 'borgee.dsh.trace.v1';
  sessionId: string;
  nativeSessionHeader: JsonValue;
  runtimeInfo: DshTraceRuntimeInfo;
}

export interface DshTraceNativeRecord {
  type: 'native_record';
  ordinal: number;
  offset: number;
  recordId: string;
  kind: DshNativeObservation['kind'];
  payload: JsonValue;
}

export interface DshTrace {
  header: DshTraceHeader;
  records: DshTraceNativeRecord[];
}

export const dshTraceFormat = 'borgee.dsh.trace.v1' as const;

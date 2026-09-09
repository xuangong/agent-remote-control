import { dshTraceFormat, isJsonDataObject, isJsonDataValue, type DshTrace, type DshTraceHeader, type DshTraceNativeRecord, type DshTraceRuntimeInfo, type JsonValue } from './schema.js';

export class DshTraceCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DshTraceCodecError';
  }
}

export function encodeDshTrace(trace: DshTrace): string {
  validateTrace(trace);
  return [trace.header, ...trace.records].map((line) => JSON.stringify(line)).join('\n') + '\n';
}

export function decodeDshTrace(input: string): DshTrace {
  if (input.length === 0 || !input.endsWith('\n')) throw new DshTraceCodecError('DSH trace is truncated or empty.');
  const lines = input.slice(0, -1).split('\n');
  if (lines.some((line) => line.length === 0)) throw new DshTraceCodecError('DSH trace contains an empty line.');
  const values = lines.map((line, index) => parseLine(line, index + 1));
  const header = readHeader(values[0]);
  const records = values.slice(1).map(readNativeRecord);
  const trace = { header, records };
  validateTrace(trace);
  return trace;
}

function parseLine(line: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new DshTraceCodecError(`DSH trace line ${lineNumber} is not valid JSON.`);
  }
}

function readHeader(value: unknown): DshTraceHeader {
  if (!isJsonDataObject(value) || value.type !== 'trace_header') throw new DshTraceCodecError('DSH trace must begin with a trace_header.');
  const header: DshTraceHeader = {
    type: 'trace_header',
    format: expectLiteral(value.format, dshTraceFormat, 'trace header format'),
    sessionId: expectNonEmptyString(value.sessionId, 'trace header sessionId'),
    nativeSessionHeader: expectJson(value.nativeSessionHeader, 'trace header nativeSessionHeader'),
    runtimeInfo: readRuntimeInfo(value.runtimeInfo),
  };
  return header;
}

function readNativeRecord(value: unknown): DshTraceNativeRecord {
  if (!isJsonDataObject(value) || value.type !== 'native_record') throw new DshTraceCodecError('DSH trace entries after the header must be native_record values.');
  return {
    type: 'native_record',
    ordinal: expectNonNegativeInteger(value.ordinal, 'native record ordinal'),
    offset: expectNonNegativeInteger(value.offset, 'native record offset'),
    recordId: expectNonEmptyString(value.recordId, 'native record recordId'),
    kind: readNativeKind(value.kind),
    payload: expectJson(value.payload, 'native record payload'),
  };
}

function validateTrace(trace: DshTrace): void {
  readHeader(trace.header);
  let previousOrdinal = 0;
  let previousOffset = 0;
  for (const record of trace.records) {
    const parsed = readNativeRecord(record);
    if (parsed.ordinal !== previousOrdinal + 1) throw new DshTraceCodecError('DSH trace native record ordinals must increase by one.');
    if (parsed.offset < previousOffset) throw new DshTraceCodecError('DSH trace native record offsets must not regress.');
    previousOrdinal = parsed.ordinal;
    previousOffset = parsed.offset;
  }
}

function readRuntimeInfo(value: unknown): DshTraceRuntimeInfo {
  if (!isJsonDataObject(value)) throw new DshTraceCodecError('trace header runtimeInfo must be an object.');
  const status = value.status;
  if (status !== 'idle' && status !== 'running' && status !== 'waiting' && status !== 'stopped' && status !== 'failed') {
    throw new DshTraceCodecError('trace header runtimeInfo.status is invalid.');
  }
  const cwd = value.cwd;
  if (cwd !== undefined && typeof cwd !== 'string') throw new DshTraceCodecError('trace header runtimeInfo.cwd must be a string.');
  const model = value.model === undefined ? undefined : readModelInfo(value.model);
  return { status, ...(cwd === undefined ? {} : { cwd }), ...(model === undefined ? {} : { model }) };
}

function readModelInfo(value: unknown): NonNullable<DshTraceRuntimeInfo['model']> {
  if (!isJsonDataObject(value)) throw new DshTraceCodecError('trace header runtimeInfo.model must be an object.');
  const id = expectNonEmptyString(value.id, 'trace header runtimeInfo.model.id');
  const optional = ['displayName', 'provider', 'reasoningEffort'] as const;
  const fields: Partial<NonNullable<DshTraceRuntimeInfo['model']>> = { id };
  for (const field of optional) {
    const fieldValue = value[field];
    if (fieldValue === undefined) continue;
    if (typeof fieldValue !== 'string') throw new DshTraceCodecError(`trace header runtimeInfo.model.${field} must be a string.`);
    fields[field] = fieldValue;
  }
  return fields as NonNullable<DshTraceRuntimeInfo['model']>;
}

function readNativeKind(value: unknown): DshTraceNativeRecord['kind'] {
  if (value === 'session_event' || value === 'interaction_requested' || value === 'interaction_resolved') return value;
  throw new DshTraceCodecError('native record kind is invalid.');
}

function expectLiteral<T extends string>(value: unknown, expected: T, field: string): T {
  if (value === expected) return expected;
  throw new DshTraceCodecError(`${field} must be ${expected}.`);
}

function expectNonEmptyString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new DshTraceCodecError(`${field} must be a non-empty string.`);
}

function expectNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw new DshTraceCodecError(`${field} must be a non-negative safe integer.`);
}

function expectJson(value: unknown, field: string): JsonValue {
  if (isJsonDataValue(value)) return value;
  throw new DshTraceCodecError(`${field} must be a JSON value.`);
}

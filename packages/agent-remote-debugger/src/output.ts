import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { DebuggerError } from './errors.js';

export interface DebuggerIo {
  readonly stdin: (signal?: AbortSignal) => Promise<string>;
  readonly readFile: (path: string, options?: { signal?: AbortSignal }) => Promise<string>;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly stdoutBytes?: (value: Uint8Array) => void;
}

export function writeJson(io: DebuggerIo, value: unknown): void {
  const serialized = jsonValue(value);
  writeOutput(() => io.stdout(`${serialized}\n`));
}

export function writeText(io: DebuggerIo, value: string): void {
  writeOutput(() => io.stdout(value));
}

export function writeStructuredError(io: DebuggerIo, error: DebuggerError): void {
  writeToStderr(io, { error: { code: error.code, message: error.message, recoverable: error.recoverable } });
}

export function writeJsonToStderr(io: DebuggerIo, value: unknown): void {
  writeToStderr(io, value);
}

export function writeBinary(io: DebuggerIo, value: Uint8Array, explicitOutput: boolean): void {
  if (!explicitOutput) {
    throw new DebuggerError(2, 'binary_stdout_requires_explicit_output', 'Binary output requires --output -.', false);
  }
  if (!io.stdoutBytes) {
    throw new DebuggerError(2, 'binary_output_unavailable', 'Binary stdout is unavailable.', false);
  }
  writeOutput(() => io.stdoutBytes?.(value));
}

function writeToStderr(io: DebuggerIo, value: unknown): void {
  const serialized = jsonValue(value);
  writeOutput(() => io.stderr(`${serialized}\n`));
}

export interface AtomicFileOperations {
  writeFile(path: string, bytes: Uint8Array, options: { signal: AbortSignal; flag: 'wx' }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const nodeFileOperations: AtomicFileOperations = {
  writeFile: (path, bytes, options) => writeFile(path, bytes, options),
  rename,
  unlink,
};

export async function writeFileAtomically(
  path: string,
  bytes: Uint8Array,
  signal: AbortSignal,
  operations: AtomicFileOperations = nodeFileOperations,
): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    await operations.writeFile(temporaryPath, bytes, { signal, flag: 'wx' });
    if (signal.aborted) throw signal.reason ?? new Error('Resource write was aborted.');
    await operations.rename(temporaryPath, path);
    renamed = true;
  } finally {
    if (!renamed) await operations.unlink(temporaryPath).catch(() => undefined);
  }
}

function writeOutput(operation: () => void): void {
  try {
    operation();
  } catch {
    throw new DebuggerError(2, 'output_write_failed', 'Local output could not be written.', false);
  }
}

function jsonValue(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('Value is not JSON-serializable.');
    return serialized;
  } catch {
    throw new DebuggerError(2, 'invalid_json_output', 'Output must be a JSON-serializable value.', false);
  }
}

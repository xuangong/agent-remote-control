import { DebuggerError } from './errors.js';

export interface DebuggerInputIo {
  readonly stdin: (signal?: AbortSignal) => Promise<string>;
  readonly readFile: (path: string, options?: { signal?: AbortSignal }) => Promise<string>;
}

type DebuggerEnvironment = Readonly<Record<string, string | undefined>>;

export function resolveRelayUrl(option: string | undefined, environment: DebuggerEnvironment): string {
  return option ?? environment.AGENT_REMOTE_URL ?? environment.BORGEE_REMOTE_URL ?? 'http://127.0.0.1:5910';
}

export function resolveOrigin(option: string | undefined, environment: DebuggerEnvironment): string {
  return option ?? environment.AGENT_REMOTE_ORIGIN ?? environment.BORGEE_REMOTE_ORIGIN ?? 'http://127.0.0.1:6175';
}

export async function readTextInput(
  argument: string | undefined,
  file: string | undefined,
  io: DebuggerInputIo,
  signal?: AbortSignal,
): Promise<string> {
  if (argument !== undefined && file !== undefined) {
    throw new DebuggerError(2, 'message_source_ambiguous', 'Provide either an argument or --file, not both.', false);
  }
  if (argument !== undefined) return argument;
  if (file === '-') return io.stdin(signal);
  if (file === undefined) {
    throw new DebuggerError(2, 'message_required', 'A message argument or --file is required.', false);
  }
  try {
    return await io.readFile(file, { signal });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw new DebuggerError(2, 'input_file_unreadable', 'Input file could not be read.', false);
  }
}

export function parseExactJson<T>(input: string): T {
  try {
    return JSON.parse(input) as T;
  } catch {
    throw new DebuggerError(2, 'invalid_json', 'Input must contain exactly one JSON value.', false);
  }
}

import { createHash, randomUUID } from 'node:crypto';

/**
 * Exit codes every resource command (session, group, host, window, login) shares: 0 done, 1 failed (the error code says
 * why), 2 the command line is wrong, 3 a change may or may not have happened (query it; do not resend a new one).
 */
export const EXIT_OK = 0, EXIT_FAILED = 1, EXIT_USAGE = 2, EXIT_UNCERTAIN = 3;
const USAGE_CODES = new Set(['invalid_request', 'invalid_argument', 'invalid_command', 'invalid_binding', 'invalid_operation']);
const UNCERTAIN_CODES = new Set(['outcome_unknown']);

/** A command failure with a stable code; detail is printed beside the error, such as the operation to query. */
export class CliError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: Record<string, unknown>) { super(message); }
}
export function usage(message: string): never { throw new CliError('invalid_request', message); }

export function exitCode(code: string): number {
  return USAGE_CODES.has(code) ? EXIT_USAGE : UNCERTAIN_CODES.has(code) ? EXIT_UNCERTAIN : EXIT_FAILED;
}

export function printResult(write: (text: string) => void, value: unknown): number {
  write(`${JSON.stringify(value ?? {}, null, 2)}\n`);
  return EXIT_OK;
}

/** Prints `{ error: { code, message }, ...detail }` and returns its exit code; secrets never reach the message. */
export function printError(write: (text: string) => void, error: unknown, secrets: readonly string[] = []): number {
  const code = error instanceof CliError ? error.code : 'command_failed';
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, '[redacted]');
  write(`${JSON.stringify({ error: { code, message }, ...(error instanceof CliError ? error.detail : {}) })}\n`);
  return exitCode(code);
}

/** The identity that makes a change idempotent: the caller's, to retry the same change, or a new one. */
export function operationId(value: string | undefined): string {
  if (value === undefined) return randomUUID();
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) usage('An operation ID has 1 to 128 letters, digits, and . _ : -.');
  return value;
}

/** The UUID a Controller's operation cache keys a command's operation identity by; a UUID stays itself. */
export function operationUuid(id: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return id;
  const bytes = createHash('sha256').update(JSON.stringify(['host:cli', id])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Splits `--name value` options from positional arguments; flags take no value. */
export function parseOptions(args: readonly string[], allowed: Record<string, 'value' | 'flag'>): { positional: string[]; options: Map<string, string> } {
  const positional: string[] = [], options = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith('--') || arg === '--') { positional.push(arg); continue; }
    const name = arg.slice(2), kind = allowed[name];
    if (!kind) usage(`Unknown option --${name}.`);
    if (options.has(name)) usage(`--${name} is given twice.`);
    if (kind === 'flag') { options.set(name, 'true'); continue; }
    const value = args[++index];
    if (value === undefined) usage(`--${name} needs a value.`);
    options.set(name, value);
  }
  return { positional, options };
}

export function integerOption(options: Map<string, string>, name: string, minimum: number, maximum: number): number | undefined {
  const value = options.get(name);
  if (value === undefined) return undefined;
  if (!/^\d{1,15}$/.test(value) || Number(value) < minimum || Number(value) > maximum) usage(`--${name} must be an integer from ${minimum} to ${maximum}.`);
  return Number(value);
}

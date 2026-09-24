#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { executeCommand, type CliEnvironment, type OutputFormat, type ParsedInvocation } from './commands.js';
import { DebuggerError, remoteOperationFailure } from './errors.js';
import type { DebuggerIo } from './output.js';
import { writeStructuredError } from './output.js';
import { RemoteOperationError } from '@orchardworks/agent-remote-web/headless';

export type { CliEnvironment } from './commands.js';

const valueOptions = new Set([
  'relay', 'origin', 'format', 'provider', 'provider-session-id', 'cwd', 'model', 'reasoning-effort', 'system-prompt',
  'persistence-file', 'tail', 'file', 'wait', 'for', 'response-file', 'output', 'until', 'timeout', 'planning', 'adapter', 'executable', 'port',
]);
const flagOptions = new Set(['json', 'jsonl', 'all', 'follow', 'help', 'open']);

export async function runCli(argv: readonly string[], io: DebuggerIo = processIo(), environment: CliEnvironment = {}): Promise<number> {
  const controller = new AbortController();
  const unsubscribeSigint = environment.subscribeSigint
    ? environment.subscribeSigint(() => controller.abort())
    : subscribeProcessSigint(() => controller.abort());
  try {
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
      io.stdout(`${helpText()}\n`);
      return 0;
    }
    const invocation = parseInvocation(argv);
    if (invocation.path[0] === 'server') {
      const { runServerCommand } = await import('./server-command.js');
      await runServerCommand(invocation, io, controller.signal);
    } else if (invocation.path[0] === 'replay') {
      const { runReplayCommand } = await import('./replay-command.js');
      await runReplayCommand(invocation, io, controller.signal);
    } else await executeCommand(invocation, io, environment, controller.signal);
    return 0;
  } catch (error) {
    const debuggerError = toDebuggerError(error);
    writeStructuredError(io, debuggerError);
    return debuggerError.exitCode;
  } finally {
    unsubscribeSigint();
  }
}

function parseInvocation(argv: readonly string[]): ParsedInvocation {
  const path = commandPath(argv);
  const options = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let index = path.length; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const option = token.slice(2);
    if (flagOptions.has(option)) {
      if (options.has(option)) throw new DebuggerError(2, 'duplicate_option', `Option --${option} was provided more than once.`, false);
      options.set(option, true);
      continue;
    }
    if (!valueOptions.has(option)) throw new DebuggerError(2, 'unknown_option', `Option --${option} is not supported.`, false);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new DebuggerError(2, 'option_value_required', `Option --${option} requires a value.`, false);
    if (options.has(option)) throw new DebuggerError(2, 'duplicate_option', `Option --${option} was provided more than once.`, false);
    options.set(option, value);
    index += 1;
  }
  const format = outputFormat(options);
  return { path, positionals, options, format };
}

function commandPath(argv: readonly string[]): readonly string[] {
  const first = argv[0];
  if (!first || first.startsWith('-')) throw new DebuggerError(2, 'command_required', 'A command is required.', false);
  if (first === 'provider' || first === 'session' || first === 'interaction' || first === 'resource' || first === 'protocol' || first === 'settings') {
    const second = argv[1];
    if (!second || second.startsWith('-')) throw new DebuggerError(2, 'subcommand_required', `A ${first} subcommand is required.`, false);
    return [first, second];
  }
  return [first];
}

function outputFormat(options: ReadonlyMap<string, string | true>): OutputFormat {
  const format = options.get('format');
  const aliases = [options.has('json') ? 'json' : undefined, options.has('jsonl') ? 'jsonl' : undefined].filter(Boolean);
  if (aliases.length > 1 || (format && aliases.length > 0)) throw new DebuggerError(2, 'output_format_ambiguous', 'Provide exactly one output format.', false);
  const value = format === true ? undefined : format ?? aliases[0] ?? 'text';
  if (value === 'text' || value === 'json' || value === 'jsonl') return value;
  throw new DebuggerError(2, 'invalid_output_format', 'Output format must be text, json, or jsonl.', false);
}

function toDebuggerError(error: unknown): DebuggerError {
  if (error instanceof DebuggerError) return error;
  if (error instanceof RemoteOperationError) {
    return remoteOperationFailure(error);
  }
  return new DebuggerError(3, 'relay_connection_failed', 'Relay command could not be completed.', true);
}

function subscribeProcessSigint(listener: () => void): () => void {
  process.once('SIGINT', listener);
  return () => process.removeListener('SIGINT', listener);
}

function processIo(): DebuggerIo {
  return {
    stdin: (signal) => new Promise<string>((resolve, reject) => {
      let value = '';
      const cleanup = () => {
        process.stdin.off('data', onData);
        process.stdin.off('end', onEnd);
        process.stdin.off('error', onError);
        signal?.removeEventListener('abort', onAbort);
      };
      const onData = (chunk: Buffer | string) => { value += String(chunk); };
      const onEnd = () => { cleanup(); resolve(value); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onAbort = () => {
        cleanup();
        process.stdin.pause();
        reject(signal?.reason ?? new Error('Standard input was interrupted.'));
      };
      process.stdin.on('data', onData);
      process.stdin.once('end', onEnd);
      process.stdin.once('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort(); else process.stdin.resume();
    }),
    readFile: async (path, options) => (await import('node:fs/promises')).readFile(path, { encoding: 'utf8', signal: options?.signal }),
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
    stdoutBytes: (value) => process.stdout.write(value),
  };
}

function helpText(): string {
  return `Usage: ardb <command> [options]

Agent Remote Debugger: inspect and exercise the Session View protocol and state.

Commands:
  server --provider <codex|claude|copilot> [--cwd <path>] [--executable <path>] [--port <0-65535>] [--open] [--jsonl]
  server --adapter <module-path> [--persistence-file <path>] [--port <0-65535>] [--open] [--jsonl]
  replay <session.jsonl> [--open] [--port <0-65535>]
  provider list
  session create <agent-id> --provider <provider-id> [--provider-session-id <id>] [--cwd <path>] [--model <model>] [--reasoning-effort <effort>] [--system-prompt <text>] [--planning <on|off>]
  session resume <agent-id> --persistence-file <path|->
  observe <agent-id> [--until <idle|interaction|failed>]
  inspect <agent-id>
  timeline <agent-id> [--tail <count>|--all] [--follow --until <idle|interaction|failed>]
  send <agent-id> [message] [--file <path|->] [--wait <condition>]
  steer <agent-id> [message] [--file <path|->] [--wait <condition>]
  cancel <agent-id>
  planning <agent-id> <on|off>
  settings list <agent-id>
  settings set <agent-id> <setting-id> <value>
  wait <agent-id> --for <idle|interaction|failed>
  interaction list <agent-id>
  interaction respond <agent-id> <request-id> --response-file <path|->
  resource get <agent-id> <resource-id> --output <path|->
  protocol trace <agent-id> --jsonl [--until <idle|interaction|failed>]

Output: one-shot commands support text or json; streaming commands support text or jsonl. --json and --jsonl are format aliases.
Connection: --relay <url> uses AGENT_REMOTE_URL, BORGEE_REMOTE_URL or http://127.0.0.1:5910. WebSocket commands also accept --origin <url>, then AGENT_REMOTE_ORIGIN, BORGEE_REMOTE_ORIGIN or http://127.0.0.1:6175.
Common options: --relay <url> --origin <url> --timeout <milliseconds> --format <text|json|jsonl> --json --jsonl`;
}

function isProcessEntry(): boolean {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (isProcessEntry()) {
  void runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

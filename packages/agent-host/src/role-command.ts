import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { commandChannel } from './cli-client.js';
import { CliError, EXIT_OK, printError, printResult, usage } from './cli-output.js';
import { SESSION_SOCKET_VARIABLE, SESSION_TOKEN_VARIABLE } from './session-callers.js';

const help = `Usage: agent-remote-controller role <command>

What the role this session holds lets it do: a Team member, a support coordinator or supporter, a TPM,
or a worker that calls for support. Run it in the session's own shell.

  role list                     The commands of this session's role, with their options
  role <command> [--OPTION VALUE]... [--input JSON | --input-file PATH|-]
                                Run one. Options are the input's fields in kebab-case; give an
                                array field once per item and an object field as JSON.

Output and exit codes work as for session commands (session --help).
`;

/** Builds the request a role command sends; the Controller checks it against the role's own schema. */
export async function roleRequest(args: readonly string[]): Promise<Record<string, unknown>> {
  const [command, ...rest] = args;
  if (!command || command.startsWith('-')) usage('Name the role command, or run role list.');
  if (command === 'list') { if (rest.length) usage('role list takes no options.'); return { command: 'list' }; }
  const options: Array<[string, string]> = [];
  let input: unknown;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (!arg.startsWith('--')) usage(`Unexpected argument: ${arg}. Give every value as --OPTION VALUE.`);
    const value = rest[++index];
    if (value === undefined) usage(`${arg} needs a value.`);
    if (arg === '--input' || arg === '--input-file') {
      if (input !== undefined) usage('Give the input once.');
      let text = value;
      if (arg === '--input-file') try { text = await readFile(value === '-' ? '/dev/stdin' : value, 'utf8'); } catch { usage('The input file could not be read.'); }
      try { input = JSON.parse(text); } catch { usage('The input must be a JSON object.'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) usage('The input must be a JSON object.');
      continue;
    }
    options.push([arg.slice(2), value]);
  }
  return { command: 'run', name: command, ...(input !== undefined ? { input } : {}), ...(options.length ? { options } : {}) };
}

export async function runRoleCommand(args: readonly string[], env: NodeJS.ProcessEnv, write: (text: string) => void, connect: typeof createConnection = createConnection): Promise<number> {
  if (!args.length || ['help', '--help', '-h'].includes(args[0]!)) { write(help); return args.length ? EXIT_OK : 2; }
  try {
    const request = await roleRequest(args);
    // A role belongs to a session, so only its own shell has one.
    if (!env[SESSION_TOKEN_VARIABLE] || !env[SESSION_SOCKET_VARIABLE]) throw new CliError('no_session_identity', 'Role commands run in the shell of the session that holds the role.');
    const channel = await commandChannel(env, async () => undefined, connect);
    const answer = await channel.call('role', request);
    if ('error' in answer) throw new CliError(answer.error.code, answer.error.message);
    return printResult(write, answer.result);
  } catch (error) {
    return printError(write, error);
  }
}

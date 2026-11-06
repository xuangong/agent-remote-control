import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { commandChannel, type ManagementAccess } from './cli-client.js';
import { CliError, EXIT_OK, operationId, printError, printResult, usage } from './cli-output.js';
import type { CliCredentials } from './relay-client.js';

const help = `Usage: agent-remote-controller session <command>

Sessions are addressed as <hostId>/<providerId>/<nativeSessionId>; a session's own shell may say self.
Every command prints JSON. Exit 0 done, 1 failed (see error.code), 2 wrong usage, 3 a change may or
may not have happened (inspect before trying again with the same --operation-id).

  session list [--host H] [--provider P] [--limit 1..50] [--cursor C]
  session read <address> [--limit 1..10] [--cursor C] [--search TEXT] [--turn TURN_ID] [--text-offset N]
  session inspect <address>
  session create --provider P [--host H] [--cwd DIR] [--model M] [--effort E] [--planning]
                 [--from ADDRESS [--context]] [--ref ADDRESS]... [--message TEXT | --file PATH]
  session send <address> (TEXT | --file PATH) [--steer]
  session cancel <address>
  session answer <address> <request-id> --response JSON
  session set <address> [--setting ID=VALUE]... [--planning true|false] [--title TEXT]
  session release <address>
  session ref list [--session ADDRESS]
  session ref add|remove <address> [--session ADDRESS]

Changes take --operation-id ID: repeating a change with the same ID does it once.
`;

type Spec = Record<string, 'value' | 'flag' | 'many'>;
const common: Spec = { 'operation-id': 'value' };
const specs: Record<string, Spec> = {
  list: { host: 'value', provider: 'value', limit: 'value', cursor: 'value' },
  read: { limit: 'value', cursor: 'value', search: 'value', turn: 'value', 'text-offset': 'value' },
  inspect: {},
  create: { ...common, provider: 'value', host: 'value', cwd: 'value', model: 'value', effort: 'value', planning: 'flag', from: 'value', context: 'flag', ref: 'many', message: 'value', file: 'value' },
  send: { ...common, file: 'value', steer: 'flag' },
  cancel: { ...common },
  answer: { ...common, response: 'value' },
  set: { ...common, setting: 'many', planning: 'value', title: 'value' },
  release: {},
  ref: { session: 'value' },
};

function parse(args: readonly string[], spec: Spec): { positional: string[]; values: Map<string, string[]> } {
  const positional: string[] = [], values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const name = arg.slice(2), kind = spec[name];
    if (!kind) usage(`Unknown option --${name}. Run agent-remote-controller session --help.`);
    if (kind !== 'many' && values.has(name)) usage(`--${name} is given twice.`);
    const value = kind === 'flag' ? 'true' : args[++index];
    if (value === undefined) usage(`--${name} needs a value.`);
    values.set(name, [...values.get(name) ?? [], value]);
  }
  return { positional, values };
}
const one = (values: Map<string, string[]>, name: string) => values.get(name)?.[0];
function integer(values: Map<string, string[]>, name: string): number | undefined {
  const value = one(values, name);
  if (value === undefined) return undefined;
  if (!/^\d{1,15}$/.test(value)) usage(`--${name} needs a non-negative integer.`);
  return Number(value);
}
function bool(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') usage(`--${name} is true or false.`);
  return value === 'true';
}
async function text(values: Map<string, string[]>, inline: string | undefined, field: string): Promise<string | undefined> {
  const file = one(values, 'file');
  if (file !== undefined && inline !== undefined) usage(`Give the ${field} as text or --file, not both.`);
  if (file === undefined) return inline;
  try { return await readFile(file === '-' ? '/dev/stdin' : file, 'utf8'); }
  catch { return usage(`The ${field} file could not be read.`); }
}
const defined = <T extends Record<string, unknown>>(value: T) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

/** Builds the request a session command sends; the Controller checks it again. */
export async function sessionRequest(args: readonly string[]): Promise<Record<string, unknown>> {
  const [command, ...rest] = args;
  const spec = command ? specs[command] : undefined;
  if (!command || !spec) usage(`Unknown session command: ${command ?? ''}. Run agent-remote-controller session --help.`);
  const { positional, values } = parse(rest, spec);
  const change = 'operation-id' in spec ? { operationId: operationId(one(values, 'operation-id')) } : {};
  const address = (index: number, what = 'session') => positional[index] ?? usage(`Name the ${what}: self or <hostId>/<providerId>/<nativeSessionId>.`);
  const extra = (count: number) => { if (positional.length > count) usage(`Unexpected argument: ${positional[count]}.`); };
  switch (command) {
    case 'list': extra(0); return defined({ command, host: one(values, 'host'), providerId: one(values, 'provider'), limit: integer(values, 'limit'), cursor: one(values, 'cursor') });
    case 'read': extra(1); return defined({ command, target: address(0), limit: integer(values, 'limit'), cursor: one(values, 'cursor'), search: one(values, 'search'),
      turnId: one(values, 'turn'), textOffset: integer(values, 'text-offset') });
    case 'inspect': case 'cancel': case 'release': extra(1); return { command, target: address(0), ...change };
    case 'create': {
      extra(0);
      if (values.has('context') && !values.has('from')) usage('--context copies the conversation of the session given with --from.');
      return defined({ command, ...change, providerId: one(values, 'provider') ?? usage('Name the provider with --provider.'), host: one(values, 'host'), cwd: one(values, 'cwd'),
        model: one(values, 'model'), reasoningEffort: one(values, 'effort'), planning: values.has('planning') ? true : undefined, from: one(values, 'from'),
        context: values.has('context') ? true : undefined, refs: values.get('ref'), message: await text(values, one(values, 'message'), 'message') });
    }
    case 'send': {
      const target = address(0);
      const inline = positional.length > 1 ? positional.slice(1).join(' ') : undefined;
      const message = await text(values, inline, 'message') ?? usage('Give the text to send, or --file PATH.');
      return { command: values.has('steer') ? 'steer' : 'send', target, text: message, ...change };
    }
    case 'answer': {
      extra(2);
      let response: unknown;
      try { response = JSON.parse(one(values, 'response') ?? usage('Give the answer with --response JSON.')); } catch (error) { if (error instanceof CliError) throw error; usage('--response must be JSON.'); }
      return { command, target: address(0), requestId: positional[1] ?? usage('Name the request to answer.'), response, ...change };
    }
    case 'set': {
      extra(1);
      const settings: Record<string, string> = {};
      for (const pair of values.get('setting') ?? []) {
        const at = pair.indexOf('=');
        if (at < 1) usage('--setting is ID=VALUE.');
        settings[pair.slice(0, at)] = pair.slice(at + 1);
      }
      return defined({ command, target: address(0), ...change, ...(Object.keys(settings).length ? { settings } : {}), planning: bool(one(values, 'planning'), 'planning'), title: one(values, 'title') });
    }
    case 'ref': {
      const [action, target] = positional;
      if (action === 'list') { extra(1); return defined({ command, action, session: one(values, 'session') }); }
      if (action !== 'add' && action !== 'remove') usage('Use session ref list, or session ref add|remove <address>.');
      extra(2);
      return defined({ command, action, target: target ?? usage('Name the session to reference.'), session: one(values, 'session') });
    }
  }
  return usage('Unknown session command.');
}

/** Session commands: from a session's shell as that session, from an ordinary terminal as the Host owner. */
export async function runSessionCommand(args: readonly string[], env: NodeJS.ProcessEnv, write: (text: string) => void,
  management: () => Promise<ManagementAccess | undefined> = async () => undefined, connect: typeof createConnection = createConnection,
  credentials: () => Promise<CliCredentials | undefined> = async () => undefined): Promise<number> {
  if (!args.length || ['help', '--help', '-h'].includes(args[0]!)) { write(help); return args.length ? EXIT_OK : 2; }
  try {
    const request = await sessionRequest(args);
    const channel = await commandChannel(env, management, connect, credentials);
    const answer = await channel.call('session', request);
    if ('error' in answer) throw new CliError(answer.error.code, answer.error.message, answer.error.code === 'outcome_unknown' && typeof request.operationId === 'string' ? { operationId: request.operationId } : undefined);
    return printResult(write, answer.result);
  } catch (error) {
    return printError(write, error);
  }
}

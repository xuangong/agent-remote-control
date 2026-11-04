import { createConnection } from 'node:net';
import { SESSION_SOCKET_VARIABLE, SESSION_TOKEN_VARIABLE } from './session-callers.js';

const usage = `Usage: agent-remote-controller session <command>

Run from the shell of a session that Agent Remote Control manages. Every command prints JSON.

  session read self
  session list [--provider P] [--limit 1..50] [--cursor C]
  session read <hostId>/<providerId>/<nativeSessionId> [--limit 1..10] [--cursor C]
               [--search TEXT] [--turn TURN_ID] [--text-offset N]
`;

const exitCodes: Record<string, number> = { invalid_request: 2, no_session_identity: 3, controller_unreachable: 4, session_forbidden: 5, session_not_found: 6 };
const options: Record<string, { field: string; integer?: true; commands: string[] }> = {
  '--provider': { field: 'providerId', commands: ['list'] },
  '--limit': { field: 'limit', integer: true, commands: ['list', 'read'] },
  '--cursor': { field: 'cursor', commands: ['list', 'read'] },
  '--search': { field: 'search', commands: ['read'] },
  '--turn': { field: 'turnId', commands: ['read'] },
  '--text-offset': { field: 'textOffset', integer: true, commands: ['read'] },
};

class SessionCommandError extends Error { constructor(readonly code: string, message: string) { super(message); } }

/** Session commands for an agent's shell: the session its credential names asks its own Controller. */
export async function runSessionCommand(args: readonly string[], env: NodeJS.ProcessEnv, write: (text: string) => void,
  connect: typeof createConnection = createConnection): Promise<number> {
  if (!args.length || ['help', '--help', '-h'].includes(args[0]!)) { write(usage); return args.length ? 0 : 2; }
  try {
    const request = parseArguments(args);
    const token = env[SESSION_TOKEN_VARIABLE], socket = env[SESSION_SOCKET_VARIABLE];
    if (!token || !socket) throw new SessionCommandError('no_session_identity', 'This shell does not belong to a session Agent Remote Control manages.');
    const response = await call(socket, { ...request, token }, connect);
    if (response.error) {
      const { code, message } = response.error as { code?: unknown; message?: unknown };
      throw new SessionCommandError(typeof code === 'string' ? code : 'controller_error', typeof message === 'string' ? message : 'The Controller refused the command.');
    }
    write(`${JSON.stringify(response.result ?? {}, null, 2)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof SessionCommandError ? error.code : 'controller_error';
    write(`${JSON.stringify({ error: { code, message: error instanceof Error ? error.message : String(error) } })}\n`);
    return exitCodes[code] ?? 1;
  }
}

function parseArguments(args: readonly string[]): Record<string, unknown> {
  const [command, ...rest] = args;
  if (command !== 'list' && command !== 'read') throw new SessionCommandError('invalid_request', `Unknown session command: ${command}. Run agent-remote-controller session --help.`);
  const request: Record<string, unknown> = { command };
  if (command === 'read') {
    const target = rest.shift();
    if (!target || target.startsWith('--')) throw new SessionCommandError('invalid_request', 'Name the session to read: self or <hostId>/<providerId>/<nativeSessionId>.');
    request.target = target;
  }
  while (rest.length) {
    const name = rest.shift()!, option = options[name], value = rest.shift();
    if (!option || !option.commands.includes(command)) throw new SessionCommandError('invalid_request', `Unknown option for session ${command}: ${name}.`);
    if (value === undefined) throw new SessionCommandError('invalid_request', `${name} needs a value.`);
    if (option.field in request) throw new SessionCommandError('invalid_request', `${name} is given twice.`);
    if (option.integer && !/^\d{1,15}$/.test(value)) throw new SessionCommandError('invalid_request', `${name} needs a non-negative integer.`);
    request[option.field] = option.integer ? Number(value) : value;
  }
  return request;
}

function call(socket: string, payload: Record<string, unknown>, connect: typeof createConnection): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const connection = connect(socket);
    let output = '';
    connection.setTimeout(60_000, () => connection.destroy(new SessionCommandError('controller_unreachable', 'The Controller did not answer in time.')));
    // Windows named pipes do not support the half-close that ends a request on Unix sockets.
    connection.on('connect', () => {
      const message = JSON.stringify(payload);
      if (process.platform === 'win32') connection.write(`${message}\n`); else connection.end(message);
    });
    connection.setEncoding('utf8');
    connection.on('data', (chunk: string) => { output += chunk; });
    connection.on('error', (error: NodeJS.ErrnoException) => {
      if (error instanceof SessionCommandError) { reject(error); return; }
      const sandboxed = error.code === 'EPERM' || error.code === 'EACCES';
      reject(new SessionCommandError('controller_unreachable', sandboxed
        ? `The Controller socket is blocked (${error.code}); a sandbox may not allow it.`
        : `The Controller is not reachable (${error.code ?? 'unknown error'}); it may not be running.`));
    });
    connection.on('close', hadError => {
      if (hadError) return;
      try {
        const response: unknown = JSON.parse(output);
        if (response && typeof response === 'object' && !Array.isArray(response)) { resolve(response as Record<string, unknown>); return; }
      } catch { /* Reported below. */ }
      reject(new SessionCommandError('controller_unreachable', 'The Controller returned an invalid answer.'));
    });
  });
}

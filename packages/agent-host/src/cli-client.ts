import { createConnection } from 'node:net';
import { CliError } from './cli-output.js';
import { SESSION_SOCKET_VARIABLE, SESSION_TOKEN_VARIABLE } from './session-callers.js';

/** A command's answer: its result, or an error with a stable code. */
export type CommandAnswer = { result: Record<string, unknown> } | { error: { code: string; message: string } };

/** The running Controller's management socket and token, readable only by the local user who owns the Host. */
export interface ManagementAccess { socket: string; token: string }

/**
 * Where a resource command goes. A session's shell asks its Controller as that session; an ordinary terminal asks the
 * local Controller as the Host owner. Either Controller sends what names another Host there through the Relay.
 */
export interface CommandChannel { readonly caller: 'session' | 'owner'; call(scope: string, request: Record<string, unknown>): Promise<CommandAnswer> }

export async function commandChannel(env: NodeJS.ProcessEnv, management: () => Promise<ManagementAccess | undefined>,
  connect: typeof createConnection = createConnection): Promise<CommandChannel> {
  const token = env[SESSION_TOKEN_VARIABLE], socket = env[SESSION_SOCKET_VARIABLE];
  if (token && socket) return { caller: 'session', call: (scope, request) => answer(socketCall(socket, { scope, ...request, token }, connect)) };
  const access = await management().catch(() => undefined);
  if (access) return { caller: 'owner', call: (scope, request) => answer(socketCall(access.socket, { action: scope, request, token: access.token }, connect)) };
  throw new CliError('no_identity', 'Run this in a session Agent Remote Control manages, or on a computer whose Controller is running.');
}

async function answer(pending: Promise<Record<string, unknown>>): Promise<CommandAnswer> {
  const response = await pending;
  if (response.result && typeof response.result === 'object') return { result: response.result as Record<string, unknown> };
  const error = response.error;
  if (error && typeof error === 'object') {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return { error: { code: typeof code === 'string' ? code : 'controller_error', message: typeof message === 'string' ? message : 'The Controller refused the command.' } };
  }
  // A Controller that predates these commands answers with its own error text.
  return { error: { code: 'unsupported_configuration', message: typeof error === 'string' ? `${error} Update the Controller.` : 'The Controller returned an invalid answer.' } };
}

/** One JSON request per connection, as both Controller sockets take it. */
export function socketCall(socket: string, payload: Record<string, unknown>, connect: typeof createConnection = createConnection, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const connection = connect(socket);
    let output = '';
    connection.setTimeout(timeoutMs, () => connection.destroy(new CliError('controller_unreachable', 'The Controller did not answer in time.')));
    // Windows named pipes do not support the half-close that ends a request on Unix sockets.
    connection.on('connect', () => {
      const message = JSON.stringify(payload);
      if (process.platform === 'win32') connection.write(`${message}\n`); else connection.end(message);
    });
    connection.setEncoding('utf8');
    connection.on('data', (chunk: string) => { output += chunk; });
    connection.on('error', (error: NodeJS.ErrnoException) => {
      if (error instanceof CliError) { reject(error); return; }
      const sandboxed = error.code === 'EPERM' || error.code === 'EACCES';
      reject(new CliError('controller_unreachable', sandboxed
        ? `The Controller socket is blocked (${error.code}); a sandbox may not allow it.`
        : `The Controller is not reachable (${error.code ?? 'unknown error'}); it may not be running.`));
    });
    connection.on('close', hadError => {
      if (hadError) return;
      try {
        const response: unknown = JSON.parse(output);
        if (response && typeof response === 'object' && !Array.isArray(response)) { resolve(response as Record<string, unknown>); return; }
      } catch { /* Reported below. */ }
      reject(new CliError('controller_unreachable', 'The Controller returned an invalid answer.'));
    });
  });
}

import { readFile } from 'node:fs/promises';
import { CliError, EXIT_OK, parseOptions, printError, printResult, usage } from './cli-output.js';
import { relayError, relayRequest, type CliCredentials } from './relay-client.js';

const help = `Usage: agent-remote-controller api <GET|POST|PUT|DELETE> <path> [--body JSON | --body-file PATH|-]

Sends one request to the Relay as the signed-in user, as the website does: /v1/... paths in your
account (for example /v1/remote/teams, /v1/remote/hosts/<hostId>/tpm), /auth/... paths at the site.
For what the other commands do not cover. Prints the JSON answer; exit 0 on 2xx, 1 otherwise.
`;

/** The website's own routes for the command line, as the signed-in user; the commands above them cover the common work. */
export async function runApiCommand(args: readonly string[], credentials: () => Promise<CliCredentials | undefined>, write: (text: string) => void, fetcher: typeof fetch = fetch): Promise<number> {
  if (!args.length || ['help', '--help', '-h'].includes(args[0]!)) { write(help); return args.length ? EXIT_OK : 2; }
  try {
    const { positional, options } = parseOptions(args, { body: 'value', 'body-file': 'value' });
    const [method, path, ...rest] = positional;
    if (rest.length) usage(`Unexpected argument: ${rest[0]}.`);
    if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'DELETE') usage('The method is GET, POST, PUT or DELETE.');
    if (!path || !/^\/(v1|auth)\/[^\s#]*$/.test(path) || path.split('/').includes('..')) usage('The path starts with /v1/ or /auth/.');
    if (options.has('body') && options.has('body-file')) usage('Give the body once.');
    let text = options.get('body');
    if (options.has('body-file')) try { text = await readFile(options.get('body-file') === '-' ? '/dev/stdin' : options.get('body-file')!, 'utf8'); } catch { usage('The body file could not be read.'); }
    let body: unknown;
    if (text !== undefined) try { body = JSON.parse(text); } catch { usage('The body must be JSON.'); }
    if (body !== undefined && method === 'GET') usage('A GET request has no body.');
    const signedIn = await credentials();
    if (!signedIn) throw new CliError('signed_out', 'Run agent-remote-controller login first.');
    const { status, data } = await relayRequest(signedIn, method, path, method === 'GET' ? undefined : body ?? {}, fetcher);
    if (status < 200 || status >= 300) throw relayError(status, data);
    return printResult(write, data);
  } catch (error) {
    return printError(write, error);
  }
}

import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { CliError, EXIT_OK, parseOptions, printError, printResult, usage } from './cli-output.js';
import { forgetCredentials, readCredentials, relayOrigin, relayRequest, saveCredentials } from './relay-client.js';

const help = `Usage: agent-remote-controller login [--server URL] [--no-browser]
       agent-remote-controller login status
       agent-remote-controller logout

login opens the website, where you allow this command line to act as you; it then reaches your
other Hosts, Windows and groups through the Relay. The session is listed with your browser sessions
in Settings, where you can revoke it. --server defaults to the Relay this Controller is paired with.
`;

export interface LoginContext {
  stateDir: string;
  /** The Relay this computer's Controller is paired with. */
  pairedServer(): Promise<string | undefined>;
  write(text: string): void;
  fetcher?: typeof fetch;
  open?(url: string): void;
  sleep?(ms: number): Promise<void>;
}

function openBrowser(url: string) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(command, args as string[], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref(); } catch { /* The URL is printed too. */ }
}

export async function runLoginCommand(command: 'login' | 'logout', args: readonly string[], context: LoginContext): Promise<number> {
  if (args.includes('--help') || args[0] === 'help') { context.write(help); return EXIT_OK; }
  const fetcher = context.fetcher ?? fetch, sleep = context.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  try {
    if (command === 'logout') {
      if (args.length) usage('logout takes no arguments.');
      const credentials = await readCredentials(context.stateDir).catch(() => undefined);
      if (credentials) await relayRequest(credentials, 'POST', '/auth/logout', {}, fetcher, 15_000).catch(() => undefined);
      await forgetCredentials(context.stateDir);
      return printResult(context.write, { signedIn: false });
    }
    if (args[0] === 'status') {
      if (args.length > 1) usage('login status takes no arguments.');
      const credentials = await readCredentials(context.stateDir);
      if (!credentials) return printResult(context.write, { signedIn: false });
      const { status, data } = await relayRequest(credentials, 'GET', '/auth/status', undefined, fetcher, 15_000).catch(error => {
        if (error instanceof CliError && error.code === 'signed_out') return { status: 401, data: {} };
        throw error;
      });
      return printResult(context.write, status === 200 ? { signedIn: true, serverUrl: credentials.serverUrl, user: data.user, expiresAt: new Date(credentials.expiresAt).toISOString() }
        : { signedIn: false, serverUrl: credentials.serverUrl });
    }
    const { positional, options } = parseOptions(args, { server: 'value', 'no-browser': 'flag' });
    if (positional.length) usage(`Unexpected argument: ${positional[0]}.`);
    const server = options.get('server') ?? await context.pairedServer() ?? usage('Give the Relay URL with --server, or pair this computer\'s Controller first.');
    const origin = relayOrigin(server);
    const started = await post(fetcher, `${origin}/auth/cli/start`, { label: hostname().slice(0, 100) });
    if (started.status !== 200 || typeof started.data.deviceCode !== 'string' || typeof started.data.verificationUrl !== 'string') throw new CliError('login_unavailable', started.data.error ?? 'The Relay did not start a sign-in. Update the website.');
    context.write(`Open ${started.data.verificationUrl} and allow code ${started.data.userCode}.\n`);
    if (!options.has('no-browser')) (context.open ?? openBrowser)(started.data.verificationUrl);
    const interval = Math.max(500, Number(started.data.intervalMs) || 2000);
    while (Date.now() < started.data.expiresAt) {
      await sleep(interval);
      const answer = await post(fetcher, `${origin}/auth/cli/token`, { deviceCode: started.data.deviceCode });
      if (answer.status === 202) continue;
      if (answer.status === 403) throw new CliError('login_refused', 'The sign-in was refused in the browser.');
      if (answer.status !== 200) throw new CliError('login_expired', 'The sign-in expired. Run agent-remote-controller login again.');
      const { token, basePath, cookieName, expiresAt } = answer.data;
      await saveCredentials(context.stateDir, { serverUrl: origin, token, basePath, cookieName, expiresAt });
      return printResult(context.write, { signedIn: true, serverUrl: origin, expiresAt: new Date(expiresAt).toISOString() });
    }
    throw new CliError('login_expired', 'The sign-in expired. Run agent-remote-controller login again.');
  } catch (error) {
    return printError(context.write, error);
  }
}

async function post(fetcher: typeof fetch, url: string, body: unknown): Promise<{ status: number; data: any }> {
  let response: Response;
  try { response = await fetcher(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }); }
  catch { throw new CliError('relay_unreachable', 'The Relay could not be reached.'); }
  const raw = await response.text();
  try { return { status: response.status, data: raw ? JSON.parse(raw) : {} }; } catch { throw new CliError('invalid_response', 'The Relay returned an invalid answer.'); }
}

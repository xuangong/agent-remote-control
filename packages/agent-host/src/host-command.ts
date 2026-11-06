import { createConnection } from 'node:net';
import { commandChannel, type CommandAnswer, type ManagementAccess } from './cli-client.js';
import { CliError, EXIT_OK, operationId, operationUuid, parseOptions, printError, printResult, usage } from './cli-output.js';
import { relayError, relayRequest, type CliCredentials } from './relay-client.js';

const help = `Usage: agent-remote-controller host <command>

A Host is named with --host ID (see host list); without it, the command is about this computer's Host.
Output, exit codes and --operation-id work as for session commands (session --help).

  host list
  host read [--host H]
  host providers [--host H]
  host providers set <provider> --enabled true|false [--host H]
  host workspaces [--host H] [--provider P] [--path DIR]
  host workspaces create <parent-dir> <name> [--host H] [--provider P]
  host tunnel [status | start --accept-license | stop] [--host H]
  host previews [--host H]
  host previews renew|remove <preview-id> [--host H]
  host update [--host H] [--version X.Y.Z]
  host stop-sessions [--host H]

host list, previews and update ask the Relay, so they need agent-remote-controller login.
`;

export type HostResponse = { status: number; data: any };
/** How a host command reaches a Host: its own routes, what it says of itself, and the Relay's account routes. */
export interface HostAccess {
  /** The Host's ID; undefined when this computer's Host is not registered yet. */
  id(): Promise<string | undefined>;
  /** A Host route, by its path under /remote/ (or under /v1/remote/hosts/<id>/ at the Relay). */
  host(method: 'GET' | 'POST', path: string, body?: unknown): Promise<HostResponse>;
  describe(): Promise<Record<string, unknown>>;
  /** A request to the Relay as the signed-in owner. */
  relay(method: 'GET' | 'POST', path: string, body?: unknown): Promise<HostResponse>;
}

/** Builds the request a host command sends; the Controller or the Relay checks it again. */
export function hostRequest(args: readonly string[]): Record<string, unknown> {
  const [command, ...rest] = args;
  const { positional, options } = parseOptions(rest, { host: 'value', enabled: 'value', provider: 'value', path: 'value', 'accept-license': 'flag', version: 'value', 'operation-id': 'value' });
  const host = options.get('host');
  const allow = (...names: string[]) => { for (const name of options.keys()) if (name !== 'host' && !names.includes(name)) usage(`--${name} does not apply to host ${command}.`); };
  const extra = (count: number) => { if (positional.length > count) usage(`Unexpected argument: ${positional[count]}.`); };
  const defined = (value: Record<string, unknown>) => Object.fromEntries(Object.entries({ host, ...value }).filter(([, item]) => item !== undefined));
  switch (command) {
    case 'list': allow(); extra(0); if (host) usage('host list lists every Host.'); return { command };
    case 'read': case 'stop-sessions': allow(...(command === 'stop-sessions' ? ['operation-id'] : [])); extra(0);
      return defined({ command, ...(command === 'stop-sessions' ? { operationId: operationUuid(operationId(options.get('operation-id'))) } : {}) });
    case 'providers': {
      if (!positional.length) { allow(); return defined({ command }); }
      allow('enabled'); extra(2);
      if (positional[0] !== 'set') usage('Use host providers, or host providers set <provider> --enabled true|false.');
      const enabled = options.get('enabled');
      if (enabled !== 'true' && enabled !== 'false') usage('--enabled is true or false.');
      return defined({ command, action: 'set', providerId: positional[1] ?? usage('Name the provider.'), enabled: enabled === 'true' });
    }
    case 'workspaces': {
      if (!positional.length) { allow('provider', 'path'); return defined({ command, providerId: options.get('provider'), path: options.get('path') }); }
      allow('provider'); extra(3);
      if (positional[0] !== 'create' || !positional[1] || !positional[2]) usage('Use host workspaces create <parent-dir> <name>.');
      return defined({ command, action: 'create', providerId: options.get('provider'), parentPath: positional[1], name: positional[2] });
    }
    case 'tunnel': {
      const action = positional[0] ?? 'status';
      extra(1); allow(...(action === 'start' ? ['accept-license'] : []));
      if (!['status', 'start', 'stop'].includes(action)) usage('Use host tunnel status, start or stop.');
      if (action === 'start' && !options.has('accept-license')) usage('Starting a tunnel accepts the VS Code Server license terms; add --accept-license.');
      return defined({ command, action });
    }
    case 'previews': {
      if (!positional.length) { allow(); return defined({ command }); }
      allow(); extra(2);
      if (positional[0] !== 'renew' && positional[0] !== 'remove') usage('Use host previews, or host previews renew|remove <preview-id>.');
      return defined({ command, action: positional[0], previewId: positional[1] ?? usage('Name the preview.') });
    }
    case 'update': allow('version', 'operation-id'); extra(0);
      return defined({ command, version: options.get('version'), ...(options.has('version') ? { operationId: operationUuid(operationId(options.get('operation-id'))) } : {}) });
  }
  return usage(`Unknown host command: ${command ?? ''}. Run agent-remote-controller host --help.`);
}

const answered = ({ status, data }: HostResponse): CommandAnswer => {
  if (status >= 200 && status < 300) return { result: data && typeof data === 'object' && !Array.isArray(data) ? data : { value: data } };
  const error = relayError(status, data);
  return { error: { code: status === 409 && error.code === 'request_rejected' ? 'conflict' : error.code, message: error.message } };
};
const safeId = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : usage('The preview ID is invalid.');

/** Answers one host command over the access it is given; both the Controller and a command line without one use it. */
export async function runHostRequest(request: Record<string, unknown>, access: HostAccess): Promise<CommandAnswer> {
  try {
    const hostPath = async () => `/v1/remote/hosts/${encodeURIComponent(await access.id() ?? fail('host_unregistered', 'This Host is not registered with the Relay yet.'))}`;
    const provider = async () => {
      if (typeof request.providerId === 'string') return request.providerId;
      const providers = (await access.describe()).providers as Array<{ providerId: string }> | undefined;
      return providers?.[0]?.providerId ?? fail('unsupported_configuration', 'The Host has no provider.');
    };
    switch (request.command) {
      case 'list': return answered(await access.relay('GET', '/v1/remote/hosts'));
      case 'read': return { result: { host: await access.describe() } };
      case 'providers': {
        if (request.action !== 'set') return answered(await access.host('GET', 'provider-settings'));
        const current = await access.host('GET', 'provider-settings');
        if (current.status !== 200) return answered(current);
        return answered(await access.host('POST', 'provider-settings', { providerId: request.providerId, enabled: request.enabled, revision: current.data.revision }));
      }
      case 'workspaces': {
        const providerId = await provider();
        if (request.action === 'create') return answered(await access.host('POST', 'workspace-folders/create', { providerId, parentPath: request.parentPath, name: request.name }));
        const workspaces = await access.host('GET', `workspaces?${new URLSearchParams({ providerId })}`);
        if (workspaces.status !== 200 || typeof request.path !== 'string') return answered(workspaces);
        const folders = await access.host('GET', `workspace-folders?${new URLSearchParams({ providerId, path: request.path })}`);
        return folders.status === 200 ? { result: { ...workspaces.data, folders: folders.data } } : answered(folders);
      }
      case 'tunnel': return answered(request.action === 'status' ? await access.host('GET', 'vscode-tunnel')
        : await access.host('POST', `vscode-tunnel/${request.action}`, request.action === 'start' ? { acceptLicense: true } : {}));
      case 'previews': {
        const path = `${await hostPath()}/previews`;
        if (request.action === undefined) return answered(await access.relay('GET', path));
        return answered(await access.relay('POST', `${path}/${safeId(String(request.previewId))}/${request.action === 'renew' ? 'renew' : 'unregister'}`, {}));
      }
      case 'update': {
        const path = `${await hostPath()}/controller-update`;
        if (typeof request.version === 'string') return answered(await access.relay('POST', path, { version: request.version, operationId: request.operationId }));
        const [status, release] = await Promise.all([access.relay('GET', path), access.relay('GET', '/v1/remote/controller-release')]);
        if (status.status !== 200) return answered(status);
        return release.status === 200 ? { result: { status: status.data, release: release.data.release ?? null } } : answered(release);
      }
      case 'stop-sessions': return answered(await access.host('POST', 'stop', { operationId: request.operationId }));
    }
    return { error: { code: 'invalid_request', message: 'Unknown host command.' } };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return { error: { code: typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'command_failed', message: error instanceof Error ? error.message : 'The host command failed.' } };
  }
}
function fail(code: string, message: string): never { throw new CliError(code, message); }

/** A Host reached through the Relay, by a command line without a Controller or a Controller naming another Host. */
export function relayHostAccess(credentials: CliCredentials, hostId: string, fetcher: typeof fetch = fetch): HostAccess {
  const relay = (method: 'GET' | 'POST', path: string, body?: unknown) => relayRequest(credentials, method, path, body, fetcher);
  return {
    id: async () => hostId,
    host: (method, path, body) => relay(method, `/v1/remote/hosts/${encodeURIComponent(hostId)}/${path}`, body),
    relay,
    async describe() {
      const listed = await relay('GET', '/v1/remote/hosts');
      if (listed.status !== 200) throw relayError(listed.status, listed.data);
      const host = (listed.data.hosts as Array<Record<string, unknown>> | undefined)?.find(value => value.id === hostId);
      return host ?? fail('host_not_found', 'No such Host on your account.');
    },
  };
}

export async function runHostCommand(args: readonly string[], env: NodeJS.ProcessEnv, write: (text: string) => void,
  management: () => Promise<ManagementAccess | undefined> = async () => undefined, connect: typeof createConnection = createConnection,
  credentials: () => Promise<CliCredentials | undefined> = async () => undefined): Promise<number> {
  if (!args.length || ['help', '--help', '-h'].includes(args[0]!)) { write(help); return args.length ? EXIT_OK : 2; }
  try {
    const request = hostRequest(args);
    const answer = await (await commandChannel(env, management, connect, credentials)).call('host', request);
    if ('error' in answer) throw new CliError(answer.error.code, answer.error.message);
    return printResult(write, answer.result);
  } catch (error) {
    return printError(write, error);
  }
}

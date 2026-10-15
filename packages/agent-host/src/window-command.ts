import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createWindowView, isWindowOperation, isWindowOperationResult, isWindowSessionBinding, isWorkspaceWindow,
  type WindowOperation, type WindowSessionBinding, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';

class CommandError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
interface Grant { serverUrl: string; windowId: string; token: string }
const help = `Usage: agent-remote-controller window <command> [--grant-file PATH] [--json]
  list | inspect <window-id> | export <window-id>
  rename <window-id> <title> | delete <window-id>
  apply <window-id> --file LAYOUT.json
  operation <window-id> <operation-id>
  view create <window-id> [--view-id ID] [--session JSON] [--mode dock|float]
  view bind <window-id> <view-id> --session JSON
  view close|select <window-id> <view-id>
  view move <window-id> <view-id> --after ID
  view resize <window-id> <view-id> --width NUMBER
  view place <window-id> <view-id> --mode dock|float
  view collapse <window-id> <view-id> --value true|false
  view display <window-id> <view-id> --mode preview|simple|content [--letters true|false]
  view geometry <window-id> <view-id> --geometry JSON
  minimize <window-id> --value true|false
Mutations: [--base-revision N] [--operation-id ID --issued-at EPOCH_MS]
Credentials: private grant file or AGENT_WINDOW_SERVER, AGENT_WINDOW_ID, AGENT_WINDOW_TOKEN.
Timeout: --timeout-ms 100..60000 (default 15000). Output is JSON. Exit 0 committed,
1 input/transport error, 2 rejected, 3 uncertain mutation (query operation; do not resend).
Create Windows in the website; an assigned Window grant cannot create unrelated Windows.
`;
function error(code: string, message: string): never { throw new CommandError(code, message); }
function number(value: string | undefined, name: string): number {
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) error('invalid_argument', `${name} must be a nonnegative safe integer.`);
  return Number(value);
}
function boolean(value: string | undefined): boolean {
  if (value !== 'true' && value !== 'false') error('invalid_argument', 'Use true or false.');
  return value === 'true';
}
function json(value: string, label: string): any {
  try { return JSON.parse(value); } catch { return error('invalid_argument', `${label} must contain valid JSON.`); }
}
async function boundedFile(path: string): Promise<string> {
  if ((await stat(path)).size > 300000) error('file_too_large', 'The input file exceeds 300000 bytes.');
  const content = await readFile(path, 'utf8');
  if (Buffer.byteLength(content) > 300000) error('file_too_large', 'The input file exceeds 300000 bytes.');
  return content;
}
async function grant(options: Map<string, string>, env: NodeJS.ProcessEnv): Promise<Grant> {
  const path = options.get('grant-file') ?? env.AGENT_WINDOW_GRANT_FILE;
  let value: unknown;
  if (path) {
    const info = await stat(path);
    if (process.platform !== 'win32' && (info.mode & 0o077)) error('insecure_grant_file', 'Grant file must be private. Run chmod 600 on the file.');
    value = json(await boundedFile(path), 'Grant file');
  } else value = { serverUrl: env.AGENT_WINDOW_SERVER, windowId: env.AGENT_WINDOW_ID, token: env.AGENT_WINDOW_TOKEN };
  const g = value as Grant | null;
  if (!g || typeof g.serverUrl !== 'string' || typeof g.token !== 'string' || !g.token || g.token.length > 4096
    || typeof g.windowId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(g.windowId)) error('missing_grant', 'Provide a private Window management grant file or AGENT_WINDOW_SERVER, AGENT_WINDOW_ID, and AGENT_WINDOW_TOKEN.');
  let url: URL;
  try { url = new URL(g.serverUrl); } catch { return error('invalid_server', 'Grant serverUrl is invalid.'); }
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)
    || url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) error('invalid_server', 'Use HTTPS, or HTTP on loopback, without URL credentials, query, or fragment.');
  return { ...g, serverUrl: url.href.replace(/\/$/, '') };
}
function binding(value: string | undefined): WindowSessionBinding {
  const parsed = json(value ?? '', '--session');
  if (!isWindowSessionBinding(parsed)) error('invalid_binding', '--session must contain hostId, providerId, nativeSessionId, and title.');
  return parsed;
}

/** Window commands never use Host pairing credentials or touch native session execution. */
export async function runWindowCommand(args: string[], env: NodeJS.ProcessEnv = process.env,
  print: (value: string) => void = value => { process.stdout.write(value); }, fetcher: typeof fetch = fetch): Promise<number> {
  if (!args.length || args.includes('--help') || args[0] === 'help') { print(help); return 0; }
  let pending: { operationId: string; issuedAt: number; baseRevision: number; windowId: string } | undefined;
  let secret = '';
  const output = (value: unknown) => print(`${JSON.stringify(value)}\n`);
  try {
    const positional: string[] = []; const options = new Map<string, string>();
    const allowed = new Set(['grant-file', 'timeout-ms', 'base-revision', 'operation-id', 'issued-at', 'file', 'view-id', 'session', 'mode', 'after', 'width', 'value', 'letters', 'geometry']);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--json') continue;
      if (!arg.startsWith('--')) { positional.push(arg); continue; }
      const name = arg.slice(2); const value = args[++i];
      if (!allowed.has(name) || options.has(name) || !value || value.startsWith('--')) error('invalid_argument', `Invalid or repeated option: --${name}.`);
      options.set(name, value);
    }
    const credentials = await grant(options, env); secret = credentials.token;
    const timeout = number(options.get('timeout-ms') ?? '15000', 'timeout-ms');
    if (timeout < 100 || timeout > 60000) error('invalid_argument', 'timeout-ms must be between 100 and 60000.');
    const request = async (path: string, method = 'GET', body?: unknown): Promise<any> => {
      const response = await fetcher(`${credentials.serverUrl}/v1/windows${path}`, { method, redirect: 'error',
        headers: { authorization: `Bearer ${credentials.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout) });
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 1024 * 1024) error('invalid_response', 'Window response exceeded the size limit.');
      let result: any; try { result = JSON.parse(raw); } catch { return error('invalid_response', 'Window service returned invalid JSON.'); }
      if (!response.ok) {
        if (response.status >= 500) error('service_unavailable', 'Window service could not confirm the request.');
        pending = undefined;
        error(typeof result.code === 'string' ? result.code : 'request_rejected', 'Window service rejected the request. Inspect the Window or refresh its management grant.');
      }
      return result;
    };
    const command = positional[0]; const isView = command === 'view'; const action = isView ? positional[1] : command;
    const windowId = positional[isView ? 2 : 1] ?? credentials.windowId;
    if (windowId !== credentials.windowId) error('window_scope_mismatch', 'This grant belongs to a different Window.');
    const path = `/${encodeURIComponent(windowId)}`;
    const snapshot = async (): Promise<WorkspaceWindow> => {
      const data = await request(path);
      if (!isWorkspaceWindow(data.window) || data.window.id !== windowId) error('invalid_response', 'Window service returned an invalid or mismatched snapshot.');
      return data.window;
    };
    if (command === 'list') {
      const data = await request('');
      if (!Array.isArray(data.windows) || data.windows.some((w: unknown) => !isWorkspaceWindow(w) || w.id !== windowId)) error('invalid_response', 'Window list is invalid.');
      output(data); return 0;
    }
    if (command === 'inspect' || command === 'export') {
      const window = await snapshot();
      if (command === 'inspect') output({ window });
      else { const { schemaVersion: _, id: __, revision: ___, ...layout } = window; output(layout); }
      return 0;
    }
    if (command === 'operation') {
      const id = positional[2]; if (!id) error('invalid_argument', 'Provide an operation ID.');
      const data = await request(`${path}/operations/${encodeURIComponent(id)}`);
      if (!isWindowOperationResult(data.result) || data.result.operationId !== id) error('invalid_response', 'Operation result is invalid or mismatched.');
      output(data); return data.result.status === 'committed' ? 0 : 2;
    }
    if (command === 'create') error('creation_not_authorized', 'An existing Window management grant cannot create another Window. Create and assign it in the website.');
    let operation: WindowOperation | { type: 'delete' };
    let observed: WorkspaceWindow | undefined;
    const viewId = positional[3] ?? '';
    if (isView) {
      switch (action) {
        case 'create': {
          const view = createWindowView(options.get('view-id') ?? options.get('operation-id') ?? randomUUID(), options.has('session') ? binding(options.get('session')) : undefined);
          const mode = options.get('mode'); if (mode) { if (mode !== 'dock' && mode !== 'float') error('invalid_argument', 'mode must be dock or float.'); view.placement = mode; }
          operation = { type: 'view.create', view }; break;
        }
        case 'bind': operation = { type: 'view.bind', viewId, binding: binding(options.get('session')) }; break;
        case 'close': case 'select': operation = { type: action === 'close' ? 'view.close' : 'view.select', viewId }; break;
        case 'move': operation = { type: 'view.move', viewId, afterId: options.get('after') ?? '' }; break;
        case 'resize': operation = { type: 'view.resize', viewId, width: number(options.get('width'), 'width') }; break;
        case 'place': operation = { type: 'view.place', viewId, placement: options.get('mode') as 'dock' | 'float' }; break;
        case 'collapse': operation = { type: 'view.collapse', viewId, collapsed: boolean(options.get('value')) }; break;
        case 'geometry': operation = { type: 'view.geometry', viewId, geometry: json(options.get('geometry') ?? '', '--geometry') }; break;
        case 'display': {
          observed = await snapshot(); const view = observed.views.find(view => view.id === viewId);
          if (!view) error('view_not_found', 'This view does not exist.');
          operation = { type: 'view.display', viewId, display: { mode: (options.get('mode') ?? view.display.mode) as 'preview' | 'simple' | 'content', lettersVisible: options.has('letters') ? boolean(options.get('letters')) : view.display.lettersVisible } }; break;
        }
        default: return error('invalid_command', 'Unknown Window view command.');
      }
    } else if (command === 'rename') operation = { type: 'rename', title: positional[2] ?? '' };
    else if (command === 'delete') operation = { type: 'delete' };
    else if (command === 'minimize') operation = { type: 'main.minimize', minimized: boolean(options.get('value')) };
    else if (command === 'apply') {
      const file = options.get('file'); if (!file) error('invalid_argument', 'Provide --file with a Window layout export.');
      operation = { type: 'layout.apply', layout: json(await boundedFile(file), 'Layout') };
    } else return error('invalid_command', 'Unknown Window command.');
    if (operation.type !== 'delete' && !isWindowOperation(operation)) error('invalid_operation', 'Invalid Window operation. Check IDs, dimensions and required arguments.');
    const operationId = options.get('operation-id') ?? randomUUID();
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(operationId)) error('invalid_argument', 'Invalid operation ID.');
    if (options.has('operation-id') !== options.has('issued-at')) error('invalid_argument', 'An explicit operation ID requires its original --issued-at timestamp, and vice versa.');
    if (options.has('operation-id') && !options.has('base-revision')) error('invalid_argument', 'Reusing an operation ID requires the original --base-revision.');
    const issuedAt = options.has('issued-at') ? number(options.get('issued-at'), 'issued-at') : Date.now();
    const baseRevision = options.has('base-revision') ? number(options.get('base-revision'), 'base-revision') : (observed ?? await snapshot()).revision;
    pending = { operationId, issuedAt, baseRevision, windowId };
    const data = await request(operation.type === 'delete' ? path : `${path}/operations`, operation.type === 'delete' ? 'DELETE' : 'POST', { operationId, issuedAt, baseRevision, operation });
    if (!isWindowOperationResult(data.result) || data.result.operationId !== operationId
      || data.window !== undefined && data.window !== null && (!isWorkspaceWindow(data.window) || data.window.id !== windowId)) error('invalid_response', 'Window service returned an invalid or mismatched operation result.');
    pending = undefined; output(data); return data.result.status === 'committed' ? 0 : 2;
  } catch (cause) {
    const code = cause instanceof CommandError ? cause.code : 'request_failed';
    const message = cause instanceof CommandError ? cause.message : 'Could not communicate with the Window service.';
    output({ ...(pending ? { status: 'unknown', ...pending } : { status: 'error' }), code, message: secret ? message.replaceAll(secret, '[redacted]') : message });
    return pending ? 3 : 1;
  }
}

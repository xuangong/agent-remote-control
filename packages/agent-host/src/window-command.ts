import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createWindowView, decodeWorkspaceWindow, isWindowOperation, isWindowOperationResult, isWindowSessionBinding,
  type WindowOperation, type WindowSessionBinding, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';

import { CliError, printError } from './cli-output.js';
import { relayRequest, type CliCredentials } from './relay-client.js';

class CommandError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const help = `Usage: agent-remote-controller window <command>
  list | inspect <window-id> | export <window-id>
  create [--title TEXT] [--window-id ID] | rename <window-id> <title> | delete <window-id>
  manager <window-id> (--session JSON | --clear)
  apply <window-id> --file LAYOUT.json
  operation <window-id> <operation-id>
  view create <window-id> [--view-id ID] [--session JSON] [--mode primary|dock|float]
  view bind <window-id> <view-id> --session JSON
  view close|select <window-id> <view-id>
  view move <window-id> <view-id> --after ID
  view resize <window-id> <view-id> --width NUMBER
  view place <window-id> <view-id> --mode dock|float
  view collapse <window-id> <view-id> --value true|false
  view display <window-id> <view-id> --mode preview|simple|content [--letters true|false]
  view geometry <window-id> <view-id> --geometry JSON
Mutations: [--base-revision N] [--operation-id ID --issued-at EPOCH_MS]
Windows are yours: run agent-remote-controller login once on this computer.
--session is {"hostId","providerId","nativeSessionId","title"}; manager names the session that arranges the Window.
Timeout: --timeout-ms 100..60000 (default 15000). Output is JSON. Exit 0 committed, 1 failed or
rejected (see error.code), 2 wrong usage, 3 uncertain mutation (query operation; do not resend).
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
function binding(value: string | undefined): WindowSessionBinding {
  const parsed = json(value ?? '', '--session');
  if (!isWindowSessionBinding(parsed)) error('invalid_binding', '--session must contain hostId, providerId, nativeSessionId, and title.');
  return parsed;
}

/** Window commands act as the signed-in user; they never use Host pairing credentials or touch native session execution. */
export async function runWindowCommand(args: string[], credentials: () => Promise<CliCredentials | undefined>,
  print: (value: string) => void = value => { process.stdout.write(value); }, fetcher: typeof fetch = fetch): Promise<number> {
  if (!args.length || args.includes('--help') || args[0] === 'help') { print(help); return 0; }
  let pending: { operationId: string; issuedAt: number; baseRevision: number; windowId: string } | undefined;
  let secret = '';
  const output = (value: unknown) => print(`${JSON.stringify(value)}\n`);
  try {
    const positional: string[] = []; const options = new Map<string, string>();
    const allowed = new Set(['timeout-ms', 'base-revision', 'operation-id', 'issued-at', 'file', 'view-id', 'session', 'mode', 'after', 'width', 'value', 'letters', 'geometry', 'title', 'window-id']);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--json') continue;
      if (!arg.startsWith('--')) { positional.push(arg); continue; }
      const name = arg.slice(2);
      if (name === 'clear') { if (options.has(name)) error('invalid_argument', 'Repeated option: --clear.'); options.set(name, 'true'); continue; }
      const value = args[++i];
      if (!allowed.has(name) || options.has(name) || !value || value.startsWith('--')) error('invalid_argument', `Invalid or repeated option: --${name}.`);
      options.set(name, value);
    }
    const signedIn = await credentials();
    if (!signedIn) error('signed_out', 'Windows belong to your account: run agent-remote-controller login first.');
    secret = signedIn!.token;
    const timeout = number(options.get('timeout-ms') ?? '15000', 'timeout-ms');
    if (timeout < 100 || timeout > 60000) error('invalid_argument', 'timeout-ms must be between 100 and 60000.');
    const request = async (path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: unknown): Promise<any> => {
      const { status, data } = await relayRequest(signedIn!, method, `/v1/windows${path}`, body, fetcher, timeout);
      if (!data || typeof data !== 'object') error('invalid_response', 'Window service returned invalid JSON.');
      if (status < 200 || status >= 300) {
        if (status >= 500) error('service_unavailable', 'Window service could not confirm the request.');
        pending = undefined;
        error(typeof data.code === 'string' ? data.code : 'request_rejected', typeof data.error === 'string' ? data.error : 'Window service rejected the request. Inspect the Window.');
      }
      return data;
    };
    const command = positional[0]; const isView = command === 'view'; const action = isView ? positional[1] : command;
    if (command === 'list') {
      const data = await request('');
      const windows = Array.isArray(data.windows) ? data.windows.map(decodeWorkspaceWindow) : undefined;
      if (!windows || windows.some((window: WorkspaceWindow | undefined) => !window)) error('invalid_response', 'Window list is invalid.');
      output({ ...data, windows }); return 0;
    }
    if (command === 'create') {
      const id = options.get('window-id') ?? randomUUID();
      const operationId = options.get('operation-id') ?? randomUUID();
      if (options.has('operation-id') !== options.has('issued-at')) error('invalid_argument', 'An explicit operation ID requires its original --issued-at timestamp, and vice versa.');
      const issuedAt = options.has('issued-at') ? number(options.get('issued-at'), 'issued-at') : Date.now();
      const window: WorkspaceWindow = { schemaVersion: 3, id, title: options.get('title') ?? 'Window', revision: 0, selectedPrimaryViewId: null, selectedViewId: null, views: [] };
      pending = { operationId, issuedAt, baseRevision: 0, windowId: id };
      const data = await request('', 'POST', { operationId, issuedAt, window });
      const created = decodeWorkspaceWindow(data.window);
      if (!isWindowOperationResult(data.result) || data.result.operationId !== operationId || data.window !== undefined && created?.id !== id) error('invalid_response', 'Window service returned an invalid creation result.');
      pending = undefined; output({ ...data, ...(created ? { window: created } : {}) }); return data.result.status === 'committed' ? 0 : 1;
    }
    const windowId = positional[isView ? 2 : 1] ?? error('invalid_argument', 'Name the Window.');
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(windowId)) error('invalid_argument', 'The Window ID is invalid.');
    const path = `/${encodeURIComponent(windowId)}`;
    if (command === 'manager') {
      if (options.has('clear') === options.has('session')) error('invalid_argument', 'Give --session JSON or --clear.');
      output(await request(`${path}/manager`, 'POST', { session: options.has('clear') ? null : binding(options.get('session')) })); return 0;
    }
    const snapshot = async (): Promise<WorkspaceWindow> => {
      const data = await request(path);
      const window = decodeWorkspaceWindow(data.window);
      if (!window || window.id !== windowId) error('invalid_response', 'Window service returned an invalid or mismatched snapshot.');
      return window;
    };
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
      output(data); return data.result.status === 'committed' ? 0 : 1;
    }
    let operation: WindowOperation | { type: 'delete' };
    let observed: WorkspaceWindow | undefined;
    const viewId = positional[3] ?? '';
    if (isView) {
      switch (action) {
        case 'create': {
          const view = createWindowView(options.get('view-id') ?? options.get('operation-id') ?? randomUUID(), options.has('session') ? binding(options.get('session')) : undefined);
          const mode = options.get('mode'); if (mode) { if (mode !== 'primary' && mode !== 'dock' && mode !== 'float') error('invalid_argument', 'mode must be primary, dock or float.'); view.placement = mode; }
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
    const window = data.window === undefined || data.window === null ? data.window : decodeWorkspaceWindow(data.window);
    if (!isWindowOperationResult(data.result) || data.result.operationId !== operationId
      || data.window !== undefined && data.window !== null && (!window || window.id !== windowId)) error('invalid_response', 'Window service returned an invalid or mismatched operation result.');
    pending = undefined; output({ ...data, ...(data.window !== undefined ? { window } : {}) }); return data.result.status === 'committed' ? 0 : 1;
  } catch (cause) {
    const code = pending ? 'outcome_unknown' : cause instanceof CommandError ? cause.code : 'request_failed';
    const message = cause instanceof CommandError ? cause.message : 'Could not communicate with the Window service.';
    return printError(print, new CliError(code, message, pending ? { status: 'unknown', ...pending } : undefined), [secret]);
  }
}

import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWindowView, applyWindowOperation, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { runWindowCommand } from './window-command.js';
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(wireVersion: 2 | 3 = 3) {
  let window: WorkspaceWindow = { schemaVersion: 3, id: 'w1', revision: 0, title: 'Project', selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', undefined, 'primary')] };
  const snapshot = (value = window) => ({ ...value, schemaVersion: wireVersion });
  const receipts = new Map<string, { input: string; result: unknown; window: WorkspaceWindow }>(); const requests: string[] = [];
  const server = createServer(async (req, res) => {
    requests.push(req.url!); res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer secret-grant') { res.writeHead(403).end(JSON.stringify({ code: 'window_access_denied' })); return; }
    if (req.method === 'GET' && req.url === '/v1/windows/w1') { res.end(JSON.stringify({ window: snapshot() })); return; }
    if (req.method === 'GET' && req.url === '/v1/windows') { res.end(JSON.stringify({ windows: [snapshot()] })); return; }
    if (req.method === 'GET' && req.url?.includes('/operations/')) { res.end(JSON.stringify({ result: receipts.get(req.url.split('/').at(-1)!)?.result })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    const previous = receipts.get(input.operationId);
    if (previous) {
      if (previous.input !== raw) { res.writeHead(409).end(JSON.stringify({ code: 'operation_conflict' })); return; }
      res.end(JSON.stringify({ result: previous.result, window: snapshot(previous.window) })); return;
    }
    if (input.baseRevision !== window.revision) { res.end(JSON.stringify({ result: { operationId: input.operationId, status: 'rejected', revision: window.revision, committedAt: Date.now(), expiresAt: Date.now() + 86400000, code: 'revision_conflict' }, window: snapshot() })); return; }
    window = applyWindowOperation(window, input.operation);
    const result = { operationId: input.operationId, status: 'committed', revision: window.revision, committedAt: Date.now(), expiresAt: Date.now() + 86400000 };
    receipts.set(input.operationId, { input: raw, result, window: structuredClone(window) }); res.end(JSON.stringify({ result, window: snapshot() }));
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  const env = { AGENT_WINDOW_SERVER: `http://127.0.0.1:${address.port}`, AGENT_WINDOW_ID: 'w1', AGENT_WINDOW_TOKEN: 'secret-grant' };
  const run = async (args: string[]) => { let output = ''; const code = await runWindowCommand(args, env, text => { output += text; }); return { code, output: JSON.parse(output) }; };
  return { run, requests, get window() { return window; }, env };
}
it('operates over HTTP and preserves stable view IDs through creation, binding, selection and resize', async () => {
  const f = await fixture();
  expect((await f.run(['inspect', 'w1'])).output.window.id).toBe('w1');
  const created = await f.run(['view', 'create', 'w1', '--view-id', 'dock', '--base-revision', '0']);
  expect(created.code).toBe(0); expect(created.output.result.status).toBe('committed');
  const session = JSON.stringify({ hostId: 'mac', providerId: 'codex', nativeSessionId: 's1', title: 'Demo' });
  expect((await f.run(['view', 'bind', 'w1', 'dock', '--session', session])).code).toBe(0);
  expect((await f.run(['view', 'resize', 'w1', 'dock', '--width', '620'])).code).toBe(0);
  expect((await f.run(['view', 'select', 'w1', 'dock'])).code).toBe(0);
  expect(f.window.selectedViewId).toBe('dock'); expect(f.window.views[1]?.width).toBe(620);
  expect((await f.run(['operation', 'w1', created.output.result.operationId])).output.result.status).toBe('committed');
});

it('reads and mutates version 2 Windows before the Relay upgrade', async () => {
  const f = await fixture(2);
  expect((await f.run(['inspect', 'w1'])).output.window).toEqual(f.window);
  expect((await f.run(['list'])).output.windows).toEqual([f.window]);
  expect((await f.run(['export', 'w1'])).output.views).toEqual(f.window.views);
  const renamed = await f.run(['rename', 'w1', 'Upgraded Controller']);
  expect(renamed.code).toBe(0);
  expect(renamed.output.window).toEqual(f.window);
  expect(renamed.output.window).toMatchObject({ schemaVersion: 3, revision: 1, title: 'Upgraded Controller' });
});
it('replays explicit view creation identities without generating another view or changing the request', async () => {
  const f = await fixture();
  const args = ['view', 'create', 'w1', '--operation-id', 'create-retry', '--issued-at', String(Date.now()), '--base-revision', '0'];
  const first = await f.run(args);
  expect(first.code).toBe(0);
  expect(first.output.window.views[1].id).toBe('create-retry');
  const replay = await f.run(args);
  expect(replay).toEqual(first);
  expect(f.window.revision).toBe(1);
  expect(f.window.views).toHaveLength(2);
  expect((await f.run([...args, '--mode', 'float'])).output.code).toBe('operation_conflict');
});
it('returns explicit conflicts and rejects malformed input without posting mutations', async () => {
  const f = await fixture();
  expect((await f.run(['rename', 'w1', 'Renamed', '--base-revision', '99'])).code).toBe(2);
  const before = f.requests.length;
  expect((await f.run(['view', 'resize', 'w1', 'main', '--width', '0'])).code).toBe(1);
  expect((await f.run(['view', 'select', 'another-window', 'main'])).code).toBe(1);
  expect(f.requests.length).toBe(before);
});
it('treats missing mutation replies as unknown and exposes the operation identity for lookup', async () => {
  const f = await fixture(); let output = '';
  const code = await runWindowCommand(['rename', 'w1', 'Next', '--base-revision', '0'], f.env, text => { output += text; }, async () => { throw new Error('network unavailable'); });
  expect(code).toBe(3); const result = JSON.parse(output);
  expect(result.status).toBe('unknown'); expect(result.operationId).toBeTruthy();
  expect(output).not.toContain('secret-grant');
});
it('does not follow redirects carrying management credentials', async () => {
  const f = await fixture(); let output = ''; let policy: RequestRedirect | undefined;
  const code = await runWindowCommand(['inspect', 'w1'], f.env, text => { output += text; }, async (_, init) => { policy = init?.redirect; return new Response(JSON.stringify({ window: { id: 'spoofed' } }), { status: 200 }); });
  expect(policy).toBe('error'); expect(code).toBe(1); expect(JSON.parse(output).code).toBe('invalid_response');
});
it('exports layout without document identity and leaves the current Window unchanged', async () => {
  const f = await fixture();
  const before = structuredClone(f.window);
  const exported = (await f.run(['export', 'w1'])).output;
  expect(exported.id).toBeUndefined(); expect(exported.revision).toBeUndefined(); expect(exported.schemaVersion).toBeUndefined();
  expect(exported.views).toEqual(before.views);
  expect(f.window).toEqual(before);
});
it('creates, selects, collapses, moves and closes primary roots through the same view commands', async () => {
  const f = await fixture();
  expect((await f.run(['view', 'create', 'w1', '--view-id', 'second', '--mode', 'primary'])).code).toBe(0);
  expect((await f.run(['view', 'select', 'w1', 'second'])).output.window.selectedPrimaryViewId).toBe('second');
  expect((await f.run(['view', 'collapse', 'w1', 'second', '--value', 'true'])).output.window.views[1].collapsed).toBe(true);
  expect((await f.run(['view', 'move', 'w1', 'second', '--after', 'main'])).code).toBe(0);
  expect((await f.run(['view', 'close', 'w1', 'main'])).output.window.views.map((view: any) => view.id)).toEqual(['second']);
  expect((await f.run(['minimize', 'w1', '--value', 'true'])).code).toBe(1);
});

it('closes, inspects, exports, applies and repopulates an empty Window over HTTP', async () => {
  const f = await fixture();
  const closed = await f.run(['view', 'close', 'w1', 'main']);
  expect(closed.code).toBe(0);
  expect(closed.output.window).toMatchObject({ id: 'w1', schemaVersion: 3, revision: 1, views: [], selectedViewId: null, selectedPrimaryViewId: null });
  expect((await f.run(['inspect', 'w1'])).output.window).toEqual(closed.output.window);
  expect((await f.run(['list'])).output.windows).toEqual([closed.output.window]);
  const exported = (await f.run(['export', 'w1'])).output;
  expect(exported).toEqual({ title: 'Project', views: [], selectedViewId: null, selectedPrimaryViewId: null });
  const directory = await mkdtemp(join(tmpdir(), 'window-empty-layout-'));
  try {
    const file = join(directory, 'layout.json'); await writeFile(file, JSON.stringify(exported));
    expect((await f.run(['apply', 'w1', '--file', file])).code).toBe(0);
    const created = await f.run(['view', 'create', 'w1', '--view-id', 'first-dock']);
    expect(created.code).toBe(0);
    expect(created.output.window).toMatchObject({ id: 'w1', revision: 3, selectedViewId: 'first-dock', selectedPrimaryViewId: null });
    expect(created.output.window.views).toEqual([createWindowView('first-dock')]);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createWindowView, applyWindowOperation, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { runWindowCommand } from './window-command.js';
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture() {
  let window: WorkspaceWindow = { schemaVersion: 1, id: 'w1', revision: 0, title: 'Project', primaryViewId: 'main', selectedViewId: 'main', mainMinimized: false, views: [createWindowView('main', undefined, 'primary')] };
  const receipts = new Map<string, { input: string; result: unknown; window: WorkspaceWindow }>(); const requests: string[] = [];
  const server = createServer(async (req, res) => {
    requests.push(req.url!); res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer secret-grant') { res.writeHead(403).end(JSON.stringify({ code: 'window_access_denied' })); return; }
    if (req.method === 'GET' && req.url === '/v1/windows/w1') { res.end(JSON.stringify({ window })); return; }
    if (req.method === 'GET' && req.url?.includes('/operations/')) { res.end(JSON.stringify({ result: receipts.get(req.url.split('/').at(-1)!)?.result })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    const previous = receipts.get(input.operationId);
    if (previous) {
      if (previous.input !== raw) { res.writeHead(409).end(JSON.stringify({ code: 'operation_conflict' })); return; }
      res.end(JSON.stringify({ result: previous.result, window: previous.window })); return;
    }
    if (input.baseRevision !== window.revision) { res.end(JSON.stringify({ result: { operationId: input.operationId, status: 'rejected', revision: window.revision, committedAt: Date.now(), expiresAt: Date.now() + 86400000, code: 'revision_conflict' }, window })); return; }
    window = applyWindowOperation(window, input.operation);
    const result = { operationId: input.operationId, status: 'committed', revision: window.revision, committedAt: Date.now(), expiresAt: Date.now() + 86400000 };
    receipts.set(input.operationId, { input: raw, result, window: structuredClone(window) }); res.end(JSON.stringify({ result, window }));
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
